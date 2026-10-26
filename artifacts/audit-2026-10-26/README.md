# 现状审计（2026-10-26）：这个项目还有哪些问题

> 对象：`/home/vivion/github/wavealstra_harness`，main = `230e8b1`（与 `origin/main` 同步）。
> 方式：Lead 跑全量门禁 + 4 路并行只读审计（测试/门禁、Linux 与发布、架构、产品与运行时）。审计阶段未修改任何源码/配置/数据；后续 §5 实施的提交见 §0.1。
> 明细见同目录 4 份子报告：[gate-test-debt.md](gate-test-debt.md)、[platform-release.md](platform-release.md)、[architecture-debt.md](architecture-debt.md)、[product-runtime.md](product-runtime.md)。

---

## 0. 一句话结论

功能主体与默认门禁是**绿**的：`pnpm -s typecheck` 退出 0；`pnpm -s test:all` 审计时实测 **260 个用例：259 通过 / 1 已知失败 / 0 新增回归，5.8 分钟**（实施后为 254 个 headless 用例全绿，见 §0.1）。
剩下的问题不在"功能没写"，而在三处：

1. **这台 Linux 机器上的可用性 / 安全 / 发布缺口**（托盘不可见、凭据降级弱加密、打包链路只支持 Windows、退出时 SIGILL 崩溃）。
2. **测试与 CI 的"看不见"**：58 个用例永不执行、`typecheck` 棘轮可 fail-open、default 套件混入真 GUI 用例、`test:all` 会写脏工作树。
3. **长期维护债**：`AgentService.ts` 5,981 行、`registerIpc` 单函数 1,994 行、无 lint/分层门禁、2,740 行死代码、文档版本漂移。

没有发现新的、会导致核心功能不可用的缺陷；有 **9 项 P1**（见下表），建议在下次发布前解决。

**2026-10-27 执行结果：§5 第 1–9 项已实施并验证，第 10 项部分完成；default 门禁 254 个用例全绿（0 失败 / 0 已知失败）。** 明细见 §0.1。

---

## 0.1 §5 执行结果（2026-10-27）

| # | 动作 | 状态 | 提交 / 证据 |
|---|---|---|---|
| 1 | Linux 托盘/密钥库移植 | ✅ | `176f964`：`linux-password-store.ts`（gnome-libsecret + backend 日志）、PNG 托盘 22px、degraded 驻留、Linux 关窗通知、窗口 PNG；`test:linux-session`、`test:tray` 16/16 |
| 2 | Linux 打包链路 | ✅（未实跑 pack） | `176f964`：afterPack payload 门禁全平台、`verify:packaged` 支持 linux-unpacked、keyring-linux 进 files/asarUnpack、`build.linux`、`pack:linux`/`dist:linux`；夹具 PASS + 负例 FAIL。真机 `pack:linux` 与 onnx linux 仍待单独验证 |
| 3 | CI 可信度 | ✅（未在真实 runner 实跑） | `176f964`：pnpm 12.14.0 + `packageManager`、install 去掉 continue-on-error、新增 verify-linux（xvfb）；`8c8f4f0` 增加 verify-windows-gui（nightly + 手动） |
| 4 | 删库守卫 | ✅ | `176f964`：不兼容库改名 `.discarded-<UTC>` 备份后重建、rename 失败回滚抛错；`test:db-schema-discard` 7 项、`test:db-migration` |
| 5 | 门禁棘轮加固 | ✅ | `176f964`：typecheck 棘轮 fail-open 修复（+`test:typecheck-guard`）、test-all 失败尾部输出/进程组 kill/性能串行池/`--update-baseline` 保留 provenance；tsconfig paths 评估记录（209→816，不硬开） |
| 6 | 排除用例可见性 | ✅ / 🟡 | `8c8f4f0`：GUI/NETWORK/DATASET 分类、`--include-gui`/`--audit`/`test:all:gui`、nightly GUI job、`models-settings-overlay` 9/9、tray/consult-entry 隔离。GUI 全量本机 298 用例中仍有环境性失败（Windows-only/缺 d2/缺 MAGPIE_TEST_EXE/无头截图超时），已分类记录在 `gate-gui-classification.md`；CI GUI job 首跑结果未知 |
| 7 | 崩溃可观测性 | ✅（根因待符号） | `71524d9`：crashReporter 本地 dump、`~/.mybuddy/logs` 轮转、uncaught/unhandled 记录、render/child process gone 通知；`crash-sigill.md` 证明 4 次 SIGILL 是 Chromium `NOTREACHED` ud2、发生在 restart stop 阶段，需 electron debug symbols 才能到 file:line |
| 8 | test:project-agent 产品决策 | ✅（决定：保留） | `e112984`：执行审计快照保留被拒 Expert 决定（reason=project_policy_denied）；同时修复 evidence request-only 后丢失的 BTW 只读计划指引；`test-baseline.json` knownFailing 清空；test:project-agent 转绿 |
| 9 | 架构小步 | ✅（部分） | `b7f4a1b`：`test:architecture-graph`（分层/运行期环/越层/行数棘轮/preload 契约，基线棘轮）；`registerIpc` 拆分与死代码删除未做（见 §7） |
| 10 | 清理与文档对齐 | 🟡 | 本次提交：删 `_tmp_` 探针、`.gitignore`、typecheck 基线 209→208、AGENTS.md（Pi 1.3.0/Linux/门禁分层/日志与删库契约）、docs/STATUS.md 顶部权威更新块、审计报告留档。未做：2,740 行死代码删除、`artifacts/` 仓库瘦身（765 文件/53MB、6 个 APK）、`AgentService`/`registerIpc` 拆分——风险与收益需单独排期 |

