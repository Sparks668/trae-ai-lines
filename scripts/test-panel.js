'use strict';
// Integration checks use temporary repositories and a mocked VS Code host.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : root;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trae-panel-test-')));
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok ${name}`); };
const flush = () => new Promise(setImmediate);
const until = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert(Date.now() < deadline, 'asynchronous guard state did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

(async () => {
  const disposables = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
    check('details command is contributed', () => assert(pkg.contributes.commands.some(c => c.command === 'aiLines.showDetails')));
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo);
    const git = args => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git(['init', '-q']);
    const guard = require(path.join(target, 'guard'));
    guard.writeHooks(path.join(repo, '.git', 'hooks'), 90, repo, { enabled: true, importOn: false });
    const commands = {}, items = [], panels = [], timers = [], output = [];
    let outputClears = 0, outputDisposed = false;
    const errors = [], warnings = [];
    let inputValue = '95', inputGate = null, inputOptions;
    let day = '2026-10-22';
    let sums = { ai: 12, total: 20, commits: 2 }, pending = { ai: 6, total: 8, gitAdds: 108, gitDels: 4 };
    let pollError = null, pendingGate = null, pendingQueries = 0; const polls = [];
    class Counter {
      async poll(native) {
        polls.push(!!native);
        if (pollError) throw pollError;
        this.lastRead = { source: 'native', files: ['/test/git-ai-daemon-2026-10-29.log'], errors: [] };
      }
      sums() { return { ...sums }; }
      listFiles() { return []; }
    }
    const lib = { AiLinesCounter: Counter, localDate: () => day,
      uncommitted: async () => { pendingQueries++; const result = pending; if (pendingGate) await pendingGate; return result; },
      gitDiffStat: async () => ({ adds: 8, dels: 1, total: 8 }) };
    const vscode = {
      StatusBarAlignment: { Right: 2 }, ViewColumn: { Active: -1, Beside: -2 },
      workspace: { workspaceFolders: [{ uri: { fsPath: repo } }] },
      commands: {
        registerCommand(id, fn) { commands[id] = fn; return { dispose() {} }; },
        executeCommand(id, ...args) { return commands[id](...args); }
      },
      MarkdownString: class { constructor(value) { this.value = value; } },
      window: {
        createStatusBarItem() { const item = { text: '', show() {}, hide() {}, dispose() {} }; items.push(item); return item; },
        showInformationMessage() {},
        showErrorMessage(message) { errors.push(message); },
        showWarningMessage(message) { warnings.push(message); },
        async showInputBox(options) { inputOptions = options; if (inputGate) await inputGate; return inputValue; },
        createOutputChannel() { const lines = []; output.push(lines); return {
          show() {}, appendLine: s => lines.push(s),
          clear() { outputClears++; lines.length = 0; },
          dispose() { outputDisposed = true; }
        }; },
        createWebviewPanel(type, title, column, options) {
          let receive, close;
          const p = { type, title, column, options, revealed: 0, disposed: false,
            messages: [], webview: { html: '',
              onDidReceiveMessage(fn) { receive = fn; return { dispose() { receive = null; } }; },
              postMessage(m) { p.messages.push(m); return Promise.resolve(true); } },
            onDidDispose(fn) { close = fn; return { dispose() { close = null; } }; },
            reveal() { p.revealed++; },
            dispose() { p.disposed = true; close?.(); receive = null; },
            receive(m) { return receive?.(m); }
          }; panels.push(p); return p;
        }
      }
    };
    let guardQueries = 0;
    const guardContext = { module: { exports: {} }, __dirname: target, process, console,
      require: name => name === 'vscode' ? vscode : name === 'child_process' ? {
        ...require(name), execFile(...args) { guardQueries++; return require(name).execFile(...args); }
      } : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(target, 'guard.js'), 'utf8'), guardContext);
    const context = { module: { exports: {} }, process, console,
      setInterval(fn, ms) { timers.push({ fn, ms }); return 1; }, clearInterval() { timers.length = 0; },
      setTimeout(fn) { fn(); },
      require: name => name === 'vscode' ? vscode : name === './lib' ? lib
        : name === './guard' ? guardContext.module.exports
          : name.startsWith('./') ? require(path.join(target, name)) : require(name) };
    vm.runInNewContext(fs.readFileSync(path.join(target, 'extension.js'), 'utf8'), context);
    context.module.exports.activate({ subscriptions: disposables, extension: { packageJSON: pkg } });
    await flush();
    check('activation keeps one refresh timer and creates no panel eagerly', () => {
      assert.strictEqual(timers.length, 1); assert.strictEqual(timers[0].ms, 30000); assert.strictEqual(panels.length, 0);
    });
    check('startup and automatic refresh prefer native logs', () => assert.strictEqual(polls[0], true));
    check('tooltip exposes only the details command as a trusted link', () => {
      assert(items[0].tooltip.value.includes('command:aiLines.showDetails'));
      assert.deepStrictEqual(Array.from(items[0].tooltip.isTrusted.enabledCommands), ['aiLines.showDetails']);
    });
    await commands['aiLines.showDetails']();
    const p = panels[0]; await p.receive({ type: 'ready' });
    check('details opens in the current editor group without a new split', () => {
      assert.strictEqual(p.column, vscode.ViewColumn.Active);
    });
    const lastData = () => p.messages.filter(m => m.type === 'data').at(-1).data;
    check('persistent panel shows the same committed/pending/Git values and guard settings', () => {
      const d = lastData(); assert.strictEqual(d.committed.ai, 12); assert.strictEqual(d.committed.total, 20);
      assert.strictEqual(d.committed.commits, 2); assert.strictEqual(d.pending.ai, 6); assert.strictEqual(d.pending.total, 8);
      assert.strictEqual(d.diff.adds, 108); assert.strictEqual(d.diff.dels, 4);
      assert.strictEqual(d.guards[0].threshold, 90); assert.strictEqual(d.guards[0].enabled, true);
      assert.strictEqual(d.guards[0].importOn, false); assert.strictEqual(d.workspace, repo); assert.strictEqual(d.version, pkg.version);
      assert.strictEqual(d.logSource, 'daemon 原生日志');
    });
    await until(() => !lastData().refreshing);
    const queriesBeforeSharedRefresh = guardQueries;
    await timers[0].fn();
    await flush();
    check('automatic refresh keeps the same native-first policy as manual refresh', () => assert.strictEqual(polls.at(-1), true));
    check('one refresh shares the guard query between status bar and open details', () => {
      assert.strictEqual(guardQueries - queriesBeforeSharedRefresh, 1);
      assert.strictEqual(lastData().refreshing, false);
      assert.strictEqual(lastData().guards[0].threshold, 90);
    });
    const repoHooks = path.join(repo, '.git', 'hooks');
    const repoConfig = path.join(repo, '.git', 'ai-ratio-guard.json');
    const savedConfig = fs.readFileSync(repoConfig);
    const savedChecker = fs.readFileSync(path.join(repoHooks, 'check-ai-ratio.js'));
    // Simulate another window updating the same repository's configuration.
    guard.writeHooks(repoHooks, 90, repo, { enabled: false, importOn: false });
    await timers[0].fn();
    check('automatic refresh picks up another window disabling the guard', () => {
      assert.strictEqual(items[1].text, 'AI-GIT校验:关');
      assert.strictEqual(guard.readState(repoHooks, repo).enabled, false);
    });
    guard.writeHooks(repoHooks, 75, repo, { enabled: true, importOn: true });
    await commands['aiLines.refresh']();
    check('manual refresh picks up external threshold and import-switch changes', () => {
      assert.strictEqual(items[1].text, '$(shield) AI≥75%');
    });
    fs.writeFileSync(repoConfig, '{');
    await timers[0].fn();
    check('external invalid config is shown without breaking statistics refresh', () => {
      assert(items[1].text.includes('配置异常'));
      assert(items[0].text.includes('AI 12 / 20'));
      assert.strictEqual(fs.readFileSync(repoConfig, 'utf8'), '{');
    });
    fs.writeFileSync(repoConfig, savedConfig);
    await commands['aiLines.refresh']();
    check('repaired config recovers the guard display without rewriting hooks', () => {
      assert.strictEqual(items[1].text, '$(shield) AI≥90%·大关');
      assert(fs.readFileSync(path.join(repoHooks, 'check-ai-ratio.js')).equals(savedChecker));
      assert(fs.readFileSync(repoConfig).equals(savedConfig));
    });
    check('webview has local-only resources and a restrictive content policy', () => {
      assert.strictEqual(p.options.enableScripts, true); assert.strictEqual(p.options.localResourceRoots.length, 0);
      assert(p.webview.html.includes("default-src 'none'")); assert(!p.webview.html.includes('unsafe-inline'));
    });
    const initialHtml = p.webview.html;
    // Execute the actual inline page script with a minimal DOM to verify clicks.
    const elements = new Map(), sent = [], listeners = {};
    class Element {
      constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; }
      append(...children) { this.children.push(...children); }
      replaceChildren() { this.children = []; }
      setAttribute(name, value) { this[name] = value; }
      addEventListener(name, fn) { this.events[name] = fn; }
    }
    for (const [, id] of initialHtml.matchAll(/id="([^"]+)"/g)) elements.set(id, new Element('div'));
    elements.get('guard-enable-all').dataset.guardAction = 'guardEnableAll';
    const buttons = () => {
      const found = [];
      const walk = node => { if (node.dataset.guardAction) found.push(node); node.children.forEach(walk); };
      walk(elements.get('guards')); return found;
    };
    vm.runInNewContext(initialHtml.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1], {
      acquireVsCodeApi: () => ({ postMessage: message => sent.push(message) }),
      document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag),
        querySelectorAll: () => [elements.get('guard-enable-all'), ...buttons()] },
      window: { addEventListener: (name, fn) => { listeners[name] = fn; } }
    });
    listeners.message({ data: { type: 'data', data: lastData() } });
    check('details show the workspace guard coverage and an explicit bulk-enable action', () => {
      assert.strictEqual(elements.get('guard-summary').textContent, '已开启 1/1 个仓库');
      elements.get('guard-enable-all').events.click();
      assert.strictEqual(sent.at(-1).type, 'guardEnableAll');
      assert.strictEqual(sent.at(-1).cwd, undefined);
      assert(elements.get('guard-enable-all').disabled); assert(buttons().every(b => b.disabled));
    });
    listeners.message({ data: { type: 'data', data: { ...lastData(), guards: [], guardsLoading: false } } });
    check('bulk enable is disabled when there are no repositories', () => {
      assert.strictEqual(elements.get('guard-summary').textContent, '暂无 Git 仓库');
      assert(elements.get('guard-enable-all').disabled);
    });
    const queryFailure = { cwd: repo + '-unavailable', error: 'Git: test query timed out' };
    listeners.message({ data: { type: 'data', data: { ...lastData(), guards: [...lastData().guards, queryFailure] } } });
    check('partial discovery failures are included in coverage and shown explicitly', () => {
      assert.strictEqual(elements.get('guard-summary').textContent, '已开启 1/2 个仓库，1 项读取失败');
      assert(elements.get('guards').children.some(s => s.children.some(c => c.textContent?.includes('test query timed out'))));
      assert(!elements.get('guard-enable-all').disabled);
    });
    listeners.message({ data: { type: 'data', data: { ...lastData(), guards: [queryFailure] } } });
    check('all discovery failures show an error instead of the no-repository message', () => {
      assert.strictEqual(elements.get('guard-summary').textContent, '已开启 0/1 个仓库，1 项读取失败');
      assert(elements.get('guards').children.every(s => s.textContent !== '当前工作区没有可用的 Git 仓库'));
    });
    listeners.message({ data: { type: 'data', data: lastData() } });
    check('page renders repository controls and sends the exact clicked action and repository', () => {
      assert.deepStrictEqual(buttons().map(b => b.textContent), ['关闭校验', '调整阈值', '开启批量校验']);
      buttons()[1].events.click();
      assert.strictEqual(sent.at(-1).type, 'guardSetThreshold'); assert.strictEqual(sent.at(-1).cwd, repo);
      assert(buttons().every(b => b.disabled));
    });
    const notInstalled = { ...lastData(), guards: [{ ...lastData().guards[0], installed: false, enabled: false }] };
    listeners.message({ data: { type: 'data', data: notInstalled } });
    check('an uninstalled repository exposes only the enable button', () => {
      assert.deepStrictEqual(buttons().map(b => b.disabled), [false, true, true]);
      assert.strictEqual(buttons()[1].title, '请先开启校验'); assert.strictEqual(buttons()[2].title, '请先开启校验');
    });
    listeners.message({ data: { type: 'data', data: { ...notInstalled, guardBusy: true } } });
    listeners.message({ data: { type: 'data', data: { ...notInstalled, guardBusy: false } } });
    check('finishing another operation does not unlock uninstalled repository settings', () => {
      assert.deepStrictEqual(buttons().map(b => b.disabled), [false, true, true]);
    });
    listeners.message({ data: { type: 'data', data: lastData() } });
    check('installed repository settings remain available', () => assert(buttons().every(b => !b.disabled)));

    const freshRepo = path.join(tmp, 'fresh'); fs.mkdirSync(freshRepo);
    execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', freshRepo], { stdio: 'ignore' });
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: freshRepo } });
    await p.receive({ type: 'refresh' });
    await until(() => lastData().guards.some(g => g.cwd === freshRepo));
    const freshState = () => lastData().guards.find(g => g.cwd === freshRepo);
    const freshScript = path.join(freshRepo, '.git/hooks/check-ai-ratio.js');
    const freshConfig = path.join(freshRepo, '.git/ai-ratio-guard.json');
    for (const type of ['guardSetThreshold', 'guardToggleImport']) {
      await p.receive({ type, cwd: freshRepo });
      check(`${type} cannot install or enable a fresh repository through a direct message`, () => {
        assert.strictEqual(freshState().installed, false); assert.strictEqual(freshState().enabled, false);
        assert(!fs.existsSync(freshScript)); assert(!fs.existsSync(freshConfig));
        assert.strictEqual(inputOptions, undefined); assert(errors.at(-1).includes('请先开启校验'));
        assert.strictEqual(lastData().guardBusy, false);
      });
    }
    await p.receive({ type: 'guardToggle', cwd: freshRepo });
    await p.receive({ type: 'guardSetThreshold', cwd: freshRepo });
    await p.receive({ type: 'guardToggleImport', cwd: freshRepo });
    check('explicitly enabling a fresh repository unlocks its settings normally', () => {
      assert.strictEqual(freshState().installed, true); assert.strictEqual(freshState().enabled, true);
      assert.strictEqual(freshState().threshold, 95); assert.strictEqual(freshState().importOn, false);
      assert.strictEqual(lastData().guards[0].threshold, 90);
    });
    const freshSettings = fs.readFileSync(freshConfig);
    fs.unlinkSync(freshScript);
    await p.receive({ type: 'guardToggleImport', cwd: freshRepo });
    check('a stale installed card cannot silently reinstall a removed checker', () => {
      assert(!fs.existsSync(freshScript)); assert(fs.readFileSync(freshConfig).equals(freshSettings));
      assert.strictEqual(freshState().installed, false); assert(errors.at(-1).includes('请先开启校验'));
    });
    await p.receive({ type: 'guardToggle', cwd: freshRepo });
    let releaseFreshInput;
    inputGate = new Promise(resolve => { releaseFreshInput = resolve; });
    inputValue = '80';
    const removingChecker = p.receive({ type: 'guardSetThreshold', cwd: freshRepo }); await flush();
    fs.unlinkSync(freshScript); inputGate = null; releaseFreshInput(); await removingChecker;
    check('removing a checker while threshold input is open prevents implicit reinstallation', () => {
      assert(!fs.existsSync(freshScript)); assert(fs.readFileSync(freshConfig).equals(freshSettings));
      assert.strictEqual(freshState().installed, false); assert.strictEqual(lastData().guardBusy, false);
    });
    inputValue = '95';
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo } }];
    await p.receive({ type: 'refresh' }); await until(() => lastData().guards.length === 1);
    await p.receive({ type: 'guardToggle', cwd: repo });
    check('panel can disable the real guard and immediately synchronize its status bar', () => {
      assert.strictEqual(lastData().guards[0].enabled, false); assert(items[1].text.includes('关'));
      assert.strictEqual(lastData().committed.total, 20);
    });
    await p.receive({ type: 'guardSetThreshold', cwd: repo });
    check('panel threshold adjustment uses the original input validation and keeps the guard disabled', () => {
      assert.strictEqual(inputOptions.value, '90'); assert.strictEqual(inputOptions.validateInput('95'), null);
      for (const value of ['49', '101', '80.5', 'abc']) assert(inputOptions.validateInput(value));
      assert.strictEqual(lastData().guards[0].threshold, 95); assert.strictEqual(lastData().guards[0].enabled, false);
    });
    inputValue = undefined;
    await p.receive({ type: 'guardSetThreshold', cwd: repo });
    check('cancelling threshold input preserves settings and unlocks panel controls', () => {
      assert.strictEqual(lastData().guards[0].threshold, 95); assert.strictEqual(lastData().guardBusy, false);
    });
    inputValue = '90';
    let releaseInput;
    inputGate = new Promise(resolve => { releaseInput = resolve; });
    const thresholdChange = p.receive({ type: 'guardSetThreshold', cwd: repo }); await flush();
    await p.receive({ type: 'guardToggle', cwd: repo });
    check('an open input box blocks duplicate guard actions and keeps controls busy', () => {
      assert.strictEqual(lastData().guardBusy, true); assert.strictEqual(guard.readState(path.join(repo, '.git/hooks'), repo).enabled, false);
    });
    inputGate = null; releaseInput(); await thresholdChange;
    await p.receive({ type: 'guardToggle', cwd: repo });
    check('panel can re-enable the guard with its preserved threshold', () => {
      assert.strictEqual(lastData().guards[0].enabled, true); assert.strictEqual(lastData().guards[0].threshold, 90);
      assert(items[1].text.includes('90%')); assert.strictEqual(lastData().guardBusy, false);
    });
    await p.receive({ type: 'guardToggleImport', cwd: repo });
    check('panel can change the bulk-import switch without changing master or threshold', () => {
      assert.strictEqual(lastData().guards[0].importOn, true); assert.strictEqual(lastData().guards[0].enabled, true);
      assert.strictEqual(lastData().guards[0].threshold, 90);
    });
    await p.receive({ type: 'guardToggleImport', cwd: repo });
    const oldConfig = fs.readFileSync(path.join(repo, '.git/ai-ratio-guard.json'));
    await p.receive({ type: 'guardToggle', cwd: tmp });
    check('panel rejects paths not represented by an opened repository', () => {
      assert(errors.at(-1).includes('仓库状态已不可用')); assert.strictEqual(lastData().guardBusy, false);
      assert(fs.readFileSync(path.join(repo, '.git/ai-ratio-guard.json')).equals(oldConfig));
    });
    const warningsBefore = warnings.length;
    await commands['aiLines.guardToggle'](tmp);
    check('guard command also rejects an arbitrary target passed outside the panel', () => {
      assert.strictEqual(warnings.length, warningsBefore + 1);
      assert(fs.readFileSync(path.join(repo, '.git/ai-ratio-guard.json')).equals(oldConfig));
    });
    inputGate = new Promise(resolve => { releaseInput = resolve; });
    inputValue = '95';
    const removedTarget = p.receive({ type: 'guardSetThreshold', cwd: repo }); await flush();
    vscode.workspace.workspaceFolders = [];
    inputGate = null; releaseInput(); await removedTarget;
    check('removing a repository while threshold input is open prevents a stale write', () => {
      assert(fs.readFileSync(path.join(repo, '.git/ai-ratio-guard.json')).equals(oldConfig));
      assert(warnings.length > 0); assert.strictEqual(lastData().guardBusy, false);
    });
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo } }];
    inputValue = '90'; await p.receive({ type: 'refresh' });
    await commands['aiLines.showDetails']();
    check('opening again reveals the existing panel', () => { assert.strictEqual(panels.length, 1); assert.strictEqual(p.revealed, 1); });
    sums = { ai: 30, total: 40, commits: 3 }; pending = null;
    await timers[0].fn();
    check('automatic refresh updates the existing page, including Git when AI is unavailable', () => {
      const d = lastData(); assert.strictEqual(d.committed.ai, 30); assert.strictEqual(d.pending, null);
      assert.strictEqual(d.diff.adds, 8); assert.strictEqual(d.diff.dels, 1); assert.strictEqual(p.webview.html, initialHtml);
      assert.strictEqual(timers.length, 1);
    });
    await p.receive({ type: 'refresh' });
    check('manual panel refresh uses the native-log refresh path', () => assert.strictEqual(polls.at(-1), true));
    const updatedAt = lastData().updatedAt;
    pollError = new Error('test read failure');
    await p.receive({ type: 'refresh' });
    check('refresh failure preserves the last snapshot and exposes the error', () => {
      const d = lastData(); assert.strictEqual(d.committed.ai, 30); assert.strictEqual(d.updatedAt, updatedAt);
      assert(d.error.includes('test read failure')); assert.strictEqual(d.refreshing, false);
    });
    pollError = null;
    let releaseRefresh;
    pendingGate = new Promise(resolve => { releaseRefresh = resolve; });
    const activeRefresh = commands['aiLines.refresh'](); await flush();
    items[0].text = 'changed while refreshing';
    const pollsBeforeDuplicate = polls.length;
    await commands['aiLines.refresh']();
    await commands['aiLines.showDetails']();
    check('refresh locking and panel busy state do not depend on status text', () => {
      assert.strictEqual(polls.length, pollsBeforeDuplicate); assert.strictEqual(lastData().refreshing, true);
    });
    pendingGate = null; releaseRefresh(); await activeRefresh;
    items[0].text = '$(loading~spin) custom idle text';
    await commands['aiLines.refresh']();
    check('loading-like text while idle does not prevent a real refresh', () => {
      assert.strictEqual(polls.length, pollsBeforeDuplicate + 1); assert.strictEqual(lastData().refreshing, false);
    });
    day = '2026-10-23'; sums = { ai: 5, total: 9, commits: 1 };
    pendingGate = new Promise(resolve => { releaseRefresh = resolve; });
    await commands['aiLines.showDetails'](); await flush();
    check('opening details after midnight clears yesterday totals while refreshing', () => {
      const d = lastData(); assert.strictEqual(d.date, day); assert.strictEqual(d.committed, null);
      assert.strictEqual(d.updatedAt, null); assert.strictEqual(d.refreshing, true);
    });
    pendingGate = null; releaseRefresh();
    await until(() => lastData().committed?.ai === 5 && !lastData().refreshing);
    check('new day totals appear only after the new day refresh completes', () => {
      assert.strictEqual(lastData().date, day); assert.strictEqual(lastData().committed.total, 9);
    });
    day = '2026-10-24'; pollError = new Error('new day read failure');
    await commands['aiLines.showDetails'](); await flush();
    await until(() => !lastData().refreshing);
    check('failed new day refresh never relabels yesterday totals as today', () => {
      const d = lastData(); assert.strictEqual(d.date, day); assert.strictEqual(d.committed, null);
      assert.strictEqual(d.updatedAt, null); assert(d.error.includes('new day read failure'));
      assert.strictEqual(d.refreshing, false);
    });
    pollError = null; sums = { ai: 30, total: 40, commits: 3 };
    await commands['aiLines.refresh']();
    pendingGate = new Promise(resolve => { releaseRefresh = resolve; });
    const crossingMidnight = commands['aiLines.refresh'](); await flush();
    day = '2026-10-25'; pendingGate = null; releaseRefresh(); await crossingMidnight;
    check('a refresh crossing midnight keeps its old totals out of today details', () => {
      assert.strictEqual(lastData().date, day); assert.strictEqual(lastData().committed, null);
    });
    await commands['aiLines.refresh']();
    const secondRepo = path.join(tmp, 'second'); fs.mkdirSync(secondRepo);
    execFileSync('git', ['init', '-q', secondRepo], { stdio: 'ignore' });
    guard.writeHooks(path.join(secondRepo, '.git', 'hooks'), 80, secondRepo, { enabled: false, importOn: true });
    pending = { ai: 6, total: 8, gitAdds: 108, gitDels: 4 };
    pendingGate = new Promise(resolve => { releaseRefresh = resolve; });
    const oldWorkspaceRefresh = commands['aiLines.refresh'](); await flush();
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: secondRepo } }, { uri: { fsPath: repo } }];
    await commands['aiLines.showDetails']();
    check('switching workspace hides previous repository pending and Git values', () => {
      const d = lastData(); assert.strictEqual(d.workspace, secondRepo); assert.strictEqual(d.pending, null);
      assert.strictEqual(d.diff, null); assert.strictEqual(d.updatedAt, null);
      assert.strictEqual(d.committed.total, 40);
    });
    pendingGate = null; releaseRefresh(); await oldWorkspaceRefresh;
    check('an old workspace query cannot populate the new repository display', () => {
      assert.strictEqual(lastData().workspace, secondRepo); assert.strictEqual(lastData().pending, null);
      assert.strictEqual(lastData().diff, null);
    });
    pending = { ai: 12, total: 15, gitAdds: 15, gitDels: 1 };
    await commands['aiLines.showDetails']();
    await until(() => lastData().pending?.ai === 12 && !lastData().refreshing);
    check('reopening details refreshes values for the newly selected repository', () => {
      assert.strictEqual(lastData().workspace, secondRepo); assert.strictEqual(lastData().pending.total, 15);
      assert.strictEqual(lastData().diff.adds, 15);
    });
    pending = null;
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo } }];
    vscode.workspace.workspaceFolders.push({ uri: { fsPath: secondRepo } });
    await p.receive({ type: 'refresh' });
    await until(() => lastData().guards.length === 2 && lastData().guards[0].cwd === repo);
    check('all workspace repositories retain their independent guard settings', () => {
      const guards = lastData().guards; assert.strictEqual(guards.length, 2);
      assert.strictEqual(guards[0].threshold, 90); assert.strictEqual(guards[1].threshold, 80);
      assert.strictEqual(guards[1].enabled, false); assert.strictEqual(guards[1].importOn, true);
    });
    inputValue = '75';
    await p.receive({ type: 'guardSetThreshold', cwd: secondRepo });
    check('panel threshold adjustment changes only the selected repository', () => {
      assert.strictEqual(lastData().guards[0].threshold, 90); assert.strictEqual(lastData().guards[1].threshold, 75);
    });
    inputValue = '80'; await p.receive({ type: 'guardSetThreshold', cwd: secondRepo });
    await p.receive({ type: 'guardToggle', cwd: secondRepo });
    await p.receive({ type: 'guardToggle', cwd: repo });
    check('panel guard toggles remain isolated across multiple repositories', () => {
      assert.strictEqual(lastData().guards[0].enabled, false); assert.strictEqual(lastData().guards[1].enabled, true);
    });
    await p.receive({ type: 'guardToggle', cwd: repo });
    await p.receive({ type: 'guardToggle', cwd: secondRepo });
    const repoState = () => lastData().guards[0];
    const entryFile = path.join(repo, '.git/hooks/pre-commit'), originalEntry = fs.readFileSync(entryFile);
    fs.writeFileSync(entryFile, '#!/bin/sh\nexit 0\n');
    await p.receive({ type: 'guardToggle', cwd: repo });
    check('panel operations preserve foreign hooks and clear their busy state on refusal', () => {
      assert.strictEqual(fs.readFileSync(entryFile, 'utf8'), '#!/bin/sh\nexit 0\n');
      assert(errors.at(-1).includes('不属于本插件')); assert.strictEqual(lastData().guardBusy, false);
      assert.strictEqual(repoState().enabled, false);
    });
    fs.writeFileSync(entryFile, originalEntry);
    await commands['aiLines.guardToggle']();
    await until(() => lastData().guards.every(g => g.enabled === false));
    check('original workspace-wide commands still update all repositories and the open panel', () => {
      assert.strictEqual(lastData().guards.length, 2); assert.strictEqual(lastData().guardBusy, false);
    });
    await p.receive({ type: 'guardToggle', cwd: repo });
    fs.writeFileSync(path.join(repo, '.git', 'ai-ratio-guard.json'), '{');
    await p.receive({ type: 'refresh' });
    await until(() => !!lastData().guards[0]?.error);
    check('bad guard config does not hide statistical data', () => {
      assert(lastData().guards[0].error.includes('ai-ratio-guard.json')); assert.strictEqual(lastData().committed.total, 40);
      assert.strictEqual(lastData().guards[1].threshold, 80);
    });
    await p.receive({ type: 'diagnose' });
    check('diagnostic button runs the built-in diagnostic without standalone scripts', () => {
      assert.strictEqual(output.length, 1); assert(output[0].some(s => s.includes('工作区')));
    });
    const before = polls.length; await p.receive({ type: 'execute', command: 'anything' });
    check('unknown webview messages cannot invoke arbitrary commands', () => assert.strictEqual(polls.length, before));
    vscode.workspace.workspaceFolders = [];
    await p.receive({ type: 'refresh' });
    await until(() => lastData().guards.length === 0);
    check('no-workspace state preserves daily totals with no pending data or guard state', () => {
      assert.strictEqual(lastData().workspace, null); assert.strictEqual(lastData().pending, null);
      assert.strictEqual(lastData().guards.length, 0); assert.strictEqual(lastData().committed.total, 40);
    });
    p.dispose(); await commands['aiLines.showDetails']();
    check('a closed panel can be opened again', () => assert.strictEqual(panels.length, 2));

    vscode.workspace.workspaceFolders = [{ uri: { fsPath: repo } }];
    let release;
    pendingGate = new Promise(resolve => { release = resolve; });
    const queriesBefore = pendingQueries, clearsBefore = outputClears;
    const diagnostic = commands['aiLines.diagnose']();
    await flush();
    const busyPanel = panels[1];
    const duplicates = Promise.all([commands['aiLines.diagnose'](), busyPanel.receive({ type: 'diagnose' })]);
    await flush();
    check('command and panel share one diagnostic while the query is pending', () => {
      assert.strictEqual(pendingQueries - queriesBefore, 1);
      assert.strictEqual(output.length, 1); assert.strictEqual(outputClears - clearsBefore, 1);
      assert.strictEqual(busyPanel.messages.filter(m => m.type === 'diagnosing').at(-1).value, true);
    });
    pendingGate = null;
    await timers[0].fn();
    check('statistics refresh preserves the running diagnostic state', () => {
      assert.strictEqual(busyPanel.messages.filter(m => m.type === 'data').at(-1).data.diagnosing, true);
    });
    busyPanel.dispose(); await commands['aiLines.showDetails']();
    const reopened = panels[2]; await reopened.receive({ type: 'ready' });
    check('reopening during diagnosis restores the busy state', () => {
      assert.strictEqual(reopened.messages.filter(m => m.type === 'data').at(-1).data.diagnosing, true);
    });
    release(); await Promise.all([diagnostic, duplicates]);
    check('diagnostic completion unlocks the replacement panel', () => {
      assert.strictEqual(reopened.messages.filter(m => m.type === 'diagnosing').at(-1).value, false);
    });
    pollError = new Error('diagnostic read failure');
    await assert.rejects(commands['aiLines.diagnose'](), /diagnostic read failure/);
    check('diagnostic failure also clears its busy state', () => {
      assert.strictEqual(reopened.messages.filter(m => m.type === 'diagnosing').at(-1).value, false);
    });
    pollError = null;
    const retryBefore = pendingQueries;
    await reopened.receive({ type: 'diagnose' });
    check('diagnosis can be retried after an error', () => assert.strictEqual(pendingQueries, retryBefore + 1));
    check('repeated diagnostics reuse and clear the same output channel', () => {
      assert.strictEqual(output.length, 1); assert.strictEqual(outputClears, clearsBefore + 3);
      assert.strictEqual(output[0].filter(s => s.includes('--- 已提交统计链路')).length, 1);
    });
    fs.writeFileSync(path.join(repo, '.git/ai-ratio-guard.json'), oldConfig);
    await commands['aiLines.refresh']();
    await until(() => !reopened.messages.filter(m => m.type === 'data').at(-1).data.guards[0]?.error);
    inputValue = '85'; inputGate = new Promise(resolve => { releaseInput = resolve; });
    const closingChange = reopened.receive({ type: 'guardSetThreshold', cwd: repo }); await flush();
    reopened.dispose(); await commands['aiLines.showDetails']();
    const replacement = panels.at(-1); await replacement.receive({ type: 'ready' });
    check('reopening the panel during threshold input preserves the busy state', () => {
      assert.strictEqual(replacement.messages.filter(m => m.type === 'data').at(-1).data.guardBusy, true);
    });
    inputGate = null; releaseInput(); await closingChange;
    check('threshold completion updates and unlocks the replacement panel', () => {
      const d = replacement.messages.filter(m => m.type === 'data').at(-1).data;
      assert.strictEqual(d.guardBusy, false); assert.strictEqual(d.guards[0].threshold, 85);
      assert.strictEqual(d.committed.total, 40);
    });
    const conflictRepo = path.join(tmp, 'bulk conflict'), bulkFresh = path.join(tmp, 'bulk fresh');
    for (const r of [conflictRepo, bulkFresh]) {
      fs.mkdirSync(r); execFileSync('git', ['-c', 'init.templateDir=', 'init', '-q', r], { stdio: 'ignore' });
    }
    const conflictEntry = path.join(conflictRepo, '.git/hooks/pre-commit');
    fs.mkdirSync(path.dirname(conflictEntry), { recursive: true });
    const foreignContent = '#!/bin/sh\n# project check\nexit 0\n'; fs.writeFileSync(conflictEntry, foreignContent);
    fs.mkdirSync(path.join(bulkFresh, 'module'));
    vscode.workspace.workspaceFolders = [conflictRepo, repo, secondRepo, bulkFresh, path.join(bulkFresh, 'module')]
      .map(fsPath => ({ uri: { fsPath } }));
    await replacement.receive({ type: 'refresh' });
    const oldThreshold = guard.readState(path.join(secondRepo, '.git/hooks'), secondRepo).threshold;
    const realEnableAll = commands['aiLines.guardEnableAll'];
    let releaseBulk;
    const bulkGate = new Promise(resolve => { releaseBulk = resolve; });
    let bulkCalls = 0;
    commands['aiLines.guardEnableAll'] = async () => {
      bulkCalls++; const result = await realEnableAll(); await bulkGate; return result;
    };
    const bulkOperation = replacement.receive({ type: 'guardEnableAll' }); await flush();
    await replacement.receive({ type: 'guardEnableAll' });
    await replacement.receive({ type: 'guardToggle', cwd: repo });
    check('one pending bulk action blocks duplicate bulk and per-repository changes', () => {
      assert.strictEqual(bulkCalls, 1);
      assert.strictEqual(replacement.messages.filter(m => m.type === 'data').at(-1).data.guardBusy, true);
    });
    releaseBulk(); await bulkOperation; commands['aiLines.guardEnableAll'] = realEnableAll;
    const bulkData = replacement.messages.filter(m => m.type === 'data').at(-1).data;
    check('bulk enable reports conflicts while still enabling later repositories', () => {
      assert.strictEqual(bulkData.guards.length, 4);
      assert.strictEqual(bulkData.guards.filter(g => g.enabled).length, 3);
      assert.strictEqual(bulkData.guardBatchResult.length, 4);
      assert.strictEqual(bulkData.guardBatchResult.filter(r => r.status === 'failed').length, 1);
      assert.strictEqual(fs.readFileSync(conflictEntry, 'utf8'), foreignContent);
      assert.strictEqual(guard.readState(path.join(secondRepo, '.git/hooks'), secondRepo).threshold, oldThreshold);
      assert.strictEqual(bulkData.guardBusy, false);
    });
    listeners.message({ data: { type: 'data', data: bulkData } });
    check('bulk results and actual coverage are displayed inside details', () => {
      assert.strictEqual(elements.get('guard-summary').textContent, '已开启 3/4 个仓库');
      const result = elements.get('guard-batch-result'); assert.strictEqual(result.hidden, false);
      assert(result.children.some(c => c.textContent.includes(conflictRepo) && c.textContent.includes('开启失败')));
      assert(items[1].text.indexOf('3/4') === -1);
    });
    disposables.forEach(d => d.dispose());
    check('deactivation disposes the panel and refresh timer', () => {
      assert.strictEqual(replacement.disposed, true); assert.strictEqual(timers.length, 0);
    });
    check('deactivation disposes the diagnostic output channel', () => assert.strictEqual(outputDisposed, true));
    console.log(`${passed} passed`);
  } finally {
    disposables.forEach(d => d.dispose());
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
