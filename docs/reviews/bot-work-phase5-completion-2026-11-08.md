# Bot / Work — Phase 5 功能补全与原生验收复核

日期：2026-11-08（Asia/Shanghai）。执行基线：[`ac03fd59b9803e47f99ea4b67078d90600eb5a19`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/ac03fd59b9803e47f99ea4b67078d90600eb5a19)。

实现冻结：**[fff50d77538654565a562b2122109fea302576a7](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/fff50d77538654565a562b2122109fea302576a7)**。本报告与源码指纹由随后独立的文档提交归档，避免用规划 SHA 代替实现 SHA。

## 1. 本轮结论

**Phase 5 剩余代码功能已补齐：真实 Gateway Work 出站、独立负责人汇总、生产原生十步故事，以及此前缺少的桌面成果评审入口。必要的实机与真实渠道证据仍未取得，因此 BOT-WORK-1.0 整体验收尚未完成。**

最终完整门禁：**353 passed / 1 failed / 0 known failed / 1 new regression（158.45 秒，exit 1）**。Linux AT-SPI 的 D-Bus socket EPERM 在本轮基线 `ac03fd5` 的独立源码快照也原样复现。没有把该错误加入失败基线，也没有移除本应运行的恢复或新增业务用例来制造通过。下文所有 fixture 均明确其验证范围。

本轮应用版本仍为 `0.1.107`，依赖未变；数据库 schema 升为 **35**。`WorkService.ts` 为 **2483 行**，未放宽 2500 行架构约束。只在 `main` 上工作，按用户授权提交与推送；没有执行应用发布 build、pack、dist 或安装包更新。

## 2. 生产入口与事实边界

### 2.1 用户能完成成果评审与关闭

新增 `bot-work:review-control` IPC、严格共享请求契约、preload 与 `AgentService.reviewWork()`；真实 `BotWorkspacePage` 接入 `WorkReviewPanel`。用户可采纳/拒绝当前成果，提交绑定当前输入与产物的通过/失败反馈，再明确确认结束结论和依据。

- AgentService 固定可信桌面用户身份；请求不能携带 actor、grants 或额外字段。先核对 Work 归属，再进入原服务的即时事务和操作回执。
- 四类操作均要求完整 `stateVersion / intentRevision / ownerEpoch`。旧版本、跨用户和 worker 冒充用户会被拒绝。
- 采纳只保存成果，不替用户补造验收证据。成功关闭仍核验验收项、必要缺口、在途效果与 watch 停止条件。
- 控制重放复用原 operationId，成功关闭保留原 `accepted_result` 卡片；不会重跑原生工作。
- 表单按 Work/版本/负责人/产物重建，旧确认不沿用。评审、卡片已读/重发及诊断的异步回调在卸载后停止更新，刷新使用当前列表范围；较早操作不能把新 all 范围回退为 open。
- 用户保存的当前验证证据投影为 `user_verified`，手机显示「用户已验证」；执行证据继续为 `auto_verified`。不会把用户反馈说成自动检查。

普通 Task 的通知保持原路径。已有真实 Work binding 的 Task 完成事件不再额外发布 generic task-completed，交给 Work 卡片与负责人通知；必要的失败/用户处理提示保留。

### 2.2 多专家负责人汇总

`WorkOwnerSummary`、`WorkOwnerSummaryFacts` 从既有成员结果、协作消息、子项、已验收成果和阻碍派生 `owner_summary` 卡片与 `summary` 通知。持久状态放在既有 `work_owner_summaries.handled_watermark_json.ownerNotification`，没有第二套执行或投递账本。

首条实质事实固定 **15 秒最长等待期限**，后来消息、重放和交接不推迟它。全部成员明确完成或新增需用户处理的阻碍可提前发布；Host 启动/唤醒扫描及绝对 deadline timer 恢复这项义务。