**最终验证（2026-10-27）**：`pnpm -s typecheck` exit 0（scripts 208 基线 / 新增 0）；`pnpm -s test:all` → **254 通过 / 0 失败 / 0 已知失败 / 0 新增回归（0.9 min）**；`test:architecture` 323/0；`test:harness-quality`、`test:artifact-gate` 通过；`test:architecture-graph` PASS 5/5。
**未验证/剩余风险**：真实 GitHub runner（Windows/Linux/GUI nightly）首跑；Linux 实机 `pack:linux`/onnx 二进制；Windows dist 与快捷方式（需 Windows）；SIGILL 根因；GUI 套件中的环境性失败需要一台带 d2/MAGPIE_TEST_EXE/真实桌面的机器才能判定。

---

## 1. 方法与边界

| 项 | 内容 |
|---|---|
| 全量门禁（Lead 实跑） | `pnpm -s test:all`（JOBS=6）→ 259 通过 / 1 已知失败 / 0 新增回归 / 5.8 min；`pnpm -s typecheck` → exit 0 |
| 已知失败 | `test:project-agent`：`Execution audit must preserve the rejected requested Expert decision`（expected `project_policy_denied`，actual `undefined`），与 `scripts/test-baseline.json` 的 `$remaining` 一致 |
| 平台 | Linux / Omarchy（Arch）/ Hyprland / Wayland；Node 26.7.0；pnpm 12.14.0；Electron 44.5.1 |
| 运行时 | 有一个 `electron-vite dev` 实例在跑（PID 223757/224446，userData `~/.config/wavealstra_harness`），审计全程只旁路观察，未重启/未干扰 |
| 数据 | `~/.mybuddy/app.db` 只读（`mode=ro`）；崩溃证据来自 `coredumpctl`、`/proc`、`~/.config/wavealstra_harness` |
| 副作用 | `test:all` 会重写 10 个被 git 跟踪的 `artifacts/**/*.json`（见 P2-2）；审计结束后已用 `git checkout -- <这 10 个文件>` 还原，工作树仅剩未跟踪的本审计目录 |

---

## 2. 健康面（先说明哪些不是问题）

- 默认门禁是**真棘轮**：260 个用例里只有 1 个已知失败，且新增回归会让门禁失败；比 2026-10 初的 38 个红灯已收敛。
- `src/` 的 strict typecheck（web/node 两套 tsconfig）干净；`test:architecture`、`test:harness-quality`、`test:artifact-gate`、`test:ipc-channel-inventory` 均通过。
- 安全设计的基本面是好的：远程配对用 `timingSafeEqual` + 5 分钟 TTL + 失败 5 次销毁（`RemoteAccessPairing.ts`），设备 token 只存 sha256（`RemoteDeviceStore.ts`），默认拒绝非 HTTPS 地址。
- 未使用依赖实测 0/22、`@ts-ignore` 0 处、TODO/FIXME 可修项 0 条；历史审计里"Remote Origin 白名单 / 模型与权限接线 / SSE 重放 / spike 决策"等项已核实落地。
- 旧审计的错误结论（源码文本断言误报、删库是"缺陷"等）已在本报告中按当前代码重新校准。

