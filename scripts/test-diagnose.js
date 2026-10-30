'use strict';
// Run with node scripts/test-diagnose.js. All Git/config changes stay in temp dirs.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const guard = require('../guard');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-diagnose-test-'));
const script = path.join(__dirname, 'diagnose-ai-guard.sh');
// Exercise multibyte shell parsing even when the test runner uses LC_ALL=C.
const env = { ...process.env, LC_ALL: 'en_US.UTF-8', HOME: path.join(tmp, 'home'), AI_RATIO_OFF: '', AI_RATIO_MIN: '',
  GIT_AI_DAEMON_HOME: '', GIT_AI_DAEMON_CONTROL_SOCKET: '' };
const git = (cwd, args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
try {
  const sh = fs.readFileSync(script, 'utf8');
  const ps = fs.readFileSync(path.join(__dirname, 'diagnose-ai-guard.ps1'), 'utf8');
  const reader = sh.split("<<'JS'\n")[1].split('\nJS\n')[0];
  check('Bash and PowerShell use identical config readers', () => {
    assert.strictEqual(ps.split("$stateReader = @'\n")[1].split("\n'@\n")[0], reader);
  });
  const diffReader = sh.split("<<'DIFF_JS'\n")[1].split('\nDIFF_JS\n')[0];
  check('Bash and PowerShell use identical staged diff readers', () => {
    assert.strictEqual(ps.split("$diffReader = @'\n")[1].split("\n'@\n")[0], diffReader);
  });
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'Test']);
  git(repo, ['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'base']);
  const hooks = path.join(tmp, 'shared-hooks');
  git(repo, ['config', 'core.hooksPath', hooks]);
  guard.writeHooks(hooks, 80, repo);
  const config = path.join(repo, '.git', 'ai-ratio-guard.json');
  const bin = path.join(env.HOME, '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime', '1.0.0', 'x', 'host');
  const daemon = path.join(env.HOME, '.trae-cn', '.git-ai-tob', 'test', 'internal', 'daemon');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(daemon, { recursive: true });
  fs.writeFileSync(path.join(bin, 'git-ai'), '#!/bin/sh\necho \'{"stats":{"git_diff_added_lines":10,"human_additions":4,"unknown_additions":0}}\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(daemon, 'daemon.pid.json'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(repo, 'code.txt'), 'line\n'.repeat(10));
  git(repo, ['add', 'code.txt']);
  const run = (cwd = repo, overrides = {}, expected = '80') => spawnSync('bash', [script, expected], {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8'
  });
  check('80% repo config agrees with actual hook despite 50% baked default', () => {
    const r = run(); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert(r.stdout.includes('有效阈值 = 80%（来源：仓库配置）'));
    assert(r.stdout.includes('BLOCKED: ratio < 80% threshold'));
  });
  for (const layout of ['without-tenant', 'explicit-home']) {
    check(`daemon discovery matches the hook: ${layout}`, () => {
      const home = path.join(tmp, layout), base = path.join(home, '.trae-cn', '.git-ai-tob');
      const runtime = path.join(base, 'tob-git-ai-runtime', '1.0.0', 'x', 'host');
      const daemonHome = layout === 'without-tenant' ? base : path.join(tmp, 'custom daemon 中文');
      fs.mkdirSync(runtime, { recursive: true });
      fs.copyFileSync(path.join(bin, 'git-ai'), path.join(runtime, 'git-ai'));
      fs.chmodSync(path.join(runtime, 'git-ai'), 0o755);
      const registry = path.join(daemonHome, 'internal', 'daemon');
      fs.mkdirSync(registry, { recursive: true });
      fs.writeFileSync(path.join(registry, 'daemon.pid.json'), JSON.stringify({ pid: process.pid }));
      const r = run(repo, { HOME: home, GIT_AI_DAEMON_HOME: layout === 'explicit-home' ? daemonHome : '' });
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert(r.stdout.includes('[PASS] daemon 存活'));
      assert(r.stdout.includes('BLOCKED: ratio < 80% threshold'));
    });
  }
  check('an unavailable explicit daemon home never falls back to a live default daemon', () => {
    const r = run(repo, { GIT_AI_DAEMON_HOME: path.join(tmp, 'missing-daemon') });
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert(r.stdout.includes('未找到 daemon.pid.json'));
    assert(!r.stdout.includes('[PASS] daemon 存活'));
    assert(r.stdout.includes('daemon offline'));
  });
  const entry = path.join(hooks, 'pre-commit');
  const template = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'pre-commit'), 'utf8');
  for (const [name, content] of [
    ['marker but exit 0', '#!/bin/sh\n# managed by ai-ratio-guard\nexit 0\n'],
    ['commented checker', template.replace('\nnode ', '\n# node ')],
    ['changed checker path', template.replace('check-ai-ratio.js', 'other.js')],
    ['extra command masks failure', template + '\nexit 0\n']
  ]) {
    check(`modified entry rejected without overwriting: ${name}`, () => {
      fs.writeFileSync(entry, content);
      try {
        assert.strictEqual(guard.readState(hooks, repo).enabled, false);
        const r = run(); assert.strictEqual(r.status, 1, r.stdout);
        assert(r.stdout.includes('入口内容与插件模板不一致'));
        assert.strictEqual(fs.readFileSync(entry, 'utf8'), content);
        if (name === 'marker but exit 0') {
          const commit = spawnSync('git', ['commit', '-qm', 'modified entry'], { cwd: repo, env, encoding: 'utf8' });
          assert.strictEqual(commit.status, 0, commit.stderr);
          git(repo, ['reset', '--soft', 'HEAD^']);
        }
      } finally { fs.writeFileSync(entry, template); }
    });
  }
  for (const [name, content] of [
    ['trailing whitespace', template + '\n \t\n']
  ]) {
    check(`entry normalization matches guard: ${name}`, () => {
      fs.writeFileSync(entry, content);
      try {
        assert.strictEqual(guard.readState(hooks, repo).enabled, true);
        const r = run(); assert.strictEqual(r.status, 0, r.stdout);
      } finally { fs.writeFileSync(entry, template); }
    });
  }
  for (const enabled of [true, false]) {
    check(`CRLF is rejected, then activation repairs LF preserving enabled=${enabled}`, () => {
      guard.writeHooks(hooks, 80, repo, { enabled, importOn: false });
      fs.writeFileSync(entry, template.replace(/\n/g, '\r\n'));
      try {
        assert.strictEqual(guard.readState(hooks, repo).enabled, false);
        const before = run(); assert.strictEqual(before.status, 1, before.stdout);
        assert(before.stdout.includes('CRLF'));
        if (process.platform !== 'win32') {
          const broken = spawnSync('git', ['commit', '-qm', 'CRLF'], { cwd: repo, env, encoding: 'utf8' });
          assert.notStrictEqual(broken.status, 0); assert(broken.stderr.includes('cannot exec'), broken.stderr);
        }
        guard.autoUpgrade({ workspace: { workspaceFolders: [{ uri: { fsPath: repo } }] } });
        assert.strictEqual(fs.readFileSync(entry, 'utf8'), template);
        const state = guard.readState(hooks, repo);
        assert.strictEqual(state.enabled, enabled); assert.strictEqual(state.masterOn, enabled);
        assert.strictEqual(state.threshold, 80); assert.strictEqual(state.importOn, false);
        const fixed = spawnSync('git', ['commit', '-qm', 'repaired LF'], { cwd: repo, env, encoding: 'utf8' });
        if (enabled) {
          assert.strictEqual(fixed.status, 1); assert(fixed.stderr.includes('BLOCKED: ratio < 80%'), fixed.stderr);
          assert.strictEqual(run().status, 0);
        } else {
          assert.strictEqual(fixed.status, 0, fixed.stderr); git(repo, ['reset', '--soft', 'HEAD^']);
        }
      } finally { fs.writeFileSync(entry, template); guard.writeHooks(hooks, 80, repo, { enabled: true, importOn: true }); }
    });
  }
  for (const [name, mode, damage] of [
    ['syntax error on deletion', 'delete', '\nconst broken = ;\n'],
    ['syntax error without changes', 'empty', '\nconst broken = ;\n'],
    ['runtime error after ratio output', 'add', '\nconsole.log("[ai-ratio] commit AI 6 / 10 lines, ratio 60.0%"); throw new Error("test failure");\n'],
    ['unexpected exit code', 'empty', '\nprocess.exit(7);\n']
  ]) {
    check(`execution failure is never a successful diagnosis: ${name}`, () => {
      const r = path.join(tmp, name); fs.mkdirSync(r); git(r, ['init', '-q']);
      git(r, ['config', 'user.name', 'Test']); git(r, ['config', 'user.email', 'test@example.invalid']);
      fs.writeFileSync(path.join(r, 'base.txt'), 'base\n'); git(r, ['add', 'base.txt']);
      git(r, ['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base']);
      if (mode === 'delete') git(r, ['rm', 'base.txt']);
      if (mode === 'add') { fs.writeFileSync(path.join(r, 'new.txt'), 'line\n'.repeat(10)); git(r, ['add', 'new.txt']); }
      const h = path.join(r, '.git', 'hooks'); guard.writeHooks(h, 80, r);
      const checker = path.join(h, 'check-ai-ratio.js'), original = fs.readFileSync(checker, 'utf8');
      fs.appendFileSync(checker, damage);
      const failed = run(r); assert.strictEqual(failed.status, 1, failed.stdout);
      assert(failed.stdout.includes('校验脚本运行失败')); assert(!failed.stdout.includes('[PASS] 无新增行'));
      const badCommit = spawnSync('git', ['commit', '--allow-empty', '-qm', 'broken'], { cwd: r, env, encoding: 'utf8' });
      assert.notStrictEqual(badCommit.status, 0);
      fs.writeFileSync(checker, original);
      const healthy = run(r); assert.strictEqual(healthy.status, 0, healthy.stdout);
      const goodCommit = spawnSync('git', ['commit', '--allow-empty', '-qm', 'healthy'], { cwd: r, env, encoding: 'utf8' });
      if (mode === 'add') { assert.strictEqual(goodCommit.status, 1); assert(goodCommit.stderr.includes('BLOCKED')); }
      else assert.strictEqual(goodCommit.status, 0, goodCommit.stderr);
    });
  }
  if (process.platform !== 'win32') {
    for (const mode of [0o644, 0o654]) {
      check(`non-executable entry ${mode.toString(8)} fails diagnosis and Git skips it`, () => {
        const entry = path.join(hooks, 'pre-commit');
        fs.chmodSync(entry, mode);
        try {
          const r = run(); assert.strictEqual(r.status, 1, r.stdout);
          assert(r.stdout.includes('当前用户没有执行权限'));
          const commit = spawnSync('git', ['commit', '-qm', 'permission test'], { cwd: repo, env, encoding: 'utf8' });
          assert.strictEqual(commit.status, 0, commit.stderr);
          assert(commit.stderr.includes('not set as executable'), commit.stderr);
          git(repo, ['reset', '--soft', 'HEAD^']);
        } finally { fs.chmodSync(entry, 0o755); }
      });
    }
  }
  check('normal bulk rejection is not mistaken for a runtime failure', () => {
    const bulk = path.join(repo, 'bulk.txt'), ignored = path.join(repo, '.git-ai-ignore');
    fs.writeFileSync(bulk, 'bulk\n'.repeat(10001)); git(repo, ['add', 'bulk.txt']);
    fs.writeFileSync(ignored, 'bulk.txt\n'); guard.writeHooks(hooks, 50, repo);
    try {
      const r = run(repo, {}, '50'); assert.strictEqual(r.status, 0, r.stdout);
      assert(r.stdout.includes('BLOCKED: bulk commit'));
      assert(r.stdout.includes('按校验规则拦截提交')); assert(!r.stdout.includes('校验脚本运行失败'));
      const commit = spawnSync('git', ['commit', '-qm', 'bulk'], { cwd: repo, env, encoding: 'utf8' });
      assert.strictEqual(commit.status, 1); assert(commit.stderr.includes('BLOCKED: bulk commit'));
    } finally {
      git(repo, ['rm', '--cached', 'bulk.txt']); fs.unlinkSync(bulk); fs.unlinkSync(ignored);
      guard.writeHooks(hooks, 80, repo);
    }
  });
  const ignore = path.join(repo, '.git-ai-ignore');
  fs.writeFileSync(ignore, 'generated/\n');
  check('gitignore does not reduce the AI denominator', () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'code.txt\n');
    const r = run(); assert.strictEqual(r.status, 0, r.stdout);
    assert(r.stdout.includes('被忽略 0 行 → 分母 10 行'));
    assert(r.stdout.includes('commit AI 6 / 10 lines (raw 10, ignored 0)'));
  });
  check('AI ignore negation is independent of gitignore', () => {
    fs.writeFileSync(ignore, '*\n!code.txt\n');
    const r = run(); assert.strictEqual(r.status, 0, r.stdout); assert(r.stdout.includes('被忽略 0 行 → 分母 10 行'));
  });
  fs.unlinkSync(path.join(repo, '.gitignore'));
  check('info/exclude does not reduce the AI denominator', () => {
    fs.writeFileSync(ignore, 'generated/\n');
    fs.writeFileSync(path.join(repo, '.git', 'info', 'exclude'), 'code.txt\n');
    const r = run(); assert.strictEqual(r.status, 0, r.stdout); assert(r.stdout.includes('被忽略 0 行 → 分母 10 行'));
  });
  check('actual AI ignore matches both diagnostic and hook', () => {
    fs.writeFileSync(ignore, 'code.txt\n');
    const r = run(); assert.strictEqual(r.status, 1, r.stdout);
    assert(r.stdout.includes('10 行全部被忽略')); assert(!r.stdout.includes('[ai-ratio] BLOCKED'));
  });
  check('tabs/newlines/CJK paths are counted and ignored exactly', () => {
    const name = 'special\t中文\nfile.txt';
    fs.writeFileSync(path.join(repo, name), 'one\ntwo\n'); git(repo, ['add', '--', name]);
    fs.writeFileSync(ignore, 'special*\n');
    const r = run(); assert.strictEqual(r.status, 0, r.stdout);
    assert(r.stdout.includes('新增 12 行，其中被忽略 2 行 → 分母 10 行'));
    assert(r.stdout.includes('commit AI 6 / 10 lines (raw 12, ignored 2)'));
    git(repo, ['rm', '--cached', '--', name]); fs.unlinkSync(path.join(repo, name));
  });
  fs.unlinkSync(ignore);
  check('rename uses destination path for AI ignore', () => {
    const renamed = path.join(tmp, 'renamed'); fs.mkdirSync(renamed); git(renamed, ['init', '-q']);
    fs.writeFileSync(path.join(renamed, 'old.txt'), 'line\n'.repeat(20)); git(renamed, ['add', 'old.txt']);
    git(renamed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'base']);
    fs.renameSync(path.join(renamed, 'old.txt'), path.join(renamed, 'new.txt'));
    fs.appendFileSync(path.join(renamed, 'new.txt'), 'extra\n'); git(renamed, ['add', 'old.txt', 'new.txt']);
    fs.writeFileSync(path.join(renamed, '.git-ai-ignore'), 'new.txt\n');
    const r = spawnSync(process.execPath, ['-'], { cwd: renamed, env, input: diffReader, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), '1|1|1');
  });
  check('disabled repo is reported disabled', () => {
    guard.writeHooks(hooks, 80, repo, { enabled: false });
    const r = run(); assert.strictEqual(r.status, 1); assert(r.stdout.includes('有效总开关关闭'));
    assert(r.stdout.includes('[ai-ratio] disabled, skip')); assert(!r.stdout.includes('[PASS] 总开关开启'));
  });
  guard.writeHooks(hooks, 80, repo, { enabled: true, importOn: false });
  fs.writeFileSync(path.join(hooks, '.ai-ratio-off'), '');
  check('v9 ignores stale markers and reads import switch from config', () => {
    const r = run(); assert.strictEqual(r.status, 0, r.stdout); assert(r.stdout.includes('仅大提交校验关闭'));
  });
  check('AI_RATIO_MIN override matches hook and numeric threshold assertion', () => {
    const r = run(repo, { AI_RATIO_MIN: '0.90' }, '90'); assert.strictEqual(r.status, 0, r.stdout);
    assert(r.stdout.includes('有效阈值 = 90%（来源：AI_RATIO_MIN 环境变量）'));
    assert(r.stdout.includes('BLOCKED: ratio < 90% threshold'));
  });
  check('AI_RATIO_OFF override disables an enabled repo', () => {
    const r = run(repo, { AI_RATIO_OFF: '1' }); assert.strictEqual(r.status, 1); assert(r.stdout.includes('有效总开关关闭'));
  });
  check('worktree resolves config from common Git directory with custom hooksPath', () => {
    const wt = path.join(tmp, 'worktree'); git(repo, ['worktree', 'add', '-q', '-b', 'audit', wt]);
    const r = run(wt); assert.strictEqual(r.status, 0, r.stdout); assert(r.stdout.includes('有效阈值 = 80%（来源：仓库配置）'));
  });
  check('missing v9 config is disabled', () => {
    fs.unlinkSync(config); const r = run(repo, {}, '50'); assert.strictEqual(r.status, 1); assert(r.stdout.includes('有效总开关关闭'));
  });
  check('invalid JSON never reports a healthy switch or threshold', () => {
    fs.writeFileSync(config, '{'); const r = run(); assert.strictEqual(r.status, 1);
    assert(r.stdout.includes('无法读取有效配置')); assert(!r.stdout.includes('[PASS] 有效阈值'));
  });
  check('legacy reader uses baked threshold and markers, ignoring v9 config', () => {
    const file = path.join(hooks, 'check-ai-ratio.js');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^\/\/ guard-v\d+:/m, '// guard-v8:'));
    const r = spawnSync(process.execPath, ['-', file], { cwd: repo, env, input: reader, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr); assert.strictEqual(r.stdout.trim(), 'off|on|50|钩子默认值|on|on|on');
  });
  console.log(`${passed} passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