规范化内容排序后形成语义身份，去除时钟、物理消息 ID、投递次数和重试顺序；成员报告的规范化正文仍是内容的一部分，不宣称任意改写措辞都等价。新增实质内容产生关联 `previousCardKey` 的新摘要。当前 owner/epoch/intent/input 重新核对，旧负责人提交拒绝，已明确 adoption 的旧 worker 成果继续有效。

未采纳报告显示「待核验」；拒绝、错误、写冲突、部分采纳缺口、实测等待、授权到期和持续阻碍保留准确含义。已答问题的重复消息及交接不会重新拉起同一待决。团队成果采纳不逐成员投递，成功关闭不再追加相同成果的通知；单负责人 Work 保留原通知身份。

摘要、水位、意图同事务提交，失败整体回滚；发布与阅读不推进 Work 控制版本。旧成功摘要遇产物变化停止发送；新摘要可以提醒重新核验，并继续校验其他仍被采纳的健康产物。为此 `WorkArtifactValidation.validate()` 仅对摘要投递接受当前 accepted bindings 范围；普通验收与成功关闭仍作原全 Work 校验，accepted artifact 缺失依赖登记仍拒绝。

### 2.3 真实 Gateway 异步出站

`WorkGatewayNotificationChannels` 将同一卡片派生为具有明确目标的通知意图，继续使用 `work_notifications / work_notification_effects / work_notification_attempts`。桌面与外部目标各有意图，原成果卡身份不变。

| 渠道 | 生产适配 | 目标边界 |
| --- | --- | --- |
| Feishu | `im/v1/messages`，解析 code/message_id | 原 App、chat、sender |
| WeCom | 私聊 `message/send`，群聊 `appchat/send` | 原 corp/agent、chat/user |
| WeChat | 客服 `message/custom/send` | 原 app/openId |
| Telegram | `sendMessage`，解析实际 Message | 原 bot/chat/forum 或 direct-message topic |
| Slack | `chat.postMessage`，解析 channel/ts | 原 team/app/bot/channel/thread；不广播到主频道 |

以上适配器均按本次实际保证声明 **best-effort-unqueryable**。成功 provider 回包只证明请求被渠道接收，不代表人已读，也不承诺跨崩溃恰好一次。丢失/畸形回执保持 unknown，人工重发仍须风险确认、原因与三版本守卫。测试使用实际适配器代码和可控传输，未发送给真实第三方收件人。

新的 `gateway_work_targets` 仅保存可信入站的公开连接身份与不可变路由，既不保存凭据，也不保存发送状态。关联必须同时匹配 **用户、Work conversation、原始 source_message_id**，不能按最近聊天、最后发送者或时间猜测目标。原生 `DurableInputProvenance` 必须找到单一 run input 的 submission 回执及完全相同的原 entry，来源才经 DomainTools/context/Goal 进入 Work；混合输入宁可不建立出站路由。

每次实际发送前重新核查账号身份、连接状态、允许名单、Work 用户与当前负责人；token 刷新后再核查一次。异步请求真正 await provider 响应，认领与回执仍有 attempt/generation/payload/effect 围栏。第二 SQLite 连接不能重新认领 best-effort 的未知效果。Host 保留 I/O 期间的尾随唤醒，限制单轮扫描，退出时取消请求并等待排空后才关闭数据库。

Feishu 新增 **Verification Token** 配置与脱敏。缺失/错误 token、错误 App/schema、停用渠道或目前未支持的加密事件均在入站层拒绝，不能驱动 Agent。启用飞书的用户需要补齐此配置。

协议参考采用官方文档：[Feishu 回调校验](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/receive-and-handle-callbacks)、[Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage)、[Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postmessage)。能力声明以已实现的可验证保证为准，不从一个 client_msg_id 推导持久幂等或可回查能力。

## 3. 同一存储上的真实原生故事

新增 `test:bot-work-phase5-native-story`，三段真实子进程复用同一 SQLite 与 Pi Durable 存储，实际运行 `WorkHostAuthority / WorkDispatchQueue / WorkExecutionAdapter / DurableBotService`、生产 subagent、资源围栏和内建 write。模型返回与通知传输是可控 fixture，执行内核和工具效果不是假代理；没有用 SQL 拼 Work/native 终态。

