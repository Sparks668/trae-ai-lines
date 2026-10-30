#!/usr/bin/env node
'use strict';
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
//          subtracted via check-ignore + core.excludesFile so scripts/md noise
//          does not dilute the ratio. If check-ignore is unavailable, fall back
//          to the old settled denominator.
//   Same accounting as trae-ai-lines' uncommitted().
//
// Rule 2 - bulk-import guard (sub-switch: .ai-ratio-import-off off-marker):
//   total = raw git staged added lines (numstat, NOT git-ai filtered - external
//           imports are invisible to git-ai, which is exactly the loophole this
//           rule closes). Block when 10000 < total < 50000 and AI lines < 5000.
//
// .ai-ratio-off is the MASTER switch: it disables both rules.
// AI_RATIO_OFF=1 is the single-commit escape hatch (same effect as master off).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const MIN_AI_RATIO = parseFloat(process.env.AI_RATIO_MIN || '__AI_RATIO__');
const IMPORT_TOTAL_MIN = 10000; // bulk guard: min raw git added lines
const IMPORT_TOTAL_MAX = 50000; // bulk guard: max raw git added lines
const IMPORT_AI_MIN = 5000;     // bulk guard: AI lines required below this size

const MASTER_OFF = !!process.env.AI_RATIO_OFF ||
  fs.existsSync(path.join(__dirname, '.ai-ratio-off'));
const IMPORT_OFF = fs.existsSync(path.join(__dirname, '.ai-ratio-import-off'));

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

function exec(cmd, args) {
  const cwd = process.env.GIT_AI_CWD || process.cwd();
  return new Promise(resolve =>
    execFile(cmd, args, { cwd, timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (e, so) => resolve(e ? null : so)));
}

(async () => {
  if (MASTER_OFF) { console.log('[ai-ratio] disabled, skip'); return; }

  // Raw git staged added lines: rule 2's total, and rule 1's denominator base.
  // core.quotepath=false: emit raw UTF-8 paths. The default octal+quoted form
  // ("src/\344...") is passed to check-ignore as a literal string and never
  // matches, silently killing the .git-ai-ignore subtraction for CJK filenames.
  const numstat = await exec('git', ['-c', 'core.quotepath=false', 'diff', '--cached', '--numstat']);
  if (numstat === null) { console.log('[ai-ratio] git diff failed, skip check'); return; }
  let rawTotal = 0;
  const files = []; // { adds, path } for .git-ai-ignore subtraction
  for (const line of numstat.split('\n')) {
    // \s*$ strips the CR half of CRLF on Windows; rename lines come through
    // as "old => new" - match ignores on the new path (where content now lives).
    const m = /^(\d+|-)\t(\d+|-)\t(.+?)\s*$/.exec(line);
    if (!m || m[1] === '-') continue;
    rawTotal += parseInt(m[1], 10);
    const r = /^(.*) => (.+)$/.exec(m[3]);
    files.push({ adds: parseInt(m[1], 10), path: r ? r[2] : m[3] });
  }

  // Subtract staged lines belonging to .git-ai-ignore'd files from the rule-1
  // denominator. check-ignore exits 1 when nothing is ignored - capture stdout
  // regardless of exit code. On any failure keep null (caller falls back).
  let ignoredAdds = null;
  const ignoreFile = path.join(process.env.GIT_AI_CWD || process.cwd(), '.git-ai-ignore');
  if (files.length && fs.existsSync(ignoreFile)) {
    const out = await new Promise(resolve => {
      // quotepath=false here too: check-ignore echoes paths in the same
      // quoted form by default, which would never equal the raw numstat paths.
      execFile('git', ['-c', 'core.quotepath=false', '-c', `core.excludesFile=${ignoreFile}`, 'check-ignore', '--no-index', '--', ...files.map(f => f.path)],
        { cwd: process.env.GIT_AI_CWD || process.cwd(), timeout: 15000, maxBuffer: 1024 * 1024 },
        (e, so) => resolve(e && e.code !== 1 ? null : so));
    });
    if (out !== null) {
      // strip \r: check-ignore on Windows ends lines CRLF; a trailing CR in
      // the Set entries would never equal the numstat paths.
      const set = new Set(out.split('\n').map(s => s.replace(/\r$/, '')).filter(Boolean));
      ignoredAdds = files.filter(f => set.has(f.path)).reduce((s, f) => s + f.adds, 0);
    }
  }

  // Settled source: rule 1's total and ai from the same stats (git-ai filtered).
  let ai = 0;
  let gitaiTotal = 0;
  let settled = false; // git-ai pipeline responded (safe to enforce rule 1)
  const bin = findGitAi();
  if (bin) {
    const out = await exec(bin, ['status', '--json']);
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
  }

  // Rule 1: ratio check. Numerator = net settled AI; denominator = real staged
  // lines (git-ai-ignore'd files subtracted). The old `gitaiTotal > 0` gate let
  // pure-external/human commits (invisible to git-ai) pass silently - exactly
  // what this guard exists to block. Enforce when git-ai is responsive and
  // there are real staged lines; skip only when the pipeline is dead or nothing
  // is staged. Never fall back to gitaiTotal as denominator: it is blind to
  // GBK/unsupported files (the 31/31=100% miss), so on check-ignore failure
  // (or repos without .git-ai-ignore) use rawTotal unchanged.
  const visible = ignoredAdds !== null ? Math.max(0, rawTotal - ignoredAdds) : rawTotal;
  if (settled && visible > 0) {
    const ratio = ai / visible;
    console.log(`[ai-ratio] commit AI ${ai} / ${visible} lines (raw ${rawTotal}${ignoredAdds !== null ? `, ignored ${ignoredAdds}` : ''}), ratio ${(ratio * 100).toFixed(1)}%`);
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
