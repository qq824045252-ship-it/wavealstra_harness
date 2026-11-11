# 缓存读取统计显示审查（2026-11-11）

## 范围与发现

依据用户提供的实际 Bot 回复截图，底栏只有输入、输出、缓存率，缓存读取数藏在 tooltip 中。此次只补展示与复用统计组件，不改变模型调用、数据库计量、缓存策略或权限。

| 界面 | 审查结果与处理 |
| --- | --- |
| 个人 Bot / 团队 Bot 前台回复 | 共用 BotReplyMetrics，均缺可见缓存读取；补为输入 → 缓存读取 → 输出 → 缓存率 |
| Work 执行统计 / 子代理详情 | 已显示真实 cacheRead，统一标签“缓存读取”并调整字段顺序 |
| 普通任务上下文用量 / 子代理侧栏 | 已有缓存读取，统一标签 |
| 多模型会诊 | 原先 cacheRead=0 被隐藏且未统一 M；复用 subagentHeaderMetrics 展示四项，缺失显示 —，每项整体换行 |
| 普通任务及 Bot/团队共用执行诊断 | 已有缓存读取与缓存曲线；请求明细统一 M 三位小数，tooltip 保留精确原始 token |
| 账户用量总览 / 模型明细 | 已有缓存读取及 M 格式，无需改动 |

## 计量口径

- Bot / Work 读取现有 `metrics.cacheReadTokens`，不从百分比反推、不按文字长度估计。
- 原生子代理 / 会诊读取真实 `usage.cacheRead`。Pi 的 input 是未命中输入；命中率沿用 cacheRead / (input + cacheRead + cacheWrite)。已提供 totalInput 的 Work 用供应商总输入为分母。
- 缺失值显示 `—`，已知 0 显示 `0.000M`；不能用未报告数据补零。小于 500 token 按三位小数可显示 `0.000M`，悬浮值仍保留精确整数。
- 不汇总父子重复快照，不改变底层计量数据。诊断原始记录仍可核对供应商数据。

## 验证

- Typecheck：通过，scripts 0 新增错误。
- 本轮已启动的非故障门禁：416 通过 / 0 失败 / 0 已知失败 / 0 新增回归（2.5 分钟）；后续同类小显示修复按用户最新要求只运行受影响专项，不重复全量。
- 专项：context-usage 95/0、overview-runtime 114/0、diagnostics-rules 65/0、subagent-runs 50/0；bot-execution-diagnostics、task-diagnostics 均通过。
- 真实 Electron 44.5.1 / Chromium 152：subagent-header-ui 覆盖六档宽度、Bot/团队/Work 的数值/未知/已知零、布局溢出、数据切换；consult-card-ui 20 项通过，含零缓存、缺失缓存与 M 格式。
- 隐藏 Wayland 窗口无法 capturePage 时，使用独立离屏 Electron 窗口补截图并人工检查，未操作生产实例。个人/团队回复及 Work 1200/390/320 宽度截图、会诊桌面/窄屏截图均生成；窄列的指标采用整体换行。
- 此次为真实组件渲染与计量回归，不声称进行了真实模型或真实业务任务验收。没有调用线上模型，无需消耗六类任务模型额度。
- 故障注入按用户要求延后，不在此次验证范围内。未打包、未改版本号、未重启生产。
