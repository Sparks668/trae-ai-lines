#!/usr/bin/env node
'use strict';
// guard-v33: version tag - the extension rewrites this hook on startup when
// this tag differs from the packaged template, so plugin upgrades propagate
// without manual off/on toggling.
// v6 change: never exec `git-ai status` without a live daemon (daemonEnv
// below) - the CLI auto-spawns a daemon when none is running, and one spawned
// outside the Trae extension gets no datafinder config, silently killing AI
// attribution for later commits (the extension reuses the crippled daemon).
// v7 change: exec() now sets _GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN
// on every git-ai call (official CLI internal switch, found in the 1.6.2
// binary) - even if the daemon dies inside the probe->exec race window, the
// CLI is forbidden from spawning a replacement. Closes the residual race v6
// accepted. Status queries must still connect to the existing Trae daemon.
// v10: pass Trae tenant home, control socket and notes namespace to status.
// AI-ratio pre-commit hook (installed and managed by the ai-ratio-guard extension).
//
// Rule 1 - ratio check:
//   ai   = stats.git_diff_added_lines - human_additions - unknown_additions
//          (net settled AI; ai_additions is cumulative edit volume, NOT net
//          diff - using it claims manual edits as AI and inflates the ratio).
//   total = raw staged added lines (numstat) MINUS lines of files ignored by
//          .git-ai-ignore. The settled git_diff_added_lines cannot be the
//          denominator: it is blind to GBK/unsupported files (counted 0), so
//          a 31-AI/34-real commit scored a bogus 31/31=100%. Ignored files are
//          subtracted via ls-files --ignored --exclude-from so only the explicit
//          AI ignore file applies. Never use the settled gitaiTotal as the
//          denominator; on ignore-query failure (or repos without
//          .git-ai-ignore) the denominator is rawTotal unchanged - strictly
//          safer: skipping the subtraction only makes the ratio smaller.
//   Same accounting as trae-ai-lines' uncommitted().
//
// Rule 2 - bulk-import guard (repository setting: importOn):
//   total = raw git staged added lines (numstat, NOT git-ai filtered - external
//           imports are invisible to git-ai, which is exactly the loophole this
//           rule closes). Block when 10000 < total < 50000 and AI lines < 5000.
//
// Repository settings live in Git's common directory (shared by worktrees).
// Legacy off markers are migrated by the extension before installing v9.
// AI_RATIO_OFF=1 is the single-commit escape hatch (same effect as master off).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// The quoted value below is a placeholder the extension replaces on install.
// If this file was copied by hand (no extension) the placeholder survives and
// parses to NaN - and `ratio < NaN` is always false, silently killing rule 1.
// Fail closed instead: fall back to the default 50% threshold.
let MIN_AI_RATIO = parseFloat(process.env.AI_RATIO_MIN || '__AI_RATIO__');
if (!Number.isFinite(MIN_AI_RATIO) || MIN_AI_RATIO <= 0) MIN_AI_RATIO = 0.5;
const IMPORT_TOTAL_MIN = 10000; // bulk guard: min raw git added lines
const IMPORT_TOTAL_MAX = 50000; // bulk guard: max raw git added lines
const IMPORT_AI_MIN = 5000;     // bulk guard: AI lines required below this size

let IMPORT_OFF = false;

