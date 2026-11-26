#Requires -Version 5.1
<#
============================================================================
 diagnose-ai-guard.ps1 —— AI 占比拦截钩子（pre-commit）自检脚本（Windows 版）
 与 bash 版 scripts/diagnose-ai-guard.sh 逐项等价。

 作用：当"设置了阈值但提交没被拦截"时，逐项检查钩子的每个"静默放行"缺口。
       结果只有【通过 / 不通过】两种；不通过时按点列出【原因】与【怎么修】。

 用法（在出问题的 git 仓库里执行）：
   powershell -ExecutionPolicy Bypass -File diagnose-ai-guard.ps1
   powershell -ExecutionPolicy Bypass -File diagnose-ai-guard.ps1 -Threshold 98

 退出码：全通过 = 0；有任一项失败 = 1；参数错误 = 2
 说明：本文件须保持 UTF-8(带 BOM)，否则 Windows PowerShell 5.1 会把中文读成乱码。
============================================================================
#>
[CmdletBinding()]
param(
  # 期望阈值(百分数)，可选；0 表示不校验。合法范围 50-100。
  [int]$Threshold = 0
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

if ($Threshold -ne 0 -and ($Threshold -lt 50 -or $Threshold -gt 100)) {
  Write-Host "参数错误：-Threshold 应为 50-100 的整数，收到 $Threshold"
  exit 2
}

$script:nPass = 0
$script:nFail = 0
$fails = New-Object System.Collections.Generic.List[object]

function Pass([string]$msg) { Write-Host ("  [PASS] " + $msg); $script:nPass++ }
function Fail([string]$reason, [string]$fix) {
  Write-Host ("  [FAIL] " + $reason)
  $script:nFail++
  [void]$fails.Add([pscustomobject]@{ Reason = $reason; Fix = $fix })
}
function Say([string]$msg) { Write-Host ""; Write-Host $msg }

# ---- 定位仓库根 ----
# 注意：不可用 `... | Select-Object -First 1`——它会提前终止上游管道，
# 使 $LASTEXITCODE 变成 $null，而 $null -ne 0 恒为真，导致误判"不是 git 仓库"。
$root = $null
$code = 0
try {
  $lines = & git rev-parse --show-toplevel 2>$null
  $code = $LASTEXITCODE
  if ($lines) { $root = (@($lines)[0]).Trim() }
} catch { $root = $null }
if ([string]::IsNullOrWhiteSpace($root) -or $code -ne 0) {
  Write-Host "自检结果: 不通过"
  Write-Host "  [FAIL] 当前目录不是 git 仓库"
  Write-Host "  [修复] cd 到出问题的 git 仓库根目录后再运行本脚本"
  exit 1
}
$root = $root.Trim()
Set-Location -LiteralPath $root

# ---- 路径常量 ----
# git 实际读取的 hooks 目录：--git-path 自动适配 worktree 与 core.hooksPath。
$hooksRaw = $null
try { $hooksRaw = & git rev-parse --git-path hooks 2>$null } catch {}
$hooks = if ($hooksRaw) { (@($hooksRaw)[0]).Trim() } else { $null }
if ([string]::IsNullOrWhiteSpace($hooks)) { $hooks = Join-Path (Join-Path $root '.git') 'hooks' }
elseif (-not [IO.Path]::IsPathRooted($hooks)) { $hooks = Join-Path $root $hooks }

# 本插件 guard.js 的安装位置（普通仓=.git/hooks；worktree=<gitdir>/hooks），用于"装错位置"分歧检测。
$pluginHooks = Join-Path (Join-Path $root '.git') 'hooks'
$dotGit = Join-Path $root '.git'
if (Test-Path -LiteralPath $dotGit -PathType Leaf) {           # worktree / submodule
  $line = Get-Content -LiteralPath $dotGit -TotalCount 1
  if ($line -match '^gitdir:\s*(.+)$') { $pluginHooks = Join-Path $Matches[1].Trim() 'hooks' }
}
$scriptPath = Join-Path $hooks 'check-ai-ratio.js'
$preCommit = Join-Path $hooks 'pre-commit'
$ignoreFile = Join-Path $root '.git-ai-ignore'

$homeDir = if ($HOME) { $HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $env:HOME }
$tobHome = Join-Path (Join-Path $homeDir '.trae-cn') '.git-ai-tob'
$runtimeRoot = Join-Path $tobHome 'tob-git-ai-runtime'

Write-Host "============================================================"
Write-Host " AI 占比拦截钩子自检 —— $root"
Write-Host "============================================================"

# ---- 1. 钩子是否安装且属于本插件 ----
Say "[1] 钩子安装"
$hasPre = Test-Path -LiteralPath $preCommit -PathType Leaf
$hasScript = Test-Path -LiteralPath $scriptPath -PathType Leaf
if ($hasPre -and $hasScript) {
  Pass "pre-commit 与 check-ai-ratio.js 文件存在（入口内容在下一项核验）"
} elseif ($pluginHooks -ne $hooks -and
          (Test-Path -LiteralPath (Join-Path $pluginHooks 'pre-commit') -PathType Leaf) -and
          ((Get-Content -LiteralPath (Join-Path $pluginHooks 'pre-commit') -Raw) -match 'ai-ratio-guard')) {
  Fail "钩子装在了 $pluginHooks，但 git 实际读取 $hooks（worktree / core.hooksPath 场景）→ 钩子不会执行，等于没拦截" `
       "把钩子安装到 git rev-parse --git-path hooks 指向的目录；或避免在该 worktree 中提交"
} elseif ($hasPre) {
  Fail "pre-commit 存在但缺少 check-ai-ratio.js（钩子不完整，commit 会报错或跳过）" `
       "打开 Trae 点状态栏 'AI-GIT校验' 重新开启以重装钩子"
} else {
  Fail "钩子目录 $hooks 下不存在 pre-commit —— 钩子根本没装，commit 不会有任何拦截" `
       "打开 Trae（本插件须激活）点状态栏 'AI-GIT校验' 开启；或在本插件仓库执行安装"
}

# ---- 2. 总开关 / 旁路 ----
# Keep this reader identical in both standalone diagnostic scripts.
# v9+ reads common-dir settings; older hooks still use their adjacent markers.
Say "[2] 总开关与旁路"
$stateReader = @'
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
'@
$stateOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  # Pipe source as UTF-8: Windows PowerShell 5.1 otherwise uses ASCII and
  # passing JS through -e can lose quotes in native argument conversion.
  $savedOutputEncoding = $OutputEncoding
  try {
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $state = $stateReader | & node - $scriptPath
    $stateOk = $LASTEXITCODE -eq 0
  } finally { $OutputEncoding = $savedOutputEncoding }
} else {
  Write-Host "  系统 PATH 中没有 node，无法读取有效配置"
}
if ($stateOk) {
  $fields = ([string]$state) -split '\|', 7
  $masterOn = $fields[0]; $importOn = $fields[1]
  $thrPct = $fields[2]; $thrSource = $fields[3]
  if ($fields[4] -eq 'off') {
    Fail "pre-commit 缺失或当前用户没有执行权限，Git 不会运行校验" `
         "在 Trae 重新开启校验以修复钩子；macOS/Linux 可检查 pre-commit 的执行权限"
  } elseif ($fields[5] -ne 'on') {
    Fail "pre-commit 入口内容与插件模板不一致，无法确认会执行占比校验" `
         "先备份并检查现有入口；确认不再需要自定义逻辑后，再恢复插件入口"
  } elseif ($fields[6] -ne 'on') {
    Fail "pre-commit 使用 CRLF 换行，入口需要转换为 LF" `
         "升级插件并重启 Trae，插件会修复自己管理的入口并保留仓库设置"
  }
  if ($masterOn -eq 'off') {
    Fail "有效总开关关闭（仓库未启用或 AI_RATIO_OFF 环境变量旁路）—— 提交会被直接放行" `
         "需要校验时在 Trae 开启 AI-GIT，并取消 AI_RATIO_OFF；旧版钩子另检查 .ai-ratio-off"
  } elseif ($importOn -eq 'off') {
    Pass "总开关开启（仅大提交校验关闭，不影响规则1）"
  } else {
    Pass "总开关开启，规则1/2 均启用"
  }
} else {
  Fail "无法读取有效配置（见上方错误），不能确定开关和阈值" `
       "检查 node、钩子文件及 git rev-parse --git-common-dir 下的 ai-ratio-guard.json"
}

# ---- 3. 实际生效阈值 ----
Say "[3] 有效阈值"
if ($stateOk) {
  $actual = [double]::Parse($thrPct, [Globalization.CultureInfo]::InvariantCulture)
  if ($Threshold -ne 0 -and $actual -ne $Threshold) {
    Fail "有效阈值 = $thrPct%（来源：$thrSource），但期望 $Threshold%" `
         "检查 AI_RATIO_MIN 环境变量；在 Trae 中调整仓库阈值"
  } else {
    Pass "有效阈值 = $thrPct%（来源：$thrSource）"
  }
} else {
  Write-Host "  有效配置读取失败，跳过阈值断言"
}

# ---- 4. git-ai 运行时二进制 ----
Say "[4] git-ai 运行时"
$bin = $null
$runtimeExe = if ([Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT) { 'git-ai.exe' } else { 'git-ai' }
if (Test-Path -LiteralPath $runtimeRoot -PathType Container) {
  $vers = Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -match '^[0-9]+\.[0-9]+\.[0-9]+$' } |
          Sort-Object { [version]$_.Name } -Descending
  foreach ($v in $vers) {
    foreach ($p in (Get-ChildItem -LiteralPath $v.FullName -Directory -ErrorAction SilentlyContinue)) {
      $cand = Join-Path (Join-Path $p.FullName 'host') $runtimeExe
      if (Test-Path -LiteralPath $cand -PathType Leaf) { $bin = $cand; break }
    }
    if ($bin) { break }
  }
}
if ($bin) {
  Pass "找到 $bin"
} else {
  Fail "未找到 git-ai 可执行文件（$runtimeRoot\*\*\host\$runtimeExe）—— 规则1 fail-open" `
       "确认已安装本插件并打开过 Trae（runtime 由插件释放）；必要时重装插件"
}

# ---- 5. daemon 存活 ----
Say "[5] daemon 存活"
$alivePid = $null; $seenN = 0; $seenPid = $null
# Match the hook: an explicit home must never fall back to another daemon.
if ($env:GIT_AI_DAEMON_HOME) {
  $daemonHomes = @($env:GIT_AI_DAEMON_HOME)
} else {
  $daemonHomes = @(Get-ChildItem -LiteralPath $tobHome -Directory -ErrorAction SilentlyContinue |
                  ForEach-Object { $_.FullName })
  $daemonHomes += $tobHome
}
foreach ($daemonHome in $daemonHomes) {
  $pf = Join-Path (Join-Path (Join-Path $daemonHome 'internal') 'daemon') 'daemon.pid.json'
  if (-not (Test-Path -LiteralPath $pf -PathType Leaf)) { continue }
  $dpid = $null
  try { $dpid = (Get-Content -LiteralPath $pf -Raw | ConvertFrom-Json).pid } catch { continue }
  if (-not $dpid) { continue }
  $seenN++; $seenPid = $dpid
  if (Get-Process -Id $dpid -ErrorAction SilentlyContinue) { $alivePid = $dpid; break }
}
if ($alivePid) {
  Pass "daemon 存活（pid=$alivePid）"
} elseif ($seenN -gt 0) {
  Fail "tob daemon 未存活（发现 $seenN 个 pid 记录，如 pid=$seenPid，均无对应进程）—— 规则1 fail-open" `
       "打开 Trae 让插件拉起 daemon 后再提交；纯终端提交前先确认 Trae 在运行"
} else {
  Fail "tob daemon 未存活（未找到 daemon.pid.json）—— 规则1 fail-open" `
       "打开 Trae 让插件拉起 daemon 后再提交；纯终端提交前先确认 Trae 在运行"
}

# ---- 6. 暂存分母是否被 .git-ai-ignore 清零 ----
Say "[6] 暂存分母"
# Keep this NUL-delimited reader identical in both standalone scripts.
$diffReader = @'
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
'@
$rawTotal = 0; $ignAdds = 0; $fileN = 0; $diffOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $savedOutputEncoding = $OutputEncoding
  try {
    $OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $diffState = $diffReader | & node -
    $diffOk = $LASTEXITCODE -eq 0
  } finally { $OutputEncoding = $savedOutputEncoding }
}
if ($diffOk) {
  $parts = ([string]$diffState) -split '\|', 3
  $rawTotal = [long]$parts[0]; $ignAdds = [long]$parts[1]; $fileN = [long]$parts[2]
}
$visible = $rawTotal - $ignAdds
if (-not $diffOk) {
  Fail "无法读取暂存分母，不能判断忽略规则" "检查 node 是否可用，以及 git diff --cached 是否能正常执行"
} elseif ($fileN -eq 0) {
  Pass "当前无暂存改动（无法验证分母，属正常）"
} elseif ($rawTotal -eq 0) {
  Pass "本提交无新增行（仅删除/重命名/二进制），规则1不适用"
} elseif ($visible -eq 0) {
  Pass "暂存新增行均由 .git-ai-ignore 排除（$rawTotal 行全部被忽略），不适用占比校验"
} else {
  Pass "暂存 $fileN 个文件：新增 $rawTotal 行，其中被忽略 $ignAdds 行 → 分母 $visible 行"
}

# ---- 7. 重放钩子，看是否真的在判定 ----
Say "[7] 钩子实际判定（重放）"
if (-not $hasScript) {
  Fail "钩子脚本不存在，无法重放" "同 [1]：重新开启钩子"
} elseif (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Fail "系统 PATH 中没有 node —— pre-commit 依赖 node 运行，钩子会直接报错/跳过" `
       "安装 Node.js 并确保 node 在 PATH（本插件运行环境已含 Node，建议用 Trae 内置终端）"
} else {
  $env:GIT_AI_CWD = $root
  $code = 0
  try {
    $outLines = & node $scriptPath 2>&1    # 先跑完再取退出码，避免管道影响 $LASTEXITCODE
    $code = $LASTEXITCODE
    $out = ($outLines | Out-String)
  } finally { Remove-Item Env:\GIT_AI_CWD -ErrorAction SilentlyContinue }
  Write-Host "      —— 钩子输出 ——"
  foreach ($ln in ($out -split "`r?`n")) { Write-Host ("      " + $ln) }
  Write-Host "      退出码=$code （0=放行/跳过；非零需结合拦截信息或错误判断）"
  if (-not $diffOk) {
    Fail "暂存分母读取失败，无法验证钩子判定" "先解决 [6] 的读取错误"
  } elseif ($code -ne 0) {
    if ($code -eq 1 -and $out -match '(?m)^\[ai-ratio\] BLOCKED: (ratio > 100%|ratio < [0-9.]+% threshold|bulk commit [0-9]+ lines with only [0-9]+ AI lines \(import guard\))\r?$') {
      Pass "钩子正常执行，并按校验规则拦截提交"
    } else {
      Fail "校验脚本运行失败（退出码 $code），不是正常放行或规则拦截" `
           "查看上方错误，检查 Node.js 环境和 check-ai-ratio.js 是否损坏"
    }
  } elseif ($out -match '(?m)^\[ai-ratio\] git (diff failed, skip check|directory unavailable, skip)\r?$') {
    Fail "钩子未能读取 Git 数据，跳过了校验" "检查上方钩子输出和 Git 仓库状态后重试"
  } elseif ($out -match '(?m)^\[ai-ratio\] disabled, skip\r?$') {
    Fail "钩子重放时校验已关闭" "检查仓库开关或 AI_RATIO_OFF 后重试"
  } elseif ($rawTotal -eq 0) {
    Pass "无新增行，钩子直接放行属正常"
  } elseif ($visible -eq 0) {
    Pass "无参与占比校验的新增行，钩子放行属正常"
  } elseif ($out -match 'ratio [0-9]') {   # 判定行形如 "…, ratio 0.0%"；避免离线提示 "ratio check" 被误判
    Pass "钩子确实在做占比判定（见上面 ratio 行）"
  } else {
    $skip = [regex]::Match($out, 'daemon offline|attribution query failed|import guard').Value
    $r = "有暂存改动，但钩子未做占比判定"
    if ($skip) { $r += "（跳过原因：$skip）" }
    $r += " —— 本次提交未被拦截"
    $fix = "按上面失败的检查项（[2]总开关 / [4]runtime / [5]daemon / [6]分母）逐项修复后重试"
    if ($skip -eq 'attribution query failed') {
      $fix = "打开 Trae 的 Git AI 页面，点击「重新检查」，再运行本脚本"
    }
    Fail $r $fix
  }
}

# ---- 结论 ----
Write-Host "============================================================"
if ($script:nFail -eq 0) {
  Write-Host "自检结果: 通过（$($script:nPass) 项全部通过）"
  Write-Host "============================================================"
  Write-Host @'
若"非 AI 提交仍未被拦"，请对照 [7] 的 ratio 行进一步判断：
  * 原始 AI 占比超过 100% 时会拦截。请核对部分暂存和 .git-ai-ignore。
  * 完全无 ratio 行     → 多为绕过了钩子，检查是否用 git commit --no-verify。
'@
  exit 0
} else {
  Write-Host "自检结果: 不通过（$($script:nFail) 项失败 / 共 $($script:nPass + $script:nFail) 项）"
  Write-Host "============================================================"
  foreach ($f in $fails) {
    Write-Host ("  • 原因：" + $f.Reason)
    Write-Host ("    修复：" + $f.Fix)
  }
  Write-Host ""
  Write-Host '提示：本钩子语义是「要求 AI 占比 ≥ 阈值才放行」，设 98% 即拦所有低于 98% 的提交。'
  Write-Host '     若你的预期恰好相反（AI 过高才拦），则工具方向不同，上述均为正常行为。'
  exit 1
}
