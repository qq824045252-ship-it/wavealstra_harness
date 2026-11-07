# Bot / Work Phase 4 实施与独立复核

日期：2026-11-07（Asia/Shanghai）。

代码基线：`main@a6c55ba27efad197bd7865b65b40347b31cc03be`，工作区在本次实施前干净；本文验收的实现是**未提交的工作区改动**。实现源码指纹见文末，测试后不再修改 `src/`、`scripts/` 或 `package.json`。

范围：[Phase 4 执行规划](../bot-work-phase4-execution-plan.md) P4-00～P4-08，覆盖 BW-A36～BW-A41。设计/验收以 [冻结设计](../bot-work-design.md)、[冻结验收](../bot-work-acceptance.md) 和 [AGENTS.md](../../AGENTS.md) 为准。

## 1. 环境与结论边界

| 项目 | 实际值 |
| --- | --- |
| OS | Windows（当前开发机） |
| Node | 24.19.0 |
| pnpm | 12.14.0 |
| Pi | 由 `EXPECTED_PI_VERSION` 读取，当前 1.5.0；未写旧版本兼容层 |
| SQLite schema | `CURRENT_DATABASE_SCHEMA_VERSION` 由 32 升到 **33**；旧库仍走 rename-backup + 重建契约 |
| 测试时钟 | 六个 Phase 4 专项全部使用注入时钟；无真实长 sleep |

结论：**P4-00～P4-08 的代码实施、六项 Phase 4 行为专项、Phase 3 九项前序专项、真实 Pi 原生结算回归、类型检查和完整 headless 门禁已通过。** 这不等于 Phase 4 全部场景验收通过：

- Phase 4 订阅控制已通过真实 `pnpm dev` 页面的 preload/IPC 保存并渲染；期限/预算按钮没有在 dev 页面逐项点击（对应服务行为已由 headless 专项覆盖）。
- Linux/Omarchy 原生桌面、移动端、发行包桌面与真实外部连接器没有本次证据。
- GitHub Issue #16 未由实施会话回填；按交接约定由主会话执行（本机 `gh` 可用且已认证，不是环境能力缺失）。

## 2. 实现落点

### 2.1 新增文件

| 文件 | 作用 |
| --- | --- |
| `src/main/db/bot-work-phase4-schema.ts` | 新表/列、唯一索引、有限保留与 projection trigger；从 `AppDatabase` 初始化 |
| `src/shared/bot-work-phase4.ts` | 注入 clock、来源 adapter 能力、版本策略、订阅/离线/预算/因果监控 DTO、严格控制 schema |
| `src/main/agent/work/WorkWatchIngress.ts` | 统一来源接纳、按目标分区、source-version 比较、固定合并截止/冻结 CAS、each 义务、有限溢出与硬容量拒绝、路由回执、订阅游标 |
| `src/main/agent/work/WorkWatchScheduler.ts` | 逻辑 tick 身份、IANA/DST 规范化、回拨/前跳、宿主水位、离线 gap、latest/each/skip 恢复、承诺到期与只读跟进 |
| `src/main/agent/work/WorkCausalGuard.ts` | 持久因果链、业务状态指纹、同状态防环、深度/跳数/全链派发上限、跨 Work 扇出与阻碍 |
| `src/main/agent/work/WorkBudgetService.ts` | 共享窗口账本、三桶互斥、真实 provider 请求预留/回执、unknown/迟到/超预留、受控续期 |
| `scripts/bot-work-phase4-*-test.ts` | 六个 BW 行为专项 |

### 2.2 真实接线

- `WorkService.ingestSourceEvent()` / `tick()` / `listDueInbox()` / `completeInboxEvent()` 委托 ingress 和 scheduler；生产 `WorkDispatchQueue` 使用 ingress 的冻结批次和 each 原始事件内容，不绕过原 Inbox/Outbox/派发链。
- `WorkService` 预算方法委托 `WorkBudgetService`；`WorkDispatchQueue` 的 4096 派发 envelope 在第一次真实 provider 请求时被释放并按请求重新占额，避免重复扣两遍。
- `DurableBotRuntime` 在 `beforeProviderRequest`（generation/provider retry）和 `completeSimple`（compaction）边界调用 `onProviderRequest`；`recordDurableUsage` 和 compaction 回执调用 `settleProviderUsage`。root、owned child、独立专家 root 都通过 `bindingForTask -> workId` 归属到同一 Work 窗口。
- `WorkHostAuthority` 在续租前暴露旧水位；`AgentService` 记录离线 gap，启动 scheduler，`powerMonitor` suspend/resume 接到 scheduler，dispose 时停 scheduler 并留下 stop 水位。
- `WorkCollaborationService.send()` 的 `delegate` 也经因果准入；结算、用量、adoption、清理路径不调用 guard。
- IPC 新增 `bot-work:phase4-control`，preload 与 `BotWorkspacePage` 展示订阅、离线 gap、队列/背压、预算三桶、因果准入和承诺期限。投影从持久 reservation/receipt 重算，renderer 不直接访问 SQLite。

