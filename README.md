# Trae AI Lines

状态栏实时统计 AI 编码行数，并在提交时校验 AI 代码占比（不达标拦截 git commit）。

## 功能一：AI 行数统计

状态栏显示：`🤖 AI 2420 / 2420 行`（今日 AI 提交行数 / 总提交行数）。

- 数据来源：`Trae Coding Analysis Daemon` 输出日志中的 `git_ai_commit_file` / `git_ai_commit_attribution` 事件
- 已提交统计：今日各次 commit 的 AI 行数 / 总行数
- 未提交统计：工作区 + 暂存区变更中的 AI 净行数 / 总行数，总行数按仓库根目录的 `.git-ai-ignore` 过滤（未排除的 GBK 编码文件同样计入）；下方 `git diff` 明细保留未过滤的新增/删除行数，未暂存时也显示，无差异显示 `+0 / -0`（未跟踪的新文件不属于 Git diff）
- 每 30 秒自动刷新；鼠标悬停显示明细，点击状态栏项立即刷新
- 悬浮提示底部点击「展开详情」，打开固定详情页，集中显示统计、校验状态、工作区和刷新信息，方便截图；页面内可立即刷新或运行插件内置诊断，再次展开复用已有页面
- git-ai 守护进程离线时未提交 AI 统计显示 `-`，Git 明细仍独立显示（Trae 重启后自动恢复）；插件只查询、绝不拉起守护进程，避免产生无配置的僵尸进程导致提交归因丢失

## 功能二：AI 占比守护（AI-GIT）

状态栏显示：`🛡 AI≥80%`（开启）或 `AI-GIT校验:关`（关闭）。开启后向当前仓库安装 git pre-commit 钩子，提交时执行两条规则：

1. **占比校验**：本次提交的 AI 行数占比低于阈值则拦截（阈值范围 50–100，悬停状态栏项点「调整阈值」，或命令面板 `AI-GIT: Set Threshold`）
2. **批量导入守护**：单次提交 1 万~5 万行且 AI 行数不足 5000 时拦截（防止外部代码导入伪装）

- 开关、阈值按仓库独立保存；批量守护关闭后状态栏显示为 `AI≥80%·大关`
- 钩子随插件自动升级：升级插件后重启 Trae 即生效，**无需逐仓库关→开**（阈值与开关状态原样保留）
- 支持从原版 0.2.19、0.2.20 的无版本标记钩子升级；这些旧模板若被额外修改，仍会提示手动处理
- 被拦截时可执行 `git commit --no-verify` 强制提交（单次逃生）
- 仓库根目录建 `.git-ai-ignore` 文件（gitignore 语法）可把生成文件、脚本等从占比分母中排除

## 命令面板

| 命令                            | 作用                     |
| ----------------------------- | ---------------------- |
| `Trae AI Lines: Refresh`      | 立即刷新统计                 |
| `Trae AI Lines: Diagnose`     | 输出诊断信息（日志路径、双源统计、环境检测） |
| `Trae AI Lines: Show Details` | 打开固定统计详情页，方便查看和截图 |
| `AI-GIT: Toggle`              | 开/关当前仓库的守护钩子           |
| `AI-GIT: Set Threshold`       | 设置当前仓库的占比阈值            |
| `AI-GIT: Toggle Import Guard` | 开/关批量导入守护子规则           |

## 排查：设了阈值却没拦住提交

仓库 `scripts/` 下的自检脚本可一键定位原因（已随 VSIX 打包，也可从源码获取；需手动在目标仓库运行）：

| 平台 | 脚本 | 运行 |
|---|---|---|
| macOS / Linux / Git Bash | `scripts/diagnose-ai-guard.sh` | `bash diagnose-ai-guard.sh [阈值]` |
| Windows 原生 | `scripts/diagnose-ai-guard.ps1` | `powershell -ExecutionPolicy Bypass -File diagnose-ai-guard.ps1 [-Threshold 98]` |

在出问题的 git 仓库里运行即可，逐项体检 7 个「静默放行」缺口：①钩子是否装到 git 实际读取的目录（含 worktree / `core.hooksPath`）②总开关与旁路 ③烘焙阈值 ④git-ai 运行时 ⑤daemon 存活 ⑥暂存分母是否被 `.git-ai-ignore` 清零 ⑦重放钩子看本次真实判定。结论只有「通过 / 不通过」，不通过时按点给出原因与修复方法。详见使用说明「二、8」。

## 安装

1. Trae 扩展面板 → `···` → 从 VSIX 安装 → 选择 `trae-ai-lines-0.2.44.vsix`
2. 重启 Trae

已安装旧版本的用户：直接安装新 vsix 覆盖即可，钩子自动升级。

## 已知限制

- 仅支持 macOS + Windows 的 Trae CN（日志路径：`~/Library/Application Support/Trae CN/logs` / `%APPDATA%\Trae CN\logs`）
- 行数统计只统计本机 Trae 日志中可见的事件
- 提交守护依赖 `node` 在 PATH 中（GUI git 客户端用户注意 nvm 场景）
