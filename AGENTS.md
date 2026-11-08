# Agent notes

- 多机（Windows/Linux）同步与 push 前门禁：以本文件 Default workflow、Explicit release workflow 与 git 状态为准；旧 docs/git-sync.md 已删除。
- Git workflow: use `main` as the only active local branch. When a commit is explicitly requested, commit directly to it. Do not create additional branches or worktrees unless the user explicitly requests them. Commit and push only when explicitly requested; there is no standing release authorization.
- Typecheck: `pnpm -s typecheck`
- Focused tests are `pnpm -s test:<name>` scripts in package.json (e.g. `test:memory`, `test:project-memory-extraction`, `test:pi-native-control`, `test:project-materials-ui`).
- **只支持当前 Pi 版本（1.5.0）**：旧版本（0.99.x / 0.99.2 / 1.0.x）的迁移与兼容测试已删除，不要为旧版本重新引入兼容层或迁移用例。版本 pin 在 `src/main/capabilities/subagent/worker-launcher.mjs` 的 `EXPECTED_PI_VERSION`，测试从那里读取，不要硬编码。
- **Full gate: `pnpm -s test:all`**（default 套件 = headless；当前数量以 `--list` 为准）。`scripts/test-all.mjs` 把 `test:*` 显式分为 headless / GUI / NETWORK / DATASET（+ pending 桶，当前为空），default 只跑 headless；`node scripts/test-all.mjs --list` 看分类，`--audit` 做分类自检。它是**棘轮**：`scripts/test-baseline.json` 里的已知失败会被打印但放行，任何*新增*失败都会让门禁失败；修好后删掉基线条目（`pnpm -s test:all:update-baseline` 会重写，但不要用它掩盖回归）。
- 产品构建产物检查单列为 **ARTIFACT**：`pnpm -s test:all:artifacts`（图片资源、OAuth bundle、内嵌 Codemode）；default 不假定已有 `out/main`。此命令不触发 build，缺产物必须失败。Windows/Linux CI 在其既有完整构建后强制执行，不得将未运行的 ARTIFACT 或 GUI 写成 default 通过。`--no-batch-build` 可对照逐脚本入口；批量 esbuild 每次编译当前源码，不使用持久缓存。
- **GUI/桌面套件必须真机跑**：`pnpm -s test:all:gui`（= default + GUI；需要真实桌面会话，先 `pnpm -s build` 供 consult-entry / startup perf 使用）。`pnpm -s test:all:live` 放行全部（含联网/远程/数据集用例）。CI 有独立的 `verify-windows-gui`（每晚 + 手动）跑 GUI 套件。
- 性能敏感用例（`test:core-performance*`）在 `test:all` 里走串行池，避免并行争用把启动 p95 推过预算；不要把它们并回并行池。
- Prefer asserting **behaviour** over source text. 仍有约 1/4 的测试用 `readFileSync` + `.includes()` 断言源码文本，这类断言在正确重构时会误报（`chat-markdown` 与 `models-settings-overlay` 都是实例）；新增断言尽量收敛到方法体或行为。不要硬编码版本/ schema 数字——从代码读（`CURRENT_DATABASE_SCHEMA_VERSION`、`EXPECTED_PI_VERSION`）。
- Electron UI 测试在继承 `ELECTRON_RUN_AS_NODE=1` 时会以 `app` undefined 失败：`env -u ELECTRON_RUN_AS_NODE pnpm -s test:<ui>`。截图落在 `out/tests/*.png`。GUI 测试必须使用临时 `userData`/HOME，不允许读真实 `~/.mybuddy` 凭据（`consult-entry` 默认空夹具，深层流程需 `CONSULT_ENTRY_SEED_USER_PROFILE=1` opt-in）。
- Run esbuild via the pnpm scripts, not by hand in Git Bash: MSYS path conversion mangles `--alias:@/store/appStore=...`。
- Live app data: `~/.mybuddy/app.db`（SQLite，只读诊断）、`~/.mybuddy/logs/main-YYYYMMDD.log`（主进程日志，按天 + 4MB 轮转、保留 7 份）、`~/.mybuddy/crashdumps/`（crashReporter 本地 dump，不上传）；Chromium 状态在 `~/.config/wavealstra_harness`（dev）或 `~/.config/MyBuddy`（打包版）。
- 数据安全：`AppDatabase` 在 `user_version` 不等于当前 schema 时会把旧库**改名备份**为 `app.db.discarded-<UTC时间戳>` 后重建空库；不要恢复旧的"直接删除"行为。`test:db-schema-discard` 保护该契约。
- Sandbox: run unsandboxed by default — `danger-full-access` with approval `never`; do not propose or fall back to sandboxed/approval-gated commands. This is pinned in the DSH desktop profile patch `~/.dsh/profiles/desktop/cordis.patch.yml` (`sandbox-policy.mode=danger-full-access`, `approval.policy=never`; `permission.defaultPreset=danger-full-access`). `DSH_*` variables are bootstrap-only: set them in the launching shell, never in `~/.dsh/.env`, or dsh refuses to boot.

