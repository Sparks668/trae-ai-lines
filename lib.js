'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB_BUSY_MS = 1500;
const ATTRIBUTION_QUERY = "SELECT event_json, created_at FROM datafinder_events "
  + "WHERE created_at >= ? "
  + "AND CASE WHEN json_valid(event_json) THEN json_extract(event_json, '$.event') END = 'git_ai_commit_attribution' "
  + "ORDER BY created_at, id";

function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function databaseFiles(root, errors) {
  const homes = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(path.join(root, entry.name));
    }
  } catch (e) {
    if (e.code !== 'ENOENT') errors.push({ file: root, message: e.message });
  }
  const files = [];
  for (const home of homes) {
    const file = path.join(home, 'internal', 'datafinder-db');
    try {
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size) files.push(file);
    } catch (e) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors.push({ file, message: e.message });
    }
  }
  return files.sort();
}

async function readAttribution(file, appRoot, since) {
  // Trae ships a SQLite binding for the platform running the extension host.
  let sqlite;
  if (appRoot) {
    try { sqlite = require(path.join(appRoot, 'node_modules', '@vscode', 'sqlite3')); }
    catch { /* Hosts with built-in SQLite can use it directly. */ }
  }
  if (!sqlite) {
    let DatabaseSync;
    try { ({ DatabaseSync } = require('node:sqlite')); }
    catch { throw new Error('当前 Trae 环境没有可用的 SQLite 读取组件'); }
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout = ' + DB_BUSY_MS);
      return db.prepare(ATTRIBUTION_QUERY).all(since);
    } finally { db.close(); }
  }

  const db = await new Promise((resolve, reject) => {
    const connection = new sqlite.Database(file, sqlite.OPEN_READONLY,
      error => error ? reject(error) : resolve(connection));
  });
  try {
    db.configure('busyTimeout', DB_BUSY_MS);
    return await new Promise((resolve, reject) =>
      db.all(ATTRIBUTION_QUERY, since, (error, rows) => error ? reject(error) : resolve(rows)));
  } finally {
    await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }
}

class AiLinesCounter {
  constructor({ appRoot, root = path.join(os.homedir(), '.trae-cn', '.git-ai-tob') } = {}) {
    this.appRoot = appRoot;
    this.root = root;
    this.day = localDate();
    this.lastRead = { files: [], errors: [], invalid: 0 };
    this.totals = null;
  }

  async poll() {
    const report = { files: [], errors: [], invalid: 0 };
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    const rows = [];
    for (const file of databaseFiles(this.root, report.errors)) {
      try {
        for (const row of await readAttribution(file, this.appRoot, since)) rows.push(row);
        report.files.push(file);
      } catch (e) {
        report.errors.push({ file, message: e.message });
      }
    }

    this.day = localDate();
    const commits = new Map();
    const superseded = new Set();
    for (const row of rows) {
      if (localDate(new Date(row.created_at * 1000)) !== this.day) continue;
      let event, payload;
      try {
        event = JSON.parse(row.event_json);
        payload = typeof event.params === 'string' ? JSON.parse(event.params) : event.params;
      } catch { report.invalid++; continue; }

      const { commit_hash: hash, amended_from_commit_hash: old, total_ai_committed_added_lines: ai,
        total_lines_added: total } = payload ?? {};
      if (!hash || typeof hash !== 'string' || !Number.isSafeInteger(ai)
        || !Number.isSafeInteger(total) || ai < 0 || ai > total) {
        report.invalid++;
        continue;
      }
      if (typeof old === 'string' && old && old !== hash) superseded.add(old);
      const order = Number(event.local_time_ms) || row.created_at * 1000;
      if (!commits.has(hash) || order >= commits.get(hash).order) commits.set(hash, { ai, total, order });
    }
    for (const hash of superseded) commits.delete(hash);
    this.totals = report.files.length && !report.errors.length && !report.invalid
      ? { ai: 0, total: 0, commits: commits.size } : null;
    if (this.totals) {
      for (const { ai, total } of commits.values()) {
        this.totals.ai += ai;
        this.totals.total += total;
      }
    }
    this.lastRead = report;
    return report;
  }

  sums() {
    return this.totals;
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
    // ponytail: git_diff_added_lines only counts checkpoint-attributed lines �� GBK files are binary_file_skipped
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

// Self-check the current machine's statistics without modifying the database.
if (require.main === module) {
  (async () => {
    const counter = new AiLinesCounter();
    await counter.poll();
    const stats = counter.sums();
    console.log('committed', JSON.stringify(stats));
    const ok = stats === null || (stats.total >= stats.ai && stats.ai >= 0);
    console.log(ok ? 'OK' : 'FAIL');
    process.exitCode = ok ? 0 : 1;
  })().catch(e => { console.error(e); process.exitCode = 1; });
}
