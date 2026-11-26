# Step 1：基线测试报告、测试分类与未覆盖环境

- **仓库基线 SHA**：`046e33ef6a6a492a99e9ad3fa10499dbac85b3aa`（核心基线 `a46f86467a0491f0dd041e2cdecf0af58c694aec` + 执行规范 `046e33ef`）
- **工作区本地改动**：`M scripts/prepare-runtime-audit.cjs`（修复 Windows Low-IL 工作区复制/构建 `.exe` 继承 `Low Mandatory Level` 导致 SQLite 写入报 `attempt to write a readonly database` / `os error 5` 的问题）
- **运行环境**：
  - OS：`Microsoft Windows 11 专业版 10.0.26300` (x64)
  - Node：`v26.13.1`
  - pnpm：`12.14.0`
  - Rust：`rustc 1.97.1 (8bab26f4f 2026-07-14)` / `cargo 1.97.1`
  - Electron：`44.5.1`
  - Pi 版本（`src/main/capabilities/subagent/worker-launcher.mjs` `EXPECTED_PI_VERSION`）：`1.5.0`
  - GitHub CI 状态（`gh run list -L 5`）：最近运行为 `2026-10-29`（workflow 当前处于 `disabled_manually`，本地未继承任何云端绿灯）

---

## 1. 测试分类核对（`node scripts/test-all.mjs --audit` / `--list`）

- 分类统计：`headless 525` · `GUI 112` · `NETWORK 42` · `DATASET 10` · `ARTIFACT 3` · `pending 0`
- Windows default（headless）选中：**523 项**（并行 516 + 串行 7），本机 Windows 自动跳过 2 项 Linux 限定用例（`test:atspi-transport(linux)`、`test:input-guardian-process(linux)`）。
- 分类自检：`OK`（无 Electron 用例混入 headless）。

---

## 2. 本轮实测结果汇总

| 检查入口 | 结果 | 详情 |
| --- | --- | --- |
| `pnpm typecheck` | **PASS** | `tsconfig.web.json`、`tsconfig.node.json`、`scripts/typecheck-scripts.mjs`（错误 0、基线 0、新增 0） |
| `cargo test --locked --release`（via `RUNTIME_AUDIT_TESTS=1 node scripts/prepare-runtime-audit.cjs`） | **PASS（Rust 单测 27/27） / copyFile EBUSY** | 27/27 Rust 单元测试全部通过（1.77s），release 二进制编译完成；但复制到 `out/native/win-x64/mybuddy-runtime-audit.exe` 时因旧协议 87 进程（`electron.exe` PID `34516` 的子进程 `18588` 与孤立进程 `9364`）占用文件句柄报 `EBUSY` |
| `pnpm run test:runtime-audit-transport` | **PASS** | 11 组通过（5s） |
| `pnpm run test:runtime-audit-backpressure` | **PASS** | 队列过载/入队截止/未完成计数通过（1s） |
| `pnpm run test:gadget-storage-authorization` | **PASS** | 3 组通过（1s） |
| `pnpm run test:durable-history-readonly` | **PASS** | 2 组通过（12s） |
| `pnpm run test:bot-work-control` | **PASS** | 通过（1s） |
| `pnpm run test:work-memory-capture` | **PASS** | 通过（0s） |
| `pnpm run test:durable-sqlite-storage` | **PASS** | 通过（0s） |
| `pnpm run test:durable-storage-lease` | **PASS** | 通过 |
| `pnpm run test:durable-storage-current` | **PASS** | 通过 |
| `pnpm run test:core-performance` | **PASS（脚本 exit 0；1 项参考预算超限）** | `startup.db-schema/cold p95=123.93ms > 100ms`（仅 `MYBUDDY_PERF_GATE=1` 时失败）；其余 13 项延迟指标与 RSS（312.3MB <= 512MB）均达标 |
| `pnpm run test:core-performance-electron` | **PASS（脚本 exit 0；1 项参考预算超限）** | `electron.working-set-mb p95=952.48MB > 850MB`；其余 5 项均达标 |
| `pnpm run test:all`（default headless，523 项） | **FAIL（473 PASS / 50 FAIL）** | 耗时 11.5 min；`knownFailing: []`（0 已知基线），实测失败 49 项 + 超时 1 项（明细见 §3） |
| `pnpm run test:all:native`（15 项原生门禁） | **BLOCKED（待进入 Step 2 前解除文件锁）** | 新协议 88 release 二进制已编译并过 27/27 单测，但 `out/native/win-x64/mybuddy-runtime-audit.exe` 仍为被占用锁定的旧协议 87 产物，需结束占用进程后替换为协议 88 再完整执行 15/15 原生门禁 |

---

## 3. `pnpm run test:all` 基线失败明细（50 项：49 FAIL + 1 TIMEOUT）

> 注意：以下均为 `046e33ef` 基线在 Windows 11 + Node v26.13.1 下的实测现状（未修改业务源码掩盖）。

