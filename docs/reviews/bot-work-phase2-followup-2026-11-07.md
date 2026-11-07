# Bot / Work Phase 2 复核与修复

日期：2026-11-07，Asia/Shanghai。复核基线：`main@5b5d5f6b9a5d98e93cfec72d884a53961610e80a`。

## 结论与范围

Phase 2 的独立前台、持久派发、原生结果对账和列表同步路径已落地，但“完全达标、只剩四个 Phase 3 优化点”的结论过强。本轮复现了同一输入在暂停/恢复后重复执行的问题，并修复工具契约、读取凭据生命周期和投影保留窗口的边界。

本轮沿用当前 Pi 1.5 和已有 Work / Durable 接线。完整资源声明与细粒度门控、部分成果定向补跑、团队原子交接仍按 Phase 3 验收，不能以此次修复宣称这些功能已完成。

## 对原审查文字的事实校正

| 原说法 | 当前源码事实 |
| --- | --- |
| `versionGuard`、`constraints`、`criteria` 可能未暴露给模型 | 基线 `BotForegroundTools.ts` 已包含这些字段，`versionGuard` 也是必填。实际不一致是字符串/数组边界、正整数限制和嵌套对象严格性。 |
| `work_projection_journal` 每次写完整快照 JSON | 实际表名为 `work_projection_events`，每行只有 `user_id / sequence / work_id`；`WorkProjectionJournal.sync()` 在一致事务中读取当前投影。日志无保留上限的问题成立。 |
| epoch/sequence 和 tombstone 是超额完成 | 它们是 `docs/bot-work-phase2-execution-plan.md` 的 P2-07 原定要求。 |
| 同轮多个业务输入已具备细粒度共享答案归属 | 当前安全边界是每个业务输入独立 root/store，拒绝绑定任务上共享同一原生因果的另一个业务 operation；没有宣称共享答案可精确拆分归属。 |
| 宿主互斥锁在 `WorkDispatchQueue.ts`，后续直接下沉 | 实际保守准入在 `WorkExecutionAdapter.resourceAvailable()`；规范化路径、worktree、浏览器和桌面资源声明仍属 Phase 3。 |
| 引用若干 `*Service.ts`、`WorkNativeResultInterpreter.ts` 和 `bot-work-phase2-source-attribution-test.ts` | 这些引用不是基线存在的文件。实际对应 `BotForegroundIdentity.ts`、`WorkControlNormalization.ts`、`WorkExecutionSettlement.ts`、`WorkProjectionJournal.ts`、`DurableWorkExecutionProjection.ts` 及已注册的 Phase 2/invariants/recovery 测试。preload 位于 `src/preload/index.ts`。 |

原 Windows 验收记录是此前实现的环境证据；它已经明确列出 Omarchy/Linux 桌面、移动端等未运行项。本次新增代码的验证结果单独记录在下方，不把旧记录当成本次跨平台实测。

## 修复

### 1. 同一输入暂停/恢复不会分配另一个 root

基线 `WorkDispatchQueue.enqueue()` 仅排除同输入的 pending/submitted/running/unknown 绑定，漏掉 completed/failed/stopped。前台恢复动作又会调用 schedule，因此一个已产生外部效果、尚未业务验收的 Work 在暂停/恢复后会分配新 Task/store/operation，重复执行。

新增确定性 native port 使用实际文件追加记录每次业务执行：基线在 completed → pause → resume 时效果计数从 1 变为 2，回归断言失败。修复后，同 `intentRevision + inputSnapshotId` 的已有执行事实均保留原身份；completed 继续待验收，failed/stopped 保留结果并呈现剩余工作的明确阻碍。新的输入或要求修订可以重新派发，尚未提交的准备过程和资源等待仍用原请求/绑定恢复。

恢复派发也执行同样的去重：已持久化的重复 pending 请求在 prepare 前被取消，同 operation 的原绑定仍正常恢复。显式失效成果不会抹去已执行的事实；只有明确 invalidated 且没有 attempt、submission receipt 或 submitted time 的从未投递绑定可以替换。实际回归关闭并重开 SQLite 连接验证上述崩溃恢复路径。

后续计划阻碍只代表“需要核对剩余工作”，不替代原生用量或外部效果对账，也不能使用户取消事项永久停留在 closing。取消和修订都必须精确处理这些内部阻碍，同时保留真正未结算的用量和未知效果。

### 2. 工具 Schema 与执行校验来自同一份定义

`BotForegroundTools.ts` 从严格 Zod 输入定义生成模型实际接收的 JSON Schema，并包装为 TypeBox Schema。字符串非空白/长度、数组上限、criterion 属性和三元正整数版本守卫一致，不再手工维护两套容易漂移的约束。

服务端先读后写仍要求完整 `(conversationId, requestId, workId)` 的持久读取凭据，并核对当前 Work 版本。测试同时验证序列化后的模型 Schema 和实际工具执行，覆盖额外 actor/授权/验收字段注入、错误版本、跨请求/事项/对话复用和模糊多事项控制。

### 3. 按请求终态清理临时读取凭据

仅 assistant 消息进入 completed/cancelled/failed 时，消息状态、对话 revision 与 `bot_work_reads` 删除在同一事务提交；已持久化的 completed user 消息不会结束 assistant 的读取作用域。权威宿主恢复时，按持久 receipt 对应的 assistant 身份补清理终态记录。

queued/running/unknown 不按时间删除，保留崩溃恢复需要的 guard。前台 beforeTool 与实际工具事务均拒绝终态请求的新动作，避免清理后迟到 query 再次写回 guard。消息历史、发送回执及稳定 requestId 保留。