---

## 3. 问题总表

| ID | 问题 | 严重度 | 验证状态 | 关键证据 |
|---|---|---|---|---|
| A1 | **Linux 托盘图标为空**：SNI 项存在但无 `IconName`/`IconPixmap`；关窗后窗口隐藏、无可见恢复入口，只能再启动一次命中单实例锁 | P1 | 已验证（运行时 D-Bus 观测） | `TrayService.ts:6,32-33` 只用 `tray.ico`；本次实测 `gdbus GetAll` 无图标属性 |
| A2 | **Hyprland 下 safeStorage 落到 `basic_text`**：Slack/MCP 凭据用 Chromium 硬编码口令弱加密，且 `isEncryptionAvailable()` 仍为 true → 不报错、无提示 | P1 | 文档+环境已验证，后端值强推断 | `SlackGatewayCredentials.ts:13,23`、`McpCredentialBackend.ts:14,18`；dev 主进程 cmdline 无 `--password-store`；分支 `fea36a8` 的 `linux-password-store.ts` 未合并 |
| A3 | **退出/重启时主进程 SIGILL**：今天 17:26–17:30 连续 4 次 `ILL_ILLOPN` core dump（25–28 MB，同签名），且应用无 `crashReporter`、崩溃只进系统 coredump | P1 | 崩溃已验证；根因推测（疑似退出路径/keyring 原生模块） | `coredumpctl info 223348`；全仓库 `crashReporter` 0 处；`index.ts:3432` 只 `console.error` |
| B1 | **Linux 打包链路不可用**：`afterPack` payload 门禁在非 win32 直接 return；`files/asarUnpack` 只列 `keyring-win32`、显式排除 onnx linux；无 `build.linux`；`dist` 硬编码 `--win` | P1（发布阻断） | 配置已验证；启动即崩为推测 | `scripts/after-pack-windows.cjs:7`；`package.json:452,480-495`；`dist` 见 `package.json:63`；本机无 wine |
| B2 | **CI 不可信**：workflow 只跑 `windows-latest`、pin `pnpm 9`，而仓库用 pnpm 10+/12 的 workspace 字段（`overrides`/`allowBuilds`/…）→ `frozen-lockfile` 预期失败，却被 `continue-on-error: true` 掩盖；本地 pnpm 12 / 分支 pin 11 / CI 9 三方漂移 | P1 | 配置结构已验证；CI 实跑状态无法离线确认 | `.github/workflows/verify.yml:20,27,34-36`；`pnpm-workspace.yaml:7,13,32` |
| C1 | **版本不匹配时静默删全库**：`resetIncompatibleDatabaseFile()` 对 db/-wal/-shm 直接 `rmSync`，构造函数无条件调用，**无 `app.isPackaged`/备份/用户提示** | P1（发布前必须处理） | 已验证 | `AppDatabase.ts:220-249,251-252`（注释里的 "development schema reset" 只是文案） |
| C2 | **58 个测试从不执行**：`EXCLUDE_PATTERNS` 排掉 58 个（e2e/desktop/live/remote/…）；CI 无 live job、无定时任务。实测被排除的 `test:models-settings-overlay` 8/9 通过、1 条红，但因为被排除**没人知道** | P1 | 已验证（实跑） | `scripts/test-all.mjs:35-58`；失败项是源码文本断言（见 §4.6） |
| C3 | **typecheck 棘轮可 fail-open**：脚本只解析 `file(line,col): error TSxxxx` 行；tsc 崩溃或配置级错误（`TS18003`）时解析到 0 条 → 打印"历史错误已不复现"并 **exit 0**；另 `tsconfig.scripts.json` `strict:false` 且缺 `paths`（31 条 `@/…` 变 any） | P1 | 已验证（读码 + 复现正则） | `scripts/typecheck-scripts.mjs:51,65-67,104-112`；`tsconfig.scripts.json:10` |
| C4 | **default 套件混入 11 个真 Electron 用例**（含 `test:consult-entry:desktop` 因 `:desktop` 漏过 `/-desktop$/`，以及 `memory-ui`/`tray`/`expert-ui`/`project-*-ui` 等），与"default 排除 GUI"的文档矛盾；JOBS=4 时可能同时开多个窗口 | P1 | 已验证（命令串 + 源码；本次在本机 GUI 会话下通过） | `scripts/test-all.mjs:45`；`test:consult-entry:desktop` 见 `package.json:315` |
| D1 | **语义索引/记忆 embedding 永久不可用**：`semantic_index_jobs` 停在 `pending`、`error=model_not_installed`；`SemanticModelManager.download()` 全仓库 0 调用、模型目录不存在、UI 无提示，记忆语义检索静默降级 | P2 | 已验证 | `~/.mybuddy/app.db` 只读查询；`MemoryService.ts:735-776` |
| D2 | **WorkGraph Phase 6 详情面板已实现但从未挂载**（`WorkGraphInspector.tsx` 194 行，仅自引用）；**OpenDesign 文档称"已实现"但代码已退役**（`RETIRED_MANAGED_PROVIDER_IDS` 含 `opendesign`） | P2 | 已验证 | `WorkGraphInspector.tsx`；`src/shared/professional-tools.ts:31`；`docs/opendesign-*` |
| D3 | **文档版本漂移**：`AGENTS.md` 写"只支持 Pi 1.0.4"（实际 1.3.0）；`docs/STATUS.md` 最后核对 2026-08-08（Pi ^0.83 / Electron ^37 / TS ^5.8，实际 1.3.0 / 44.5.1 / 7.0.2） | P2 | 已验证 | `AGENTS.md:6`；`docs/STATUS.md:4,31-33` |
| E1 | **变更放大点**：`AgentService.ts` 5,981 行 / 262 方法 / 140 import 跨 19 个领域（全史 +6,078/−97）；`registerIpc` 单函数 1,994 行 / 445 条 IPC；`appStore.ts` 6,562 行 | P2 | 已验证 | `wc -l`、AST 统计；`src/main/index.ts:644-2637` |
| E2 | **结构约束零机械保护**：无 ESLint/dependency-cruiser/knip；`app/remote → src/renderer` 已有 1 条越层；5 个 SCC 里 1 个真运行期环 | P2 | 已验证 | `/tmp/arch/analyze.mjs`（Babel AST + Tarjan）；`app/remote/src/components/RemoteMarkdown.tsx:8` |
| E3 | **374 个空 catch（21.2%）**，6 处高后果吞掉 DB 删除/pragma/回滚；无日志层、无 uncaught 兜底（297+66 处手写 `console`） | P2 | 已验证 | `ArtifactRepository.ts:146`、`AppDatabase.ts:1382/3425` 等 |
| E4 | **死代码 2,740 行**（10 个不可达模块 + 230 行死 monorepo 骨架）；生成物 `subagent/vendor/*.mjs` 写进 `src/` 且被 `.gitignore:29` 全局 `vendor/` 隐藏 | P2 | 已验证 | `RuntimeContextInspector.tsx` 等；`src/main/capabilities/subagent/vendor/` |
| F1 | **`test:all` 写脏工作树**：10 个 default 用例把带时间戳的结果写进被 git 跟踪的 `artifacts/**/*.json` | P2 | 已验证（本次实跑复现） | `pi-native-control-test.ts:131` 等 10 处 |
| F2 | **门禁失败无日志 / 超时残留进程**：`test-all.mjs` 用 `stdio:"ignore"`，CI 看不到失败原因；`spawnSync(shell:true, SIGKILL)` 只杀 shell，pnpm/esbuild/electron 孙进程残留；"超时未作为回归判定"的提示与代码行为相反（超时确实算 failed） | P2 | 已验证 | `scripts/test-all.mjs:108-160` |
| F3 | **测试隔离仍有漏口**：20 个 default 用例完全绕过 test-guard；guard 未重定向 `APPDATA/LOCALAPPDATA`（Windows 是 CI 主平台）；`test:tray` 无 `app.setPath('userData')`；`consult-entry` 复制真实 `~/.mybuddy` 凭据 | P2 | 已验证（配置/源码） | `scripts/test-guard.mjs`；`scripts/consult-entry-electron-test.cjs:17-20` |
| F4 | **唯一已知失败悬而未决 17 天**：`test:project-agent` 的"审计快照是否保留被项目策略拒绝的 Expert"是产品决策，baseline 里只记录、无结论 | P2 | 已验证 | `scripts/test-baseline.json:8-9` |
| G1 | **仓库卫生**：`artifacts/` 有 765 个跟踪文件 / 53 MB（含 6 个 APK、Windows 绝对路径）；130 个 scripts 未被任何 test:* 引用、46 个零引用；`_tmp_actual_wavealstra_execution_probe.ts` 引用了已删除模块；`app/remote` 有独立 typecheck 但未接入根门禁 | P3 | 已验证 | `git ls-files artifacts`、`git check-ignore` |