## Linux（Omarchy / Wayland）

- Linux 开发/验收要点如下（旧 docs/omarchy-linux.md 已删除）。main 已内置 Linux 适配：PNG 托盘（22px）、`--password-store=gnome-libsecret`（Hyprland 下防止 safeStorage 落到 basic_text）、Linux 关窗驻留降级与通知、窗口 PNG 图标。
- safeStorage 需要在 ready 前注入开关并打印后端：启动日志应出现 `[safeStorage] linux backend=gnome_libsecret available=true` 与 `[Tray] 系统托盘已初始化 (png)`；若后端是 `basic_text`，不能接受为安全密钥库，Gateway 凭据会拒绝保存/恢复，先修系统 keyring（libsecret / gnome-keyring 等）。
- Linux 打包：`pnpm -s pack:linux`（electron-builder `--linux --dir`，产物 `release/linux-unpacked/mybuddy`），然后用 `pnpm -s verify:packaged -- --app-dir release/linux-unpacked` 过 payload 门禁（afterPack 现在所有平台都跑）。目前只有 dir 目标，还没有 AppImage/deb；从 Linux 交叉构建 Windows 不受支持（需要 wine + win32 原生重建）。
- CI：`.github/workflows/verify.yml` 有 `verify-windows` / `verify-linux`（default headless）与 `verify-windows-gui`（每晚 + 手动，不做 continue-on-error）。Linux job 用 xvfb 兜底间接拉起 Electron 的 headless 用例。
- **平台边界**：Windows/Linux/macOS 差异集中在 `src/main/platform/`（`runtime`/`paths`/`terminal`/`apps`/`fs-security`/`input`、`computer-use` backend、`tray`、`credentials`、`window-shell`/`app`/`lifecycle`、`fonts`、`processes`、`shell-tools`、`browsers`、`glimpse`）。服务层新增代码不要直接写 `process.platform` 分支；新增平台 = 在 platform 下加 provider/backend。矩阵与 Linux backend 以 `src/main/platform/computer-use/support.ts` 为准。
- **Linux Computer Use 使用 TypeScript + AT-SPI / Hyprland**：`src/main/platform/computer-use/linux/` 直接读取独立 accessibility bus 的控件对象，Hyprland IPC 提供窗口身份、逻辑布局、聚焦和真实指针回读，ydotool 只发送输入事件。不要恢复旧后端、截图/OCR 自动定位、X11 回退或任意 shell 拼接。对象引用须绑定总线代次/窗口观测，坐标须有来源与可靠性；未知 bounds、歧义目标和过期观测必须拒绝输入。详见 `docs/linux-computer-use.md`。
- **Linux 输入与截图独立验收**：`status()` 只能读轻量缓存，`refreshDiagnostics()` 按能力探测，不得隐式截图。AT-SPI worker 与输入释放守护进程使用 Electron 内置 Node，新增依赖为锁定的纯 JS `dbus-native`；打包必须包含 unpacked worker 并通过真实打包程序的握手。`key_down`/`mouse_down_client` 的状态保留到显式 up 或任务清理，取消/失败/进程退出只能释放本驱动持有的输入。
- **Linux GUI 门禁不能用 headless 代替**：`pnpm -s test:computer-use-linux` 在真实 Hyprland 用户会话里运行隔离的 Electron 与 GTK 靶窗；`pnpm -s test:computer-use-linux:packaged` 另验真实发行包的正常启动、内置 Node、worker 与相同输入链路。缺会话、依赖或 GTK 无障碍桥时命令必须失败，不得 skip+exit0。分数缩放须有实际桌面证据，混合缩放/旋转等纯变换夹具要另列。开发模式或 payload PASS 均不能称作发行包桌面验收通过。
- 停止/重启 dev 实例只对 Electron **主进程**发 SIGTERM（`.tools/mybuddy.sh stop` 已如此）；不要 broad `pkill` 所有 electron 进程——退出期 GPU relaunch 连续失败会触发 Chromium 的 GPU 崩溃保护（SIGILL + core，见 `artifacts/audit-2026-10-26/crash-sigill.md` §9）。

