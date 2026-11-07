# Bot / Work Phase 4 加固复核

日期：2026-11-07（Asia/Shanghai）。

审查基线：`main@60a50eec58fbb96cefb1fa4690e430546f2bb57d`。本轮按用户要求评估、修复 Phase 4 并推送主线；没有启动 Phase 5 实施，也没有升级应用版本或执行发布 build/pack/dist。

## 1. 结论与原评语校正

Phase 4 的核心结构和生产接线已经存在，但不能把既有 Windows headless 门禁通过等同于全部平台、全部恢复边界验收通过。本轮确认并修复了来源版本回退、离线分页漏接纳、暂停积压边界和预算核对缺口。

**最终结果：类型检查及六项 Phase 4 专项通过；两轮完整 Linux headless 均为 344 passed / 1 failed，退出码均为 1。** 唯一失败为基线同环境也复现的 AT-SPI D-Bus socket EPERM；没有修改失败白名单。因此本轮不宣称完整门禁全绿或 Phase 4 整体验收完成。

- `WorkWatchIngress.accept()` 在基线中已经调用 `WorkService.transaction()`，后者使用 SQLite `.immediate()`。在线 `route()` 的版本检查、Inbox 和 Cursor 并不是三个独立事务。直接再套一层事务不能修复实际问题。
- 实际问题是水位选择、暂停/异步回读边界及离线游标推进。新的独立连接竞争和故障注入测试保护整扇出的原子性。
- `unknown` 的长期冻结是保守记账的正确默认值；缺口是受守卫的显式核对入口，以及缺报后的可信迟到回执曾被忽略。本轮不把未知用量自动当作零。
- `DURABLE_STORAGE_OWNED` 的存储所有权由 PID 存活性判断，不能直接归因于 Pi 租约 TTL；测试使用的 1 秒 `WorkHostAuthority` 租约是另一套条件。当前 Linux 未复现此前 Windows 的那一次瞬时错误，不能声称已确认其唯一根因。
- `watchRule.subscriptions` 身份回归实际位于 `scripts/bot-work-phase4-hook-fanout-test.ts`；仓库没有原评语所写的 `bot-work-phase4-source-invariant-test.ts`。

## 2. Ingress、暂停与离线恢复

### 2.1 水位必须共同约束接纳，不能按字段是否存在选旧水位

基线 `isStale()` 使用 `highestConsumedVersion ?? highestFrozenVersion ?? highestAcceptedVersion`。在已消费 v1、当前已接纳 v3 时，晚到 v2 会与 v1 比较，错误地合并并覆盖 v3。本轮先用行为测试复现 `merged`，修复后晚到 v2 为 `skipped`，后续冻结水位仍为 v3。

现在 accepted/frozen/consumed 三种水位共同约束来源版本，游标写入在即时事务内只向前推进；整数来源序号使用精确整数比较。消费同时更新 Inbox、路由回执与水位，重复消费不再次累计计数。实际输入快照与来源版本仍保持独立。

### 2.2 异步回读不能消费期间已经变化的批次

暂停恢复中的异步权威回读原先只验证 Work 版本；在线合并可能只改变 Inbox，从而在旧回读返回后消费新事件。本轮增加 Inbox 的 claim、冻结、来源身份/版本、合并次数与 payload 比对，发现变化就保留批次重新回读。

暂停事件保存 targetKey 并推进 accepted 水位；恢复 latest 按目标分别形成权威回读批次。尚未取得 Inbox 槽位、只存在于 Source/Route 的暂停义务也计入条数与字节硬上限，超限拒绝 ACK。背压阻碍按现有同 Work/原因唯一约束复用，避免多订阅或两条积压路径互相冲突或提前清除。

### 2.3 离线分页只推进连续已接纳前缀

基线 `applyGap()` 在某条事件被拒收后仍把 continuation cursor 推到整页末尾，并重复累计已接纳事件。现在遇到拒收就停止，只保存连续成功前缀的游标；重放已完成前缀不重复计数，未接纳事件可继续重试。

来源声明 `canQueryHistory=true` 不等于已经完成回查。宿主恢复时没有传入历史页，缺口保持 `recovering / 等待来源历史回查结果`；明确返回空页才表明该次分页已结束。真实外部连接器的回查能力仍需单独取得证据。

### 2.4 双连接竞争与事务回滚证据

`hook-fanout` 在版本比较期间通过第二个 SQLite 连接竞争写锁，观察到 `SQLITE_BUSY`，且第二连接只能读到事务前的已提交游标。向第二订阅注入失败后，来源事实、第一订阅的 Inbox 合并、Route 与 Cursor 全部回滚。它验证的是已经存在的即时事务契约，不把单线程顺序调用包装成进程并发。

## 3. 预算显式核对与迟到回执

### 3.1 受守卫的核销入口

