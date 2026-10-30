'use strict';
// Details queries must preserve Git path semantics without synchronous Git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const vm = require('vm');
const cp = require('child_process');
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-details-query-')));
const guard = require(path.join(target, 'guard.js'));
const { createDetailsPanel } = require(path.join(target, 'panel.js'));
const flush = () => new Promise(setImmediate);
let passed = 0, calls = 0;
function check(name, fn) { fn(); passed++; console.log(`ok ${name}`); }
function git(cwd, args) { return cp.execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function repo(name) {
  const cwd = path.join(tmp, name); fs.mkdirSync(cwd); git(cwd, ['init', '-q']);
  git(cwd, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
    'commit', '--allow-empty', '-qm', 'base']);
  fs.mkdirSync(path.join(cwd, 'sub'));
  return cwd;
}
const folders = (...paths) => ({ workspace: { workspaceFolders: paths.map(fsPath => ({ uri: { fsPath } })) } });
(async () => {
  try {
    process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'no-global');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    const context = { module: { exports: {} }, __dirname: target, process, console,
      require: name => name === 'child_process' ? {
        execFile(...args) { calls++; return cp.execFile(...args); },
        execFileSync() { throw new Error('details used synchronous Git'); }
      } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(target, 'guard.js'), 'utf8'), context);
    const getStates = context.module.exports.getGuardStates;
    async function expect(name, folder, root, hooks) {
      const before = calls;
      const pending = getStates(folders(folder));
      check(`${name}: returns an asynchronous query`, () => assert(pending && typeof pending.then === 'function'));
      const states = JSON.parse(JSON.stringify(await pending));
      check(`${name}: one Git call with unchanged state and paths`, () => {
        assert.strictEqual(calls - before, 1);
        assert.deepStrictEqual(states, [{ cwd: root, hooks, ...guard.readState(hooks, root) }]);
      });
    }
    const a = repo('normal repo'); let hooks = path.join(a, '.git/hooks');
    guard.writeHooks(hooks, 85, a, { enabled: true, importOn: false });
    await expect('default hooks', a, a, hooks);
    await expect('subfolder workspace', path.join(a, 'sub'), a, hooks);
    git(a, ['config', 'core.hooksPath', 'relative hooks']); hooks = path.join(a, 'relative hooks');
    guard.writeHooks(hooks, 90, a, { enabled: false });
    await expect('relative hooks from subfolder', path.join(a, 'sub'), a, hooks);
    const shared = path.join(tmp, 'shared hooks');
    git(a, ['config', 'core.hooksPath', shared]); guard.writeHooks(shared, 95, a);
    await expect('absolute hooks', path.join(a, 'sub'), a, shared);
    const worktree = path.join(tmp, 'linked worktree');
    git(a, ['worktree', 'add', '-qb', 'details-test', worktree]);
    fs.mkdirSync(path.join(worktree, 'sub'));
    await expect('linked worktree and common settings', path.join(worktree, 'sub'), worktree, shared);
    const duplicates = await getStates(folders(a, path.join(a, 'sub'), a));
    check('multiple workspace folders in one repository produce one guard card', () => {
      assert.strictEqual(duplicates.length, 1); assert.strictEqual(duplicates[0].cwd, a);
    });
    const worktrees = await getStates(folders(a, path.join(a, 'sub'), worktree));
    check('distinct worktrees remain separate even with shared hooks and settings', () => {
      assert.strictEqual(worktrees.length, 2);
      assert.strictEqual(worktrees[0].cwd, a); assert.strictEqual(worktrees[1].cwd, worktree);
    });
    const sameHost = folders(a), beforeShared = calls;
    await Promise.all([getStates(sameHost), getStates(sameHost)]);
    check('simultaneous guard readers share one Git query', () => {
      assert.strictEqual(calls - beforeShared, 1);
    });
    await getStates(sameHost);
    check('a completed guard query is not cached for later refreshes', () => {
      assert.strictEqual(calls - beforeShared, 2);
    });
    const b = repo('second'); git(b, ['config', 'core.hooksPath', shared]);
    guard.writeHooks(shared, 75, b, { enabled: true, importOn: true });
    const nonRepo = path.join(tmp, 'not a repo'); fs.mkdirSync(nonRepo);
    const settings = path.join(a, '.git/ai-ratio-guard.json'); fs.writeFileSync(settings, '{');
    const states = await getStates(folders(a, b, nonRepo));
    check('one bad config and a non-repository do not hide another repository', () => {
      assert.strictEqual(states.length, 2); assert(states[0].error.includes('ai-ratio-guard.json'));
      assert.strictEqual(states[1].threshold, 75); assert.strictEqual(states[1].enabled, true);
    });

    // A slow second repository must not let an old snapshot undo a command's UI.
    const raceRepo = repo('guard race'), slowRepo = repo('slow repo');
    const raceHooks = path.join(raceRepo, '.git/hooks');
    guard.writeHooks(raceHooks, 90, raceRepo, { enabled: true, importOn: true });
    const queued = [], commands = {}, items = [];
    let input = async () => '75';
    const guardHost = { ...folders(raceRepo, slowRepo), StatusBarAlignment: { Right: 2 },
      MarkdownString: class { constructor(value) { this.value = value; } },
      commands: { registerCommand(id, fn) { commands[id] = fn; return { dispose() {} }; } },
      window: {
        createStatusBarItem() { const item = { show() {}, hide() {}, dispose() {} }; items.push(item); return item; },
        showInputBox: () => input(), showInformationMessage() {},
        showWarningMessage(m) { throw new Error(m); }, showErrorMessage(m) { throw new Error(m); }
      } };
    const raceContext = { module: { exports: {} }, __dirname: target, process, console,
      require: name => name === 'vscode' ? guardHost : name === 'child_process' ? {
        execFileSync: cp.execFileSync,
        execFile(cmd, args, options, callback) {
          const out = cp.execFileSync(cmd, args, options);
          queued.push(() => callback(null, out));
        }
      } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(target, 'guard.js'), 'utf8'), raceContext);
    const refreshGuard = raceContext.module.exports.activateGuard({ subscriptions: [] });
    async function startSlowRefresh() {
      const done = refreshGuard(); queued.shift()(); await flush();
      return { finish: async () => { queued.shift()(); await done; } };
    }
    for (const [command, expected] of [
      ['guardToggle', 'AI-GIT校验:关'],
      ['guardSetThreshold', '$(shield) AI≥75%'],
      ['guardToggleImport', '$(shield) AI≥90%·大关']
    ]) {
      guard.writeHooks(raceHooks, 90, raceRepo, { enabled: true, importOn: true });
      const pending = await startSlowRefresh();
      await commands['aiLines.' + command](raceRepo);
      assert.strictEqual(items[0].text, expected);
      const config = fs.readFileSync(path.join(raceRepo, '.git/ai-ratio-guard.json'));
      await pending.finish();
      check(`${command}: an older refresh cannot overwrite the command result`, () => {
        assert.strictEqual(items[0].text, expected);
        assert(fs.readFileSync(path.join(raceRepo, '.git/ai-ratio-guard.json')).equals(config));
      });
    }
    guard.writeHooks(raceHooks, 90, raceRepo, { enabled: true, importOn: true });
    let submitInput;
    input = () => new Promise(resolve => { submitInput = resolve; });
    const changing = commands['aiLines.guardSetThreshold'](raceRepo);
    const duringInput = await startSlowRefresh();
    submitInput('80'); await changing; await duringInput.finish();
    check('a refresh started during threshold input cannot undo the saved threshold', () => {
      assert.strictEqual(items[0].text, '$(shield) AI≥80%');
    });
    guard.writeHooks(raceHooks, 95, raceRepo, { enabled: true, importOn: false });
    const subsequent = await startSlowRefresh(); await subsequent.finish();
    check('a fresh query still applies external settings after command invalidation', () => {
      assert.strictEqual(items[0].text, '$(shield) AI≥95%·大关');
    });

    // Manually controlled promises model slow Git without timing-dependent sleeps.
    const requests = [], panels = [];
    let committed = 1;
    const vscode = { workspace: { workspaceFolders: [] }, ViewColumn: { Active: -1 }, window: {
      showErrorMessage() {},
      createWebviewPanel() {
        let receive, close;
        const p = { messages: [], reveal() {}, receive: m => receive(m), dispose: () => close(),
          webview: { html: '', postMessage(m) { p.messages.push(m); return Promise.resolve(true); },
            onDidReceiveMessage(fn) { receive = fn; return { dispose() {} }; } },
          onDidDispose(fn) { close = fn; return { dispose() {} }; } };
        panels.push(p); return p;
      }
    } };
    const details = createDetailsPanel(vscode, { version: 'test',
      getSnapshot: () => ({ committed: { ai: committed }, workspace: null }),
      getGuardStates: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
      refresh: async () => {}, diagnose: async () => {} });
    const latest = p => p.messages.filter(m => m.type === 'data').at(-1).data;
    details.open(); const first = panels[0];
    const ready = first.receive({ type: 'ready' });
    const repeatedReady = first.receive({ type: 'ready' }); await flush();
    check('first open and ready share one in-flight query', () => {
      assert.strictEqual(requests.length, 1); assert.strictEqual(latest(first).guardsLoading, true);
      assert.strictEqual(latest(first).committed.ai, 1);
    });
    requests[0].resolve([{ threshold: 85 }]); await Promise.all([ready, repeatedReady]);
    await first.receive({ type: 'ready' });
    check('ready after initial data reuses the completed result', () => {
      assert.strictEqual(requests.length, 1); assert.strictEqual(latest(first).guards[0].threshold, 85);
    });
    const slow = details.update(); await flush(); committed = 9;
    details.update(); details.update();
    check('slow guard queries do not delay statistics or start parallel duplicate queries', () => {
      assert.strictEqual(requests.length, 2); assert.strictEqual(latest(first).committed.ai, 9);
    });
    requests[1].resolve([{ threshold: 85 }]); await flush();
    check('intervening refreshes coalesce into one follow-up query', () => assert.strictEqual(requests.length, 3));
    requests[2].resolve([{ threshold: 90 }]); await slow;
    check('follow-up query delivers the latest settings', () => assert.strictEqual(latest(first).guards[0].threshold, 90));
    const oldRead = details.update(); await flush(); first.dispose(); details.open();
    const second = panels[1], newReady = second.receive({ type: 'ready' }); await flush();
    requests[4].resolve([{ threshold: 95 }]); await newReady;
    requests[3].resolve([{ threshold: 50 }]); await oldRead;
    check('a closed panel query cannot overwrite a reopened panel', () => assert.strictEqual(latest(second).guards[0].threshold, 95));
    const failed = details.update(); await flush(); requests[5].reject(new Error('test read failure')); await failed;
    check('query errors leave statistics available and finish loading', () => {
      assert.strictEqual(latest(second).committed.ai, 9); assert.strictEqual(latest(second).guardsLoading, false);
      assert(latest(second).guards[0].error.includes('test read failure'));
    });
    details.dispose(); await details.update();
    check('closed details start no further queries', () => assert.strictEqual(requests.length, 6));

    // Exercise the actual shared reader when only the second workspace changes.
    const replacementRepo = repo('replacement workspace');
    guard.writeHooks(path.join(replacementRepo, '.git/hooks'), 75, replacementRepo);
    const liveGetStates = raceContext.module.exports.getGuardStates;
    const liveDetails = createDetailsPanel(vscode, { version: 'test',
      getSnapshot: () => ({ workspace: raceRepo }), getGuardStates: liveGetStates,
      refresh: async () => {}, diagnose: async () => {} });
    vscode.workspace.workspaceFolders = folders(raceRepo, slowRepo).workspace.workspaceFolders;
    liveDetails.open();
    const previousReady = panels.at(-1).receive({ type: 'ready' }); await flush();
    const previousCallbacks = queued.splice(0);
    assert.strictEqual(previousCallbacks.length, 2);
    liveDetails.dispose();
    vscode.workspace.workspaceFolders = folders(raceRepo, replacementRepo).workspace.workspaceFolders;
    liveDetails.open(); const currentPanel = panels.at(-1);
    const currentReady = currentPanel.receive({ type: 'ready' }); await flush();
    check('changed workspace list starts a fresh query when details reopen', () => {
      assert.strictEqual(queued.length, 2);
    });
    const currentCallbacks = queued.splice(0), currentQuery = liveGetStates(vscode);
    previousCallbacks.forEach(done => done()); await previousReady;
    check('finishing an old workspace query preserves the newer shared query', () => {
      assert.strictEqual(liveGetStates(vscode), currentQuery);
      assert.strictEqual(queued.length, 0);
    });
    currentCallbacks.forEach(done => done()); await Promise.all([currentReady, currentQuery]);
    check('reopened details show the replacement workspace instead of the removed one', () => {
      assert.deepStrictEqual(Array.from(latest(currentPanel).guards, g => g.cwd), [raceRepo, replacementRepo]);
    });
    liveDetails.dispose();
    console.log(`${passed} passed`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