## 3. BW-A36～BW-A41 行为证据

| 验收 | 注入条件 | 实际观察 | 结论 |
| --- | --- | --- | --- |
| BW-A36 | 同一 hook 命中两个 Work；重复投递；v4→v1、v9→v10、同版本不同 each 事件；target A/B；回读期间新事件；部分路由背压；硬容量拒绝；`watchRule` 来源名身份；重启 | 每个合法路由一条 route 回执；重复不新增 Inbox；v1 只生成 skipped 审计，v4 批次 payload 不被覆盖；v10 合并且首个 deadline 不变；each 同版本不同事件保留 4 条 pending，两个 binding 的 `executionInput.sourceEvent.payload` 不同；target B 独立接受 v1；冻结后新事件进入新批次且冻结 payload 不变；硬拒绝 `acknowledged=false`，重试后可再接纳；`watchRule.subscriptions` 始终是来源名，同来源 `addSubscription` 幂等，带 `watchRule` 的 update 不会停掉有效订阅或生成 `source=<subscriptionId>` 垃圾行；重开数据库后 route/cursor/Inbox 保留 | passed（headless SQLite） |
| BW-A37 | 旧心跳 1 小时、来源可回查/不可回查；latest/each/skip；重复 resume；重开数据库；host release | 每个活跃订阅一条 gap（from/to/依据/策略/queryable）；latest 只生成一个权威回读批次且不冒充当前输入；each 通过 ingress 有界补入 2 条原始事件；skip 保留未知数量并接受恢复后的在线新事件；不可回查生成 `unqueryable-offline-gap` 阻碍；同 session/from 不重复；release 后投影订阅为 offline | passed（headless SQLite） |
| BW-A38 | 洛杉矶春季 02:30 缺失、秋季 01:30 重复；上海；回拨；前跳 1h/10h；规则 revision；零 Hook 期限；暂停期限；冻结批次回拨 | 缺失槽位保留 `2026-03-08T02:30` 身份并只在 03:30 实际时刻执行一次；秋季重复小时只产生一个 `01:30` tick；上海直接映射；回拨不重放；前跳分页补 tick（单页 ≤64）；规则变更 revision 递增且不重放旧规则；期限只产生一个 `deadline_expired`，dispatch 为 read-only 且 `inputSnapshotId` 不变；暂停只留 `deadline-follow-up` 阻碍；冻结批次回拨后仍保持原 deadline | passed（虚拟时钟 + 真实 SQLite） |
| BW-A39 | 同状态换 operation/message id；跨 Work/订阅扇出；A→B→A 5 跳；伪造引用；预算耗尽；handoff；重启 | 合法下游状态变化一次通过；同状态新 id 得到 `causal-loop-guard` 且只更新一个 blocker；跨 Work/订阅不被全局去重吞掉；第 5 跳 `causal-hops`；伪造引用 `causal-attribution-unknown`；预算耗尽后本次预留仍可 commit；被拦截 dispatch 不创建 binding，新 root 仍可派发；handoff 与重启不解链 | passed（headless SQLite） |
| BW-A40 | 两个独立 SQLite 连接争最后 100 tokens；root/child/expert/compaction；replay/new retry；unknown/合成零/明确零；超预留；窗口未到期/禁止续期/回拨/跨多周期；重启 | 第二个连接拿不到最后额度；派发 envelope 被释放后 4 个真实请求共用同一 window；相同 reservation 身份不重复；新请求新增占额；unknown 保留上界且不释放；合成零保留 reserved，明确零 committed 0；超预留 25 不裁剪；同一 generation 回执幂等；未到期/有 outstanding/回拨不重开；跨 5 分钟只开当前合法窗口；重启后 window/used/outstanding 保留 | passed（两个独立 SQLite 连接） |
| BW-A41 | 每 20ms 连续 latest 输入；冻结后新事件；each 队列 depth 2 + overflow 4；硬拒绝；慢消费者重复；高流量订阅与安静订阅；阻塞期间其他 Work 期限/结算；重启 | 首批 deadline 固定在首接收 +100ms，第 6 个事件在到期时冻结前批并开新批；冻结 payload 不变；2 pending + 2 blocked 后第 5 条明确拒绝且不 ACK；消费后回填 blocked，再重投成功；重复源事实不变；安静 Work 在 51ms 后仍到期 ready；其他 Work 的 deadline 与预算结算不受阻塞影响；blocked 清零后同一 backpressure 阻碍清除；重启保留批次与 route | passed（headless SQLite） |

