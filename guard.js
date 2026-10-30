'use strict';
// guard.js: AI-ratio pre-commit hook manager, merged from ai-ratio-guard 0.1.0.
// State lives in the repository's common Git directory; hooks may be shared
// by unrelated repositories. Source stays ASCII-only (Chinese
// via \u escapes) so no editor/file-encoding can ever garble it at runtime.
const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const SCRIPT = 'check-ai-ratio.js';
const ENTRY = 'pre-commit';
const MARKER = '.ai-ratio-off';
const IMPORT_MARKER = '.ai-ratio-import-off';
const SETTINGS = 'ai-ratio-guard.json';
const SCRIPT_OWNER = '// AI-ratio pre-commit hook (installed and managed by the ai-ratio-guard extension).';
// Original 0.2.19/0.2.20 checkers predate guard-v tags. Match their entire
// templates, allowing only the installed threshold and line-ending changes.
const LEGACY_SCRIPT_HASHES = new Set([
  '44ac70916b63da611910d4010d5af4c13d33ce1ba5957547050e281476d4dbeb',
  '0465203c17b4a4976b843085b4baa86e6d79cb7aca3ec54c75fc3925e87f81ad'
]);
const HOOK_TAG = 'guard-v10'; // bump whenever hooks/check-ai-ratio.js template changes
const DEFAULT_PCT = 50;

const T = {
  onTip: 'AI\u4ee3\u7801\u5360\u6bd4\u6821\u9a8c\uff1a\u5f00\u542f\uff08\u9608\u503c ',
  onTipEnd: '%\uff09',
  clickOff: '\u70b9\u51fb\u5173\u95ed \u00b7 ',
  setThr: '\u8c03\u6574\u9608\u503c',
  offTip: 'AI \u4ee3\u7801\u5360\u6bd4\u6821\u9a8c\uff1a\u5173\u95ed',
  clickOn: '\u70b9\u51fb\u5f00\u542f',
  offText: 'AI-GIT\u6821\u9a8c:\u5173',
  configError: '$(warning) AI-GIT\u6821\u9a8c:\u914d\u7f6e\u5f02\u5e38',
  configErrorTip: '\u8bfb\u53d6\u6821\u9a8c\u914d\u7f6e\u5931\u8d25\uff0c\u8bf7\u4fee\u590d\u540e\u91cd\u8bd5',
  noRepo: '\u5f53\u524d\u5de5\u4f5c\u533a\u6ca1\u6709 git \u4ed3\u5e93',
  enableFirst: '\u8bf7\u5148\u5f00\u542f\u6821\u9a8c',
  offMsg: 'AI \u6821\u9a8c\u5df2\u5173\u95ed\uff08\u94a9\u5b50\u4fdd\u7559\uff0c\u91cd\u65b0\u5f00\u542f\u5373\u6062\u590d\uff09',
  onMsg: 'AI \u6821\u9a8c\u5df2\u5f00\u542f\uff0c\u9608\u503c ',
  thrMsg: 'AI \u6821\u9a8c\u9608\u503c\u5df2\u8bbe\u4e3a ',
  inputTitle: 'AI \u4ee3\u7801\u5360\u6bd4\u9608\u503c (%)',
  inputPrompt: '\u63d0\u4ea4\u8981\u6c42 AI \u5360\u6bd4 \u2265 \u8be5\u503c\u624d\u653e\u884c\uff0c\u5141\u8bb8 50\u2013100 \u7684\u6574\u6570',
  inputErr: '\u8bf7\u8f93\u5165 50\u2013100 \u7684\u6574\u6570\uff08\u4e0d\u80fd\u4f4e\u4e8e 50\uff09',
  foreignHook: ' \u5df2\u5b58\u5728\u4e14\u4e0d\u5c5e\u4e8e\u672c\u63d2\u4ef6\uff0c\u8bf7\u5148\u624b\u52a8\u5904\u7406',
  importTip: '\u5927\u63d0\u4ea4\u6821\u9a8c\uff0810k\u201350k \u884c\u4e14 AI<5k \u62e6\u622a\uff09\uff1a',
  importOnC: '\u5f00',
  importOffC: '\u5173',
  importOnMsg: '\u5927\u63d0\u4ea4\u6821\u9a8c\u5df2\u5f00\u542f\uff08>1\u4e07\u884c\u4e14AI<5\u5343\u5c06\u62e6\u622a\uff09',
  importOffMsg: '\u5927\u63d0\u4ea4\u6821\u9a8c\u5df2\u5173\u95ed',
  toggleC: '\u5207\u6362',
  dot: ' \u00b7 ',
  dash: '\u00b7\u5927\u5173',
  name: 'AI-GIT\u6821\u9a8c'
};

