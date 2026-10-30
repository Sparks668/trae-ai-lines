# Trae AI Lines 插件实现逻辑

> 版本：0.2.31 ｜ 双文件架构：`extension.js`（UI 层）+ `lib.js`（数据层）｜ 纯只读，零磁盘写入

## 1. 插件做什么

状态栏右侧（Trae++ 按钮左边）显示一个机器人图标项：

```
$(robot) AI 1275 / 1290 行
```

悬浮 tooltip 展示今日明细：

```
今日统计（2026-08-25）

AI Commit：1275 行，
总Commit：1290 行，
提交数：6

未提交：AI 6 行，总 13 行

数据来源：点击实时读取 daemon 原生日志，自动每 30s 刷新镜像日志
```

点击状态栏项 = 手动刷新（带 spinner 动画，最短展示 400ms）。

## 2. 两条统计链路（数据源完全独立）

| | 已提交统计（今日） | 未提交统计（工作区） |
|---|---|---|
| 方式 | **解析日志文件**中的归因事件 | **执行二进制** `git-ai status --json` 实时查询 |
| 不依赖 | 不查 git 历史 | 不读日志 |
| 输出 | ai / total / commits | ai / total |

### 2.1 已提交统计的日志源（双源，native 优先）

- **native 源（首选）**：`~/.trae-cn/.git-ai-tob/<租户ID>/internal/daemon/logs/git-ai-daemon-<今日>.log`
  - `<租户ID>` 不写死，readdir 枚举 `.git-ai-tob` 下全部目录逐个探测（多账号全兼容）
  - 近实时，归因事件落地即统计到
- **镜像源（回退）**：`<userData>/Trae CN/logs/<会话目录>/.../Trae Coding Analysis Daemon.log`
  - 递归扫描会话目录（只扫近 3 天，跨天会话也覆盖）
  - native 源不存在时自动回退，两者统计结果一致

日志中目标行格式（LINE_RE）：

```
2026-08-25T09:13:xx.xxx INFO datafinder: event [git_ai_commit_file] core_payload={"ai_lines":63,"commit_hash":"...","file_path":"...","total_lines_added":63,...}
2026-08-25T09:13:xx.xxx INFO datafinder: event [git_ai_commit_attribution] core_payload={"commit_hash":"...","total_lines_added":63,...}
```

### 2.2 未提交统计的执行链

1. 定位二进制：扫描 `~/.trae-cn/.git-ai-tob/tob-git-ai-runtime/<版本>/` 下全部版本目录（从新到旧）× 全部平台子目录（**不匹配目录名**），找到含 `host/git-ai`（Windows 为 `git-ai.exe`）的第一个
   - 平台目录命名是 Trae 自造的（macOS 实测叫 `macos-arm64`，非 VS Code 的 `darwin-arm64`），所以不能猜 Windows 叫什么，只能扫描发现
2. 在工作区目录执行 `git-ai status --json`（15s 超时）
3. 解析 JSON 重算（见 3.3）

## 3. 核心算法

### 3.0 行数计算总览（一句话版）

- **已提交 AI 行数** = Σ 每个提交里 daemon 已归因的 `ai_lines`（Trae 自己算好写进日志，插件只做累加去重）
- **已提交总行数** = Σ 每个提交的 `total_lines_added`（有整提交归因事件用事件值，否则该提交各文件求和）
- **未提交 AI 行数** = `stats.git_diff_added_lines − human_additions − unknown_additions`（净结算 AI，钳制不超过总行数）
- **未提交总行数** = 真实 `git diff HEAD` 新增行（git 不可用时回落 `stats.git_diff_added_lines`）

### 3.1 增量读取（避免每次全量读文件）

- 每个 `AiLinesCounter` 实例维护 `offsets: Map<file, byteOffset>`
- 只读上次之后的新增字节；文件被轮转（size 变小）则从头重读
- 只吸收**完整行**（最后一个 `\n` 之后的不完整行留到下次）

### 3.2 已提交：事件去重与合并（sums）

`entries: Map<"commitHash|filePath|@attr", payload>`，同一 key 后到的事件覆盖先到的：

