# Step 10：整体验收与最终交付核对（RC-25 ～ RC-26 · §6 · §7）

- **状态**：`passed（Windows 11 x64 开发源码 + 原生 Rust release + §6 完整故事 + §7 性能基准）` / **`not-run`（未授权打包产物构建 / `test:all:artifacts` / Linux 实机 / 完整 GUI 112 项 / >= 8h 常驻实测）**
- **基线提交与工作区**：
  - Git `main` HEAD：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`（工作区含 Step 2～10 未提交源码与脚本改动）
  - 原生二进制指纹（`out/native/win-x64/mybuddy-runtime-audit.exe`）：SHA-256 `BA031F0A8853A44CE157516AF4655B341B1209C1883954F3BEC732D603AA1CF5`
  - Pi 版本（动态读取自 `EXPECTED_PI_VERSION`）：`1.5.0`
- **环境**：Windows 11 Pro `10.0.26300` (x64)，Node `v26.13.1`，pnpm `12.14.0`，Rust `1.97.1 (8bab26f4f 2026-07-14)`，Electron `44.5.1`（dev runtime）
- **GitHub CI 状态**：`.github/workflows/verify.yml` 最近一次记录为 `2026-10-29T18:03:42Z`（run `40927216546` failed），workflow 当前为 `disabled_manually`，未继承任何云端绿灯。

---

## 1. 核心门禁实测结果（Windows）

| 门禁入口 | 结果 | 实测观测 |
| --- | --- | --- |
| Rust 单元测试 (`RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs`) | **PASS** | **`40 passed; 0 failed`**（`2.13s`，release 编译与 Medium-IL/二进制指纹校验完成） |
| TypeScript 检查 (`pnpm typecheck`) | **PASS** | `tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs` **0 新增错误**（基线 `0`，当前 `0`） |
| 门禁分类自检 (`node scripts/test-all.mjs --audit`) | **PASS** | `headless 525 · GUI 112 · NETWORK 42 · DATASET 19 · ARTIFACT 3 · pending 0`（`OK`） |
| 全量原生门禁 (`pnpm run test:all:native`) | **PASS** | **`24/24` 原生业务用例全部命中真实 worker**（含 `test:thin-main` 5s 与 `test:core-production-lifecycle` 22s） |
| §6 完整生命周期故事 (`pnpm run test:core-production-lifecycle`) | **PASS** | Steps 1～10 全通过：`coreSha256=ba031f0a8853`、UI 离线 Pi Work 完成、`effectCount=1`、前景控制 `ctrlMs=10.50ms`、Pi Host/Core 故障注入恢复、`unknown` 保真、`tray_stop` 停止围栏及二进制升级热交接后同 `dataDir` 延续 |
| Artifact 机检门禁 (`pnpm run test:artifact-gate`) | **PASS** | **`32/32 PASS`**（`R4` 修复后零回归，3s） |
| 本地工作流 (`pnpm run test:local-workflow`) | **PASS（单跑）** | `elapsed=260s`（全量 4 并发下曾触及 300s 超时，单独隔离执行正常通过） |
| Electron 运行探针 (`pnpm run test:runtime-probe-electron`) | **PASS** | `runtime probe electron smoke: ok` |
| Electron 桌面性能 (`pnpm run test:core-performance-electron`) | **PASS (6/6)** | `electron.working-set-mb` 从 Step 1 基线 **`952.48 MB`（超标）降为 `668.36 MB <= 850 MB`**；其余 5 项全过 |
| 默认全量 headless (`pnpm run test:all`，523 项 / 12.4 min) | **FAIL（基线 50 + 前序 2 项差异）** | 本轮全量运行（改 `test:artifact-gate` 修复前）实测 **`471 PASS / 52 FAIL`**（含 Step 1 既有 50 条基线失败、`test:artifact-gate` 1 条、及 4 并发下超时 1 条 `test:local-workflow`）；随后修复 `R4` 并单独复验 `test:artifact-gate`（`32/32 PASS`）与 `test:local-workflow`（`PASS`）以及 `test:all:native`（`24/24 PASS`），未再重跑完整 12.4 min `test:all` 全套。 |

---

## 2. §7 性能与资源验收（基线 vs 候选版实测对照，`perf:rust-core`）

> 测量条件：`win32/x64`，Node `v26.13.1`，独立串行运行（`pnpm run perf:rust-core`，`elapsed=2s`），无并发压测争抢；因采样数 `n=20..40 < 100`，`p99` 按 §7.1 规范标为 `N/A(n<100)`。

| 场景 / 指标 | 样本 `n` | `p50` | `p95` | `max` | 事件循环延迟 `max` | 峰值 RSS | Step 1 冻结预算 | 结论 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 冷启动 Core (`coldBootMs`) | 1 | — | — | `117.37 ms` | — | — | `<= 4,000 ms` | **PASS** |
| Core 停机重启恢复 (`recoveryMs`) | 1 | — | — | `3.61 ms` | — | — | `<= 4,000 ms` | **PASS** |
| `core.writeTaskRecord(warm)` | 40 | `3.62 ms` | **`5.02 ms`** | `9.07 ms` | `12.41 ms` | `80.08 MiB` (`83,972,096 B`) | `p95 <= 25 ms`, `RSS <= 256 MiB` | **PASS** |
| `core.controlAck(executionStatus)` | 30 | `0.22 ms` | **`0.57 ms`** | `7.70 ms` | `0.00 ms` | `80.70 MiB` (`84,623,360 B`) | `p95 <= 10 ms`, `RSS <= 256 MiB` | **PASS** |
| `core.heavyWriteMixedWithLightSnapshot` | 30 | `2.12 ms` | **`2.65 ms`** | `3.05 ms` | `11.21 ms` | `82.42 MiB` (`86,421,504 B`) | `p95 <= 40 ms`, `RSS <= 512 MiB` | **PASS** |
| `core.staticGadgetScaling(20apps)` | 20 | `0.15 ms` | **`0.38 ms`** | `0.68 ms` | `0.00 ms` | `82.80 MiB` (`86,827,008 B`) | `p95 <= 25 ms`, `0` Node HTTP 进程增量 | **PASS** |
| `core.ui20ReopenAndReclaimCycles` | 20 | `10.58 ms` | **`20.65 ms`** | `24.35 ms` | `11.91 ms` | `83.41 MiB` (`87,457,792 B`) | `p95 <= 150 ms`, `RSS <= 952 MiB` | **PASS** |
| Electron 工作集 (`test:core-performance-electron`) | 5 | `665.08 MB` | **`668.36 MB`** | `668.36 MB` | — | — | Step 1 基线 `952.48 MB` / 预算 `<= 850 MB` | **PASS (-29.8%)** |

---

## 3. 明确未执行 / 受环境或构建约束限制清单（Not-Run）

> 按 `AGENTS.md` 与执行规范 §8.3 / §9.1 如实登记，严禁将未跑项标记为通过：

1. **产品构建与双平台发行包验收（`not-run`）**：
   - 受 `AGENTS.md` 开发期默认规则约束（“改完只跑 `pnpm dev`，不要编译任何产物/不要 `pnpm build`/`pack:*`/`dist*`/`electron-builder`”，仅在用户明确要求发布时构建），本轮未执行 `pnpm build`、`pack:win`、`pack:linux`、`verify:packaged`、`pnpm run test:all:artifacts`（3 项）与 `test:core-performance-mybuddy-startup`。
2. **Linux 实机原生与桌面会话门禁（`not-run`）**：
   - 本机为 Windows 11 x64，未运行 Linux `cargo test`、Linux `test:all:native`、`test:atspi-transport`、`test:input-guardian-process`、`test:computer-use-linux` 与 `test:computer-use-linux:packaged`。
3. **完整桌面 GUI 套件（部分通过 / 余项 `not-run`）**：
   - 已通过 `test:runtime-probe-electron` 与 `test:core-performance-electron`；完整 112 项 `pnpm run test:all:gui`、`test:extension-toolbar-dev`（`desktop-dev-harness` 冷启动 Vite 超时中止）与真实联网/渠道账号压测（`NETWORK` 42 项）尚未全量运行。
4. **>= 8 小时连续常驻观测（`not-run`）**：
   - 长期稳定斜率与 8 小时以上实跑窗口留待发布候选环境挂机观测。
