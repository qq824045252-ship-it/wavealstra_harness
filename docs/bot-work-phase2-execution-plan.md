# Bot / Work — Phase 2 执行规划（供 Codex 实施）

> 状态：**Approved plan / M1～M3 已实施，Phase 2 Windows 组件验收通过**
> 制定日期：2026-11-07（Asia/Shanghai）  
> 审核代码基线：`main@ac2b4583460f38a54ea797c1a09826e6920a6d62`  
> 范围：Phase 2 —— **真实前台独立对话、受守卫的 Work 控制工具、独立后台 root、事务 Inbox/Outbox 与结果事件闭环**。  
> 2026-11-07 按第 7 节完成本阶段门禁，证据见 [Phase 2 验收记录](reviews/bot-work-phase2-2026-11-07.md)。这不代表后续阶段或全部平台验收通过。

本文件是给 Codex 的**实施任务书**，不是第二份产品真源。按优先级服从 [架构冻结设计](bot-work-design.md)、[冻结验收 BW-A01～BW-A46](bot-work-acceptance.md)、[双页面 UI 规范](bot-work-ui.md)、[Phase 1 复审修复记录](reviews/bot-work-phase1-2026-11-07.md) 以及仓库根目录 `AGENTS.md`。不得通过修改冻结行为语义、降低失败基线或替换执行内核来“完成”本计划。

## 0. 不可突破的约束

1. **不做旧数据、旧 Pi 兼容。** 当前仅支持仓库锁定的 **Pi 1.5.0**。缺少依赖或缓存是环境阻塞；依照 lockfile 安装/恢复真实依赖后验证。**禁止**创建 Pi 1.3→1.5 的 `.d.ts` 伪兼容垫片、改运行版本校验、改 lockfile 来掩盖缓存差异，或把 blocked 写成 passed。
2. **单一真源。** `BotRegistry` 管 Bot 身份，`WorkService`/SQLite 管 Work、控制状态、证据与验收；既有 Pi Durable 管真实执行、原生 submission、checkpoint、owned child 与恢复。不得新建第二套 worker 引擎、恢复日志或用伪造普通 Task / Durable conversation ID 当 Bot 或 Work 身份。
3. **前台不能执行长业务工具。** 前台只完成独立 Bot 交流、获授权的已知事实读取和有限 Work 控制。联网调查、代码/文件写入、桌面/浏览器实际操作等进入受守卫的后台 root。普通交流不强制建 Work；前台不等待后台完成。
4. **宿主、身份和并发不降级。** 保留 Phase 1 的可信 actor、单主宿主租约、写事务内权限/版本 CAS、幂等 operationId、Memory 隔离、专家快照、有效执行绑定。模型只能提出控制参数，不能自行指定/提升用户身份、授权或当前版本。
5. **恢复不重跑逻辑工作。** 可补投递、可重复读取、不可盲目重新执行；原生会话查回使用完整执行命名空间。外部效果不可确定时维持 `unknown`，有界回查、阻碍可见，不推断“超时=未发生”。
6. **受影响的资源写入先串行。** Phase 3 完整跨 root 资源门控尚未完成时，同一可变工作区、浏览器会话和桌面设备不能无约束并行。允许已证明隔离的只读并行；无法验证隔离时按受管资源串行，不能宣传已有 `write-conflict` 为全局锁。
7. **不做发布操作。** 根据 `AGENTS.md`，本次 Codex 开发任务不自动升级版本号、不打包、不安装、不改快捷方式；验证以 typecheck/相关测试为主，必要的交互预览使用 `pnpm dev`。用户未明确授权发布时不执行 build/pack/dist/release。只在用户明确授权提交/推送时按仓库当前工作流操作。

## 1. 已有基础（不要重复造轮子）

以 `ac2b458` 为准，**已存在**：

