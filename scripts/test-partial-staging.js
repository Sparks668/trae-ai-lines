'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const target = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const guard = require(path.join(target, 'guard.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-partial-staging-'));
const home = path.join(tmp, 'home');
const runtime = path.join(home, '.trae-cn', '.git-ai-tob');
const bin = path.join(runtime, 'tob-git-ai-runtime', '1.0.0', 'test', 'host', 'git-ai');
const daemon = path.join(runtime, 'fixture', 'internal', 'daemon');
const env = {
  ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AI_CWD: '', GIT_AI_DAEMON_HOME: '', GIT_AI_DAEMON_CONTROL_SOCKET: '',
  AI_RATIO_MIN: '', AI_RATIO_OFF: '', TEST_AI: '0', TEST_STAGED_LINES: ''
};

function run(cwd, command, args, extra = {}) {
  return spawnSync(command, args, { cwd, env: { ...env, ...extra }, encoding: 'utf8' });
}

function git(cwd, ...args) {
  const result = run(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function put(cwd, name, content = 'one line\n') {
  fs.writeFileSync(path.join(cwd, name), content);
}

function setup(name, tracked = []) {
  const cwd = path.join(tmp, name);
  fs.mkdirSync(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Fixture');
  git(cwd, 'config', 'user.email', 'fixture@example.invalid');
  for (const file of tracked) {
    put(cwd, file, 'before\n');
    git(cwd, 'add', file);
  }
  git(cwd, 'commit', '-qm', 'base', '--allow-empty');
  guard.writeHooks(path.join(cwd, '.git', 'hooks'), 90, cwd);
  return cwd;
}

function commit(cwd, ai, flags = [], extra = {}) {
  return run(cwd, 'git', ['-c', 'user.useConfigOnly=true', 'commit', '-qm', 'fixture', ...flags],
    { ...extra, TEST_AI: String(ai) });
}

function expect(result, code, output) {
  const log = result.stdout + result.stderr;
  assert.equal(result.status, code, log);
  assert.match(log, output);
}

try {
  fs.mkdirSync(daemon, { recursive: true });
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  put(daemon, 'daemon.pid.json', JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(bin, `#!/bin/sh
printf '{"stats":{"git_diff_added_lines":%s,"human_additions":0,"unknown_additions":0}}\\n' "$TEST_AI"
`, { mode: 0o755 });

  // Use a one-line staged file. These cases override only the hook's staged count.
  const fixture = path.join(tmp, 'numstat.cjs');
  put(tmp, 'numstat.cjs', `
const cp = require('node:child_process');
const execFile = cp.execFile;
cp.execFile = (file, args, options, callback) => {
  if (file === 'git' && args.includes('--cached') && args.includes('--numstat') && process.env.TEST_STAGED_LINES) {
    process.nextTick(callback, null, process.env.TEST_STAGED_LINES + '\\t0\\tstaged.txt\\0');
    return;
  }
  return execFile(file, args, options, callback);
};
`);
  const mockCount = count => ({
    NODE_OPTIONS: '--require ' + JSON.stringify(fixture), TEST_STAGED_LINES: String(count)
  });

  for (const [staged, ai, code, reason] of [
    [41, 36, 1, /BLOCKED: ratio < 90%/],
    [41, 42, 1, /BLOCKED: ratio > 100%/],
    [10000, 10001, 1, /BLOCKED: ratio > 100%/],
    [10, 9, 0, /ratio 90\.0%/],
    [41, 41, 0, /commit AI 41 \/ 41 lines.*ratio 100\.0%/]
  ]) {
    const cwd = setup(`ratio-${staged}-${ai}`);
    put(cwd, 'staged.txt');
    put(cwd, 'draft.txt');
    git(cwd, 'add', 'staged.txt');
    const head = git(cwd, 'rev-parse', 'HEAD');
    expect(commit(cwd, ai, [], mockCount(staged)), code, reason);
    assert.equal(git(cwd, 'rev-parse', 'HEAD') === head, code !== 0);
    assert.equal(git(cwd, 'ls-files', '--others', '--exclude-standard'), 'draft.txt');
    if (!code) assert.equal(git(cwd, 'show', '--format=', '--name-only'), 'staged.txt');
    console.log(`ok ${ai}/${staged} with a separate untracked file`);
  }

  {
    const cwd = setup('above-100-diagnose');
    put(cwd, 'staged.txt');
    put(cwd, 'draft.txt');
    git(cwd, 'add', 'staged.txt');
    const head = git(cwd, 'rev-parse', 'HEAD');
    expect(commit(cwd, 2), 1, /存在部分暂存提交，无法精确计算本次提交的贡献率，检查无误后可关闭校验点后进行提交。/);
    assert.equal(git(cwd, 'rev-parse', 'HEAD'), head);
    expect(run(cwd, 'bash', [path.join(target, 'scripts', 'diagnose-ai-guard.sh'), '90'], { TEST_AI: '2' }),
      0, /按校验规则拦截提交/);
    console.log('ok diagnostic identifies the new upper-bound rejection');
  }

  {
    const cwd = setup('all-staged');
    put(cwd, 'staged.txt');
    git(cwd, 'add', 'staged.txt');
    expect(commit(cwd, 1), 0, /ratio 100\.0%/);
    console.log('ok all staged files still use the original threshold');
  }

  {
    const cwd = setup('auto-stage', ['tracked.txt']);
    put(cwd, 'tracked.txt');
    assert.equal(git(cwd, 'diff', '--cached', '--name-only'), '');
    expect(commit(cwd, 1, ['-a']), 0, /ratio 100\.0%/);
    assert.equal(git(cwd, 'show', '--format=', '--name-only'), 'tracked.txt');
    console.log('ok commit -a still stages and validates tracked changes');
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