> 严重度口径：P1 = 影响本机可用性/安全或发布可信度，建议下次发布前解决；P2 = 可计划修复的质量债；P3 = 可延后。

---

## 4. 最值得先看的几项（展开）

### 4.1 Linux 托盘（A1，已验证）

本机运行中的 dev 实例（main 代码）在 D-Bus 上注册了
`org.freedesktop.StatusNotifierItem-224446-1`（ToolTip=MyBuddy），但属性表里**没有 `IconName`、也没有 `IconPixmap`**（对照组 FlClash 有 `IconName`）。`TrayService.ts` 只加载 `tray.ico`；在 Linux 上该图标的 nativeImage 为空，于是"托盘存在但看不见"。
由于 `closeToTray` 默认 `true`，关窗后窗口隐藏且**界面上没有任何恢复入口**（只能再次启动应用命中单实例锁，或从托盘菜单退出）。分支 `origin/cursor/omarchy-linux-adapt-413c` 的 `fea36a8` 已给出全部四块修复（PNG 托盘 + 22px 缩放、`--password-store`、Linux 关窗通知、窗口 PNG 图标），但**未合并**。

### 4.2 Linux 凭据加密（A2，强推断）

`XDG_CURRENT_DESKTOP=Hyprland` 不在 Electron 识别的桌面列表（GNOME/KDE/Cinnamon/Deepin/Pantheon/XFCE/UKUI/unity）里，且 dev 主进程 cmdline 无 `--password-store`。按 Electron 文档，此时 Chromium 走 `basic_text` 后端——用硬编码口令"加密"。
而 `SlackGatewayCredentials.ts:13,23` 与 `McpCredentialBackend.ts:14,18` 只检查 `safeStorage.isEncryptionAvailable()`：`basic_text` 下它返回 true，所以**不会报错**，凭据静默落盘为弱加密。分支的 `linux-password-store.ts` 会在 ready 前注入 `--password-store=gnome-libsecret`（本机 `gnome-keyring` 与 libsecret 均已安装）。

