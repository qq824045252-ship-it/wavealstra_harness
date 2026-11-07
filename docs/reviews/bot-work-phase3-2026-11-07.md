# Bot / Work Phase 3 实施与验证记录

日期：2026-11-07。执行规划为 [Phase 3 执行规划](../bot-work-phase3-execution-plan.md)，规划代码基线为 `a6bb4a5`，本次同步后的起点为 `main@5fd4582`。保留 Phase 2 修复，不改冻结验收语义。

状态：P3-00～P3-08 已实际接线，组件与 headless 门禁已在本机通过。Windows 真实桌面输入验收仍受 `FOCUS_FAILED` 阻塞，因此不能标记 BW-A31 或 Phase 3 全部验收通过。

## 实现范围

- `WorkResourceGate` 负责实际资源身份、成组准入、单调 fencing、读取版本、等待取消和隔离。文件同时核对规范路径、实体及内容；新路径解析已存在父目录；目录按组件判断包含关系。Git 元数据、浏览器及物理输入采用对应范围。未知 Shell/MCP 使用较粗排他范围，缺少可信读取适配的路径请求明确阻碍，不宣称任意 Shell 获得文件级安全证明。
- `DurableToolPolicy` 与普通 Task、owned child、Code Mode 使用同一动作 gate。实际 Windows/Linux 桌面 backend 和 BrowserAutomationService 另有受管入口边界。根推理不占动作租约；只有宿主已安装全部动作边界的执行端口允许独立可变 root 并行，其他端口保留保守准入。
- `WorkResourceRecovery` 在原调度循环中执行有界核对。恢复要求实际原生任务图安静、后端队列和本驱动输入释放证明，以及原文件或供应商效果核验。过期不自动接管；旧宿主桌面缺少原驱动释放回执时仍隔离。未知效果不会被 key-up 或输入清理覆盖。
- 新子项、补跑、协作和通知事实接入当前 SQLite schema 及既有投影日志。当前 schema 为 32，沿用不兼容库改名备份后重建契约，不引入旧 Pi 或旧数据迁移。
- 原生 `results`、rejected、未启动项、冲突和实际产物经过统一结果 Inbox 落盘。有效部分成果保留为待核验材料，必要缺口单独规划，普通 pause/resume 不重做原输入。
- 缺口 continuation 有独立持久身份、缺口唯一约束和原预算预留。外部产物变化产生只读重新核验计划，实际读取当前产物后才建立新指纹，原写入不重做；原有验收和当前版本实测仍独立处理。
- 暂停积压只使用原 Inbox。满队列的索引引用原来源事实，不复制事件内容或另建消费真源。宿主循环完成 file/Git 权威回读、来源 CAS、原 Inbox 消费及 Outbox；each 保留逐事件义务，latest 不按到达顺序猜版本，skip 保存跳过事实。未配置来源显式受阻，完整外部订阅仍属 Phase 4。
- 八类协作消息校验身份、接收范围、真实执行引用、因果关系和去重。交接在既有控制事务中更新 owner、epoch、审计和有效委派接管，保留要求、输入、成果和预算。旧负责人未提交决定作废，已尝试原执行继续查回。
- 发送前读取当前通知和 Work，事务认领不可变 attempt，在事务外投递。语义失效独立于渠道失败和已读。交接保持语义卡片；unknown 先查原 payload/供应商键，不盲重发。
- Work 页面显示等待、保留子项、缺口、暂停结算、实测版本和交接历史。缺口补跑、交接和协作问题走严格的 `phase3Control` IPC。重试缓存完整原请求，包含原版本守卫。上下文使用当前执行可见的协作消息和持久访问凭证，既有 Memory 查询、读取、派生知识及写权限隔离保持生效。

## BW 场景与证据

本地日志及结构化结果位于 `out/diagnostics/bot-work-phase3/`。这些文件是运行产物；仓库提交的是可重复执行的脚本和本记录。