- `AgentService.ts` 创建并使用 `BotRegistry`、`WorkHostAuthority`、`WorkService`、`BotWorkContextService`；已有 Bot/Work 查询、验收与通知等 IPC。`resumePersistedTasks()` 已实例化 `WorkExecutionAdapter`、调用 `DurableBotService.workExecutionPort()`，然后恢复原生持久执行。
- `src/main/agent/work/WorkExecutionAdapter.ts` 已做绑定持久化后的 `flush`/轮询、原生 `prepare/find/submit/inspect/stop`、取消恢复先核对原回执、结果与结算的业务事务。**仓库不存在单独的 `DurableWorkExecutionAdapter.ts` 文件，不得按旧规划再建立同义适配器。**
- Phase 1 已处理事务内租约检查、worker 身份绑定、停用 Bot 拦截、显式续权、历史成果失效、原生区间分页读取、共享 Memory 写保护与 renderer 刷新竞态。**移除旧 Milestone 2.1 中重复“补控制层漏洞”的任务**，但在新端到端链路中继续做回归验证。
- `src/renderer/src/store/app/slices/activeContext.ts` 的 `submitBotDraft()` **仍仅设置草稿提示，不发送消息**；`refreshSequence` 拒绝过期刷新，但**没有**持久跨端列表 watermark/tombstone 协议。
- `src/shared/bot-work.ts` 的 `CreateWorkParams`、`AmendWorkParams` 已有 `inputSnapshotId`/`causalEventId`；不能把“新增这两个字段”写成完成多 `steer` 归属。
- `WorkService.reconcileExecution()` 当前对重复 `unknown` 和旧状态回放还不是统一事件消费者：新推流接入前必须增加稳定事实去重、终态/顺序保护，并消除预算预留错配风险。
- 既有 `test:durable-bot` 额外探查出现 busy/idle 及 fork store 断言问题，且 Phase 1 复审环境的 Pi 缓存为 1.3。必须在符合锁定依赖的环境中复现、修复或明确记录真实阻塞，不能用兼容声明“变绿”。

**明确缺口**：独立 Bot 前台持久消息与真实发送、受守卫工具白名单、事件驱动的后台业务受理/派发闭环、持久结果统一消费、前端列表可靠增量与恢复协议、对应真实集成验收。

## 2. 目标流与身份映射

```text
用户 / 桌面 Bot 页面 / 已绑定渠道
  -> 可信入口 + Bot 长期对话记录（真实持久消息；不造 Work）
  -> 前台 Bot（仅答复 / 查询 / 结构化控制工具）
  -> WorkService：身份/授权/版本 CAS + operationId 去重
  -> 同一业务 SQLite 事务：Work 决定 / inbox 处理 / outbox 意图
  -> WorkExecutionAdapter：唤醒派发（原生 find / submit / inspect）
  -> 独立 Durable root -> 现有 owned children / 工具准入 / 预算 / 资源
  -> 原生持久回执/事件（实时通知仅唤醒）
  -> 统一持久结果接收：去重/有序结算/成果/预算/后续 outbox
  -> Work 权威投影 + Bot 消息/Work 卡片（支持补读与重同步）
```

至少区分以下身份，**不得合并为同一个随机 ID**：

- `botId`：长期负责人；`botConversationId` / `messageId`：交流事实与 UI 引用；`workId`：长期业务事项。
- `operationId`：同一结构化业务决定的重发去重；`sourceEventId` / `inboxEventId`：事实来源与业务处理去重；`causalEventId`：因果关系。
- `inputSnapshotId`、`intentRevision`、`stateVersion`、`ownerEpoch`：本次要求/输入/控制/负责人版本，各有不同语义。
- `bindingId`、`submissionId` 及 `(taskId, durableStoreKey, conversationId, workspaceBinding)`：**完整原生执行命名空间**，可扩展 epoch；即使多个 root 的 conversation 数字相同也不可串扰。
- `effectId`、`reservationId`：外部效果幂等回查和**准确对应的预算预留**。即使业务 Work 被取消或旧要求失效，这些身份仍必须可查回结算。

## 3. 开发前环境门禁（准备条件，不是产品兼容功能）

- 核实 main 与 `ac2b458` 后的新增变更；不要覆盖 Codex/其他开发者的新修改。恢复与 lockfile 一致的依赖和 Pi 1.5.0；不创建旧版本 shim。
- 执行并分别记录 `pnpm -s typecheck`、`pnpm -s test:bot-work-phase1`、`pnpm -s test:bot-work-review-control`、`pnpm -s test:bot-work-review-execution`、`pnpm -s test:bot-work-review-memory`、`pnpm -s test:bot-work-review-projection`、`pnpm -s test:bot-work-execution`；`test:durable-bot` 先核实分类和依赖，覆盖 busy→idle 与 fork store 两个断言。
- 环境阻塞用 `blocked` + 缺少的具体包/版本/命令报告，不得新增 `test-baseline.json` 条目、放宽断言或擅自改 `EXPECTED_PI_VERSION`。
- 文档修改本身不要求伪称完整测试已运行。功能开发后才运行本任务定义的联调门禁。

