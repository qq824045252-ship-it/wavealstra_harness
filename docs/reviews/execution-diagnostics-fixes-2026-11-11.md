# 执行诊断修复：轮次身份、判定降噪、费用口径与 Windows 只读后端

日期：2026-11-11。范围：`src/main/agent`、`src/main/usage`、`src/main/platform`、`src/renderer/src/lib` 与对应测试。只读依据：本机 `~/.mybuddy/app.db`（诊断投影：1,122+ 请求、工具记录）、`~/.mybuddy/durable/*/main.jsonl` 工具结果原文；对活库的轮次归并结果用数据库副本 + 真实 `TaskDiagnosticsRepository` + 新规则重放验证。

## 现场结论（修复前）

- 面板显示的「轮」远超真实模型轮次：github 评估任务 24 个请求显示 60 轮（36 个工具各自成轮），其中 36 轮「命中率未知」；原因是工具/等待记录用 `toolTaskId` 作 `executionId`，请求用 `generationTaskId`。
- 16 条「异常」全部来自工具失败，模型请求 0 失败；「需注意」16/21 来自 `read` 的图片/截断提示（A7）与每个任务的第 1 轮缓存 0%（C3）。
- 每个任务首批请求 `费用 $0.000000`：`magpie/opendesign/deepseek-v4.1-flash-eco` 模型目录 cost 四项全 0，pi 算出的 0 被当真实账单（pi-native、complete=true）。
- `register_artifact` 在两个出文件任务里各失败一次（先登记后 write → `ENOENT realpath`；以及流式 tool_call 参数拼接）。
- Windows 上 `ls -la` 等只读校验命令直接抛「当前平台尚未提供可信只读命令后端」。
- OfficeCLI 在 OneDrive 工作区对 `%TEMP%\tmp*.tmp`、`.tmp_officecli` 报 `Access to the path … is denied`（5 次，09:41–09:45，三个任务并发期间）。

## 本次修复

| 问题 | 修复 |
| --- | --- |
| 轮次身份割裂（P0） | 工具诊断事件新增 `generationTaskId`：`DurableBotRuntime` 用每个会话最近一次 generation + 每个 toolTaskId 固化映射；`TaskDiagnosticsRepository.observeTool` 用它按与请求相同的口径写 `executionId`。旧记录（无该字段）在读取时按「同会话最近完成的请求」归轮，并在工具表标「旧记录：按同会话前序请求归轮」；等待记录同样通过 toolTaskId→generation 映射归轮。 |
| A6 把命令非零退出判异常 | `exit_code` → 需注意（命令自身失败）；`invalid_arguments`/`blocked`/`tool_error`/无诊断 → 异常（工具层故障）。同名工具连续失败只统计工具层故障。 |
| A7 阅读提示噪声 | `image`、`truncated`、`full_output`、`N more lines in file…` 视为阅读提示，不再触发「需注意」。 |
| A8 失败工具重复标缺口 | 失败工具不再追加「观测不完整」unknown；A8 只用于中断/未完整观测。 |
| C3 首轮冷缓存 | 已在提交 `73b7fcd7` 修复：要求同组先有真实命中；首轮 0% 只作基线，趋势点只对规则命中的回源标红。 |
| `register_artifact` 报错 | 文件不存在时返回可操作中文提示（先 write/命令创建再登记；write/edit 成功会自动登记），并更新工具描述，避免模型先登记后写。 |
| 费用未配置 | `nativeCostEvidence` 与 `CacheRequestTracer`：total=0 且模型定价全 0 且无供应商报告 → 未知；`UsageStatsService.recordLive` 增加 `pricingConfigured`，durable/auxiliary 调用方按模型目录传值，cost_known=0 而不是记 0。历史行保持原值。 |
| Windows 只读命令 | `executeWorkReadCommand` 非 Linux 走进程内 Node fs 后端（ls/wc/stat/du/od/sha*/md5），不 spawn、不读 PATH；安全校验（realpath、普通文件/目录、硬链接、读后比对、100k 上限）与 Linux 分支的 fd 绑定保持独立。新增 `test:work-shell-read`。 |
| 流式 tool_call 参数拼接 | 已提交 `3f3169fb` 的 pi-ai 补丁；此前提交后未装进 `node_modules`（`test:pi-tool-call-stream` 失败），本次执行 `pnpm install --frozen-lockfile` 应用，测试 9/9 通过。 |

## 验证

- `pnpm -s typecheck`：web/node/scripts 0 新增错误。
- `pnpm -s test:diagnostics-rules`：80 passed（含新增 A6/A7/A8/阅读提示用例）。
- `pnpm -s test:task-diagnostics`：通过（含新记录 generation 归轮、旧记录推断归轮、等待合并断言）。
- `pnpm -s test:work-shell-read`：14 passed / 1 skipped（Windows 符号链接用例需开发者模式）。
- `pnpm -s test:native-cost-evidence`、`test:usage-stats`(163)、`test:usage-recon`(30)、`test:pi-tool-call-stream`(9) 全绿。
- 活库重放（数据库副本 + 真实 Repository + 新规则）：github 任务 60 轮→24 轮、未知命中率轮 36→0、异常 4→2、需注意 3→2；科灵 124→58 轮、异常 3→0/需注意 3；微量水 50→22 轮、异常 7→1、需注意 2→5；质量流量计 33→14 轮；nsh 69→53 轮。所有任务 tool-only 轮为 0。

## 未闭环 / 边界

- OfficeCLI 的 `Access to the path … denied` 五次均发生在 09:41–09:45 三个 OneDrive 工作区任务并发期间；本机同版本 officecli（1.0.160）手工 `create/view/validate`（含 4 路并发、工作区 TEMP）均成功，未能复现。已在 officecli skill 增加降级指引（不要对同一路径反复重试；改用内置 write/Python 或换路径重试一次），代码层不伪造修复。
- 非 durable 会话（`SessionEventCoordinator`）记录用量时仍没有模型定价上下文，cost 口径保持旧行为；durable/auxiliary 路径已按模型目录传 `pricingConfigured`。
- 历史诊断记录里的 `费用 $0.000000` 不会被改写；只有重启后的新记录按新口径记未知。
- Linux/macOS 实机未跑：Linux 分支逻辑未改，host 后端在 Windows 验证；符号链接逃逸用例待 Linux 执行。
