# MyBuddy DuckDB 工作区验收

基线为 `6487cfd581e189328edeae7bfff98ca1d65959da`。待验版本为该提交加当前工作区改动。交接包中的原始清单和历史 SQLite 证据保留原样。

**整体未通过。** 生产入口已用 Rust Core 打开 `app.duckdb`、写入默认 Bot 并完成 `AgentService` 装配。隔离桌面在 Gateway 会话绑定装配、Pi Node Host 在 Dots 委派装配时触发 SQLite 连接保护。首窗和生产宿主就绪仍待验收。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-goal-tool-port.log) · [桌面主进程](../../out/duckdb-acceptance-20261126/desktop-main-usage-assembly.log)

本轮在 Windows x64 使用隔离临时目录。命令行和 CI 的 Node 基线为 26，本机实测 `26.13.1`。曾用独立 Node `24.22.3` 对照旧测试加载器和首启错误。桌面使用仓库固定的 Electron `44.5.1`，启动日志记录其内置 Node `24.21.0`。Pi 版本从仓库 pin 读取。pnpm 为 `12.14.0`，Rust 为 `1.97.1`，DuckDB Rust crate 为 `1.20001.0`。测试数据由各用例创建，硬杀用例使用离线模型夹具。未对真实 MyBuddy profile 执行数据库切换或清库。

上一轮 Windows Rust worker SHA256 为 `a950cebd5a045e8b04fd943f7e83bb81aad5006a77cbe11b807b4bec89f683fb`。Core supervisor、客户端、业务协议、Pi DuckDB、Native Hooks、路径经验、改进包与复盘账本专项通过。 [Supervisor](../../out/duckdb-acceptance-20261126/core-supervisor-review-v4.log) · [Core 客户端](../../out/duckdb-acceptance-20261126/core-client-review-v4.log) · [业务协议](../../out/duckdb-acceptance-20261126/core-business-protocol-review-v4.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-review-v4.log) · [Hooks 与路径经验](../../out/duckdb-acceptance-20261126/native-hooks-review-v4.log) · [改进包与复盘账本](../../out/duckdb-acceptance-20261126/improvement-packages-core-review-v4.log)

## 目标与重建

| ID | 状态 | 证据 |
| --- | --- | --- |
| DB-01 | not-run | 三个 Core 进程并发从无数据库文件的目录启动，只有一个 worker 成为实际库主。退出后读回文件头为 `DUCK`。完整应用未进入正常运行。 |
| DB-02 | failed | Core 已接管多项领域读写。生产进程装配 Gateway 和 Dots 委派时仍直接访问 SQLite。 |
| DB-03 | failed | 隔离启动不生成 `app.db`。Gateway、Dots、Goal 续跑等调用路径仍要求 SQLite 接口。 |
| DB-04 | not-run | 产品切换未执行。仅使用隔离测试目录。 |
| DB-05 | failed | 正式启动流程打开新库并通过 Core 装配 `AgentService`，随后分别在 Gateway 或 Dots 委派装配时退出。 |
| DB-06 | not-run | Rust 的重开和损坏库用例已执行。完整应用重启与持久化未验证。 |

## 并发与控制

| ID | 状态 | 证据 |
| --- | --- | --- |
| CC-01 | not-run | Rust 用屏障验证了不相交资源的事务重叠。Pi 用例同时向四个 store 写入。任务写入使用产品中的按任务队列，挂起一个任务的写入后，另一个任务通过真实 Core 先提交。未在完整桌面入口测量事务重叠。 |
| CC-02 | not-run | Rust 资源门测试覆盖同实体串行。产品实体的并发修订缺独立验证。 |
| CC-03 | not-run | Rust 关系目录和资源门通过各自的测试。父删除与子重挂的产品级并发验证未执行。 |
| CC-04 | not-run | Rust Work 调度通过冲突与容量场景。跨服务并发准入未执行。 |
| CC-05 | not-run | Rust 写入入口回归先失败后通过。同 store 的锁被测试持有时，无关 store 成功提交。排队取消覆盖一次返回和从未启动。在所有写入线程运行慢请求时的完整 IPC 过期场景尚未验收。 |
| CC-06 | not-run | Rust 测试验证提交解除 interrupt 绑定。慢提交期间的完整产品控制链未验证。 |
| CC-07 | not-run | Rust 测试验证纯数据库冲突重试。带外部效果的边界未做产品级验证。 |
| CC-08 | not-run | 保留既有 lane 源码和指标。Wave 3 在启动阶段失败。 |
| CC-09 | not-run | Rust 提交与 finalization permit 有单项测试。外部效果后必要收尾未完成故障注入。 |
| CC-10 | not-run | 调度器测试通过若干冲突场景。回滚后 ExecutorTracker 与数据库的一致性未完整验证。 |
| CC-11 | not-run | Rust 单元测试覆盖淘汰时的同根目录锁身份。HTTP 503 后许可恢复未通过完整产品验收。 |

## 完整性、事件与文件

| ID | 状态 | 证据 |
| --- | --- | --- |
| IN-01 | not-run | Rust 关系目录测试覆盖登记的关系和条件唯一规则。定时计划专项验证了删除时清理运行输入、暂停状态和 Dots 归属。完整产品写入路径未验收。 |
| IN-02 | not-run | Rust 测试覆盖五组触发副作用。所有产品入口的间接修订和通知身份未验收。 |
| IN-03 | not-run | Outbox 有 Rust 持久发布测试。产品断连和发布器重启未联合验收。 |
| IN-04 | not-run | Rust 测试覆盖强快照排空、固定 MVCC 快照和保留租约。跨连接故障组合未完成产品验收。 |
| IN-05 | not-run | 未完成 Memory scope 版本、有效期、移动和遗忘的完整产品验收。 |
| IN-06 | not-run | Rust 搜索测试覆盖中文、短查询、型号词和 scope。产品搜索和更新路径受启动问题影响。 |
| IN-07 | not-run | Wave 4 未进入故障注入。文件发布和大 BLOB 内存开销无本轮结论。 |
| IN-08 | not-run | Pi mint、commit 和执行进度使用同事务回执。隔离 IPC 注入提交后丢回复，通过原操作身份取回回执，并拒绝用同一身份提交不同载荷。其他产品写入类型未完成验收。 |
| IN-09 | not-run | Core 客户端接通实时订阅后，从快照水位补读遗漏事件。复验在快照与订阅之间插入 seq 8，再发实时 seq 9，收到顺序为 8、9。生产写入口仍有直接分配 seq 的路径，尚未完成全域 outbox 发布验收。 |
| IN-10 | not-run | 临时 delta 的 Core/Host 洪峰场景未执行。 |
| IN-11 | passed | 隔离 Host 通过真实 Core IPC 覆盖在途进度、同步洪峰、Core 拒绝、重试耗尽、提交后丢回复、取消等待和进度未确认时断连。必要进度未确认时，Core 状态为 `unknown`。 |
| IN-12 | not-run | Native Hooks、路径经验、改进包和复盘账本通过同一 DuckDB 实例验证。全域 schema 映射和实际产品入口仍待验收。 |

## Pi 和产品链路

| ID | 状态 | 证据 |
| --- | --- | --- |
| PI-01 | passed | 官方 Storage conformance 的 32 项通过真实 Rust IPC。 |
| PI-02 | passed | 官方用例验证 ID、批次前缀和 receive。附加用例验证四个 store 的数据隔离。 |
| PI-03 | passed | 官方用例覆盖分支、文档历史、fork/copy、注销重建和分页。 |
| PI-04 | not-run | IPC 用例观察到旧 writer epoch、host generation 和读代次被拒绝。旧只读句柄与历史会话在 store 被重建后都读不到新数据。完整生产 host 换代链路待验收。 |
| PI-05 | not-run | 离线 Pi 夹具在工具结果已持久化、提交仍未结算时硬杀真实子进程。重开后等待原提交完成，文件追加仍为一次。生产 PiNodeHost 的父子任务恢复仍待验证。 |
| PI-06 | failed | Core IPC 测试通过 bootstrap、manifest 和防重复派发场景。生产 PiNodeHost 已装配 `AgentService`，在 Dots 委派装配时触发 SQLite 连接保护。 |
| PI-07 | not-run | 旧 generation 拒绝有 IPC 证据。生产启动规格、退避和主动停止抑制未复验。 |
| APP-01 | failed | `AppDatabase.open` 和 `AgentService.open` 完成，Electron 在后续 Gateway 装配阶段退出。 |
| APP-02 | not-run | 夹具验证单一逻辑 store 的 purge/reopen。任务绑定、trash/restore、目录移动和导出未完成产品验收。 |
| APP-03 | not-run | Core 客户端验证订阅接入竞态与游标过期重同步。Electron 在数据库装配阶段失败，UI 水合未验收。 |
| APP-04 | not-run | Wave 3 失败于数据库装配。四类 Maintenance 周期未进入完整产品流程。 |
| APP-05 | not-run | Core 拒绝空 manifest 的场景已过。supervised-ui 和 Gateway 装配未全链路验证。 |
| APP-06 | not-run | Wave 2 未进入 Platform RPC 验收。 |

## 检查和性能

| ID | 状态 | 证据 |
| --- | --- | --- |
| QA-01 | failed | 类型和 Rust 专项通过，生产链路专项失败。 |
| QA-02 | failed | 第一轮退役旧门禁并更新测试加载器后，Node 26 默认 headless 441 通过、76 失败。后续退役两项以 SQLite 句柄和文件路径为前提的旧夹具，通过相关专项和分类复验。剩余失败包括未装配 PiStorageClient 的测试夹具。 |
| QA-03 | failed | Windows 隔离 Electron 在首窗创建前遇到 Gateway 的 SQLite 连接保护。Linux 和发行包未验收。 |
| QA-04 | failed | 退役旧门禁后的首轮 Node 26 native 门禁 3 通过、22 失败。Core supervisor 和 Core client 的 DuckDB 夹具后来各自通过。`test:core-production-lifecycle`、`test:pi-node-host` 和 Wave 2、3 仍受应用数据库接入阻塞。 |
| PF-01 至 PF-05 | not-run | 未取得同种子新旧产品对照，无吞吐、延迟、内存、启动或 ORT 争用的结论。 |

验收日志在 `out/duckdb-acceptance-20261126`。

- `pnpm.cmd run typecheck` 和 `node scripts/test-all.mjs --audit` 通过。 [类型检查日志](../../out/duckdb-acceptance-20261126/typecheck-final-node26.log) · [分类检查日志](../../out/duckdb-acceptance-20261126/classification-final.log)
- `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs` 在 Windows MSVC 环境运行 Rust 测试，69 项通过。 [Rust 日志](../../out/duckdb-acceptance-20261126/rust-final.log)
- `pnpm.cmd run test:all` 和 `pnpm.cmd run test:all:native` 均返回失败。 [Node 26 headless 日志](../../out/duckdb-acceptance-20261126/headless-final-node26.log) · [Node 26 native 日志](../../out/duckdb-acceptance-20261126/native-final-node26.log)
- Windows 原生专项 `pnpm.cmd run test:runtime-audit-native-contract` 通过 5 项 Gadget 租约断言。
- `pnpm.cmd run test:pi-duckdb-storage-conformance` 通过 Pi 官方用例与隔离 IPC 场景。 [Pi 日志](../../out/duckdb-acceptance-20261126/pi-conformance.log)
- `pnpm.cmd run test:gadget-save-workspace-desktop` 拉起隔离的 Electron 开发实例，首启时主进程报数据库格式错误。 [桌面主进程日志](../../out/duckdb-acceptance-20261126/desktop-main.log)
- `pnpm.cmd run test:pi-node-host -- --native`、`pnpm.cmd run test:core-production-lifecycle -- --native`、`pnpm.cmd run test:wave2-capabilities-recovery -- --native` 和 `pnpm.cmd run test:wave3-thin-main-concurrency -- --native` 均退出 1。 [PiNodeHost 日志](../../out/duckdb-acceptance-20261126/pi-node-host.log) · [Wave 2](../../out/duckdb-acceptance-20261126/wave2-capabilities-recovery.log) · [Wave 3](../../out/duckdb-acceptance-20261126/wave3-thin-main-concurrency.log)

## 退役的门禁

移除了以 SQLite 主库、Pi 伴生库或旧租约和 selector 为前提的十二个入口。测试源码保留供核对。