### 4.3 退出崩溃（A3）

`coredumpctl` 显示今天 17:26:36 / 17:28:10 / 17:29:22 / 17:30:15 连续 4 次 `SIGILL (ILL_ILLOPN)`，同一签名栈顶 `electron+0x937f521`，core 25–28 MB；命令行是主进程，时间点与 `mybuddy.sh restart` 重合。当前实例（17:30:49 起）已稳定 3 小时 44 分，因此更像**退出/重启路径**而非启动崩溃。
应用侧不可观测：全仓库无 `crashReporter.start()`，Crashpad 为空；`child-process-gone`/`render-process-gone` 只 `console.error`，dev 日志每次 start 被覆盖。**根因尚未确定**（疑似 keyring 原生模块或 teardown 期 V8/native 交互），需要符号化或最小复现（启动后立刻 SIGTERM）。

### 4.4 删库（C1）

任何 `user_version !== 27` 的 `app.db`（降级、回滚、迁移中断、手工导入旧备份）在打开前被**无条件删除**（含 `-wal`/`-shm`），只留一行 `console.warn`。`AppDatabase.ts` 全文没有 `NODE_ENV`/`isPackaged` 判断；`paths.ts` 显示 dev 也使用生产路径 `~/.mybuddy`。
在 0.1.x 预发布阶段这可以被视为开发期契约，但一旦分发就必须改成"备份/报错/引导恢复"，否则一次降级就会静默清空用户全部任务与历史。

### 4.5 门禁盲区（C2/C3/C4）

