#!/usr/bin/env bash
# ============================================================================
# diagnose-ai-guard.sh —— AI 占比拦截钩子（pre-commit）自检脚本
#
# 作用：当"设置了阈值但提交没被拦截"时，逐项检查钩子的每个"静默放行"缺口。
#       结果只有【通过 / 不通过】两种；不通过时按点列出【原因】与【怎么修】。
#
# 用法：在出问题的 git 仓库里执行（脚本放哪都行）：
#   bash diagnose-ai-guard.sh          # 只检查，不校验具体阈值
#   bash diagnose-ai-guard.sh 98       # 额外断言有效阈值为 98%
#
# 平台：macOS / Linux 直接用 bash 运行；
#       Windows 请在【Git Bash】里运行（cmd.exe / PowerShell 不支持 bash 脚本）。
#
# 退出码：全通过 = 0；有任一项失败 = 1
# ============================================================================
# 若被 sh/dash/zsh 运行（如 `sh diagnose-ai-guard.sh`），POSIX shell 不支持
# process substitution（`< <(...)`）会语法崩溃。能力探测：subshell 里试一次，
# 失败则切 bash 重执行自身（subshell 吞掉语法错误，dash 下也安全）。
if ! (eval 'read _ < <(echo ok)' 2>/dev/null); then
  exec bash "$0" "$@"
fi
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$ROOT" ]; then
  echo "自检结果: 不通过"
  echo "  [FAIL] 当前目录不是 git 仓库"
  echo "  [修复] cd 到出问题的 git 仓库根目录后再运行本脚本"
  exit 1
fi
cd "$ROOT" || exit 1

EXPECT_PCT="${1:-}"          # 期望阈值（百分数），可选
if [ -n "$EXPECT_PCT" ] && ! printf '%s' "$EXPECT_PCT" | grep -qE '^[0-9]+$'; then
  echo "参数错误：期望阈值应为 50-100 的整数，收到 \"$EXPECT_PCT\""
  exit 2
fi
# git 实际读取的 hooks 目录：--git-path 会自动适配 worktree 与 core.hooksPath，
# 比手写 .git/hooks 更权威（worktree 下是公共仓 .git/hooks，而非 <gitdir>/hooks）。
HOOKS="$(git rev-parse --git-path hooks 2>/dev/null)"
case "$HOOKS" in
  "")  HOOKS="$ROOT/.git/hooks" ;;
  /*)  : ;;
  *)   HOOKS="$ROOT/$HOOKS" ;;
esac
# 本插件 guard.js 的安装位置（普通仓=.git/hooks；worktree=<gitdir>/hooks），用于"装错位置"分歧检测。
PLUGIN_HOOKS="$ROOT/.git/hooks"
if [ -f "$ROOT/.git" ]; then                                  # worktree / submodule
  GD="$(sed -n 's/^gitdir:[[:space:]]*//p' "$ROOT/.git" | tr -d '\r')"
  [ -n "$GD" ] && PLUGIN_HOOKS="$GD/hooks"
fi
TOB_HOME="$HOME/.trae-cn/.git-ai-tob"
RUNTIME_ROOT="$TOB_HOME/tob-git-ai-runtime"
SCRIPT="$HOOKS/check-ai-ratio.js"

have() { command -v "$1" >/dev/null 2>&1; }
PY=""; have python3 && PY=python3 || { have python && PY=python; }

# 把路径转成 node(原生程序) 能识别的形式：Windows/Git Bash 下用 cygpath -w，其它平台原样。
winpath() { if have cygpath; then cygpath -w "$1"; else printf '%s' "$1"; fi; }

# 进程存活探测：与 hook 的 process.kill(pid,0) 等价。
# Windows(Git Bash/MSYS) 的 kill 对原生 PID 不可靠，故用 tasklist 兜底；ps 作最后兜底。
alive() {
  _ap="$1"
  kill -0 "$_ap" 2>/dev/null && return 0
  if have tasklist; then
    tasklist //FI "PID eq $_ap" //NH 2>/dev/null | grep -qw "$_ap" && return 0
  fi
  ps -p "$_ap" >/dev/null 2>&1 && return 0
  return 1
}

NFILE="$(mktemp 2>/dev/null || echo "/tmp/dg.$$.fails")"
: > "$NFILE"