- `test:rust-writer-boundary`、`test:rust-domain-equivalence`、`test:db-schema-discard`、`test:db-migration`
- `test:durable-sqlite-storage`、`test:durable-sqlite-close-retry`、`test:bot-history-paging-sqlite`
- `test:durable-storage-current`、`test:durable-storage-lease`、`test:wave4-data-process`
- `test:durable-close-retry`、`test:durable-history-readonly`

生产首启、Core/Pi 生命周期、Wave 2 和 Wave 3 门禁仍执行。Node 26 移除的 TypeScript `transform` 模式从测试加载器删除。加载器复用 esbuild 在内存转换现有测试，业务代码和断言无需配合旧 API。

## 并发修复复测

- 保持 Pi store A 被锁时，改动前 store B 在等待期间写入 `0` 条，改动后写入 `1` 条。测试调用真实 Rust 写入入口，并读取新建的 DuckDB 来判断提交。 [修复前](../../out/duckdb-acceptance-20261126/writer-admission-before.log) · [修复后](../../out/duckdb-acceptance-20261126/writer-admission-after.log)
- 公平资源票据保留互斥请求的顺序。PiHost 先归还写连接再执行系统进程操作，收尾前重新取得原资源许可并核对进程身份。Rust 用例验证旧启动不能覆盖新状态，并用只有一条写连接的池证明进程阶段可让出连接。 [Rust 专项日志](../../out/duckdb-acceptance-20261126/pi-host-finalization-iteration.log)
- Core supervisor 与客户端用 DuckDB 夹具复验。覆盖并发启动只产生一个 owner、临时断线与崩溃重连、慢客户端隔离，以及重复关闭 UI 连接不泄漏历史会话。 [Supervisor](../../out/duckdb-acceptance-20261126/core-supervisor-duckdb.log) · [Core client](../../out/duckdb-acceptance-20261126/core-client-duckdb.log)
- 清除并重建逻辑 store 后，旧句柄读取同一记录 ID 的回归曾失败。Pi 查询和历史会话加入同一读事务内的代次校验。官方 32 项与 IPC 集成复验全部通过。 [修复前](../../out/duckdb-acceptance-20261126/pi-read-fence-before.log) · [复验](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-current.log)
- 并发启动前，Core 客户端和 supervisor 都要求数据库文件已经存在。新路径检查允许数据库文件尚未创建，仍要求可验证的父目录。负责持有 worker 锁的进程创建数据库；fixture 停机后核对文件头。 [Core 客户端修复前](../../out/duckdb-acceptance-20261126/cold-core-client-before.log) · [监督进程复验](../../out/duckdb-acceptance-20261126/cold-core-supervisor-after.log) · [客户端复验](../../out/duckdb-acceptance-20261126/cold-core-client-after.log)
- 执行进度在调用当下占用入队配额，按提交顺序送达。Core 拒绝或额度耗尽会阻止成功结算；取消也等待已入队的必要进度。传输重试复用同一进度身份。 [溢出修复前](../../out/duckdb-acceptance-20261126/progress-before.log) · [复验](../../out/duckdb-acceptance-20261126/progress-after.log)
- Core UI 订阅在实时连接接通后补读快照之后的已提交事件。补读期间用实时游标跟踪目标，避免实时到达的事件覆盖仍待补读的较早事件。 [修复前](../../out/duckdb-acceptance-20261126/subscription-before.log) · [复验](../../out/duckdb-acceptance-20261126/subscription-after.log)
- 当前 Rust 单测 76 项通过。类型检查通过，脚本检查新增错误为 0。 [Rust](../../out/duckdb-acceptance-20261126/final-rust.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-closeout.log)

## Native Hooks 与文件路径经验

- 两个 Core 客户端同时发布同一 Hook 版本，只有一个成功。两端同时安装同一个托管 Hook 得到同一初始版本。Hook 回执和回读凭据在同一事务提交，晚到的旧回执不会覆盖较新的结果。使用新建 `app.duckdb` 和离线模型运行真实 Pi 工具与会话恢复。 [专项日志](../../out/duckdb-acceptance-20261126/native-hooks-path-hints.log)
- 真实恢复请求在原工具结果之后收到一条系统工具清单更新。原测试模型按最后一条消息的角色决策，误发了新工具调用。测试模型识别工具清单消息后，恢复断言确认任务 ID 和调用 ID 一致，旧调用采用 v1，新提交采用 v2。 [失败诊断](../../out/duckdb-acceptance-20261126/native-hooks-replay-diagnostic.log) · [复验](../../out/duckdb-acceptance-20261126/native-hooks-path-hints.log)
- 同一任务并发学到不同文件路径时，两条建议都停用，另一任务的经验继续有效。用真实文件和独立 Core 客户端暂停“验证路径之后、记录使用之前”，此时停用经验，恢复后旧建议被拒绝，重启后触发数和修复数保持为 2 和 1。 [专项日志](../../out/duckdb-acceptance-20261126/native-hooks-path-hints.log)
- DuckDB schema 提升到 2，增加 Hook 的持久顺序序列，避免并发发布和回执用单行计数器排序。此次新建隔离 profile 验收，用户 profile 未清库。 [类型检查](../../out/duckdb-acceptance-20261126/typecheck-native-hooks-path-hints.log) · [门禁分类检查](../../out/duckdb-acceptance-20261126/classification-hooks-path-hints.log)
- Rust 76 项通过。改进周报导出和交付契约专项通过。 [Rust 日志](../../out/duckdb-acceptance-20261126/hooks-hints-rust.log) · [周报导出](../../out/duckdb-acceptance-20261126/hooks-hints-weekly-report.log) · [交付契约](../../out/duckdb-acceptance-20261126/hooks-hints-delivery-contract.log)

## 改进包与复盘账本

- 两端同时基于同一代次发布时只有一个成功。迟到的失败回执无法撤回较新版本。重复故障回执只记录一次并触发一次回退。回放依据在暂存后发生变化时必须重新验证。 [专项日志](../../out/duckdb-acceptance-20261126/improvement-packages-core-review-v4.log)
- 输入和验收分别按输入身份与执行代次去重。周报只确认本次取到的变更，生成期间收到的纠正仍能进入下一次复盘。 [专项日志](../../out/duckdb-acceptance-20261126/improvement-packages-core-review-v4.log)
- 前台和后台同时启动复盘时只有一个取得所有权。失去所有权的一方不能改写。重复提交同一批检查点不会增加计数，较早分析版本不能覆盖最新游标。复验还检查了每周额度、归因结果、漏周补报及重启读回。 [专项日志](../../out/duckdb-acceptance-20261126/improvement-packages-core-review-v4.log)
- 复盘通过 Core 读取任务绑定及工作目录。两个客户端验证了未绑定任务不会出现在复盘范围，修改目录后另一端能读回。 [专项日志](../../out/duckdb-acceptance-20261126/improvement-packages-core-review-v4.log)
- 独立周报导出与交付契约通过。旧应用级复盘脚本未装配 `PiStorageClient`，在实际工作流前退出。 [周报导出](../../out/duckdb-acceptance-20261126/improvement-weekly-report-review-v4.log) · [交付契约](../../out/duckdb-acceptance-20261126/improvement-delivery-contract-review-v4.log) · [应用级复盘脚本](../../out/duckdb-acceptance-20261126/native-improvement-product-review-v4.log)
- 本轮 Rust 76 项通过，Node 26 类型检查与门禁分类通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-unit-review-v4.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-review-v4.log) · [分类检查](../../out/duckdb-acceptance-20261126/classifier-review-v4.log)

## 任务、Dots 与 Python 项目绑定

- 同一个 DuckDB 上从两个客户端并发写入不同任务，检查全部记录和同一任务的过期标题保护。任务绑定与删除工作空间并发时，只接受相互一致的结果。 [专项日志](../../out/duckdb-acceptance-20261126/core-task-and-python-task-python-final.log)
- 任务写入时发现工作空间不存在，Core 在同一事务内解析目录并创建或复用空间。两个客户端请求不同空间 ID 但使用同一目录时只保留一个工作空间。任务引用的项目不存在时，工作空间随任务写入回滚。 [专项日志](../../out/duckdb-acceptance-20261126/core-task-and-python-task-python-final.log)
- 复验发现 Rust 的 Dots 初始化写入旧会话 ID，导致桌面使用的会话 ID 读不到。初始化、定时调度、记忆保护和删除保护使用同一产品 ID。专项验证按 ID 能读回 Dots，普通任务列表仍排除 Dots。 [修复前](../../out/duckdb-acceptance-20261126/core-task-and-python-task-and-python.log) · [复验](../../out/duckdb-acceptance-20261126/core-task-and-python-task-python-final.log)
- Electron 和 Pi Node Host 的 Python 项目绑定读取与保存接到 Core。专项验证子目录就近继承，解释器路径失效时执行解析明确失败，解绑恢复到上一层绑定，并验证停机重开后读回。测试使用解释器路径夹具，未运行 Python 脚本。 [专项日志](../../out/duckdb-acceptance-20261126/core-task-and-python-task-python-final.log)

- 本轮 Windows Rust worker SHA256 为 `368bfe5e9801f94298c9fb40d82f9e0290171a6691d761b977d65dbe1f949265`。Rust 76 项、Pi 官方 32 项、Core 协议、运行时租约和改进账本均通过。Node 26 类型检查及门禁分类通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-task-python.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-task-python-final.log) · [Core 协议](../../out/duckdb-acceptance-20261126/core-business-protocol-task-python-final.log) · [运行时租约](../../out/duckdb-acceptance-20261126/runtime-audit-native-contract-task-python-final.log) · [改进账本](../../out/duckdb-acceptance-20261126/improvement-packages-core-task-python-final.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-task-workspace.log) · [分类检查](../../out/duckdb-acceptance-20261126/classification-task-python-final.log)

## 任务写入顺序与定时计划

- 主进程按任务排队保存、重命名、设置截止日期、确认完成、归档和更新工作区状态。分支创建同时排在父任务和子任务之后。隔离测试暂停任务 A 的写入，确认任务 B 能通过真实 Core 提交，随后释放 A 并确认同一任务的两次写入仍按顺序完成。 [任务专项](../../out/duckdb-acceptance-20261126/core-task-and-python-cron-queue.log)
- 定时计划详情读取计划、归属和活动及最近运行的数据都来自同一 DuckDB 快照。编辑使用生成补丁时读取的版本。并发复验确认旧快照不能覆盖另一端的新版本。现有调度用例另验证重新读取后重试能保留另一端的修改。 [Core 专项](../../out/duckdb-acceptance-20261126/core-cron-cron-queue.log) · [调度回归](../../out/duckdb-acceptance-20261126/cron-scheduling-cron-queue.log)
- 删除计划时使用关系目录清理运行输入、暂停记录、排程状态和 Dots 归属。使用同一个计划 ID 重新创建时，旧归属的编辑被拒绝。两个客户端竞争同一任务最后一个自动化名额时，只接受一个。 [Core 专项](../../out/duckdb-acceptance-20261126/core-cron-cron-queue.log)
- Core 模式下任务列表和已接入的定时计划读取会报告 Core 未确认的读取错误。定时计划服务装配时直接使用 Core schema。部分 Dots 管理路径和其他仓储还在使用 SQLite。
- 本轮 Windows Rust worker SHA256 为 `26083f6eda02926605a8f974d88b91e35a23fc9cbcbb95f2c1417a8d0efe13e4`。Rust 76 项、Pi 官方 32 项、Core 协议、租约和 Node 26 类型检查均通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-cron-queue.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-cron-queue.log) · [Core 协议](../../out/duckdb-acceptance-20261126/core-business-protocol-cron-queue.log) · [租约](../../out/duckdb-acceptance-20261126/runtime-audit-native-contract-cron-queue.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-cron-queue.log)

生产切换仍需要把 `AppDatabase` 的启动和现有 Repository 调用换成类型化 Core API，包括复盘读取诊断及工作记录的路径。完成这些入口后，才切换目标测试 profile，并在全新数据库上验收生命周期、恢复和性能。

## 通知与任务删除

