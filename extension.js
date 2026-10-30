'use strict';
const vscode = require('vscode');
const { AiLinesCounter, localDate, uncommitted, gitDiffStat } = require('./lib');
const { activateGuard, getGuardStates } = require('./guard'); // merged from ai-ratio-guard 0.1.0
const { createDetailsPanel } = require('./panel');

const REFRESH_MS = 30000;
const SPIN_MIN_MS = 400; // spinner \u6700\u77ed\u5c55\u793a\u65f6\u957f, \u5237\u65b0\u592a\u5feb\u65f6\u4fdd\u8bc1\u52a8\u753b\u53ef\u89c1

let item;
let counter;
let details;
let snapshot;
let refreshError = null;
let refreshing = false;
let diagnosing = false;
let diagnosticOutput;
let refreshGuard;

function currentWorkspace() {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || null;
}

function getSnapshot() {
  const date = localDate();
  const workspace = currentWorkspace();
  const sameDay = snapshot?.date === date;
  const sameWorkspace = snapshot?.workspace === workspace;
  // Keep each value attached to its actual date/repository until refreshed.
  return { ...snapshot, date, workspace,
    committed: sameDay ? snapshot.committed : null,
    pending: sameWorkspace ? snapshot.pending : null,
    diff: sameWorkspace ? snapshot.diff : null,
    updatedAt: sameDay && sameWorkspace ? snapshot.updatedAt : null,
    error: refreshError, refreshing, diagnosing };
}

async function refresh(manual) {
  // \u5237\u65b0\u52a8\u753b: \u52a0\u8f7d\u4e2d spinner + \u5237\u65b0\u4e2d\u7981\u6b62\u91cd\u5165
  if (refreshing) return;
  refreshing = true;
  const prev = item.text;
  item.text = '$(loading~spin) \u5237\u65b0\u4e2d...';
  details?.setRefreshing(true);
  try {
    const t0 = Date.now();
    const date = localDate();
    await counter.poll(manual);
    const remain = SPIN_MIN_MS - (Date.now() - t0);
    if (remain > 0) await new Promise(r => setTimeout(r, remain));
    const { ai, total, commits } = counter.sums();
    const cwd = currentWorkspace();
    const pend = cwd ? await uncommitted(cwd) : null;
    // Git details remain available even when AI attribution cannot be queried.
    const diff = pend && pend.gitAdds != null
      ? { adds: pend.gitAdds, dels: pend.gitDels }
      : cwd ? await gitDiffStat(cwd) : null;
    item.text = `$(robot) AI ${ai} / ${total} \u884c`;
    item.tooltip = new vscode.MarkdownString(
      `**\u4eca\u65e5\u7edf\u8ba1\uff08${date}\uff09**\n\n` +
      `AI Commit\uff1a${ai} \u884c\uff0c\n` +
      `\u603bCommit\uff1a${total} \u884c\uff0c\n` +
      `\u63d0\u4ea4\u6570\uff1a${commits}\n\n` +
      (pend
        ? `\u672a\u63d0\u4ea4\uff1aAI ${pend.ai} \u884c\uff0c\u603b ${pend.total} \u884c\n`
        : `\u672a\u63d0\u4ea4\uff1a-\n`) +
      (diff ? `\u3000\u3000git diff\uff1a+${diff.adds} / -${diff.dels} \u884c\n` : '') +
      `\n\u6570\u636e\u6e90\uff1a\u70b9\u51fb\u5b9e\u65f6\u8bfb\u53d6 daemon \u539f\u751f\u65e5\u5fd7\uff0c\u81ea\u52a8\u6bcf ${REFRESH_MS / 1000}s \u5237\u65b0\u955c\u50cf\u65e5\u5fd7` +
      '\n\n[\u5c55\u5f00\u8be6\u60c5](command:aiLines.showDetails)'
    );
    item.tooltip.isTrusted = { enabledCommands: ['aiLines.showDetails'] };
    snapshot = { date, committed: { ai, total, commits }, pending: pend, diff,
      workspace: cwd || null, updatedAt: new Date().toISOString(), manual: !!manual };
    refreshError = null;
  } catch (e) {
    item.text = prev || '$(robot) AI -';
    item.tooltip = `\u8bfb\u53d6\u5931\u8d25\uff1a${e && e.message}`;
    refreshError = e && e.message;
  } finally {
    try {
      const guardUpdate = refreshGuard?.();
      // Subscribe together so the status bar and page share the same Git read.
      details?.update();
      await guardUpdate;
    }
    catch (e) { console.error('guard refresh failed:', e); }
    refreshing = false;
    details?.updateSnapshot();
    details?.setRefreshing(false);
  }
}

async function diagnose() {
  // Commands and the details page share one diagnostic run per window.
  if (diagnosing) return;
  diagnosing = true;
  try {
    details?.setDiagnosing(true);
    await runDiagnostics();
  } finally {
    diagnosing = false;
    details?.setDiagnosing(false);
  }
}

