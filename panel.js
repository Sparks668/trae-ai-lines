'use strict';

function panelHtml(data) {
  const nonce = require('crypto').randomBytes(18).toString('hex');
  // Paths and error messages may contain HTML. Serialize them only as data;
  // the page renders all dynamic values with textContent.
  const initialData = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Trae AI Lines · 详情</title>
<style nonce="${nonce}">
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--vscode-foreground, #d4d4d4); background: var(--vscode-editor-background, #1e1e1e); font-family: var(--vscode-font-family, sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1.6; }
main { max-width: 1040px; margin: 0 auto; padding: 28px 32px 22px; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
h1 { font-size: 22px; font-weight: 600; line-height: 1.3; margin: 0 0 5px; letter-spacing: -.4px; }
.muted, dt, .label { color: var(--vscode-descriptionForeground, #aaa); }
.subtitle { font-size: 12px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: inherit; padding: 5px 12px; border: 1px solid transparent; border-radius: 3px; cursor: pointer; color: var(--vscode-button-foreground, #fff); background: var(--vscode-button-background, #0e639c); white-space: nowrap; }
button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
button.secondary { background: var(--vscode-button-secondaryBackground, #3a3d41); color: var(--vscode-button-secondaryForeground, #fff); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
button:focus-visible { outline: 2px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
button:disabled { opacity: .6; cursor: wait; }
button[data-needs-install="true"]:disabled { cursor: not-allowed; }
section { border-top: 1px solid var(--vscode-panel-border, #454545); padding: 17px 0 19px; }
.section-head { display: flex; gap: 10px; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
h2 { font-size: 14px; font-weight: 600; margin: 0; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
.value { margin-top: 3px; font-size: 34px; font-weight: 600; line-height: 1.25; font-variant-numeric: tabular-nums; }
.unit { font-size: 12px; font-weight: 400; color: var(--vscode-descriptionForeground, #aaa); margin-left: 7px; }
.ai { color: var(--vscode-textLink-foreground, #75beff); }
.git { display: flex; flex-direction: column; justify-content: flex-end; gap: 4px; }
.git-value { font: 600 20px/1.5 var(--vscode-editor-font-family, monospace); font-variant-numeric: tabular-nums; }
.adds { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
.dels { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
.hint { font-size: 12px; margin: 12px 0 0; }
.error { border-left: 3px solid var(--vscode-inputValidation-errorBorder, #be1100); background: var(--vscode-inputValidation-errorBackground, #412b2b); padding: 9px 12px; margin: 0 0 18px; overflow-wrap: anywhere; }
.error[hidden], [hidden] { display: none; }
.guard + .guard { margin-top: 16px; padding-top: 14px; border-top: 1px dashed var(--vscode-panel-border, #454545); }
.repo { margin-bottom: 9px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; overflow-wrap: anywhere; }
.guard-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 16px; }
.setting { margin-top: 3px; font-weight: 600; }
.guard-actions { margin-top: 12px; }
.batch-result { margin: 12px 0; overflow-wrap: anywhere; }
dl { display: grid; grid-template-columns: 90px minmax(0, 1fr); margin: 0; gap: 8px 16px; }
dd { margin: 0; overflow-wrap: anywhere; }
.path { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
footer { border-top: 1px solid var(--vscode-panel-border, #454545); padding-top: 12px; font-size: 11px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
@media (max-width: 570px) { main { padding: 20px 18px; } header { flex-direction: column; } .value { font-size: 28px; } .metrics { gap: 10px; } .guard-grid { grid-template-columns: 1fr; } dl { grid-template-columns: 76px minmax(0, 1fr); gap: 8px; } }
</style></head><body><main>
<header><div><h1>Trae AI Lines</h1><div class="muted subtitle">统计详情 · <span id="date">—</span></div></div>
<div class="actions"><button id="refresh" type="button">立即刷新</button><button id="diagnose" class="secondary" type="button">运行诊断</button></div></header>
<div id="error" class="error" role="alert" hidden></div>
<section><div class="section-head"><h2>今日提交</h2><span class="muted subtitle">本机 Trae 日志汇总</span></div>
<div class="metrics"><div><div class="label">AI 提交行数</div><div class="value ai"><span id="committed-ai">—</span><span class="unit">行</span></div></div>
<div><div class="label">总提交行数</div><div class="value"><span id="committed-total">—</span><span class="unit">行</span></div></div>
<div><div class="label">提交次数</div><div class="value"><span id="commits">—</span><span class="unit">次</span></div></div></div></section>
<section><div class="section-head"><h2>未提交</h2><span id="pending-status" class="muted subtitle">读取中</span></div>
<div class="metrics"><div><div class="label">AI 行数</div><div class="value ai"><span id="pending-ai">—</span><span class="unit">行</span></div></div>
<div><div class="label">总行数</div><div class="value"><span id="pending-total">—</span><span class="unit">行</span></div></div>
<div class="git"><div class="label">git diff · 原始行数</div><div class="git-value"><span id="git-adds" class="adds">—</span> / <span id="git-dels" class="dels">—</span></div></div></div>
<p class="muted hint">总行数按 .git-ai-ignore 过滤；git diff 保留未过滤的新增 / 删除行数。</p></section>
<section><div class="section-head"><h2>提交校验</h2><span id="guard-summary" class="muted subtitle">正在读取校验状态…</span></div>
<div class="actions"><button id="guard-enable-all" type="button" data-guard-action="guardEnableAll" disabled>开启工作区全部仓库校验</button></div>
<div id="guard-batch-result" class="batch-result" role="status" hidden></div><div id="guards" class="guard-actions"></div>
<p class="muted hint">批量导入规则：暂存新增超过 10,000 且少于 50,000 行，AI 不足 5,000 行时拦截；此规则使用未过滤的暂存行数。</p></section>
<section><div class="section-head"><h2>数据与刷新</h2></div><dl>
<dt>统计工作区</dt><dd id="workspace" class="path">—</dd>
<dt>数据源</dt><dd>手动刷新优先读取 daemon 原生日志，无可用原生日志时回退镜像日志；自动刷新读取镜像日志。未提交 AI 数据来自 git-ai status。</dd>
<dt>刷新方式</dt><dd id="source">—</dd><dt>最近更新</dt><dd id="updated-at">尚未完成刷新</dd>
<dt>自动刷新</dt><dd>每 30 秒，与状态栏同步</dd></dl></section>
<footer class="muted"><span>固定详情页 · 可直接截图</span><span id="version"></span></footer>
</main><script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const text = (id, value) => { document.getElementById(id).textContent = value == null ? '—' : String(value); };
const el = (tag, className, value) => { const n = document.createElement(tag); n.className = className; if (value != null) n.textContent = String(value); return n; };
function loading(value) { const b = document.getElementById('refresh'); b.disabled = !!value; b.textContent = value ? '刷新中…' : '立即刷新'; b.setAttribute('aria-busy', String(!!value)); }
function diagnosing(value) { const b = document.getElementById('diagnose'); b.disabled = !!value; b.textContent = value ? '诊断中…' : '运行诊断'; b.setAttribute('aria-busy', String(!!value)); }
function changingGuard(value) { for (const b of document.querySelectorAll('[data-guard-action]')) { b.disabled = !!value || b.dataset.needsInstall === 'true' || b.dataset.unavailable === 'true'; b.setAttribute('aria-busy', String(!!value)); } }
function render(d) {
  text('date', d.date); text('version', 'v' + d.version);
  text('committed-ai', d.committed?.ai); text('committed-total', d.committed?.total); text('commits', d.committed?.commits);
  text('pending-ai', d.pending?.ai); text('pending-total', d.pending?.total);
  text('git-adds', d.diff ? '+' + d.diff.adds : null); text('git-dels', d.diff ? '-' + d.diff.dels : null);
  text('pending-status', d.pending ? '当前工作区' : !d.workspace ? '未打开工作区' : d.refreshing && !d.updatedAt ? '读取中' : 'AI 查询不可用');
  text('workspace', d.workspace || '未打开工作区');
  text('source', !d.updatedAt ? '待读取' : d.manual ? '手动刷新（原生日志优先）' : '自动刷新（镜像日志）');
  text('updated-at', d.updatedAt ? new Date(d.updatedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未完成刷新');
  const error = document.getElementById('error'); error.hidden = !d.error;
  error.textContent = d.error ? '刷新失败：' + d.error + (d.updatedAt ? '。当前保留上次成功的数据。' : '') : '';
  const repos = d.guards.filter(g => g.cwd);
  const failures = d.guards.filter(g => g.error).length;
  text('guard-summary', d.guardsLoading ? '正在读取校验状态…' : repos.length ? '已开启 ' + repos.filter(g => g.enabled).length + '/' + repos.length + ' 个仓库' + (failures ? '，' + failures + ' 项读取失败' : '') : failures ? '校验状态读取失败' : '暂无 Git 仓库');
  document.getElementById('guard-enable-all').dataset.unavailable = String(d.guardsLoading || !repos.length);
  const batch = document.getElementById('guard-batch-result'); batch.replaceChildren();
  batch.hidden = !d.guardBatchResult?.length;
  if (!batch.hidden) {
    const results = d.guardBatchResult;
    const added = results.filter(r => r.status === 'enabled').length;
    const existing = results.filter(r => r.status === 'alreadyEnabled').length;
    const failed = results.filter(r => r.status === 'failed').length;
    batch.append(el('div', 'setting', '上次批量开启：本次开启 ' + added + ' 个，原已开启 ' + existing + ' 个，失败 ' + failed + ' 个'));
    for (const r of results) batch.append(el('div', r.status === 'failed' ? 'error' : 'muted hint', (r.status === 'failed' ? '开启失败：' : r.status === 'alreadyEnabled' ? '原已开启：' : '已开启：') + r.cwd + (r.error ? ' · ' + r.error : '')));
  }
  const container = document.getElementById('guards'); container.replaceChildren();
  if (!d.guards.length) container.append(el('div', 'muted', d.guardsLoading ? '正在读取校验状态…' : '当前工作区没有可用的 Git 仓库'));
  for (const g of d.guards) {
    const section = el('div', 'guard'); section.append(el('div', 'repo', g.cwd || '工作区'));
    if (g.error) { section.append(el('div', 'error', '读取校验状态失败：' + g.error)); container.append(section); continue; }
    const grid = el('div', 'guard-grid');
    const state = !g.installed ? '未安装 / 未识别' : g.enabled ? '已开启' : g.masterOn ? '未生效（入口不可用）' : '已关闭';
    const bulk = !g.installed ? '未安装' : !g.importOn ? '已关闭' : g.enabled ? '已开启' : '已配置开启（总校验未生效）';
    const fields = [['AI 占比校验', state], ['占比阈值', g.configured ? g.threshold + '%' : '未配置'], ['批量导入校验', bulk]];
    for (const [label, value] of fields) { const cell = el('div', ''); cell.append(el('div', 'label', label), el('div', 'setting', value)); grid.append(cell); }
    const actions = el('div', 'actions guard-actions');
    for (const [type, label] of [['guardToggle', g.enabled ? '关闭校验' : '开启校验'], ['guardSetThreshold', '调整阈值'], ['guardToggleImport', g.importOn ? '关闭批量校验' : '开启批量校验']]) {
      const button = el('button', 'secondary', label); button.type = 'button'; button.dataset.guardAction = type;
      button.dataset.needsInstall = String(!g.installed && type !== 'guardToggle');
      if (button.dataset.needsInstall === 'true') button.title = '请先开启校验';
      button.addEventListener('click', () => { changingGuard(true); vscode.postMessage({ type, cwd: g.cwd }); });
      actions.append(button);
    }
    section.append(grid, actions); container.append(section);
  }
  changingGuard(d.guardBusy);
  loading(d.refreshing);
  diagnosing(d.diagnosing);
}
document.getElementById('refresh').addEventListener('click', () => { loading(true); vscode.postMessage({ type: 'refresh' }); });
document.getElementById('diagnose').addEventListener('click', () => { diagnosing(true); vscode.postMessage({ type: 'diagnose' }); });
document.getElementById('guard-enable-all').addEventListener('click', () => { changingGuard(true); vscode.postMessage({ type: 'guardEnableAll' }); });
window.addEventListener('message', event => { const m = event.data; if (m?.type === 'data') render(m.data); else if (m?.type === 'loading') loading(m.value); else if (m?.type === 'diagnosing') diagnosing(m.value); });
render(${initialData});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

function createDetailsPanel(vscode, { version, getSnapshot, getGuardStates, refresh, diagnose }) {
  let panel;
  let guards = null;
  let readingGuards;
  let readAgain = false;
  let guardBusy = false;
  let guardBatchResult = null;
  const data = () => ({ ...getSnapshot(), version, guards: guards || [], guardsLoading: guards === null, guardBusy, guardBatchResult });
  const post = () => { if (panel) panel.webview.postMessage({ type: 'data', data: data() }); };
  const update = () => {
    if (!panel) return Promise.resolve();
    const target = panel;
    if (readingGuards) readAgain = true;
    else {
      const pending = Promise.resolve().then(() => getGuardStates(vscode))
        .then(states => { if (panel === target) guards = states; })
        .catch(e => { if (panel === target) guards = [{ error: String(e.message || e) }]; })
        .finally(() => {
          if (readingGuards === pending) readingGuards = undefined;
          if (panel !== target) return;
          // Coalesce intervening refreshes, keeping workspace/settings changes.
          if (readAgain) { readAgain = false; return update(); }
          post();
        });
      readingGuards = pending;
    }
    // Statistics appear immediately, even when the guard-state query is slow.
    post();
    return readingGuards;
  };
  return {
    open() {
      if (panel) { panel.reveal(); update(); return; }
      const opened = vscode.window.createWebviewPanel('aiLines.details', 'Trae AI Lines · 详情',
        vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
      panel = opened;
      const messages = opened.webview.onDidReceiveMessage(async message => {
        if (panel !== opened) return;
        try {
          if (message?.type === 'ready') {
            if (guards === null) await (readingGuards || update());
            else post();
          }
          else if (message?.type === 'refresh') await refresh();
          else if (message?.type === 'diagnose') await diagnose();
          else if (['guardToggle', 'guardSetThreshold', 'guardToggleImport', 'guardEnableAll'].includes(message?.type)) {
            if (guardBusy) return;
            guardBusy = true;
            if (message.type === 'guardEnableAll') guardBatchResult = null;
            post();
            try {
              if (message.type === 'guardEnableAll') {
                guardBatchResult = await vscode.commands.executeCommand('aiLines.guardEnableAll');
              } else {
                if (typeof message.cwd !== 'string' || !guards?.some(g => g.cwd === message.cwd && !g.error)) {
                  throw new Error('仓库状态已不可用，请刷新后重试');
                }
                await vscode.commands.executeCommand('aiLines.' + message.type, message.cwd);
              }
            } finally {
              guardBusy = false;
              post();
            }
          }
        } catch (e) { vscode.window.showErrorMessage('Trae AI Lines：' + e.message); }
      });
      const closed = opened.onDidDispose(() => {
        if (panel === opened) { panel = undefined; guards = null; readingGuards = undefined; readAgain = false; }
        messages.dispose(); closed.dispose();
      });
      opened.webview.html = panelHtml(data());
    },
    update,
    // Publish the final loading state without repeating the repository query.
    updateSnapshot: post,
    setRefreshing(value) { if (panel) panel.webview.postMessage({ type: 'loading', value }); },
    setDiagnosing(value) { if (panel) panel.webview.postMessage({ type: 'diagnosing', value }); },
    dispose() { panel?.dispose(); }
  };
}

module.exports = { createDetailsPanel, panelHtml };
