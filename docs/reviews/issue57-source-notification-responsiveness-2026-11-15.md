# Issue #57：来源读回与通知投递的独立推进

## 范围与基线

- Issue：<https://github.com/qq824045252-ship-it/wavealstra_harness/issues/57>
- 实现基线：`7b899cbd3ac8dd6872932ed02e262032a3b52a76`。
- 验证日期：2026-11-15（北京时间），Node `v24.22.1`。
- 目标同时包含来源消费和 Work 通知投递；沿用现有 Work、Inbox、Outbox、执行身份、SQLite 通知账本与 Durable。
- 此次调整公共推进循环及必要生命周期接线，不改变前台模型分类、业务执行策略或审批流程。

## 实现与约束

### 来源消费

`WorkDispatchQueue.flush()` 安排文件协调、来源消费和普通派发，不再等待一个无关来源的读取完成。每个 Work 保留一个来源 flight，默认同时最多四个实际来源读取；轮转游标让等待中的 Work 公平续办。无需 I/O 的 `each` 与定时跟进事件可以在读取槽位已满时继续处理，每轮最多安排 64 个来源事件。

正常唤醒走 `flush()`；显式诊断用 `drain()` 保留等待来源、文件协调及执行提交的屏障。来源事件仍保存在原 Inbox，容量限制不会丢弃待办或创建第二份业务状态。

来源读取默认 30 秒截止，支持 AbortSignal。取消消费者与释放实际 I/O 槽位分别处理：不响应取消的读取仍占用原 Work 的槽位，直到实际 Promise 结束，防止反复 amend/wake 累积后台读取。关闭仅等待已经屏蔽迟到结果的消费者，不等待不可取消的外部调用；迟到回调在访问数据库前检查生命周期。

成功应用和错误 blocker 均核对原 Work 生命周期、版本、负责人、输入、宿主租约及原事件批次。批次核对保留 `claimVersion/frozenAt/sourceVersion/sourceEventId/mergedCount/payload`，并核对冻结 payload。读取期间的改要求、暂停、取消、负责人交接、租约重新取得或批次变化均使旧读回失效。

订阅配置与停止状态也单独核对：同一 Work 存在多个同源订阅时，停止其中一个不一定改变 Work 版本。迟到的成功或失败都不能给已停止订阅创建 blocker；仍有效的同源订阅可越过原 Inbox 行继续派发。

`WorkWatchIngress.refillBlocked()` 不再把 `_sourceReadbackError` 当作普通队列溢出立即回填；读取失败按既有来源更新或暂停/恢复语义重试原事件，避免来源完成唤醒触发连续失败循环。

### 文件和 Git 读取

文件监听协调只安排独立读取。每订阅的实际读取锁跨超时和重新配置保留，现有最多 64 个监听及单文件 4 MiB 上限继续有效。原生读取保留常规文件检查、`NONBLOCK/NOFOLLOW`、读取前后文件状态检查及关闭句柄。

Git 命令与内容流支持取消，内容采用流式 hash。一次权威观察最多 25,000 个文件、256 MiB 总内容；超过边界明确失败并保留原事件。确认删除是可观察事实，权限或 I/O 失败不能伪装成成功快照。符号链接按链接本身形成身份。

这些数字是读取资源边界，不是业务执行额度，也不是性能测量结果。

### 通知投递

`WorkNotificationHost` 将短暂的安排扫描与耗时的 route 投递分开。默认最多 16 个 route 同时投递、同一渠道最多四个，以 `channel + targetKey` 保持同目标单 flight。桌面 Work 通知和等待期间出现的新 route 可以独立进入下一轮扫描。

`WorkNotificationDelivery` 也保护直接调用的同目标顺序。通知仍使用原 effect、attempt、claim generation、不可变 payload 和回执账本；发送前重验与 unknown/lookup/部分成功回执语义保留。`recordProgress` 在关闭、取消或宿主失效后不会访问已经关闭的 SQLite。

容量满时下一轮从第一个跳过的 route 继续。内部续办只完成本轮有限扫描，外部唤醒才开启新一轮；24 个无法查询回执的 unknown route 超过容量时，回归确认扫描次数会稳定，不会形成空转重试。

原 Discord REST 队列、服务端 429 等待和四次尝试上限均保留；此次没有把限流等待改成新效果重新排队，也没有重置 nonce 或重试次数。

### 宿主身份

来源和通知异步操作使用现有 `work_host_lease` 的 authority、acquired_at、released_at 识别原租约。心跳不改变身份；新租约的 acquisition 水位保持单调，避免同一毫秒重新取得或时钟回退让旧 flight 重新变为有效。没有新增数据库 schema 或独立调度状态机。

## 顺序证据

### 来源 A 挂起期间

`test:work-dispatch-concurrency` 使用实际生产队列、执行适配器及真实 SQLite；来源和执行端 I/O 为受控夹具。释放 A 前的记录顺序为：

| 序号 | 事件 |
| --- | --- |
| 0 | 接收 A 来源事件 |
| 1 | 接收 B 普通派发请求 |
| 2 | A 来源开始读取并保持挂起 |
| 3 | B 已派发 |
| 4 | 新提交 C 普通派发请求 |
| 5 | 新接收 D 来源事件 |
| 6 | D 来源开始读取 |
| 7 | D 来源读取完成 |
| 8 | C 已派发 |
| 9 | D 已派发 |