父进程在两个检查点执行 `SIGKILL`，核对原 PID 消失、持久租约未正常释放且自然过期，然后恢复原命名空间。完整逐步身份、文件哈希、调用账本、预算和 kill 记录见 [原生证据](bot-work-phase5-completion-native-2026-11-08.json)。

| 检查点 | 模型调用 | 成功原生写入 | 恢复事实 |
| --- | ---: | ---: | --- |
| 原生提交已落盘、业务回执未写入 | 9 | 2 | 第一次真实强杀 |
| 恢复该提交 | 9 | 2 | 原 binding/task/store/conversation/submission 不变，零重复执行 |
| 验收/有限关闭/汇总意图已落盘、尚未投递 | 17 | 5 | 第二次真实强杀 |
| 恢复通知 | 17 | 5 | 只恢复通知；一个物理通知效果 |
| 附加输入来源反例完成 | 25 | 5 | 来源专项另 8 次模型调用 |

五次写入分别是 r1 历史结果、保留子项、缺口补跑、协作者修复与 Watch B，各一次；冲突写入的成功效果为零。A 实际 fixture 用量 70 tokens、B 10 tokens，恢复不重复结算。通知两次 attempt 为 failed→sent，复用同一非空 providerEffectKey/payloadHash，实际通知效果一次。

连续十步覆盖：同库立项与 B 对照；真实 Hook 去重与前台原生讨论；r2 要求变更；第一次强杀；r1 晚到历史归档；真实并行 child 冲突与仅补必要缺口；验收/实测等待；实际配对 HTTP Remote 失败反馈、修复中交接与旧产物 409；可信关闭 A、B 继续运行；第二次强杀后通知恢复及桌面 reducer/实际 Remote store 收敛。

附加来源测试经过真实 `DurableBotRuntime → durableDomainTools → conversation_goal_create → ConversationGoalService`：单输入可追溯，同 request 重放保留来源；无关输入、伪造 audit、伪造后追加 entry、跨 conversation、空输入均不能借用其他来源。在真实工具运行期间提交 steer，原生形成 `run.inputs=[8,14]`，该 Work 不设置 sourceMessageId。

原 `test:bot-work-phase5-e2e-story` 继续作为 **服务层观察 fixture**，更新团队成功关闭的 summary 预期，不再将它作为真实原生进程证据。它与上述强杀专项分别记载。

## 4. 最终门禁

| 命令/范围 | 最终结果 | 证据边界 |
| --- | --- | --- |
| `pnpm -s typecheck` | exit 0 | web、node、scripts，0 新增错误 |
| `pnpm -s test:architecture-graph` | 5/5，exit 0 | 1017 源文件、3769 依赖边；棘轮未放宽 |
| Remote `pnpm exec tsc --noEmit` | exit 0 | 手机客户端类型 |
| `node scripts/test-all.mjs --audit` | exit 0 | headless 354 / GUI 55 / NETWORK 29 / DATASET 2 / pending 0 |
| `pnpm -s test:all` | **353 passed / 1 failed / 0 known failed / 1 new regression；158.45 秒，exit 1** | 完整默认 headless 354 个；唯一失败为 AT-SPI，未选分类不计通过 |
| Phase 5 delivery / Gateway / owner summary | 34 / 13 / 17 场景通过 | 实际 SQLite 与适配器、受控 provider 传输 |
| 可信 review / React 生命周期 | 11 / 8 场景通过 | 服务守卫；真实 ReactDOM 点击+受控 API Promise |
| reconnect diagnostics / remote sync | 19 / 19 场景通过 | reducer、HTTP/API/store；真实手机待补 |
| 服务层故事 / 新原生故事 | 10 步 / 10 步通过 | 新故事真实三个进程、两次 SIGKILL；模型/通知 fixture |
| `test:db-schema-discard` | 7 场景通过 | schema 35 备份重建行为 |
| 真实 `pnpm dev` 探针 | **受阻，exit 1** | Electron singleton socket EPERM，实际 UI 检查数 0 |

