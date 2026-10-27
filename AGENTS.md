# Agent notes

- Git workflow: use `main` as the only active local branch and commit directly to it. Do not create additional branches or worktrees unless the user explicitly requests them. The release workflow below is standing authorization for its scoped commit and push; otherwise push only when explicitly requested.
- Typecheck: `pnpm -s typecheck`
- Focused tests are `pnpm -s test:<name>` scripts in package.json (e.g. `test:memory`, `test:project-memory-extraction`, `test:pi-native-control`, `test:project-materials-ui`).
- **只支持当前 Pi 版本（1.3.0）**：旧版本（0.99.x / 0.99.2 / 1.0.x）的迁移与兼容测试已删除，不要为旧版本重新引入兼容层或迁移用例。版本 pin 在 `src/main/capabilities/subagent/worker-launcher.mjs` 的 `EXPECTED_PI_VERSION`，测试从那里读取，不要硬编码。
- **Full gate: `pnpm -s test:all`**（default 套件 = headless，255 个用例，约 1 分钟）。`scripts/test-all.mjs` 把 `test:*` 显式分为 headless / GUI / NETWORK / DATASET（+ pending 桶，当前为空），default 只跑 headless；`node scripts/test-all.mjs --list` 看分类，`--audit` 做分类自检。它是**棘轮**：`scripts/test-baseline.json` 里的已知失败会被打印但放行，任何*新增*失败都会让门禁失败；修好后删掉基线条目（`pnpm -s test:all:update-baseline` 会重写，但不要用它掩盖回归）。
- **GUI/桌面套件必须真机跑**：`pnpm -s test:all:gui`（= default + GUI；需要真实桌面会话，先 `pnpm -s build` 供 consult-entry / startup perf 使用）。`pnpm -s test:all:live` 放行全部（含联网/远程/数据集用例）。CI 有独立的 `verify-windows-gui`（每晚 + 手动）跑 GUI 套件。
- 性能敏感用例（`test:core-performance*`）在 `test:all` 里走串行池，避免并行争用把启动 p95 推过预算；不要把它们并回并行池。
- Prefer asserting **behaviour** over source text. 仍有约 1/4 的测试用 `readFileSync` + `.includes()` 断言源码文本，这类断言在正确重构时会误报（`chat-markdown` 与 `models-settings-overlay` 都是实例）；新增断言尽量收敛到方法体或行为。不要硬编码版本/ schema 数字——从代码读（`CURRENT_DATABASE_SCHEMA_VERSION`、`EXPECTED_PI_VERSION`）。
- Electron UI 测试在继承 `ELECTRON_RUN_AS_NODE=1` 时会以 `app` undefined 失败：`env -u ELECTRON_RUN_AS_NODE pnpm -s test:<ui>`。截图落在 `out/tests/*.png`。GUI 测试必须使用临时 `userData`/HOME，不允许读真实 `~/.mybuddy` 凭据（`consult-entry` 默认空夹具，深层流程需 `CONSULT_ENTRY_SEED_USER_PROFILE=1` opt-in）。
- Run esbuild via the pnpm scripts, not by hand in Git Bash: MSYS path conversion mangles `--alias:@/store/appStore=...`。
- Live app data: `~/.mybuddy/app.db`（SQLite，只读诊断）、`~/.mybuddy/logs/main-YYYYMMDD.log`（主进程日志，按天 + 4MB 轮转、保留 7 份）、`~/.mybuddy/crashdumps/`（crashReporter 本地 dump，不上传）；Chromium 状态在 `~/.config/wavealstra_harness`（dev）或 `~/.config/MyBuddy`（打包版）。
- 数据安全：`AppDatabase` 在 `user_version` 不等于当前 schema 时会把旧库**改名备份**为 `app.db.discarded-<UTC时间戳>` 后重建空库；不要恢复旧的"直接删除"行为。`test:db-schema-discard` 保护该契约。
- Sandbox: run unsandboxed by default — `danger-full-access` with approval `never`; do not propose or fall back to sandboxed/approval-gated commands. This is pinned in the DSH desktop profile patch `~/.dsh/profiles/desktop/cordis.patch.yml` (`sandbox-policy.mode=danger-full-access`, `approval.policy=never`; `permission.defaultPreset=danger-full-access`). `DSH_*` variables are bootstrap-only: set them in the launching shell, never in `~/.dsh/.env`, or dsh refuses to boot.

