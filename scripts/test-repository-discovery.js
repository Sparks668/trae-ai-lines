'use strict';
// Real temporary repositories, with only the editor API and Git failures mocked.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const vm = require('vm');
const assert = require('assert');
const root = path.resolve(__dirname, '..');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-repositories-')));
const source = fs.readFileSync(path.join(root, 'guard.js'), 'utf8');
const flush = () => new Promise(setImmediate);
const until = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'repository refresh did not finish');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok ' + name); }
function repo(name) {
  const cwd = path.join(tmp, name); fs.mkdirSync(cwd, { recursive: true });
  cp.execFileSync('git', ['init', '-q', cwd]); return cwd;
}
function host(folders, repositories = []) {
  const events = { open: new Set(), close: new Set() };
  const subscribe = set => fn => { set.add(fn); return { dispose: () => set.delete(fn) }; };
  const api = { repositories: repositories.map(fsPath => ({ rootUri: { scheme: 'file', fsPath } })),
    onDidOpenRepository: subscribe(events.open), onDidCloseRepository: subscribe(events.close) };
  const extension = { isActive: true, exports: { getAPI: () => api }, activate: async () => extension.exports };
  const messages = [], commands = {}, items = [];
  return { api, extension, events, messages, items,
    workspace: { workspaceFolders: folders.map(fsPath => ({ uri: { scheme: 'file', fsPath } })) },
    extensions: { getExtension: id => id === 'vscode.git' ? extension : undefined },
    StatusBarAlignment: { Right: 2 }, MarkdownString: class { constructor(value) { this.value = value; } },
    commands: { registerCommand(id, fn) { commands[id] = fn; return { dispose() {} }; } },
    window: {
      showWarningMessage: m => messages.push(['warning', m]),
      showInformationMessage: m => messages.push(['info', m]),
      showErrorMessage: m => messages.push(['error', m]), showInputBox: async () => '80',
      createStatusBarItem() { const item = { show() {}, hide() {}, dispose() {} }; items.push(item); return item; }
    }, commandHandlers: commands
  };
}
function load(vscode, fail = () => false, calls = {}) {
  const context = { module: { exports: {} }, __dirname: root, process, console,
    require: name => name === 'vscode' ? vscode : name === 'child_process' ? {
      execFileSync(cmd, args, options) {
        calls.sync?.push(args);
        if (fail(args[1])) { const e = new Error('test Git query timed out'); e.code = 'ETIMEDOUT'; throw e; }
        return cp.execFileSync(cmd, args, options);
      },
      execFile(cmd, args, options, callback) {
        calls.async?.push(args);
        const run = () => {
          if (fail(args[1])) { const e = new Error('test Git query timed out'); e.code = 'ETIMEDOUT'; callback(e, '', ''); return; }
          return cp.execFile(cmd, args, options, callback);
        };
        if (calls.pending) calls.pending.push(run);
        else return run();
      }
    } : require(name) };
  vm.runInNewContext(source, context); return context.module.exports;
}
const paths = states => Array.from(states, s => s.cwd);
const item = { show() {}, hide() {} };
(async () => {
  process.env.GIT_CONFIG_GLOBAL = path.join(tmp, 'no-global'); process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    const a = repo('parent/a'), b = repo('parent/b'), parent = path.dirname(a);
    const vscode = host([parent], [a, b]), guard = load(vscode);
    const states = await guard.getGuardStates(vscode);
    check('a parent workspace includes repositories discovered by the built-in Git extension', () => {
      assert.deepStrictEqual(paths(states), [a, b]);
    });
    const results = guard.enableAll(vscode, item);
    check('bulk enable installs both child repositories from a parent workspace', () => {
      assert.deepStrictEqual(paths(results), [a, b]); assert(results.every(r => r.status === 'enabled'));
    });
    guard.toggle(vscode, item, b);
    check('single-repository actions accept the same discovered child repositories', () => {
      assert.strictEqual(guard.readState(path.join(b, '.git/hooks'), b).enabled, false);
      assert.strictEqual(guard.readState(path.join(a, '.git/hooks'), a).enabled, true);
    });
    fs.mkdirSync(path.join(a, 'module'));
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: path.join(a, 'module') } });
    check('workspace modules and Git API roots do not duplicate a repository', () => {
      assert.strictEqual(guard.enableAll(vscode, item).length, 2);
    });
    const outer = repo('outer'), inner = repo('outer/inner');
    const nested = host([outer], [outer, inner]);
    check('nested independent repositories remain in the shared repository list', () => {
      assert.deepStrictEqual(paths(guard.enableAll(nested, item)), [outer, inner]);
    });
    const fallback = host([a, b]); delete fallback.extensions;
    check('editors without the built-in Git API retain workspace-based discovery', () => {
      assert.strictEqual(guard.enableAll(fallback, item).length, 2);
    });
    const broken = load(vscode, folder => folder === b);
    const partial = await broken.getGuardStates(vscode);
    check('a failed Git query remains visible alongside healthy repositories', () => {
      const failure = partial.find(s => s.cwd === b);
      assert(failure && failure.error.includes('timed out'));
      assert(partial.some(s => s.cwd === a && !s.error));
    });
    const config = path.join(b, '.git/ai-ratio-guard.json'), before = fs.readFileSync(config);
    vscode.messages.length = 0;
    const partialBulk = broken.enableAll(vscode, item);
    check('bulk results count discovery failures instead of claiming full success', () => {
      assert.strictEqual(partialBulk.length, 2);
      assert.strictEqual(partialBulk.find(s => s.cwd === b).status, 'failed');
      assert(vscode.messages.some(([type, m]) => type === 'warning' && m.includes('1/2')));
      assert(fs.readFileSync(config).equals(before));
    });
    const failedHost = host([b]); delete failedHost.extensions;
    const failed = await broken.getGuardStates(failedHost);
    check('all Git queries failing returns an error instead of an empty repository list', () => {
      assert.strictEqual(failed.length, 1); assert(failed[0].error.includes('timed out'));
    });
    const notRepo = path.join(tmp, 'empty'); fs.mkdirSync(notRepo);
    const emptyHost = host([notRepo]); delete emptyHost.extensions;
    check('an actual non-repository is still omitted', () => {
      assert.strictEqual(guard.enableAll(emptyHost, item).length, 0);
    });
    const deleted = host([parent], [notRepo, b]);
    const deletedStates = await guard.getGuardStates(deleted);
    check('a known Git root becoming unavailable is reported instead of silently omitted', () => {
      assert.strictEqual(deletedStates.length, 2);
      assert(deletedStates.find(s => s.cwd === notRepo).error.includes('not a git repository'));
    });
    const late = host([parent], [a, b]); late.extension.isActive = false;
    let release, activations = 0;
    late.extension.activate = () => { activations++; return new Promise(resolve => { release = () => { late.extension.isActive = true; resolve(late.extension.exports); }; }); };
    const first = guard.getGuardStates(late), second = guard.getGuardStates(late);
    await flush();
    check('concurrent readers share one pending built-in Git activation', () => {
      assert.strictEqual(activations, 1); assert.strictEqual(first, second);
    });
    release();
    const lateStates = await first;
    check('the first query waits for Git discovery instead of reporting no repositories', () => {
      assert.deepStrictEqual(paths(lateStates), [a, b]);
    });
    const live = host([parent], [a]); const liveGuard = load(live);
    const subscriptions = []; let updates = 0;
    liveGuard.activateGuard({ subscriptions }, async () => { updates++; await liveGuard.getGuardStates(live); });
    await flush(); await flush();
    check('one subscription tracks repository opens and closes', () => {
      assert.strictEqual(live.events.open.size, 1); assert.strictEqual(live.events.close.size, 1);
    });
    live.api.repositories.push({ rootUri: { scheme: 'file', fsPath: b } });
    for (const fn of live.events.open) await fn();
    check('newly discovered repositories update the details without restarting', () => {
      assert(updates > 0);
    });
    assert.deepStrictEqual(paths(await liveGuard.getGuardStates(live)), [a, b]);
    const beforeClose = updates;
    live.api.repositories.pop();
    for (const fn of live.events.close) await fn();
    const afterClose = await liveGuard.getGuardStates(live);
    check('closing a discovered repository removes it from details and action targets', () => {
      assert(updates > beforeClose); assert.deepStrictEqual(paths(afterClose), [a]);
      live.messages.length = 0; liveGuard.toggle(live, item, b);
      assert(live.messages.some(([type]) => type === 'warning'));
    });
    const oldQuery = liveGuard.getGuardStates(live);
    live.api.repositories.push({ rootUri: { scheme: 'file', fsPath: b } });
    const newQuery = liveGuard.getGuardStates(live);
    const [oldStates, newStates] = await Promise.all([oldQuery, newQuery]);
    check('a changed Git repository list starts a new query while the old one is pending', () => {
      assert.notStrictEqual(oldQuery, newQuery);
      assert.deepStrictEqual(paths(oldStates), [a]); assert.deepStrictEqual(paths(newStates), [a, b]);
    });
    subscriptions.forEach(s => s.dispose());
    check('deactivation disposes the Git repository event subscriptions', () => {
      assert.strictEqual(live.events.open.size, 0); assert.strictEqual(live.events.close.size, 0);
    });
    const starting = host([parent], [a, b]); starting.extension.isActive = false;
    let finishStart, starts = 0;
    starting.extension.activate = () => { starts++; return new Promise(resolve => {
      finishStart = () => { starting.extension.isActive = true; resolve(starting.extension.exports); };
    }); };
    const startingGuard = load(starting), startingSubscriptions = [];
    startingGuard.activateGuard({ subscriptions: startingSubscriptions });
    const enabling = starting.commandHandlers['aiLines.guardEnableAll']();
    await flush(); assert.strictEqual(starts, 1); finishStart();
    const startedResults = await enabling;
    check('an early bulk command waits for the same Git activation as startup', () => {
      assert.strictEqual(starts, 1); assert.deepStrictEqual(paths(startedResults), [a, b]);
      assert.strictEqual(starting.events.open.size, 1); assert.strictEqual(starting.events.close.size, 1);
    });
    startingSubscriptions.forEach(s => s.dispose());
    const stoppedRepo = repo('stopped/child');
    const stopped = host([path.dirname(stoppedRepo)], [stoppedRepo]); stopped.extension.isActive = false;
    let finishStopped;
    stopped.extension.activate = () => new Promise(resolve => {
      finishStopped = () => { stopped.extension.isActive = true; resolve(stopped.extension.exports); };
    });
    const stoppedGuard = load(stopped), stoppedSubscriptions = [];
    stoppedGuard.activateGuard({ subscriptions: stoppedSubscriptions });
    const stoppedCommand = stopped.commandHandlers['aiLines.guardEnableAll']();
    await flush(); stoppedSubscriptions.forEach(s => s.dispose()); finishStopped();
    await stoppedCommand; await flush();
    check('disposal during Git activation cancels pending writes and event subscriptions', () => {
      assert(!fs.existsSync(path.join(stoppedRepo, '.git/hooks/pre-commit')));
      assert.strictEqual(stopped.events.open.size, 0); assert.strictEqual(stopped.events.close.size, 0);
    });
    const single = host([parent], [a, b]), singleCalls = { sync: [] };
    let slow = false;
    const singleGuard = load(single, folder => slow && folder === b, singleCalls);
    const singleSubscriptions = [];
    singleGuard.activateGuard({ subscriptions: singleSubscriptions });
    slow = true; singleCalls.sync.length = 0;
    singleGuard.toggle(single, single.items[0], a);
    single.window.showInputBox = async () => '90';
    await singleGuard.setThreshold(single, single.items[0], a);
    singleGuard.toggleImport(single, single.items[0], a);
    check('single-repository actions and status updates never synchronously query unrelated repositories', () => {
      assert.strictEqual(singleCalls.sync.filter(args => args[1] === b).length, 0);
      assert.strictEqual(singleGuard.readState(path.join(a, '.git/hooks'), a).threshold, 90);
    });
    singleSubscriptions.forEach(s => s.dispose());
    const otherFirst = host([parent], [b, a]), otherCalls = { sync: [] };
    slow = false;
    const otherGuard = load(otherFirst, folder => slow && folder === b, otherCalls), otherSubscriptions = [];
    otherGuard.activateGuard({ subscriptions: otherSubscriptions });
    const firstStatus = otherFirst.items[0].text;
    slow = true; otherCalls.sync.length = 0;
    otherGuard.toggle(otherFirst, otherFirst.items[0], a);
    check('changing a secondary repository preserves the first repository status without querying it', () => {
      assert.strictEqual(otherCalls.sync.filter(args => args[1] === b).length, 0);
      assert.strictEqual(otherFirst.items[0].text, firstStatus);
    });
    otherSubscriptions.forEach(s => s.dispose());
    const moduleHost = host([path.join(a, 'module')]); delete moduleHost.extensions;
    const moduleGuard = load(moduleHost);
    const moduleBefore = moduleGuard.readState(path.join(a, '.git/hooks'), a).enabled;
    moduleGuard.toggle(moduleHost, item, a);
    check('a workspace opened below the repository root still authorizes that root', () => {
      assert.strictEqual(moduleGuard.readState(path.join(a, '.git/hooks'), a).enabled, !moduleBefore);
    });
    const alias = path.join(tmp, 'module-alias'); fs.symlinkSync(path.join(a, 'module'), alias, 'dir');
    const aliasHost = host([alias]); delete aliasHost.extensions;
    const aliasBefore = moduleGuard.readState(path.join(a, '.git/hooks'), a).enabled;
    moduleGuard.toggle(aliasHost, item, a);
    check('a symlinked workspace module retains access to its real repository root', () => {
      assert.strictEqual(moduleGuard.readState(path.join(a, '.git/hooks'), a).enabled, !aliasBefore);
    });
    const forbiddenBefore = fs.readFileSync(path.join(b, '.git/ai-ratio-guard.json'));
    moduleGuard.toggle(moduleHost, item, b);
    moduleGuard.toggle(moduleHost, item, parent);
    check('target filtering still refuses outside repositories and ancestors that are not the Git root', () => {
      assert(fs.readFileSync(path.join(b, '.git/ai-ratio-guard.json')).equals(forbiddenBefore));
      assert(!fs.existsSync(path.join(parent, '.git')));
    });
    const switching = host([a]); delete switching.extensions;
    let submitThreshold;
    switching.window.showInputBox = () => new Promise(resolve => { submitThreshold = resolve; });
    const switchingGuard = load(switching), switchingItem = { show() {}, hide() {} };
    switchingGuard.writeHooks(path.join(b, '.git/hooks'), 75, b, { enabled: true, importOn: true });
    const editingGlobal = switchingGuard.setThreshold(switching, switchingItem);
    switching.workspace.workspaceFolders = [{ uri: { fsPath: b } }];
    submitThreshold('85'); await editingGlobal;
    check('a global threshold input spanning a workspace switch keeps the status on the current workspace', () => {
      assert.strictEqual(switchingItem.text, '$(shield) AI≥75%');
    });
    const burstParent = path.join(tmp, 'burst'); fs.mkdirSync(burstParent);
    const burst = host([burstParent]), burstCalls = { async: [], pending: [] };
    const burstGuard = load(burst, () => false, burstCalls), burstSubscriptions = [];
    let latest = [];
    burstGuard.activateGuard({ subscriptions: burstSubscriptions }, async () => { latest = await burstGuard.getGuardStates(burst); });
    const eventResults = [];
    const addRepository = i => {
      const cwd = repo('burst/repo-' + i);
      burst.api.repositories.push({ rootUri: { scheme: 'file', fsPath: cwd } });
      for (const fn of burst.events.open) eventResults.push(fn());
    };
    for (let i = 0; i < 20; i++) addRepository(i);
    await flush();
    check('twenty repository-open events start one shared round instead of 230 Git queries', () => {
      assert.strictEqual(burstCalls.async.length, 21);
    });
    for (let i = 20; i < 30; i++) addRepository(i);
    await flush();
    check('events arriving during a pending query do not start overlapping rounds', () => {
      assert.strictEqual(burstCalls.async.length, 21);
    });
    burstCalls.pending.splice(0).forEach(run => run());
    await until(() => burstCalls.pending.length === 31);
    burstCalls.pending.splice(0).forEach(run => run());
    await Promise.all(eventResults);
    check('one follow-up round includes all repositories discovered during the first query', () => {
      assert.strictEqual(latest.length, 30); assert.strictEqual(burstCalls.async.length, 52);
    });
    addRepository(30); await flush();
    const callsBeforeDispose = burstCalls.async.length;
    addRepository(31);
    burstSubscriptions.forEach(s => s.dispose());
    burstCalls.pending.splice(0).forEach(run => run());
    await Promise.all(eventResults);
    check('disposal during an event refresh cancels its queued follow-up', () => {
      assert.strictEqual(burstCalls.async.length, callsBeforeDispose);
      assert.strictEqual(burstCalls.pending.length, 0);
    });
    console.log(passed + ' passed');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
