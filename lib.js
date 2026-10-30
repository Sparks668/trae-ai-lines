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
    this.offsets = new Map();   // file -> read byte offset, for incremental reads
    this.day = localDate();
    this.entries = new Map();   // "commit|file" -> payload, latest event wins
    this.superseded = new Set(); // amended hashes stay excluded when another log source arrives late
  }

  listFiles(native) {
    if (native) {
      const nat = this._nativeFiles();
      if (nat.length) return nat;
    }
    const out = [];
    let sessions;
    try { sessions = fs.readdirSync(this.logRoot); } catch { return out; }
    // ponytail: scan only the last 3 days of session dirs; covers cross-day sessions
    const keepFrom = localDate(new Date(Date.now() - 3 * 864e5)).replace(/-/g, '');
    for (const s of sessions) {
      if (/^\d{8}T/.test(s) && s.slice(0, 8) < keepFrom) continue;
      this._walk(path.join(this.logRoot, s), out);
    }
    return out;
  }

  _nativeFiles() {
    const out = [];
    let ids;
    try { ids = fs.readdirSync(this.nativeRoot); } catch { return out; }
    const want = `git-ai-daemon-${this.day}.log`;
    for (const id of ids) {
      const f = path.join(this.nativeRoot, id, 'internal', 'daemon', 'logs', want);
      try { if (fs.statSync(f).isFile()) out.push(f); } catch { /* not a log dir */ }
    }
    return out;
  }

  _walk(dir, out) {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) this._walk(p, out);
      else if (n.endsWith('Trae Coding Analysis Daemon.log')) out.push(p);
    }
  }

  async _readNew(file) {
    const st = await fs.promises.stat(file);
    let off = this.offsets.get(file) || 0;
    if (st.size < off) off = 0; // file was rotated/truncated, re-read from start
    if (st.size <= off) return [];
    const fh = await fs.promises.open(file, 'r');
    try {
      const buf = Buffer.alloc(st.size - off);
      await fh.read(buf, 0, buf.length, off);
      const text = buf.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl === -1) return []; // no complete line yet, read next time
      this.offsets.set(file, off + Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8'));
      return text.slice(0, lastNl).split('\n');
    } finally {
      await fh.close();
    }
  }

  async poll(native) {
    const today = localDate();
    if (today !== this.day) { this.day = today; this.entries.clear(); this.superseded.clear(); }
    for (const f of this.listFiles(native)) {
      let lines;
      try { lines = await this._readNew(f); } catch { continue; }
      this._absorb(lines);
    }
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
    await mirror.poll();
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