新增业务、原生与 React 行为专项进入默认 headless；真实 pnpm dev 探针归 GUI。新原生强杀故事进入既有串行恢复池，未调整超时、失败白名单或架构基线。IPC 清单只增加经审阅的 `bot-work:review-control` 一个通道，没有移除或新增真实重复；运行时生成基线更新与失败白名单无关。

实跑 `BOT_WORK_DEV_HEADLESS=1 pnpm -s test:bot-work-phase5:dev` 使用隔离 HOME/userData。第一次 Node 默认堆不足，重新以 `NODE_OPTIONS=--max-old-space-size=6144` 启动 dev 到 Electron，随后宿主报：

```text
FATAL:chrome/browser/process_singleton_posix.cc:319
socket() failed: Operation not permitted (1)
```

探针 exit 1，`checks=[] / actualControlChecks=[]`，没有进入页面。新增 LinkeDOM 场景只证明真实 React 的异步生命周期和调用参数，不代表 Electron/preload/真实浏览器点击通过。

AT-SPI 在本轮源码与 `ac03fd5` 独立快照均失败，原始信息为 `Private dbus-daemon exited 1 ... Failed to open socket: Operation not permitted`。源码未修改该平台实现，也未把失败隐藏为通过。

## 5. BW-A01～BW-A46 与额外闭环

下表「组件通过」表示对应行为测试证据，不能自动推导物理设备或第三方账户验收。标明前序证据的 NETWORK 专项未冒充本轮新运行，实际执行列表以门禁 JSON 为准；完整门禁的环境失败仍按上一节计入。表中 ID 已逐行重新对照冻结验收，纠正历史表的 A01～A03、A16～A20 语义错位及 A12/A35 证据归属。

