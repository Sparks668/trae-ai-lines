'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LINE_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d+\s+INFO datafinder: event \[(git_ai_commit_file|git_ai_commit_attribution)\] core_payload=(\{.*\})\s*$/;

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

class AiLinesCounter {
  // ponytail: Trae CN only; win32 path follows VS Code %APPDATA% convention, untested on a real Windows box
  constructor(logRoot, nativeRoot) {
    if (!logRoot) {
      logRoot = process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Trae CN', 'logs')
        : path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'logs');
    }
    this.logRoot = logRoot;
    // ponytail: native daemon log is near-realtime but lives in an internal dir; falls back to mirror logs when absent
    this.nativeRoot = nativeRoot || path.join(os.homedir(), '.trae-cn', '.git-ai-tob');
    this.offsets = new Map();   // file -> identity and byte offset, for incremental reads
    this.day = localDate();
    this.entries = new Map();   // "commit|file" -> payload, latest event wins
    this.superseded = new Set(); // amended hashes stay excluded when another log source arrives late
    this.lastRead = { source: 'none', files: [], errors: [] };
  }

  listFiles(native = true, errors = []) {
    if (native) {
      const nat = this._nativeFiles(errors);
      if (nat.length) return nat;
    }
    const out = [];
    // Sessions can keep writing for weeks. Search the output-log layout,
    // without recursively walking every extension's files.
    for (const s of this._dirEntries(this.logRoot, errors)) {
      if (!s.isDirectory() || !/^\d{8}T/.test(s.name)) continue;
      const session = path.join(this.logRoot, s.name);
      this._mirrorLogs(session, out, errors); // Older/standalone mirror layouts.
      for (const w of this._dirEntries(session, errors)) {
        if (!w.isDirectory() || !/^window\d+$/.test(w.name)) continue;
        const host = path.join(session, w.name, 'exthost');
        for (const output of this._dirEntries(host, errors)) {
          if (output.isDirectory() && output.name.startsWith('output_logging_')) {
            this._mirrorLogs(path.join(host, output.name), out, errors);
          }
        }
      }
    }
    return out;
  }

  _nativeFiles(errors = []) {
    const out = [];
    const want = `git-ai-daemon-${this.day}.log`;
    const homes = [this.nativeRoot, ...this._dirEntries(this.nativeRoot, errors)
      .filter(e => e.isDirectory()).map(e => path.join(this.nativeRoot, e.name))];
    for (const home of homes) {
      const dir = path.join(home, 'internal', 'daemon', 'logs');
      for (const entry of this._dirEntries(dir, errors)) {
        if (!entry.isFile() || !/^git-ai-daemon-\d{4}-\d{2}-\d{2}\.log$/.test(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.name === want || this._updatedToday(file, errors)) out.push(file);
      }
    }
    return out;
  }

  _discoveryError(file, error, errors) {
    // Optional tenant/output directories may not exist. Access and I/O
    // failures are different: retain them so native reads can fall back.
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
      errors.push({ file, message: error.message });
    }
  }

  _dirEntries(dir, errors) {
    try { return fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { this._discoveryError(dir, e, errors); return []; }
  }

  _updatedToday(file, errors) {
    try { return fs.statSync(file).mtimeMs >= new Date(`${this.day}T00:00:00`).getTime(); }
    catch (e) { this._discoveryError(file, e, errors); return false; }
  }

  _mirrorLogs(dir, out, errors) {
    for (const entry of this._dirEntries(dir, errors)) {
      if (!entry.isFile() || !entry.name.endsWith('Trae Coding Analysis Daemon.log')) continue;
      const file = path.join(dir, entry.name);
      if (this._updatedToday(file, errors)) out.push(file);
    }
  }

  async _readNew(file) {
    const previous = this.offsets.get(file);
    const offsetFor = st => previous && previous.dev === st.dev && previous.ino === st.ino
      && previous.birthtimeMs === st.birthtimeMs && st.size >= previous.offset ? previous.offset : 0;
    let st = await fs.promises.stat(file);
    let off = offsetFor(st);
    const save = offset => this.offsets.set(file,
      { offset, dev: st.dev, ino: st.ino, birthtimeMs: st.birthtimeMs });
    if (st.size <= off) { save(off); return []; }
    const fh = await fs.promises.open(file, 'r');
    try {
      // The path may have been replaced after stat. Use the opened file's
      // identity and size before deciding where to resume.
      st = await fh.stat();
      off = offsetFor(st);
      if (st.size <= off) { save(off); return []; }
      const buf = Buffer.alloc(st.size - off);
      const { bytesRead } = await fh.read(buf, 0, buf.length, off);
      const text = buf.toString('utf8', 0, bytesRead);
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) { save(off); return []; } // Retry the incomplete line next time.
      save(off + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'));
      return text.slice(0, lastNl).split('\n');
    } finally {
      await fh.close();
    }
  }

  async poll(native = true) {
    const resetDay = () => {
      const today = localDate();
      if (today !== this.day) { this.day = today; this.entries.clear(); this.superseded.clear(); }
    };
    resetDay();
    const report = { source: 'none', files: [], errors: [] };
    const read = async (files, source) => {
      let successes = 0;
      for (const file of files) {
        try {
          const lines = await this._readNew(file);
          resetDay(); // A file read may span midnight.
          this._absorb(lines);
          report.files.push(file);
          successes++;
        } catch (e) { report.errors.push({ file, message: e.message }); }
      }
      if (successes) report.source = report.source === 'none' ? source : `${report.source}+${source}`;
    };
    if (native) {
      await read(this._nativeFiles(report.errors), 'native');
      // A readable zero is valid. Supplement unreadable native files with
      // mirrors; existing commit/file deduplication handles source overlap.
      if (!report.files.length || report.errors.length) await read(this.listFiles(false, report.errors), 'mirror');
    } else await read(this.listFiles(false, report.errors), 'mirror');
    this.lastRead = report;
    return report;
  }

  _absorb(lines) {
    for (const line of lines) {
      const m = LINE_RE.exec(line);
      if (!m || m[1] !== this.day) continue;
      let p;
      try { p = JSON.parse(m[3]); } catch { continue; }
      // ponytail: file events deduped by commit|file (carry ai_lines); attribution events have no file_path, one per commit (carry total_lines_added)
      if (!p.commit_hash) continue;
      // Process the relation even when this event's own commit was superseded:
      // C -> B can arrive before B -> A, and both ancestors must stay excluded.
      if (p.amended_from_commit_hash) {
        this.superseded.add(p.amended_from_commit_hash);
        const old = p.amended_from_commit_hash + '|';
        for (const k of this.entries.keys()) if (k.startsWith(old)) this.entries.delete(k);
      }
      if (this.superseded.has(p.commit_hash)) continue;
      this.entries.set(`${p.commit_hash}|${p.file_path || '@attr'}`, p);
    }
  }

  // ponytail: AI + total both deduped per commit: attribution event's settled fields win (total_ai_committed_added_lines matches Trae's official settlement: source_scene-unknown AI edits count as unknown, not AI), else fall back to file-event sums; avoids double counting both event kinds
  sums() {
    let ai = 0;
    const commits = new Set();
    const attrAi = new Map(); // commit -> total_ai_committed_added_lines from attribution event (settled, official)
    const attrTotal = new Map(); // commit -> total_lines_added from attribution event
    const fileTotal = new Map(); // commit -> sum of per-file total_lines_added
    const fileAi = new Map(); // commit -> sum of per-file ai_lines (loose attribution, fallback only)
    for (const [k, p] of this.entries) {
      commits.add(p.commit_hash);
      if (k.endsWith('|@attr')) {
        // settled fields win even when 0: use typeof-number (not truthiness) so a git-ai-ignored file settled to 0 total/ai isn't mistaken for "no data" and wrongly reverted to the loose file-event value
        if (typeof p.total_ai_committed_added_lines === 'number') attrAi.set(p.commit_hash, p.total_ai_committed_added_lines);
        if (typeof p.total_lines_added === 'number') attrTotal.set(p.commit_hash, p.total_lines_added);
      } else {
        fileAi.set(p.commit_hash, (fileAi.get(p.commit_hash) || 0) + (p.ai_lines || 0));
        if (p.total_lines_added) {
          fileTotal.set(p.commit_hash, (fileTotal.get(p.commit_hash) || 0) + p.total_lines_added);
        }
      }
    }
    let total = 0;
    for (const c of commits) {
      total += attrTotal.has(c) ? attrTotal.get(c) : (fileTotal.get(c) || 0);
      ai += attrAi.has(c) ? attrAi.get(c) : (fileAi.get(c) || 0);
    }
    return { ai, total, commits: commits.size };
  }
}

