# Step 1 执行报告与证据索引（基线、所有权与验收口径）

- **步骤 / 场景**：Step 1（基线固定、生产入口所有权盘点、行为分类、性能基线与冻结数值预算）
- **源码与产物**：
  - Git `main` SHA：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`（核心基线 `a46f86467a0491f0dd041e2cdecf0af58c694aec` + 执行规范 `046e33ef`）
  - 工作区改动：`M scripts/prepare-runtime-audit.cjs`（修复 Windows Low-IL 工作区生成 `.exe` 继承 Low 完整性标签导致 SQLite 只读拒绝的问题）
  - 协议版本：`88`（`out/native/runtime-audit-build/x86_64-pc-windows-msvc/release/mybuddy-runtime-audit.exe` 已编译并通过 27/27 Rust 单测；`out/native/win-x64/mybuddy-runtime-audit.exe` 暂被运行中的旧协议 87 进程占用待替换）
  - Pi 版本：`1.5.0`（`src/main/capabilities/subagent/worker-launcher.mjs` `EXPECTED_PI_VERSION`）
- **环境**：Windows 11 Pro `10.0.26300` (x64)，Intel Core Ultra 9 285H，32 GiB RAM，Node `v26.13.1`，pnpm `12.14.0`，Rust `1.97.1`，Electron `44.5.1`。

---

## 证据清单

1. [ownership-inventory.md](ownership-inventory.md) — 全部生产入口（桌面 IPC、Remote、Cron、Dots、Gateway、Work、Gadget、Pi 执行/工具/存储、启动恢复、退出清理、数据库重建、安装更新）当前与目标所有权、全部 `db.connection` / `new Database(` / 文件写 / listener / timer / spawn 盘点、以及「必须保留 / 已退役 / 明确不在范围」分类。
2. [baseline-tests.md](baseline-tests.md) — `test-all.mjs --audit` / `--list` 分类核对、`pnpm typecheck`、Rust 单测（27/27）、第 8.1 节基础契约用例（9 项全过）、`pnpm run test:all`（473 PASS / 50 FAIL 实测明细）及未覆盖环境清单。
3. [performance-baseline.md](performance-baseline.md) — `test:core-performance`、`test:core-performance-electron`、协议 88 Core Socket/Control/EventLoop/Recovery 实测基线样本及冻结的 Step 2～10 数值预算表。
4. [step2-contracts.md](step2-contracts.md) — Step 2（`RC-01`～`RC-05`）Windows 实测报告：`test:all:native` `15/15`、Rust 单测 `27/27`、`test:work-host-authority --native`、路径别名并发启动、慢消费方断开与 Medium-IL 修复证据（Linux 实机标 `not-run`）。
5. [step3-business-protocol.md](step3-business-protocol.md) — Step 3（`RC-06`～`RC-08`）Windows 实测报告：协议 `89`（SHA-256 `E0EEE6E1...B059A5`）、Rust 单测 `30/30`、`test:core-business-protocol` 与 `test:all:native` `16/16` 全过；含多角色连接隔离、事件快照/游标/缺口重同步、Core 执行槽与 Main Pi 过渡执行桥、`--watchdog` 崩溃恢复/熔断及显式停止围栏证据。
6. [step4-write-convergence.md](step4-write-convergence.md) — Step 4（`RC-09`～`RC-10`）Windows 实测报告：全部应用域写入收敛至 Rust Core、监督生产 `AppDatabase` 启用 `readonly: true`、`32/32` Rust 单测、`18/18` `test:all:native`、`test:rust-writer-boundary`、`test:rust-domain-equivalence` 及 523 项 `test:all` 棘轮（473 PASS / 50 基线 FAIL，0 新增回归）。
7. [step5-work-scheduler.md](step5-work-scheduler.md) — Step 5（`RC-11`～`RC-13`）Windows 实测报告：Work 状态机、DST/Cron 调度器、资源冲突与独立并发控制及恢复扫描迁入 Rust Core，Main 调度器收回；`34/34` Rust 单测、`19/19` `test:all:native` 与 `test:rust-work-scheduler` 全过。

8. [step6-background-services.md](step6-background-services.md) — Step 6（`RC-14`～`RC-16`）Windows 实测报告：按 Cron → Dots → Gateway → Remote 顺序将后台定时循环、渠道重连与出站对账、Remote 幂等命令与离线通知补偿迁入 Rust Core；`38/38` Rust 单测、`20/20` `test:all:native`、`test:rust-background-services` 及 Gateway/Cron/Dots/Remote 回归全过。
9. [step7-gadget-host.md](step7-gadget-host.md) — Step 7（`RC-17`～`RC-19`）Windows 实测报告：Rust 共享静态 HTTP Gadget Host（0/1/10/20 静态 Gadget `0` Node 进程）、Node/Python/Go/Rust 按需后端与闲置/在途/缺失环境阻断、UI 断连与实例 generation 权责拆分；`39/39` Rust 单测、`21/21` `test:all:native`、`test:rust-gadget-host` 及全部 Gadget 回归通过。
10. [step8-pi-node-host.md](step8-pi-node-host.md) — Step 8（`RC-20`～`RC-22`）Windows 实测报告：独立 `PiNodeHost` 进程脱离 Electron Main、`isolated-client` 模式、`durable_bot_*` 只读 `app.db` 投影修复、generation 围栏；`40/40` Rust 单测、`22/22` `test:all:native`、`test:pi-node-host` 及 Pi/Durable/Workflow 回归通过。
11. [step9-thin-main.md](step9-thin-main.md) — Step 9（`RC-23`～`RC-24`）Windows 实测报告：窗口级 UI 快照+增量游标重连（连续 20 次退出/重开无 owner 漂移与事件丢失/重复）、多表面 WebContents 回收/恢复、`waiting_platform` 代理与 readonly/supervised 零回退/零 Main 业务定时器门禁通过。
12. [step10-final-acceptance.md](step10-final-acceptance.md) — Step 10（`RC-25`～`RC-26` · §6 · §7）最终验收与交付核对报告：`40/40` Rust 单测、`24/24` `test:all:native`、`32/32` `test:artifact-gate`、`test:core-production-lifecycle`（§6 1～10）、`perf:rust-core`（全预算 PASS）、`test:core-performance-electron`（Working Set `952.48 MB → 668.36 MB` PASS）；打包/Linux/完整 GUI/8h 常驻按授权与环境边界明确列为 `not-run`。

---

## Step 1 ～ Step 10 出口门禁核对

- [x] **Step 1**：基线（`046e33ef`）、所有权清单、行为边界分类、性能数值预算冻结；结果：**`passed`**。
- [x] **Step 2**：`out/native/win-x64/mybuddy-runtime-audit.exe` 协议 `88`、`RC-01`～`RC-05` Windows 全门禁通过（见 [step2-contracts.md](step2-contracts.md)）；结果：**`passed`（Windows；Linux `not-run`）**。
- [x] **Step 3**：协议 `89`、`RC-06`～`RC-08` Windows 全门禁通过（`30/30` Rust 单测、`16/16` `test:all:native`、`test:core-business-protocol`，见 [step3-business-protocol.md](step3-business-protocol.md)）；结果：**`passed`（Windows；Linux 实机 `not-run`）**。
- [x] **Step 4**：收拢应用域写入与事务（`RC-09`～`RC-10`，见 [step4-write-convergence.md](step4-write-convergence.md)）；结果：**`passed`（Windows；Linux `not-run`）**。
- [x] **Step 5**：Work 状态机与调度恢复迁入 Rust Core（`RC-11`～`RC-13`，见 [step5-work-scheduler.md](step5-work-scheduler.md)）；结果：**`passed`（Windows；Linux `not-run`）**。
- [x] **Step 6**：按 Cron → Dots → Gateway → Remote 顺序迁移触发与渠道服务（`RC-14`～`RC-16`，见 [step6-background-services.md](step6-background-services.md)）；结果：**`passed`（Windows；Linux / GUI `not-run`）**。
- [x] **Step 7**：Rust 共享 HTTP 静态 Gadget Host、按需后端与权责拆分（`RC-17`～`RC-19`，见 [step7-gadget-host.md](step7-gadget-host.md)）；结果：**`passed`（Windows；Linux / GUI `not-run`）**。
- [x] **Step 8**：独立 `PiNodeHost` 与 Main `isolated-client` 解耦（`RC-20`～`RC-22`，见 [step8-pi-node-host.md](step8-pi-node-host.md)）；结果：**`passed`（Windows；Linux / GUI `not-run`）**。
- [x] **Step 9**：收薄 Electron Main、UI 快照+增量重连与页面回收（`RC-23`～`RC-24`，见 [step9-thin-main.md](step9-thin-main.md)）；结果：**`passed`（Windows 原生/源码集成；Linux 与实际发行包 `not-run`）**。
- [ ] **Step 10**：Windows 开发源码/原生全量/完整故事/性能与 Electron 探针通过（见 [step10-final-acceptance.md](step10-final-acceptance.md)）；**授权打包、`test:all:artifacts`、Linux 实机与 >= 8h 常驻观测待发布范围触发后补齐（`not-run`）**。