- **file 事件**（`git_ai_commit_file`）：每个提交的每个文件一条，携带 `ai_lines`（**Trae daemon 归因出的该文件 AI 行数**——AI 会话中生成并进入本次提交的新增行）和 `total_lines_added`（该文件新增总行数）
- **attribution 事件**（`git_ai_commit_attribution`）：无 file_path，每提交一条，携带整提交的 `total_lines_added`
- **AI 行数计算**：`ai = Σ 各提交的 total_ai_committed_added_lines`（attribution 事件携带的**结算口径**，与 Trae 官方界面一致）。注意它比 IDE 实时归因保守：`source_scene` 为 `unknown` 的 AI 会话编辑在结算时归为 unknown 而非 AI（实测一笔提交 file 事件合计 10 行 AI，结算口径只有 1 行）。无 attribution 事件时回退用各 file 事件的 `ai_lines` 求和（宽松口径）
- **total 合并规则**：某提交若有 attribution 事件，用它的整提交 total；否则用该提交所有 file 事件的 total 之和。两种事件并存时不会重复计数
- **amend 处理**：事件带 `amended_from_commit_hash` 时，删除旧 hash 的全部条目，避免 amend 前后双份计数
- **跨天清零**：`poll()` 检测日期变化即 `entries.clear()`

### 3.3 未提交：AI 归因重算（关键修正）

**checkpoint 是什么**：git-ai 对工作区每次代码改动记的一条"存档点"，形如`{ additions, deletions, is_human, tool_model, ... }`——记录这次改动加了几行删了几行、是人改的还是 AI 改的、用的什么工具/模型。你在编辑器里敲一行、接受一次 AI 补全、粘贴一段代码，各是一条 checkpoint。`git-ai status --json` 的 `checkpoints` 数组就是当前未提交改动对应的全部存档点，是区分"这行是谁写的"的唯一明细。

**checkpoint 怎么存**：磁盘上是 **SQLite 数据库**（`~/.trae-cn/.git-ai-tob/<租户>/internal/datafinder-db`，伴生 `-shm`/`-wal` 文件为 WAL 模式标配），JSON 只是 `git-ai status --json` 命令执行时的**输出序列化格式**，插件不直接读数据库，只消费命令返回的 JSON。

daemon 的 `stats.ai_additions` 会把编辑器内手工编辑（KnownHuman）混进 AI，**不可信**。因此放弃它，改为遍历 `checkpoints` 自行累加：

```js
for (const c of j.checkpoints || []) {
  if (c.is_human) continue;                          // 编辑器外的人工改动
  if (/<.+>/.test(c.tool_model || '')) continue;     // tool_model 是 git 身份 "name <email>" => 编辑器内手工编辑
  ai += c.additions || 0;
}
if (!cps.length) ai = s.ai_additions || 0;           // 无 checkpoint 明细才回退原始值
return { total, ai: Math.min(ai, total) };           // AI 不可能超过 diff 总数，钳制
```

`tool_model` 判定：**模型名**（如 `Trae glm-5.3`、`Trae-code-edit default` 行内补全）= 真 AI，累加其 additions；**git 身份格式**（`bobchen <email>`）= 编辑器内手工编辑，跳过。

**未提交总行数** = 真实 `git diff HEAD --numstat` 的新增行之和（0.2.17 起不再取 `stats.git_diff_added_lines`——它只计 checkpoint 归因过的行，GBK 文件按 binary_file_skipped 计 0 会漏统计）。git 命令失败时回落 `stats.git_diff_added_lines`。

注意：查询命令是 `status --json`，**不带 `--diff-only`**——该参数会剥掉 checkpoints 明细，导致每次都回退到混算的 `ai_additions`。

## 4. UI 层逻辑（extension.js）

- 状态栏项：`StatusBarAlignment.Right`，priority 9999（尽量靠右）
- 刷新：`setInterval(refresh, 30000)` 自动 + 命令 `aiLines.refresh` 手动
- 刷新防重入：item.text 以 `$(loading` 开头时直接 return
- spinner 最短展示 400ms（避免刷新太快动画闪没）
- 失败兜底：读取异常时显示上一次正常值 + tooltip 显示错误信息
- 命令 `aiLines.diagnose`：诊断（见 6）

## 5. 跨平台路径适配

| 项 | macOS | Windows |
|---|---|---|
| 镜像日志根 | `~/Library/Application Support/Trae CN/logs` | `%APPDATA%\Trae CN\logs` |
| native/运行时根 | `~/.trae-cn/.git-ai-tob/...` | `%USERPROFILE%\.trae-cn\.git-ai-tob\...` |
| 二进制名 | `git-ai` | `git-ai.exe` |
| 平台目录名 | 扫描发现（不匹配名字） | 扫描发现（不匹配名字） |

`.trae-cn` 主目录与 `internal/daemon/logs` 层级是固定结构；租户 ID、版本号、平台段名全部动态发现。

## 6. 诊断命令（Trae AI Lines: Diagnose）