| 场景 | 真实行为与证据入口 | 当前边界 |
| --- | --- | --- |
| BW-A26 | `test:bot-work-phase3-pause-backlog`、`test:bot-work-phase3-native-settlement`：暂停新准入与在途结算、Hook 去重、原 Inbox、each 有界回填与两份实际效果、latest 当前 v4 对乱序 v1 只执行一次、skip、来源到原生 root 的宿主链 | 完整 Cron/GitHub 来源不在本阶段 |
| BW-A27 | `test:bot-work-phase3-handoff`：双连接 CAS 竞争、事务故障回滚、旧控制拒绝、有效原 worker 迟到成果及原预算/输入保留 | 不以 ownerEpoch 变化丢弃有效成果 |
| BW-A28 | 同 handoff 用例：逐次发送前变化、取消、交接和文件变化，成功关闭后继续交付，认领前后故障、在途与非幂等 unknown，关库重开回查 | 效果端点是独立真实 SQLite；外部渠道全面接入属 Phase 5 |
| BW-A29 / A32 | `test:bot-work-phase3-resource-gate`、`test:durable-subagent`：single/chain/parallel、局部冲突、实际 shared/worktree 回执，禁止 worktree 的计划和实际创建守卫、有效并发 1 的共享写 | 不创建当前仓库分支或 worktree |
| BW-A30 | resource-gate 与 focus-gate：两个连接、真实文件效果与屏障、无关写并发、多资源整组准入、反向集合、软硬链接/新路径/目录、读取中变化和别名改指、MCP/Shell 写前拒绝旧版本 | 外部进程没有受应用锁约束；内容复核不表述为外部原子 CAS |
| BW-A31 | `test:bot-work-phase3-focus-gate`：输入资源互斥、按下到清理、两键叠加 unknown 后部分释放仍隔离、旧 token 拒绝、清理后同 owner 可继续；focus-desktop 实际浏览器变更检查 | Windows 原生窗口连续无法获得焦点，真实输入链 blocked；Linux/Omarchy 未运行 |
| BW-A33 | partial-settlement 与 native-settlement：真实 Pi owned children 一项成功、一项启动前 rejected、一项 chain 未启动；保留产物，只补必要项；重复、重开和强杀不重复真实效果 | 原生完成不自动成为 Work 验收 |
| BW-A34 | partial-settlement：无反馈、旧输入反馈、当前失败/通过、同输入产物变化和新指纹反馈；只读重新核验 | fixture 的环境反馈不等于真实 Omarchy 实测 |
| BW-A35 | resource-gate、partial-settlement、native-settlement：同 mtime 不同内容、dirty/untracked Git、多源保留、写前及验收/发送前重验、只读产物核验 | 不扩大外部文件排他保证 |
| 关联 BW-A08 / F11 / F12 | collaboration 与 collaboration-context：八类消息持久化、越权/伪造引用拒绝、接收范围投影及历史撤权，实际 Memory 查询/直接访问/写入拒绝其他 Bot 私有记忆 | worker 推测没有自动变成团队事实 |

## 原生恢复与实际效果

`native-recovery-results.json` 保存四个受控子进程 SIGKILL 窗口的原命名空间、绑定、计划、预算和效果计数：

1. 逐项结果消费事务提交前。
2. 补跑计划已经提交、派发前。
3. 补跑请求已经保存、绑定插入前。
4. 原生补跑完成、业务 Inbox 接收前。

每次恢复均保留两个执行绑定、一个补跑计划。原产物、两个必要缺口的实际文件效果均各一次；用量为原执行 24 加补跑 38，累计 62，沿用原预算窗口。

`native-resource-recovery.json` 另记录实际 Pi owned-task graph、原存储命名空间、重开后的资源 gate 和协调器回执。只读旧租约在真实图安静后释放，旧 token 拒绝后续操作，已有文件效果计数不增加。focus-gate 的文件核验证据使用真实文件、`prepareFileEffect`、`verifyFileEffect` 和 `ExecutionAttemptRepository`；其 quiet/drain 故障端口与前述实际 Pi 图证据分开记录。