function gitExtension(vscode) {
  return vscode.extensions?.getExtension('vscode.git');
}

function gitApi(vscode) {
  const extension = gitExtension(vscode);
  try { return extension?.isActive ? extension.exports.getAPI(1) : null; }
  catch { return null; } // Older/disabled Git integrations retain folder discovery.
}

const gitActivations = new WeakMap();
function activateGit(vscode) {
  const extension = gitExtension(vscode);
  if (!extension || extension.isActive) return null;
  if (gitActivations.has(vscode)) return gitActivations.get(vscode);
  const pending = Promise.resolve().then(() => extension.activate())
    .catch(e => { console.error('[guard] built-in Git activation failed:', e.message || e); })
    .finally(() => { gitActivations.delete(vscode); });
  gitActivations.set(vscode, pending);
  return pending;
}

// Git already discovers nested repositories. Reuse its window-scoped list
// rather than recursively scanning the workspace on each refresh.
function repositoryInputs(vscode) {
  const inputs = new Map();
  const add = (uri, required) => {
    if (!uri?.fsPath || (uri.scheme && uri.scheme !== 'file')) return;
    const folder = path.resolve(uri.fsPath);
    const previous = inputs.get(folder);
    inputs.set(folder, { folder, required: required || !!previous?.required });
  };
  for (const folder of vscode.workspace.workspaceFolders || []) add(folder.uri, false);
  for (const repo of gitApi(vscode)?.repositories || []) add(repo.rootUri, true);
  return [...inputs.values()];
}

function discoveryFailure(folder, required, error) {
  const detail = error.stderr?.toString().trim() || error.message || String(error);
  // Only a genuine non-repository workspace folder is safe to omit. A root
  // already known to Git must retain its failure (deleted, inaccessible, etc.).
  if (!required && (error.code === 128 || error.status === 128)
    && /not a git repository/i.test(detail)) return null;
  return { cwd: folder, error: `Git: ${detail}` };
}

function uniqueLocations(states) {
  const seen = new Set();
  return states.filter(state => {
    if (!state || seen.has(state.cwd)) return false;
    seen.add(state.cwd);
    return true;
  });
}

// Resolve roots with Git, preserving worktrees, submodules and hooksPath.
function locate({ folder, required }) {
  const options = { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C' } };
  try {
    const cwd = execFileSync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], options).trim();
    const hooks = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-path', 'hooks'], options).trim();
    return { cwd, hooks: path.resolve(cwd, hooks) };
  } catch (e) { return discoveryFailure(folder, required, e); }
}

function locateAll(vscode) {
  return uniqueLocations(repositoryInputs(vscode).map(locate));
}

function locationState(location) {
  if (location.error) throw new Error(location.error);
  return readState(location.hooks, location.cwd);
}

// Panel actions target one opened repository; commands without a target keep
// their existing workspace-wide behavior. Never accept an arbitrary disk path.
function realPath(folder) {
  try { return fs.realpathSync(folder); }
  catch { return path.resolve(folder); }
}

function actionLocations(vscode, cwd) {
  if (cwd === undefined) return locateAll(vscode);
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return [];
  const root = realPath(cwd);
  const inputs = repositoryInputs(vscode).filter(({ folder }) => {
    // Only the root itself or an opened module below it can authorize a
    // target. Git must still confirm that it is the module's actual root.
    const relative = path.relative(root, realPath(folder));
    return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
  });
  // Prefer an exact Git API root over additional modules in the same repo.
  inputs.sort((a, b) => Number(b.folder === cwd) - Number(a.folder === cwd));
  for (const input of inputs) {
    const location = locate(input);
    if (location && realPath(location.cwd) === root) return [location];
  }
  return [];
}

// Status bar and details share only an in-flight read, never a completed cache.
const guardQueries = new WeakMap();
function getGuardStates(vscode) {
  const inputs = repositoryInputs(vscode);
  const key = JSON.stringify(inputs);
  const current = guardQueries.get(vscode);
  if (current && current.key === key) return current.pending;
  const activation = activateGit(vscode);
  const query = activation
    ? activation.then(() => readGuardStates(repositoryInputs(vscode)))
    : readGuardStates(inputs);
  const pending = query.finally(() => {
    // An older workspace read must not remove a newer in-flight query.
    if (guardQueries.get(vscode)?.pending === pending) guardQueries.delete(vscode);
  });
  guardQueries.set(vscode, { key, pending });
  return pending;
}