// Keep raw HEAD-vs-worktree counts for the Git diff detail, but filter the
// pending total with .git-ai-ignore to match the official AI attribution scope.
// Git's own counts still include text encodings skipped by git-ai (e.g. GBK).
async function gitDiffStat(cwd) {
  const { execFile } = require('child_process');
  const run = (args, dir = cwd) => new Promise(resolve =>
    execFile('git', args, { cwd: dir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
      (e, out) => resolve(e ? null : out)));
  const top = await run(['rev-parse', '--show-toplevel']);
  if (!top) return null;
  const root = top.trim();
  const out = await run(['diff', 'HEAD', '--numstat', '-z', '--no-relative'], root);
  if (out === null) return null;
  let adds = 0, dels = 0;
  const files = [];
  const records = out.split('\0');
  for (let i = 0; i < records.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!m) continue;
    let name = m[3];
    if (!name) { i++; name = records[++i]; } // rename: old path, then destination
    if (m[1] === '-') continue; // binary files have no line counts
    const n = Number(m[1]);
    adds += n;
    dels += Number(m[2]);
    files.push({ name, adds: n });
  }
  let total = adds;
  const ignoreFile = path.join(root, '.git-ai-ignore');
  if (fs.existsSync(ignoreFile)) {
    const ignored = await run(['ls-files', '--cached', '--ignored', '--full-name',
      `--exclude-from=${ignoreFile}`, '-z'], root);
    if (ignored === null) return null; // Let the caller fall back to official stats.
    const paths = new Set(ignored.split('\0'));
    total -= files.filter(f => paths.has(f.name)).reduce((sum, f) => sum + f.adds, 0);
  }
  return { adds, dels, total };
}