输出到 Output 面板 "Trae AI Lines" 通道（懒创建，跑一次命令才出现），逐项检查：

- 日志目录 / git-ai 运行时目录存在性 + 版本目录列表
- 国际版 Trae 检测（`Trae/logs`、`.trae/.git-ai-tob` 存在则提示）
- 逐租户探测 native 今日日志，缺失时**列出目录内实际文件名**（看穿命名差异）
- 日志文件读取探针（抓 Windows 文件锁定）
- logs 目录顶层内容、镜像日志文件数
- 两个源各自实际统计结果
- 未提交查询结果

## 7. 已知限制（数据源的边界，非插件 bug）

1. **daemon 没见证的提交不计入**：已提交统计只认 daemon 记录的归因事件，以下情况不产生事件、统计不到（属预期行为，非 bug）：
   - 仓库/路径在 `git-ai-ignore` 忽略名单内（例：今早 09:04 的提交 2173 行，用户自行加入忽略后从终端提交，不计入是正确的）
   - 在命令行 / 其他 IDE 提交（git-ai 未跟踪该次提交）
2. **`Trae-code-edit default` 归因粒度极限**：编辑器内行内补全接受记为 AI；如果用户认为某次"补全"其实是纯手工，无法再细分
3. **Windows 未做真机验证**：路径逻辑全部为扫描式自适应，但 `git-ai.exe` 命名与 `host/` 层级是合理假设，以 Diagnose 实测为准
4. **未提交 checkpoints 无过期问题**（早先"几分钟过期"判断有误，实为 `--diff-only` 参数剥掉了 checkpoints，已移除该参数）

## 8. 工程特性

- 零磁盘写入：全部操作只读（readdir/stat/read/execFile 查询），无任何 writeFile/临时文件
- 内存有界：offsets 与 entries 均为内存 Map，跨天自动清空
- 源码纯 ASCII：中文全部 `\uXXXX` 转义，规避 GBK/UTF-8 编码乱码
- `node lib.js` 自检：三源统计一致性 + 未提交合法性校验，输出 OK/FAIL

## 9. 版本演进摘要