// Resolve all three paths asynchronously in one command per candidate.
async function readGuardStates(inputs) {
  const states = await Promise.all(inputs.map(async ({ folder, required }) => {
    const result = await new Promise(resolve => execFile('git', ['-C', folder, 'rev-parse',
      '--show-toplevel', '--git-path', 'hooks', '--git-common-dir'],
    { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' } },
    (error, stdout) => resolve({ error, stdout })));
    if (result.error) return discoveryFailure(folder, required, result.error);
    const [cwd, hooks, common] = result.stdout.trimEnd().split(/\r?\n/);
    const l = { cwd, hooks: path.resolve(folder, hooks) };
    try { return { ...l, ...readState(l.hooks, cwd, path.resolve(folder, common)) }; }
    catch (e) { return { ...l, error: e.message }; }
  }));
  return uniqueLocations(states);
}

function managedEntry(src) {
  const normalize = s => s.replace(/\r\n/g, '\n').trimEnd();
  return normalize(src) === normalize(fs.readFileSync(path.join(__dirname, 'hooks', ENTRY), 'utf8'));
}

function managedScript(src) {
  if (!src.split(/\r?\n/).includes(SCRIPT_OWNER)) return false;
  if (/^\/\/ guard-v\d+:/m.test(src)) return true;
  const normalized = src.replace(/\r\n/g, '\n').trimEnd()
    .replace(/^(const MIN_AI_RATIO = parseFloat\(process\.env\.AI_RATIO_MIN \|\| ')[\d.]+('\);)$/m,
      '$1__AI_RATIO__$2');
  return LEGACY_SCRIPT_HASHES.has(require('crypto').createHash('sha256').update(normalized).digest('hex'));
}

function commonDir(hooks, cwd) {
  // The optional cwd is required for custom hooksPath. The shorthand supports
  // the default .git/hooks layout used by standalone callers/tests.
  if (!cwd) return path.dirname(hooks);
  const dir = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return path.resolve(cwd, dir);
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function entryReady(hooks) {
  try {
    const entry = path.join(hooks, ENTRY);
    const st = fs.statSync(entry);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(entry, fs.constants.X_OK);
    const src = fs.readFileSync(entry, 'utf8');
    // CRLF can still identify our hook, but must be rewritten to executable LF.
    return !src.includes('\r\n') && managedEntry(src);
  } catch { return false; }
}

function usesLegacySettings(src) {
  const tag = /^\/\/ guard-v(\d+):/m.exec(src);
  // Ownership is checked by callers; a recognised untagged template is legacy.
  return !tag || Number(tag[1]) < 9 || src.includes('__AI_RATIO__');
}

function readState(hooks, cwd, resolvedCommonDir) {
  let threshold = DEFAULT_PCT;
  let installed = false;
  let legacy = false;
  try {
    const src = fs.readFileSync(path.join(hooks, SCRIPT), 'utf8');
    installed = managedScript(src);
    legacy = installed && usesLegacySettings(src);
    const m = /AI_RATIO_MIN \|\| '([\d.]+)'\)/.exec(src);
    if (m) threshold = Math.round(parseFloat(m[1]) * 100);
  } catch { /* not installed */ }
  const dir = resolvedCommonDir || commonDir(hooks, cwd);
  const config = path.join(dir, SETTINGS);
  let settings;
  try { settings = JSON.parse(fs.readFileSync(config, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { e.message = `${config}: ${e.message}`; throw e; }
  }
  // Only an old checker (or a hand-copied placeholder) has legacy settings.
  // A v9+ dispatcher must never enable an unconfigured repository, even when
  // another repository points hooksPath at this repository's default hooks.
  const masterOn = settings ? settings.enabled : legacy && !fs.existsSync(path.join(hooks, MARKER));
  const importOn = settings ? settings.importOn : installed && !fs.existsSync(path.join(hooks, IMPORT_MARKER));
  return {
    installed,
    configured: !!settings || legacy,
    masterOn,
    enabled: installed && entryReady(hooks) && !!masterOn,
    threshold: settings && Number.isFinite(settings.threshold) ? settings.threshold : installed ? threshold : DEFAULT_PCT,
    importOn: !!importOn
  };
}

function writeHooks(hooks, pct, cwd, changes = {}) {
  const entry = path.join(hooks, ENTRY);
  // Trust boundary: never overwrite a pre-commit hook that is not ours.
  if (fs.existsSync(entry) && !managedEntry(fs.readFileSync(entry, 'utf8'))) {
    throw new Error(entry + T.foreignHook);
  }
  const script = path.join(hooks, SCRIPT);
  const existing = fs.existsSync(script) ? fs.readFileSync(script, 'utf8') : '';
  if (fs.existsSync(script) && !managedScript(existing)) {
    throw new Error(script + T.foreignHook);
  }
  const s = readState(hooks, cwd);
  const settings = Object.assign({ enabled: s.configured ? !!s.masterOn : !s.installed,
    threshold: pct, importOn: s.configured || s.installed ? s.importOn : true }, changes);
  fs.mkdirSync(hooks, { recursive: true });
  const tpl = f => fs.readFileSync(path.join(__dirname, 'hooks', f));
  // Target the constant line only (not any comment mention of the placeholder):
  // String.replace() swaps the FIRST occurrence, which was the comment when one
  // existed - leaving the real constant unfilled. A line-anchored regex cannot
  // miss.
  // Keep the old shared threshold as a frozen migration default. Per-repo
  // changes go only to SETTINGS, so later windows can still recover this value.
  const originalRatio = /AI_RATIO_MIN \|\| '([\d.]+)'\)/.exec(existing);
  const fallback = originalRatio ? originalRatio[1] : '0.50';
  const checker = tpl(SCRIPT).toString('utf8')
    .replace(/(AI_RATIO_MIN \|\| ')__AI_RATIO__('\))/, `$1${fallback}$2`);
  if (!fs.existsSync(script) || fs.readFileSync(script, 'utf8') !== checker) writeAtomic(script, checker);
  if (!fs.existsSync(entry) || !fs.readFileSync(entry).equals(tpl(ENTRY))) writeAtomic(entry, tpl(ENTRY));
  fs.chmodSync(entry, 0o755);
  writeAtomic(path.join(commonDir(hooks, cwd), SETTINGS), JSON.stringify(settings) + '\n');
}

// On activation: rewrite already-installed hooks whose embedded version tag
// lags the packaged template, so upgrading the extension upgrades the hooks
// too - no off/on toggling per repo. Migrates legacy thresholds/switches;
// foreign hooks are never touched.
function autoUpgrade(vscode) {
  // Snapshot before rewriting: multiple workspace repositories can share an old
  // dispatcher, and each must migrate its legacy values from that old version.
  const snapshots = locateAll(vscode).map(l => {
    try { return { l, src: fs.readFileSync(path.join(l.hooks, SCRIPT), 'utf8') }; }
    catch { return null; }
  }).filter(Boolean);
  for (const { l, src } of snapshots) {
    if (!managedScript(src)) continue;
    // Isolate configuration/read failures as well as writes to this repository.
    try {
      const config = path.join(commonDir(l.hooks, l.cwd), SETTINGS);
      if (src.includes(HOOK_TAG) && !src.includes('__AI_RATIO__') && entryReady(l.hooks)
        && fs.existsSync(config)) continue;
      // Repair an outdated/placeholder checker or a missing/non-executable entry.
      // writeHooks preserves repository switches and refuses foreign entries.
      const s = readState(l.hooks, l.cwd);
      const changes = {};
      // Before v9 custom hooks also stored settings beside the dispatcher.
      // Migrate the opened repo once; untouched repositories stay unconfigured.
      if (!fs.existsSync(config) && usesLegacySettings(src)) {
        const m = /AI_RATIO_MIN \|\| '([\d.]+)'\)/.exec(src);
        s.threshold = m ? Math.round(parseFloat(m[1]) * 100) : DEFAULT_PCT;
        changes.enabled = !fs.existsSync(path.join(l.hooks, MARKER));
        changes.importOn = !fs.existsSync(path.join(l.hooks, IMPORT_MARKER));
      }
      writeHooks(l.hooks, s.threshold, l.cwd, changes);
      console.log(`[guard] hook upgraded to ${HOOK_TAG} in ${l.cwd}`);
    } catch (e) { console.error(`[guard] hook upgrade failed in ${l.cwd}:`, e.message || e); }
  }
}

