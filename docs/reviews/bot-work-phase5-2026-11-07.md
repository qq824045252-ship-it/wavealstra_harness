# Bot / Work — Phase 5 执行复核（2026-11-07）

> 最新补全记录见 [Phase 5 功能补全与原生验收复核](bot-work-phase5-completion-2026-11-08.md)：五类 Gateway 出站、独立负责人汇总、用户评审入口及真实原生十步故事已补齐。本文保留本轮历史事实；当前门禁与未完成实机边界以上述最新报告为准。

> 首轮状态（2026-11-07 Windows 历史记录）：**实现完成，headless 347/0/0/0；实机（Windows 强杀、Omarchy/Hyprland、真实手机、真实外部连接器）证据仍未取得，Phase 5 整体验收未完成。**
>
> 执行日期：2026-11-07（Asia/Shanghai）。规划基线 `main@02c40ed`（父提交 `57e6fbb`，代码零漂移）。首轮受测实现冻结：[`f561cc7a2c03d644d724302eb6b0ae92f636dc1c`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/f561cc7a2c03d644d724302eb6b0ae92f636dc1c)（§6 指纹）。
> 冻结设计/验收：[design](../bot-work-design.md)、[acceptance](../bot-work-acceptance.md)、[Phase 5 规划](../bot-work-phase5-execution-plan.md)。
>
> 后续加固（2026-11-08）：实现冻结为 [`877f2cf82d0a586cf305c8ea3b7d59688bcd24b7`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/877f2cf82d0a586cf305c8ea3b7d59688bcd24b7)，最终 Linux 全量 **348 passed / 1 failed，exit 1**（原基线亦复现的 AT-SPI socket EPERM）。本页正文保留首轮证据；桌面渠道能力、移动端控制/隔离、回包裁剪和最新门禁以 [Phase 5 加固复核](bot-work-phase5-followup-2026-11-08.md) 为准。

## 1. 交付内容

| 规划项 | 状态 | 事实 |
| --- | --- | --- |
| P5-00 schema 与共享契约 | **完成** | schema 33→34：`work_result_cards`（`semantic_card_key UNIQUE`，唯一阅读写入点）、`work_notification_effects`（provider 效果身份，initial 每通知唯一）、`work_owner_summaries`；`work_notifications` 增 `card_key/effect_key/target_key`；`work_notification_attempts` 增 `provider_effect_key/payload_hash/delivery_guarantee/claim_generation` 并去掉 `idempotency_key` 的全局 UNIQUE。契约在 `src/shared/bot-work-phase5.ts`。 |
| P5-01 原子成果接纳与唯一卡片 | **完成** | 卡片写在 `acceptDeliverable`/`closeWork`/`reportBlocker` 的 `.immediate()` 事务内；accepted→closed 复用同一 substantive 卡片，cancel/ended 独立；重放/回滚/双连接唯一性/内部进展不生成卡片均有测试。 |
| P5-02 生产投递与 unknown | **完成（桌面渠道）/ 部分（外部连接器）** | `WorkNotificationHost` 已在 `src/main/index.ts` 随宿主启动、随 projection 唤醒、退出时停止；`createDesktopWorkChannel` 用既有 `NotificationService` 落库通知，效果键即 dedupeKey，重启靠回读结算；能力矩阵（`idempotent-queryable / idempotent-unqueryable / best-effort-unqueryable`）矛盾或“声明可回查却无 lookup”直接失败；unknown 不自动重发；人工重发需 `acknowledgedDuplicateRisk` + 受控 operationId + 版本守卫；迟到回执按 `attempt_id + claim_generation` 结算。**未完成**：真实 Gateway/外部连接器的 Work 出站适配器与真实回查契约证据。 |
| P5-03 汇总与阅读 | **部分** | 持久汇总水位（digest）、待决阻碍 → 唯一 escalation 卡片、`markWorkCardRead` 零控制副作用、主机时钟压制、倒序不倒退、越权拒绝、closed 可读，均已测试。**未完成**：多专家“汇总通知”独立语义（当前由负责人 escalation + result 卡片表达）。 |
| P5-04 桌面/移动持久同步 | **完成** | 卡片/效果/汇总接入既有 user journal（同事务、不递增 Work 版本）；`emitCurrentProjection({force})` 让同 stateVersion 的阅读/投递也推送；桌面 `mergeWorkList` 快照原子替换（修掉本地高版本遮蔽新 epoch 的缺陷）。移动端：`shared/src/remote-contract.ts` Work 契约、`/v1/work/sync|:id|diagnostics|cards/:key/read|feedback|notifications/:id/resend` 路由（设备鉴权 + 版本守卫）、`createRemoteWorkBridge`、`RemoteClient` 方法、`remoteWork` store（epoch/scope 替换、delta 连续、代次丢弃旧响应）、`WorkPanel`（列表/详情/未验证范围/卡片已读/实测反馈/unknown 重发/诊断）、SSE 只作唤醒。 |
| P5-05 分层诊断与 UI | **完成（实现）/ 未实机** | `getWorkSummary`（决策层）与 `getWorkDiagnostics`（六段有界分页 + `truncated`/`nextCursor` + `missing`）；`unverifiedScope` 五种原因；桌面 `WorkCardsPanel`（卡片已读、外部通知 unknown 重发、按需诊断抽屉）；R09 `BotExpertReview`（完整 pending 配置审阅 + 按 `pendingVersion/snapshotId` 显式采用，旧确认被拒由 `adoptExpertVersion` 保证）。**未执行**：`pnpm dev` 真实点击回归。 |
| P5-06 十步故事 | **完成（headless）/ 未实机** | 十步连续通过：单库、真实 ingress/journal/delivery、两次同库重开、r1 晚到、写冲突、等待实测、手机失败反馈绑原 input、旧 owner 拒绝、可信关闭、B 隔离、验收后未发送即崩溃的恢复、双端一致。**未覆盖**：真实原生 Durable 进程运行与强杀、真实模型调用、Omarchy 桌面。 |
| P5-07 专项与联合门禁 | **完成（headless）** | 四个专项（delivery-dedup 24 / reconnect-diagnostics 13 / e2e-story 10 / remote-work-sync 8）注册并显式登记 `HEADLESS_TESTS`；`--audit` 自检 OK；`typecheck` 通过；`test:all` = **347 passed / 0 failed / 0 known / 0 regression**。**未执行**：`pnpm dev` 实机点击。 |
| P5-08 全景证据 | **部分** | 本文含 §4 的 46 行矩阵；实机项标注 blocked。 |