## 4. M1 — 独立前台 Bot 对话与控制工具（必须真接线）

### 4.1 主进程与协议

- 在现有身份/权限体系上建立**持久 Bot 对话**：稳定 `botId`、对话 ID、客户端消息 ID、用户/助手消息、Work 引用、发送状态、恢复游标。普通问答可以只留下对话消息；不能用当前 `Task` 记录或 `welcomeMode="bot"` 代替长期 Bot 会话。
- 主进程提供并实际挂载：发送 Bot 消息 / 查询历史 / 查询 Work / 结构化控制回执等最小 IPC；加入既有 preload/types/renderer 接线与 IPC 通道清单。使用稳定请求 ID 处理重发，提交成功后 UI 才清空对应草稿；错误和未知回执保留可重试的原请求身份。
- 前台模型回合与后台执行会话完全分离。重用已有模型与提示/记忆/专家装配能力，不重造新执行内核。前台只能获得可见且被授权的当前 Bot 私有/Work 事实，不能自动拿到所有项目或别的 Bot 个人记忆。
- 强制**代码层能力白名单**：状态/已知成果/预算/历史查询，以及 `work_create`、`work_amend`、`work_pause`、`work_resume`、`work_cancel`（如确需其他工具，先按冻结设计及验收显式扩展）。不能只靠 system prompt 或 bot mode 文案禁止长工具；网络/文件/桌面实际动作必须走后台并受准入。
- 将模型生成的控制决定映射到已有 `WorkService`：actor 来源于可信宿主、真实用户/渠道身份和持久绑定；对既存 Work 的变更使用**模型读取时的** `(stateVersion,intentRevision,ownerEpoch)` 三元守卫，提交时仍在写事务内复核；冲突返回新快照后重新判断，不用“拿最新版本重试原决定”绕过 CAS。`createWork` 不凭空补不存在的历史版本守卫。
- 实施多 Work 消歧：稳定 `workId` 与卡片/消息引用优先，明示选中 Work 次之；用户“停一下”有多个有效候选时只澄清，**不得默认全局暂停/取消**。
- 权限策略：模型请求不能扩大授权、假冒用户执行续权、代替用户验收、修改其他 Bot 的 Work 或触发未授权副作用；停用的 Bot 不接受新业务动作，但既有结果仍可核对结算。

### 4.2 Bot 页面

- 复用已存在的独立 `page="bot"` 页面与 `activeBotId`/`selectedWorkId`，**替换** `submitBotDraft()` 的草稿占位为真实持久发送；持久显示前台回复、受理回执、Work 卡片和失败/离线事实。
- 普通 Task 输入草稿/选择和 Bot 草稿/选择严格隔离；切页、切 Bot、重复点击发送、取消发送、重开页面及乱序回执不能串发送给其他身份。
- 同一对话可引用 Work A/B；归档对话**不会取消或删除 Work**；普通交流不强制建 Work。右侧 Work 详情从 `WorkService` 权威投影读取，不把 Durable 原生运行结束当作 Work 验收通过。
- 本阶段要求**真实可用的发送与控制闭环**；Phase 5 仍负责完整响应式/移动体验、通知体验与跨端交互精修，不能用“Phase 5 再做 UI”推迟实际 Bot 前台接线。

### 4.3 M1 验收

- `BW-A02`、`BW-A05`、`BW-A09`、`BW-A11`、`BW-A21`、`BW-A25` 与 `UI-03/04/05/09` 的适用内容有行为测试。
- 真正的前台普通提问得回复且不产生 Work；委托经控制工具落盘并产生受理回执；后台根执行未完成时仍能查询、开另一个 Work、修订和取消。
- 重发同一请求无第二份 Work/消息/控制效果；篡改 actor、伪造/过期版本、跨 Bot 目标、过期授权被拒绝；普通 Task/Gateway 旧入口不回归。

## 5. M2 — 后台独立 root、事件消费与原生恢复

### 5.1 业务派发与原生执行

