# Step 2 验收报告：三条基础契约（RC-01 ～ RC-05）

- **步骤 / 场景**：Step 2（`RC-01` ～ `RC-05`：写入与权限、请求生命周期、Core 所有权与 Windows/Linux 实测差异）
- **源码与产物**：
  - Git `main` SHA：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`
  - 工作区未提交改动：
    - `M scripts/prepare-runtime-audit.cjs`（构建/拷贝后将 `.exe` 与依赖设为 Windows Medium Integrity Level，修复 Low-IL 工作区触发 SQLite readonly / 启动握手超时）
    - `M src/main/platform/core-client.ts`（`prepareCoreBinary` 不可变二进制写入临时文件并 `link` 前执行 `ensureWindowsMediumIntegrity`）
    - `M scripts/core-client-test.ts`（补充 `RC-05` junction + 大小写路径别名并发 `connectCoreWorker` 与 guard 互斥验收）
    - `M scripts/core-supervisor-test.mjs`（补充 `RC-05` 路径别名并发 `--supervise` 竞争，并将慢消费者响应调整为 4×10 MB hex 以稳定触发 Windows 回环阻塞/队列上限）
  - 原生 Core 二进制：`out/native/win-x64/mybuddy-runtime-audit.exe`
    - 协议版本：`88`
    - Windows完整性标签：`Mandatory Label\Medium Mandatory Level:(NW)`
    - SHA-256：`49BA3475E4A76CA5B67E2CF882138C150FDA05C041B46A2EF8F0347867E0783F`
  - Pi 版本：`1.5.0`
- **环境**：Windows 11 Pro `10.0.26300` (x64)，Node `v26.13.1`，Rust `1.97.1`，Electron `44.5.1`，真实 `mybuddy-runtime-audit.exe` + 真实 SQLite + 真实子进程 / detached supervisor。
- **结果**：**Windows 本地门禁 `passed`**（Linux 实机复跑标记 `not-run`，需在真实 Linux 主机完成；不影响 Windows Step 2 结论同步）。

---

## RC-01 ～ RC-05 逐项核对与实测观察

| ID | 输入与故障注入 | 实测观察与代码边界 | 结果 |
| --- | --- | --- | --- |
| **RC-01** | `RuntimeAuditReader` 配置原生可执行文件路径后，注入 `snapshots` 排队占满、写操作超时、`overloaded`、probe 超时、`omitReceiptResult`、`exit`；核对 `AppDatabase.ts` 各写入口（`writeTaskRecord` / `writeTaskDoneAck` / `writeTaskSidebar` / `writeTaskDueDate` / `writeTaskContextUsageBatch` / `writeCronPlan` / `writeCronRun`） | 1) `mutatesPersistentState` 将所有未列于 `READ_ONLY_OPERATIONS` 的写命令标记 `mutation = true`；`isCapabilityRequest` 将能力探测标记 `capability = true`。<br>2) `RuntimeAuditReader.read` 在超时、排队过期、`overloaded`、通道关闭或探测异常时均拒绝为 `RuntimeAuditUnknownOperationError` / `RuntimeAuditNotStartedOperationError` / `RuntimeAuditOperationFailedError`，不会返回 `undefined` 落入 Node 写回退，且能力探测失败时调用 `clearCapabilities()`。<br>3) `test:runtime-audit-transport`、`test:runtime-audit-native-contract` 全项通过。 | `passed` (Win) |
| **RC-02** | `AppDatabase` + 外部 `better-sqlite3` `BEGIN IMMEDIATE` 锁争用；`WorkHostAuthority` 挂起 `acquire`、`heartbeat` 返回失败/延迟回复；维护事务 `deleteLibrary` 与普通写入共享 write gate 仲裁 | 1) `test:work-host-authority -- --native`（`3/3` PASS）：主线程非阻塞租约探测 `<250ms` 并恢复 `busy_timeout=5000`；异步权威模式下 pending/stop/unknown/TTL 失效均 fail-closed，不触及 host DB fallback；真实 Rust worker 在外部 `BEGIN IMMEDIATE` 争用下仅由 Rust 写入并在锁释放后恢复。<br>2) `test:runtime-audit-lifecycle`（`5/5` PASS）：持外部 `BEGIN IMMEDIATE` 时取消控制帧仍即时响应，且取消状态在获取共享写闸门后、`BEGIN` 前二次核对。 | `passed` (Win) |
| **RC-03** | 分别在 `queued`、`running`、提交后 `holdReply`（缺 `result`）以及中断重启后查询原 `requestId` 或同 `requestId` 重发 | 1) `test:runtime-audit-lifecycle` 与 `test:runtime-audit-transport` 证明：`queued` 取消/过期返回 `neverStarted: true` 且无 DB 效果；`running` 取消在未提交前可回滚/拒收；`committed` 后断流可通过 `queryOperation` 找回持久回执；中断后状态维持 `unknown`，同 `requestId` 重发返回 `DUPLICATE_REQUEST`（`neverStarted: false`），不自动重放。 | `passed` (Win) |
| **RC-04** | 阻塞 `database` 队列 300 条请求（`LANE_QUEUE_LIMIT = 256`）、160 条受控租约洪峰、`control` 过载（65 次撤销）、制造慢读 TCP 客户端（Windows 下发送 4×10 MB hex `historyRead` 响应超 48 MB 回环缓冲与 `64 MB` 队列上限） | 1) `test:runtime-audit-backpressure`（PASS）：等待+在途受 `256` 严格约束，超时 caller 按各自 enqueue deadline 返回且不释放 worker 真实在途槽位。<br>2) `test:runtime-audit-transport`（PASS）：控制通道满载时 fail-closed 退役连接而不丢弃撤销；caller 超时不中断并发 `inference`。<br>3) `test:core-supervisor`（PASS）：慢读消费方断连而不阻塞同进程后续客户端与 `historyRead` 恢复。 | `passed` (Win) |
| **RC-05** | 并发 `--supervise`（含 Windows `junction` 目录别名与 `APP.DB` 大小写别名）、并发 `connectCoreWorker` 别名启动、删除 `core.json` 后窃锁测试、半握手工、杀 worker、杀 supervisor 留活 worker、运行时替换可执行文件与版本切换、活 Core 下请求兼容/不兼容 schema 重建 | 1) `test:core-supervisor`（`9/9` PASS）：含路径别名在内的 3 路 `--supervise` 竞争仅产生 1 个 OS 锁持有者与唯一 `workerPid`；删 `core.json` 不被篡夺；杀 supervisor 留活 worker 时新 supervisor 拒绝接管（`previous core worker still running`）。<br>2) `test:core-client`（`9/9` PASS）：路径别名并发 `connectCoreWorker` 均连入同一 `pid`/`workerPid`/`generation` 且第二路 `acquireCoreDatabaseGuard` 被拒；运行中追加更新源 `.exe` 后连接安全切换代次与 `binaryHash`；活 Core 下不兼容 schema 重建被 guard 拒绝，库文件 `ino` 未被删除。 | `passed` (Win) |

---

## 本步命令执行清单

- `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs`：**PASS**（Rust 单测 `27/27` passed in `1.93s`；更新默认 `.exe` 至 protocol `88` 与 `Medium Mandatory Level`）
- `pnpm typecheck`：**PASS**（web/node/scripts 错误 `0`）
- `pnpm run test:all:native`：**PASS**（`15/15` 原生业务门禁全部命中真实 protocol `88` Rust worker：
  `test:runtime-audit-native-contract`、`test:runtime-audit-lifecycle`、`test:core-supervisor`、`test:core-client`、`test:work-host-authority`、`test:durable-task-projection`、`test:project-domain`、`test:task-board`、`test:gateway`、`test:activity-time`、`test:workspace-notes`、`test:task-workspace-lifecycle`、`test:gadget-backend-domain`、`test:library-domain`、`test:library-lifecycle-transaction`）
- `pnpm run test:work-host-authority -- --native`：**PASS**（`3/3`，含真实 Rust 写路径与锁争用）
- `pnpm run test:runtime-audit-transport`：**PASS**（`11/11`）
- `pnpm run test:runtime-audit-backpressure`：**PASS**（`1/1`）
- `pnpm run test:gadget-storage-authorization`、`test:durable-history-readonly`、`test:bot-work-control`、`test:work-memory-capture`、`test:db-schema-discard`：**PASS**（均在本阶段实测通过）

---

## Windows vs Linux 平台实测差异记录

1. **Windows Mandatory Integrity Level (IL) 继承问题**：工作区根路径继承 `Low Mandatory Level`，从其内部复制/编译出的 `.exe` 默认以 Low IL（`0x1000`）运行，导致 Windows 下写入 Medium-IL `~/.mybuddy/app.db` 或 `%LOCALAPPDATA%\Temp` 时报 `attempt to write a readonly database` / `os error 5` / detached supervisor 握手超时。已在 `prepare-runtime-audit.cjs` 与 `src/main/platform/core-client.ts` 的 `prepareCoreBinary` 统一使用 `icacls /setintegritylevel M /L /Q` 显式设回 Medium IL。
2. **Windows `.exe` 文件锁 vs SHA-256 不可变副本**：未重启的旧协议 87 进程直接运行在 `out/native/win-x64/mybuddy-runtime-audit.exe` 上会触发 `EBUSY`；而协议 88 的 `core-client.ts` 通过 `core-binaries/<sha256>/` + `link` 启动副本，允许开发或升级期间替换源 `.exe` 并在新客户端连入时停旧启新（`test:core-client` 已实测通过）。
3. **Windows loopback TCP 大窗口缓冲**：Windows 11 本机回环连接可先吸收约 ~32–48 MB 写入才触发 socket 背压；`core-supervisor-test.mjs` 原先单个 ~20 MB 响应在 Windows 下会瞬间写完而不触发 `750ms` `WRITE_DEADLINE`，调整为 4×10 MB hex（超过内核缓冲及 `64 MB` `MAX_QUEUE_BYTES` 队列上限）后在 Windows 稳定验证慢消费方断连。
4. **未覆盖范围**：Linux 实机 `flock` / `AF_UNIX` / POSIX symlink 路径别名与 GUI/打包环境在当前 Windows 机器上为 `not-run`。

---

## Step 2 出口门禁核对

- [x] `RC-01` ～ `RC-05` 在 Windows 本机以真实 Rust `protocol 88` + 真实 SQLite + 真实进程验证通过。
- [x] 未在原生超时/过载/探测失败路径保留静默 Node 写入回退；取消确认与取消终态、unknown 与 dup-reject 行为边界已核对。
- [x] Windows 路径、锁、二进制替换与 IL 差异已记录；未跑的 Linux 实机明确标注 `not-run`。
- **下一步**：允许进入 **Step 3**（先建业务协议、多角色连接身份、事件快照/增量订阅、过渡执行桥及独立后台生命周期，`RC-06`～`RC-08`）。