1. **Node v26 `stripTypeScriptTypes` `mode: 'transform'` 报错（21 项）**
   - 原因：`scripts/headless-source-test-hooks.mjs` 与 `scripts/test-typescript-memory-loader.mjs` 调用 `stripTypeScriptTypes(..., { mode: 'transform' })`，而 Node `v26.13.1` 报错 `TypeError [ERR_INVALID_ARG_VALUE]: The property 'options.mode' must be one of: 'strip'. Received 'transform'`。
   - 受影响用例（21）：`test:bot-clarification-history-schema`、`test:bot-delegated-task-projection`、`test:bot-message-html-service`、`test:bot-task-reply-presentation`、`test:deepseek-connection`、`test:deepseek-media-integration`、`test:deepseek-media-provider`、`test:deepseek-search`、`test:deepseek-tts-stream`、`test:dots-profile`、`test:gateway-binding-slack-identity`、`test:notification-activation`、`test:pi-tool-stream-durable-retry`、`test:pstack-advanced-artifacts`、`test:pstack-catalog`、`test:pstack-eval`、`test:pstack-interrogate`、`test:pstack-orchestration`、`test:pstack-statechart`、`test:pstack-watch`、`test:pstack-worker-contract`、`test:stream-retry-crash-probe`、`test:tool-stream-identity-trace`、`test:web-access-capability`。（实际共 24 项同源 loader 错误。）
2. **ESM loader `.tsx` / TypeScript 语法加载失败（7 项）**
   - 原因：`shared/src/icons.tsx` 在 CJS/TSGO UI 测试链路中被 Node ESM 直接加载，报 `ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".tsx"` 或 `SyntaxError: Unexpected token '{'`。
   - 受影响用例（7）：`test:app-permission-ui-removal`、`test:bot-clarification-options-ui`、`test:capability-result-dom`、`test:deepseek-model-settings-ui`、`test:gateway-presentation-ui`、`test:message-html-ui`、`test:saved-file-actions-ui`、`test:work-file-card-ui`。（共 8 项。）
3. **架构图 / 文件行数棘轮检查失败（2 项）**
   - `test:architecture-graph`、`test:architecture`：1) 运行期依赖环 `PstackAdvancedArtifacts.ts ↔ PstackStatechartTool.ts ↔ PstackVideoInspection.ts`；2) 文件行数超出基线棘轮 8 处（`remoteStore.ts` 1129→1355、`AgentService.ts` 5992→6461、`AppDatabase.ts` 3819→4521、`index.ts` 3521→3974、`LibraryService.ts` 2055→2703、`MemoryService.ts` 1174→1884、`runtime-audit.ts` 新文件 3011 > 2500、`ProjectRepository.ts` 1110→1311）。
4. **DOM 全局对象缺失 / SSR 快照（2 项）**
   - `test:bot-workspace-navigation-ui`（`ReferenceError: ResizeObserver is not defined`）
   - `test:sidebar-pinned`（`Missing getServerSnapshot`）
5. **行为或源码文本断言基线失败（13 项）**
   - `test:app-store-structure`、`test:dots-delivery`（`temporary receipt read failure`）、`test:dots-followup`、`test:durable-context-entrypoints`、`test:durable-workspace-binding`、`test:gateway-conversation`、`test:memory-correctness`、`test:professional-tools`、`test:project-task-defaults`、`test:prompt-enhance`、`test:runtime-orchestrator`、`test:visual-polish-ux`、`test:workspace-navigation-ux`。
6. **超时（1 项）**
   - `test:dots-reply-recovery`（300s 超时）。

---

## 4. 未覆盖环境清单（Not Run / Blocked）

| 类别 | 范围 | 当前状态 | 原因与解锁条件 |
| --- | --- | --- | --- |
| Windows 原生全量契约 | `pnpm run test:all:native`（15 项，协议 88） | **blocked** | `out/native/win-x64/mybuddy-runtime-audit.exe` 被运行中的旧协议 87 进程占用（`EBUSY`）；解除占用并复制协议 88 产物后即在 Step 2 执行 |
| Linux 原生与桌面验收 | `cargo test`、`test:all:native`、AT-SPI/Hyprland/ydotool、`test:computer-use-linux*` | **not-run** | 当前执行主机为 Windows 11；需真实 Linux x64 + Wayland/Hyprland/libsecret 会话 |
| Windows GUI 套件 | `pnpm run test:all:gui`（112 项） | **not-run** | 按规范留待相应功能域验收及 Step 10 完整候选包验收执行 |
| 产物与构建启动性能 | `pnpm run test:all:artifacts`（3 项）、`test:core-performance-mybuddy-startup`、发行包 `pack:win` / `verify:packaged` | **not-run** | 遵守 `AGENTS.md` 开发期不编译 `out/main` 与不提前打包约束；留待授权发布构建与 Step 10 执行 |
| 联网与数据集用例 | `NETWORK` 42 项、`DATASET` 余下用例 | **not-run** | 需真实模型凭据、外部渠道测试账号或大语料环境 |
| GitHub Actions CI | `.github/workflows/verify.yml` | **disabled** | 仓库当前 workflow 为 `disabled_manually`，无近期自动 CI 结果 |