- 复用 `WorkExecutionAdapter` + `DurableBotService.workExecutionPort()`，在 `work_create`/`work_amend` 受理后**落盘绑定及 Outbox**，唤醒后台派发。单纯定时 `flush` 不能作为唯一工作启动触发；轮询保留作兜底恢复，不另造 Durable 重试内核。
- 独立 Durable **root** 执行 Work（复杂工作可调用现有 owned children；child 继续禁止递归委派）；前台不作为其父工具长时间等待。对同一 Work 不得因失败而分配新的逻辑操作 ID 重放原业务。
- 业务库事务与 Durable JSONL 不存在跨存储的虚构原子性。启动前重新确认 Work lifecycle、授权、要求版本和宿主 lease；提交响应丢失后先在**原 task/store/conversation/workspace + operation** 命名空间 `find`，不得无凭据换会话投递。
- 暂停/取消后禁止新的业务效果准入，但对已经尝试的提交仍 `find→inspect→必要时 stop→inspect→reconcile`；停止不意味着已发出的外部请求撤销。终态已完成时先读回成果，再决定是否需要 stop，不能先 stop 破坏已完成回执。
- 实际工具准入必须继续涵盖适用的主机工具、MCP、Codemode 嵌套调用和子任务。Phase 3 资源门控上线前，无法证明互斥/隔离的可变资源实行串行或阻止派发；并行只读不得被无谓锁死。

### 5.2 单一持久结果消费者（实时 + 补读同入口）

- 原生 `onSettled`/事件推流只负责**唤醒**统一结果消费；启动恢复、定期 `inspect`、事件推送**共享同一批稳定事实身份与持久 Inbox 消费边界**。不能并列写出两条各自调用 `reconcileExecution()` 的结算路径。
- 用完整执行命名空间 + 原生 `submission/event/entry` 身份构成去重键，并持久保存已接收身份、可恢复游标或可信恢复位置；先存可靠接收记录，再允许推进游标。一个 SQLite 写事务中完成**去重标记 / 成果证据 / 执行状态 / 精确预算结算 / 后续 Outbox / 消费标记**，失败时全部回滚。
- `completed/failed/stopped` 等已确认终态不能被迟到的 `running/unknown` 或另一路重复事实回退；重复 `unknown` 不能生成多个相同 blocker 或无意义增加 `stateVersion`。未确定的外部效果仍保持可见的 `unknown` 阻碍，不“成功”或“失败”猜测性降级。
- 结果正文和已保存的 evidence 不等于 Work 验收。当前要求变更后，旧结果保留在历史但不自动满足新条件；旧负责人结果按有效委派和当前要求判定。已有 `supersedeStaleDeliverables` 的规则必须继续适用。
- **预算身份必须精确**：每个执行绑定关联相应 `reservationId`，提交结果只能核销该预留；不能按“本 Work 第一笔 reserved”猜测。重放和乱序不能重复扣费，`unknown` 保留待核算额度；真实 SDK 用量的更大范围项目仍属 Phase 4。

### 5.3 多次 `steer` 与输入因果

- 已有 `inputSnapshotId`、`causalEventId` 只是标签。Pi 一个 turn 内多个 steer 可能共享同一 `answer`，区间扫描不能自动证明某件产物只属于其中某条输入。
- **Phase 2 保守默认**：对影响同一 Work 要求的输入，使用 `amendWork` 提交新的版本/快照并失效受影响执行，旧执行按原绑定停止/查回/结算，新执行按独立绑定重新安排；不把共享 answer 直接判给某个输入。
- 如果选择支持同轮多 steer 的细粒度结果归属，必须在**每次受守卫工具调用/效果准入**时持久记录 `bindingId`、生效 `inputSnapshotId`、`intentRevision`、工具调用/效果 ID，按这些事实分配成果。无法证明的证据保留“归属不明/待核验”，**不得自动接纳**。不得通过仅新增 UUID 字段宣称已解决。
- 控制消息（暂停/恢复/查询）各有稳定操作身份，但不能一律制造新的业务输入快照；消息 ID、操作 ID、要求版本和输入快照四者职责分明。

### 5.4 外部效果与真实故障窗口

- 有业务幂等/可回查的工具：持久效果身份 → 提交 → 失响应后查回原效果/回执 → 结算，不再执行一份副作用。
- 不支持幂等、无法可信读回的工具：第一次可能投递就记录不确定状态；超时、取消和重启后保持 `unknown`，有限次/期限核验用尽形成 blocker，禁止业务层盲重试。
- 对 `BW-A13～BW-A20` **全部**逐一做故障注入：宿主双主、Outbox 已提交投递前、Durable 已受理业务回执丢失并追加取消、结果送达前/持久接收后/游标边界、Inbox 消费事务中断、可回查效果丢响应、不可回查效果超时、两 root 相同数字 conversation ID。使用**关闭并重开实际存储**与实际效果计数，不只断言“方法被调用”。
- `BW-A12` 验证 Durable 原生分类/重试边界、recovered 证据、预算和期限未重置；业务层不能叠加第二套无限或无条件重试。