| 版本 | 要点 |
|---|---|
| 0.2.8 | 基线：已提交统计（镜像日志）+ 状态栏 |
| 0.2.10 | 未提交统计（git-ai status），tooltip 增加"未提交"行 |
| 0.2.11 | KnownHuman 排除初版（后发现 --diff-only 剥 checkpoints 的坑） |
| 0.2.12 | 移除 `--diff-only`，checkpoints 明细可用，手工/AI 区分生效 |
| 0.2.13 | Windows 路径适配 + Diagnose 诊断命令 v1 |
| 0.2.14 | 二进制路径改为扫描式发现（平台段名不再写死/猜测） |
| 0.2.15 | tooltip 数字格式微调（"行，"分隔） |
| 0.2.16 | Diagnose 升级：已提交链路全透视（租户枚举/实际文件名/读取探针/双源统计/国际版检测） |
| 0.2.17 | 未提交统计改用 git diff HEAD 真实行数（GBK 文件不再漏统计） |
| 0.2.18 | 未提交 AI 净行数 = attributed − human − unknown（手动编辑不再误计为 AI） |
| 0.2.19 | 合并 ai-ratio-guard：guard.js 守护模块 + 独立状态栏项，旧插件停用 |
| 0.2.20 | 钩子拦截修复三连：分母改真实暂存行数（31/31=100% 漏拦根因）、gitaiTotal 门槛修复、中文路径 quotepath / rename / CRLF 解析修复 |
| 0.2.21 | 钩子模板加 guard-v3 版本标记，插件启动 autoUpgrade 自动重写落后钩子（升插件即升钩子，免逐仓库关→开；阈值与开关状态保留，外来钩子不动） |
| 0.2.22 | 插件说明中文化：package.json description + README.md（扩展详情页）；打包后已验证 UTF-8 中文未被管道破坏 |
| 0.2.23 | README 详情页从单一统计说明扩为完整功能页：行数统计 + AI-GIT 守护两条规则 + 命令面板五命令 + .git-ai-ignore / --no-verify / 钩子自动升级说明 |
| 0.2.24 | README 展示格式对齐真机：统计项 `AI 2420 / 2420 行`、守护项 `AI≥80%` / `AI-GIT校验:关`（前版凭记忆写错）、补阈值范围 50–100 与两种设置入口 |
| 0.2.25 | 文档补批量守护关闭时的显示变体 `AI≥xx%·大关`（guard.js T.dash 后缀，前两版遗漏） |
| 0.2.26 | 钩子 guard-v4：核心审计发现 git-ai 结算含未暂存行（整树口径），部分暂存提交时 ratio 虚高——无法按暂存区归因（数据源边界），改为透明提示（log unstaged 行数 + note 说明），不改拦截判定 |
| 0.2.27 | 三处修复：① NaN 注释含 `__AI_RATIO__` 字面量与常量行撞车，String.replace 首匹配错位 → writeHooks 产出钩子阈值恒 50%（改注释措辞 + 行锚定正则替换）；② autoUpgrade 跳过带占位符的手动复制钩子 → 加治愈条件（tag 同但占位符在即重写）；③ setThreshold 对占位符钩子 replace 空转（提示已设 80% 实际拦 50%）→ 回落 writeHooks；钩子头注释同步修正陈旧分母描述，tag bump guard-v5 |
| 0.2.28 | 建立全路径回归套件 test.js（35 断言：钩子 14 场景含伪 git-ai 确定性注入/guard 模块 13/lib 2/制品一致性 5，可对已安装目录二次运行）；guard.js 导出内部函数仅供测试（行为不变）；钩子模板未动（仍 guard-v5）。此后任何改动先过套件全绿再发布 |
| 0.2.29 | 修复多根工作区阈值覆写：toggle/toggleImport 重开时原先用 locs[0] 的阈值重装所有仓库，会把兄弟仓库的 100 静默放宽到 50（autoUpgrade 本就逐仓库取值，属实现不一致）；改为循环内逐仓库 readState 取各自阈值；补 B11 双断言回归（双仓库 50/100 经 toggle 与 toggleImport 各一轮后各自保留）；钩子模板未动（仍 guard-v5） |
| 0.2.30 | 钩子 guard-v6 + lib 同步：修复 2026-10-13 归因断裂根因——插件两条路径（30s 刷新 + pre-commit 钩子）执行 `git-ai status` 时若 daemon 不在场，CLI 会自动拉起一个无 datafinder 配置的残废 daemon（app_id 只存在于 Trae 扩展的 spawn env），且官方扩展随后复用它不重启，导致此后所有提交零归因（当日 3 笔提交 AI 统计丢失）。修复：新增 daemonAlive() 活性预检（读 daemon 自维护的 daemon.pid.json + process.kill(pid,0) 探活），daemon 不在场时 lib.uncommitted 返回 null（状态栏显示"-"）、钩子 rule1 跳过并明示 note（rule2 纯 git 照拦），两处均绝不执行 CLI；补 A12/A13/C3 回归（离线场景 rule1 跳过、rule2 照拦、lib 不碰 CLI），测试假环境 FAKE_HOME 需注册活 pid 否则 rule1 用例全体静默失效 |
| 0.2.31 | 钩子 guard-v7 + lib 同步：关闭 v6 遗留的"探测→执行毫秒级窗口"。用 strings 从 git-ai 1.6.2 二进制中提取到官方内部开关 `_GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN`，验证设为 true 可禁止 wrapper 自动拉起 daemon；lib.uncommitted 与钩子 exec() 的所有 git-ai 调用均注入该环境变量，daemon 即便在预检后瞬间死亡，CLI 也被结构性禁止拉起替代进程。附带实验修正的再修正（0.2s 密集采样实锤，2026-10-13 晚）：早前 fake home 实验得出"status 在无 daemon 时走本地计算不拉起"的结论是假象——fake home 缺少真实状态导致 status 走了另一条分支；在真实默认 home 下，0.2 秒间隔采样抓到完整父子链 `git-ai status --json (父=Trae 扩展宿主) → git-ai bg run`，证明 **status 确实会自动拉起无配置 daemon**，v6 当初的担心是对的。v7 开关实测有效：带 `_GITAI_INTERNAL_DISABLE_WRAPPER_DAEMON_AUTOSPAWN=true` 跑 status（exit 0、本地计算、5 秒观察无新进程），不带开关则每次周期刷新都会复活僵尸 daemon。结论：**本开关是防线本体而非兜底，严禁移除**——v6 的 daemonAlive 预检查的是 tob home（官方扩展的 daemon），拦不住 status 在默认 home 的拉起，这正是 0.2.30 后僵尸 daemon 仍周期重生的原因；顺带实测 Trae 扩展经 socket 下发的 runtime config 不含 app_id（app_id 只来自 spawn env），证实"扩展重启时序内拉起的裸 daemon"只有 settings.json 兜底（tobGitAi.dataFinder.*）能救，0.2.30 已配 |
