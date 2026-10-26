# §5-6 实施报告：排除用例可见性 + GUI 集合 + 测试隔离（2026-10-26）

> 对应任务 `task-8`（审计 README §5-6）。范围：`scripts/test-all.mjs`、`.github/workflows/verify.yml`、
> `docs/omarchy-linux.md`、`scripts/models-settings-overlay-test.ts`、`scripts/tray-service-test.cjs`、
> `scripts/consult-entry-electron-test.cjs`。**未改** `package.json`、`src/`、packaging；未 commit/push。
> GUI 全量运行日志：同目录 `gui-run-2026-10-26.log`（298 用例、14.8 min）。

## 1. 变更摘要

| 文件 | 变更 |
|---|---|
| `scripts/models-settings-overlay-test.ts` | 修源码文本断言误报：新增 `methodBody()`（大括号配平、跳过字符串/注释），把「显式刷新绕过缓存」断言收敛到 `BrowserHost.reloadCurrent()` 方法体，并断言 `reload()`/`hardReload()` 都委托 `reloadCurrent()`。删掉整文件 `!includes("loadURL(url)")`（误伤 `navigateForAutomation()` 的 `wc.loadURL(url)`）。**9/9 PASS** |
| `scripts/test-all.mjs` | 原来的 `EXCLUDE_PATTERNS`（16 条名字正则）拆成 **GUI / NETWORK / DATASET + 显式 headless 白名单 + pending 临时桶**；新增 `--include-gui`、`--audit`、`--list` 分类输出；非 Windows 自动跳过 5 个 Windows-only GUI 用例；新增分类自检（Electron 启动命令 vs 清单，警告而非红灯）。`--include-live` 仍放行全部。更新头部注释与用法 |
| `.github/workflows/verify.yml` | 新增 `verify-windows-gui` job（`windows-latest`，`pnpm -s build` → `node scripts/test-all.mjs --include-gui`，**无 continue-on-error**，失败上传截图/结果 artifact）；`schedule: nightly 18:00 UTC`；`workflow_dispatch` 增加 `suite: default\|gui\|all`；default 两条 job 改为 push/PR/手动 default 才跑；更新陈旧注释 |
| `docs/omarchy-linux.md` | 新增「GUI 套件（本机全量）」跑法与 `--list/--audit` 说明；CI 一节改写为三条 job，并写明 GUI job 的取舍与「hosted runner 若因环境长期红 → 换自托管，不要塞回无头门禁」 |
| `scripts/tray-service-test.cjs` | ready 前把 `userData`/`sessionData` 改到**固定临时目录**（`os.tmpdir()/mybuddy-tray-test`，每次开头重建，避免跨轮状态），quit 前后尽力删除；不再把 Chromium/托盘 profile 写进真实 `~/.config`。**16/16 PASS（连跑两次）** |
| `scripts/consult-entry-electron-test.cjs` | 默认**完全不读真实 `~/.mybuddy`**：只写最小夹具（settings/mcp）；深层流程改为显式 opt-in `CONSULT_ENTRY_SEED_USER_PROFILE=1`；SKIP 时打印如何 opt-in。本机实测 SKIP、exit 0 |

### 分类结果（`node scripts/test-all.mjs --list` 实测）

| 类 | 数量 | 说明 |
|---|---|---|
| headless（default 套件） | **252** | 原 default 263；移出 13 个真 Electron 用例（8 个直接 `electron`、3 个 node driver 内部 spawn、2 个 perf 会 spawn Electron），移入 2 个误排除的静态用例（`test:models-settings-overlay`、`test:browser-open-guard`） |
| GUI | **46** | 8 个 Electron UI + 3 个 browser/electron + 3 个 electron/perf + 3 个 node-driver UI + 10 个 e2e + 11 个 `-desktop` + 5 个 Windows 桌面自动化 |
| NETWORK | **20** | 8 个 `remote-*`、8 个 `:live`、`streaming-live`、`multi-search-live`、`durable-bot`、`browser-automation-recovery` |
| DATASET | **2** | `blender-skill`（市场归档缺失）、`terminal`（node-pty 原生/pty） |
| pending（临时桶） | **1** | `test:workspace-files-ui`：headless 但既有 1/37 红（"项目资产可跳到侧边栏资料库"），只有 `--include-live` 会跑到；修好后移回 default |
| 合计（非聚合脚本） | 321 | 另有 3 个 `test:all*` 自排除 |

- `--list`：default **252**（并行 251 · 串行 1）；`--include-gui` 非 Windows 上 **293**（跳过 5 个 Windows-only），Windows 上 298；`--include-live` **321**。
- `--audit`：**「分类自检 OK：没有 Electron 用例混进 headless」**（分类自检会指出"命令里直接启动 electron 却归 headless"或 GUI 清单里已不存在的用例）。