## 6. M3 — 投影水位、列表移除与阶段联合验收

- Phase 2 IPC 数据协议预留并实际使用**稳定、可持久恢复的单调投影序号/水位**：为明确的用户/列表作用域定义 `projectionEpoch`、`sequence` 或等价有序事件日志；快照在一致读取边界返回 `watermark`；增量带作用域和序号；Gap/新 epoch 必须触发全量补读。**不得**用某个 Work 的 `stateVersion` 当列表全局水位，也不得直接借用进程内 `RemoteEventBus.nextId` 作为跨重启序号。
- 视图成员移除事件必须带稳定 `workId`、作用域、原因/成员关系和版本水位：例如 open-only 过滤视图因 Work 关闭而移除。`tombstone` 指**视图成员变化**，不是物理删除 Work；归档 Bot 对话不等于 Work 消失或后台停止。
- Renderer 对同一作用域按快照水位与增量序号合并；重复包无效果，旧包不得复活已移除卡片，缺口重拉；保留 `refreshSequence` 的本地防乱序和通知 readAt 单向性。状态缺证据时呈现 unknown/offline，不假造“正在运行”。
- Phase 2 完成最小可靠 IPC 与 renderer 更新；Phase 5 仍负责真实手机/多端网络重连、完整通知体验与全部 UI-08 故事。提前冻结字段结构，不假称 Phase 5 已验收。
- 增加端到端组件测试：Bot 页面发送→可信控制受理→同一 Work 的原生 root 真启动→可查询/修改/取消→事件消费或崩溃补读→成果证据入库→最新投影收敛；普通模式及 Gateway 旧路径不回归。

## 7. 验收矩阵与完成门禁

| 场景 | Phase 2 实施证明 | 不得拿来充数的证据 |
| --- | --- | --- |
| `BW-A09～A11` | 前台独立回合，后台运行时并行查询/新委托/控制；root/child 不越界；受控查询不启动业务工具 | 静态 Bot UI、只有占位按钮 |
| `BW-A12` | 原生重试分类、有界恢复和预算/期限证据 | 业务层重新提交一次算“恢复” |
| `BW-A13` | 多客户端/多 SQLite 连接下单主 lease 与事务 CAS | 只在单进程对象里检查布尔状态 |
| `BW-A14` | Outbox 提交后、原生投递前强制重启，逻辑工作只有一个 | 无持久重开模拟 |
| `BW-A15` | 原生已受理但业务回执丢失并发生取消，原绑定查回/停止/结算 | 取消后直接跳过查回 |
| `BW-A16` | 送达/持久接收/消费水位三个崩溃窗口，结果不跳过、不重写、不重复 | 只凭 onSettled 内存通知 |
| `BW-A17` | Inbox 处理/Work/Outbox 一笔事务、重复事件与失败回滚 | 先记“已处理”后异步发工作 |
| `BW-A18～A19` | 可回查效果一次；不可回查保留 unknown 与有界 blocker | timeout 当失败并自动重试 |
| `BW-A20` | 相同数字 conversation ID 的两个 root 完整命名空间隔离 | 仅用 conversationId 拼键 |
| 关联：`A02/A05/A21/A23/A24/A25` | 多 Work 消歧、稳定操作身份、旧决定拒绝、旧成果隔离、取消副作用门禁 | 只调用单个 service mock |
| UI：`UI-03/04/05/09` | 真消息、独立草稿、列表收敛、普通模式不回归 | 截图或纯静态源码关键词 |

### 要求 Codex 交付的证据