## 2. 关键取舍

1. **卡片不是第二套 Work**：仅有事实投影 + 阅读列，当前性由 `(intentRevision, inputSnapshotId)` 与成果是否 superseded 判定。
2. **attempt 与效果分离**：物理尝试 fencing 用 `attempt_id + claim_generation + payload_hash`；安全重发复用效果键与原 payload；只有人工重发产生新效果身份并保留原 unknown。
3. **阅读不走控制路径**：`markWorkCardRead` 不经 `runWorkControl`，不写回执、不推进版本，只写卡片事实并发 journal。
4. **移动端只读投影**：`RemoteWorkSummary` 不含 binding/预算/其他 Bot 私有上下文；SSE 只唤醒，游标只来自 journal。
5. **棘轮不放宽**：新逻辑拆到 `WorkResultCards` / `WorkPhase5Facts` / `WorkControlGuards`，`WorkService.ts` 2498 行（上限 2500）。

## 3. 门禁原始结果

```
pnpm -s typecheck                         → OK（scripts 新增错误 0）
node scripts/test-all.mjs --audit         → headless 349 · GUI 54 · NETWORK 29 · DATASET 2 · 自检 OK
                                            本机 windows 跳过 2 个平台限定用例
pnpm -s test:all                          → 4.0 min · 347 passed / 0 failed / 0 known / 0 regression
test:bot-work-phase5-delivery-dedup       → 24 passed
test:bot-work-phase5-reconnect-diagnostics→ 13 passed
test:bot-work-phase5-e2e-story            → 10 steps passed
test:remote-work-sync                     → 8 passed
test:architecture-graph                   → PASS（含 2500 行棘轮、层间、环、preload 契约）
test:ipc-channel-inventory                → 基线一致（有意新增 6 个 bot-work channel 后复核新增项）
```

首轮全量出现过 2 个新增回归（行数棘轮、IPC 冻结基线），均按脚本指引处理：拆模块而不是放宽行数；IPC 是有意新增并复核了新增清单。

## 4. BW-A01～BW-A46 证据矩阵

`passed` = 本机 headless 有行为断言；`partial` = 实现完成但缺少实机/外部证据；`blocked` = 需要特定硬件/会话/授权；`not-run` = 未执行。

