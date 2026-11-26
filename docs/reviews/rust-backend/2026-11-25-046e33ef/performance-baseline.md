# Step 1：性能基线与冻结数值预算

- **基线 SHA**：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`
- **构建类型**：Node 源码 bundle (`esbuild` / Electron dev runtime `44.5.1`) + Rust `release` profile (`out/native/runtime-audit-build/x86_64-pc-windows-msvc/release/mybuddy-runtime-audit.exe`, 协议 88)

---

## 1. 测试环境与条件记录

| 条件项 | 实际记录 |
| --- | --- |
| 机器 / OS | `Microsoft Windows 11 专业版 10.0.26300` (64-bit, `win32/x64`) |
| CPU / 内存 | `Intel(R) Core(TM) Ultra 9 285H` (16 核 16 逻辑处理器, 2900 MHz)、物理内存 ~31.4 GiB (`32961912 KB`) |
| 运行时版本 | Node `v26.13.1`、Rust `1.97.1`、Electron `44.5.1`、Pi `1.5.0` |
| 模型与网络 | 全部为本地隔离夹具 / fake UV / fake PTY / 无外部模型与网络请求 |
| 后台干扰 | 本机同时存在桌面会话（含已打开的用户 `electron.exe` PID `34516`）；性能用例串行单独运行 |
| 测量工具 | `node:perf_hooks` (`performance.now()`, `monitorEventLoopDelay({ resolution: 10 })`)、`process.memoryUsage()`、`app.getAppMetrics()`、`RuntimeAuditReader.laneDiagnostics()` |
| 采样说明 | 样本数 `n=5..80` 可稳定报告 `p50`/`p95`/`min`/`max`；因样本量 `< 100`，`p99` 按规范标为 `N/A（样本量不足）`，避免伪造分位数 |

---

## 2. 实测性能基线

### 2.1 `pnpm run test:core-performance`（Node 合成存储/检索/渲染路径）

| 指标 | 样本数 `n` | `p50` | `p95` | `p99` | `min` | `max` | 现有参考预算 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `startup.db-schema/cold` | 20 | 107.72 ms | **123.93 ms** | N/A | 97.86 ms | 199.68 ms | 100 ms（当前超 23.93 ms） |
| `startup.db-open/warm` | 30 | 14.11 ms | **19.14 ms** | N/A | 12.16 ms | 19.27 ms | 40 ms |
| `prompt.local-preflight/100-files` | 20 | 1.22 ms | **2.41 ms** | N/A | 1.01 ms | 2.46 ms | 10 ms |
| `runtime.python-orchestration/cold` | 8 | 3.92 ms | **5.64 ms** | N/A | 2.91 ms | 5.64 ms | 20 ms |
| `runtime.python-orchestration/hot` | 30 | 0.19 ms | **0.70 ms** | N/A | 0.15 ms | 0.74 ms | 3 ms |
| `library.search specific/800` | 25 | 1.04 ms | **1.95 ms** | N/A | 0.90 ms | 2.08 ms | 10 ms |
| `library.search miss/800` | 12 | 0.73 ms | **1.99 ms** | N/A | 0.68 ms | 1.99 ms | 10 ms |
| `library.search short/800` | 12 | 8.27 ms | **11.51 ms** | N/A | 6.50 ms | 11.51 ms | 75 ms |
| `workspace.snapshot/5000` | 20 | 35.17 ms | **40.87 ms** | N/A | 28.73 ms | 41.39 ms | 120 ms |
| `workspace.preview-text/16MB` | 7 | 18.76 ms | **38.64 ms** | N/A | 16.58 ms | 38.64 ms | 75 ms |
| `terminal.background-open/100` | 20 | 27.57 ms | **35.97 ms** | N/A | 22.56 ms | 37.88 ms | 120 ms |
| `session.history/1000-turns` | 12 | 9.56 ms | **10.77 ms** | N/A | 6.39 ms | 10.77 ms | 50 ms |
| `renderer.setActiveTask/300x120` | 80 | 0.12 ms | **0.24 ms** | N/A | 0.11 ms | 0.48 ms | 5 ms |
| `chat.height-estimate/5000` | 30 | 0.82 ms | **1.51 ms** | N/A | 0.54 ms | 1.83 ms | 5 ms |
| Node 内存峰值 (`observedMaxRss`) | — | — | — | — | 163.2 MB | **312.3 MB** | 512 MB |

### 2.2 `pnpm run test:core-performance-electron`（Electron 无头窗口/虚拟滚动基线）

| 指标 | 样本数 `n` | `p50` | `p95` | `p99` | `min` | `max` | 现有参考预算 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `electron.process-to-app-ready` | 5 | 67.16 ms | **68.54 ms** | N/A | 63.87 ms | 68.54 ms | 350 ms |
| `electron.process-to-first-window` | 5 | 195.39 ms | **206.29 ms** | N/A | 184.01 ms | 206.29 ms | 800 ms |
| `electron.first-window-load` | 5 | 111.27 ms | **118.07 ms** | N/A | 79.93 ms | 118.07 ms | 500 ms |
| `electron.virtual-scroll-frame-p95` | 5 | 0.50 ms | **0.60 ms** | N/A | 0.50 ms | 0.60 ms | 6 ms |
| `electron.surface-switch-p95` | 5 | 0.02 ms | **0.03 ms** | N/A | 0.02 ms | 0.03 ms | 3 ms |
| `electron.working-set-mb`（整组进程） | 5 | 946.85 MB | **952.48 MB** | N/A | 946.15 MB | 952.48 MB | 850 MB（当前超 102.48 MB） |

### 2.3 Rust Core Supervisor Socket 基线实测（协议 88 release 二进制）

> 测量条件：隔离临时目录 + `AppDatabase.open(..., { runtimeAuditSupervised: true })`，5 次预热后连续测量 50 次 `writeTaskRecord` 与 30 次 `queryOperation` 控制通道查询，再执行 `shutdownCoreWorker` + 冷重连恢复并写入 1 次。

| 实测项 | 样本数 `n` | `p50` | `p95` | `max` | 备注 |
| --- | --- | --- | --- | --- | --- |
| Core 写请求往返 (`writeTaskRecord`) | 50 | 3.13 ms | **4.60 ms** | 4.70 ms | 走 `core-client` TCP socket + Rust `database-writer` |
| 控制通道确认 (`queryOperation`) | 30 | 0.10 ms | **0.23 ms** | 0.57 ms | 走独立 `control` 通道，不进业务写队列 |
| Node 事件循环延迟 (`monitorEventLoopDelay`) | 全程 | — | **45.25 ms** | 107.15 ms | 含冷建库同步 `AppDatabase.open` 迁移毛刺 |
| Node 客户端常驻 RSS | 1 | — | — | **100.16 MB** (`105,029,632 B`) | 单进程（不含 Rust Core/Electron Chromium 子进程） |
| 通道队列深度 (`lane_queued`) | — | 0 | 0 | 0 | 无积压 |
| Core 停机重连恢复 (`shutdownCoreWorker` -> 可写) | 1 | — | — | **60.05 ms** | 含 OS 双锁释放、supervisor 拉起与重连 |

- **尚未基线化场景**：完整产物冷启动（`test:core-performance-mybuddy-startup`，需 `pnpm build`，按开发规则留待授权构建/Step 10）、高并发长 IO + 轻查询混跑（`perf:rust-core`，将在 Step 2/3～10 逐步补齐并受下表冻结预算约束）、20 次 UI 退出/重连循环与 8 小时常驻观测。

---

## 3. 冻结的迁移数值预算（步骤 2～10 不得在测后放宽）

> 按规范 §7.1 要求，所有新增场景必须在实现前冻结具体数值；以下预算适用于后续每一步的隔离回归和 Step 10 整体验收。

| 场景类别 | `request_p95_ms_max` | `control_ack_p95_ms_max` | `event_loop_delay_ms_max` | `rss_peak_bytes_max` | `queue_depth_max` | `recovery_deadline_ms` | 说明 / 不适用原因 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Core 轻请求与写操作（`database` / `history` 通道） | **25 ms** | **10 ms** | **50 ms**（稳态运行期；不含冷建库 DDL） | **268,435,456 B** (256 MiB, Node+Core) | **16**（非压测稳态） / **256**（过载拒绝硬上限 `LANE_QUEUE_LIMIT`） | **4,000 ms**（Core 崩溃/重启接管） | 以基线 `4.60 ms` / `0.23 ms` 留出跨进程与中等数据量裕度 |
| 长操作（资料库维护/大文件导入）叠加轻查询与取消 | **40 ms**（并发轻查询/读） | **15 ms**（cancel/status/续租） | **60 ms** | **536,870,912 B** (512 MiB, Node+Core) | **64**（control 队列硬上限 `CONTROL_QUEUE_LIMIT`） / **32**（`database-writer` 通道） | **5,000 ms**（取消终态或明确的 `unknown` 回执落地） | 禁止长 IO 阻塞轻查询与控制通道 |
| SQLite 写锁争用、队列过载与取消风暴 | **250 ms**（有界等待/明确拒绝） | **20 ms** | **80 ms** | **536,870,912 B** (512 MiB) | **256**（单 lane 入队硬上限，超限立即 `overloaded`） | **5,000 ms** | 不得用无限队列掩盖过载 |
| Core + 独立 Pi Node Host 无界面推进与故障恢复（Step 8+） | **40 ms**（Core 领域命令） | **20 ms**（pause/cancel/status） | **60 ms** | **671,088,640 B** (640 MiB, Core+Pi Host+Node 驱动) | **64**（执行桥待派发上限） | **8,000 ms**（杀 Pi Host 后重新取锁恢复 checkpoint） | 模型推理外部 API 首字延迟除外，仅约束宿主控制与持久化边界 |
| 静态 Gadget 共享 Host（0/1/10/20 个静态 Gadget） | **25 ms** | **10 ms** | **50 ms** | **402,653,184 B** (384 MiB, Core) | **64**（每实例在途/状态队列） | **2,000 ms**（实例 stop/revoke 生效） | 静态 Gadget 专属 Node HTTP 进程增量必须为 **0** |
| Electron UI 退出与 20 次重连循环（含界面快照恢复） | **150 ms**（重连首屏快照读取） | **20 ms** | **50 ms** | **998,244,352 B** (952 MiB, 含 Chromium 进程组基线，20 次循环后须回落稳态不单调增长) | N/A（UI 断开即回收订阅与视图句柄，不跨连接积压） | **3,000 ms**（重开界面拿到权威快照并接通增量游标） | 参考当前 Electron 多进程组 working set 基线 `952.48 MB`，迁移收薄 Main 后不得高于当前基线 |
| 持续常驻运行观测（>= 8 小时） | **30 ms**（稳态周期查询/Cron/Dots tick） | **15 ms** | **60 ms** | **671,088,640 B** (640 MiB, Core+Pi Host，RSS 稳态斜率 <= 5 MiB/h) | **32**（event/outbox 未消费积压在无活跃故障时须收敛至 0） | **10,000 ms**（模拟断连/故障注入后恢复） | 外部渠道网络抖动不计入本地 `request_p95` |