1. 在真实临时 SQLite + Durable JSONL + 本地确定性模型/工具 fixture 上验证核心链路；涉及真实进程恢复的场景必须**强杀/重启并重新打开**，记录实际效果次数和身份映射。fixture 可以证明契约，但不能代替真实 Pi 1.5 运行时。
2. 为 M1/M2/M3 适量新增行为测试和 `package.json` 测试命令，并遵守既有 headless/GUI/NETWORK 分类；不修改失败基线绕过错误。优先以用户可观察结果和数据库真实状态断言。
3. 执行 `pnpm -s typecheck`、`pnpm -s test:all`、所有相关 Bot/Work 回归与新增测试；分类明确的网络/GUI/真实 Omarchy/移动端测试按环境能力执行并报告 passed/failed/blocked/not-run，不得静默 skip 或把旧记录算当前通过。
4. 完成代码后新增 `docs/reviews/bot-work-phase2-2026-11-07.md`（如完成日不同可调整日期），逐项记载**代码 SHA、实际运行环境、每个 BW 场景/故障注入、原生与业务状态/效果计数、结果、失败与未运行项**，并同步更新 `docs/bot-work-implementation.md` 的阶段状态；不得篡改原 Phase 1 历史证据。
5. 本阶段通过不等于 `BOT-WORK-1.0` 整体交付。Phase 3 仍负责全面跨 root 资源门控与团队交接，Phase 4 为订阅与真实用量，Phase 5 为跨端/通知及最终全部 BW-A01～A46 与第 9 节 10 步端到端故事。

## 8. Codex 执行任务（可逐项勾选）

- [x] **P2-00 环境**：核对当前 main，恢复 Pi 1.5 锁定依赖，跑基线并记录受阻项；不做 1.3 类型垫片。2026-11-07 已核实本机真实 1.5 依赖、修复预检发现的问题并通过基线，见[预检记录](reviews/bot-work-phase2-2026-11-07.md)。
- [x] **P2-01 消息**：持久 Bot 会话、稳定发送请求、回复/历史、IPC/preload/renderer 真发送，不借普通 Task 身份。
- [x] **P2-02 工具**：前台代码白名单；查询与 `work_create/amend/pause/resume/cancel` 串接 `WorkService` 的真实 actor/CAS/幂等。
- [x] **P2-03 交互**：多 Work 引用/消歧、页面/草稿隔离、卡片和当前权威投影；普通 Task 不回归。
- [x] **P2-04 派发**：Work 受理→Outbox→独立 Durable root→原生 children；沿用 `WorkExecutionAdapter`/原生存储，不双重重试。
- [x] **P2-05 消费**：实时唤醒和重启补读合流；持久去重/水位、事务成果/状态/预算/后续 Outbox；旧状态不回退、unknown 不重复。
- [x] **P2-06 证据**：输入变更后的独立执行归属或明确拒绝伪归属；完整命名空间、精确 reservation、外部效果回查/unknown。
- [x] **P2-07 同步**：持久作用域水位、列表成员 tombstone、补读/缺口恢复、跨页面事件不串扰。
- [x] **P2-08 验证**：BW-A09～A20 全部，关联 A02/A05/A21/A23/A24/A25 和 UI 项；真实重启/崩溃注入；回归/typecheck/test:all；写 Phase 2 证据报告。

### 代码定位（先读现有实现，复用后改造）

| 范围 | 起点 |
| --- | --- |
| 主服务组装和启动 | `src/main/agent/AgentService.ts`，`src/main/index.ts` |
| Bot/Work 真源及权限 | `src/main/agent/work/BotRegistry.ts`，`WorkHostAuthority.ts`，`WorkService.ts`，`WorkRepository.ts` |
| 派发和原生读回 | `src/main/agent/work/WorkExecutionAdapter.ts`，`src/main/agent/durable/DurableBotService.ts`，`DurableWorkExecutionProjection.ts` |
| 共享协议和 IPC | `src/shared/bot-work.ts`，`src/shared/bot-work-ipc.ts`，`src/preload/` |
| 独立 Bot 页及 store | `src/renderer/src/components/pages/`，`src/renderer/src/components/bot/`，`src/renderer/src/store/app/slices/activeContext.ts` |
| 权限/记忆/工具恢复 | `src/main/agent/ConversationGoalService.ts`，`src/main/memory/`，`docs/durable-tool-recovery.md` |
| 用例和测试分类 | `scripts/bot-work-*.ts`，`scripts/test-all.mjs`，`package.json` |

**Codex 完成定义**：以文档第 7 节的可执行验收为准，不能以目录、类型、静态 UI 或“原 Phase 1 已通过”代替 Phase 2 的真实业务链路。若某冻结验收条件超出当前环境，保留 `blocked` 和准确证据，不能自行删除或重新解释。