### 4. 投影事件有界保留并补齐分页恢复

每个用户保留最近 10,000 条 `work_projection_events`。写入触发器与业务变更在同一事务裁剪，启动时也清理积累历史；不依赖在线读者触发 GC，不改 epoch，不回退 sequence。裁剪只删除同步日志，不删除 Work、成果、回执或通知。

过期游标触发 `resync_required` 并补读权威快照。renderer 现在也处理后续分页中发生的 GC/epoch 失效，不再只在第一页回退快照。回归验证边界游标、200 条分页、其他用户隔离、事务回滚、重开数据库、已裁剪 tombstone 的列表移除，以及补读后草稿和待确认发送请求保留。

### 5. 修复全量门禁暴露的 Linux 进程终止问题

`core-performance-baseline.ts` 和 terminal 单测的假 PTY 使用了 `pid=1`。Linux 的终端清理会调用 `killProcessTree()`，原代码把它变成 `process.kill(-1, "SIGKILL")`，导致整个测试进程及父级可能被广播终止。原始提交和修复中间版本都以 exit 137 终止，不能把它当作性能测试通过或擅自归因为 OOM。

平台层现在拒绝 0、1、负数、非整数及非安全整数 PID，阻止进入系统终止、child 回退和升级计时器；null/undefined 原有缺失 PID 语义保留。两个内存 PTY 夹具改用无 OS 进程的 `pid=0`。平台回归注入信号/进程依赖验证拒绝行为，测试自身不发送实际信号。

## 验证

运行环境：Linux，Node.js 24.22.1，pnpm 12.14.0，实际安装的 `pi-ai` / `pi-coding-agent` / `pi-durable` 均为 1.5.0。使用冻结 lockfile 安装依赖，没有修改依赖版本、失败基线或类型检查基线。全部测试使用隔离临时数据和确定性 fixture。

### 已通过的检查

| 检查 | 本次实际结果 |
| --- | --- |
| `pnpm -s typecheck` | web/node/scripts 通过；scripts 错误 0、基线 0、新增 0。 |
| `pnpm -s test:all --filter=bot-work` | 最终 Phase 2 修复代码：16/16 通过，已知失败 0、新增回归 0。包含真实 Pi 1.5 前后台链路、崩溃恢复、归属与用量，以及本轮新增回归。 |
| `test:bot-work-foreground-contract` | 序列化后的 Function Calling Schema 与实际工具执行共同拒绝 84 组无效输入；完整创建/修订/控制流程、严格读取与终态请求检查通过。 |
| `test:bot-work-read-lifecycle` | 10 组行为检查通过，包括事务失败/回滚、跨用户身份和重开数据库。 |
| `test:bot-work-projection-retention` | 4 组行为检查通过，覆盖无读者时有界写入、精确游标边界、墓碑、分页、回滚和启动清理。 |
| `test:bot-work-review-projection` | 7 组 renderer store 回归通过，含分页中途失效、草稿和待确认发送保留。 |
| `test:platform-providers` | 246 passed、0 failed，含全部非法 PID 拒绝路径。 |
| `test:terminal` | host 33/33、bridge 20/20、store 9/9、Herdr 7/7。 |
| `test:core-performance` | 修正虚拟 PID 后单独执行 exit 0；14 项时间预算和最大 RSS 预算全部通过。冷启动建库 p95 21.18 ms、热启动 5.21 ms、5,000 文件快照 81.19 ms、最大观测 RSS 480.8 MB。 |
| `git diff --check` | 通过。 |

### 全量门禁的限制与原始提交对照

当前 Linux 默认集合为 330 个脚本。完整执行的并行部分为 **324 passed、5 failed**，随后串行性能夹具因上述假 PID 问题中断（exit 137）。修复后单独补跑性能脚本通过，故已取得 **325 个默认脚本的通过结果**；最终派发路径补修后又独立重跑了全部 16 项 Bot/Work 门禁。

**不能将此写成 `test:all` 全绿。** 剩余五项在原始 `5b5d5f6` 的独立源码快照、同一冻结依赖环境中也逐一复现了相同失败：

| 脚本 | 修改前和修改后相同的失败原因 |
| --- | --- |
| `test:atspi-transport` | 测试私有 D-Bus 无法创建套接字：`Failed to open socket: Operation not permitted`。 |
| `test:image-resize-assets` | 当前无 `out/main/image-resize-worker.js` 产物，ENOENT。 |
| `test:oauth-bundle` | 九个 OAuth provider 的独立 smoke 检查通过；后续检查因无 `out/main/index.js` 失败。 |
| `test:pi104-features` | 版本/认证检查通过；`configurePiCodemodeAssets(out/main)` 因缺少产物而返回 false。 |
| `test:ipc-channel-inventory` | 缺少 `artifacts/ipc-channel-baseline.json`，该文件也不在原始提交树中。 |

这些结果保留为未满足的全量验证条件；没有增加失败白名单、删除断言或生成一份当前输出去覆盖缺失基线。本轮遵守仓库的开发流程约束，没有执行发布 build/pack 来补出产物。原始性能夹具的 137 已实际定位并修复，没有继续重复运行其广播终止路径。

新增回归入口：

- `pnpm -s test:bot-work-foreground-contract`
- `pnpm -s test:bot-work-read-lifecycle`
- `pnpm -s test:bot-work-projection-retention`
- `pnpm -s test:bot-work-resume-dispatch`

既有 `test:bot-work-review-projection` 增加分页中途失效后立即全量补读的行为回归。

本次没有重新执行 Windows 或 Omarchy/Hyprland 真机 GUI 验收，也未以 headless 结果替代这些环境的证据。