// Track only which repository the status item represents, not cached settings.
const displayedRepositories = new WeakMap();
function refresh(vscode, item, locations, targetOnly = false) {
  const locs = locations || locateAll(vscode);
  // A change to a secondary repository must not relabel the first one's item.
  if (targetOnly && displayedRepositories.get(item) !== locs[0]?.cwd) return;
  if (!locs.length) { renderState(vscode, item); return; }
  let s;
  try { s = { cwd: locs[0].cwd, ...locationState(locs[0]) }; }
  catch (e) { s = { cwd: locs[0].cwd, error: e.message }; }
  renderState(vscode, item, s);
}

function renderState(vscode, item, s) {
  displayedRepositories.set(item, s?.cwd);
  if (!s) { item.hide(); return; }
  if (s.error) {
    item.text = T.configError;
    item.tooltip = `${T.configErrorTip}\n${s.error}`;
    item.show();
    return;
  }
  if (s.enabled) {
    const importLine = `\n\n${T.importTip}${s.importOn ? T.importOnC : T.importOffC}${T.dot}[${T.toggleC}](command:aiLines.guardToggleImport)`;
    item.text = `$(shield) AI\u2265${s.threshold}%` + (s.importOn ? '' : T.dash);
    const tip = new vscode.MarkdownString(
      `**${T.onTip}${s.threshold}${T.onTipEnd}**\n\n${T.clickOff}[${T.setThr}](command:aiLines.guardSetThreshold)${importLine}`);
    tip.isTrusted = true; // command: links stay dead text without this
    item.tooltip = tip;
  } else {
    item.text = T.offText;
    const tip = new vscode.MarkdownString(`**${T.offTip}**\n\n${T.clickOn}`);
    tip.isTrusted = true;
    item.tooltip = tip;
  }
  item.show();
}