## Default workflow

- 默认流程：完成修复或功能实现，运行与改动相关的测试和检查，然后报告结果。
- 默认不升级版本号、不提交、不打包、不更新快捷方式、不推送，也不清理已有发行包。只有用户明确要求相应操作时才执行，不因完成修复而自动启动发布流程。
- **改完只跑 `pnpm dev`，不要编译任何产物**（用户 2026-11-06 明确指令）：不要 `pnpm -s build`、不要 `pack:*` / `dist*` / `electron-builder`，也不要为了「看一眼效果」构建开发包或安装包。验证用 `pnpm -s typecheck` + 与改动相关的 `test:*`；要看界面/实机效果就直接跑 `pnpm dev`（electron-vite dev，主进程与渲染层热更新）。
- 打包、安装、更新快捷方式只在用户明确要求发布时执行（见下一节）。

## Explicit release workflow

- 以下规则仅适用于用户明确要求的发布操作。按请求范围执行；要求打包不自动授权更新快捷方式、提交或推送。
- When packaging is explicitly requested, build the requested distribution and validate the actual packaged app before accepting it.
- When shortcut updates are explicitly requested, update the Desktop and Start Menu shortcuts to the accepted build, and read back their target, working directory, icon, and application identity.
- **Packaged-payload gate是构建的一部分**：`electron-builder` 的 `afterPack` 会调用 `scripts/verify-packaged-app.cjs`，校验 asar 索引里所有 `unpacked:true` 的条目都在 `app.asar.unpacked` 存在，并实际启动打包后的子代理 worker（`node worker-launcher.mjs <pi-runtime.mjs> --version`，版本必须等于 `EXPECTED_PI_VERSION`）；Linux 还必须用打包程序的 Electron Node 启动 AT-SPI worker / 输入释放守护进程握手，核对 Node 与依赖版本。构建失败就不要接受/安装该产物；不要为了“先跑起来”删掉 `app.asar.unpacked` 里的任何目录（子代理、execute_code、图片缩放都依赖它）。
- 手工复核用 `pnpm -s verify:packaged -- --app-dir <win-unpacked>`：PASS 才可以把快捷方式指过去。dev 模式（`out/`）永远有这些文件，dev 测试 GREEN 不能证明安装包可用。
- **打包会就地改写仓库根 `package.json`**：`electron-builder` 26.x 在打包时把它换成「打包用」裁剪版（只剩 name/version/main/dependencies 等，`scripts`/`devDependencies`/`build` 全丢；asar 里那份是正常的）。所以 `pack`/`pack:win`/`pack:linux`/`dist*` 链尾都串了 `scripts/check-root-package-json.cjs`：相对 git HEAD 发现短缺就备份到 `out/diagnostics/` 并从 HEAD 还原，然后非零退出（构建产物本身仍可用，`--no-fail` 只跳过退码）。手工跑过 `electron-builder` 后请看一眼 `git status`，别把裁剪版当成「没改动」提交掉。
- When release installation or cleanup is explicitly requested, keep one accepted desktop release. Delete obsolete generated release directories only after checking their resolved paths, active processes, and shortcut references, and verifying the retained package's hash and startup. Preserve unrelated source changes, user data, and diagnostic reports.
- Do not interrupt an active user task without authorization. If release validation fails, retain the previously accepted build and report the specific failure.
