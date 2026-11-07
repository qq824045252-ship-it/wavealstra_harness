# Bot / Work — Phase 5 加固复核

> 最新补全记录见 [Phase 5 功能补全与原生验收复核](bot-work-phase5-completion-2026-11-08.md)：五类 Gateway 出站、独立负责人汇总、用户评审入口及真实原生十步故事已补齐。本文保留本轮历史事实；当前门禁与未完成实机边界以上述最新报告为准。

日期：2026-11-08（Asia/Shanghai）。

审查基线：[`f561cc7a2c03d644d724302eb6b0ae92f636dc1c`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/f561cc7a2c03d644d724302eb6b0ae92f636dc1c)。规划提交为 `02c40edba09fe9fe32f4feead2ec067bcd779e37`。

本轮按用户要求修复 Phase 5 并直接推送 `main`。应用版本、数据库 schema、依赖及失败白名单保持原状；没有创建额外分支，没有执行发布 build/pack/dist。

## 1. 结论与原评语校正

**本轮代码加固已完成，类型检查与相关专项通过；最终完整门禁为 348 passed / 1 failed / 0 known failed / 1 new regression（143.82 秒，exit 1）。** 唯一失败是 `test:atspi-transport` 的 D-Bus socket EPERM，并已在原始 `f561cc7` 快照复现。没有把环境失败加入白名单；不宣称全量全绿或 Phase 5 整体验收完成。

原实现报告的 Windows `347 passed / 0 failed` 是历史运行证据，不是本轮 Linux 结果。原报告中的实机和外部适配缺口继续保留，不能因代码加固或 headless 测试通过而自动勾选。

- **通知 API 实际同步。** `WorkNotificationHost.drain()`、`deliverPendingNotifications()` 和当前渠道接口都同步返回，没有评语描述的 `await channel.deliver()` 窗口。真正需要保护的是渠道/投影回调重入、扫描期间新事实和停止后尚未执行的 wake；既有 15 秒轮询也意味着普通遗漏不会必然永久滞留。
- **生产已读入口原本有事务。** `WorkPhase5Facts.markRead()` 已通过 `WorkService.transaction()` 包住 `cards.markRead()` 与投影通知；该事务使用 `.immediate()`。本次让底层 helper 自身也保证完整性，不能将原生产入口描述为完全无事务。
- **成功关闭复用卡片是正确身份设计。** 复用后的卡片仍是 `accepted_result`，不应改写 kind 或另建重复卡片；展示应结合权威 `lifecycle / closureConclusion`。
- **实际架构脚本是 `test:architecture-graph`。** 仓库没有 `test:architecture-qgraph`；本轮执行真实脚本。

## 2. 通知宿主与投递恢复

### 2.1 重入唤醒与停止边界

`WorkNotificationHost` 记录 `pendingDrain`：排空时收到重入 drain/wake，不再静默丢弃，当前扫描结束后补扫。补扫使用全局范围，因为新的请求可能属于另一个 Work。宿主代次与权威检查约束后续渠道/补扫，`stop()` 清除待执行 wake timer，旧生命周期的回调不能在停止后继续投递。

unknown 本身不发布新投影；只有真实变化才唤醒，因此补扫不应变成 unknown 的自动盲重发循环。

### 2.2 旧效果可以对账，新发送必须重新准入

恢复时继续使用原效果键与不可变 payload，同时检查原渠道、目标、能力契约、当前要求/输入、负责人身份及产物有效性。已被撤销、取消、改要求或产物失效的结果不能借“安全重放”重新发送。已发生的旧效果仍可以通过真实回执结算，历史事实不能伪装为当前结论。

人工重发保留原 unknown attempt，产生可归因的新 effect，并继续验证当前语义。重试继续使用授权所属的 effect，不退回初始 effect。迟到结算除 attempt 围栏外，还检查当前 notification 所属 effect/ordinal，不能覆盖较新的人工重发授权或物理尝试。