- `pnpm -s test:all` 的 default 套件选 260 个，321 个 `test:*` 里 **58 个被排除**（e2e 10、desktop 11、remote 8、`:live` 8、electron 5、computer 5、browser 4、单条 7），CI 没有 live job，等于"删除"。实测被排除的 `test:models-settings-overlay` 8/9 通过、1 条红（`explicit refresh bypasses cache…`），而失败原因是**源码文本断言**：实现改为 `reloadCurrent()` + `reloadIgnoringCache()` 后，测试仍在找 `loadURL(url)` 的精确文本（正确行为其实存在）。这说明盲区里既有产品回归也可能只是测试腐烂，但**没人看得见**。
- typecheck 棘轮的 209 条基线错误的分布：TS2307 31、TS2339 30、TS2741 30、TS2322 23、TS2345 23……涉及 98 个文件；**147 条落在 default 套件会跑的测试里**。其中 27 条 TS2307 是因为 `tsconfig.scripts.json` 缺 `paths`（`@/…` 变 `any`）——棘轮本来要防的"服务契约漂移"恰好看不见。另有 9 条 TS2304（未定义标识符）一旦执行到就是 `ReferenceError`（如 `artifact-machine-gate.ts:372,480,494` 的 `basename`）。
- 棘轮 fail-open 最危险：tsc 崩溃/配置错误时它 exit 0，CI 仍绿。

### 4.6 `test:models-settings-overlay` 的失败不是产品缺陷（更正子报告）

子报告初稿写"8/9 failed"，实测是 **8/9 passed + 1 failed**。失败项为源码文本断言（见 4.5），`BrowserHost` 的硬刷新行为正确（`reloadCurrent()` 调 `reloadIgnoringCache()`）。它暴露的是"被排除 = 无人维护"的机制问题，而不是浏览器刷新功能坏掉。

### 4.7 架构（E1/E2/E3/E4）

- `AgentService.ts` 5,981 行、262 个方法、140 个 import 跨 19 个领域目录，18 次提交合计 **+6,078/−97**（只加不减）；`appStore.ts` 17 次提交 +6,710/−148；`src/main/index.ts:644-2637` 的 `registerIpc` 是一个 1,994 行的单函数，内含 445 条 `ipcMain` 注册（全 `src/main` 459 条）。
- 没有任何机械约束：无 ESLint、无 dependency-cruiser/knip；`test:architecture` 只覆盖部分历史契约。AST 分析（734 文件/2,613 边/Tarjan）显示 5 个 SCC，但剔掉 `import type` 后只有 1 个真运行期环（`web-access` 的 `extract.ts` ↔ `gemini-url-context.ts` ↔ `video-extract.ts` ↔ `youtube-extract.ts`）；`app/remote → src/renderer` 已有 1 条越层。
- 1,766 个 catch 里 374 个真空块（21.2%，125 文件）；6 处高后果：`AppDatabase.ts:1382/1390/3425`（FTS/work_graph 边删除静默失败）、`ArtifactRepository.ts:146`（`pragma foreign_keys=ON` 失败 → CASCADE 静默失效）、`BlueprintService.ts:197/200`（回滚删除被吞）、`subagent/index.ts:547`（事件广播丢失）。
- 10 个不可达模块共 2,740 行（`RuntimeContextInspector.tsx` 790 行等）；`src/main/capabilities/subagent/vendor/*.mjs` 是构建生成物却被写进 `src/`，又因 `.gitignore:29` 的全局 `vendor/` 而未跟踪——`worker-launcher.mjs:8-9` 依赖它们，属于"仓库里看不见的必需文件"。

---

## 5. 建议修复顺序（按 ROI）