| ID | 事实 | 状态 | 证据 |
| --- | --- | --- | --- |
| BW-A01 | 长期 Work 身份与负责人代次 | passed | phase1/control/review-control |
| BW-A02 | 跨入口（桌面/手机）引用同一 Work | partial | remote-work-sync（HTTP）；真机未跑 |
| BW-A03 | 普通交流不自动创建 Work | passed | bot-conversation-ui、foreground-contract |
| BW-A04 | once / watch 生命周期 | passed | phase2/phase4 系列 |
| BW-A05 | 控制操作幂等与回执重放 | passed | review-control、phase5 delivery-dedup |
| BW-A06 | Bot 停用后拒绝新动作 | passed | review-control |
| BW-A07 | 专家版本显式采用 | passed | review-control + 本轮 R09 审阅/采用接线 |
| BW-A08 | 协作资料隔离（Memory/私有上下文） | passed | phase3-collaboration |
| BW-A09 | 前后台分离，查询只读 | passed | phase5 e2e-story 第 2 步 |
| BW-A10 | 原生 children 与子项结果 | partial | phase3-native-settlement；本机注入 observation |
| BW-A11 | 只读查询不派发任务 | passed | e2e-story 第 2 步 |
| BW-A12 | 有界原生补试 | passed | phase3-partial-settlement |
| BW-A13 | 单权威宿主 | passed | phase2-recovery、phase4 hook-fanout |
| BW-A14 | Outbox 崩溃边界 | passed | phase2-recovery |
| BW-A15 | Submit 回执窗口 | passed | e2e-story 第 4 步；phase2-recovery 真实强杀 |
| BW-A16 | Inbox 重放幂等 | passed | e2e-story 第 4 步 |
| BW-A17 | 业务效果幂等 | passed | phase5 delivery-dedup |
| BW-A18 | 不可确认效果保持 unknown | passed | delivery-dedup（best-effort） |
| BW-A19 | 完整原生命名空间 | passed | phase2-invariants |
| BW-A20 | 恢复不重跑已完成工作 | passed | phase2-recovery、e2e-story 第 10 步 |
| BW-A21 | 旧决定被版本/代次拒绝 | passed | e2e-story 第 8 步 |
| BW-A22 | 遥测隔离 | passed | phase2-usage |
| BW-A23 | 旧要求结果不覆盖当前 | passed | e2e-story 第 5 步 |
| BW-A24 | 取消与结算 | passed | review-control、phase3-recovery-control |
| BW-A25 | 歧义引用拒绝 | passed | phase3-handoff |
| BW-A26 | 暂停积压 | passed | phase3-pause-backlog |
| BW-A27 | 交接与 adoption | passed | phase3-handoff、e2e-story 第 8 步 |
| BW-A28 | 发送前重验发送者/版本/产物 | passed | delivery-dedup、e2e-story 第 10 步 |
| BW-A29 | 局部写冲突保留成功分支 | passed | phase3-partial-settlement、e2e-story 第 6 步 |
| BW-A30 | 真实资源 gate | partial | phase3-resource-gate（headless）；真实窗口未跑 |
| BW-A31 | 桌面焦点/释放 | blocked | 需 Windows 隔离真实窗口会话 |
| BW-A32 | 仓库约束（分支/worktree 授权） | passed | phase3-handoff、review-control |
| BW-A33 | 部分成果与定向补跑 | passed | phase3-partial-settlement |
| BW-A34 | 版本匹配的实机实测 | partial | e2e-story 反馈绑定；Omarchy 未跑 |
| BW-A35 | 外部产物变化使旧证据失效 | passed | phase5 delivery-dedup（artifact/证据版本守卫） |
| BW-A36 | 真实 Hook 扇出与水位 | passed | phase4-hook-fanout |
| BW-A37 | 离线补处理 | passed | phase4-offline-catchup |
| BW-A38 | 时区/时钟/期限 | passed | phase4-schedule-clock |
| BW-A39 | 因果防环 | passed | phase4-causal-guard |
| BW-A40 | 共享预算 unknown/迟到回执 | passed | phase4-shared-budget |
| BW-A41 | 合并与背压 | passed | phase4-backpressure |
| BW-A42 | 成果接纳与唯一卡片 | passed | phase5 delivery-dedup |
| BW-A43 | 渠道能力/unknown/人工重发 | passed | phase5 delivery-dedup（fixture 契约）；真实连接器 blocked |
| BW-A44 | 汇总与阅读隔离 | passed | phase5 delivery-dedup、reconnect-diagnostics |
| BW-A45 | 桌面/移动重连 | passed | reconnect-diagnostics + remote-work-sync；真机 blocked |
| BW-A46 | 分层诊断与未验证范围 | passed | reconnect-diagnostics、WorkCardsPanel |
| 额外 | 冻结验收 §9 十步 | partial | e2e-story 10 步（headless） |
| 额外 | R09 专家配置审阅/采用 | passed | BotExpertReview + adoptExpertVersion 版本冲突守卫 |
| 额外 | R10 重连 | passed | reconnect-diagnostics |
| 额外 | UI-01～UI-10 双页面 | not-run | 需 `pnpm dev` 实机点击 |