连续丢失回执达到同 effect 的 3 次自动尝试上限后仍保留 `unknown`，不把“停止自动尝试”误记为已确认失败。真实 `emitProjection → host.wake()` 回归验证该场景在 4 轮扫描后终止；best-effort 场景始终只有一次发送。人工重发拥有独立预算，并保留原 unknown 历史。

人工授权使用本宿主已观察到的渠道能力，尚未恢复渠道时明确拒绝；授权之后能力漂移会停止发送、退回原效果的 unknown 并记录可诊断错误，重新确认后才冻结新契约。不能以更强的新能力追认旧效果具有相同保证。

### 2.3 桌面渠道能力按实际保证声明

桌面通知的应用内行有保留/清理周期；关闭应用内通知时去重键仅在内存中，系统 toast 也没有可持久查询的供应商回执。因此 `createDesktopWorkChannel()` 改为 `best-effort-unqueryable`，保留可用的本地去重，但不再声称跨崩溃的完整幂等/回查保证。丢失回执保持 unknown，需用户确认重复风险后人工重发。

这次没有增加第二套通知账本，也没有把系统通知展示包装成 exactly-once。

## 3. 卡片阅读、关闭展示与诊断身份

- `WorkResultCards.markRead()` 以短 `.immediate()` 事务覆盖权限读取、条件更新、Journal trigger 和 DTO 回读。嵌入生产事务时使用 savepoint；不经过 Work 控制入口，不推进 `works.state_version`，保留旧 readAt 的 `replayed` 语义与越权拒绝。
- 双连接断言验证未提交卡片与 Journal 对观察者一起不可见；在 UPDATE/Journal trigger 之后注入回读失败，确认阅读版本、Journal 水位/事件和 Work 全部回滚。
- 桌面和手机对当前结果卡片显示“已完成并关闭”，条件为 `closed + succeeded`。取消、未达成、active/closing、历史、失效和阻碍卡片均不显示成功关闭。已有 `accepted_result` 的身份和唯一性保持不变。
- `unverifiedScope()` 不再用 `cardKey` 充当缺失的 `artifactSnapshotId`；源码 `sourceSha` 与 `artifacts:<aggregate hash>` 属于不同身份，也不再直接比较。当前证据仍要求相同 intent/input；产物变化继续通过既有 `WorkArtifactValidation` 重开验收项并撤销当前证据引用。

## 4. 移动端控制契约与会话隔离

### 4.1 重发和实测反馈能通过真实宿主守卫

基线手机重发请求未携带 `acknowledgedDuplicateRisk` 和完整版本守卫，被宿主 strict schema 拒绝。手机实测反馈也缺少本地产物快照与版本守卫。本轮将页面、store、共享契约、Remote schema 和宿主摘要接通：

- 重发必须先确认重复风险，携带 `acknowledgedDuplicateRisk: true` 与用户审阅时的 `stateVersion / intentRevision / ownerEpoch`。
- 实测反馈携带输入快照和真实 `artifactSnapshotId`；文件产物通过原生结果接收路径登记，再由宿主核对。缺失/旧产物身份、旧控制版本继续拒绝，未放宽服务端守卫。
- 摘要新增明确 `closureConclusion` 和产物快照；不暴露 binding、预算或其他 Bot 私有上下文。
- `RemoteClient` 保留既有错误结构优先，并读取 Work 返回的顶层 message/code，使 409 的具体拒绝原因能够显示。
- 控制接口回执使用显式白名单：成功/重放只返回 `ok / replayed`，失败只返回 `ok / code / message`。基线曾直接序列化 `WorkControlResult`，将 `work / latestWorkSnapshot` 中的工作区、权限、执行身份和预算带进 HTTP 回包；仅声明窄 TypeScript 类型不会裁剪这些运行时字段。两类控制各自的成功、重放、版本冲突均有真实 HTTP 字段隔离断言。

### 4.2 一个客户端会话只能写自己的投影

Work store 由 Remote 连接生命周期显式绑定 client。退出、切换服务器，或连接流程收到 401/403 时，立即清理事项列表、游标、选择与诊断；旧页面回调的 `refresh(oldClient)` 无法重新绑定旧会话。