### 3.1 缺口 A 回归证据（watchRule 身份）

- 改法：`watchRule.subscriptions` 统一为**来源名**集合；`addSubscription` 同来源幂等（更新原订阅，不新增第二行）；`phase4Control` configure 同 source/target 复用原订阅；停止订阅后仅在没有同来源 active 订阅时移除该来源名；`syncWatchSubscriptions` 仍只按来源名比较。
- 先临时把两处 `subscription.source` 改回 `subscription.subscriptionId`，运行 `test:bot-work-phase4-hook-fanout`：**失败**，断言 `addSubscription records the source name, not the subscription key`，实际数组为 `["hook", "subscription-<uuid>"]`。
- 恢复修复后同一用例通过；并断言：创建 watch Work（`watchRule.subscriptions=["hook"]`）→ `addSubscription` → 带 `watchRule {subscriptions:["hook"]}` 的 amend 后，只有 1 条 active `source="hook"` 订阅、`stoppedAt` 为空、没有 `source == subscriptionId` 的行、`watchRule.subscriptions` 仍为 `["hook"]`。
- 回归位于 `scripts/bot-work-phase4-hook-fanout-test.ts`，不是只在文档或别处声明。

## 4. 命令、退出码与真实结果

| 命令 | 实际结果 |
| --- | --- |
| `pnpm -s typecheck` | **通过**（web/main/scripts；scripts 新增错误 0） |
| `node scripts/test-all.mjs --audit` | **通过**；headless 345、GUI 54、NETWORK 29、DATASET 2、pending 0；没有 Electron 用例混入 headless |
| `pnpm -s test:all` | **通过，退出码 0**；343 passed / 0 failed / 0 known failed / 0 new regressions（3.5 min） |
| 六个 `test:bot-work-phase4-*` | **全部通过**：hook-fanout、offline-catchup、schedule-clock、causal-guard、shared-budget、backpressure |
| Phase 3 九项 headless 专项 | **全部通过**：resource-gate、focus-gate、partial-settlement、pause-backlog、collaboration、handoff、native-settlement、recovery-control、resource-settlement |
| `test:bot-work-phase3-native-settlement` | **通过**；真实 Pi 原生 root、owned child、文件效果、结果 Inbox、重启恢复；包含新 ingress 的实际 each/latest 生产循环 |
| `test:bot-work-phase2-usage` / `test:bot-work-phase2-invariants` | **通过**；真实 Pi owned-child 用量与共享预算/命名空间回归 |
| `test:db-schema-discard` | **通过**；当前 schema 33 不被误备份，旧版本仍先备份再重建 |
| `test:bot-workspace` | **通过**；React 实际渲染 phase4 订阅/离线/三桶/因果/期限卡片 |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:bot-work-phase3:dev` | **通过**；真实 `pnpm dev` → Electron → preload → Bot 页面 → 原生 fixture，隔离 HOME；通过 preload/IPC 保存 phase4 订阅并渲染「关注与运行/共享预算」；期限/预算按钮未逐项点击 |
| `test:ipc-channel-inventory` | **通过**；本地 ignored 基线从 484 更新到 485，diff 仅 `bot-work:phase4-control` 与一行既有注册点行号；未从改后源码掩盖其他通道变化 |
| `test:typecheck-guard` / `test:architecture` | **通过** |

### 4.1 中途失败与修复（保留真实记录）

- 首次完整门禁为 **340 passed / 3 failed**：`test:bot-work-projection-retention`、`test:ipc-channel-inventory`、`test:typecheck-guard`。前两项分别由“投影读取预算时写账本导致 sequence 被保留策略剪掉”和“新增 IPC 未更新 ignored 基线”引起；`typecheck-guard` 是同一 TypeScript 错误。修复方式：投影改用只读 `budget.snapshot()`，并让 `createWork` 在控制事务内建立窗口；IPC 基线只更新一条新增 channel。修复后完整门禁 343/0。
- Phase 3 `pause-backlog` 的旧断言要求 `lastProcessedSourceVersion` 等于回读输入快照。Phase 4 §1.1 明确要求把 provider 源版本与输入快照分开，因此该断言改为断言源版本保持 `v3`、输入快照在 Work 上。不是放宽门禁。
- Phase 3 `native-settlement` 的 `unknown-provider` 场景原先用 `each` 断言“无文件来源被回读阻碍”。Phase 4 的 each 以不可变事件内容为输入，不应要求当前状态回读；该场景改为 `latest`（必须权威回读）并继续断言显式 `source-readback` 阻碍。不是放宽 latest 语义。
- 既有 `test:bot-work-phase3:dev` 增加了 Phase 4 订阅 preload/IPC 保存与投影渲染断言；它是真实 dev 页面证据，不代替期限/预算按钮的逐项点击。
- 没有修改 `scripts/test-baseline.json`。

## 5. 身份、持久终态与故障边界

专项中使用的稳定身份：

- 来源事实：`hook:evt-1`、`hook:bounded-5`、`repo:offline-e1`。
- 路由：`(source, source_event_id, subscription_id)` 主键；每个订阅独立 route 状态。
- latest 批次：`subscriptionId:targetKey:sourceEventId`，首发 `batchDeadlineAt` 固定；冻结写 `frozen_at/frozen_payload_json/claim_version`。
- each 义务：Inbox `event_id` + binding `inbox_event_id`，worker 输入来自该行 payload。
- 调度：`(subscription_id, schedule_revision, logical_slot_key)` 唯一；春季缺失槽位保留名义 wall time。
- 离线：`(host_session_id, subscription_id, offline_gap_from)` 唯一；重复 resume 复用。
- 因果：`admission_key` 幂等 + `(root, work, subscription, inputSnapshot, stateHash)` 防环；depth/hops/dispatch_count 持久。
- 预算：`window_id = work + policyRevision + periodStart`；每条 reservation 带 requestKind、binding、attempt identity、receipt key。`available = limit - committed - reserved - unknown`。
- 结算：`commit` 幂等；同 generation 回执只结算一次；已释放的派发 envelope 不再重复记账。

故障/重启检查：来源接纳、冻结、窗口、因果、预算和离线 gap 均使用真实 SQLite；测试关闭并重新打开 `AppDatabase`，断言 route/cursor/batch/reservation/chain/gap 身份和终态保留。真实竞争使用两个独立 SQLite 连接争最后额度。没有用单线程假并发替代预算竞争，也没有用假执行器替代 `native-settlement` 的真实 Pi 链路。

## 6. 未运行 / blocked

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| Phase 4 dev 期限/预算按钮逐项点击 | not-run | 订阅控制已通过真实 preload/IPC + 页面渲染；期限/预算的服务行为由 headless 专项覆盖，页面按钮未逐项点击 |
| Linux/Omarchy 原生桌面、AT-SPI、移动端 | not-run | 当前是 Windows 机器；Phase 3 报告中的 Linux socket EPERM 仍是环境边界 |
| 发行包/安装包桌面验收 | not-run | 默认流程不 build/pack/dist；用户未要求发布 |
| 真实外部连接器 webhook/远端历史回查 | blocked | 仓库当前没有通用公网 webhook 服务；本轮使用真实文件/Git 观测与宿主事件入口，外部来源能力通过 adapter 声明，不承诺不存在的服务 |
| GitHub Issue #16 回填 | 未由实施会话执行 | 按交接约定由主会话回填；`gh` 在本机可用且已认证 |

## 7. 冻结实现指纹

实现 SHA-256 由新增的 `scripts/bot-work-phase4-source-evidence.mjs` 对相对 `HEAD` 的 `src/`、`scripts/`、`package.json` 变更/新增文件计算，输出在 `out/diagnostics/bot-work-phase4/source-manifest.json`。

- 基线提交：`a6c55ba27efad197bd7865b65b40347b31cc03be`
- 文件数：34
- **sourceSha256：`f5db31a6c69ef10885e90607ea2fea7d053cd62c18655f2c7d92524fe23c97f9`**
- 最终类型检查日志：`out/phase4-typecheck-final.log`
- 最终完整门禁日志：`out/phase4-test-all-final.log`（343 passed / 0 failed，退出码 0）

测试后未再修改源码；本文只记录实现与证据，不替代平台/UAT 验收。