| ID | 事实 | 状态 | 证据 |
| --- | --- | --- | --- |
| BW-A01 | 同一 Bot 从多入口/对话查询同一 Work | 组件通过 / 实机待补 | phase1、remote-work-sync、native-story 双端收敛；真实设备/账户待补 |
| BW-A02 | 单对话两事项，卡片回复只修改引用目标 | 组件通过 | phase1 的 multi-chat/card-first/explicit Work；foreground-contract 双 Work 控制 |
| BW-A03 | 来源对话归档后 Work/职责继续存在 | 组件通过 / 窗口待补 | control R08 归档与存储重开；真实关闭窗口未在本轮验证 |
| BW-A04 | once / watch 生命周期 | 组件通过 | phase2/phase4 系列 |
| BW-A05 | 控制操作幂等与回执重放 | 组件通过 | review-control、phase5 delivery-dedup |
| BW-A06 | Bot 停用/删除不丢责任与在途记录 | 组件通过 | phase1/control、review-control 的停用守卫 |
| BW-A07 | 专家版本显式采用 | 组件通过 / UI 待补 | review-control 与 R09 版本冲突守卫；dev 页面受阻 |
| BW-A08 | 协作资料隔离（Memory/私有上下文） | 组件通过 | phase3-collaboration |
| BW-A09 | 前后台分离，查询只读 | 组件通过 | phase5 e2e-story 第 2 步 |
| BW-A10 | 独立后台原生 children 与递归边界 | 原生核心通过 | native-story 真实 children/生产 write；递归限制沿用 durable-subagent 前序证据 |
| BW-A11 | 只读查询不派发任务 | 组件通过 | e2e-story 第 2 步 |
| BW-A12 | 供应商分类、有界原生补试与 recovered | 前序组件证据 | durable-subagent 的 quota retry/recovered/plain failure；本轮 phase2-usage 与 phase4-shared-budget 回归 |
| BW-A13 | 单权威宿主 | 组件通过 | phase2-recovery、phase4 hook-fanout |
| BW-A14 | Outbox 崩溃边界 | 组件通过 | phase2-recovery |
| BW-A15 | Submit 回执窗口与恢复前取消 | 原生通过 | native-story 第 4 步真实 SIGKILL；phase2-recovery accepted-cancel 核对/停止 |
| BW-A16 | 终态送达/持久接收/游标边界恢复 | 组件通过 | phase2-recovery 的 before-result、received、cursor-transaction |
| BW-A17 | Inbox 重复与消费/Work/Outbox 原子性 | 组件通过 | phase2 重复 Inbox；phase2-recovery consume-transaction |
| BW-A18 | 幂等可回查效果响应丢失后恢复 | 组件通过 | phase2-recovery effect-receipt，按原效果身份核对 |
| BW-A19 | 不可回查效果保留 unknown，禁止盲重试 | 组件通过 | phase2-recovery effect-unknown、phase5 delivery-dedup |
| BW-A20 | 多 root 同数字 conversationId 的命名空间隔离 | 组件通过 | phase2-invariants 两个 conversationId=1 的隔离断言 |
| BW-A21 | 旧决定被版本/代次拒绝 | 组件通过 | e2e-story 第 8 步 |
| BW-A22 | 遥测隔离 | 组件通过 | phase2-usage |
| BW-A23 | 旧要求结果不覆盖当前 | 组件通过 | e2e-story 第 5 步 |
| BW-A24 | 取消与结算 | 组件通过 | review-control、phase3-recovery-control |
| BW-A25 | 歧义引用拒绝 | 组件通过 | phase3-handoff |
| BW-A26 | 暂停积压 | 组件通过 | phase3-pause-backlog |
| BW-A27 | 交接与 adoption | 组件通过 | phase3-handoff、e2e-story 第 8 步 |
| BW-A28 | 发送前重验发送者/版本/产物 | 组件通过 | delivery-dedup、e2e-story 第 10 步 |
| BW-A29 | 局部写冲突与不同 dispatch/隔离模式 | 原生核心通过 | native-story 生产 child/write 冲突；subagent-write-conflict 与 durable-subagent 前序多模式证据 |
| BW-A30 | 跨 Work/root 的文件、Shell、别名与多资源保护 | 组件通过 | phase3-resource-gate 的真实文件/版本/资源准入；桌面输入接管另见 A31 |
| BW-A31 | 桌面焦点/释放 | 受阻 | 需 Windows 隔离真实窗口会话 |
| BW-A32 | 仓库约束（分支/worktree 授权） | 组件通过 | phase3-handoff、review-control |
| BW-A33 | 部分成果、启动前拒绝与定向补跑 | 原生通过 | native-story 保留产物与仅补缺口；phase3-native-settlement / partial-settlement 的 rejected/chain |
| BW-A34 | 版本匹配的实机实测 | 部分 / 实机待补 | e2e-story 反馈绑定；Omarchy 未跑 |
| BW-A35 | 应用外文件/产物变化使旧证据失效 | 原生/组件通过 | phase3-native-settlement 外改后 artifact_revalidation；phase3-resource-gate 内容指纹/保持 mtime 外改/别名 |
| BW-A36 | 真实 Hook 扇出与水位 | 组件通过 | phase4-hook-fanout |
| BW-A37 | 离线补处理 | 组件通过 | phase4-offline-catchup |
| BW-A38 | 时区/时钟/期限 | 组件通过 | phase4-schedule-clock |
| BW-A39 | 因果防环 | 组件通过 | phase4-causal-guard |
| BW-A40 | 共享预算 unknown/迟到回执 | 组件通过 | phase4-shared-budget |
| BW-A41 | 合并与背压 | 组件通过 | phase4-backpressure |
| BW-A42 | 成果接纳与唯一卡片 | 组件通过 | phase5 delivery-dedup |
| BW-A43 | 渠道能力/unknown/人工重发 | 适配通过 / 真实账户待补 | delivery-dedup 34 + Gateway 13，实际生产 adapter/受控传输 |
| BW-A44 | 汇总与阅读隔离 | 组件通过 | owner-summary 17、阅读事务/Journal、真实交接准入 |
| BW-A45 | 桌面/移动重连 | 组件通过 | reconnect-diagnostics + remote-work-sync；真机 blocked |
| BW-A46 | 分层诊断与未验证范围 | 组件通过 | reconnect-diagnostics、WorkCardsPanel |
| 额外 | 冻结验收 §9 十步 | 原生通过 / 实机待补 | 新 native-story 同库/原生/两次真实强杀；模型/传输 fixture |
| 额外 | R09 专家配置审阅/采用 | 组件通过 / UI 待补 | BotExpertReview + adoptExpertVersion 守卫；dev 点击受阻 |
| 额外 | R10 重连 | 组件通过 | reconnect-diagnostics |
| 额外 | UI-01～UI-10 双页面 | 局部 DOM 通过 / 实机受阻 | 评审实际 React 生命周期专项；完整 pnpm dev 点击未进入页面 |


