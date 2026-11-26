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
const COMMITTED_SOURCE = 'Trae 本地上报库';

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
    await counter.poll();
    const date = counter.day || localDate();
    const committed = counter.sums();
    const dataSource = committed ? COMMITTED_SOURCE : counter.lastRead?.invalid
      ? `${COMMITTED_SOURCE}数据不完整` : `${COMMITTED_SOURCE}不可用`;
    const remain = SPIN_MIN_MS - (Date.now() - t0);
    if (remain > 0) await new Promise(r => setTimeout(r, remain));
    const cwd = currentWorkspace();
    const pend = cwd ? await uncommitted(cwd) : null;
    // Git details remain available even when AI attribution cannot be queried.
    const diff = pend && pend.gitAdds != null
      ? { adds: pend.gitAdds, dels: pend.gitDels }
      : cwd ? await gitDiffStat(cwd) : null;
    item.text = committed ? `$(robot) AI ${committed.ai} / ${committed.total} \u884c` : '$(robot) AI -';
    item.tooltip = new vscode.MarkdownString(
      `**\u4eca\u65e5\u7edf\u8ba1\uff08${date}\uff09**\n\n` +
      (committed
        ? `AI Commit：${committed.ai} 行，\n总Commit：${committed.total} 行，\n提交数：${committed.commits}\n\n`
        : '今日提交：暂不可用\n\n') +
      (pend
        ? `\u672a\u63d0\u4ea4\uff1aAI ${pend.ai} \u884c\uff0c\u603b ${pend.total} \u884c\n`
        : `\u672a\u63d0\u4ea4\uff1a-\n`) +
      (diff ? `\u3000\u3000git diff\uff1a+${diff.adds} / -${diff.dels} \u884c\n` : '') +
      `\n提交数据源：${dataSource}，自动每 ${REFRESH_MS / 1000}s 刷新` +
      '\n\n[\u5c55\u5f00\u8be6\u60c5](command:aiLines.showDetails)'
    );
    item.tooltip.isTrusted = { enabledCommands: ['aiLines.showDetails'] };
    snapshot = { date, committed, pending: pend, diff,
      workspace: cwd || null, updatedAt: new Date().toISOString(), manual: !!manual, dataSource };
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
  const rt = path.join(os.homedir(), '.trae-cn', '.git-ai-tob', 'tob-git-ai-runtime');
  p(fs.existsSync(rt), `git-ai \u8fd0\u884c\u65f6\u76ee\u5f55 ${rt}`);
  if (fs.existsSync(rt)) {
    const vs = fs.readdirSync(rt).filter(v => /^\d+\.\d+\.\d+$/.test(v));
    ch.appendLine(`       \u7248\u672c\u76ee\u5f55: ${vs.join(', ') || '\u65e0'}`);
  }
  const committed = new AiLinesCounter({ appRoot: vscode.env?.appRoot });
  await committed.poll();
  const stats = committed.sums();
  const report = committed.lastRead;
  ch.appendLine(`--- 已提交统计（按入库日期 ${committed.day || localDate()}） ---`);
  p(!!stats, `${COMMITTED_SOURCE} ${committed.root || ''}`);
  for (const file of report?.files || []) p(true, `已读取 ${file}`);
  for (const error of report?.errors || []) p(false, `${error.file} ${error.message}`);
  if (report?.invalid) p(false, `无法解析 ${report.invalid} 条提交归因记录`);
  ch.appendLine(`       今日汇总：${stats ? JSON.stringify(stats) : '不可用'}`);
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  ch.appendLine(`       \u5de5\u4f5c\u533a: ${cwd || '\u672a\u6253\u5f00'}`);
  if (cwd) {
    const r = await uncommitted(cwd);
    ch.appendLine(`       \u672a\u63d0\u4ea4\u67e5\u8be2: ${r ? `\u6210\u529f ${JSON.stringify(r)}` : '\u5931\u8d25\uff08\u4e8c\u8fdb\u5236\u672a\u627e\u5230/\u975e git \u4ed3\u5e93/\u8d85\u65f6\uff09'}`);
  }
}

function activate(context) {
  counter = new AiLinesCounter({ appRoot: vscode.env?.appRoot });
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