在既有 `bot-work:phase4-control` 内新增 `reconcile-budget-reservation` 请求种类；没有新增 IPC channel 或第二套控制服务。

请求必须绑定 Work、预留和原窗口，提供确认数量、处理方式、原因、凭据，以及完整 `stateVersion / intentRevision / ownerEpoch` 三版本。只有当前主负责人或该用户可以操作：

- `committed` 按确认的实际数量结算；`released` 必须明确填写 0。
- 空凭据、旧版本、旧负责人、普通协作者、跨 Work 或错误窗口均拒绝。
- 普通 `release()` 不再释放 unknown，防止绕过核对入口。
- 预留、审计证据、状态版本和操作回执同事务提交；向回执写入注入失败时全部回滚。
- 审计复用 `work_evidence`，记录操作者、原状态、原窗口、确认数量、理由、凭据和三版本；幂等复用 `work_operation_receipts`。
- 核对现有账务可以在 paused、closing、closed 或业务授权过期后执行，不因此恢复业务执行权限、重开 Work 或创建 Task。

未知预留估计为 0 时仍然是未决记录，不能绕过自动 rollover、政策修改或显式新窗口门禁。核对完成后仍按原有到期、续期政策和宿主规则处理下一窗口。

### 3.2 缺报不抢占可信回执身份

基线 `reported=false` 时提前写入 `receipt_key`，后续真实用量会被误判为重复；筛选 reserved 也排除了已经 unknown 的请求。本轮缺报仅保留 unknown，允许可信迟到回执结算原请求。

同 generation 的回执归属最后实际请求，或已明确绑定的原请求；请求顺序依据持久插入顺序，不依据可能回拨的墙钟。最后一次请求已人工核销时，也不能把迟到用量转记到较早的 retry。

人工核销后收到矛盾的真实用量，账本记回原窗口并保留冲突证据；新窗口不被重复扣账。相互矛盾的可信回执保守保留较高数量，不相加，不悄然降低。相同回执重复到达不重复扣账。

历史窗口也按原预留归属重算；预算耗尽阻碍按 Work 隔离。每个 Work 的预算回执冲突共用一个开放阻碍，逐笔证据分别保留，符合数据库 `(work_id, reason_code)` 的开放阻碍唯一约束。

预算阻碍保留被拒请求所需的数量；仅调用 `summary()` 不能因为“还有一些额度”就清除仍然不足的阻碍。真实结算使额度足以覆盖原请求，或者原 rollover 阻碍对应的窗口确实已切换后，才按条件解除。

### 3.3 控制面与投影

只读预算投影提供未知预留清单和阻塞续期原因。实际页面新增核对表单：数量初始为空，需要输入数量、原因、凭据并显式确认；网络结果不明时保留原操作 ID 和原三版本用于重试。

页面增加“查看已结束事项”，查询、轮询和控制后刷新保持 all scope；普通消息发送完成也保持当前 scope，防止已结束事项的选择和核销表单被默认 open 列表清掉。

React 渲染专项覆盖空金额、默认禁用和 closed Work 的核对入口。开发环境测试新增真实表单→preload→IPC 的提交与释放步骤，数据库种子明确标为 fixture；实际运行结果及环境阻碍见下节，不把脚本存在当作界面验收通过。

## 4. 恢复测试稳定性

恢复专项保留 8 个真实强杀/重开场景和前台取消的两次强杀，继续验证外部效果一次、原执行身份、结果和 Inbox 终态。

- checkpoint 通过临时文件与原子 rename 发布，避免读到半写 JSON。
- 等待子进程 close，识别 signal 提前退出；恢复前核对被强杀 PID 已消失，且持久 `WorkHostAuthority` 租约属于该 PID、未被正常释放、确已到期。
- 删除固定 1100ms 睡眠，保留原 25 秒观察上限，不修改产品租约策略。
- `test:all` 仅把这一重型 SQLite/JSONL 强杀套件移入现有串行池；性能测试仍在串行池最后。测试不被排除、失败不自动重试、timeout 和失败白名单不放宽。

## 5. 本轮环境与门禁

| 项目 | 本轮实际值 |
| --- | --- |
| 系统 | Linux x86_64，内核 6.18.57，glibc 2.41 |
| Node / pnpm | Node 24.22.1 / pnpm 12.14.0（按仓库 pin） |
| Pi / better-sqlite3 | Pi Coding Agent 与 Pi Durable 1.5.0 / better-sqlite3 13.0.3 |
| Electron | 44.5.1；只尝试 `pnpm dev`，不生成发布包 |
| 数据库 schema / 应用版本 | 保持 33 / 0.1.107 |
| 依赖 | 与已有安装的 dependency maps 和完整 lockfile 一致；没有修改依赖声明或锁文件 |