A 在以上全部事件发生后才释放。另有实际读取槽位全部占满时，`each` 事件仍进入执行的回归。

### 文件协调

`test:work-file-event-source` 使用真实 SQLite、OS 文件与 Git，并注入一个可控慢读取。观察顺序为慢读取开始、快来源进入 Inbox、新增来源进入 Inbox、旧慢结果最终被丢弃；快来源和新增来源均不依赖慢读取返回。

### 通知与 Discord

通知专项使用真实 WorkService、SQLite 通知账本和生产 Host，外部发送为受控 I/O；Discord 部分使用真实生产适配器和模拟时钟。完整时间线随测试输出打印，不把受控夹具耗时视为真实设备延迟或 p95。

本轮受控通知记录如下。计时仅用于核对先后关系，包含夹具创建、SQLite 与测试调度开销：

| 事件 | 自夹具开始的相对时间 |
| --- | ---: |
| 独立 B 投递完成 | 154.165 ms |
| 等待中新到的桌面通知投递完成 | 313.040 ms |
| 等待中新到的独立 route 投递完成 | 322.917 ms |
| 主动释放挂起的 A | 324.993 ms |

Discord 回归让真实适配器收到 `retry_after: 300`：请求分别发生在模拟时间 `0 / 300000 / 600000 / 900000 ms`，独立 provider 和新桌面通知都在模拟时间 `0 ms` 完成。每次都完整等待服务端间隔，四次请求的 payload、nonce 相同，SQLite 仍只有一个原 effect/attempt；达到尝试上限不会重新计数。另行验证了关闭取消 backoff 后不再产生 POST。测试没有实际等待 900 秒。

## 验证记录

以下命令均已通过；不把这些专项结果表述为整个仓库 `test:all` 或 GUI 套件通过。

| 验证入口 | 覆盖与结果 |
| --- | --- |
| `pnpm -s typecheck` | Web、Node 与 scripts 检查通过；scripts 错误、基线、新增均为 0 |
| `pnpm -s test:work-dispatch-concurrency` | 38 个场景；普通派发、来源并发、实际 I/O 容量、迟到成功/失败、超时、原身份恢复、订阅停止、租约与关闭 |
| `pnpm -s test:work-file-event-source` | 真实文件监听、读取边界、Git、慢/新来源独立推进、重新配置与关闭 |
| `pnpm -s test:bot-work-phase5-delivery-dedup` | 原主组 43 个用例、新增 10 个通知并发场景、既有 multipart/QQ/closure-correction 后续用例全部通过 |
| `pnpm -s test:bot-work-phase5-gateway` | 22 passed / 0 failed；生产适配器、异步认领与恢复 |
| `pnpm -s test:discord-gateway` | 原 Discord 网关契约通过 |
| `pnpm -s test:bot-work-phase1` | 来源与 Work 基础不变量 |
| `pnpm -s test:bot-work-phase2-invariants` | 多连接租约/CAS；新增同毫秒 reacquire、心跳稳定与时钟回退身份检查 |
| `pnpm -s test:bot-work-phase3-pause-backlog` | 持久 `each/latest/skip` 暂停积压、重复/顺序、回滚与重新打开 |
| `pnpm -s test:bot-work-phase3-partial-settlement` | 原有部分结果结算 |
| `pnpm -s test:bot-work-phase4-hook-fanout` | 原 Hook 扇出与来源消费 |
| `pnpm -s test:bot-work-phase4-offline-catchup` | 离线缺口、补处理、原事件与游标恢复 |
| `pnpm -s test:bot-work-phase4-backpressure` | 冻结批次、合并截止、容量、公平与重启 |
| `pnpm -s test:bot-work-team-watch` | 成员/负责人轮次、事件去重、历史归属与暂停 |
| `pnpm -s test:bot-work-team-recovery` | 原身份续办、独立成员、结果依赖与重启去重 |
| `pnpm -s test:bot-work-resume-dispatch` | 恢复原输入去重、持久重复请求及新输入派发 |
| `pnpm -s test:bot-work-phase5-owner-summary` | 17 个负责人汇总场景 |
| `pnpm -s test:bot-work-phase5-native-story` | 真实 Pi Durable 连续 10 步、两次实际 SIGKILL、原身份恢复和通知不重发 |
| `git diff --check` | 通过 |

新增通知回归由现有 `test:bot-work-phase5-delivery-dedup` 导入运行，继续进入既有测试入口；没有增加依赖或修改测试失败基线。

## 实测边界

本次没有运行用户 Windows/Omarchy 桌面，也没有使用真实外部账号制造 Discord 429。桌面通知在回归中使用同步适配器夹具；真实系统通知展示与真实网络延迟未测量。

真实 Pi Durable 的 10 步连续恢复故事使用确定性模型与隔离的工具效果，并包含两次实际进程 SIGKILL；它验证执行身份、恢复和通知账本，不代表真实模型质量或实体手机、桌面体验验收。