client/scope 切换使旧刷新失效；epoch 替换清理缓存并隔离旧已读/诊断回执。旧上下文的响应不能覆盖新数据、已读水位、诊断或 loading。相同上下文内的已读回执保持单调；跨 epoch 则必须接受权威快照较低的新版本。诊断还绑定 Work 版本和该事项最新诊断请求，已移除事项不会遗留诊断。SSE 继续只作唤醒，重连/前台 resync 读取持久 journal。

## 5. 本轮门禁与可复核边界

环境：Linux x86_64；Node 24.22.1，pnpm 12.14.0。数据库 schema 34、应用 0.1.107、`WorkService.ts` 2498 行，本轮均未改变。

| 命令或检查 | 本轮实际结果 |
| --- | --- |
| `pnpm -s typecheck` | **passed，exit 0**；web/main/scripts；scripts 错误 0、基线 0、新增 0 |
| `pnpm -C app/remote -s typecheck` | **passed，exit 0**；Remote 子包实际 `tsc --noEmit` |
| `node scripts/test-all.mjs --audit` | **passed**；headless 349 / GUI 54 / NETWORK 29 / DATASET 2 / pending 0 |
| `pnpm -s test:architecture-graph` | **passed，5/5**；行数、层次、环与 preload 契约门禁保持 |
| `pnpm -s test:bot-work-phase5-delivery-dedup` | **34 passed**；原 24 组，新增 10 组，桌面恢复用例按真实能力校正 |
| `pnpm -s test:bot-work-phase5-reconnect-diagnostics` | **19 passed**；原 13 组，新增 6 组 |
| `pnpm -s test:bot-work-phase5-e2e-story` | **10 steps passed**；原十步连续故事 |
| `pnpm -s test:remote-work-sync` | **19 passed**；原 8 组，新增 11 组；含两类控制成功/重放/冲突的 6 种回包白名单断言 |
| `pnpm -s test:bot-workspace` | **passed**；真实 React SSR，含成功关闭的 2 种卡片与 10 个负向状态 |
| `pnpm -s test:bot-work-control` | **passed**；能力漂移负例与同契约回执恢复正例均保留 |
| `pnpm -s test:bot-work-phase3-handoff` | **passed**；交接、原回执与不可变通知恢复回归 |
| `pnpm -s test:all` | **348 passed / 1 failed / 0 known failed / 1 new regression，exit 1**；143.82 秒；唯一失败 `test:atspi-transport` |
| IPC inventory | **passed**；对原始 `f561cc7` channel 基线，新增/删除为 0 |
| `git diff --check` | **passed** |
| 基线 `f561cc7` 的 `test:atspi-transport` | **failed，exit 1**；D-Bus socket EPERM，详见下节 |
| 隔离用户目录的 `pnpm dev` 探针 | **blocked，exit 1**；Electron singleton socket EPERM，未进入页面 |

`pnpm -s remote:typecheck` 的嵌套 `--filter` 在此工作区遇到 pnpm 12 的 `ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH`（复用的根 `node_modules` 为软链接）。随后直接执行同一子包的 `pnpm -C app/remote -s typecheck`，实际 TypeScript 检查通过；没有修改 pnpm 安全校验或项目依赖来消除该错误。

编写新增 HTTP 产物反馈回归时，最初只调用 `submitDeliverable` 的夹具未登记文件依赖，不能验证“缺少产物快照必须拒绝”。最终夹具改走真实 `nativeResults.receive → acceptDeliverable` 并明确断言 `capture().observed.length === 1`，缺失/旧产物快照仍要求 HTTP 409，未放宽拒绝断言。

首轮完整门禁为 **347 passed / 2 failed / 0 known / 2 new regressions（147.85 秒，exit 1）**：AT-SPI 环境失败，以及前序 `test:bot-work-control` 的能力升级夹具。后者原先先以 best-effort 发送，再在重启后改成 idempotent + queryable 并直接确认旧效果；与本轮冻结能力守卫冲突。

