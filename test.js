'use strict';
// Full-path regression suite for trae-ai-lines.
// Usage: node test.js [targetDir] [artifactDir]
//   Default target is this repo. To check package consistency, pass the
//   extracted VSIX extension directory as artifactDir. Rule-1 numbers use a fake
//   git-ai binary under an overridden HOME.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = __dirname;
const TARGET = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
const GUARD = path.join(TARGET, 'guard.js');
const HOOK = path.join(TARGET, 'hooks', 'check-ai-ratio.js');
const ENTRY = path.join(TARGET, 'hooks', 'pre-commit');
const HOOK_TAG = fs.readFileSync(HOOK, 'utf8').match(/^\/\/ (guard-v\d+):/m)[1];

let pass = 0, fail = 0;
const ASYNC = []; // promises carrying async asserts (setThreshold etc.)
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? ' :: ' + extra : ''}`); }
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-lines-suite-'));

function mkrepo(name) {
  const r = path.join(TMP, name);
  fs.mkdirSync(r, { recursive: true });
  execFileSync('git', ['-C', r, 'init', '-q']);
  execFileSync('git', ['-C', r, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', r, 'config', 'user.name', 't']);
  execFileSync('git', ['-C', r, 'commit', '-q', '--allow-empty', '-m', 'base', '--no-verify']);
  return r;
}
function installHook(repo, pct, legacy = false) {
  const h = path.join(repo, '.git', 'hooks');
  let src = fs.readFileSync(HOOK, 'utf8');
  if (pct !== undefined) src = src.replace(/(AI_RATIO_MIN \|\| ')__AI_RATIO__('\))/, `$1${pct}$2`);
  if (legacy) src = src.replace(/^\/\/ guard-v\d+:/m, '// guard-v8:');
  fs.writeFileSync(path.join(h, 'check-ai-ratio.js'), src);
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  fs.chmodSync(path.join(h, 'pre-commit'), 0o755);
  if (!legacy) fs.writeFileSync(path.join(repo, '.git', 'ai-ratio-guard.json'), JSON.stringify({
    enabled: true, importOn: true, threshold: pct === undefined ? undefined : Number(pct) * 100
  }));
  return path.join(h, 'check-ai-ratio.js');
}
function changeSettings(repo, patch) {
  const p = path.join(repo, '.git', 'ai-ratio-guard.json');
  fs.writeFileSync(p, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(p, 'utf8')), patch)));
}
const FAKE_HOME = path.join(TMP, 'fakehome');
const DEAD_HOME = path.join(TMP, 'deadhome');
const NODAEMON_HOME = path.join(TMP, 'nodaemonhome'); // binary present, no live daemon
function fakeRuntime(home) {
  const bin = path.join(home, '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime', '1.0.0', 'x', 'host');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git-ai'),
    '#!/bin/sh\n' +
    'if [ "$1" = effective-ignore-patterns ]; then printf "%s\\n" "${FAKE_IGNORE_PATTERNS:-[]}"\n' +
    'else echo \'{"stats":{"git_diff_added_lines":\'${FAKE_AI:-0}\',"human_additions":0,"unknown_additions":0}}\'\nfi\n');
  fs.chmodSync(path.join(bin, 'git-ai'), 0o755);
}
(function buildFakeHome() {
  fakeRuntime(FAKE_HOME);
  // the v6 daemon gate: rule-1/lib queries only run when daemonAlive() sees a
  // live pid. FAKE_HOME must register one (the test process itself) or every
  // rule-1 case silently turns into "daemon offline, skipped".
  const reg = path.join(FAKE_HOME, '.trae-cn', '.git-ai-tob', 'tenant1', 'internal', 'daemon');
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, 'daemon.pid.json'), JSON.stringify({ pid: process.pid }));
  fakeRuntime(NODAEMON_HOME); // same binary, deliberately NO pid registry
  fs.mkdirSync(DEAD_HOME, { recursive: true });
})();
const bulkFixture = { NODE_OPTIONS: '--require ' + JSON.stringify(path.join(ROOT, 'test-fixtures', 'staged-bulk.cjs')) };
function writeAIIgnore(repo, contents) {
  fs.writeFileSync(path.join(repo, '.git-ai-ignore'), contents);
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n.git-ai-ignore\n.gitignore\n');
}
function runHook(script, repo, opts) {
  const o = opts || {};
  const env = Object.assign({}, process.env, { GIT_AI_CWD: repo });
  if (o.home) env.HOME = o.home;
  if (o.ai !== undefined) env.FAKE_AI = String(o.ai);
  Object.assign(env, o.extra || {});
  const r = spawnSync('node', [script], { cwd: repo, env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function lines(repo, name, n) {
  fs.writeFileSync(path.join(repo, name),
    Array.from({ length: n }, (_, i) => 'l' + i).join('\n') + '\n');
}
function add(repo, names) {
  for (const n of names) execFileSync('git', ['-C', repo, 'add', '--', n]);
}

console.log(`suite target: ${TARGET}`);

// ---------- A. hook behavior ----------
console.log('A. hook behavior');

{ // A1 nothing staged
  const r = mkrepo('a1');
  const s = installHook(r, 0.50);
  const h = runHook(s, r, { home: FAKE_HOME });
  ok('A1 nothing staged -> exit 0', h.code === 0 && !h.out.includes('BLOCKED'), h.out.trim());
}
{ // A2 git-ai unavailable -> rule 1 skipped
  const r = mkrepo('a2');
  lines(r, 'f.txt', 10); add(r, ['f.txt']);
  const s = installHook(r, 0.50);
  const h = runHook(s, r, { home: DEAD_HOME });
  ok('A2 git-ai dead -> rule1 skipped, exit 0', h.code === 0 && !h.out.includes('BLOCKED') && !/commit AI/.test(h.out), h.out.trim());
}
{ // A3 git-ai unavailable + bulk -> rule 2 blocks
  const r = mkrepo('a3');
  lines(r, 'bulk.txt', 1); add(r, ['bulk.txt']);
  const s = installHook(r, 0.50);
  const h = runHook(s, r, { home: DEAD_HOME, extra: bulkFixture });
  ok('A3 git-ai dead + bulk import -> rule2 blocks', h.code === 1 && h.out.includes('import guard') && h.out.includes('BLOCKED'), h.out.trim());
}
{ // A4 master off setting
  const r = mkrepo('a4');
  lines(r, 'f.txt', 10); add(r, ['f.txt']);
  const s = installHook(r, 0.50);
  changeSettings(r, { enabled: false });
  const h = runHook(s, r, { home: FAKE_HOME, ai: 0 });
  ok('A4 master off -> skip', h.code === 0 && /disabled, skip/.test(h.out), h.out.trim());
}
{ // A5 env escape hatch
  const r = mkrepo('a5');
  lines(r, 'f.txt', 10); add(r, ['f.txt']);
  const s = installHook(r, 0.50);
  const h = runHook(s, r, { home: FAKE_HOME, ai: 0, extra: { AI_RATIO_OFF: '1' } });
  // env escape shares the 'disabled, skip' message with master off; distinct
  // because this repo has NO marker file - env is the only skip reason.
  ok('A5 AI_RATIO_OFF=1 -> skip', h.code === 0 && /disabled, skip/.test(h.out)
    && !fs.existsSync(path.join(r, '.git', 'hooks', '.ai-ratio-off')), h.out.trim());
}
{ // A6 unreplaced placeholder -> NaN fallback 50%
  const r = mkrepo('a6');
  lines(r, 'f.txt', 10); add(r, ['f.txt']);
  const s = installHook(r); // placeholder survives
  const blocked = runHook(s, r, { home: FAKE_HOME, ai: 0 });
  ok('A6a placeholder + low ratio -> blocked at default 50%', blocked.code === 1 && blocked.out.includes('ratio < 50%'), blocked.out.trim());
  const pass = runHook(s, r, { home: FAKE_HOME, ai: 10 });
  ok('A6b placeholder + 100% ratio -> pass (fallback is 50, not always-block)', pass.code === 0, pass.out.trim());
}
{ // A7 threshold value enforced
  const r1 = mkrepo('a7a');
  lines(r1, 'f.txt', 2); add(r1, ['f.txt']);
  const s1 = installHook(r1, '1.00');
  const b = runHook(s1, r1, { home: FAKE_HOME, ai: 1 });
  ok('A7a threshold 100% -> 50% blocked', b.code === 1 && b.out.includes('ratio < 100%'), b.out.trim());
  const r2 = mkrepo('a7b');
  lines(r2, 'f.txt', 2); add(r2, ['f.txt']);
  const s2 = installHook(r2, '0.50');
  const p = runHook(s2, r2, { home: FAKE_HOME, ai: 1 });
  ok('A7b threshold 50% -> 50% pass', p.code === 0, p.out.trim());
}
{ // A8 .git-ai-ignore subtracts from denominator
  const r = mkrepo('a8');
  writeAIIgnore(r, 'gen.txt\n');
  lines(r, 'gen.txt', 1); lines(r, 'real.txt', 1); add(r, ['gen.txt', 'real.txt']);
  const s = installHook(r, '0.70');
  // Excluding the generated line raises 1/2 to 1/1.
  const h = runHook(s, r, { home: FAKE_HOME, ai: 1 });
  ok('A8 ignore subtraction -> 1/1 passes 70%', h.code === 0 && /ignored 1/.test(h.out), h.out.trim());
}
{ // A9 CJK filename in ignore
  const r = mkrepo('a9');
  writeAIIgnore(r, '\u6587\u4ef6\u540d.txt\n');
  lines(r, '\u6587\u4ef6\u540d.txt', 1); lines(r, 'real.txt', 1); add(r, ['\u6587\u4ef6\u540d.txt', 'real.txt']);
  const s = installHook(r, '0.80');
  const h = runHook(s, r, { home: FAKE_HOME, ai: 1 });
  ok('A9 CJK path ignored -> pass + ignored 1', h.code === 0 && /ignored 1/.test(h.out), h.out.trim());
}
{ // A10 rename staged, no crash
  const r = mkrepo('a10');
  writeAIIgnore(r, 'gen2.js\n');
  fs.writeFileSync(path.join(r, 'gen.js'), 'existing generated content\n');
  lines(r, 'real.txt', 1); add(r, ['gen.js', 'real.txt']);
  execFileSync('git', ['-C', r, 'commit', '-q', '-m', 'c', '--no-verify']);
  lines(r, 'real.txt', 2); // modify after commit
  execFileSync('git', ['-C', r, 'mv', 'gen.js', 'gen2.js']);
  fs.appendFileSync(path.join(r, 'gen2.js'), 'x\n');
  add(r, ['gen2.js', 'real.txt']);
  const s = installHook(r, '0.50');
  const h = runHook(s, r, { home: FAKE_HOME, ai: 1 });
  ok('A10 rename + ignore new path -> no crash, ignored counted', h.code === 0 && /ignored \d+/.test(h.out), h.code + ' :: ' + h.out.trim());
}
for (const test of [{ name: 'A11a', importOn: true, expected: 1 }, { name: 'A11b', importOn: false, expected: 0 }]) {
  const r = mkrepo(test.name);
  writeAIIgnore(r, 'bulk.txt\n');
  lines(r, 'bulk.txt', 1); lines(r, 'real.txt', 1); add(r, ['bulk.txt', 'real.txt']);
  const hook = installHook(r, 0.50);
  changeSettings(r, { importOn: test.importOn });
  const result = runHook(hook, r, { home: FAKE_HOME, ai: 1, extra: bulkFixture });
  // Rule 1 sees 1/1. Rule 2 also sees the 20,000 simulated ignored lines.
  ok(test.name + ' bulk threshold follows the import switch',
    result.code === test.expected && /commit AI 1 \/ 1/.test(result.out)
    && result.out.includes('import guard') === test.importOn, result.out.trim());
}
{ // A12 binary present but daemon offline -> rule 1 skipped, NEVER exec the
  // CLI (it would auto-spawn a config-less daemon that the Trae extension
  // then reuses, killing attribution for later commits - the 2026-10-13 bug)
  const r = mkrepo('a12');
  lines(r, 'f.txt', 10); add(r, ['f.txt']);
  const s = installHook(r, '0.50');
  // same numbers as A6a (which BLOCKS at FAKE_HOME): the only difference is
  // no live daemon -> must pass with the offline note, not block and not silently
  const h = runHook(s, r, { home: NODAEMON_HOME, ai: 0 });
  ok('A12 daemon offline -> rule1 skipped + note', h.code === 0 && /daemon offline/.test(h.out) && !h.out.includes('BLOCKED'), h.out.trim());
}
{ // A13 daemon offline + bulk import -> rule 2 (pure git) still blocks
  const r = mkrepo('a13');
  lines(r, 'bulk.txt', 1); add(r, ['bulk.txt']);
  const s = installHook(r, '0.50');
  const h = runHook(s, r, { home: NODAEMON_HOME, ai: 0, extra: bulkFixture });
  ok('A13 daemon offline + bulk -> rule2 blocks', h.code === 1 && h.out.includes('import guard') && h.out.includes('BLOCKED'), h.out.trim());
}

{ // A14 ordinary .gitignore must not remove tracked manual code from the denominator
  const r = mkrepo('a14');
  fs.writeFileSync(path.join(r, '.gitignore'), 'manual.txt\n');
  writeAIIgnore(r, 'generated.txt\n');
  lines(r, 'manual.txt', 1); lines(r, 'ai.txt', 1);
  execFileSync('git', ['-C', r, 'add', '-f', '--', 'manual.txt', 'ai.txt']);
  const h = runHook(installHook(r, '0.80'), r, { home: FAKE_HOME, ai: 1 });
  ok('A14 gitignore does not inflate 1/2 into 1/1', h.code === 1 && /commit AI 1 \/ 2 lines/.test(h.out), h.out.trim());
}
{ // A15 a partial commit uses the original ratio, with a strict upper bound
  const r = mkrepo('a15');
  lines(r, 'staged.txt', 1); add(r, ['staged.txt']);
  lines(r, 'outside.txt', 1);
  const hook = installHook(r, 0.80);
  const exact = runHook(hook, r, { home: FAKE_HOME, ai: 1 });
  ok('A15a exactly 100% passes with another new file outside the commit',
    exact.code === 0 && /commit AI 1 \/ 1/.test(exact.out), exact.out.trim());
  const excess = runHook(hook, r, { home: FAKE_HOME, ai: 2 });
  ok('A15b a ratio above 100% is blocked',
    excess.code === 1 && /BLOCKED: ratio > 100%/.test(excess.out), excess.out.trim());
}
{ // A16 numstat's compact directory rename must resolve to the real destination
  const r = mkrepo('a16');
  fs.mkdirSync(path.join(r, 'src'));
  fs.writeFileSync(path.join(r, 'src/old.js'), 'existing generated content\n'); add(r, ['src/old.js']);
  execFileSync('git', ['-C', r, 'commit', '-q', '-m', 'base-file', '--no-verify']);
  execFileSync('git', ['-C', r, 'mv', 'src/old.js', 'src/new.js']);
  fs.appendFileSync(path.join(r, 'src/new.js'), 'x\n');
  lines(r, 'real.txt', 1); add(r, ['src/new.js', 'real.txt']);
  writeAIIgnore(r, 'src/new.js\n');
  const h = runHook(installHook(r, '0.80'), r, { home: FAKE_HOME, ai: 1 });
  ok('A16 nested rename ignores exactly its one added line',
    h.code === 0 && /commit AI 1 \/ 1 lines \(raw 2, ignored 1\)/.test(h.out), h.out.trim());
}
{ // A17 explicit ignore patterns and their negation are independent of .gitignore
  const r = mkrepo('a17');
  fs.mkdirSync(path.join(r, 'generated'));
  fs.writeFileSync(path.join(r, '.gitignore'), '!generated/**\n');
  writeAIIgnore(r, 'generated/**\n!generated/keep.txt\n');
  lines(r, 'generated/auto.txt', 2); lines(r, 'generated/keep.txt', 1); lines(r, 'real.txt', 1);
  add(r, ['generated/auto.txt', 'generated/keep.txt', 'real.txt']);
  const h = runHook(installHook(r, '0.70'), r, { home: FAKE_HOME, ai: 2 });
  ok('A17 git-ai-ignore negation works without gitignore precedence',
    h.code === 0 && /commit AI 2 \/ 2 lines \(raw 4, ignored 2\)/.test(h.out), h.out.trim());
}
{ // A18 Git quotes tabs/newlines even with core.quotepath=false; NUL paths stay exact
  const r = mkrepo('a18');
  const name = 'generated\tfile\nwith space.txt';
  writeAIIgnore(r, 'generated*\n');
  lines(r, name, 1); lines(r, 'real.txt', 1); add(r, [name, 'real.txt']);
  const h = runHook(installHook(r, '0.80'), r, { home: FAKE_HOME, ai: 1 });
  ok('A18 special filename ignored without quoted-path mismatch',
    h.code === 0 && /commit AI 1 \/ 1 lines \(raw 2, ignored 1\)/.test(h.out), h.out.trim());
}

// ---------- B. guard module ----------
console.log('B. guard module');
const g = require(GUARD);
function mvs(repo) {
  return {
    workspace: { workspaceFolders: [{ uri: { fsPath: repo } }] },
    window: {
      showInputBox: async () => '80',
      showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
      createOutputChannel: () => ({ clear() {}, show() {}, appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({ text: '', tooltip: null, show() {}, hide() {}, name: 'x', command: 'y' }),
    },
    MarkdownString: class { constructor(v) { this.value = v; } },
  };
}
const scriptOf = r => path.join(r, '.git', 'hooks', 'check-ai-ratio.js');
const readOf = r => fs.readFileSync(scriptOf(r), 'utf8');

{ // B1 readState on fresh repo
  const r = mkrepo('b1');
  const s = g.readState(path.join(r, '.git', 'hooks'));
  // readState returns threshold as PERCENT (0-100), matching status-bar display
  ok('B1 fresh -> not installed, default 50', !s.installed && s.threshold === 50 && !s.importOn, JSON.stringify(s));
}
{ // B2 writeHooks refuses foreign pre-commit
  const r = mkrepo('b2');
  const h = path.join(r, '.git', 'hooks');
  fs.writeFileSync(path.join(h, 'pre-commit'), '#!/bin/sh\necho foreign\n');
  let threw = false;
  try { g.writeHooks(h, 80); } catch { threw = true; }
  ok('B2 foreign pre-commit -> refuse', threw);
}
{ // B3 writeHooks installs correctly
  const r = mkrepo('b3');
  const h = path.join(r, '.git', 'hooks');
  g.writeHooks(h, 80);
  const s = g.readState(h);
  const entry = fs.statSync(path.join(h, 'pre-commit'));
  ok('B3 install -> threshold 80, entry executable, enabled',
    s.installed && s.threshold === 80 && s.enabled && (entry.mode & 0o111) !== 0, JSON.stringify(s));
}
{ // Incomplete hand-written settings must display the same fallback as the hook.
  const r = mkrepo('b3-threshold'), h = path.join(r, '.git', 'hooks');
  g.writeHooks(h, 90, r);
  const config = path.join(r, '.git', 'ai-ratio-guard.json');
  for (const value of [undefined, null, '90']) {
    fs.writeFileSync(config, JSON.stringify({ enabled: true, threshold: value }));
    const s = g.readState(h, r);
    ok(`B3 invalid/missing threshold ${String(value)} falls back to 50`, s.enabled && s.threshold === 50);
  }
  fs.writeFileSync(scriptOf(r), readOf(r).replace(/(AI_RATIO_MIN \|\| ')0\.50('\))/, '$10.85$2'));
  ok('B3 invalid setting preserves the installed hook fallback', g.readState(h, r).threshold === 85);
  fs.writeFileSync(config, JSON.stringify({ enabled: true, threshold: 95 }));
  ok('B3 valid repository threshold takes precedence over hook fallback', g.readState(h, r).threshold === 95);
}
{ // B4 actually start from an old tag, then verify version + states after upgrade
  const r = mkrepo('b4');
  const h = path.join(r, '.git', 'hooks');
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(scriptOf(r), fs.readFileSync(HOOK, 'utf8')
    .replace(/^\/\/ guard-v\d+:/m, '// guard-v0:')
    .replace(/(AI_RATIO_MIN \|\| ')__AI_RATIO__('\))/, '$10.90$2'));
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  fs.writeFileSync(path.join(h, '.ai-ratio-off'), '');
  fs.writeFileSync(path.join(h, '.ai-ratio-import-off'), '');
  ok('B4a fixture really contains an old hook tag', readOf(r).includes('// guard-v0:') && !readOf(r).includes(HOOK_TAG));
  g.autoUpgrade(mvs(r));
  const s = g.readState(h);
  ok('B4 upgrade keeps threshold/off/import states', s.threshold === 90 && !s.enabled && s.importOn === false && g.readState(h).installed, JSON.stringify(s));
  ok('B4b tag updated', readOf(r).includes(HOOK_TAG));
}
{ // B28 untagged 0.2.19/0.2.20 hooks must migrate without trusting edited scripts.
  for (const version of ['0.2.19', '0.2.20']) {
    const original = fs.readFileSync(path.join(ROOT, 'test-fixtures', `check-ai-ratio-${version}.js`), 'utf8');
    for (const enabled of [true, false]) {
      const r = mkrepo(`b28-${version}-${enabled}`), h = path.join(r, '.git', 'hooks');
      let src = original.replace(/(AI_RATIO_MIN \|\| ')__AI_RATIO__('\))/, '$10.85$2');
      if (enabled) src = src.replace(/\n/g, '\r\n');
      fs.writeFileSync(path.join(h, 'check-ai-ratio.js'), src);
      fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
      fs.chmodSync(path.join(h, 'pre-commit'), 0o755);
      if (!enabled) fs.writeFileSync(path.join(h, '.ai-ratio-off'), '');
      if (enabled) fs.writeFileSync(path.join(h, '.ai-ratio-import-off'), '');
      const before = g.readState(h, r);
      ok(`B28 ${version} recognises legacy ownership and settings (${enabled})`,
        before.installed && before.enabled === enabled && before.threshold === 85 && before.importOn === !enabled, JSON.stringify(before));
      g.autoUpgrade(mvs(r));
      const after = g.readState(h, r);
      ok(`B28 ${version} startup upgrades and preserves settings (${enabled})`,
        readOf(r).includes(HOOK_TAG) && after.enabled === enabled && after.threshold === 85 && after.importOn === !enabled
        && fs.existsSync(path.join(r, '.git', 'ai-ratio-guard.json')), JSON.stringify(after));
      const snapshot = readOf(r);
      g.autoUpgrade(mvs(r));
      ok(`B28 ${version} upgrade is idempotent (${enabled})`, readOf(r) === snapshot);
    }
    const r = mkrepo(`b28-edited-${version}`), h = path.join(r, '.git', 'hooks');
    const edited = original + '\nconsole.log("custom action");\n';
    const legacyFile = path.join(h, 'check-ai-ratio.js');
    fs.writeFileSync(legacyFile, edited);
    fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
    g.autoUpgrade(mvs(r));
    let refused = false;
    try { g.writeHooks(h, 80, r); } catch (e) { refused = e.message.includes('check-ai-ratio.js'); }
    ok(`B28 ${version} edited legacy checker is refused and preserved`,
      refused && fs.readFileSync(legacyFile, 'utf8') === edited
      && !fs.existsSync(path.join(r, '.git', 'ai-ratio-guard.json')));
  }
}

{ // B5 autoUpgrade heals a hand-copied placeholder hook
  const r = mkrepo('b5');
  const h = path.join(r, '.git', 'hooks');
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(scriptOf(r), fs.readFileSync(HOOK, 'utf8')); // tag v5, placeholder
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  g.autoUpgrade(mvs(r));
  const src = readOf(r);
  ok('B5 placeholder healed', !src.includes('__AI_RATIO__') && g.readState(h).threshold === 50, src.match(/AI_RATIO_MIN[^\n]*/)[0]);
  const snap = src;
  g.autoUpgrade(mvs(r));
  ok('B5b idempotent second run', readOf(r) === snap);
}
{ // B6 foreign pre-commit untouched
  const r = mkrepo('b6');
  const e = path.join(r, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(e, '#!/bin/sh\necho foreign\n');
  g.autoUpgrade(mvs(r));
  ok('B6 foreign untouched', fs.readFileSync(e, 'utf8') === '#!/bin/sh\necho foreign\n');
}
{ // B7 setThreshold patches installed hook (async - must await)
  const r = mkrepo('b7');
  const h = path.join(r, '.git', 'hooks');
  g.writeHooks(h, 50);
  ASYNC.push(g.setThreshold(mvs(r), { text: '', tooltip: null, show() {}, hide() {} }).then(() => {
    ok('B7 setThreshold 80', g.readState(h).threshold === 80, readOf(r).match(/AI_RATIO_MIN[^\n]*/)[0]);
  }));
}
{ // B8 setThreshold on placeholder hook rewrites from template (async - must await)
  const r = mkrepo('b8');
  const h = path.join(r, '.git', 'hooks');
  fs.mkdirSync(h, { recursive: true });
  fs.writeFileSync(scriptOf(r), fs.readFileSync(HOOK, 'utf8'));
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  ASYNC.push(g.setThreshold(mvs(r), { text: '', tooltip: null, show() {}, hide() {} }).then(() => {
    const src = readOf(r);
    ok('B8 placeholder + setThreshold -> rewritten with 80', !src.includes('__AI_RATIO__') && g.readState(h).threshold === 80, src.match(/AI_RATIO_MIN[^\n]*/)[0]);
  }));
}
{ // B9 toggle off/on
  const r = mkrepo('b9');
  const h = path.join(r, '.git', 'hooks');
  g.writeHooks(h, 80);
  const item = { text: '', tooltip: null, show() {}, hide() {} };
  g.toggle(mvs(r), item);
  ok('B9a toggle -> disabled', g.readState(h).installed && !g.readState(h).enabled);
  g.toggle(mvs(r), item);
  ok('B9b toggle again -> enabled', g.readState(h).enabled);
}
{ // B10 toggleImport
  const r = mkrepo('b10');
  const h = path.join(r, '.git', 'hooks');
  g.writeHooks(h, 80);
  const item = { text: '', tooltip: null, show() {}, hide() {} };
  g.toggleImport(mvs(r), item);
  const settings = () => JSON.parse(fs.readFileSync(path.join(r, '.git', 'ai-ratio-guard.json'), 'utf8'));
  ok('B10a toggleImport -> repository setting off', !g.readState(h).importOn && !settings().importOn);
  g.toggleImport(mvs(r), item);
  ok('B10b toggleImport again -> repository setting on', g.readState(h).importOn && settings().importOn);
}
{ // B11 multi-root: toggle off->on must keep EACH repo's own threshold
  // (regression: used to reinstall every repo with locs[0]'s value, silently
  // loosening a stricter sibling repo from 100 down to 50)
  const rx = mkrepo('b11x'), ry = mkrepo('b11y');
  const hx = path.join(rx, '.git', 'hooks'), hy = path.join(ry, '.git', 'hooks');
  g.writeHooks(hx, 50); g.writeHooks(hy, 100);
  const two = {
    workspace: { workspaceFolders: [{ uri: { fsPath: rx } }, { uri: { fsPath: ry } }] },
    window: {
      showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
      createStatusBarItem: () => ({ text: '', tooltip: null, show() {}, hide() {}, name: 'x', command: 'y' }),
    },
    MarkdownString: class { constructor(v) { this.value = v; } },
  };
  const item = { text: '', tooltip: null, show() {}, hide() {} };
  g.toggle(two, item); // off (writes markers to both)
  g.toggle(two, item); // on  -> must reinstall each with its OWN threshold
  ok('B11a toggle keeps per-repo thresholds (50 / 100)',
    g.readState(hx).threshold === 50 && g.readState(hy).threshold === 100,
    `${g.readState(hx).threshold}/${g.readState(hy).threshold}`);
  g.toggleImport(two, item); // import on -> marker (no reinstall)
  g.toggleImport(two, item); // import off -> reinstall, again per-repo
  ok('B11b toggleImport keeps per-repo thresholds (50 / 100)',
    g.readState(hx).threshold === 50 && g.readState(hy).threshold === 100,
    `${g.readState(hx).threshold}/${g.readState(hy).threshold}`);
}

{ // B12 install where Git reads hooks, including relative/absolute paths and a nested workspace
  for (const absolute of [false, true]) {
    const r = mkrepo(absolute ? 'b12-absolute' : 'b12-relative');
    const h = absolute ? path.join(TMP, 'absolute hooks') : path.join(r, 'custom hooks');
    execFileSync('git', ['-C', r, 'config', 'core.hooksPath', absolute ? h : 'custom hooks']);
    const folder = path.join(r, 'nested'); fs.mkdirSync(folder);
    const item = { text: '', show() {}, hide() {} };
    g.toggle(mvs(folder), item);
    lines(r, 'manual.txt', 5); add(r, ['manual.txt']);
    const commit = spawnSync('git', ['-C', r, 'commit', '-q', '-m', 'must-block'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: FAKE_HOME, FAKE_AI: '0' }) });
    ok(`B12 ${absolute ? 'absolute' : 'relative'} hooksPath blocks real git commit`,
      fs.existsSync(path.join(h, 'pre-commit')) && commit.status === 1 && /BLOCKED/.test(commit.stderr), commit.stderr);
  }
}
{ // B13 a linked worktree shares the main repository's hook directory
  const r = mkrepo('b13-main'), wt = path.join(TMP, 'b13 worktree');
  execFileSync('git', ['-C', r, 'worktree', 'add', '-q', '-b', 'audit', wt]);
  const item = { text: '', show() {}, hide() {} };
  g.toggle(mvs(wt), item);
  lines(wt, 'manual.txt', 5); add(wt, ['manual.txt']);
  const commit = spawnSync('git', ['-C', wt, 'commit', '-q', '-m', 'must-block'],
    { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: FAKE_HOME, FAKE_AI: '0' }) });
  ok('B13 worktree installs shared hook and blocks real git commit',
    fs.existsSync(path.join(r, '.git', 'hooks', 'pre-commit')) && commit.status === 1 && /BLOCKED/.test(commit.stderr), commit.stderr);
}
{ // B14 the checker alone does not mean Git can execute our pre-commit entry
  const r = mkrepo('b14'), h = path.join(r, '.git', 'hooks'), entry = path.join(h, 'pre-commit');
  g.writeHooks(h, 80); fs.unlinkSync(entry);
  ok('B14a missing entry is not enabled', !g.readState(h).enabled);
  g.autoUpgrade(mvs(r));
  ok('B14b activation repairs missing entry and keeps threshold',
    fs.existsSync(entry) && g.readState(h).enabled && g.readState(h).threshold === 80);
  if (process.platform !== 'win32') {
    g.writeHooks(h, 80); fs.chmodSync(entry, 0o644);
    ok('B14c non-executable entry is not enabled', !g.readState(h).enabled);
    g.autoUpgrade(mvs(r));
    ok('B14d activation repairs entry permissions', g.readState(h).enabled && (fs.statSync(entry).mode & 0o111) !== 0);
  }
  fs.writeFileSync(entry, '#!/bin/sh\necho foreign\n');
  ok('B14e foreign replacement is not enabled', !g.readState(h).enabled);
  g.autoUpgrade(mvs(r));
  ok('B14f repair never overwrites a foreign entry', fs.readFileSync(entry, 'utf8') === '#!/bin/sh\necho foreign\n');
}
{ // B15 enabling an import sub-rule must preserve the explicit master-off state
  const r = mkrepo('b15'), h = path.join(r, '.git', 'hooks');
  installHook(r, '0.80', true); // legacy configuration: both marker switches are off
  fs.writeFileSync(path.join(h, '.ai-ratio-off'), '');
  fs.writeFileSync(path.join(h, '.ai-ratio-import-off'), '');
  g.toggleImport(mvs(r), { text: '', show() {}, hide() {} });
  ok('B15 import enable keeps master off and threshold 80',
    !g.readState(h).enabled && g.readState(h).importOn && g.readState(h).threshold === 80);
}
{ // B16 placeholder repair while setting a threshold must also keep master off
  const r = mkrepo('b16'), h = path.join(r, '.git', 'hooks');
  installHook(r, undefined, true);
  fs.writeFileSync(path.join(h, '.ai-ratio-off'), '');
  ASYNC.push(g.setThreshold(mvs(r), { text: '', show() {}, hide() {} }).then(() => {
    ok('B16 setThreshold repairs placeholder without enabling master',
      !g.readState(h).enabled && g.readState(h).threshold === 80);
  }));
}

{ // B17 mentioning our name does not make a foreign hook ours
  const r = mkrepo('b17'), h = path.join(r, '.git', 'hooks');
  const entry = '#!/bin/sh\n# Company check; ai-ratio-guard is handled separately\necho company-check\nexit 1\n';
  fs.writeFileSync(path.join(h, 'pre-commit'), entry);
  let refused = false;
  try { g.writeHooks(h, 80); } catch { refused = true; }
  g.autoUpgrade(mvs(r));
  ok('B17 foreign hook mentioning ai-ratio-guard is preserved', refused
    && fs.readFileSync(path.join(h, 'pre-commit'), 'utf8') === entry);
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  const checker = '// foreign checker mentions ai-ratio-guard\nprocess.exit(1);\n';
  fs.writeFileSync(path.join(h, 'check-ai-ratio.js'), checker);
  refused = false;
  try { g.writeHooks(h, 80); } catch { refused = true; }
  ok('B17b foreign checker is preserved', refused
    && fs.readFileSync(path.join(h, 'check-ai-ratio.js'), 'utf8') === checker);
}
{ // B18 two independent windows/repositories sharing the same hooks directory
  const a = mkrepo('b18a'), b = mkrepo('b18b'), h = path.join(TMP, 'shared hooks');
  for (const r of [a, b]) {
    execFileSync('git', ['-C', r, 'config', 'core.hooksPath', h]);
    lines(r, 'manual.txt', 10); add(r, ['manual.txt']);
  }
  const item = { text: '', show() {}, hide() {} };
  g.toggle(mvs(a), item);
  const hook = path.join(h, 'check-ai-ratio.js');
  ok('B18a shared hook does not implicitly enable another repo',
    !g.readState(h, b).enabled && runHook(hook, b, { home: FAKE_HOME, ai: 0 }).code === 0);
  g.toggle(mvs(b), item);
  const vb = mvs(b); vb.window.showInputBox = async () => '100';
  ASYNC.push((async () => {
    await g.setThreshold(vb, item);
    ok('B18b shared hook thresholds are per repo (50 / 100)',
      g.readState(h, a).threshold === 50 && g.readState(h, b).threshold === 100);
    ok('B18c shared hook enforces each repo threshold',
      runHook(hook, a, { home: FAKE_HOME, ai: 8 }).code === 0
      && runHook(hook, b, { home: FAKE_HOME, ai: 8 }).code === 1);
    g.toggleImport(mvs(a), item);
    ok('B18d shared hook import switches are per repo',
      !g.readState(h, a).importOn && g.readState(h, b).importOn);
    for (const r of [a, b]) { lines(r, 'bulk.txt', 1); add(r, ['bulk.txt']); }
    ok('B18d2 shared hook enforces each repo import switch',
      runHook(hook, a, { home: DEAD_HOME, extra: bulkFixture }).code === 0
      && runHook(hook, b, { home: DEAD_HOME, extra: bulkFixture }).code === 1);
    g.toggle(mvs(a), item);
    ok('B18e shared hook master switches are per repo',
      !g.readState(h, a).enabled && g.readState(h, b).enabled
      && runHook(hook, a, { home: FAKE_HOME, ai: 0 }).code === 0
      && runHook(hook, b, { home: FAKE_HOME, ai: 0 }).code === 1);
  })());
}
{ // B19 preserve legacy custom-hooks settings for every opened repo before rewriting shared code
  const a = mkrepo('b19a'), b = mkrepo('b19b'), h = path.join(TMP, 'legacy shared hooks');
  fs.mkdirSync(h);
  for (const r of [a, b]) execFileSync('git', ['-C', r, 'config', 'core.hooksPath', h]);
  fs.writeFileSync(path.join(h, 'check-ai-ratio.js'), fs.readFileSync(HOOK, 'utf8')
    .replace(/^\/\/ guard-v\d+:/m, '// guard-v8:')
    .replace(/(AI_RATIO_MIN \|\| ')__AI_RATIO__('\))/, '$10.90$2'));
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  fs.chmodSync(path.join(h, 'pre-commit'), 0o755);
  fs.writeFileSync(path.join(h, '.ai-ratio-off'), '');
  fs.writeFileSync(path.join(h, '.ai-ratio-import-off'), '');
  const two = mvs(a);
  two.workspace.workspaceFolders.push({ uri: { fsPath: b } });
  g.autoUpgrade(two);
  ok('B19 legacy shared hooks migrate threshold and both off switches', [a, b].every(r => {
    const s = g.readState(h, r);
    return s.threshold === 90 && !s.enabled && !s.importOn;
  }));
}
{ // B20 related worktrees use one repository setting, not separate copies
  const r = mkrepo('b20-main'), wt = path.join(TMP, 'b20-worktree');
  execFileSync('git', ['-C', r, 'worktree', 'add', '-q', '-b', 'config-test', wt]);
  const h = path.join(r, '.git', 'hooks'), item = { text: '', show() {}, hide() {} };
  g.toggle(mvs(wt), item);
  ok('B20a enabling in worktree is visible from main repo', g.readState(h, r).enabled);
  g.toggle(mvs(r), item);
  ok('B20b disabling main repo applies to worktree', !g.readState(h, wt).enabled);
}
{ // B21 another repo can point hooksPath at a repository's default hooks directory
  const a = mkrepo('b21a'), b = mkrepo('b21b'), h = path.join(a, '.git', 'hooks');
  execFileSync('git', ['-C', b, 'config', 'core.hooksPath', h]);
  g.toggle(mvs(b), { text: '', show() {}, hide() {} });
  lines(a, 'manual.txt', 10); add(a, ['manual.txt']);
  g.autoUpgrade(mvs(a));
  ok('B21 shared default-hooks directory does not implicitly enable its owner',
    !g.readState(h, a).enabled && g.readState(h, b).enabled
    && runHook(path.join(h, 'check-ai-ratio.js'), a, { home: FAKE_HOME, ai: 0 }).code === 0);
}
{ // B22 repairing a missing checker retains repository settings
  const r = mkrepo('b22'), h = path.join(r, '.git', 'hooks');
  g.writeHooks(h, 80);
  changeSettings(r, { enabled: false, importOn: false });
  fs.unlinkSync(path.join(h, 'check-ai-ratio.js'));
  g.toggleImport(mvs(r), { text: '', show() {}, hide() {} });
  const s = g.readState(h);
  ok('B22 reinstall keeps repository master off and threshold', !s.enabled && s.importOn && s.threshold === 80);
}

{ // B23 legacy shared hooks migrate in separate windows, preserving the old default
  const a = mkrepo('b23a'), b = mkrepo('b23b'), h = path.join(TMP, 'b23-shared');
  fs.mkdirSync(h);
  for (const r of [a, b]) execFileSync('git', ['-C', r, 'config', 'core.hooksPath', h]);
  fs.writeFileSync(path.join(h, 'check-ai-ratio.js'), fs.readFileSync(HOOK, 'utf8')
    .replace(/^\/\/ guard-v\d+:/m, '// guard-v8:')
    .replace(/(AI_RATIO_MIN \|\| ')__AI_RATIO__('\))/, '$10.90$2'));
  fs.writeFileSync(path.join(h, 'pre-commit'), fs.readFileSync(ENTRY));
  fs.chmodSync(path.join(h, 'pre-commit'), 0o755);
  fs.writeFileSync(path.join(h, '.ai-ratio-import-off'), '');
  g.autoUpgrade(mvs(a));
  ASYNC.push((async () => {
    // A's later change must not become B's migration default.
    await g.setThreshold(mvs(a), { show() {}, hide() {} });
    const child = spawnSync('node', ['-e',
      `require(${JSON.stringify(GUARD)}).autoUpgrade({workspace:{workspaceFolders:[{uri:{fsPath:${JSON.stringify(b)}}}]}})`],
      { encoding: 'utf8' });
    ok('B23a separate-window upgrade preserves legacy threshold and import-off', child.status === 0
      && g.readState(h, b).threshold === 90 && !g.readState(h, b).importOn
      && !g.readState(h, b).enabled && g.readState(h, a).threshold === 80);
    g.toggle(mvs(b), { show() {}, hide() {} });
    lines(b, 'manual.txt', 10); add(b, ['manual.txt']);
    const commit = spawnSync('git', ['-C', b, 'commit', '-q', '-m', 'must-block-at-90'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: FAKE_HOME, FAKE_AI: '8' }) });
    ok('B23b re-enabled migrated repo still rejects 80 percent at legacy 90',
      g.readState(h, b).enabled && g.readState(h, b).threshold === 90
      && commit.status === 1 && /BLOCKED/.test(commit.stderr), commit.stderr);
  })());
}
if (process.platform !== 'win32') { // B24 group execute must not hide a non-executable owner
  const r = mkrepo('b24'), h = path.join(r, '.git', 'hooks'), entry = path.join(h, 'pre-commit');
  g.writeHooks(h, 80); fs.chmodSync(entry, 0o654);
  let executable = true; try { fs.accessSync(entry, fs.constants.X_OK); } catch { executable = false; }
  if (!executable) {
    ok('B24a no owner execution is reported disabled', !g.readState(h).enabled);
    g.autoUpgrade(mvs(r));
    lines(r, 'manual.txt', 10); add(r, ['manual.txt']);
    const commit = spawnSync('git', ['-C', r, 'commit', '-q', '-m', 'must-block-after-permission-repair'],
      { encoding: 'utf8', env: Object.assign({}, process.env, { HOME: FAKE_HOME, FAKE_AI: '0' }) });
    ok('B24b activation repairs permission and Git executes the guard',
      g.readState(h).enabled && commit.status === 1 && /BLOCKED/.test(commit.stderr), commit.stderr);
  } else console.log('  --  B24 skipped: effective user can execute mode 0654');
}

{ // B25 one damaged config must not stop repairs in other workspace repositories
  for (const enabled of [true, false]) {
    const a = mkrepo(`b25-broken-${enabled}`), b = mkrepo(`b25-healthy-${enabled}`);
    const ah = path.join(a, '.git', 'hooks'), bh = path.join(b, '.git', 'hooks');
    g.writeHooks(ah, 90, a);
    g.writeHooks(bh, 80, b, { enabled, importOn: false });
    const config = path.join(b, '.git', 'ai-ratio-guard.json');
    const saved = fs.readFileSync(config);
    const brokenConfig = path.join(a, '.git', 'ai-ratio-guard.json');
    fs.writeFileSync(brokenConfig, '{');
    const crlf = fs.readFileSync(ENTRY, 'utf8').replace(/\n/g, '\r\n');
    for (const h of [ah, bh]) fs.writeFileSync(path.join(h, 'pre-commit'), crlf);
    const vscode = mvs(a);
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: b } });
    const errors = [], oldError = console.error;
    let thrown;
    console.error = (...args) => errors.push(args.join(' '));
    try { g.autoUpgrade(vscode); } catch (e) { thrown = e; }
    finally { console.error = oldError; }
    ok(`B25 ${enabled}: bad config is reported without aborting other repairs`,
      !thrown && errors.length === 1 && errors[0].includes(a), thrown && thrown.message);
    ok(`B25 ${enabled}: damaged repository is left unchanged`,
      fs.readFileSync(brokenConfig, 'utf8') === '{'
      && fs.readFileSync(path.join(ah, 'pre-commit'), 'utf8') === crlf);
    ok(`B25 ${enabled}: healthy entry repaired with settings preserved`,
      fs.readFileSync(path.join(bh, 'pre-commit')).equals(fs.readFileSync(ENTRY))
      && fs.readFileSync(config).equals(saved));
    lines(b, 'manual.txt', 10); add(b, ['manual.txt']);
    const commit = spawnSync('git', ['-C', b, 'commit', '-q', '-m', 'after-isolated-repair'], {
      encoding: 'utf8', env: Object.assign({}, process.env, { HOME: FAKE_HOME, FAKE_AI: '0',
        AI_RATIO_OFF: '', AI_RATIO_MIN: '', GIT_AI_CWD: '' })
    });
    ok(`B25 ${enabled}: real commit follows preserved switch`, enabled
      ? commit.status === 1 && /BLOCKED: ratio < 80%/.test(commit.stderr)
      : commit.status === 0, commit.stderr);
  }
}

{ // B26 exercise activation and registered commands, not only autoUpgrade()
  ASYNC.push((async () => {
    const vm = require('vm');
    const a = mkrepo('b26a'), b = mkrepo('b26b');
    const ah = path.join(a, '.git', 'hooks'), bh = path.join(b, '.git', 'hooks');
    g.writeHooks(ah, 90, a); g.writeHooks(bh, 80, b, { enabled: false, importOn: false });
    const config = path.join(a, '.git', 'ai-ratio-guard.json');
    const savedA = fs.readFileSync(config), savedB = fs.readFileSync(path.join(b, '.git', 'ai-ratio-guard.json'));
    fs.writeFileSync(config, '{');
    fs.writeFileSync(path.join(bh, 'pre-commit'), fs.readFileSync(ENTRY, 'utf8').replace(/\n/g, '\r\n'));
    const vscode = mvs(a), commands = {}, items = [], errors = [], logs = [];
    let inputCalls = 0;
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: b } });
    vscode.StatusBarAlignment = { Right: 2 };
    vscode.commands = { registerCommand(id, fn) { commands[id] = fn; return { dispose() {} }; } };
    vscode.window.createStatusBarItem = () => {
      const item = { text: '', visible: false, show() { this.visible = true; },
        hide() { this.visible = false; }, dispose() {} };
      items.push(item); return item;
    };
    vscode.window.showErrorMessage = message => errors.push(message);
    vscode.window.showInputBox = async () => { inputCalls++; return '85'; };
    const quietConsole = { log() {}, error(...args) { logs.push(args.join(' ')); } };
    const guardContext = { module: { exports: {} }, __dirname: TARGET, process, console: quietConsole,
      require: name => name === 'vscode' ? vscode : require(name) };
    vm.runInNewContext(fs.readFileSync(GUARD, 'utf8'), guardContext);
    const extensionContext = { module: { exports: {} }, process, console: quietConsole,
      setInterval() { return 1; }, clearInterval() {}, setTimeout(fn) { fn(); },
      require: name => name === 'vscode' ? vscode : name === './guard' ? guardContext.module.exports
        : name === './lib' ? { AiLinesCounter: class { async poll() {} sums() { return { ai: 1, total: 2, commits: 1 }; } },
          localDate: () => '2026-10-18', uncommitted: async () => null, gitDiffStat: async () => null } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(TARGET, 'extension.js'), 'utf8'), extensionContext);
    const context = { subscriptions: [] };
    try {
      extensionContext.module.exports.activate(context);
      await new Promise(setImmediate);
      ok('B26 startup shows configuration error instead of hiding guard',
        items[1].visible && items[1].text.includes('\u914d\u7f6e\u5f02\u5e38')
        && String(items[1].tooltip).includes(config) && !logs.some(s => s.includes('guard init failed')));
      ok('B26 counter and other repository repair survive bad first config',
        items[0].visible && items[0].text.includes('AI 1 / 2')
        && fs.readFileSync(path.join(bh, 'pre-commit')).equals(fs.readFileSync(ENTRY)));
      for (const id of ['aiLines.guardToggle', 'aiLines.guardSetThreshold', 'aiLines.guardToggleImport']) {
        const previous = errors.length;
        let thrown;
        try { await commands[id](); } catch (e) { thrown = e; }
        ok(`B26 ${id} reports config path without throwing`, !thrown && errors.length === previous + 1
          && errors[errors.length - 1].includes(config), thrown && thrown.message);
      }
      ok('B26 invalid commands preserve configs and do not open threshold input', inputCalls === 0
        && fs.readFileSync(config, 'utf8') === '{'
        && fs.readFileSync(path.join(b, '.git', 'ai-ratio-guard.json')).equals(savedB));
      fs.writeFileSync(config, savedA);
      await commands['aiLines.guardSetThreshold']();
      ok('B26 commands and status recover after config is repaired', inputCalls === 1
        && items[1].text.includes('85%') && g.readState(ah, a).threshold === 85
        && g.readState(bh, b).threshold === 85 && !g.readState(bh, b).enabled);
      fs.writeFileSync(config, '{');
      await commands['aiLines.guardToggle']();
      ok('B26 runtime config failure replaces stale enabled status',
        items[1].visible && items[1].text.includes('\u914d\u7f6e\u5f02\u5e38'));
    } finally { context.subscriptions.forEach(d => d.dispose()); }
  })());
}

{ // B29 explicit bulk enable isolates conflicting repositories and preserves settings.
  const repos = ['conflict', 'already', 'disabled', 'fresh', 'bad-config', 'foreign-checker', 'after-errors']
    .map(name => fs.realpathSync(mkrepo('b29-' + name)));
  const [conflict, already, disabled, fresh, bad, foreign, after] = repos;
  const hookDir = r => path.join(r, '.git', 'hooks');
  const config = r => path.join(r, '.git', 'ai-ratio-guard.json');
  const foreignEntry = '#!/bin/sh\n# existing project hook\nexit 0\n';
  fs.writeFileSync(path.join(hookDir(conflict), 'pre-commit'), foreignEntry);
  g.writeHooks(hookDir(already), 70, already, { enabled: true, importOn: false });
  g.writeHooks(hookDir(disabled), 85, disabled, { enabled: false, importOn: false });
  g.writeHooks(hookDir(bad), 80, bad); fs.writeFileSync(config(bad), '{');
  fs.writeFileSync(path.join(hookDir(foreign), 'check-ai-ratio.js'), 'foreign checker\n');
  const savedAlready = fs.readFileSync(config(already));
  const existingMtime = fs.statSync(config(already)).mtimeMs;
  fs.mkdirSync(path.join(fresh, 'module'));
  const vscode = mvs(conflict), warnings = [];
  vscode.workspace.workspaceFolders = [...repos, path.join(fresh, 'module')].map(fsPath => ({ uri: { fsPath } }));
  vscode.window.showWarningMessage = message => warnings.push(message);
  const results = g.enableAll(vscode, { show() {}, hide() {} });
  ok('B29 bulk enable processes each repository once despite duplicate workspace roots',
    results.length === repos.length && results.filter(r => r.cwd === fresh).length === 1);
  ok('B29 conflicts and malformed configs do not block later repositories',
    results.filter(r => r.status === 'failed').length === 3
    && g.readState(hookDir(after), after).enabled && g.readState(hookDir(fresh), fresh).enabled);
  ok('B29 foreign hooks, foreign checkers and malformed configs are preserved',
    fs.readFileSync(path.join(hookDir(conflict), 'pre-commit'), 'utf8') === foreignEntry
    && fs.readFileSync(path.join(hookDir(foreign), 'check-ai-ratio.js'), 'utf8') === 'foreign checker\n'
    && fs.readFileSync(config(bad), 'utf8') === '{');
  const state = g.readState(hookDir(disabled), disabled);
  ok('B29 enabling a disabled repo retains its threshold and import setting',
    state.enabled && state.threshold === 85 && !state.importOn);
  ok('B29 an already enabled repo is not rewritten',
    results.find(r => r.cwd === already).status === 'alreadyEnabled'
    && fs.readFileSync(config(already)).equals(savedAlready)
    && fs.statSync(config(already)).mtimeMs === existingMtime);
  const newState = g.readState(hookDir(fresh), fresh);
  ok('B29 fresh repos receive normal defaults and failures have repository-specific reasons',
    newState.threshold === 50 && newState.importOn
    && results.filter(r => r.status === 'failed').every(r => r.error && r.cwd)
    && warnings.length === 1);
  lines(fresh, 'manual.txt', 1); add(fresh, ['manual.txt']);
  const commit = spawnSync('git', ['commit', '-qm', 'one manual line'], { cwd: fresh,
    encoding: 'utf8', env: { ...process.env, HOME: FAKE_HOME, FAKE_AI: '0',
      AI_RATIO_OFF: '', AI_RATIO_MIN: '', GIT_AI_CWD: '', GIT_AI_DAEMON_HOME: '', GIT_AI_DAEMON_CONTROL_SOCKET: '' } });
  ok('B29 bulk-installed hooks really block a one-line non-AI commit',
    commit.status === 1 && (commit.stdout + commit.stderr).includes('BLOCKED: ratio < 50%'));
  const empty = mvs(fresh); empty.workspace.workspaceFolders = [];
  ok('B29 no repositories produces an empty result without installing anything', g.enableAll(empty, {}).length === 0);
}

{ // B30 migrate both previous two-hook layouts while preserving settings.
  const referencePrefix = [
    '#!/bin/sh', '# managed by ai-ratio-guard', '[ "$1" = prepared ] || exit 0',
    'git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 0'
  ];
  const v24Reference = [...referencePrefix,
    'ticket="$git_dir/ai-ratio-commit-$PPID"', '[ -f "$ticket" ] || exit 0',
    'exec node "$(dirname "$0")/check-ai-ratio.js" --reference-transaction "$ticket"', ''
  ].join('\n');
  const v28Reference = [...referencePrefix,
    'command -v node >/dev/null 2>&1 || exit 0',
    'for ticket in "$git_dir"/ai-ratio-commit-*; do', '  [ -f "$ticket" ] || continue',
    '  AI_RATIO_HOOK_PARENT=$PPID exec node "$(dirname "$0")/check-ai-ratio.js" --reference-transaction "$git_dir"',
    'done', ''
  ].join('\n');
  const currentEntry = fs.readFileSync(ENTRY, 'utf8');
  const layouts = [
    { version: 24, parent: 'AI_RATIO_GIT_PID', contents: v24Reference, foreign: false },
    { version: 28, parent: 'AI_RATIO_HOOK_PARENT', contents: v28Reference, foreign: false },
    { version: 28, parent: 'AI_RATIO_HOOK_PARENT', contents: v28Reference + '# project-owned change\n', foreign: true }
  ];
  for (const { version, parent, contents, foreign } of layouts) {
    const kind = foreign ? 'custom' : 'managed';
    const repo = mkrepo(`b30-${version}-${kind}`);
    const checker = installHook(repo, '0.87');
    const hooks = path.dirname(checker);
    const entry = path.join(hooks, 'pre-commit');
    const reference = path.join(hooks, 'reference-transaction');
    const oldEntry = currentEntry.replace('\nnode ', `\n${parent}=$PPID exec node `).trimEnd() + ' --pre-commit\n';
    fs.writeFileSync(checker, fs.readFileSync(checker, 'utf8').replace(HOOK_TAG, `guard-v${version}`));
    fs.writeFileSync(entry, oldEntry);
    fs.writeFileSync(reference, contents, { mode: 0o755 });
    changeSettings(repo, { enabled: !foreign, importOn: false });
    g.autoUpgrade(mvs(repo));
    const s = g.readState(hooks, repo);
    ok(`B30 v${version} upgrades and preserves settings with ${kind} reference hook`,
      fs.readFileSync(checker, 'utf8').includes(HOOK_TAG) && fs.readFileSync(entry, 'utf8') === currentEntry
      && s.enabled === !foreign && s.threshold === 87 && !s.importOn);
    ok(`B30 v${version} leaves only project-owned reference hooks`,
      foreign ? fs.readFileSync(reference, 'utf8') === contents : !fs.existsSync(reference));
  }
}

// ---------- C. lib self-check ----------
console.log('C. lib self-check');
{
  const r = spawnSync('node', [path.join(TARGET, 'lib.js')], { encoding: 'utf8' });
  ok('C1 lib.js invariants hold', r.status === 0, (r.stdout || r.stderr || '').slice(0, 200));
}
{
  // uncommitted() is async; assert via a child process so exit code is settled
  const r = spawnSync('node', ['-e',
    `require(${JSON.stringify(path.join(TARGET, 'lib.js'))}).uncommitted(${JSON.stringify(path.join(TMP, 'no-such-dir'))})` +
    '.then(r => process.exit(r === null ? 0 : 3), () => process.exit(9))']);
  ok('C2 uncommitted(non-repo) -> null', r.status === 0, 'exit ' + r.status);
}
{
  // C3 the v6 daemon gate in lib: binary exists + real repo, but no live
  // daemon -> uncommitted() must return null WITHOUT exec-ing the CLI (which
  // would auto-spawn a config-less daemon). With the gate removed the fake
  // binary answers and the result is non-null -> exit 3.
  const r = mkrepo('c3');
  lines(r, 'f.txt', 5); add(r, ['f.txt']);
  const p = spawnSync('node', ['-e',
    `require(${JSON.stringify(path.join(TARGET, 'lib.js'))}).uncommitted(${JSON.stringify(r)})` +
    '.then(v => process.exit(v === null ? 0 : 3), () => process.exit(9))'],
    { env: Object.assign({}, process.env, { HOME: NODAEMON_HOME }), encoding: 'utf8' });
  ok('C3 uncommitted(daemon offline) -> null, CLI never exec', p.status === 0, 'exit ' + p.status + ' :: ' + (p.stdout || p.stderr || '').slice(0, 120));
}

{ // C5 the real CLI needs Trae's tenant home and control socket, not just a live PID.
  const home = path.join(TMP, 'c5-home');
  fakeRuntime(home);
  const tenant = path.join(home, '.trae-cn', '.git-ai-tob', 'tenant-b');
  const reg = path.join(tenant, 'internal', 'daemon');
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, 'daemon.pid.json'), JSON.stringify({ pid: process.pid }));
  const digest = require('crypto').createHash('sha256').update(tenant).digest('hex').slice(0, 16);
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\tob-git-ai-${digest}-control`
    : path.join(os.tmpdir(), `tob-git-ai-d-${digest}`, 'control.sock');
  const bin = path.join(home, '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime', '1.0.0', 'x', 'host', 'git-ai');
  fs.writeFileSync(bin, `#!${process.execPath}\n` +
    `const e = process.env;\n` +
    `if (e.GIT_AI_DAEMON_HOME !== ${JSON.stringify(tenant)} ||\n` +
    `    e.GIT_AI_DAEMON_CONTROL_SOCKET !== (e.EXPECT_SOCKET || ${JSON.stringify(socket)}) ||\n` +
    `    e.GIT_AI_NOTES_REF !== 'refs/notes/ai-tob' ||\n` +
    `    e._GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN !== 'true' ||\n` +
    `    process.argv.slice(2).join(' ') !== 'status --json') process.exit(1);\n` +
    `console.log(JSON.stringify({stats:{git_diff_added_lines:10,human_additions:4,unknown_additions:0}}));\n`);
  const repo = mkrepo('c5');
  lines(repo, 'code.txt', 10); add(repo, ['code.txt']);
  const hook = installHook(repo, 0.8);
  const baseEnv = { ...process.env, HOME: home, GIT_AI_DAEMON_HOME: '',
    GIT_AI_DAEMON_CONTROL_SOCKET: '', GIT_AI_NOTES_REF: '',
    _GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN: 'false' };
  const query = extra => spawnSync('node', ['-e',
    `require(${JSON.stringify(path.join(TARGET, 'lib.js'))}).uncommitted(${JSON.stringify(repo)})` +
    `.then(v => { console.log(JSON.stringify(v)); process.exit(v && v.ai === 6 && v.total === 10 ? 0 : 3); })`],
    { env: { ...baseEnv, ...extra }, encoding: 'utf8' });
  const q = query({});
  ok('C5a uncommitted connects to the live Trae tenant with auto-spawn disabled', q.status === 0, q.stdout + q.stderr);
  const h = runHook(hook, repo, { home, extra: baseEnv });
  ok('C5b hook query enforces 60% < 80% instead of silently skipping',
    h.code === 1 && h.out.includes('BLOCKED: ratio < 80%'), h.out);
  const commit = spawnSync('git', ['commit', '-qm', 'must be blocked'], { cwd: repo, env: baseEnv, encoding: 'utf8' });
  ok('C5d real git commit is blocked through the tenant connection',
    commit.status !== 0 && (commit.stdout + commit.stderr).includes('BLOCKED: ratio < 80%'), commit.stdout + commit.stderr);
  const custom = path.join(TMP, 'explicit-control.sock');
  const q2 = query({ GIT_AI_DAEMON_HOME: tenant, GIT_AI_DAEMON_CONTROL_SOCKET: custom, EXPECT_SOCKET: custom });
  ok('C5c explicit daemon home and socket are preserved', q2.status === 0, q2.stdout + q2.stderr);
}