function toggle(vscode, item, cwd) {
  const locs = actionLocations(vscode, cwd);
  if (!locs.length) { vscode.window.showWarningMessage(T.noRepo); return; }
  try {
    const s = locationState(locs[0]);
    if (s.enabled) {
      for (const l of locs) writeHooks(l.hooks, locationState(l).threshold, l.cwd, { enabled: false });
      vscode.window.showInformationMessage(T.offMsg);
    } else {
      for (const l of locs) {
        writeHooks(l.hooks, locationState(l).threshold, l.cwd, { enabled: true });
      }
      vscode.window.showInformationMessage(T.onMsg + s.threshold + '%');
    }
  } catch (e) {
    vscode.window.showErrorMessage(String(e.message || e));
  }
  refresh(vscode, item, locs, cwd !== undefined);
}

function enableAll(vscode, item) {
  const locs = locateAll(vscode);
  if (!locs.length) { vscode.window.showWarningMessage(T.noRepo); return []; }
  const results = locs.map(l => {
    try {
      const s = locationState(l);
      if (s.enabled) return { cwd: l.cwd, status: 'alreadyEnabled' };
      writeHooks(l.hooks, s.threshold, l.cwd, { enabled: true });
      return { cwd: l.cwd, status: 'enabled' };
    } catch (e) {
      // Preserve conflicting hooks/configs, then continue with other repos.
      return { cwd: l.cwd, status: 'failed', error: String(e.message || e) };
    }
  });
  const failed = results.filter(r => r.status === 'failed').length;
  const message = `\u6279\u91cf\u5f00\u542f\u6821\u9a8c\uff1a\u5df2\u5f00\u542f ${results.length - failed}/${results.length} \u4e2a\u4ed3\u5e93\uff0c\u5931\u8d25 ${failed} \u4e2a`;
  if (failed) vscode.window.showWarningMessage(message);
  else vscode.window.showInformationMessage(message);
  refresh(vscode, item, locs);
  return results;
}

async function setThreshold(vscode, item, cwd) {
  let locs = actionLocations(vscode, cwd);
  if (!locs.length) { vscode.window.showWarningMessage(T.noRepo); return; }
  try {
    const cur = locationState(locs[0]);
    if (cwd !== undefined && !cur.installed) throw new Error(T.enableFirst);
    const v = await vscode.window.showInputBox({
      title: T.inputTitle,
      value: String(cur.threshold),
      prompt: T.inputPrompt,
      validateInput: t => {
        const n = Number(t);
        return /^\d+$/.test(t.trim()) && n >= 50 && n <= 100 ? null : T.inputErr;
      }
    });
    if (v === undefined) return;
    // The repository may have been removed while the input box was open.
    if (cwd !== undefined) locs = actionLocations(vscode, cwd);
    if (!locs.length) { vscode.window.showWarningMessage(T.noRepo); return; }
    if (cwd !== undefined && !locationState(locs[0]).installed) throw new Error(T.enableFirst);
    const pct = Number(v);
    for (const l of locs) {
      if (l.error) throw new Error(l.error);
      writeHooks(l.hooks, pct, l.cwd);
    }
    vscode.window.showInformationMessage(T.thrMsg + pct + '%');
  } catch (e) {
    vscode.window.showErrorMessage(String(e.message || e));
  }
  // The global input box can outlive a workspace switch. Keep its status
  // refresh tied to the current workspace, as before this optimization.
  refresh(vscode, item, cwd === undefined ? undefined : locs, cwd !== undefined);
}

