# Agent notes

- Git workflow: use `main` as the only active local branch and commit directly to it. Do not create additional branches or worktrees unless the user explicitly requests them. The release workflow below is standing authorization for its scoped commit and push; otherwise push only when explicitly requested.
- Typecheck: `pnpm -s typecheck`
- Focused tests are `pnpm -s test:<name>` scripts in package.json (e.g. `test:memory`, `test:project-memory-extraction`, `test:pi-native-control`, `test:project-materials-ui`).
- **只支持当前 Pi 版本（1.0.4）**：旧版本（0.99.x / 0.99.2）的迁移与兼容测试已删除，不要为旧版本重新引入兼容层或迁移用例。
- **Full gate: `pnpm -s test:all`** (aggregate runner over every `test:*`, excluding GUI/CDP/GPU/network cases — see `EXCLUDE_PATTERNS` in `scripts/test-all.mjs`). It is a **ratchet**: failures listed in `scripts/test-baseline.json` are tolerated but printed; any *new* failure fails the gate. Fix a test → remove its baseline entry (`pnpm -s test:all:update-baseline` rewrites the file). Never add an entry to silence a real regression.
- GUI/desktop suites need a real desktop session: `pnpm -s test:all:live`.
- Prefer asserting **behaviour** over source text. 30% of test files grep implementation source with `readFileSync` + `.includes()`; those break on correct refactors (e.g. `chat-markdown` pinned `isSvgFenceLanguage(extracted.language)` and broke when the call correctly gained a second argument). Do not hardcode versions/schema numbers in tests — read them from the code (`CURRENT_DATABASE_SCHEMA_VERSION`, the Pi `EXPECTED_PI_VERSION` pin).
- Electron UI tests fail with `app` undefined when the shell inherits `ELECTRON_RUN_AS_NODE=1`; run them as `env -u ELECTRON_RUN_AS_NODE pnpm -s test:project-materials-ui`. Screenshots land in `out/tests/*.png`.
- Run esbuild via the pnpm scripts, not by hand in Git Bash: MSYS path conversion mangles `--alias:@/store/appStore=...`.
- Live app data: `~/.mybuddy/app.db` (SQLite, open read-only for diagnosis).
- Sandbox: run unsandboxed by default — `danger-full-access` with approval `never`; do not propose or fall back to sandboxed/approval-gated commands. This is pinned in the DSH desktop profile patch `~/.dsh/profiles/desktop/cordis.patch.yml` (`sandbox-policy.mode=danger-full-access`, `approval.policy=never`; `permission.defaultPreset=danger-full-access`). `DSH_*` variables are bootstrap-only: set them in the launching shell, never in `~/.dsh/.env`, or dsh refuses to boot.

## Default release workflow

- After completing a feature or bug fix, bump the desktop patch version unless the user specifies another version, run relevant checks, commit the scoped changes to `main`, and push to `origin/main`.
- Build the Windows distribution, validate the actual packaged app, update the Desktop and Start Menu shortcuts to the accepted build, and read back their target, working directory, icon, and application identity.
- **Packaged-payload gate是构建的一部分**：`electron-builder` 的 `afterPack` 会调用 `scripts/verify-packaged-app.cjs`，校验 asar 索引里所有 `unpacked:true` 的条目都在 `app.asar.unpacked` 存在，并实际启动打包后的子代理 worker（`node worker-launcher.mjs <pi-runtime.mjs> --version`，版本必须等于 `EXPECTED_PI_VERSION`）。构建失败就不要接受/安装该产物；不要为了“先跑起来”删掉 `app.asar.unpacked` 里的任何目录（子代理、execute_code、图片缩放都依赖它）。
- 手工复核用 `pnpm -s verify:packaged -- --app-dir <win-unpacked>`：PASS 才可以把快捷方式指过去。dev 模式（`out/`）永远有这些文件，dev 测试 GREEN 不能证明安装包可用。
- Keep one accepted desktop release. Delete obsolete generated release directories only after checking their resolved paths, active processes, and shortcut references, and verifying the retained package's hash and startup. Preserve unrelated source changes, user data, and diagnostic reports.
- Do not interrupt an active user task without authorization. If release validation fails, retain the previously accepted build and report the specific failure.