| 顺序 | 动作 | 覆盖问题 | 成本 |
|---|---|---|---|
| 1 | 从分支 `fea36a8` **挑文件**移植 Linux 能力：`linux-password-store.ts`、PNG 托盘 + 缩放、`tray-residency.ts`、Linux 关窗通知；补 `ready` 后打印 `getSelectedStorageBackend()` 并在非 gnome_libsecret 时告警 | A1、A2 | S–M（不要整体 merge 分支，会回退 magpie/Connector/typecheck 棘轮） |
| 2 | 修 `after-pack-windows.cjs` 的平台判断 + `build.files/asarUnpack` 补 `@napi-rs/keyring-linux-x64-gnu`，补 `build.linux`；`dist` 按平台分派；Linux 构建后跑一次 `verify:packaged --app-dir linux-unpacked` 扩展 | B1 | M |
| 3 | 修 CI：`packageManager: pnpm@12.x`（或与 lockfile 匹配的版本）、去掉 `continue-on-error`、加 Linux job（至少 typecheck + test:all）；把 `.github/workflows/verify.yml` 的 pnpm 版本与本地对齐 | B2 | S–M |
| 4 | `resetIncompatibleDatabaseFile` 改"备份后重建 / packaged 下报错"；启动时把 discard 事件落 `notifications` | C1 | S |
| 5 | 门禁自检：给 `typecheck-scripts.mjs` 加"解析到 0 条但 tsc 非 0 → exit 1"；`test:all` 改用管道捕获失败输出（分支 `70e1028` 已有实现，挑过来）；补 `tsconfig.scripts.json` 的 `paths` 并把 `strict` 逐目录打开 | C3、F2 | S–M |
| 6 | 给被排除的 58 个用例建**独立 live job/定时任务**（至少 nightly），先修 `models-settings-overlay` 的源码文本断言；把 11 个 GUI 用例从 default 移到 live | C2、C4、F3 | S–M |
| 7 | 崩溃可观测性：`crashReporter.start()` + `child-process-gone`/`render-process-gone` 转可见通知 + `~/.mybuddy/logs/` 轮转；用 `coredumpctl gdb` 符号化 4 份 SIGILL core | A3 | S（可观测性）+ M（根因） |
| 8 | 产品决策：`test:project-agent` 的审计快照语义（保留/不保留被拒 Expert），给结论后修实现或测试 | F4 | S |
| 9 | 架构小步：新增 `architecture-graph-test`（分层=0、值导入 SCC=0、文件行数上限）；按 `*Ipc` 拆 `registerIpc`（IPC 基线作安全网）；preload 键集合断言 + 把 `src/preload` 纳入 IPC 基线扫描 | E1、E2 | M |
| 10 | 清理：删 `_tmp_` 探针与 2,740 行死代码；`git rm --cached` 精简 `artifacts/`（保留必要的验收 JSON，APK 另存）；修 6 处高后果空 catch；`AGENTS.md`/`STATUS.md` 版本对齐 | E3、E4、G1、D3 | S–M |

**不建议**：整体 merge `origin/cursor/omarchy-linux-adapt-413c`（两dot diff 会回退 main 的 magpie、ConnectorService 大小写、typecheck 棘轮等，−1,245 行）；也不建议为此给 `ModelInvocationAdmission` 加防御（那会掩盖测试 fixture 的错误）。

---

## 6. 附录：复现命令

```bash
cd /home/vivion/github/wavealstra_harness
pnpm -s typecheck                     # exit 0，但 scripts/ 209 条基线错误
pnpm -s test:all                      # 259 pass / 1 known fail / 0 new，约 6 分钟
pnpm -s test:project-agent            # 复现唯一 known failure
pnpm -s test:models-settings-overlay  # 被排除，8/9 pass + 1 条源码文本断言红
npx tsc --noEmit -p tsconfig.scripts.json   # 看 209 条基线的原始分布
gdbus call --session --dest org.freedesktop.StatusNotifierItem-224446-1 \
  --object-path /StatusNotifierItem \
  --method org.freedesktop.DBus.Properties.GetAll org.kde.StatusNotifierItem  # 无图标属性
coredumpctl --no-pager list | grep -i electron   # 4 次 SIGILL
git diff --stat main..origin/cursor/omarchy-linux-adapt-413c   # 分支包含 Linux 托盘/密钥库，但基线落后于 main
sqlite3 'file:/home/vivion/.mybuddy/app.db?mode=ro' \
  "select job_id,status,error from semantic_index_jobs;"        # pending / model not_installed
```

---

## 7. 审计产物与声明

- 4 份子报告：`gate-test-debt.md`（423 行）、`platform-release.md`（311 行）、`architecture-debt.md`（444 行）、`product-runtime.md`（253 行）。
- 本审计**未修改**任何源码、配置、lockfile 或用户数据；DB 全程只读；未启动/重启 Electron；未调用真实模型。
- `test:all` 造成的 10 个 artifacts 跟踪文件改动已还原，当前 `git status` 只剩 `artifacts/audit-2026-10-26/`（本目录，未跟踪）。
- 标注为"强推断/推测"的结论（A2 后端值、B1 Linux 包启动崩溃、A3 根因、B2 CI 实跑、被排除用例的归因）均已在各子报告的"不确定"章节列出。