async function runDiagnostics() {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const ch = diagnosticOutput;
  ch.clear();
  ch.show();
  const p = (ok, msg) => ch.appendLine(`${ok ? '[OK]  ' : '[MISS]'} ${msg}`);
  const probe = f => {
    try { const b = fs.readFileSync(f); ch.appendLine(`       [OK] \u53ef\u8bfb\u53d6 (${b.length}B) ${f}`); }
    catch (e) { ch.appendLine(`       [MISS] \u8bfb\u53d6\u5931\u8d25: ${e.message} ${f}`); }
  };
  const logRoot = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Trae CN', 'logs')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Trae CN', 'logs');
  p(fs.existsSync(logRoot), `\u65e5\u5fd7\u76ee\u5f55 ${logRoot}`);
  const rt = path.join(os.homedir(), '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime');
  p(fs.existsSync(rt), `git-ai \u8fd0\u884c\u65f6\u76ee\u5f55 ${rt}`);
  if (fs.existsSync(rt)) {
    const vs = fs.readdirSync(rt).filter(v => /^\d+\.\d+\.\d+$/.test(v));
    ch.appendLine(`       \u7248\u672c\u76ee\u5f55: ${vs.join(', ') || '\u65e0'}`);
  }
  // committed-stats pipeline: per-tenant native log, actual filenames, read probe, both sources' sums
  ch.appendLine(`--- \u5df2\u63d0\u4ea4\u7edf\u8ba1\u94fe\u8def (\u4eca\u65e5 ${localDate()}) ---`);
  const intlLog = path.join(path.dirname(logRoot), 'Trae', 'logs');
  if (fs.existsSync(intlLog)) ch.appendLine(`       [\u6ce8\u610f] \u68c0\u6d4b\u5230\u56fd\u9645\u7248\u65e5\u5fd7\u76ee\u5f55 ${intlLog}`);
  const intlRt = path.join(os.homedir(), '.trae', '.git-ai-tob', 'tob-git-ai-runtime');
  if (fs.existsSync(intlRt)) ch.appendLine(`       [\u6ce8\u610f] \u68c0\u6d4b\u5230\u56fd\u9645\u7248 git-ai \u8fd0\u884c\u65f6 ${intlRt}`);
  const natRoot = path.join(os.homedir(), '.trae-cn', '.git-ai-tob');
  let natFile = null;
  if (fs.existsSync(natRoot)) {
    const want = `git-ai-daemon-${localDate()}.log`;
    for (const id of fs.readdirSync(natRoot)) {
      const d = path.join(natRoot, id, 'internal', 'daemon', 'logs');
      if (!fs.existsSync(d)) continue;
      const names = fs.readdirSync(d);
      p(names.includes(want), `native daemon \u65e5\u5fd7 (${id}): ${want}`);
      if (names.includes(want)) natFile = path.join(d, want);
      else if (names.length) ch.appendLine(`       \u76ee\u5f55\u5185\u5b9e\u9645\u6587\u4ef6: ${names.slice(0, 5).join(', ')}`);
    }
  } else {
    p(false, `native \u6839\u76ee\u5f55 ${natRoot}`);
  }
  if (natFile) probe(natFile);
  else ch.appendLine(`       \u672a\u53d1\u73b0\u4efb\u4f55\u4eca\u65e5 native daemon \u65e5\u5fd7`);
  if (fs.existsSync(logRoot)) {
    ch.appendLine(`       logs \u76ee\u5f55\u9876\u5c42: ${fs.readdirSync(logRoot).slice(0, 8).join(' | ') || '\u65e0'}`);
  }
  const cMir = new AiLinesCounter();
  const mir = cMir.listFiles(false);
  ch.appendLine(`       \u955c\u50cf\u65e5\u5fd7\u6587\u4ef6\u6570: ${mir.length}`);
  if (mir.length) probe(mir[0]);
  await cMir.poll(false);
  ch.appendLine(`       \u955c\u50cf\u6e90\u7edf\u8ba1: ${JSON.stringify(cMir.sums())}`);
  const cNat = new AiLinesCounter();
  await cNat.poll(true);
  ch.appendLine(`       native \u6e90\u7edf\u8ba1: ${JSON.stringify(cNat.sums())}`);
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  ch.appendLine(`       \u5de5\u4f5c\u533a: ${cwd || '\u672a\u6253\u5f00'}`);
  if (cwd) {
    const r = await uncommitted(cwd);
    ch.appendLine(`       \u672a\u63d0\u4ea4\u67e5\u8be2: ${r ? `\u6210\u529f ${JSON.stringify(r)}` : '\u5931\u8d25\uff08\u4e8c\u8fdb\u5236\u672a\u627e\u5230/\u975e git \u4ed3\u5e93/\u8d85\u65f6\uff09'}`);
  }
}

function activate(context) {
  counter = new AiLinesCounter();
  diagnosticOutput = vscode.window.createOutputChannel('Trae AI Lines');
  // ponytail: Right side, just left of Trae++ feedback button; raise priority if crowded
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 9999);
  item.name = 'Trae AI Lines';
  item.command = 'aiLines.refresh';
  item.show();

  const cmd = vscode.commands.registerCommand('aiLines.refresh', () => refresh(true));
  const dgn = vscode.commands.registerCommand('aiLines.diagnose', diagnose);
  details = createDetailsPanel(vscode, {
    version: context.extension?.packageJSON.version || require('./package.json').version,
    getSnapshot,
    getGuardStates, refresh: () => refresh(true), diagnose
  });
  const showDetails = vscode.commands.registerCommand('aiLines.showDetails', () => {
    if (!snapshot || snapshot.date !== localDate() || snapshot.workspace !== currentWorkspace()) refresh();
    details.open();
  });
  const timer = setInterval(refresh, REFRESH_MS);
  context.subscriptions.push(item, diagnosticOutput, cmd, dgn, showDetails, details, { dispose: () => clearInterval(timer) });
  // merged guard must never take down the line-counter if it fails to init
  try { refreshGuard = activateGuard(context, () => details?.update()); } catch (e) { console.error('guard init failed:', e); }
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
