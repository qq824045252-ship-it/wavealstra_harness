# 持续委托前台自动补查

基线：`e1d5ce2`。本轮由助手直接修改，未调用 Codex 工作线程；未改生产配置、未更新生产实例。

## 行为

- 前台真实模型核对原目标、本轮真实结果和近期记录。缺少可通过只读查询补齐的信息时输出结构化 `followUp`，引用原始请求，宿主复核并持久派发。
- 复用原有 partial-results / continuation / outbox，不另建内存补跑队列。补查独立执行，结果回到原 Bot 对话由前台再次核对；不改变原 cron，不把完成一轮等同结束持续委托。
- 同一观察链最多两次补查；每个正常周期独立计算补查次数。这里是防即时无限循环的执行次数，不是用户额度或预算模块。
- 补查实际 delegatedScope 和工具模式都只读。暂停、到期、结束、owner/intent/schedule 变化沿用现有派发取消语义；确定性操作身份与事务防止重复派发。
- 团队当前 owner 的有效补查可使用自己真实工具读回作为停止条件证据；普通成员没有因此获得 owner 身份。
- “目标源确实尚未发布”可能是有效的本轮观察。模型可保留原周期而不盲目即时重试；验收必须把正常周期与独立补查区分记录。

## 真实测试发现并修复的时间问题

一次真实模型创建请求把 11 月 10 日 20:54 错算成 11 月 30 日 20:54 的毫秒时间戳，导致首次调度推迟约 20 天。

周期工具输入现在不接受模型心算的 `nextWakeAt`：省略后由宿主根据 cron/timezone 计算；用户明确指定首次日期时使用带时区 ISO `firstCheckAt`，保留指定首次时间。一次性数值时间仍支持。模型输入和内部 normalized DTO 分离，避免团队工具二次解析冲突。专项验证错误数值无写入、ISO 日期精确保留及团队二次解析。

## 验证记录

用户要求先推送：本提交时类型检查及受影响专项已通过，411 项非故障注入回归仍在最后段，六类真实模型验收仍在运行，不能报告全部通过。已确认下述单次真实独立补查成功。本文件不声称长期在线 365 天或物理键鼠点击已验证。

独立补查已真实取证：隔离 profile `YHqQhH`，发布状态 Work `work-2f400b77-687c-4a30-897a-a97967d23005` 首轮读取未发布资料失败后，前台模型生成补查，持久 continuation `continuation:9d6da06ff9fc1c54981726dd2dd7a02f0c2c4e7b5c2e78765f088f693a848799` 派发原生 binding `binding-d706120f-1370-46e2-a7a0-20fb60078062`，实际读回 `RELEASE_cc810804=READY` 并在 Bot 原对话反馈。该次测试脚本误只查 UI 最新执行窗口，漏掉已完成补查，后已改成持久执行记录和 UI 消息双核验，不能把整批脚本误报为通过。

测试使用 Omarchy 隔离 HOME、真实 Electron 页面/CDP、现有真实模型 `opendesign/deepseek-v4.1-flash-eco`。不是 mocked 模型或 mocked 工具。headless 页面验收不等于物理桌面键鼠验收。第六类联网沿用本机已有代理配置投影，不设置防火墙、不新增 Cloudflare 或 Codex 依赖。

按用户要求暂缓崩溃/故障注入，未启动新的实机故障注入活动。上一次完整默认门禁 432 项出现三个既有夹具漂移与一个并行超时；夹具分别修复字段登记、团队新合同参数和三位 M 文案，未改失败白名单。最终门禁结果另列，不以旧通过覆盖新代码。

## 推送后完成的非故障注入门禁

- `pnpm -s typecheck`：通过，scripts 0 错误。
- 默认聚合用例中排除下列 20 个故障/恢复相关用例后：411 通过、0 失败、0 已知失败、0 新回归，3.7 分钟。
- `test:project-task-defaults` 单独补跑通过（临时 fault 子串误匹配 defaults，已补回）；合计本轮非故障注入门禁 412 项通过。
- 暂缓：bot-work-automatic-recovery、bot-work-phase2-recovery、bot-work-phase3-handoff、bot-work-phase3-pause-backlog、bot-work-phase5-e2e-story、bot-work-phase5-native-story、bot-work-team-recovery、crash-reporting、durable-session-recovery、durable-work-liveness、durable-workspace-binding、execution-restart-recovery、gateway-inbox-crash、input-guardian、input-guardian-process、prompt-failure-recovery、runtime-requirement-recovery、session-history-recovery、skill-authoring-recovery、ui-automation-recovery。
- 临时过滤入口仅用于这次验证，正式 `test:all` 和失败基线未改。六类真实验收仍在进行，不能把本节当作六类全过。

## 六类真实任务发现的前台压缩故障与修复

同一 Bot 连续执行发布、CSV、日志、JSON、文档、网页六种任务时，第六次请求触发原生 `pi.compaction`。真实日志保留原始 `mybuddy.user`（含正确 `botRequestId`），但其后插入的压缩摘要也是 `role=user`。`BotForegroundIdentity` 过去直接解析离调用最近的任意 user 条目，因此报 `mybuddyInput` 缺失。模型尝试把这个宿主字段塞入工具参数，又被工具 schema 拒绝，无法自行解决。

修复只跳过原生 `pi.compaction` 及已导入历史，继续查同一原生调用之前的真实输入；真实输入缺字段仍拒绝，不会越过坏的真实输入去绑定更早用户。回归覆盖正常输入、压缩与分页、导入历史、坏真实输入边界、缺失输入、缺失调用；前台合同（87 种无效参数）与类型检查通过。

第一次六类批次严格取证为 4 类通过（发布/CSV/日志/JSON）；文档旧断言错误地匹配到请求引用的“36”，实际在正确原文回传完成前被测试暂停，不能算通过；网页因上述压缩故障未建立。验收脚本已加强：同一执行必须真实读到目标原文，文档必须有 A/B 两份，网页必须有 URL 来源和实际网页内容，不只匹配回复数字。

该批次还出现一次 Eco 模型 reasoning 耗尽旧夹具 4096 输出上限的空回复，自动重试后有下一轮正确结果。后续该测试声明 16384 输出上限，不改变生产模型配置。正在重新执行六类严格验收，已发布源资料通过 `BOT_WATCH_SOURCES_READY=1` 明确记录；不能将这批已发布资料路径冒充未发布资料自动补查路径。独立补查证据见前文。