- 主进程与 Pi Node Host 使用 Core 读取通知、修改已读状态和清理过期记录。点击通知时，Core 在同一快照中读取并验证原目标。通知补读在一个快照中返回列表和未读数，空列表也会刷新角标。 [通知专项](../../out/duckdb-acceptance-20261126/core-notifications.log)
- 双客户端复验发现迁移后的去重索引允许重复写入。DuckDB schema 5 恢复通知键的唯一约束，并持久化桌面通知的六小时去重记录。前台与远程入口共用去重规则。专项覆盖并发发布、Core 重启后的桌面通知去重与原目标回读，以及无去重键的独立通知。 [通知专项](../../out/duckdb-acceptance-20261126/core-notifications.log)
- 原任务删除 SQL 在 DuckDB 沿用了 SQLite 的 `char`。普通删除与彻底删除共用同一事务内的清理逻辑，保留记忆摘录并清理看板记录。过期的回收站快照会拒绝彻底删除。两种删除成功后，旧通知都无法打开原任务。 [修复前](../../out/duckdb-acceptance-20261126/core-notifications-before-task-delete.log) · [复验](../../out/duckdb-acceptance-20261126/core-notifications.log)
- Windows Rust worker SHA256 为 `a699863cc93d97e96ad8671ad9d898828338d0c856e8b4dbd937775b622095d0`。Rust 76 项、Pi 官方 32 项与集成测试、Core 协议、Node 26 类型检查和门禁分类均通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-notifications.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-notifications.log) · [Core 协议](../../out/duckdb-acceptance-20261126/core-business-protocol-notifications.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-notifications.log) · [分类检查](../../out/duckdb-acceptance-20261126/classification-notifications.log)
- 通知点击回归、任务并发写入与 Python 绑定专项通过。 [点击回归](../../out/duckdb-acceptance-20261126/notification-routing.log) · [任务与 Python](../../out/duckdb-acceptance-20261126/core-task-and-python-notifications.log)
- 生产生命周期原生门禁仍在 `AppDatabase.open` 的 SQLite 探测处返回 `SQLITE_NOTADB`。通知专项使用真实 Core 和临时 DuckDB，桌面点击通过回调夹具检查。整机验收仍待完成。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-notifications.log)

## 任务看板

- Electron 和 Pi Node Host 启动时直接装配 Core 看板客户端。IPC 接收视图、范围、排序游标、时间边界和即时审批状态。查询、翻页计数及操作可见性都由 Rust 执行。
- 看板观察记录与任务终态、成果登记和刷新、交互确认以及 Bot 接收回执和交付结果在各自的事务内保存。隔离 Core 用例覆盖真实读写、归档工作空间下的操作拒绝、稳定分页、自动化下钻、即时审批、失败原因和 Bot 请求范围。 [看板原生专项](../../out/duckdb-acceptance-20261126/core-task-board.log)
- 固定占住任务 A 的写许可时，任务 B 的看板计划仍能提交。释放后任务 A 按顺序安排、清除计划并记录访问。单独暂停 Node 端一条待写观察时，无关范围的看板页仍能读取。Core 重启后延期、结果时间和已读动作都能读回。 [Rust 并发验收](../../out/duckdb-acceptance-20261126/rust-task-board.log) · [看板原生专项](../../out/duckdb-acceptance-20261126/core-task-board.log)
- 移除了 `test:runtime-audit-lifecycle` 和 `test:dots-dispatch-failure`。前者依赖旧 worker 协议和外部 SQLite 写锁，后者通过旧 SQLite 夹具启动 Dots，在行为断言前缺少 Pi Storage 客户端。原生验收改用 `test:core-task-board`，并继续执行 Core 生命周期、订阅和恢复验收。旧看板行为夹具单独保留。 [旧生命周期门禁](../../out/duckdb-acceptance-20261126/runtime-audit-lifecycle-legacy.log) · [旧 Dots 门禁](../../out/duckdb-acceptance-20261126/dots-dispatch-legacy.log) · [看板行为夹具](../../out/duckdb-acceptance-20261126/task-board-renderer-fixture.log)
- 优化后的 Windows worker 协议为 91，SHA256 为 `8b96687c3ecda16b3d3982c27e331b2e7b7d882c700a5a23de067ba0c8b51fb6`。Rust 77 项、Pi 官方 32 项和集成测试、Core 业务协议、Node 26 类型检查均通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-task-board.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-task-board.log) · [Core 协议](../../out/duckdb-acceptance-20261126/core-business-protocol-task-board.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-task-board.log)
- 生产生命周期门禁用新 worker 复测，仍在 `AppDatabase.open` 的 SQLite 探测处退出。看板复验使用真实 Core 和隔离数据，完整桌面启动验收待完成。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-task-board.log)

## Gadget 和 Blueprint

- 主进程与 Pi Node Host 使用只接 Core 的 Gadget 仓储。Blueprint 仓储和实例化回执也从 Core 读取。两端同时编辑名称、描述和配置时，只提交请求中指定的字段。测试暂停后台编辑，在主程序完成改名后恢复后台保存，并回读数据库和 manifest。 [工作台原生专项](../../out/duckdb-acceptance-20261126/core-workbench.log)
- 相同 Gadget 的源码、元数据和清理使用同一资源许可。固定占住一个 Gadget 的源码写许可时，另一个 Gadget 仍能提交修改。任务可见范围由 Core 读取，保存、复制和导出按最新范围检查。测试把 Gadget 移出范围，再用原源码版本请求保存和导出，核对源文件和目标目录。 [Rust 并发验收](../../out/duckdb-acceptance-20261126/rust-workbench.log) · [权限复验](../../out/duckdb-acceptance-20261126/core-workbench.log)
- DuckDB schema 6 保存工作台操作的身份和原结果。Blueprint 用例在真实写入提交后丢弃首次回复，客户端通过回执确认结果。Core 重启后同一操作返回原结果，实例目录和文件可回读。 [工作台原生专项](../../out/duckdb-acceptance-20261126/core-workbench.log)
- Gadget 宿主专项直接连原生 Core，使用隔离目录真实运行静态站点与 Node、Python、Go、Rust 后端。覆盖并发首调用、空闲回收、进程退出和 UI 断开后的代次保护。 [Gadget 宿主专项](../../out/duckdb-acceptance-20261126/rust-gadget-host-workbench-final.log)
- Windows worker 协议为 92，SHA256 为 `0c5db2937dc385005ff458dae70b76c5fcc4c14621bbe8c86cc74232bc51af41`。Rust 78 项、Pi 官方 32 项和集成测试、看板回归、Node 26 类型检查和门禁分类通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-workbench.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-workbench.log) · [看板回归](../../out/duckdb-acceptance-20261126/core-task-board-workbench.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-workbench.log) · [分类检查](../../out/duckdb-acceptance-20261126/classification-workbench.log)
- 生产生命周期用 schema 6 的 worker 复测，`AppDatabase.open` 仍在 SQLite schema 探测处返回 `SQLITE_NOTADB`。上述原生业务和宿主验收使用实际 Core 与临时数据目录。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-workbench.log)

## 成果登记、清理和回读

- DuckDB schema 7 以任务和操作 ID 保存回执，并校验重试的请求内容。同一任务后续写入、宿主重连和 Core 重启后仍能回读早先的提交结果。删除任务时，在同一事务内清理所属成果、依赖、消息来源、修订和回执。受管文件由 Core 清理。 [成果原生专项](../../out/duckdb-acceptance-20261126/core-artifacts.log)
- Core 在同一任务的写许可内合并同一路径的登记请求，保留两次工具调用的消息来源。独立任务可同时写入。Rust 用例暂停一项任务的受管成果写入，验证另一个任务在释放许可前已经写入文件和回执。成果清理与受管文件写入共用资源许可。 [Rust](../../out/duckdb-acceptance-20261126/rust-artifacts.log)
- 成果单项读取、内容和图片预览、来源以及文件依赖已接入 Core。Gadget 取回成果和 Dots 收集外部任务成果时使用 Core 读取。文件验收直接使用临时 DuckDB，覆盖超过 20 MiB 的分块、UTF-8、链接边界、图片取消、文件变化和孤儿清理。旧 SQLite 成果门禁移除了 `--native` 路径，保留适用的行为夹具。 [成果原生专项](../../out/duckdb-acceptance-20261126/core-artifacts.log) · [成果行为夹具](../../out/duckdb-acceptance-20261126/artifact-domain-fixture.log)
- 优化后的 Windows worker 协议为 93，SHA256 为 `939c68c6eb79799150d6a295ced53be178d06eadaf84a4457142df9d3df848d0`。Rust 79 项、成果行为夹具 119 项、Pi 官方 32 项和集成测试、Node 26 类型检查和门禁分类通过。通知、工作台和看板专项也通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-artifacts.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-artifacts.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-artifacts.log) · [分类检查](../../out/duckdb-acceptance-20261126/classification-artifacts.log) · [通知](../../out/duckdb-acceptance-20261126/core-notifications-artifacts.log) · [工作台](../../out/duckdb-acceptance-20261126/core-workbench-artifacts.log) · [看板](../../out/duckdb-acceptance-20261126/core-task-board-artifacts.log)
- 生产生命周期在临时数据库上复现 `SQLITE_NOTADB`。`AppDatabase.open` 仍让 SQLite 读取 Rust Core 创建的 DuckDB 文件，整机验收尚未完成。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-artifacts.log)

## 生产数据库入口

- 生产 `AppDatabase.open` 直接连接 Core，默认打开 `app.duckdb`。Rust 从实际打开的库返回格式、schema 和数据库代次。隔离测试并发启动 UI 和后台客户端，校验双方读取同一代次、重开数据保留、旁边的 `app.db` 不被打开或更改。 [启动与任务专项](../../out/duckdb-acceptance-20261126/core-task-and-python-database-open.log)
- Windows 冷启动复现了并发发布 Core 可执行文件时的误报。另一客户端删除临时硬链接会改变文件的 `ctime`。已发布文件在这类变更后重新计算并校验哈希，内容或文件身份变化仍会失败。旧进程镜像、崩溃重连和版本切换回归通过。 [Core 客户端](../../out/duckdb-acceptance-20261126/core-client-database-open.log)
- 工作区改名后的路径修复等待 Core 提交并报告实际更新数。更新会核对原路径及原文件是否仍存在，防止启动修复覆盖并发的用户改绑。初始资料目录通过 Core 返回库条目、成果和用户名称。启动用例也核对过期记忆候选进入待审核、近期候选继续等待。旧工作区测试删去 SQLite 旧表迁移断言，并在所有异步用例结束后统计，保留的 11 项通过。 [启动与任务专项](../../out/duckdb-acceptance-20261126/core-task-and-python-database-open.log) · [工作区行为](../../out/duckdb-acceptance-20261126/task-workspace-migration-database-open.log)
- Windows Core worker 协议 94，SHA256 为 `d9398569b5cabb0296db982029006c54d8a42ce06a9c58ebd23e2ba1e2c744bb`。Rust 79 项、Pi 官方 32 项及集成测试、Node 26 类型检查通过。启动与任务专项在四个独立临时库连续通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-database-open.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-database-open.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-database-open.log) · [第四次冷启动复验](../../out/duckdb-acceptance-20261126/core-cold-recheck-4.log)
- 隔离 Electron dev 实际创建 `app.duckdb`，未产生 `app.db`，随后在构造 `AgentService` 的运行上下文快照仓储时触发剩余的同步 SQLite 访问。独立 Pi Node Host 走到同一处，尚未报告就绪。生产生命周期和首窗启动仍待验收。受管笔记中断后的文件恢复还需移到 Core。 [Electron 启动](../../out/duckdb-acceptance-20261126/desktop-main-database-open.log) · [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-database-open.log)

## 运行上下文、诊断与文件审查

