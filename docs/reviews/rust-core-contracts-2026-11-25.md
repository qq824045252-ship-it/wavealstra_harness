# Rust 核心基础契约补全

本次以 `83ab1580c652037265bb3b44e1455699bf220463` 为基线，暂停扩展业务迁移范围。不升级应用版本或数据库 schema，不迁移 Pi；修复现有 Rust 路径的写入、请求生命周期和 Core 所有权契约。

## 1. 写入与调度权

- 普通应用数据库写入由独立 Rust writer 执行，维护任务的数据库事务使用同一写入仲裁。读入口和控制入口不等待写队列腾出空间，过载显式拒绝。
- Work 调度租约的 acquire、heartbeat、release 通过 Rust 异步写入。Electron Main 只使用已确认且未过期的本地租约状态；无确认、续租失败或停止均不授予新调度权。
- 退出顺序为停止调度、排空 owner 专属 release、断开客户端。迟到的 acquire 回复不能复活已停止的 owner。release 未确认时，本地保持停调度，数据库租约依赖 TTL 到期。
- Work 记忆 catch-up 在确认获得权限后触发，避免异步启动时被跳过；权限恢复会重新触发。
- 无原生配置的隔离 Host 路径保留，但租约写入使用临时 `busy_timeout=0`，不会同步等待 SQLite 默认的五秒锁超时。

## 2. 请求、取消与操作结果

线协议升级到 **88**。请求携带 `requestId`、`deadlineAt`，回复必须关联 `replyId`。排队时间计入截止时间；排队过期的任务不能稍后执行。

| 状态 / 错误 | 含义与调用方行为 |
| --- | --- |
| `RUNTIME_OPERATION_NOT_STARTED` | 未派发或 Core 明确拒收；已配置原生时仍不能静默改由 Host 写入 |
| `running` | 后台仍在运行，取消只表示已提出取消请求 |
| `RUNTIME_OPERATION_FAILED` | 已执行，但域代码可以证明未提交持久效果，例如明确成功回滚的事务 |
| `RUNTIME_OPERATION_UNKNOWN` | 已派发但结果无法确认；保留操作 ID 查询回执，不自动重放 |
| `committed` | 已确认执行结果；回执可以附带域返回值 |
| `cancelled` / `expired` | 在执行前或提交边界停止；已存在部分提交时必须保留为 `unknown` |

- caller 超时与 worker 终态分别记录；caller 超时不会释放仍在执行的槽位。
- cancel、status、Gadget revoke 走独立控制入口，业务队列和控制队列均有上限。取消后的排队项和仍在执行的项不能因回执淘汰而失去身份。
- 已配置原生时，能力探测暂态失败不缓存为“不支持”；只有明确否定才允许 `needsHost`。
- Gadget 的最终原子替换与撤销共用提交检查。临时文件写入、序列化和 fsync 不占用撤销检查锁。SQL 维护事务在取得写锁后和 COMMIT 前复核请求有效性。
- 持久操作回执保存在数据库旁的 `.runtime-operations` 目录，Unix 目录权限为 0700、文件为 0600。重启将尚未确认的执行记录恢复为 `unknown`，拒绝相同 ID 重放。回执数量和结果大小有上限；不确定的持久回执不能为了接收新请求被淘汰。
- 资料库删除不再把超时报告成“已经失败”。它先查询操作回执或数据库提交证据，无法确认时保留明确的“结果尚未确认”错误，文件清理仍跟随数据库提交。

回执是有界的恢复信息，不是完整的业务审计库。已淘汰记录查询为 `unknown`，不是“从未执行”的证据；大返回值可能不写入回执，缺少返回值不能触发 Host 重写。

## 3. Core 所有权与生产生命周期

- Electron 生产入口通过 Core socket adapter 连接监督进程；普通客户端关闭只断开本连接。
- supervisor 和 worker 分别持有操作系统文件锁。只有两把锁都可取得才能建立新代，不能因为 TCP 端口不通、endpoint 缺失或 supervisor 被杀就判定旧 worker 已退出。
- worker 在打开数据库前核对代次并取得自身锁；监督进程收到 worker ready 后才发布 endpoint。
- 握手有截止时间，并发握手、输入、输出及在途路由均有上限。慢读客户端会被断开，不会长时间占用全局路由互斥锁；断连回收其历史快照和 Gadget 授权。
- 创建或重建数据库必须通过 `AppDatabase.open` 取得相同的两把独占锁。活 Core 阻止不兼容 schema 的删除重建，防止旧 worker 持有旧 inode、Main 创建新数据库。
- Core 从按二进制 SHA-256 保存的不可变副本运行，避免 Windows 覆盖正在运行的可执行文件。endpoint 和握手绑定二进制指纹，更新时先确认旧代退出，再建立新代；在途未知结果不自动重放。

## 验证

复现与验收使用真实 Rust 进程、真实 SQLite 写锁和主动进程终止，不能用 Host 回退或并发定时器夹具替代。

验收入口：

```sh
pnpm -s typecheck
pnpm -s test:runtime-audit-transport
pnpm -s test:runtime-audit-backpressure
pnpm -s test:durable-history-readonly
pnpm -s test:bot-work-control
RUNTIME_AUDIT_TESTS=1 pnpm -s test:all:native
```

原生门禁包含 Core supervisor、生产 adapter、Work 租约、生命周期/回执，以及已有业务原生用例。GitHub workflow 增加 `native` 手动选项，并在 Linux、Windows 上运行原生门禁。

本地测试和线上 CI 状态分别报告；没有运行的 Windows、GUI、安装包或 CI 验收不能称作通过。

### 本轮实测结果

Linux x64，Node 24.22.3，Rust 1.100.0；原生业务门禁使用重新编译的 release worker（协议 88）。

| 检查 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | PASS，Web / Main / scripts，脚本基线 0、错误 0 |
| `cargo test --locked` | 27/27 PASS |
| `pnpm -s test:all:native` | 15/15 PASS |
| `test:runtime-audit-transport` | 11 组 PASS |
| `test:runtime-audit-backpressure` | PASS |
| `test:gadget-storage-authorization` | 3 组 PASS |
| `test:durable-history-readonly` | PASS |
| `test:bot-work-control`、`test:work-memory-capture` | PASS |
| `test:project-domain` Host 路径 | PASS；原生路径已包含在 15 项门禁 |
| workflow YAML、原生脚本入口、`git diff --check` | PASS |

没有修改失败基线。Project 触发器失败的原生断言改为严格检查 UNKNOWN、操作名和 UUID，同时保留原有回滚验证；Gadget 排队撤销修复保留 STALE_WRITE 断言，并增加“已派发、回复丢失不能假称撤销”的反向用例。

没有运行仓库完整默认 `test:all`、Windows 实机、Electron GUI 或发行包验收；本轮没有构建 Electron 应用或安装包。