{ // C6 pending totals must use .git-ai-ignore while the Git diff details stay raw.
  const pending = (cwd, ai) => {
    const p = spawnSync('node', ['-e',
      `require(${JSON.stringify(path.join(TARGET, 'lib.js'))}).uncommitted(${JSON.stringify(cwd)}).then(v => console.log(JSON.stringify(v)))`],
      { env: { ...process.env, HOME: FAKE_HOME, FAKE_AI: String(ai), GIT_AI_DAEMON_HOME: '', GIT_AI_DAEMON_CONTROL_SOCKET: '' }, encoding: 'utf8' });
    if (p.status !== 0) throw Error(p.stderr);
    return JSON.parse(p.stdout);
  };
  const expect = (name, cwd, ai, total, adds, dels = 0) => {
    const r = pending(cwd, ai);
    ok(name, r && r.ai === Math.min(ai, total) && r.total === total && r.gitAdds === adds && r.gitDels === dels, JSON.stringify(r));
  };
  const repo = mkrepo('c6-mixed');
  fs.mkdirSync(path.join(repo, 'sub'));
  lines(repo, 'code.txt', 1); lines(repo, 'generated.txt', 1);
  add(repo, ['code.txt', 'generated.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'base files', '--no-verify']);
  fs.appendFileSync(path.join(repo, 'code.txt'), 'a\nb\n');
  fs.appendFileSync(path.join(repo, 'generated.txt'), 'generated\n'.repeat(10));
  add(repo, ['code.txt']);
  expect('C6 no ignore file keeps staged and unstaged additions', repo, 2, 12, 12);
  fs.writeFileSync(path.join(repo, '.git-ai-ignore'), 'generated.txt\n');
  const ruleBytes = fs.readFileSync(path.join(repo, '.git-ai-ignore'));
  expect('C6 ignored unstaged additions are removed only from pending total', repo, 2, 2, 12);
  expect('C6 subfolder workspace resolves repository-root ignore rules', path.join(repo, 'sub'), 2, 2, 12);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'code.txt\n');
  fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'code.txt\n');
  expect('C6 gitignore and info/exclude do not hide tracked additions', repo, 2, 2, 12);
  ok('C6 existing ignore file is never modified', fs.readFileSync(path.join(repo, '.git-ai-ignore')).equals(ruleBytes));
  fs.writeFileSync(path.join(repo, '.git-ai-ignore'), '*\n');
  expect('C6 all ignored yields zero without losing raw Git diff', repo, 0, 0, 12);
  fs.writeFileSync(path.join(repo, '.git-ai-ignore'), '*\n!code.txt\n');
  expect('C6 negation restores explicitly included tracked files', repo, 2, 2, 12);
  fs.writeFileSync(path.join(repo, 'generated.txt'), 'replacement\n'.repeat(4));
  expect('C6 ignored replacements keep raw additions and deletions visible', repo, 2, 2, 6, 1);

  const renamed = mkrepo('c6-rename');
  lines(renamed, 'old.txt', 40); add(renamed, ['old.txt']);
  execFileSync('git', ['-C', renamed, 'commit', '-qm', 'base file', '--no-verify']);
  execFileSync('git', ['-C', renamed, 'mv', 'old.txt', 'generated.txt']);
  fs.appendFileSync(path.join(renamed, 'generated.txt'), 'new\n');
  fs.writeFileSync(path.join(renamed, '.git-ai-ignore'), 'generated.txt\n');
  expect('C6 rename is filtered by destination path', renamed, 0, 0, 1);

  const special = mkrepo('c6-paths');
  const name = 'generated-中文\t换\n行.txt';
  lines(special, name, 1); lines(special, 'code.txt', 1);
  add(special, [name, 'code.txt']);
  execFileSync('git', ['-C', special, 'commit', '-qm', 'base files', '--no-verify']);
  fs.appendFileSync(path.join(special, name), 'ignored\n'.repeat(3));
  fs.appendFileSync(path.join(special, 'code.txt'), 'kept\n'.repeat(2));
  fs.writeFileSync(path.join(special, '.git-ai-ignore'), 'generated-*\n');
  expect('C6 tabs, newlines and CJK filenames filter correctly', special, 2, 2, 5);
  fs.writeFileSync(path.join(special, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 10, 0xce, 0xc4, 10]));
  add(special, ['gbk.txt']);
  expect('C6 included GBK additions remain in the filtered total', special, 2, 4, 7);
}