- Electron 和 Pi Node Host 的快照和诊断使用 Core，两个宿主可以各自写入。快照按任务排队，丢失回复时用原操作 ID 查询结果。后台维护把快照正文按内容哈希去重，清理无引用正文。Rust 用例以相同提示词固定暂停任务 A，确认任务 B 在解除暂停前已提交。Node 客户端专项在同一个宿主上暂停任务 A 的完成写入，确认任务 B 可照常保存及读取。 [Rust](../../out/duckdb-acceptance-20261126/rust-observability.log) · [Core 专项](../../out/duckdb-acceptance-20261126/core-observability.log)
- DuckDB schema 8 持久化快照回执和每个诊断写入端的顺序。删除任务同时删除其快照、回执、诊断及审查记录。文件审查通过 Core 读写，过期的捕获不能替换当前记录，拒绝操作保留手工修改的文件。 [Core 专项](../../out/duckdb-acceptance-20261126/core-observability.log)
- 移除了依赖 SQLite 启动 Durable 的 `test:task-code-review`，以及 `test:runtime-materials` 和 `test:task-diagnostics` 中的 SQLite 原生模式。适用的单项行为夹具和桌面文件审查门禁保留。 [旧审查门禁](../../out/duckdb-acceptance-20261126/task-code-review-observability.log) · [诊断回归](../../out/duckdb-acceptance-20261126/task-diagnostics-observability.log) · [材料回归](../../out/duckdb-acceptance-20261126/runtime-materials-observability.log) · [Git 审查回归](../../out/duckdb-acceptance-20261126/git-code-review-observability.log)
- Windows 优化 worker 协议 95，SHA256 为 `f47d7ca69289df21516221787da0c64d13b5f3f29d8e07baed7b30692f3f7ba5`。Rust 80 项、Pi 官方 Storage 32 项及集成测试、任务与 Python、成果专项均通过。Node 为 26.13.1，类型检查和门禁分类通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-observability.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-observability.log) · [任务与 Python](../../out/duckdb-acceptance-20261126/core-task-and-python-observability.log) · [成果](../../out/duckdb-acceptance-20261126/core-artifacts-observability.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-observability.log) · [分类检查](../../out/duckdb-acceptance-20261126/classification-observability.log)
- 同一 worker 的 Core 协议、通知、任务看板和工作台回归通过。 [Core 协议](../../out/duckdb-acceptance-20261126/core-business-protocol-observability.log) · [通知](../../out/duckdb-acceptance-20261126/core-notifications-observability.log) · [看板](../../out/duckdb-acceptance-20261126/core-task-board-observability.log) · [工作台](../../out/duckdb-acceptance-20261126/core-workbench-observability.log)
- Windows 隔离 Electron dev（Electron 44.5.1 内嵌 Node 24.21.0）创建了 `app.duckdb`，`AgentService` 已越过快照和诊断装配，在 `BotRegistry` 取得同步 SQLite 连接时退出启动流程。生产生命周期用 Node 26 启动真实 Pi Node Host，宿主在同一处失败，门禁在等待宿主就绪时报错。首窗和完整生产生命周期验收仍待完成。 [Electron 启动](../../out/duckdb-acceptance-20261126/desktop-main-observability.log) · [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-observability.log)

## Bot 注册与生产启动

- Electron 和 Pi Node Host 的启动入口在装配前等待 Core 登记默认 Bot。Bot、初始专家版本与用户主角色由同一事务保存。按 Bot 和用户主角色协调写入。已有 Bot 的名称、专家版本及归属保持原值，删除时在同一事务释放主角色。专项覆盖回复丢失后重新登记、不同请求内容复用操作 ID 被拒绝，以及删除和重启后迟到的重试仅返回原回执。 [Rust](../../out/duckdb-acceptance-20261126/rust-bot-receipts.log) · [Core 启动与任务专项](../../out/duckdb-acceptance-20261126/core-task-and-python-bot-bootstrap.log)
- 技能列表、技能归属检查和定时计划的技能名称读取改用 Core Bot 查询。独立的 Bot/Work 行为夹具、租约、定时计划并发及技能修订回归通过。 [Bot/Work](../../out/duckdb-acceptance-20261126/bot-work-phase1-bootstrap.log) · [调度租约](../../out/duckdb-acceptance-20261126/work-host-authority-bot-bootstrap.log) · [定时计划](../../out/duckdb-acceptance-20261126/cron-scheduling-bot-bootstrap.log) · [技能修订](../../out/duckdb-acceptance-20261126/memory-skill-revision-bot-bootstrap.log)
- 隔离 Electron dev 和真实 Pi 宿主均越过 Bot 注册，随后在构造 `WorkService` 时触发 SQLite 连接保护。冷启动和真实生命周期门禁继续执行。 [Electron 启动](../../out/duckdb-acceptance-20261126/desktop-main-bot-bootstrap.log) · [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-bot-bootstrap.log)
- Windows 优化 worker 协议 96，SHA256 为 `99cc7d246a99bff07eedc870f9d535622f7c6fd6ef7fce1e4204ee040d1b052f`。Rust 81 项、Pi Storage 官方 32 项及集成测试、Core 快照诊断、看板和定时计划专项通过，Node 26.13.1 类型检查通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-bot-receipts.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-bot-bootstrap.log) · [Core 快照诊断](../../out/duckdb-acceptance-20261126/core-observability-bot-bootstrap.log) · [看板](../../out/duckdb-acceptance-20261126/core-task-board-bot-bootstrap.log) · [定时计划](../../out/duckdb-acceptance-20261126/core-cron-bot-bootstrap.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-bot-bootstrap.log)

## 对话快照与执行归属

- 桌面和远程状态入口从同一个 DuckDB 读快照取得问题、当前 Goal、历史 Goal、来源与续跑信息。专项核对已关闭 Goal、来源与验收依据、跨用户范围、旧续跑状态和仍可辨认的历史 Work 执行。 [Core 专项](../../out/duckdb-acceptance-20261126/core-observability-work-context.log) · [远程](../../out/duckdb-acceptance-20261126/remote-access-work-context.log) · [远程 ACP](../../out/duckdb-acceptance-20261126/acp-remote-work-context.log)
- Core 按任务协调交互写入。固定暂停任务 A 时，任务 B 已保存问题。重复执行 ID 只能有一个待回答问题。任务删除时清理问题，迟到写入不能给已删除任务补写问题。 [Rust 并发验收](../../out/duckdb-acceptance-20261126/rust-work-context-final.log) · [Core 专项](../../out/duckdb-acceptance-20261126/core-observability-work-context.log)
- 提交、模型请求、工具和启动恢复等待执行归属检查。模型验收用实际 Pi、Core 和本地 HTTP provider，模拟请求重试、授权未确认、撤销及另一个任务继续运行。文件工具验收在授权等待时取消并核对磁盘。旧 SQLite provider 夹具改用真实 Core，纳入原生门禁。 [模型请求](../../out/duckdb-acceptance-20261126/durable-provider-authority-work-context.log) · [工作区文件](../../out/duckdb-acceptance-20261126/durable-tool-coordination-work-context.log) · [恢复队列](../../out/duckdb-acceptance-20261126/durable-resume-admission-work-context.log)
- Windows 优化 worker 协议 97，SHA256 为 `a461ecfb500d252ff2363da5794a6b7d75e7f003593a31e27ae3c22637a05326`。Rust 82 项、Pi Storage 官方 32 项及集成测试、Node 26.13.1 类型检查、分类核对及看板通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-work-context-final.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-work-context.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-work-context.log) · [分类](../../out/duckdb-acceptance-20261126/classification-work-context.log) · [看板](../../out/duckdb-acceptance-20261126/core-task-board-work-context.log)
- 隔离桌面和真实 Pi 宿主能打开 Core 数据库并写入主 Bot。两端的 `WorkService` 装配仍要求 SQLite，所以完整启动未通过。Goal 写入、续跑和 Work 装配仍待切换。 [Electron](../../out/duckdb-acceptance-20261126/desktop-main-work-context.log) · [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-work-context.log)

## Goal 创建与事件发布

- 桌面 Goal 创建入口向 Core 提交命令。Work、冻结的专家版本、来源、续跑用量基线、事件和回执一起写入 DuckDB。Rust 用真实写入器暂停任务 A，确认任务 B 仍能提交，也核对了来源消息的冻结配置和此前的用量水位。 [Rust](../../out/duckdb-acceptance-20261126/rust-goal-publisher.log)
- 修复 Core 运行时未启动 outbox 发布器的问题。发布事务一起写入事件和 Work 列表游标。写入在提交后通知发布器，Core 重启时发布器扫描上次已提交的待发布事件。 [修复前的双客户端复现](../../out/duckdb-acceptance-20261126/core-goal-projection-before-fix.log)
- 双客户端同时提交时，同一操作只创建一个 Goal，不同操作争用同一对话时只有一个写入成功。Work 列表、实时订阅和事件回放各收到对应的单条记录。Core 重启后可凭原操作身份取回原回执，Work 列表无重复事件。 [Core 专项](../../out/duckdb-acceptance-20261126/core-observability-goal-publisher.log)
- Windows 优化 worker 协议 98，SHA256 为 `49f8ab8dc74a8f0808733db39b4d4a6914c5b9eb935606f917e89bb8065f3cfb`。Rust 83 项、Pi 官方 32 项及集成测试、任务看板、Core 业务协议、Node 26 类型检查和分类审计通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-goal-publisher.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-goal-publisher.log) · [看板](../../out/duckdb-acceptance-20261126/core-task-board-goal-publisher.log) · [业务协议](../../out/duckdb-acceptance-20261126/core-business-protocol-goal-publisher.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-goal-publisher.log) · [分类审计](../../out/duckdb-acceptance-20261126/classification-goal-publisher.log)
- 移除依赖旧 SQLite Durable 启动的 `test:conversation-goal-prompt`。生产生命周期门禁保留，其成果和任务回读使用 Core IPC。Windows 隔离桌面与真实 Pi 宿主仍停在 `WorkService` 对 SQLite 连接的依赖。Goal 的更新、取消、续跑和完整桌面验收仍在迁移范围内。 [桌面](../../out/duckdb-acceptance-20261126/desktop-main-goal-publisher.log) · [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-goal-publisher.log)

## Durable 绑定、恢复候选和启动装配

- 桌面的被动历史、提问索引和标题读取可以通过 Core 查找会话绑定。启动恢复通过稳定任务键分页枚举，再在出队时复核绑定、回收站状态及执行权限。Rust 分页测试核对了 514 个有效绑定，并验证孤立记录不参与恢复。 [Rust](../../out/duckdb-acceptance-20261126/rust-durable-binding-final.log)
- Durable 投影的写入许可按任务取得，目录绑定再按目录取得许可。一个任务被阻塞时，另一个任务仍能保存绑定。绑定写入拒绝已删除或移入回收站的任务，同一任务重复绑定原目录可重试，竞争目录收到明确冲突。 [Rust](../../out/duckdb-acceptance-20261126/rust-durable-binding-final.log) · [修复前复现](../../out/duckdb-acceptance-20261126/core-durable-binding-before-guard.log)
- 永久删除先从权威绑定取出对应的 store 目录，再在原事务中退役该逻辑 store、清除绑定及任务的 Durable 投影。修复前删除只清除了任务行，重建同一任务 ID 后会重新读到原绑定和回收站状态。双客户端复验覆盖竞争绑定、工作目录变更、回收站保护、旧写入端被拒绝、其他 store 继续写入及重建后的空绑定。 [修复前复现](../../out/duckdb-acceptance-20261126/core-durable-binding-before-purge.log) · [Core 专项](../../out/duckdb-acceptance-20261126/core-durable-binding-final.log) · [复验](../../out/duckdb-acceptance-20261126/core-durable-binding-recheck.log)
- Pi 启动的 Azure 设置检查从 Core 读取任务目录并保存模型选择。桌面和 Pi 共用的成果服务装配直接使用 Core。Durable 投影与工作目录搬迁的写入口不再为选择写入端而读取 SQLite 连接。隔离桌面和 Pi 宿主仍在进入这些步骤前停在 `WorkService` 装配。 [桌面](../../out/duckdb-acceptance-20261126/desktop-main-durable-binding.log) · [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-durable-binding.log)
- Windows 优化 worker 协议 99，SHA256 为 `834de02bac6c910031b279181ccc5fd3c14b30a06c67fb074792293db8f7251b`。Rust 85 项、Pi 官方 32 项及集成测试、Core 可观测性、任务看板、成果和 Node 26 类型检查通过。 [Rust](../../out/duckdb-acceptance-20261126/rust-durable-purge.log) · [Pi](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-durable-purge.log) · [Core 可观测性](../../out/duckdb-acceptance-20261126/core-observability-durable-purge.log) · [看板](../../out/duckdb-acceptance-20261126/core-task-board-durable-purge.log) · [成果](../../out/duckdb-acceptance-20261126/core-artifacts-durable-purge.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-durable-binding.log)

## Work 装配与 Goal 工具

- `AgentService` 的 Core 装配专项使用 `isolated-client`。SQLite 版 `WorkService` 只在显式测试夹具构造。Goal 工具读取 Core 目标版本，Core 新建 Goal 持久化模型作者和原始输入消息身份。修改和验收工具仍待迁移。 [Core 装配复验](../../out/duckdb-acceptance-20261126/core-task-and-python-goal-tool-assembly.log)
- 桌面外部执行器恢复直接选择 Core 路径。用量回填从 Core 读取会话文件路径，包含已归档和回收站任务。回填异步排队，Core 读取失败会进入现有错误处理。
- Windows worker 协议 101，SHA256 为 `e2d548b379749ba8e39d0298dd5e7dbd6913f59483100138752316b9356dba05`。Rust 85 项、Pi 官方 32 项及集成、Core 可观测性和 Node 26 类型检查通过。Core 专项核对同一对话的并发 Goal 创建只接受一个，重复提交只公布一次事件，重启后新 Core 所有者的版本单调前进。 [Rust](../../out/duckdb-acceptance-20261126/rust-goal-tool-assembly-final.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-goal-tool-assembly.log) · [Core](../../out/duckdb-acceptance-20261126/core-observability-goal-tool-assembly.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-audit-final.log)

