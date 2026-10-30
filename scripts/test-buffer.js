'use strict';
// Exercise the real query subprocess with an isolated, simulated runtime.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const { uncommitted } = require(path.join(target, 'lib.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-buffer-test-'));
(async () => {
  try {
    Object.assign(process.env, { HOME: path.join(tmp, 'home'), GIT_CONFIG_GLOBAL: path.join(tmp, 'no-global'), GIT_CONFIG_NOSYSTEM: '1' });
    delete process.env.GIT_AI_DAEMON_HOME;
    delete process.env.GIT_AI_DAEMON_CONTROL_SOCKET;
    const base = path.join(process.env.HOME, '.trae-cn/.git-ai-tob');
    const daemon = path.join(base, 'test/internal/daemon');
    const bin = path.join(base, 'tob-git-ai-runtime/1.0.0/x/host/git-ai');
    const callsFile = path.join(tmp, 'status-calls');
    fs.mkdirSync(daemon, { recursive: true });
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(path.join(daemon, 'daemon.pid.json'), JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.env._GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN !== 'true') process.exit(9);
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(callsFile)}, 'status\\n');
function respond() {
  if (process.env.FAKE_FAILURE) process.exit(1);
  console.log(JSON.stringify({ stats: { git_diff_added_lines: 10, human_additions: 0, unknown_additions: 0 }, files: [{ path: 'code.txt', detail: 'x'.repeat(Number(process.env.FAKE_PADDING)) }] }));
}
if (process.env.FAKE_GATE) {
  const timeout = setTimeout(() => process.exit(8), 5000);
  const timer = setInterval(() => {
    if (!fs.existsSync(process.env.FAKE_GATE)) return;
    clearTimeout(timeout); clearInterval(timer); respond();
  }, 5);
} else respond();
`, { mode: 0o755 });
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'base']);
    fs.writeFileSync(path.join(repo, 'code.txt'), 'line\n'.repeat(10));
    execFileSync('git', ['-C', repo, 'add', 'code.txt']);
    for (const bytes of [0, 1357875, 11 * 1024 * 1024]) {
      process.env.FAKE_PADDING = String(bytes);
      const stats = await uncommitted(repo);
      assert.deepStrictEqual(stats, bytes > 10 * 1024 * 1024 ? null : { total: 10, ai: 10, gitAdds: 10, gitDels: 0 });
      console.log(`ok response with ${bytes} bytes of detail`);
    }
    process.env.FAKE_PADDING = '0';
    const second = path.join(tmp, 'second');
    execFileSync('git', ['clone', '-q', repo, second]);
    fs.writeFileSync(path.join(second, 'code.txt'), 'line\n'.repeat(10));
    execFileSync('git', ['-C', second, 'add', 'code.txt']);
    const callCount = () => fs.readFileSync(callsFile, 'utf8').trim().split('\n').length;
    const before = callCount();
    process.env.FAKE_GATE = path.join(tmp, 'release-status');
    const queries = [uncommitted(repo), uncommitted(repo), uncommitted(second)];
    const deadline = Date.now() + 5000;
    while (callCount() < before + 2) {
      assert(Date.now() < deadline, 'query subprocesses did not start');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    fs.writeFileSync(process.env.FAKE_GATE, 'release');
    const values = await Promise.all(queries);
    assert.strictEqual(callCount() - before, 2);
    assert(values.every(v => v && v.total === 10 && v.ai === 10));
    console.log('ok simultaneous callers share one subprocess per workspace');
    delete process.env.FAKE_GATE;
    const fresh = await uncommitted(repo);
    assert.strictEqual(fresh.total, 10);
    assert.strictEqual(callCount() - before, 3);
    console.log('ok completed results are released before the next query');
    process.env.FAKE_FAILURE = '1';
    const failed = await Promise.all([uncommitted(repo), uncommitted(repo)]);
    assert(failed.every(v => v === null));
    assert.strictEqual(callCount() - before, 4);
    delete process.env.FAKE_FAILURE;
    assert.strictEqual((await uncommitted(repo)).total, 10);
    assert.strictEqual(callCount() - before, 5);
    console.log('ok failed shared queries are released and can be retried');
    console.log('6 passed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