> 与 Lead 名单的差异（已核实后调整）：
> - `test:project-workspace-ui` 命令是 `esbuild --platform=node + test-guard`，**不启动 Electron**，0.2s PASS → 保留在 default（不归 GUI 以免白丢覆盖）。
> - `test:core-performance-mybuddy-startup` **会 spawn 真实 Electron ≥9 次**（`require('electron')` + `spawnSync`）→ 归 GUI + 串行池。
> - `test:core-performance-all` 内部串联 `test:core-performance-electron`（原被排除的 Electron 用例）→ 归 GUI + 串行池。
> - `test:workspace-files-ui` 实际是 headless 且有 1 条既有红 → 放 pending 桶（见上），而不是塞进 GUI。
> - `test:models-settings-overlay`、`test:browser-open-guard` 是纯源码静态断言（修复后 9/9、6/6）→ 从排除集合**移回 default**，让它们真正被门禁保护。

## 2. `package.json` 待接线（Lead 统一提交，我不改 package.json）

在 `package.json` 的 `test:all` 三行附近（当前 `package.json:364-366`）加入：

```json
"test:all": "node scripts/test-all.mjs",
"test:all:gui": "node scripts/test-all.mjs --include-gui",
"test:all:live": "node scripts/test-all.mjs --include-live",
"test:all:audit": "node scripts/test-all.mjs --audit",
"test:all:update-baseline": "node scripts/test-all.mjs --update-baseline",
```

（`test:all:live` / `test:all:update-baseline` 已存在；只需新增 `test:all:gui`，可选 `test:all:audit`。CI 里用的是 `node scripts/test-all.mjs --include-gui`，不依赖该别名。）

## 3. 验证记录（本机，Linux/Omarchy）

| 命令 | 结果 |
|---|---|
| `pnpm -s typecheck` | **EXIT 0**；`scripts/ 错误 209 条 · 基线 209 条 · 新增 0 · 已修复 0`（我改的 `.ts` 测试未新增错误） |
| `pnpm -s test:models-settings-overlay` | **9/9 passed，EXIT 0**（修复前 8/9 FAIL） |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:tray` | **16/16 passed，EXIT 0**（隔离 profile 生效，`[Tray] 系统托盘已初始化 (png)`） |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:consult-entry:desktop` | **SKIP，EXIT 0**，输出提示「隔离 profile 未配置多模型会诊 / 本机深层验证可显式 opt-in」，全程不读真实 `~/.mybuddy` |
| `node scripts/test-all.mjs --audit` | 分类 OK；pending/GUI 清单自检通过 |
| `node scripts/test-all.mjs --filter=models-settings` | 1/1 PASS（聚合器在新分类下工作正常） |
| `pnpm -s build` | EXIT 0（GUI 用例需要 `out/main/index.js`；CI GUI job 已加该步骤） |
| `node scripts/test-all.mjs --include-gui`（全量，本机 GUI 会话） | 见下 |

### 3.1 GUI 全量运行结果（298 用例，14.8 min，EXIT=1）

`运行 298 个用例（default + GUI） · 通过 275 · 失败 23 · 已知失败 1 · 新增回归 22 · 超时 6`

失败分 6 类（**预期内的既有腐烂/环境限制，非本次改动引入**）：

1. **Windows-only（非 Windows 已自动跳过，共 5 个）**：`test:computer-automation`、`test:computer-automation-windows`、`test:computer-use-desktop`、`test:computer-use-overlay`、`test:computer-use-run` —— 断言原文 `computer_exec 当前仅支持 Windows` / `requires Windows`。Windows GUI job 仍会跑。（`test:computer-use-recovery` 在 Linux PASS，已从该集合移出。）
2. **外部可选依赖缺失（Windows CI 也会红）**：`test:artifact-open-e2e` —— `build-wave5-real-open.mjs` 里 esbuild 报 `Could not resolve "@terrastruct/d2"`（该包是 markstream-react 的 **optional peer**，本仓库未安装；其它同类用例都显式 `--external:@terrastruct/d2`，唯独这个 build 脚本没有）。建议：加 devDependency 或在该 build 脚本里 external。
3. **外部前置缺失**：`test:magpie-desktop` —— `MAGPIE_TEST_EXE must name the built Magpie executable`（需要先构建 Magpie 可执行文件）。
4. **Linux 显示/截图/窗口同步导致超时（hosted Windows 上表现未知）**：`test:browser-screenshot-electron`(90s 超时，前 3 项 PASS)、`sidebar-space-collapse-desktop`/`task-status-dot-desktop`(305s)、`wave5a/b/d2/d3-e2e`(300s 超时)、`wave5c/d1-e2e`(244s)。与 `cc32b2b`/`ui-capture.cjs` 记录的 Linux capturePage/无合成器问题同源。
5. **Electron 启动/桌面环境类**：`test:chat-attachment-acp-desktop`(30s，tests 空)、`test:expert-binding-desktop`(`Isolated Electron exited 0`)、`test:memory-lifecycle-desktop`/`test:local-capabilities-electron`(`CDP timeout: Runtime.enable`)、`test:durable-bot-desktop`(19.8s 断言失败)。
6. **e2e 真实断言漂移**：`test:wave4-e2e` —— `FAIL E1-6c 同页第二次抓取不淘汰首次可信引用`、`E1-6d 多抓取上下文包含两个元素且只含一份 document excerpt`（行为/断言过期，属既有腐烂）。
7. 另：`test:project-agent` 仍是 baseline 已知失败（本次设计不变）。