## 生产路径上的 SQLite 残留

八路源码排查以 DuckDB 模式的实际入口为准。协议 111 的隔离 Windows 桌面已创建窗口并载入渲染页面，首屏互动未验收。Node 26 Pi 宿主已通过执行服务构造，启动时在 Goal 恢复进入旧 Work 夹具后退出。其余入口的验收范围见各专项记录。 [桌面日志](../../out/duckdb-acceptance-20261126/desktop-main-dots-file-watch-111.log) · [Pi 宿主日志](../../out/duckdb-acceptance-20261126/core-production-lifecycle-dots-111.log)

### 挡住启动或第一轮聊天

- **桌面装配**。注册 IPC 会依次装配 Dots 委派、活动、报告和主动交付，仍传入 SQLite。启用 Android Remote 时也会触发旧 Work 桥接，故障会被捕获。 [Dots IPC](../../src/main/index.ts#L795) · [远程](../../src/main/remote/RemoteAccessController.ts#L137)
- **Pi 装配与恢复**。Dots 委派是实测首错。报告、主动交付和 Dots 验收仍依赖旧服务。`agent.init()` 随后会装配旧执行指标并扫描渠道会话目录。恢复候选分页已接 Core，打开候选会话时的任务、专家、绑定、搬迁和投影水位仍同步读取；默认设置下还会同步读取待提炼记忆，之后调用旧 Goal 续跑服务。 [Pi 装配](../../src/main/host/PiNodeHost.ts#L338) · [Durable 启动](../../src/main/agent/durable/DurableBotService.ts#L195) · [会话恢复](../../src/main/agent/durable/DurableBotService.ts#L490) · [恢复入口](../../src/main/agent/AgentService.ts#L2257)
- **发送第一条普通消息**。输入记录先调用旧 Goal 续跑。随后还有持久提交去重、工作目录解析、专家选择、写入授权、等待输入检查、提示词审计和模型用量记账。现有 Core 的任务、专家及 Durable 绑定读取可复用。连接器孤儿对账也已在实际 Pi 启动日志中触发 SQLite 保护并被捕获。 [提交](../../src/main/agent/AgentService.ts#L5902) · [目录](../../src/main/agent/AgentService.ts#L2800) · [工具权限](../../src/main/agent/AgentService.ts#L2513) · [连接器对账](../../src/main/agent/AgentService.ts#L1099)

### 功能触发后的残留

| 范围 | 旧库入口与影响 |
| --- | --- |
| Gateway | 常规持久入站的收件、会话分配、恢复列表、执行及发送认领已接 Core，扫码授权与撤销已接渠道事务。Slack 独立队列的会话预留、协作渠道续回创建、Durable 私人记忆隔离和记忆范围仍有 SQLite 调用链。 [收发队列](../../src/main/gateway/GatewayDeliveryJournal.ts) · [路由](../../src/main/gateway/GatewayConversationSession.ts#L61) · [Durable 隔离](../../src/main/agent/durable/GatewayConversationIsolation.ts) |
| Dots | Core 已接前台读取、待补要求、后续计划、活动和主动队列。原始未准备回传的研判、部分用户操作、Goal 结项接线和按空间暂停仍待完整生产验收。 [操作](../../src/main/dots/DotsActions.ts) · [活动](../../src/main/dots/DotsActivity.ts) · [Core 回传](../../native/runtime-audit/src/dots_reply_data.rs) |
| Work、Goal 和提问 | Goal 编辑、暂停、继续、取消、证据及模型提议完成仍访问旧 Work。聊天分支、历史 Bot 详情、提问回答和关闭也仍有旧读。Goal 验收需同时校验任务、三项版本和证据。桌面和手机竞争同一提问时应使用 Core 的结算回执。 [Goal](../../src/main/agent/AgentService.ts#L1581) · [工具](../../src/main/agent/conversation-runtime-extension.ts#L208) · [提问](../../src/main/agent/ConversationInteractionRepository.ts#L100) |
| 记忆 | 搜索和自动召回仍同步取得 scope 与版本，多类设置写入在 Core 前读取 SQLite 事务状态。Durable 原始捕获已接 Core。待提炼的认领和发布需要校验来源、撤回及 owner，记忆整理恢复也需避免暂停其他活跃宿主的任务。 [搜索和召回](../../src/main/memory/MemoryService.ts#L1221) · [提炼](../../src/main/agent/AgentService.ts#L5279) · [整理恢复](../../src/main/memory/MemoryOrganizationService.ts#L73) |
| 任务、项目与资料库 | 任务归档、回收、恢复、永久删除、终端工作目录和分支仍有旧状态读取。项目普通写入在准备快照时开 SQLite 事务，项目文件迁移和导入也有旧读。资料库浏览、搜索、附件维护和原子建集合并绑定仍待迁移。 [回收检查](../../src/main/task/TaskExecutionWorkspaceLifecycle.ts#L354) · [项目写入](../../src/main/project/ProjectService.ts#L572) · [资料库搜索](../../src/main/library/LibraryService.ts#L544) |
| 工作区与成果 | 共享上下文、材料检索设置仍有提前读取 SQLite 的守卫。项目和工作区便签管理已接 Core，提示词和子代理的便签证据与权限复核仍用旧库。成果 HTML/CSS 预览、Gadget 导出目录和 Blueprint 工作区捕获仍有同步旧读。 [共享上下文](../../src/main/workspace/WorkspaceSharedContextService.ts#L273) · [便签证据](../../src/main/project/ProjectNotesService.ts#L57) · [成果预览](../../src/main/index.ts#L3830) |
| 自动化、维护和诊断 | 项目归档的准备步骤仍读取旧库。Core 归档与停用计划需要同事务完成。回收前停计划、Dots 运行前校验、Library 维护、载入诊断和用量月报还有旧读。 [计划](../../src/main/cron/CronService.ts#L910) · [Pi 维护](../../src/main/host/PiNodeHost.ts#L887) · [用量月报](../../src/main/usage/UsageStatsService.ts#L744) |
| 回答规则 | 回答规则的保存、备注和首次选择仍走旧库。 [回答规则](../../src/main/agent/AnswerRoutingService.ts#L350) |

### 排查时已修复并复验

- Gateway 消息日志通过既有 Core 命令读写。UI 和后台客户端同时投递相同事件只保存一条，其他会话的消息也保存成功。按会话读取时未串入其他消息，数量上限生效。隔离测试未连接外部渠道。
- 项目及工作区便签装配直接选择 Core。工作区便签的两个编辑端竞争同一版本时只接受一个。模拟保存已提交但回复丢失，再从 Core 确认正确的版本和正文。
- 数据库关闭前可以等待写入队列并重新打开同一 Core 实例。SQLite Work 写队列只在有 SQLite 夹具时等待。启动与聊天仍受上表阻塞。 [专项日志](../../out/duckdb-acceptance-20261126/core-gateway-scoped-notes-close.log)

## Gateway 渠道配置与重连

- 普通连接、断开、已保存配置和恢复通过异步渠道接口读取。Core 按渠道对照调用者读取时的配置与连接状态，在同一事务写入新状态和操作回执。两个客户端同时修改同一配置时只接受一个，丢回复时用原操作身份取回结果，复用身份提交不同配置时拒绝。Rust 测试暂扣一个渠道的写入许可，另一个渠道在释放之前完成提交。全部 86 项 Rust 测试通过。 [Core 专项](../../out/duckdb-acceptance-20261126/core-gateway-channels-final.log) · [Rust](../../out/duckdb-acceptance-20261126/rust-gateway-channel-concurrency.log)
- 连接等保存确认再开放收件，恢复在激活前重新核对持久配置。重连只处理被派发的渠道，等待 Core 读取时若 Gateway 被暂停，迟到的结果不会重新启动它。飞书和企微夹具覆盖保存等待和写失败。 [生命周期](../../out/duckdb-acceptance-20261126/gateway-lifecycle-channel-cas.log) · [配置](../../out/duckdb-acceptance-20261126/gateway-provider-config-channel-cas.log)
- 退役了 Slack 门禁中直接打开 Durable runtime 且缺少 Core Storage 的一项旧夹具。Slack 同线程串行、独立线程、重复投递、加密配置和激活门禁仍运行。生产 Slack 与 Pi 的实际联调尚未验收。 [Slack](../../out/duckdb-acceptance-20261126/slack-gateway-channel-cas.log)
- Windows worker 协议 102，SHA256 为 `91a6d494bae898cfd7b36e9515580c0f5a2bc29b2cde0400b7b3ce58ceb35c5b`。Core 可观测性、Pi 官方 32 项及集成和 Node 26 类型检查通过。Gateway 的持久收发队列和私人记忆授权仍在构造时访问 SQLite，继续阻塞桌面首窗。协议 102 的生产 Pi 验收再次确认宿主在 Dots 委派装配退出，未进入 ready。 [可观测性](../../out/duckdb-acceptance-20261126/core-observability-gateway-channels.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-gateway-channels.log) · [生产 Pi](../../out/duckdb-acceptance-20261126/core-production-lifecycle-gateway-channels.log) · [型检](../../out/duckdb-acceptance-20261126/typecheck-gateway-channels-final.log)

## Gateway 执行、发送与回执对账

- Core 的待处理输入和待发送回复可以各自认领。注册器等待数据库确认后才继续模型或网络发送。保存回复、取消和发送结算匹配对应尝试号，迟到的结果无法更改新一轮的状态。已确认收到的消息和已进入模型执行分别验收。 [Gateway 队列](../../out/duckdb-acceptance-20261126/gateway-journal-claim-control.log) · [队列复验](../../out/duckdb-acceptance-20261126/gateway-journal-claim-recheck.log)
- 同一 Core 内重复启动 Gateway 会保留仍有效的发送认领。Core 重启后，只有具备 Pi 持久回执的输入能再次认领执行。中断在发送阶段的回复保留为待核查。对账任务带原账号和发送尝试号，旧尝试的结论无法重排或关闭新尝试。现有渠道适配器尚未实现提供商回执查询，专项直接验证 Core 对账命令。 [Core 专项](../../out/duckdb-acceptance-20261126/core-gateway-delivery-reconcile-final.log) · [Core 复验](../../out/duckdb-acceptance-20261126/core-gateway-delivery-reconcile-recheck.log)
- 退役的 `test:rust-background-services` 通过旧 SQLite 连接和已退役写命令拼装多域服务。Gateway 重投和对账用例归入现行 Core 专项。Cron 和通知的现行 Core 专项继续保留。 [旧门禁日志](../../out/duckdb-acceptance-20261126/rust-background-gateway-delivery-control.log) · [Cron](../../out/duckdb-acceptance-20261126/core-cron-gateway-reconcile.log) · [通知](../../out/duckdb-acceptance-20261126/core-notifications-gateway-reconcile.log)
- Windows worker 协议 103，SHA256 为 `5b8c3f96824ce0703a895d9fd19fbd1093279221c823174743603bd3673b74e6`。注册器 24 项、Pi Storage 官方 32 项及集成、Core 可观测性和 Node 26 类型检查通过。Gateway 构造、收件入队、会话路由和私人授权仍有 SQLite 依赖。生产 Pi 宿主复跑仍在 Dots 委派装配报错。外部渠道尚未联调。 [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-gateway-reconcile-final.log) · [Core 可观测性](../../out/duckdb-acceptance-20261126/core-observability-gateway-reconcile-final.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-gateway-reconcile.log) · [分类自检](../../out/duckdb-acceptance-20261126/classification-gateway-delivery.log) · [生产 Pi](../../out/duckdb-acceptance-20261126/core-production-lifecycle-gateway-delivery-reconcile.log)
- Rust 全套 87 项通过。一个投递的认领被暂时锁住时，另一个投递能先取得执行认领并提交。 [Rust](../../out/duckdb-acceptance-20261126/rust-gateway-delivery-reconcile-final.log)

## Gateway 收件与会话分配

- 常规持久入站在同一 Core 事务检查渠道权限、收件箱容量和重投内容，再持久化消息、原会话分配和已授予的私人记忆绑定。Core 模式的平台注册器等待提交后才确认收件。同一渠道会话的入队按接收顺序提交。旧版本的路由插入在 DuckDB 缺少 `seq`，现由 Core 在事务内分配。 [Core 专项](../../out/duckdb-acceptance-20261126/core-gateway-admission.log)
- 两个客户端竞争最后一个收件名额时只接受一个。`/new` 生效后旧消息重投仍归原会话。在 inbox 唯一约束导致插入失败时，事务也会撤回这一轮的会话修改。以真实 Core 读取驱动 `GatewayRouter`，验证只有已接纳且可使用的会话分配进入执行端口。模型在这项测试中使用夹具。 [事务与网关路由复验](../../out/duckdb-acceptance-20261126/core-gateway-admission-recheck.log)
- QQ 私人消息的允许名单、账号和回复对象与持久授权一致时才会绑定。共享消息使用独立会话，使用不同回复对象重投或撤销后重投会拒绝。注册器、生命周期、安全和 QQ / 微信扫码夹具通过。 [队列](../../out/duckdb-acceptance-20261126/gateway-journal-admission.log) · [安全](../../out/duckdb-acceptance-20261126/gateway-security-admission.log)
- 退役的 `test:gateway-conversation` 用 SQLite 装配直接打开 Durable runtime，在调用模型前因缺少 PiStorageClient 退出。会话分配、收件回滚、旧任务归档和账号切换由现行 Core 专项验证。九种适配器的真实会话与工具边界仍待生产验收。 [旧门禁日志](../../out/duckdb-acceptance-20261126/gateway-conversation-admission.log) · [Core 复验](../../out/duckdb-acceptance-20261126/core-gateway-admission-recheck.log)
- Windows worker 协议 104，SHA256 为 `27fa4ae417695fe27c6d4130c08f8a77d093552f60b49e37fffde54a820204c9`。Rust 87 项、Pi Storage 32 项和 Node 26 类型检查通过。队列恢复、Slack 独立入站、扫码授权和 Gateway 生产构造仍有旧库入口。真实 Pi 宿主仍在 Dots 委派装配退出，桌面首窗与外部渠道尚未验收。 [Rust](../../out/duckdb-acceptance-20261126/rust-gateway-admission.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-gateway-admission.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-gateway-admission-final.log) · [生产 Pi](../../out/duckdb-acceptance-20261126/core-production-lifecycle-gateway-admission.log)

## Gateway 队列恢复

- Core 在同一读事务返回可恢复消息、队列计数和下一个重试时间。新收件只等待本会话的恢复读取。恢复有条数和响应大小上限，仍有较早的待恢复消息时推迟新收件。自动调度保持渠道暂停，并保留结果不明的回复供对账。 [队列查询](../../native/runtime-audit/src/gateway_queue_data.rs) · [注册器](../../src/main/gateway/GatewayPlatformRegistry.ts)
- 不带 SQLite 的注册器通过真实 Core 验证了同会话旧消息先执行、其他会话可同时完成、暂停后的迟到读取和提交回执不会触发执行、已到期的回复会进入队列以及结果不明的回复不会自动重发。传输适配器在此专项使用本地夹具。 [Core 专项](../../out/duckdb-acceptance-20261126/core-gateway-queue.log)
- Windows worker 协议 105，SHA256 为 `cf16951ab5365127066a4a8afa4765b91fb51b6429397242f57859db5c7dfb3e`。Rust 87 项、Node 26 类型检查、Pi Storage 官方 32 项及集成、Gateway 队列 24 项、注册器、生命周期、安全、Slack 22 项和 QQ / 微信扫码夹具通过。真实 Pi 生命周期复跑在 Dots 委派装配退出。 [Rust](../../out/duckdb-acceptance-20261126/rust-gateway-queue.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-gateway-queue.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-gateway-queue.log) · [Pi 生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-gateway-queue.log)
- 普通收发队列可以直接使用 Core。协议 105 的隔离 Electron dev 创建了 `app.duckdb`，在装配 Gateway 私人记忆授权时访问 SQLite 连接并停在首窗前。 [协议 105 桌面实测](../../out/duckdb-acceptance-20261126/desktop-main-gateway-queue-isolated.log)

## Gateway 扫码授权与撤销

- 渠道配置、已验证账号、私人记忆授权和操作回执在同一事务提交。两个客户端以同一版本分别执行恢复和断开时，Core 只接受一个。断开后即使恢复相同配置，旧授权写入仍会被拒绝，重放旧回执也不会恢复授权。恢复连接仅保留同账号的有效授权。 [Core 专项](../../out/duckdb-acceptance-20261126/core-gateway-authorization.log)
- QQ 走真实 Core、扫码和网络用本地夹具。渠道在保存并复核后才接收消息。延迟已提交的扫码回执期间取消，渠道保持关闭，该次授权被撤销，原加密配置保留。微信、飞书和企微覆盖现有入口夹具。 [QQ 专项](../../out/duckdb-acceptance-20261126/gateway-qq-core-authorization.log) · [微信](../../out/duckdb-acceptance-20261126/gateway-weixin-authorization.log) · [飞书和企微](../../out/duckdb-acceptance-20261126/gateway-provider-config-authorization.log)
- Windows worker 协议 106，SHA256 为 `44bf4ecb5c2d38f88956d6801aea8aedb451abc16ccc2db5b27f032a6f54af17`。Rust 87 项、Pi Storage 官方 32 项及集成、Node 26 类型检查、Gateway 生命周期和安全专项通过。隔离 Electron dev 创建 `app.duckdb`，通过 Gateway 构造，在注册 Dots 委派时触发 SQLite 保护。实际 Pi 宿主仍在 Dots 委派初始化退出。 [Rust](../../out/duckdb-acceptance-20261126/rust-gateway-authorization.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-gateway-authorization.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-gateway-authorization-final.log) · [桌面实测](../../out/duckdb-acceptance-20261126/desktop-main-gateway-authorization.log) · [Pi 宿主实测](../../out/duckdb-acceptance-20261126/core-production-lifecycle-gateway-authorization.log)

## Dots 委派写入和恢复调度

- Core 保存委派时分配顺序号，提交目标、来源、请求和工作区快照。界面列表通过 Core 分页读取委派、等待条件、进展和回传状态，按来源与允许的空间筛选。 [委派读写](../../native/runtime-audit/src/dots_delegation_data.rs) · [列表入口](../../src/main/index.ts#L843)
- Core 调度恢复保留原请求和执行标识，在入队时校验任务身份、工作区、归档、回收及暂停状态。Pi 调用普通任务前查原收件回执并复核条件。条件没有满足时保留原执行标识等待后续恢复。桌面端旧的恢复入口继续供 SQLite 夹具使用。 [Core 执行队列](../../native/runtime-audit/src/business_protocol.rs) · [Pi 恢复入口](../../src/main/host/PiNodeHost.ts#L734)
- 退役 `test:dots-reply-recovery` 门禁。该夹具直接装配旧 SQLite 服务，在建立 Pi Storage 客户端之前打开 Durable runtime，首项行为断言无法运行。保留原场景代码以供后续迁移。Dots 初始化、原对话可靠回传以及首次合法绑定工作目录时的历史回传修复仍待接线和生产验收。 [旧门禁日志](../../out/duckdb-acceptance-20261126/dots-reply-recovery-delegations.log)
- Windows worker 协议 107，SHA256 为 `15307845d947d4fba9871f6522c5d20cabb17c53f1764f46c67335ef1b02e04c`。隔离桌面复跑创建 `app.duckdb`，在注册 Dots 委派时触发 SQLite 保护。隔离 Node 26 Pi 宿主也停在初始化 Dots 委派，尚未接受生产调度。 [桌面日志](../../out/duckdb-acceptance-20261126/desktop-main-dots-delegations.log) · [Pi 宿主日志](../../out/duckdb-acceptance-20261126/core-production-lifecycle-dots-delegations.log)
- 真实 Core 与隔离执行端验证了并发只登记一条委派、保留原正文和来源、并发恢复只创建一个执行、工作区变更拒绝入队、主动暂停不会被自动恢复、普通提交不能冒用恢复标记、已确认的执行不会重复登记。Core 执行协议、Pi Storage 官方 32 项及集成、Node 26 类型检查和门禁分类自检通过。 [Core 专项](../../out/duckdb-acceptance-20261126/core-dots-delegations.log) · [Core 执行协议](../../out/duckdb-acceptance-20261126/core-business-dots-delegations.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-dots-delegations.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-dots-delegations-final.log) · [门禁分类](../../out/duckdb-acceptance-20261126/classification-dots-delegations.log)

## Dots 原对话回传和交付回执

- Core 保留第一份已准备的回复和报告正文。Pi 向原对话追加回复时，Core 在同一事务核对原请求、任务归属、当前工作区和允许交付的状态，并提交消息、交付回执和队列状态。 [Core 回传](../../native/runtime-audit/src/dots_reply_data.rs) · [Pi 写入](../../native/runtime-audit/src/pi_storage.rs)
- 隔离测试使用真实 Core 与 Pi Harness。两个客户端并发准备时读到同一份正文。两个提交回执均丢失后，原对话只有一条回复，另一个对话没有写入。Core 重启后仍可读取原附件。正文准备好后变更任务工作区，提交时拒绝写入。 [Core 专项](../../out/duckdb-acceptance-20261126/core-dots-reply-outbox.log)
- Windows worker 协议 108，SHA256 为 `2fbb926448f8de16462aec79b02b73fdcc20eee3589155a06e3de67fb9d11c2e`。Core 执行协议、Pi Storage 官方 32 项及集成、Node `26.13.1` 类型检查通过。 [Core 执行协议](../../out/duckdb-acceptance-20261126/core-business-dots-reply-outbox.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-dots-reply-outbox.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-dots-reply-outbox-verified.log)
- Electron dev 与真实 Pi 宿主均用隔离数据目录，启动在取 Dots 委派的 SQLite 连接处退出。首次合法绑定工作目录的旧回执处理、依赖研判和真实模型回传仍待生产验收。 [桌面](../../out/duckdb-acceptance-20261126/desktop-main-dots-reply-outbox.log) · [Pi 宿主](../../out/duckdb-acceptance-20261126/core-production-lifecycle-dots-reply-outbox.log)

## 项目删除回执与资料清理

- Core 模式下，删除结果不明时重发同一操作编号和原参数，由 Core 返回保存的删除回执。项目资料文件清理也交给 Core。 [项目删除](../../src/main/project/ProjectDeletion.ts) · [资料清理](../../src/main/library/LibraryService.ts)
- 隔离 DuckDB 测试模拟提交后回执丢失。重试返回原计划移除清单，任务保留并解除项目绑定，项目资料目录删除，计划移除只发布一次。SQLite 夹具的原有事务检查与 Node 26 类型检查也通过。 [Core 专项](../../out/duckdb-acceptance-20261126/core-project-deletion-receipt-final.log) · [SQLite 夹具](../../out/duckdb-acceptance-20261126/project-deletion-fixture-receipt.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-project-deletion-receipt-final.log)

## Dots 委派并发对账

- 桌面和 Pi 装配的委派服务使用 Core。Core 事务复核委派、任务归属、工作区和读取时的版本，再一起保存状态和回传事件。派发入口等待原委派写入确认。 [委派服务](../../src/main/dots/DotsDelegations.ts) · [Core 工作区校验](../../native/runtime-audit/src/dots_delegation_data.rs) · [原子写入](../../native/runtime-audit/src/batch4a_writes.rs)
- 两个独立客户端故意交错读取活动委派，迟到的进展被拒绝，随后重新读取。两个客户端重放同一工具观察和进展，只保留首次记录。在读取执行结果期间更换工作区，迟到的结果未发布。Core 执行协议、Pi Storage 官方 32 项及集成、Node 26 类型检查和门禁分类自检通过。Windows worker 协议 109，SHA256 为 `07b8836208e7decccd39b4d309819b3712e7da5f6c2e5378f3314e36e8da0f4f`。 [Core 专项](../../out/duckdb-acceptance-20261126/core-dots-reconcile-core-final.log) · [Core 执行协议](../../out/duckdb-acceptance-20261126/core-business-dots-reconcile-core.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-dots-reconcile-core.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-dots-reconcile-core-final.log) · [门禁分类](../../out/duckdb-acceptance-20261126/classification-dots-reconcile-core.log)
- 退役 `test:dots-actions`、`test:dots-delivery` 和 `test:dots-followup`。三项旧 SQLite 夹具在首次打开 Durable 会话时缺少 Pi Storage 客户端。保留原场景代码。后续研判、进展样本、依赖接续和生产回传仍待接线及验收。 [操作夹具](../../out/duckdb-acceptance-20261126/dots-actions-reconcile-core.log) · [交付夹具](../../out/duckdb-acceptance-20261126/dots-delivery-reconcile-core.log) · [跟进夹具](../../out/duckdb-acceptance-20261126/dots-followup-reconcile-core.log)

## Dots 前台读取、待补要求、跟进与主动队列

- 前台额度由 Core 在同一事务内核对授权和扣减。两个客户端同时读到额度边界时共用同一个预算，重复调用不重复扣减，冻结策略、授权撤销和移交原对话的归属可在 Core 重启后核对。 [前台与移交专项](../../out/duckdb-acceptance-20261126/parallel-core-task-and-python-final.log)
- 待补要求与委派在同一事务认领。两方竞争只留一份委派，另一方的委派回滚。只有匹配原任务和原操作的实际 Pi 受理回执能标记已使用。后续计划和提交基线在独立验证中各只保留一份，保留的任务结果可用于回复原对话。 [待补要求专项](../../out/duckdb-acceptance-20261126/dots-deferred-parallel-core.log) · [跟进专项](../../out/duckdb-acceptance-20261126/dots-followup-core-parallel-probe.log)
- 活动中的可点击成果核对真实 Pi 交付回执。两个宿主同时给同一条主动消息入队时只留第一份正文。第一次提交成功但回执丢失后，另一宿主通过 Pi 确认已提交的消息，原对话仍只有一条。旧 `test:dots-proactive-notices` 的 SQLite 夹具在首次打开 Durable 前缺少 Pi Storage 客户端，已移出门禁并保留场景。RSS 恢复和归档重试尚需单独做 Core 验收。 [交付与通知专项](../../out/duckdb-acceptance-20261126/parallel-core-task-and-python-final.log) · [旧通知夹具](../../out/duckdb-acceptance-20261126/parallel-verify-dots-proactive-notices.log)
- 协议 110 的 SHA256 为 `daf842fe319b83b3462c4a48351244ca30996f79ecb55bbcf85e42bcc3f2e93a`。默认 EXE 当时被 Windows 占用，验收使用同一构建产物的隔离副本。Core 执行协议、Pi Storage 官方 32 项及集成、Node 26 类型检查和门禁分类自检通过。桌面与 Pi 仍有启动阻塞，完整聊天、真实模型和文件订阅未通过生产验收。 [执行协议](../../out/duckdb-acceptance-20261126/core-business-dots-parallel.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-dots-parallel-final.log) · [类型检查](../../out/duckdb-acceptance-20261126/typecheck-dots-parallel-verified.log) · [门禁分类](../../out/duckdb-acceptance-20261126/classification-dots-parallel.log)

## Core 文件订阅和 Durable 打开状态

- 文件订阅由 Pi 消费 Core 调度。用两个真实 Core 客户端、真实文件和 Pi Storage 验证创建与认领只成功一次、暂停与工作区迁移阻止认领、伪造受理回执被拒绝。Pi 受理记录已提交但回复丢失后，重启恢复只读回执。通知确认丢失后以原去重键重试，仍只保留一条。该专项未调用模型。 [文件订阅专项](../../out/duckdb-acceptance-20261126/file-watch-core-probe.log)
- 协议 111 的 SHA256 为 `9ebef58a9334da8615df69459d3c0317ff3ceb0434821da6d407881d23ff4a00`。原对话、活动和主动消息专项与 Pi Storage 官方 32 项、Core 执行协议均复验通过。 [综合 Core](../../out/duckdb-acceptance-20261126/core-dots-file-watch-111.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-dots-111.log) · [执行协议](../../out/duckdb-acceptance-20261126/core-business-dots-111.log) · [Node 26 类型检查](../../out/duckdb-acceptance-20261126/typecheck-dots-111-complete.log)
- 执行服务以 Core 读取持久会话绑定、上下文捕获水位和待确认的工作区迁移。隔离实例未登录模型，实际打开了 Pi 会话并回读历史，两个任务的运行指标各归本任务，重放时采用提供商实报用量。生产 Pi 复跑已越过执行服务构造，停在 Goal 续跑的启动恢复。桌面已创建窗口并载入页面，尚未取得 `bootstrapApplied` 和 `taskListInteractive` 两项信号。 [执行服务专项](../../out/duckdb-acceptance-20261126/durable-111-live-core-open-metrics-probe.log) · [Pi 宿主](../../out/duckdb-acceptance-20261126/core-production-lifecycle-dots-111.log) · [桌面](../../out/duckdb-acceptance-20261126/desktop-main-dots-file-watch-111.log)
- Dots 启动能从 Core 确认待提炼或可重试的记录。真实并发复现表明，现有记忆提炼标记仍可被两个客户端同时更新，造成一次输入累计两次尝试。提炼归属认领和派生视图待迁移。 [启动检查](../../out/duckdb-acceptance-20261126/memory-recovery-core-111.log) · [并发复现](../../out/duckdb-acceptance-20261126/memory-claim-race-core-111.log)
- `test:memory-lifecycle` 保留删除、撤回和提炼的行为用例。给旧 `AgentService.workService` 注入替代仓储的发送子用例已移除，普通聊天与后台提炼的并行关系仍需在真实入口验收。 [旧夹具失败](../../out/duckdb-acceptance-20261126/memory-extraction-lifecycle-111.log) · [保留用例](../../out/duckdb-acceptance-20261126/memory-extraction-lifecycle-111-final.log)

## Core 112 并发认领、Goal 恢复和桌面首屏

- 两个独立 Core 客户端同时认领同一批记忆，只产生一个所有者和一次尝试。同一身份重放可读回原结果。释放后的旧认领和删除证据后的完成请求均被拒绝。生产记忆提炼还需接通模型前授权和候选发布事务。 [Core 任务专项](../../out/duckdb-acceptance-20261126/core-task-and-python-112.log)
- 活跃 Pi 宿主在启动事务中记录中断 Goal 为 `deferred / restart`。隔离验收保留原尝试、令牌和停滞次数，只发出一次恢复事件，原任务未再次派发。真实宿主现已能进入 ready。生命周期专项继续发送第一条消息，在旧 Goal 入口失败。 [Goal 恢复](../../out/duckdb-acceptance-20261126/isolated-goal-restart-probe.log) · [真实生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-112.log)
- 工作目录由 Core 快照核对任务、继承链和 Durable 绑定。并发更改继承目录或回收删除后，旧目录绑定写入会被拒绝。仍在执行的 Pi 会话使用原目录，变更在空闲时接续。真实 Pi 的执行服务专项还验证了两个相同提交共用一个回执和一次测试模型调用。 [工作目录专项](../../out/duckdb-acceptance-20261126/core-task-and-python-112.log) · [执行服务专项](../../out/duckdb-acceptance-20261126/durable-submit-111-live-core-probe.log)
- 隔离桌面收到 `bootstrapApplied` 和 `taskListInteractive`，实际鼠标选中了 Core 中创建的任务。打开任务时，会话分支与外部代理历史查询仍调用 SQLite。 [桌面验收](../../out/duckdb-acceptance-20261126/renderer-bootstrap-diag-REwY3C/renderer-capture.json) · [主进程日志](../../out/duckdb-acceptance-20261126/renderer-bootstrap-diag-REwY3C/launch-1/dev.log)
- Windows worker 协议 112 的 SHA256 为 `b16bc28ba166c2362b58eee38dfe00cd6ab369ef74faa72e51345a5b6dbafc7e`。Core 执行协议和 Pi Storage 官方 32 项及集成均通过。 [执行协议](../../out/duckdb-acceptance-20261126/core-business-protocol-112.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-112.log)

## Core 113 历史、提交和 Gateway 授权

- 并行运行的 Core 任务综合测试、Core 执行协议和 Pi Storage 官方 32 项及集成通过。工作目录、项目与 Dots 并发测试继续使用独立临时库。Windows worker SHA256 为 `aacb07f96eb008c6c86beccedf10777b5e2757f9f2ff3c26ca372afdb7ceddcc`。 [Core 综合](../../out/duckdb-acceptance-20261126/core-task-and-python-113.log) · [执行协议](../../out/duckdb-acceptance-20261126/core-business-protocol-113.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-113.log)
- 桌面会话打开从 Core 取分支关系、ACP 和记载的 Pi 历史。65 条同时间戳的 ACP 记录分页后保留消息 ID、正文、附件和工具结果。分支专项验证回收项的可见性以及后台和执行宿主的权限隔离。隔离桌面用鼠标选中任务，真实聊天气泡显示了预写的 Pi 消息。历史、分支和成果接口均返回成功。 [桌面复验](../../out/duckdb-acceptance-20261126/renderer-bootstrap-diag-AMJLAM/renderer-capture.json) · [ACP 历史](../../out/duckdb-acceptance-20261126/parallel-acp-core-history-probe-113-final.log) · [分支隔离](../../out/duckdb-acceptance-20261126/conversation-branch-core-113-role.log)
- 只有首次写入真实 Pi 用户消息的事务能解除对应的可恢复 Goal 等待。重复请求和旧请求保留更新的暂停状态，预算、次数和真实用量继续保留。该专项使用实际 Pi Storage 和隔离数据库。 [Goal 并发与重放](../../out/duckdb-acceptance-20261126/isolated-goal-input-probe.log)
- Gateway 首条消息和 `/new` 在同一 Core 事务域竞争，过期路由无法创建任务，重复受理只创建一次。实际 Durable 服务连到夹具提供商收到一次回复。发送前撤销授权后没有出站模型请求。旧版同格式 DuckDB 的已有数据和库代次得以保留。 [已有库兼容](../../out/duckdb-acceptance-20261126/gateway-authority-113-preexisting.log) · [真实 Durable 验收](../../out/duckdb-acceptance-20261126/gateway-authority-113-real-durable.log)
- 通知专项验证跨客户端回放只提醒一次，迟到的待处理更新不会覆盖已回答状态。完整 Pi 生命周期已进入 ready，随后复验中的普通消息通过装配并取得真实提交记录。当前端到端失败在关闭 UI 后等待 Pi 实际写入测试文件。可观测性回归另记录永久删除后遗留的技能用量观测，删除清理正在复验。 [通知专项](../../out/duckdb-acceptance-20261126/core-notifications-task-callbacks-protocol113.log) · [普通提交与离线工具](../../out/duckdb-acceptance-20261126/core-production-lifecycle-113-assembly-scope.log) · [可观测性删除复现](../../out/duckdb-acceptance-20261126/core-observability-loadout-113-purge-before.log)

## Core 114 定时、删除及证据校验

- Windows worker SHA256 为 `273aa690af8d9af76e1be9cfbccfe494129e5f1e60322a283f9536544c8f3981`。Node 26 的 Core 综合、Core 执行协议、可观测性、通知和 Pi Storage 官方 32 项及集成通过。 [Core 综合](../../out/duckdb-acceptance-20261126/core-task-and-python-tool-persistence-114.log) · [执行协议](../../out/duckdb-acceptance-20261126/core-business-protocol-114.log) · [可观测性](../../out/duckdb-acceptance-20261126/goal-settle-114-core-observability.log) · [通知](../../out/duckdb-acceptance-20261126/goal-settle-114-core-notifications-final.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-114.log)
- 定时输入先排队再由另一客户端置为暂停。协议 113 的 Pi 事务仍然写入该输入。协议 114 在事务内拒绝该输入并允许同一存储中的普通消息继续写入。解除暂停后，合法输入只提交一次。 [修复前复现](../../out/duckdb-acceptance-20261126/core-cron-placement-before-114.log) · [双客户端复验](../../out/duckdb-acceptance-20261126/core-cron-authorization-114.log)
- Gateway 任务删除时同时退役原会话归属。旧收件回执与删除竞争时无法重建任务，后续合法输入获得新任务。工具执行回执保留第一次已确认的结果，待答交互只由对应任务及执行身份结算。技能装配观测和专家绑定随任务删除。 [Gateway 删除](../../out/duckdb-acceptance-20261126/gateway-delete-core114.log) · [真实 Durable Gateway](../../out/duckdb-acceptance-20261126/gateway-real-durable-core114.log) · [工具持久化](../../out/duckdb-acceptance-20261126/core-tool-persistence-114.log)
- 任务资料权限按单个 Core 快照判断。取消附件或解除工作区绑定后，旧证据会被拒绝。最新已批准的技能修订需要匹配当前来源和范围，忘记或改变来源内容立即取消资格。 [资料隔离](../../out/duckdb-acceptance-20261126/project-context-core114-scope-isolation.log) · [技能授权](../../out/duckdb-acceptance-20261126/memory-installed-skill-grounding-114.log)
- 普通聊天的生产生命周期 10 步通过。真实 Pi 将已授权的普通记忆发给本机夹具提供商，并排除了另一任务的记忆。关闭 UI 后，Pi 执行工具写入文件，Core 登记成果，重连取回状态。测试复核了宿主替换、并发控制、停止和升级，文件效果计数为 1。独立真实 Pi 探针验证第二轮历史恢复和发包前撤销权限。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-114-scoped-memory-artifact.log) · [模型权限复验](../../out/duckdb-acceptance-20261126/durable-provider-authority-core-memory.log)
- 退役 `test:conversation-branch-service`、`test:task-expert-binding`、`test:runtime-skill-loader`、`test:durable-tool-policy`、`test:durable-projection` 和 `test:conversation-goal-continuation` 的门禁入口。旧 SQLite 夹具在 Node 26 启动 Durable 时缺少 Pi Storage 客户端。分支、专家绑定、执行回执、部分 Goal 状态和证据撤销已有真实 Core 分组回归。场景源码继续保留，完整续跑与冷恢复验收仍列在原场景清单。 [综合 Core 回归](../../out/duckdb-acceptance-20261126/core-task-and-python-ordinary-recall-114.log) · [旧续跑夹具](../../out/duckdb-acceptance-20261126/goal-settle-114-goal-continuation-fixture.log) · [异步证据撤销](../../out/duckdb-acceptance-20261126/context-ledger-async-evidence.log) · [门禁分类](../../out/duckdb-acceptance-20261126/gate-classification-114-final.log)

## Core 115 提交验收

- Windows worker SHA256 为 `da9ccbd9cfde4e3a5e1ccb7e60175858b47284f1103e02240a5a16c9718eeead`。Node 26 的生产生命周期 10 步、Core 任务综合和 Pi Storage 官方 32 项及集成均通过。真实 Pi 使用本机模型夹具验证任务记忆隔离、离线工具实际写入、成果登记、重连和宿主替换。重复提交和宿主替换后的文件结果只出现一次。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-115-final.log) · [Core 综合](../../out/duckdb-acceptance-20261126/core-task-and-python-115-dots-worker-authority.log) · [Pi Storage](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-115-final.log)
- 两个独立 Core 客户端复核 Dots 最新委派、工作区、暂停、重新启用、被新委派替代和 Pi 宿主失效后的工具权限。普通记忆搜索、上下文注入和 `memory_get` 以 Core 当前版本与任务范围为准。自动提炼候选发布、Goal 自动续跑和少数扩展入口仍需单独迁移及验收。 [Dots 权限](../../out/duckdb-acceptance-20261126/core-task-and-python-115-dots-worker-authority.log) · [普通记忆读取](../../out/duckdb-acceptance-20261126/core-task-and-python-memory-get-114.log)

## Core 117 并发验收

- Windows worker 的 SHA256 为 `a590aabf884121591e4f835e2a2422be3e98b9301b1dcdd94e657390b9864b84`。Node 26 的生产生命周期通过 10 步。关闭 UI 后，记忆模型请求暂停时，另一条前台会话照常完成。释放模型响应后，原任务的记忆只发布一次。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-117.log)
- 普通任务的模型只收到 Core 批准的来源。Core 在事务内核对来源原文、当前范围、批次租约与候选目标。两个客户端争抢或重放同一批次时只提交一次。撤回、归档和伪造引用会阻止发布。同一毫秒后来产生的来源留在下一批，删除部分来源后仍能处理原批次的有效条目。 [发布](../../out/duckdb-acceptance-20261126/memory-publication-117.log) · [调度](../../out/duckdb-acceptance-20261126/memory-extraction-scheduler-core117.log)
- 租约到期时可重新认领。等待另一宿主的租约和等待模型超时均有界，前台重新生成可撤销旧提炼。用协议 115 创建的隔离数据在协议 117 上保留原任务和数据库代次。真实 Pi 的 Codex 提炼经 SSE 在发送时复核授权。 [数据兼容](../../out/duckdb-acceptance-20261126/memory-extraction-retained-117.log) · [模型权限](../../out/duckdb-acceptance-20261126/durable-provider-authority-117.log)
- Goal 的续跑认领、提交和用量记录改由 Core 确认。Pi 的模型、工具和工具恢复会核对当前运行与已提交的续跑认领。隔离 Pi 测试覆盖撤回权限后没有发包或写文件，恢复中断工具时旧权限仍被拒绝，前台消息仍可运行。 [续跑驱动](../../out/duckdb-acceptance-20261126/core-goal-continuation-driver-117-final.log) · [Pi 权限](../../out/duckdb-acceptance-20261126/core-goal-runtime-authority-117-verified.log)
- Core 任务综合、业务协议和 Pi 存储官方 32 项及集成通过。当前普通任务可自动提炼，Dots、Gateway、Bot 和 Work 来源仍需独立授权。忘记和替换候选继续进入审核。 [Core 综合](../../out/duckdb-acceptance-20261126/core-task-and-python-117-verified.log) · [业务协议](../../out/duckdb-acceptance-20261126/core-business-protocol-117.log) · [Pi 存储](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-117.log)
- Goal 宿主接管期间，已经排队的普通消息继续沿原 Pi 回执执行。隔离的真实 Core 和 Pi 宿主分别验证了终止前排队与接管后发送，两种情况下旧 Goal 都没有重发。Pi 夹具也验证了旧执行终止后、恢复队列前再次中断的情况。 [终止前排队](../../out/duckdb-acceptance-20261126/goal-foreground-queued-before-host-restart-117-followup.log) · [接管后发送](../../out/duckdb-acceptance-20261126/goal-foreground-after-host-ready-117-followup.log)

## Core 118 独立任务并发

- Windows worker SHA256 为 `41efe6fbe675dd53b8c3c7180bfc6987095e11d90b23aa23d06e1f03d92c0bc3`。真实 Core 与 Pi 执行桥验证了 8 个模型任务占满常规执行位时，其他任务仍能停止、查回执和回应认证。轻量操作有独立上限，同一会话、Work 和资源的冲突仍按顺序处理。 [业务协议](../../out/duckdb-acceptance-20261126/pi-control-saturation-118.log)
- 记忆捕获、BGE-M3 向量落库及两个资料空间的 DOCX 恢复，在第一项回执或发布被暂扣时都验证了另一项能先提交。Dots 跨任务进度和订阅、工作区保存、Gateway 渠道恢复、Cron 计划保存分别通过并发测试。 [记忆](../../out/duckdb-acceptance-20261126/memory-parallel-core118.log) · [资料库](../../out/duckdb-acceptance-20261126/library-docx-concurrency-core-118.log) · [Dots](../../out/duckdb-acceptance-20261126/dots-delegation-concurrency-core-117-final.log) · [工作区](../../out/duckdb-acceptance-20261126/core-workspace-queue-after.log) · [Gateway](../../out/duckdb-acceptance-20261126/gateway-concurrent-history-117-final.log) · [Cron](../../out/duckdb-acceptance-20261126/cron-concurrent-plans-117.log)
- Node 26 的生产生命周期 10 步、Core 任务综合、Pi 存储官方 32 项及集成、类型检查与门禁分类通过。旧 `test:rust-work-scheduler` 在监督模式启动后直接读取 SQLite，入口已退役并保留场景源文件。Work 候选改为有界扫描，超出首批的独立任务可在后续扫描获得空闲执行位。 [生产生命周期](../../out/duckdb-acceptance-20261126/core-production-lifecycle-118.log) · [Core 综合](../../out/duckdb-acceptance-20261126/core-task-and-python-118.log) · [Pi 存储](../../out/duckdb-acceptance-20261126/pi-duckdb-storage-conformance-118.log)

## Core 119 发行版数据库重建

> 历史记录：后续切换规则取消了按版本重建。首次启动仅清理已知旧 SQLite 及其 SQLite 伴随文件，不迁移数据。已有 DuckDB 和恢复文件不参与清理；后续升级必须保留原库、任务与数据库代次。

- Windows worker SHA256 为 `77fd676485ec3dd448f9b73e1f8d4959818c8ae79bbe7d1529b5b3dc53b1bb40`。发行版启动用应用版本核对数据库版本记录。同版本启动保留现有库和宿主。首次遇到尚未记录版本的旧安装，或版本变化时，先确认旧 Pi 和 Core 停止，再由 Rust 持有两把所有权锁，删除已确认的 MyBuddy 库和附属文件，创建空库后写入版本记录。 [发行版入口](../../out/duckdb-acceptance-20261126/core-database-release-119-final.log) · [真实宿主切换](../../out/duckdb-acceptance-20261126/packaged-pi-release-cutover-118-to-119.log)
- 隔离验证覆盖旧 SQLite、当前 DuckDB、Durable 和 Gateway 旧库、升级中途退出，以及 Windows 目录联接。已知升级可继续清理残留文件。源文件损坏、只读、归属异常或旧宿主未退出时，程序拒绝切换。旧项目文件、配置、成果、Gadget 数据和 Blueprint 工作区在多次重建及正常重启后均保留。 [文件与版本保护](../../out/duckdb-acceptance-20261126/database-release-reset-119-final-probe.log) · [成果](../../out/duckdb-acceptance-20261126/core-artifacts-119-asset-retention.log) · [工作台](../../out/duckdb-acceptance-20261126/core-workbench-119-asset-retention.log)
- 发行版已关闭旧会话、旧成果索引和用量归档的自动回填。Cron 不再重建缺少 Core 回执的旧输入，正常重启仍沿原回执续跑。Gateway 的旧明文凭据需要重新配置，当前凭据仍按原流程使用。旧 Gadget、项目知识和工作区集成的 CommonJS 门禁在 Node 26 加载 Pi 时失败，已退役其入口，保留场景源码。 [会话](../../out/duckdb-acceptance-20261126/pi-core-jsonl-discard-118.log) · [Cron](../../out/duckdb-acceptance-20261126/core-cron-119-recovery.log)

## Core 120 Dots 暂停和恢复

- Windows worker SHA256 为 `ad62083cec440984807e35b1981067eaea6c7369450fe1944a98c8663fad4781`。Dots 主动暂停、计划暂停和操作回执在一个 Core 事务内提交。恢复全局暂停时保留单空间和手动暂停。旧请求的重放只回读原回执，暂停时新建的计划在恢复后可重新排程。 [真实 Dots 入口](../../out/duckdb-acceptance-20261126/dots-proactive-control-120.log)
- 隔离 Core 120 复验了发行版重建、原生数据库保护、Goal 认领与 Work 任务越过第一批阻塞候选。Goal 原生测试改用真实 SHA-256 作为输入，完整原生套件 99 项通过。Node 26 类型检查和 Cron 的现有回执恢复也通过。 [数据库切换](../../out/duckdb-acceptance-20261126/core-database-release-120.log) · [原生套件](../../out/duckdb-acceptance-20261126/native-full-120.log) · [Cron](../../out/duckdb-acceptance-20261126/core-cron-120.log)

## Core 121 Goal 写入和证据

- Windows Core SHA256 为 `0c70f4a3b0f348542da4a35e62cfc2e2fac646b9f281cf55e41369f6f227c2a4`。两个已认证桌面客户端从同一版本同时编辑时，Core 只接受其中一个。旧版本和错误任务的写入被拒绝，重启后重放成功请求可取回原回执。创建和自定义预算一起提交。调整预算时保留本轮用量和尝试次数。 [双客户端写入](../../out/duckdb-acceptance-20261126/core-observability-goal-mutations-121.log) · [验收条件与用户证据](../../out/duckdb-acceptance-20261126/goal-mutation-attestation-121.log)
- 已登记的成果从保存快照读取。实际 Pi 回归验证，工作文件改动后快照内容仍可用，跨空间读取被拒绝，重复核验只保留首次时间。核验或预览期间移动任务或修改 Goal 时，旧请求不能继续使用先前的权限。写入意图保存后、实际工具开始前撤销权限时，Pi 保存未执行回执且没有生成文件。 [成果证据](../../out/duckdb-acceptance-20261126/core-task-and-python-goal-evidence-121.log) · [工具权限](../../out/duckdb-acceptance-20261126/goal-tool-121-final.log)
- 桌面编辑使用打开表单时看到的版本，迟到的回执和快照无法覆盖更新的状态。手动续跑也核对显示的续跑版本，旧点击不会启动下一次尝试。 [桌面回归](../../out/duckdb-acceptance-20261126/goal-ui-121-final.log) · [续跑回归](../../out/duckdb-acceptance-20261126/goal-driver-121-final.log)