// Same as trae-ai-lines: platform dir names are custom (macos-arm64, not
// darwin-arm64), so scan version dirs newest-first for any host/git-ai binary.
function findGitAi() {
  const root = path.join(os.homedir(), '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime');
  const exe = process.platform === 'win32' ? 'git-ai.exe' : 'git-ai';
  let versions;
  try { versions = fs.readdirSync(root).filter(v => /^\d+\.\d+\.\d+$/.test(v)); } catch { return null; }
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (let i = versions.length - 1; i >= 0; i--) {
    let plats;
    try { plats = fs.readdirSync(path.join(root, versions[i])); } catch { continue; }
    for (const pl of plats) {
      const p = path.join(root, versions[i], pl, 'host', exe);
      try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
    }
  }
  return null;
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

function exec(cmd, args, daemon = {}) {
  const cwd = process.env.GIT_AI_CWD || process.cwd();
  // v7: official CLI internal switch - forbid daemon auto-spawn even if the
  // daemon dies inside the daemonEnv->exec race window (git ignores this).
  const env = Object.assign({}, process.env, daemon, { _GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN: 'true' });
  return new Promise(resolve =>
    execFile(cmd, args, { cwd, timeout: 15000, maxBuffer: 10 * 1024 * 1024, env }, (e, so) => resolve(e ? null : so)));
}

// Ignore callbacks from a reference hook left over from a preview build.
if (process.argv[2] === '--reference-transaction') process.exit(0);

(async () => {
  const common = await exec('git', ['rev-parse', '--git-common-dir']);
  if (common === null) { console.log('[ai-ratio] git directory unavailable, skip'); return; }
  const dir = path.resolve(process.env.GIT_AI_CWD || process.cwd(), common.trim());
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(dir, 'ai-ratio-guard.json'), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const enabled = settings && settings.enabled;
  IMPORT_OFF = settings && !settings.importOn;
  if (settings && !process.env.AI_RATIO_MIN && Number.isFinite(settings.threshold)) MIN_AI_RATIO = settings.threshold / 100;
  if (process.env.AI_RATIO_OFF || !enabled) { console.log('[ai-ratio] disabled, skip'); return; }

  // NUL-delimited paths avoid quoting and compact "src/{old => new}" renames.
  const numstat = await exec('git', ['diff', '--cached', '--numstat', '-z']);
  if (numstat === null) { console.log('[ai-ratio] git diff failed, skip check'); return; }
  let rawTotal = 0;
  const files = []; // { adds, path } for .git-ai-ignore subtraction
  const records = numstat.split('\0');
  for (let i = 0; i < records.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!m) continue;
    let name = m[3];
    if (!name) { i++; name = records[++i]; } // rename: empty field, old path, new path
    if (m[1] === '-') continue;
    rawTotal += parseInt(m[1], 10);
    files.push({ adds: parseInt(m[1], 10), path: name });
  }

  // Query tracked/index paths using ONLY .git-ai-ignore. Without --exclude-standard,
  // ls-files ignores .gitignore, info/exclude, and the user's global excludes.
  let ignoredAdds = null;
  const ignoreFile = path.join(process.env.GIT_AI_CWD || process.cwd(), '.git-ai-ignore');
  if (files.length && fs.existsSync(ignoreFile)) {
    const out = await exec('git', ['ls-files', '--cached', '--ignored', '--full-name',
      `--exclude-from=${ignoreFile}`, '-z']);
    if (out !== null) {
      const set = new Set(out.split('\0').filter(Boolean));
      ignoredAdds = files.filter(f => set.has(f.path)).reduce((s, f) => s + f.adds, 0);
    }
  }

  // Transparency note: git-ai settles the WHOLE working tree, so unstaged Trae
  // edits inflate the numerator when the user commits a partial staging. We
  // cannot split attribution per staging state (data-source limit), so count
  // the unstaged adds and surface them instead of silently judging skewed.
  const unstaged = await exec('git', ['-c', 'core.quotepath=false', 'diff', '--numstat']);
  let unstagedAdds = 0;
  if (unstaged) {
    for (const line of unstaged.split('\n')) {
      const u = /^(\d+)\t/.exec(line);
      if (u) unstagedAdds += parseInt(u[1], 10);
    }
  }

  // Settled source: rule 1's total and ai from the same stats (git-ai filtered).
  let ai = 0;
  let gitaiTotal = 0;
  let settled = false; // git-ai pipeline responded (safe to enforce rule 1)
  const bin = findGitAi();
  const daemon = bin ? daemonEnv() : null;
  if (bin && !daemon) {
    // rule 1 fail-open, but say so - a silent skip would look like approval.
    // rule 2 (pure git) still applies below.
    console.log('[ai-ratio] note: git-ai daemon offline, AI-ratio check skipped this commit (import guard still active)');
  } else if (bin) {
    const out = await exec(bin, ['status', '--json'], daemon);
    if (out) {
      try {
        const s = JSON.parse(out).stats;
        if (s && typeof s.git_diff_added_lines === 'number') gitaiTotal = s.git_diff_added_lines;
        // ponytail: net settled AI = attributed rows minus human/unknown buckets;
        // ai_additions is cumulative edit volume and must not be used here.
        ai = Math.max(0, gitaiTotal - (s.human_additions || 0) - (s.unknown_additions || 0));
        settled = true;
      } catch { /* parse failure: keep totals at 0 */ }
    }
    if (!settled && rawTotal > 0) {
      console.log('[ai-ratio] note: git-ai attribution query failed, AI-ratio check skipped this commit');
    }
  }

  // Rule 1: ratio check. Numerator = net settled AI; denominator = real staged
  // lines (git-ai-ignore'd files subtracted). The old `gitaiTotal > 0` gate let
  // pure-external/human commits (invisible to git-ai) pass silently - exactly
  // what this guard exists to block. Enforce when git-ai is responsive and
  // there are real staged lines; skip only when the pipeline is dead or nothing
  // is staged. Never fall back to gitaiTotal as denominator: it is blind to
  // GBK/unsupported files (the 31/31=100% miss), so on ignore-query failure
  // (or repos without .git-ai-ignore) use rawTotal unchanged.
  const visible = ignoredAdds !== null ? Math.max(0, rawTotal - ignoredAdds) : rawTotal;
  if (settled && visible > 0) {
    const ratio = ai / visible;
    console.log(`[ai-ratio] commit AI ${ai} / ${visible} lines (raw ${rawTotal}${ignoredAdds !== null ? `, ignored ${ignoredAdds}` : ''}${unstagedAdds ? `, unstaged ${unstagedAdds} (settles into this ratio!)` : ''}), ratio ${(ratio * 100).toFixed(1)}%`);
    if (ai > visible) {
      console.error('[ai-ratio] BLOCKED: ratio > 100%');
      console.error('存在部分暂存提交，无法精确计算本次提交的贡献率，检查无误后可关闭校验点后进行提交。');
      process.exit(1);
    }
    if (unstagedAdds > 0) {
      console.log(`[ai-ratio] note: git-ai settles the whole tree; ${unstagedAdds} unstaged lines inflate the ratio above what THIS commit alone deserves`);
    }
    if (ratio < MIN_AI_RATIO) {
      console.error(`[ai-ratio] BLOCKED: ratio < ${MIN_AI_RATIO * 100}% threshold`);
      console.error('[ai-ratio] force commit: git commit --no-verify');
      process.exit(1);
    }
  }

  // Rule 2: bulk-import guard on the raw git basis (sees what git-ai cannot).
  if (!IMPORT_OFF && rawTotal > IMPORT_TOTAL_MIN && rawTotal < IMPORT_TOTAL_MAX && ai < IMPORT_AI_MIN) {
    console.error(`[ai-ratio] BLOCKED: bulk commit ${rawTotal} lines with only ${ai} AI lines (import guard)`);
    console.error('[ai-ratio] force commit: git commit --no-verify');
    process.exit(1);
  }
})();