## 6. 数据变更与仍需实机取证的边界

**schema 35 会按仓库既有契约把旧 schema 库及 WAL/SHM 改名为 `.discarded-<UTC>` 备份，再重建空库。** 本轮未添加旧版本迁移；旧文件不会被直接删除。`test:db-schema-discard` 验证备份、边文件、当前库不重建和备份失败原库保留。拉取后首次启动的这一行为须与功能交付一起告知用户。

| 项目 | 本轮事实 | 需要的后续环境/复验 |
| --- | --- | --- |
| Windows 恢复/BW-A31 | Linux 原生强杀已过；未操作 Windows 真实窗口 | Windows 隔离桌面运行恢复与焦点/输入释放专项 |
| Omarchy / Hyprland | 业务/协议 fixture 通过，不是物理实测 | 真实 Hyprland/AT-SPI 会话、隔离靶窗、当前版本反馈 |
| pnpm dev 页面 | 实际启动受 singleton socket EPERM 阻断 | 有权限桌面运行 `pnpm -s test:bot-work-phase5:dev`，保留截图与 actualControlChecks |
| 真实手机 | 实际 HTTP 配对/反馈/重连协议和 Remote store 通过 | 真实手机/Tailscale、断网、宿主重启、能力撤销后的重连 |
| 真实外部渠道 | 五类生产适配与 fixture 请求/回执通过 | 已授权真实账户/目标、发送、响应丢失与人工对账证据 |
| 真实 provider 用量 | 原生 fixture 父子用量、预算隔离和恢复通过 | 实际供应商原始用量/原窗口及迟到/矛盾核销凭据 |
| 发行包 | 未执行，未取得本轮发布授权 | 另行明确发布后验证实际包；本次不自动 build/pack/dist |

上述缺证不是新增 TODO 代码被隐藏；它们仍阻止声明 BOT-WORK-1.0 全平台整体验收完成。不得用之前 Windows 历史全绿、当前 DOM 测试或 fixture 中的「Omarchy 通过」替代真实设备事实。

## 7. 冻结与可复验性

- 实现提交：**[fff50d77538654565a562b2122109fea302576a7](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/fff50d77538654565a562b2122109fea302576a7)**。
- 源码清单：[逐文件 SHA-256](bot-work-phase5-completion-source-2026-11-08.json)，聚合指纹 **63e9f19008091bab17ab9327b2ccc77ebdd654a924e5c2e1f1ec207326928cca**；排序后的 `files` 紧凑 UTF-8 JSON（ensure_ascii=False，分隔符 `,`/`:`）计算。
- 原生证据：[三段宿主/两次强杀记录](bot-work-phase5-completion-native-2026-11-08.json)。所有路径和 ID 均来自隔离测试，文件已清理时仍保留账本事实。
- 完整门禁记录：[本轮命令与退出码](bot-work-phase5-completion-gates-2026-11-08.json)。原始日志在 `out/diagnostics/bot-work-phase5-completion/`，dev 与 native 的原始日志分别在对应子目录。
- 前序冻结继续保留：[原 Phase 5](bot-work-phase5-2026-11-07.md)、[第一轮加固](bot-work-phase5-followup-2026-11-08.md)。本轮不把历史运行改写成新代码的验证结果。