## Linux（Omarchy / Wayland）

- 完整开发/验收/打包说明见 [docs/omarchy-linux.md](docs/omarchy-linux.md)。main 已内置 Linux 适配：PNG 托盘（22px）、`--password-store=gnome-libsecret`（Hyprland 下防止 safeStorage 落到 basic_text）、Linux 关窗驻留降级与通知、窗口 PNG 图标。
- safeStorage 需要在 ready 前注入开关并打印后端：启动日志应出现 `[safeStorage] linux backend=gnome_libsecret available=true` 与 `[Tray] 系统托盘已初始化 (png)`；若后端是 `basic_text`，Slack/MCP 凭据会弱加密，先修密钥环（`docs/omarchy-linux.md` §系统依赖）。
- Linux 打包：`pnpm -s pack:linux`（electron-builder `--linux --dir`，产物 `release/linux-unpacked/mybuddy`），然后用 `pnpm -s verify:packaged -- --app-dir release/linux-unpacked` 过 payload 门禁（afterPack 现在所有平台都跑）。目前只有 dir 目标，还没有 AppImage/deb；从 Linux 交叉构建 Windows 不受支持（需要 wine + win32 原生重建）。
- CI：`.github/workflows/verify.yml` 有 `verify-windows` / `verify-linux`（default headless）与 `verify-windows-gui`（每晚 + 手动，不做 continue-on-error）。Linux job 用 xvfb 兜底间接拉起 Electron 的 headless 用例。
- **平台边界**：Windows/Linux/macOS 差异集中在 `src/main/platform/`（`runtime`/`paths`/`terminal`/`apps`/`fs-security`/`input`、`computer-use` backend、`tray`、`credentials`、`window-shell`/`app`/`lifecycle`、`fonts`、`processes`、`shell-tools`、`browsers`、`glimpse`）。服务层新增代码不要直接写 `process.platform` 分支；新增平台 = 在 platform 下加 provider/backend。矩阵与 Linux backend 路线见 [docs/platform-capabilities.md](docs/platform-capabilities.md)。
- 停止/重启 dev 实例只对 Electron **主进程**发 SIGTERM（`.tools/mybuddy.sh stop` 已如此）；不要 broad `pkill` 所有 electron 进程——退出期 GPU relaunch 连续失败会触发 Chromium 的 GPU 崩溃保护（SIGILL + core，见 `artifacts/audit-2026-10-26/crash-sigill.md` §9）。

## Default release workflow

- After completing a feature or bug fix, bump the desktop patch version unless the user specifies another version, run relevant checks, commit the scoped changes to `main`, and push to `origin/main`.
- Build the Windows distribution, validate the actual packaged app, update the Desktop and Start Menu shortcuts to the accepted build, and read back their target, working directory, icon, and application identity.
- **Packaged-payload gate是构建的一部分**：`electron-builder` 的 `afterPack` 会调用 `scripts/verify-packaged-app.cjs`，校验 asar 索引里所有 `unpacked:true` 的条目都在 `app.asar.unpacked` 存在，并实际启动打包后的子代理 worker（`node worker-launcher.mjs <pi-runtime.mjs> --version`，版本必须等于 `EXPECTED_PI_VERSION`）。构建失败就不要接受/安装该产物；不要为了“先跑起来”删掉 `app.asar.unpacked` 里的任何目录（子代理、execute_code、图片缩放都依赖它）。
- 手工复核用 `pnpm -s verify:packaged -- --app-dir <win-unpacked>`：PASS 才可以把快捷方式指过去。dev 模式（`out/`）永远有这些文件，dev 测试 GREEN 不能证明安装包可用。
- Keep one accepted desktop release. Delete obsolete generated release directories only after checking their resolved paths, active processes, and shortcut references, and verifying the retained package's hash and startup. Preserve unrelated source changes, user data, and diagnostic reports.
- Do not interrupt an active user task without authorization. If release validation fails, retain the previously accepted build and report the specific failure.