// Match Trae CN's daemon-home.ts: tenant-scoped home and hashed control socket.
// A live PID alone does not tell the CLI where Trae's background service listens.
function daemonEnv() {
  const root = path.join(os.homedir(), '.trae-cn', '.git-ai-tob');
  const explicitHome = process.env.GIT_AI_DAEMON_HOME;
  let homes;
  if (explicitHome) homes = [explicitHome];
  else {
    try { homes = fs.readdirSync(root).map(id => path.join(root, id)); }
    catch { return null; }
    homes.push(root); // Trae also supports running without a tenant suffix.
  }
  for (const home of homes) {
    let pid;
    try {
      pid = JSON.parse(fs.readFileSync(path.join(home, 'internal', 'daemon', 'daemon.pid.json'), 'utf8')).pid;
    } catch { continue; }
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 0); }
    catch (e) { if (!e || e.code !== 'EPERM') continue; }
    const digest = require('crypto').createHash('sha256').update(home).digest('hex').slice(0, 16);
    const socket = process.platform === 'win32'
      ? `\\\\.\\pipe\\tob-git-ai-${digest}-control`
      : path.join(os.tmpdir(), `tob-git-ai-d-${digest}`, 'control.sock');
    return {
      GIT_AI_DAEMON_HOME: home,
      GIT_AI_DAEMON_CONTROL_SOCKET: (explicitHome && process.env.GIT_AI_DAEMON_CONTROL_SOCKET) || socket,
      GIT_AI_NOTES_REF: 'refs/notes/ai-tob'
    };
  }
  return null;
}

// uncommitted working-change stats via `git-ai status --json` run in cwd; null when binary/repo/daemon/data unavailable
const uncommittedQueries = new Map();
function uncommitted(cwd) {
  if (!cwd) return Promise.resolve(null);
  const key = path.resolve(cwd);
  if (uncommittedQueries.has(key)) return uncommittedQueries.get(key);
  const pending = readUncommitted(cwd).finally(() => uncommittedQueries.delete(key));
  uncommittedQueries.set(key, pending);
  return pending;
}