## 5. 明确未完成 / blocked

| 项 | 缺口 | 需要的环境/复验步骤 |
| --- | --- | --- |
| 真实外部连接器 | Gateway/第三方出站的 Work 适配器与真实幂等/回查契约 | 已授权真实目标 + 响应丢失/对账脚本 |
| Windows 恢复与 BW-A31 | 原生持久存储真实强杀、隔离真实窗口输入 | Windows 桌面会话 |
| Omarchy / Hyprland | 当前源码/产物在真实桌面实测 | 隔离靶窗 + 版本化反馈 |
| 真实手机 | 配对/断连/宿主重启/能力撤销后的重连 | 真机 + Tailscale |
| `pnpm dev` 点击回归 | 卡片已读/重发/诊断/专家采用 | 桌面会话 |
| 发行包 | 仅在另行发布授权下验证 | 不自动 build/pack/dist |

## 6. 受测源文件指纹（SHA-256 前 16 位）

```
543c9998caee6a21  src/shared/bot-work-phase5.ts
72627120db0ad157  src/main/db/bot-work-phase5-schema.ts
a6cc4084f7bc6b8d  src/main/agent/work/WorkResultCards.ts
e6128fee02ec7882  src/main/agent/work/WorkPhase5Facts.ts
b067101598d65061  src/main/agent/work/WorkControlGuards.ts
7954037f113485a1  src/main/agent/work/WorkNotificationDelivery.ts
1ae72d090987fe75  src/main/agent/work/WorkNotificationHost.ts
266562008a30ca82  src/main/agent/work/WorkDesktopNotificationChannel.ts
a64e3df846f9bccb  src/main/agent/work/WorkService.ts
928931f988e13d5a  src/main/agent/work/WorkRepository.ts
234b1ffbecafc65a  src/main/agent/work/BotRegistry.ts
4e0f066ef6f77707  src/main/db/AppDatabase.ts
cee44b3d7186a282  src/main/agent/AgentService.ts
9a6255687590e028  src/main/index.ts
6c79197dde50f74d  src/preload/index.ts
f4edcfcb98c876d4  src/shared/bot-work.ts
a0118fed247da1ee  src/shared/bot-work-ipc.ts
1a559ed4c7a8b49c  src/main/remote/RemoteAccessServer.ts
2fb58525b04967c9  src/main/remote/RemoteAccessController.ts
d0033d490b7eec1c  src/main/remote/work-mapper.ts
25aabc198f8530f1  src/main/remote/remoteSchemas.ts
6c38ab7b1a3e27f1  src/renderer/src/store/app/slices/botWorkSync.ts
a9bad38d90fabbc9  src/renderer/src/components/pages/BotWorkCardsPanel.tsx
a4418fcc7b66d39c  src/renderer/src/components/pages/BotExpertReview.tsx
67489bcfbe8afd84  app/remote/src/store/remoteWork.ts
415143e73f9f8ea5  app/remote/src/components/WorkPanel.tsx
e0717a4950890468  shared/src/remote-contract.ts
0fdc86815c6a3d95  scripts/bot-work-phase5-delivery-dedup-test.ts
f01f9215fb2e5dec  scripts/bot-work-phase5-reconnect-diagnostics-test.ts
67c5e13993fb4a0c  scripts/bot-work-phase5-e2e-story-test.ts
b8548cbcffccd731  scripts/remote-work-sync-test.ts
```

## 7. 首轮结论（历史）

Phase 5 的**实现与 headless 门禁已完成**：卡片唯一性、投递诚实性、阅读零副作用、桌面/移动同步、分层诊断、生产桌面投递、R09 审阅均落地并有行为测试，`test:all` 347/0/0/0。**实机与外部证据缺失**（Windows/Omarchy/真机/真实连接器/`pnpm dev` 点击），因此不宣称 Phase 5 收官或 BOT-WORK-1.0 交付。

## 8. 实现 SHA 归档与后续复核

首轮实现固定为 `f561cc7a2c03d644d724302eb6b0ae92f636dc1c`，规划提交固定为 `02c40edba09fe9fe32f4feead2ec067bcd779e37`。2026-11-08 的后续实现固定为 `877f2cf82d0a586cf305c8ea3b7d59688bcd24b7`；[加固报告](bot-work-phase5-followup-2026-11-08.md) 与 [逐文件源码指纹](bot-work-phase5-followup-source-2026-11-08.json) 单独记录本轮事实。原 §5 缺证据项仍未取得新实机验收，不沿用历史 Windows 门禁作为新提交的验证结果。