> 这说明「58 个被排除用例从没被验证」不是理论风险：这批 GUI 用例里确实有 1 个可选依赖缺失、1 个外部前置缺失、2 个真实断言漂移，以及若干 Linux 显示相关挂死。去掉 5 个 Windows-only 后本机 GUI 选择为 **293**；Windows GUI job 仍跑 298。

## 4. CI 变更（`.github/workflows/verify.yml`）

```yaml
on:
  push: { branches: [main] }
  pull_request:
  schedule: [{ cron: "0 18 * * *" }]        # 每晚 18:00 UTC（北京 02:00）
  workflow_dispatch:
    inputs:
      suite: { type: choice, options: [default, gui, all], default: default }
```

- `verify-windows` / `verify-linux`：`if: event != schedule && (suite 为空/ default / all)` —— headless default 套件（**不再含 GUI 用例**）。
- 新增 `verify-windows-gui`：`if: schedule || suite == gui || suite == all`；`windows-latest`，`timeout-minutes: 120`；
  install（短路径）→ typecheck → **`pnpm -s build`** → **`node scripts/test-all.mjs --include-gui`**（无 `continue-on-error`）→ `always()` 上传 `out/tests/**` 截图/results。
- 取舍说明：GUI job 首次在 hosted Windows runner 上的结果未实测。按本机 Linux 结果，**首次 nightly 预计红**（至少 `artifact-open-e2e`、`magpie-desktop` 与部分 wave e2e/desktop 超时）。我按 Lead 的方案保留 nightly + 手动入口而不是 continue-on-error；若后续确认是"托管 runner 不支持 Tray/桌面自动化"这类环境限制，正确做法是换自托管 runner（文档已写），不要把它塞回无头门禁。

## 5. 未完成 / 不确定

- **GUI 红条目未修**：除上面 3 个允许修改的测试文件外，失败用例所在的脚本（`build-wave5-real-open.mjs`、`magpie-desktop-test.cjs`、`wave4-e2e.ts`、各类 `*-desktop-test.cjs` 等）不在本任务允许写入范围，只记录并分类；需要后续 §5-6 follow-up 或各自负责人处理。
- **Windows GUI job 未实跑**：托管 runner 能否跑 Tray/UIA/隐藏窗口 CDP 未知；首次 nightly 结果需 Lead 观察后决定 nightly vs 手动/自托管。
- **并发写入干扰**：本轮期间另一名 agent 正在改 `src/main/index.ts` + 新增 `crash-reporting.ts`/`runtime-logging.ts`（§5-7）。我的 `pnpm -s build` 与 GUI 运行基于该**未提交状态**；部分 Electron 启动类失败（`expert-binding-desktop` 的 `Isolated Electron exited 0`、CDP timeout）不能排除与这组未提交改动有关，建议 Lead 在干净提交上复跑 `node scripts/test-all.mjs --include-gui --filter=...` 复核。
- **工作树**：GUI 运行产生的 tracked `artifacts/**`（computer-use 截图、pi-* results 等 43 个文件）已 `git restore` 还原；当前仅剩本任务改动 + §5-7 的 src 改动 + 本目录未跟踪文件。
- **/tmp 残留**：`test:tray` 的隔离 profile 目录（`os.tmpdir()/mybuddy-tray-test`）在 Electron native 退出后仍会留下（Chromium 关机时写 Cache）；已改为固定路径 + 每次运行开头重建，所以最多一个目录、不会累积，也不再碰真实 profile。`consult-entry` 的 SKIP 分支已显式回收（原来 `process.exit` 会跳过 finally 导致每轮残留一个 `/tmp/mybuddy-consult-entry-*`）。
- `test:all:gui` / `test:all:audit` 别名未写入 `package.json`（按边界由 Lead 接线，行见 §2）。
- 默认套件总数由 263 变为 252（分类结果），Lead 跑 default 时请以 `--list` 输出为准。