该夹具已拆为两个都经历真实数据库重开的 Work：能力升级的旧效果保持 unknown、lookup 和重发均不发生；从首次发送就声明 idempotent-queryable 的效果则凭同一能力契约的回执结算 sent，attempt ID、effect key 和一次外部效果保持不变。`test:bot-work-control` 专项通过后重跑完整门禁；没有删除正向回执保证，也没有放宽产品守卫或失败白名单。

### 5.1 原始基线与环境失败

`f561cc7` 的独立源码快照在相同 Node/pnpm/依赖下执行 `test:atspi-transport`，原样复现：

```text
Failed to start message bus: Failed to open socket: Operation not permitted
```

当前失败白名单仍为空；环境对照只解释原因，不将命令失败改写为通过。

本轮实际启动了隔离用户目录的 dev 验证探针：

```text
BOT_WORK_DEV_HEADLESS=1 NODE_OPTIONS=--max-old-space-size=6144 pnpm -s test:bot-work-phase3:dev
FATAL:chrome/browser/process_singleton_posix.cc:319
socket() failed: Operation not permitted (1)
```

Electron 启动后在创建 singleton socket 时失败，未进入页面，`actualControlChecks` 为空。因此没有 Phase 5 真实 UI 点击通过证据；React SSR 和真实 HTTP 测试按各自范围记录。

IPC inventory 的 ignored 基线从原始 `f561cc7` 快照生成，再与本轮源码比较；没有从修改后的源码重写基线以掩盖 channel 变化。默认测试分类、性能/恢复串行池、单项超时和失败基线没有放宽。

本地原始日志位于 `out/diagnostics/bot-work-phase5-followup/`，包括专项、类型检查、全量门禁、原始基线 AT-SPI 失败及 dev 启动日志。最终全量证据是 `test-all-2.log` / `test-all-2-result.json`（143.82 秒，348/1）；`test-all.log` / `test-all-result.json` 及 `test-all-1.*` 记录的是首轮 147.85 秒、347/2，不能混用。它们是诊断记录，不是白名单或运行时输入。

## 6. 冻结源码身份

- 原始 Phase 5 实现冻结点：`f561cc7a2c03d644d724302eb6b0ae92f636dc1c`。
- 本轮加固实现：[`877f2cf82d0a586cf305c8ea3b7d59688bcd24b7`](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/877f2cf82d0a586cf305c8ea3b7d59688bcd24b7)。
- 后续冻结记录只改变文档，不改变经过门禁的源码。
- 源码范围涵盖 `src/`、`app/remote/src/`、`shared/src/`、`scripts/` 与 `package.json` 相对原始实现的变更。
- 指纹与逐文件清单：[bot-work-phase5-followup-source-2026-11-08.json](bot-work-phase5-followup-source-2026-11-08.json)。19 个变更源码/测试文件的聚合 SHA-256 为 `5b4fdcbf86cc575a6952678068b3b1b383f18f2d409e703b36f7d7e26788d4ad`；按路径排序，取清单 `files` 数组的紧凑 UTF-8 JSON（`ensure_ascii=False`、分隔符 `,` / `:`）计算。运行最终门禁前与提交前逐文件核对一致，暂存树为 `fe6a3ed98c0051336bc28b6c3346270485632081`。

## 7. 仍需完成的实机与外部工作

延续原实现报告 §5：Windows 原生强杀恢复/BW-A31、Omarchy/Hyprland、真实手机配对与断线重连、Phase 5 dev 点击、真实外部连接器出站适配和幂等/回查契约仍无本轮验收证据。发行包只在另行发布授权下验证。

原报告 §1 已明确保留的多专家独立“汇总通知”语义和真实原生进程十步故事也不能被这次局部加固自动视为完成。原 46 行矩阵保留其历史测试范围；本轮新增证据与限制以本报告为准，不宣称 Phase 5 或 BOT-WORK-1.0 整体验收完成。