n_pass=0; n_fail=0
pass() { printf '  [PASS] %s\n' "$1"; n_pass=$((n_pass+1)); }
# $1=原因(点)  $2=修复
fail() { printf '  [FAIL] %s\n' "$1"; n_fail=$((n_fail+1)); printf '%s\n' "  • 原因：$1
    修复：$2" >> "$NFILE"; }
# 供各检查内部调用：渲染一条带原因的失败
failwith() { fail "$1" "$2"; }

echo "============================================================"
echo " AI 占比拦截钩子自检 —— $ROOT"
echo "============================================================"

# ---- 1. 钩子是否安装且属于本插件 ----------------------------------------
echo "[1] 钩子安装"
if [ -f "$HOOKS/pre-commit" ] && [ -f "$SCRIPT" ]; then
  pass "pre-commit 与 check-ai-ratio.js 文件存在（入口内容在下一项核验）"
elif [ "$PLUGIN_HOOKS" != "$HOOKS" ] && [ -f "$PLUGIN_HOOKS/pre-commit" ] && grep -q 'ai-ratio-guard' "$PLUGIN_HOOKS/pre-commit"; then
  failwith "钩子装在了 ${PLUGIN_HOOKS}，但 git 实际读取 ${HOOKS}（worktree / core.hooksPath 场景）→ 钩子不会执行，等于没拦截" \
           "把钩子安装到 git rev-parse --git-path hooks 指向的目录；或避免在该 worktree 中提交"
elif [ -f "$HOOKS/pre-commit" ]; then
  failwith "pre-commit 存在但缺少 check-ai-ratio.js（钩子不完整，commit 会报错或跳过）" \
           "打开 Trae 点状态栏 'AI-GIT校验' 重新开启以重装钩子"
else
  failwith "钩子目录 $HOOKS 下不存在 pre-commit —— 钩子根本没装，commit 不会有任何拦截" \
           "打开 Trae（本插件须激活）点状态栏 'AI-GIT校验' 开启；或在本插件仓库执行安装"
fi

# ---- 2. 总开关 / 旁路 ----------------------------------------------------
# Keep this reader identical in both standalone diagnostic scripts.
# v9+ reads common-dir settings; older hooks still use their adjacent markers.
echo "[2] 总开关与旁路"
STATE=""; STATE_OK=0
if have node; then
  STATE="$(node - "$(winpath "$SCRIPT")" <<'JS'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
try {
  const src = fs.readFileSync(process.argv[2], 'utf8');
  const hooks = path.dirname(process.argv[2]);
  const tag = /^\/\/ guard-v(\d+):/m.exec(src);
  const perRepo = tag && Number(tag[1]) >= 9;
  let settings;
  if (perRepo) {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
    try { settings = JSON.parse(fs.readFileSync(path.join(path.resolve(common), 'ai-ratio-guard.json'), 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  let enabled = perRepo ? !!(settings && settings.enabled) : !fs.existsSync(path.join(hooks, '.ai-ratio-off'));
  const importOn = perRepo ? !!(settings && settings.importOn) : !fs.existsSync(path.join(hooks, '.ai-ratio-import-off'));
  if (process.env.AI_RATIO_OFF) enabled = false;
  const baked = /AI_RATIO_MIN\s*\|\|\s*['"]([^'"]+)['"]/.exec(src);
  let ratio = parseFloat(process.env.AI_RATIO_MIN || (baked && baked[1]));
  let source = process.env.AI_RATIO_MIN ? 'AI_RATIO_MIN 环境变量' : '钩子默认值';
  if (!Number.isFinite(ratio) || ratio <= 0) { ratio = 0.5; source = '无效阈值回退 50%'; }
  // Match the hook: environment overrides repo settings, then the baked default.
  if (settings && !process.env.AI_RATIO_MIN && Number.isFinite(settings.threshold)) {
    ratio = settings.threshold / 100;
    source = '仓库配置';
  }
  const pct = Number((ratio * 100).toPrecision(12));
  let entryReady = false;
  let entryMatches = false;
  let entryLf = false;
  try {
    const entry = path.join(hooks, 'pre-commit');
    if (fs.statSync(entry).isFile()) {
      // Standalone copy of hooks/pre-commit; normalization matches guard.js.
      const expectedEntry = "#!/bin/sh\n# managed by ai-ratio-guard\nnode \"$(dirname \"$0\")/check-ai-ratio.js\"\n";
      const normalize = s => s.replace(/\r\n/g, '\n').trimEnd();
      const entrySrc = fs.readFileSync(entry, 'utf8');
      entryMatches = normalize(entrySrc) === normalize(expectedEntry);
      entryLf = !entrySrc.includes('\r\n');
      if (process.platform !== 'win32') fs.accessSync(entry, fs.constants.X_OK);
      entryReady = true;
    }
  } catch { /* missing or not executable by the current user */ }
  console.log([enabled ? 'on' : 'off', importOn ? 'on' : 'off', pct, source, entryReady ? 'on' : 'off', entryMatches ? 'on' : 'off', entryLf ? 'on' : 'off'].join('|'));
} catch (e) { console.error(e.message); process.exitCode = 1; }
JS
)" && STATE_OK=1
else
  echo "  系统 PATH 中没有 node，无法读取有效配置"
fi
if [ "$STATE_OK" -eq 1 ]; then
  IFS='|' read -r MASTER_ON IMPORT_ON THR_PCT THR_SOURCE ENTRY_READY ENTRY_MATCHES ENTRY_LF <<< "$STATE"
  if [ "$ENTRY_READY" = off ]; then
    failwith "pre-commit 缺失或当前用户没有执行权限，Git 不会运行校验" \
             "在 Trae 重新开启校验以修复钩子；macOS/Linux 可检查 pre-commit 的执行权限"
  elif [ "$ENTRY_MATCHES" != on ]; then
    failwith "pre-commit 入口内容与插件模板不一致，无法确认会执行占比校验" \
             "先备份并检查现有入口；确认不再需要自定义逻辑后，再恢复插件入口"
  elif [ "$ENTRY_LF" != on ]; then
    failwith "pre-commit 使用 CRLF 换行，入口需要转换为 LF" \
             "升级插件并重启 Trae，插件会修复自己管理的入口并保留仓库设置"
  fi
  if [ "$MASTER_ON" = off ]; then
    failwith "有效总开关关闭（仓库未启用或 AI_RATIO_OFF 环境变量旁路）—— 提交会被直接放行" \
             "需要校验时在 Trae 开启 AI-GIT，并取消 AI_RATIO_OFF；旧版钩子另检查 .ai-ratio-off"
  elif [ "$IMPORT_ON" = off ]; then
    pass "总开关开启（仅大提交校验关闭，不影响规则1）"
  else
    pass "总开关开启，规则1/2 均启用"
  fi
else
  failwith "无法读取有效配置（见上方错误），不能确定开关和阈值" \
           "检查 node、钩子文件及 git rev-parse --git-common-dir 下的 ai-ratio-guard.json"
fi

# ---- 3. 实际生效阈值 ----------------------------------------------------
echo "[3] 有效阈值"
if [ "$STATE_OK" -eq 1 ]; then
  if [ -n "$EXPECT_PCT" ] && ! awk -v actual="$THR_PCT" -v expected="$EXPECT_PCT" 'BEGIN { exit !(actual == expected) }'; then
    failwith "有效阈值 = ${THR_PCT}%（来源：${THR_SOURCE}），但期望 ${EXPECT_PCT}%" \
             "检查 AI_RATIO_MIN 环境变量；在 Trae 中调整仓库阈值"
  else
    pass "有效阈值 = ${THR_PCT}%（来源：${THR_SOURCE}）"
  fi
else
  echo "  有效配置读取失败，跳过阈值断言"
fi

# ---- 4. git-ai 运行时二进制 ---------------------------------------------
echo "[4] git-ai 运行时"
FOUND_BIN=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) RUNTIME_EXE=git-ai.exe ;;
  *) RUNTIME_EXE=git-ai ;;
esac
if [ -d "$RUNTIME_ROOT" ]; then
  for v in $(ls "$RUNTIME_ROOT" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
    for plat in "$RUNTIME_ROOT/$v"/*; do
      candidate="$plat/host/$RUNTIME_EXE"
      if [ -f "$candidate" ] && [ -x "$candidate" ]; then FOUND_BIN="$candidate"; break 2; fi
    done
  done
fi
if [ -n "$FOUND_BIN" ]; then
  pass "找到 $FOUND_BIN"
else
  failwith "未找到 git-ai 可执行文件（$RUNTIME_ROOT/*/*/host/$RUNTIME_EXE）—— 规则1 fail-open" \
           "确认已安装本插件并打开过 Trae（runtime 由插件释放）；必要时重装插件"
fi

# ---- 5. daemon 存活 ------------------------------------------------------
echo "[5] daemon 存活"
# 与钩子 daemonEnv 一致：显式 home 优先，否则查租户目录和无租户根目录。
ALIVE_PID=""; SEEN_PID=""; SEEN_N=0
DAEMON_HOMES=()
if [ -n "${GIT_AI_DAEMON_HOME:-}" ]; then
  DAEMON_HOMES=("$GIT_AI_DAEMON_HOME")
else
  for d in "$TOB_HOME"/*; do
    [ -d "$d" ] && DAEMON_HOMES+=("$d")
  done
  DAEMON_HOMES+=("$TOB_HOME")
fi
for daemon_home in "${DAEMON_HOMES[@]}"; do
  f="$daemon_home/internal/daemon/daemon.pid.json"
  [ -e "$f" ] || continue
  if [ -n "$PY" ]; then
    p="$("$PY" -c "import json,sys;print(json.load(open(sys.argv[1])).get('pid',''))" "$f" 2>/dev/null)"
  else
    p="$(sed -n 's/.*"pid"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$f" 2>/dev/null | head -1)"
  fi
  [ -n "$p" ] || continue
  SEEN_N=$((SEEN_N+1)); SEEN_PID="$p"
  if alive "$p"; then ALIVE_PID="$p"; break; fi
done
if [ -n "$ALIVE_PID" ]; then
  pass "daemon 存活（pid=${ALIVE_PID}）"
elif [ "$SEEN_N" -gt 0 ]; then
  failwith "tob daemon 未存活（发现 $SEEN_N 个 pid 记录，如 pid=${SEEN_PID}，均无对应进程）—— 规则1 fail-open" \
           "打开 Trae 让插件拉起 daemon 后再提交；纯终端提交前先确认 Trae 在运行"
else
  failwith "tob daemon 未存活（未找到 daemon.pid.json）—— 规则1 fail-open" \
           "打开 Trae 让插件拉起 daemon 后再提交；纯终端提交前先确认 Trae 在运行"
fi

# ---- 6. 暂存分母是否被 .git-ai-ignore 清零 -------------------------------
# Keep this NUL-delimited reader identical in both standalone scripts.
echo "[6] 暂存分母"
rawTotal=0; ignAdds=0; fileN=0; DIFF_OK=0
if have node; then
  DIFF_STATE="$(node - <<'DIFF_JS'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const git = args => execFileSync('git', args, {
  encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
});
try {
  const records = git(['-c', 'diff.relative=false', 'diff', '--cached', '--numstat', '-z']).split('\0');
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!m) continue;
    let name = m[3];
    if (!name) { i++; name = records[++i]; } // rename: old path, then new path
    files.push({ adds: m[1] === '-' ? 0 : Number(m[1]), path: name });
  }
  const raw = files.reduce((sum, f) => sum + f.adds, 0);
  let ignored = 0;
  const ignoreFile = path.resolve('.git-ai-ignore');
  if (files.length && fs.existsSync(ignoreFile)) {
    try {
      // Match the real hook: ONLY .git-ai-ignore, never .gitignore/info/exclude.
      const names = new Set(git(['ls-files', '--cached', '--ignored', '--full-name',
        `--exclude-from=${ignoreFile}`, '-z']).split('\0').filter(Boolean));
      ignored = files.filter(f => names.has(f.path)).reduce((sum, f) => sum + f.adds, 0);
    } catch { console.error('忽略规则查询失败，与钩子一致使用全部暂存新增行作为分母'); }
  }
  console.log([raw, ignored, files.length].join('|'));
} catch (e) { console.error(e.message); process.exitCode = 1; }
DIFF_JS
)" && DIFF_OK=1
fi
if [ "$DIFF_OK" -eq 1 ]; then
  IFS='|' read -r rawTotal ignAdds fileN <<< "$DIFF_STATE"
fi
visible=$((rawTotal-ignAdds))

if [ "$DIFF_OK" -ne 1 ]; then
  failwith "无法读取暂存分母，不能判断忽略规则" "检查 node 是否可用，以及 git diff --cached 是否能正常执行"
elif [ "$fileN" -eq 0 ]; then
  pass "当前无暂存改动（无法验证分母，属正常）"
elif [ "$rawTotal" -eq 0 ]; then
  pass "本提交无新增行（仅删除/重命名/二进制），规则1不适用"
elif [ "$visible" -eq 0 ]; then
  pass "暂存新增行均由 .git-ai-ignore 排除（$rawTotal 行全部被忽略），不适用占比校验"
else
  pass "暂存 $fileN 个文件：新增 $rawTotal 行，其中被忽略 $ignAdds 行 → 分母 $visible 行"
fi

# ---- 7. 重放钩子，看是否真的在判定 --------------------------------------
echo "[7] 钩子实际判定（重放）"
if [ -f "$SCRIPT" ]; then
  if ! have node; then
    failwith "系统 PATH 中没有 node —— pre-commit 依赖 node 运行，钩子会直接报错/跳过" \
             "安装 Node.js 并确保 node 在 PATH（本插件运行环境已含 Node，建议用 Trae 内置终端）"
  else
  # GIT_AI_CWD/脚本路径转成 node 可用的原生路径（Windows 下必须），否则 hook 内 git 会失败。
  OUT="$(GIT_AI_CWD="$(winpath "$ROOT")" node "$(winpath "$SCRIPT")" 2>&1)"; CODE=$?
  echo "      —— 钩子输出 ——"
  printf '%s\n' "$OUT" | sed 's/^/      /'
  echo "      退出码=$CODE （0=放行/跳过；非零需结合拦截信息或错误判断）"
  if [ "$DIFF_OK" -ne 1 ]; then
    failwith "暂存分母读取失败，无法验证钩子判定" "先解决 [6] 的读取错误"
  elif [ "$CODE" -ne 0 ]; then
    if [ "$CODE" -eq 1 ] && printf '%s\n' "$OUT" | grep -qE '^\[ai-ratio\] BLOCKED: (ratio > 100%|ratio < [0-9.]+% threshold|bulk commit [0-9]+ lines with only [0-9]+ AI lines \(import guard\))$'; then
      pass "钩子正常执行，并按校验规则拦截提交"
    else
      failwith "校验脚本运行失败（退出码 ${CODE}），不是正常放行或规则拦截" \
               "查看上方错误，检查 Node.js 环境和 check-ai-ratio.js 是否损坏"
    fi
  elif printf '%s\n' "$OUT" | grep -qE '^\[ai-ratio\] git (diff failed, skip check|directory unavailable, skip)$'; then
    failwith "钩子未能读取 Git 数据，跳过了校验" "检查上方钩子输出和 Git 仓库状态后重试"
  elif printf '%s\n' "$OUT" | grep -qF '[ai-ratio] disabled, skip'; then
    failwith "钩子重放时校验已关闭" "检查仓库开关或 AI_RATIO_OFF 后重试"
  elif [ "$rawTotal" -eq 0 ]; then
    pass "无新增行，钩子直接放行属正常"
  elif [ "$visible" -eq 0 ]; then
    pass "无参与占比校验的新增行，钩子放行属正常"
  # 判定行形如 "…, ratio 0.0%"，用 "ratio 空格 数字" 精确匹配；
  # 否则离线提示 "AI-ratio check skipped" 里的 "ratio check" 会被误当成已判定。
  elif printf '%s' "$OUT" | grep -qE 'ratio [0-9]'; then
    pass "钩子确实在做占比判定（见上面 ratio 行）"
  else
    SKIPREASON="$(printf '%s' "$OUT" | grep -oE 'daemon offline|attribution query failed|import guard' | head -1)"
    FIX="按上面失败的检查项（[2]总开关 / [4]runtime / [5]daemon / [6]分母）逐项修复后重试"
    if [ "$SKIPREASON" = 'attribution query failed' ]; then
      FIX="打开 Trae 的 Git AI 页面，点击「重新检查」，再运行本脚本"
    fi
    failwith "有暂存改动，但钩子未做占比判定${SKIPREASON:+（跳过原因：${SKIPREASON}）} —— 本次提交未被拦截" \
             "$FIX"
  fi
  fi
else
  failwith "钩子脚本不存在，无法重放" "同 [1]：重新开启钩子"
fi

# ---- 结论 ----------------------------------------------------------------
echo "============================================================"
if [ "$n_fail" -eq 0 ]; then
  echo "自检结果: 通过（$n_pass 项全部通过）"
  echo "============================================================"
  cat <<'EOF'
若"非 AI 提交仍未被拦"，请对照 [7] 的 ratio 行进一步判断：
  * 原始 AI 占比超过 100% 时会拦截。请核对部分暂存和 .git-ai-ignore。
  * 完全无 ratio 行     → 多为绕过了钩子，检查是否用 git commit --no-verify。
EOF
  rm -f "$NFILE"; exit 0
else
  echo "自检结果: 不通过（$n_fail 项失败 / 共 $((n_pass+n_fail)) 项）"
  echo "============================================================"
  cat "$NFILE"
  echo
  echo '提示：本钩子语义是「要求 AI 占比 ≥ 阈值才放行」，设 98% 即拦所有低于 98% 的提交。'
  echo '     若你的预期恰好相反（AI 过高才拦），则工具方向不同，上述均为正常行为。'
  rm -f "$NFILE"; exit 1
fi
