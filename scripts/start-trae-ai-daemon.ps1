#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$Workspace = (Get-Location).Path,
  [string]$TraeExe,
  [ValidateRange(1, 300)]
  [int]$TimeoutSeconds = 60,
  [switch]$RestartTrae
)

$ErrorActionPreference = 'Stop'
$traeNames = @('Trae CN', 'Trae', 'TraeCode')
$daemonRoot = Join-Path -Path $HOME -ChildPath '.trae-cn/.git-ai-tob'

function Get-TraeDaemon {
  $homes = @($env:GIT_AI_DAEMON_HOME)
  if (-not $env:GIT_AI_DAEMON_HOME) {
    $homes = @($daemonRoot)
    $homes += @(Get-ChildItem -LiteralPath $daemonRoot -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { $_.FullName })
  }
  foreach ($daemonHome in $homes) {
    $pidFile = Join-Path $daemonHome 'internal/daemon/daemon.pid.json'
    try { $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json }
    catch { continue }
    $daemonPid = 0
    if (-not [int]::TryParse([string]$record.pid, [ref]$daemonPid) -or $daemonPid -le 0) { continue }
    $process = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'git-ai') { return $process }
  }
}

function Find-TraeExe {
  $running = Get-Process -Name $traeNames -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path }
  foreach ($process in $running) {
    if (Test-Path -LiteralPath $process.Path -PathType Leaf) { return $process.Path }
  }

  foreach ($name in $traeNames) {
    $exe = "$name.exe"
    foreach ($key in @(
      "HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exe",
      "HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\$exe"
    )) {
      $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
      if (-not $item) { continue }
      $candidate = [Environment]::ExpandEnvironmentVariables([string]$item.GetValue('')).Trim('"')
      if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    $command = Get-Command -Name $exe -CommandType Application -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($command) { return $command.Source }
  }

  $roots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)})
  foreach ($root in ($roots | Where-Object { $_ })) {
    foreach ($folder in @('Programs/Trae CN', 'Programs/Trae', 'Programs/TraeCode', 'Trae CN', 'Trae', 'TraeCode')) {
      foreach ($name in $traeNames) {
        $candidate = Join-Path (Join-Path $root $folder) "$name.exe"
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      }
    }
  }
}

try {
  $daemon = Get-TraeDaemon
  if ($daemon) {
    Write-Host "[PASS] 已找到正在运行的 Trae 归因服务（PID $($daemon.Id)）。"
    exit 0
  }

  if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "仓库目录不存在：$Workspace"
  }
  $Workspace = (Resolve-Path -LiteralPath $Workspace).ProviderPath
  if (-not $TraeExe) { $TraeExe = Find-TraeExe }
  if (-not $TraeExe -or -not (Test-Path -LiteralPath $TraeExe -PathType Leaf)) {
    throw '未找到 Trae CN。请用 -TraeExe 指定 Trae CN 的 .exe 完整路径。'
  }
  $TraeExe = (Resolve-Path -LiteralPath $TraeExe).ProviderPath

  if ($RestartTrae) {
    $processName = [IO.Path]::GetFileNameWithoutExtension($TraeExe)
    $running = @(Get-Process -Name $processName -ErrorAction SilentlyContinue |
      Where-Object { $_.Path -eq $TraeExe -and $_.MainWindowHandle -ne 0 })
    foreach ($process in $running) {
      Write-Host '正在请求 Trae 正常退出。如有保存提示，请在 Trae 中处理。'
      if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(30000)) {
        throw 'Trae 尚未退出。请保存工作，在 Trae 菜单中完全退出后再运行脚本。'
      }
    }
    if (Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $TraeExe }) {
      throw 'Trae 仍在后台运行。请在 Trae 菜单中完全退出后再运行脚本。'
    }
  }

  Write-Host "正在用 Trae 打开仓库，最多等待归因服务 $TimeoutSeconds 秒。"
  $workspaceArg = '"' + $Workspace.Replace('\', '/') + '"'
  Start-Process -FilePath $TraeExe -ArgumentList $workspaceArg -WorkingDirectory $Workspace
  $timer = [Diagnostics.Stopwatch]::StartNew()
  do {
    $daemon = Get-TraeDaemon
    if ($daemon) {
      Write-Host "[PASS] 已找到正在运行的 Trae 归因服务（PID $($daemon.Id)）。"
      exit 0
    }
    Start-Sleep -Milliseconds 500
  } while ($timer.Elapsed.TotalSeconds -lt $TimeoutSeconds)

  if ($env:GIT_AI_DAEMON_HOME) {
    Write-Host '当前 PowerShell 设置了 GIT_AI_DAEMON_HOME。请确认它指向本账号的 Trae 归因服务目录。'
  }
  throw '等候超时。请确认 Trae CN 已登录，并查看「输出 → Trae: Coding Analysis」中的启动报错。'
} catch {
  Write-Host "[FAIL] $($_.Exception.Message)"
  exit 1
}