function toggleImport(vscode, item, cwd) {
  const locs = actionLocations(vscode, cwd);
  if (!locs.length) { vscode.window.showWarningMessage(T.noRepo); return; }
  try {
    const s = locationState(locs[0]);
    if (cwd !== undefined && !s.installed) throw new Error(T.enableFirst);
    for (const l of locs) {
      writeHooks(l.hooks, locationState(l).threshold, l.cwd, { importOn: !s.importOn });
    }
    vscode.window.showInformationMessage(s.importOn ? T.importOffMsg : T.importOnMsg);
  } catch (e) {
    vscode.window.showErrorMessage(String(e.message || e));
  }
  refresh(vscode, item, locs, cwd !== undefined);
}

// Called from trae-ai-lines' activate(): owns the second status-bar item and
// the aiLines.guard* commands. Hook scripts themselves keep the original
// ownership markers so already-installed hooks are recognized, not clobbered.
function activateGuard(context, onChange = () => {}) {
  const vscode = require('vscode');
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9998);
  item.name = T.name;
  item.command = 'aiLines.guardToggle';
  let revision = 0;
  let disposed = false;
  const run = action => async cwd => {
    // Invalidate reads both before the command and after an awaited input box.
    revision++;
    try {
      const activation = activateGit(vscode);
      if (activation) await activation;
      if (disposed) return;
      return await action(vscode, item, cwd);
    }
    finally { revision++; if (!disposed) await onChange(); }
  };
  context.subscriptions.push(
    item,
    { dispose: () => { disposed = true; revision++; } },
    vscode.commands.registerCommand('aiLines.guardToggle', run(toggle)),
    vscode.commands.registerCommand('aiLines.guardEnableAll', run(enableAll)),
    vscode.commands.registerCommand('aiLines.guardSetThreshold', run(setThreshold)),
    vscode.commands.registerCommand('aiLines.guardToggleImport', run(toggleImport))
  );
  // Re-read shared repository settings without synchronous Git on each poll.
  const refreshAsync = async () => {
    if (disposed) return;
    const request = ++revision;
    const states = await getGuardStates(vscode);
    if (!disposed && request === revision) renderState(vscode, item, states[0]);
  };
  let changing;
  let changeAgain = false;
  const changed = () => {
    if (disposed) return Promise.resolve();
    revision++; // Immediately invalidate a query for an older repository list.
    changeAgain = true;
    if (changing) return changing;
    // Merge synchronous discovery events, then serialize later rounds. An
    // event during a query requests one follow-up with the newest repo list.
    const pending = Promise.resolve().then(async () => {
      while (changeAgain && !disposed) {
        changeAgain = false;
        await Promise.all([refreshAsync(), onChange()]);
      }
    }).catch(e => { console.error('[guard] repository refresh failed:', e.message || e); })
      .finally(() => {
        changing = undefined;
        // A queued event may arrive between the last loop and this cleanup.
        if (changeAgain && !disposed) return changed();
      });
    changing = pending;
    return pending;
  };
  const initialize = () => {
    if (disposed) return;
    try { autoUpgrade(vscode); } catch (e) { console.error('guard auto-upgrade failed:', e); }
    refresh(vscode, item);
    const api = gitApi(vscode);
    if (api?.onDidOpenRepository) context.subscriptions.push(api.onDidOpenRepository(changed));
    if (api?.onDidCloseRepository) context.subscriptions.push(api.onDidCloseRepository(changed));
    if (vscode.workspace.onDidChangeWorkspaceFolders) {
      context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(changed));
    }
  };
  const activation = activateGit(vscode);
  if (activation) activation.then(() => { initialize(); return changed(); })
    .catch(e => { console.error('[guard] Git initialization failed:', e.message || e); });
  else initialize();
  return refreshAsync;
}

// internals exported for test.js (the full-path regression suite); harmless
// for the extension host - activateGuard remains the only entry it calls.
module.exports = { activateGuard, autoUpgrade, readState, writeHooks, toggle, enableAll, setThreshold, toggleImport, getGuardStates };