## 页面与真实环境

`test:bot-work-phase3:dev` 只启动隔离用户配置的真实 `pnpm dev`，使用本地确定性模型端点。页面发送、独立后台 root、问题保存和缺口按钮通过真实 preload/IPC/控制事务执行；同请求重试不再增加计划或 Task。

该页面测试明确种入两份子项、资源等待及暂停在途事实以检查展示，不把这些种入状态冒充实际资源冲突或暂停执行证据。截图为 `dev/phase3-page.png`，报告在 `dev/report.json`。原生执行、资源冲突和暂停行为分别由上表的行为用例证明。

Windows 原生桌面尝试使用隔离测试窗口，未操作用户业务窗口。实际前台为 `ShellExperienceHost` 的“新通知”窗口，输入 desktop 为 `Default`；目标窗口请求聚焦后，真实前台仍未改变并返回 `FOCUS_FAILED`。没有据此推断锁屏，也没有关闭用户进程或通知。已请求用户在方便时收起通知面板，再重跑桌面门禁。Chromium 捕获曾出现 `UnknownVizError`，浏览器行为检查、截图结果及失败分别保留。Linux、Omarchy、移动端及发行包桌面未运行。

## 最终门禁和交付

在 Windows 本机、Pi 1.5 锁定依赖上运行，原始输出保存在 `out/diagnostics/bot-work-phase3/final-gate-freeze.log` 与 `out/diagnostics/bot-work-phase3/freeze/`：

| 门禁 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过；web + node 无错误，`scripts/` 基线 0 条、新增 0 条 |
| `node scripts/test-all.mjs --audit` | 分类自检通过：headless 338 · GUI 54 · NETWORK 29 · DATASET 2 · pending 0；本机跳过 2 个 Linux 限定用例 |
| `pnpm -s test:all` | 通过 336 · 失败 0 · 已知失败 0 · 新增回归 0（3.3 分钟，含串行池中的 `test:core-performance`） |
| 八个 `test:bot-work-phase3-*` headless 用例（resource-gate / focus-gate / partial-settlement / pause-backlog / collaboration / handoff / native-settlement / resource-settlement） | 全部通过 |
| `test:bot-work-phase3:dev`（GUI，隔离 profile 的真实 `pnpm dev`） | 通过；报告 `out/diagnostics/bot-work-phase3/dev/report.json` 为 `status: passed` |
| `test:bot-work-phase3-focus-desktop`（GUI，真实桌面输入） | 受阻：`FOCUS_FAILED`，真实前台未被改变；证据见上节与实际桌面记录 |
| NETWORK / DATASET / Linux GUI / 发行包桌面 | 本轮未运行，不作为通过证据 |

本轮较早一次全量门禁曾出现 `test:architecture-graph` 与 `test:conversation-runtime` 两项新增回归（`final-gate.log`）；修复后按上表重跑全绿。没有修改失败白名单、lockfile 或 Pi pin，也没有用 `test:all:update-baseline` 掩盖失败。

因此本阶段的结论是：组件行为、故障恢复和 headless 门禁成立，BW-A31 的真实 Windows 桌面输入链仍受阻（前台停在 `ShellExperienceHost` 通知窗口，目标窗口聚焦返回 `FOCUS_FAILED`，未操作用户业务窗口、未关闭用户进程）；Linux/Omarchy、移动端与发行包桌面未运行，Phase 3 不得整体标记验收通过。

用户授权完成实现、更新、提交和推送。没有升级应用版本、运行发布 build/pack/dist、安装或更新快捷方式。

冻结的源码提交：`238bb999f25f9b9fd8bfd208c9ac9f0aa13db4af`（`feat(bot-work): complete Phase 3 resource gating, settlement and collaboration`）。上述门禁在该提交的工作树上运行，本记录随其后一次文档提交落库。