| 命令或检查 | 实际结果 |
| --- | --- |
| `pnpm -s typecheck` | **passed，退出码 0**；web/main/scripts 均通过，scripts 错误 0、基线 0、新增 0 |
| `node scripts/test-all.mjs --audit` | **passed，退出码 0**；headless 345 / GUI 54 / NETWORK 29 / DATASET 2 / pending 0 |
| 第一次 `pnpm -s test:all` | **failed，退出码 1**；344 passed / 1 failed / 0 known failed / 1 new regression，2.5 min |
| 第二次 `pnpm -s test:all` | **failed，退出码 1**；344 passed / 1 failed / 0 known failed / 1 new regression，2.4 min |
| 六项 `test:bot-work-phase4-*` | **两轮均 6/6 passed**：hook-fanout、offline-catchup、schedule-clock、causal-guard、shared-budget、backpressure；含新增行为回归 |
| Phase 3 九项 headless 专项 | **两轮均 9/9 passed**，包括真实 Pi native-settlement 和暂停积压回归 |
| `test:bot-work-phase2-recovery` | **两轮均 passed**，串行池分别 22.8s / 22.7s；真实强杀与恢复断言保留 |
| `test:core-performance` | **两轮均 passed**，串行池分别 9.1s / 8.7s |
| `test:bot-workspace` / `test:bot-conversation-ui` | **两轮均 passed**；含未知预算表单、closed 事项入口等渲染检查 |
| `test:db-schema-discard` / `test:ipc-channel-inventory` | **两轮均 passed**；schema 备份重建及 IPC 库存契约保持 |
| `git diff --check` | **passed，退出码 0** |
| 基线 `60a50ee` 快照的 `test:atspi-transport` | **failed，退出码 1**；同一 D-Bus socket EPERM，证明不是本轮改动首次引入 |
| `BOT_WORK_DEV_HEADLESS=1 NODE_OPTIONS=--max-old-space-size=6144 pnpm -s test:bot-work-phase3:dev` | **blocked / 退出码 1**；实际 Electron 启动后 Unix socket EPERM，未进入页面 |

两轮完整门禁均采用默认并发 4、原单项超时 300s，未使用 filter、skip、失败重试或扩充 baseline。因为 baseline 仍为空，脚本仍将 AT-SPI 项打印为 **1 new regression**，完整命令保持失败；基线源码对照仅用于解释原因，不改变门禁结果。既有 Windows 343/0 只属于原始实施报告，不是本轮 Linux 实测结果。

本地原始记录：`out/diagnostics/bot-work-phase4-followup/typecheck-final.log`、`test-all-1.log`、`test-all-2.log`、`atspi-baseline.log`、`dev-followup.log`。诊断日志不作为测试白名单或运行时输入。

### 5.1 已确认的环境阻碍

`test:atspi-transport` 创建隔离 D-Bus 时发生 `Failed to open socket: Operation not permitted`。从基线 `60a50ee` 提取的独立源码快照、同 Node/pnpm/依赖在当前环境重跑该项，也以完全相同的 D-Bus socket EPERM 失败。相关 AT-SPI 产品和测试源码没有被本次改动。

真实 dev 验证也已尝试：修正测试启动器对 Linux 原生 pnpm 二进制的识别后，默认 Node 堆曾在开发转换阶段耗尽；用本机 6GB 临时堆配置重跑后，已进入 Electron 启动，但在 `process_singleton_posix.cc` 创建 Unix socket 时被 `EPERM` 拒绝，未进入页面。因此新表单点击步骤仍为 **blocked**，不能声称真实 preload/IPC 点击已通过。没有修改沙箱/网络策略或失败白名单绕过限制。

IPC 检查所需 ignored 基线从原始 `60a50ee` 的源码快照生成，再与修改后的源码比较。相对旧本地基线增加的只有原提交已经包含的 `bot-work:phase4-control`；本轮最终仍为 485 个 channel，新增/删除均为 0。没有从修改后源码重写基线掩盖变化。

Windows/Omarchy 原生桌面、移动端、真实供应商账单、外部连接器回查及发行包验收没有本轮新证据。恢复套件在 Linux 连跑的结果不能替代此前 Windows 瞬时失败的复验。

## 6. 最终源码身份

- 基线提交：`60a50eec58fbb96cefb1fa4690e430546f2bb57d`。
- 冻结源码范围：`src/`、`scripts/`、`package.json` 相对基线的变更文件；本轮共 18 个，`package.json` 本身未变。
- source SHA-256：`cd7c759ccbc14a170b8824586b7a19a1ad70ef03c9731e4b874d7ea690141b26`。
- 可核查的逐文件清单：[bot-work-phase4-followup-source-2026-11-07.json](bot-work-phase4-followup-source-2026-11-07.json)。
- 指纹由 `node scripts/bot-work-phase4-source-evidence.mjs` 在提交前计算，完整门禁使用同一冻结源码。报告、实施记录等文档不计入源码指纹。