async function readUncommitted(cwd) {
  // ponytail: platform dir name is a custom scheme (macos-arm64, NOT vscode's darwin-arm64), so don't guess win32 naming: scan version dirs newest-first, any platform subdir with host/git-ai(.exe)
  const root = path.join(os.homedir(), '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime');
  const exe = process.platform === 'win32' ? 'git-ai.exe' : 'git-ai';
  let bin = null;
  try {
    const vs = fs.readdirSync(root)
      .filter(v => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (let i = vs.length - 1; i >= 0 && !bin; i--) {
      const vdir = path.join(root, vs[i]);
      let plats;
      try { plats = fs.readdirSync(vdir); } catch { continue; }
      for (const pl of plats) {
        const p = path.join(vdir, pl, 'host', exe);
        try { fs.accessSync(p, fs.constants.X_OK); bin = p; break; } catch { /* next */ }
      }
    }
  } catch { /* runtime root missing */ }
  if (!bin || !cwd) return null;
  const daemon = daemonEnv();
  if (!daemon) return null;
  const { execFile } = require('child_process');
  // v7: official CLI internal switch - forbid daemon auto-spawn even if the
  // daemon dies inside the daemonEnv->exec race window.
  const env = Object.assign({}, process.env, daemon, { _GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN: 'true' });
  const out = await new Promise(r =>
    execFile(bin, ['status', '--json'], { cwd, timeout: 15000, maxBuffer: 10 * 1024 * 1024, env }, (e, so) => r(e ? null : so)));
  if (!out) return null;
  try {
    const j = JSON.parse(out);
    const s = j.stats;
    // ponytail: settlement scheme matches committed side and Trae's official UI:
    // stats splits the net working-tree diff into ai/human/unknown buckets (their sum equals git_diff_added_lines),
    // so ai_additions is the settled AI count. Do NOT sum checkpoints[].additions: those are cumulative edit
    // volume (edits later overwritten/deleted), a different unit from net diff, and their tool_model attribution
    // does not map back to the settled buckets (verified: human bucket is separate, unknown edits aren't AI).
    // ponytail: git_diff_added_lines only counts checkpoint-attributed lines ¡ª GBK files are binary_file_skipped
    // there and vanish; total prefers Git counts after .git-ai-ignore filtering, falling back when Git fails.
    // ponytail: AI rows = attributed rows minus human/unknown buckets, NOT min(ai_additions,total): ai_additions
    // is cumulative edit volume, clamping it to total wrongly claims unattributed rows (GBK/no-checkpoint) as AI.
    const g = await gitDiffStat(cwd);
    const attributed = s.git_diff_added_lines || 0;
    const aiNet = Math.max(0, attributed - (s.human_additions || 0) - (s.unknown_additions || 0));
    const total = g ? g.total : attributed;
    const ai = Math.min(aiNet, total);
    return { total, ai, gitAdds: g ? g.adds : null, gitDels: g ? g.dels : null };
  } catch { return null; }
}

module.exports = { AiLinesCounter, localDate, uncommitted, gitDiffStat };

// self-check: run against real logs, print and validate today's sums
if (require.main === module) {
  (async () => {
    const mirror = new AiLinesCounter();
    await mirror.poll(false);
    const ms = mirror.sums();
    const nat = new AiLinesCounter();
    await nat.poll(true);
    const ns = nat.sums();
    const fb = new AiLinesCounter(undefined, '/nonexistent-native');
    await fb.poll(true);
    const fs2 = fb.sums();
    console.log('mirror  ', JSON.stringify(ms));
    console.log('native  ', JSON.stringify(ns));
    console.log('fallback', JSON.stringify(fs2));
    const up = await uncommitted('/Users/bobchen/Desktop/ideaWorks/boss');
    console.log('uncommit', JSON.stringify(up));
    const ok = ms.total >= ms.ai && ms.ai >= 0
      && ns.total >= ns.ai && ns.ai >= 0
      && fs2.ai === ms.ai && fs2.total === ms.total
      && (up === null || (up.ai >= 0 && up.total >= up.ai));
    console.log(ok ? 'OK' : 'FAIL');
    process.exit(ok ? 0 : 1);
  })().catch(e => { console.error(e); process.exit(1); });
}