{ // C7 render the actual tooltip with real Git and an unavailable AI daemon.
  const repo = mkrepo('c7-tooltip');
  lines(repo, 'tracked.txt', 1); add(repo, ['tracked.txt']);
  execFileSync('git', ['-C', repo, 'commit', '-qm', 'tracked base', '--no-verify']);
  const tooltip = cwd => {
    const script = `
      const fs = require('fs'), vm = require('vm');
      const lib = require(${JSON.stringify(path.join(TARGET, 'lib.js'))});
      const vscode = { workspace: { workspaceFolders: [{ uri: { fsPath: ${JSON.stringify(cwd)} } }] },
        MarkdownString: class { constructor(value) { this.value = value; } } };
      const context = { module: { exports: {} }, setTimeout: fn => fn(),
        require: name => name === 'vscode' ? vscode : name === './lib' ? lib : {} };
      vm.runInNewContext(fs.readFileSync(${JSON.stringify(path.join(TARGET, 'extension.js'))}, 'utf8') +
        '\\nitem = { text: "" }; counter = { async poll() {}, sums() { return {ai: 1, total: 2, commits: 1}; } };' +
        '\\nmodule.exports.render = async () => { await refresh(); return item.tooltip; };', context);
      context.module.exports.render().then(v => console.log(JSON.stringify(v)));
    `;
    const p = spawnSync('node', ['-e', script], { encoding: 'utf8', env: { ...process.env,
      HOME: NODAEMON_HOME, GIT_AI_DAEMON_HOME: '', GIT_AI_DAEMON_CONTROL_SOCKET: '' } });
    if (p.status !== 0) throw Error(p.stderr);
    return JSON.parse(p.stdout).value || p.stdout;
  };
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'new1\nnew2\n');
  const changed = tooltip(repo);
  ok('C7 unstaged diff stays visible when AI daemon is offline',
    changed.includes('未提交：-') && changed.includes('git diff：+2 / -1'), changed);
  execFileSync('git', ['-C', repo, 'checkout', '--', 'tracked.txt']);
  const clean = tooltip(repo);
  ok('C7 clean Git diff explicitly displays zero', clean.includes('git diff：+0 / -0'), clean);
  lines(repo, 'untracked.txt', 3);
  const untracked = tooltip(repo);
  ok('C7 untracked files keep Git diff at zero without being staged',
    untracked.includes('git diff：+0 / -0') &&
    execFileSync('git', ['-C', repo, 'ls-files', '--', 'untracked.txt'], { encoding: 'utf8' }) === '', untracked);
  const missing = tooltip(NODAEMON_HOME);
  ok('C7 a non-repository does not claim a successful zero diff',
    missing.includes('未提交：-') && !missing.includes('git diff：+0'), missing);
}

{ // B27 v9 already uses per-repo settings: a new hook tag must not re-enable an unconfigured repo.
  const repo = mkrepo('b27');
  const h = path.join(repo, '.git', 'hooks');
  const script = installHook(repo, 0.8);
  fs.writeFileSync(script, fs.readFileSync(script, 'utf8').replace(/^\/\/ guard-v\d+:/m, '// guard-v9:'));
  fs.unlinkSync(path.join(repo, '.git', 'ai-ratio-guard.json'));
  ok('B27a unconfigured v9 repository remains disabled before upgrade', !g.readState(h, repo).enabled);
  g.autoUpgrade(mvs(repo));
  ok('B27b upgrade to the new connection code preserves disabled state',
    !g.readState(h, repo).enabled && fs.readFileSync(script, 'utf8').includes(HOOK_TAG));
}

// ---------- D. artifact consistency ----------
console.log('D. artifact consistency');
{
  const v = JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version;
  ok(`D1 package.json version reads ${v}`, /^\d+\.\d+\.\d+$/.test(v));
  if (process.argv[3]) {
    const artifact = path.resolve(process.argv[3]);
    const files = ['package.json', 'guard.js', 'extension.js', 'lib.js', 'panel.js', 'icon.png',
      'hooks/check-ai-ratio.js', 'hooks/pre-commit', 'scripts/diagnose-ai-guard.sh', 'scripts/diagnose-ai-guard.ps1'];
    try {
      const different = files.filter(f => !fs.readFileSync(path.join(TARGET, f)).equals(fs.readFileSync(path.join(artifact, f))));
      ok('D2 extracted artifact matches target files', different.length === 0, different.join(', '));
    } catch (e) {
      ok('D2 extracted artifact matches target files', false, e.message);
    }
    try {
      const artifactVersion = JSON.parse(fs.readFileSync(path.join(artifact, 'package.json'), 'utf8')).version;
      ok('D3 extracted artifact version matches target', artifactVersion === v, artifactVersion);
    } catch (e) {
      ok('D3 extracted artifact version matches target', false, e.message);
    }
  }
}
{
  const r = spawnSync('node', ['--check', path.join(TARGET, 'guard.js')]);
  ok('D4 guard.js syntax', r.status === 0);
  const r2 = spawnSync('node', ['--check', HOOK]);
  ok('D5 hook template syntax', r2.status === 0);
}

Promise.all(ASYNC.map(p => p.catch(e => {
  ok('async regression completed without exception', false, e.stack || String(e));
}))).finally(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
