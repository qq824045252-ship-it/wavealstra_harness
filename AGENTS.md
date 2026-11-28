# Agent notes

- 多机（Windows/Linux）同步与 push 前门禁：以本文件 Default workflow、Explicit release workflow 与 git 状态为准；旧 docs/git-sync.md 已删除。
- Git workflow: use `main` as the only active local branch. When a commit is explicitly requested, commit directly to it. Do not create additional branches or worktrees unless the user explicitly requests them. Commit and push only when explicitly requested; there is no standing release authorization.
- **推送 GitHub 默认合入 main**（用户 2026-11-10 明确要求）：用户说「提交并推送」时，不要只推临时分支，而是先 `git fetch` 并 rebase 到 `origin/main`，再在主仓库 `git merge --ff-only <branch>` 后 `git push origin main`；临时分支内容进 main 后删除远端同名分支。只在用户明确要求 PR/分支评审时才推分支。
- Typecheck: `pnpm -s typecheck`
- Node.js 26 is the MyBuddy development and verification baseline.
- Focused tests are `pnpm -s test:<name>` scripts in package.json (e.g. `test:memory`, `test:project-memory-extraction`, `test:pi-native-control`, `test:project-materials-ui`).
- **只支持当前 Pi 版本（1.5.0）**：旧版本（0.99.x / 0.99.2 / 1.0.x）的迁移与兼容测试已删除，不要为旧版本重新引入兼容层或迁移用例。版本 pin 在 `src/main/capabilities/subagent/worker-launcher.mjs` 的 `EXPECTED_PI_VERSION`，测试从那里读取，不要硬编码。
- **Full gate: `pnpm -s test:all`**（default 套件 = headless；当前数量以 `--list` 为准）。`scripts/test-all.mjs` 把 `test:*` 显式分为 headless / GUI / NETWORK / DATASET（+ pending 桶，当前为空），default 只跑 headless；`node scripts/test-all.mjs --list` 看分类，`--audit` 做分类自检。它是**棘轮**：`scripts/test-baseline.json` 里的已知失败会被打印但放行，任何*新增*失败都会让门禁失败；修好后删掉基线条目（`pnpm -s test:all:update-baseline` 会重写，但不要用它掩盖回归）。
- 产品构建产物检查单列为 **ARTIFACT**：`pnpm -s test:all:artifacts`（图片资源、OAuth bundle、内嵌 Codemode）；default 不假定已有 `out/main`。此命令不触发 build，缺产物必须失败。Windows/Linux CI 在其既有完整构建后强制执行，不得将未运行的 ARTIFACT 或 GUI 写成 default 通过。`--no-batch-build` 可对照逐脚本入口；批量 esbuild 每次编译当前源码，不使用持久缓存。
- **GUI/桌面套件必须真机跑**：`pnpm -s test:all:gui`（= default + GUI；需要真实桌面会话，先 `pnpm -s build` 供 consult-entry / startup perf 使用）。`pnpm -s test:all:live` 放行全部（含联网/远程/数据集用例）。CI 有独立的 `verify-windows-gui`（每晚 + 手动）跑 GUI 套件。
- 性能敏感用例（`test:core-performance*`）在 `test:all` 里走串行池，避免并行争用把启动 p95 推过预算；不要把它们并回并行池。
- Prefer asserting **behaviour** over source text. 仍有约 1/4 的测试用 `readFileSync` + `.includes()` 断言源码文本，这类断言在正确重构时会误报（`chat-markdown` 与 `models-settings-overlay` 都是实例）；新增断言尽量收敛到方法体或行为。不要硬编码版本/ schema 数字——从代码读（`CURRENT_DATABASE_SCHEMA_VERSION`、`EXPECTED_PI_VERSION`）。
- Electron UI 测试在继承 `ELECTRON_RUN_AS_NODE=1` 时会以 `app` undefined 失败：`env -u ELECTRON_RUN_AS_NODE pnpm -s test:<ui>`。截图落在 `out/tests/*.png`。GUI 测试必须使用临时 `userData`/HOME，不允许读真实 `~/.mybuddy` 凭据（`consult-entry` 默认空夹具，深层流程需 `CONSULT_ENTRY_SEED_USER_PROFILE=1` opt-in）。
- 聊天标题和操作按钮验收使用 `pnpm -s test:desktop-task-title`，`--list` 列出用例，修复后用 `--case=<id>` 复验。收到 `blocked_same_failure` 时读取报告的预期值和实测值，先定位断言或修复相关代码，再重跑对应单例。用户明确要求复验时可加 `--fresh`。过滤 Bash 验收日志时用 `set -o pipefail` 保留失败退出码。
- Run esbuild via the pnpm scripts, not by hand in Git Bash: MSYS path conversion mangles `--alias:@/store/appStore=...`。
- 生产数据由 Core 管理，位于 `~/.mybuddy/app.duckdb`，运行期间通过领域 IPC 诊断。主进程日志位于 `~/.mybuddy/logs/main-YYYYMMDD.log`，按天和 4 MB 轮转并保留 7 份。本地崩溃转储位于 `~/.mybuddy/crashdumps/`。Chromium 状态使用 Electron 的 `userData` 路径。Linux 默认使用 `~/.config/wavealstra_harness`（开发）或 `~/.config/MyBuddy`（打包）。Windows 默认使用 `%APPDATA%` 下的应用目录。隔离测试和定制启动以实际 `app.getPath("userData")` 为准。
- 旧数据策略（用户 2026-11-12 明确要求）：仅支持当前数据格式。确认格式或 schema 不兼容后才删除目标旧库及其 sidecar 并重建。不迁移旧数据，不生成 discarded 备份。当前有效数据库的幂等、崩溃恢复和单写者保护仍须保留。权限、I/O 和损坏错误不能冒充已确认的旧格式。DuckDB 引擎测试覆盖重开、确认旧格式重建和损坏文件保留。
- **DuckDB 是编译进 Rust 的**：`native/runtime-audit/Cargo.toml` 用 `duckdb = { version = "=1.20001.0", features = ["bundled", "json"] }`，C++ 引擎由 `libduckdb-sys` 从源码静态链接进 `mybuddy-runtime-audit`；TS 侧只经领域 IPC 访问 `~/.mybuddy/app.duckdb`，不加载外部 duckdb 动态库。AGENTS 本身不要求手工编译；`pnpm dev` 会调 `scripts/prepare-runtime-audit.cjs --dev`，显式要求编译时才单独跑它。
- **Windows 编译前置（缺一不可）**：标准 rustup 工具链（默认 1.97.1；`~/.cargo/bin` 里可能只有 `huacnlee/cargo` fork 的 `cargo.exe`、没有 `rustc.exe`，脚本检测到 fork 签名会回退到 `%RUSTUP_HOME%/toolchains/<default>`）；VS 2022 Build Tools 的 VC x86/x64 工具、Windows 10 SDK、CMake、Ninja（脚本先用 `vswhere` 定位安装，再从 `VC/Tools/MSVC/<version>` 与 `Windows Kits/10` 直接注入 `INCLUDE`/`LIB`/`PATH`；受限 shell 里 `vcvars64.bat` 依赖的 `reg.exe` 可能不可用，故不依赖它；Git Bash 的裸 PATH 里看不到 `cl`/`cmake` 是正常的）；Git Perl 与 Python 需在 PATH。当前依赖图不需要 `protoc` / `libclang`。
- **并行度（14 核怎么来的）**：`libduckdb-sys` 的 `bundled` 走 `cc-rs`，而它自己的 `Cargo.toml` 已声明 `cc = { features = ["parallel"] }`，所以 `cargo -j N` 会真的变成 N 个并发 `cl.exe`——前提是 cargo jobserver 还有空闲 token。脚本默认 `-j` = `availableParallelism() - 2`（16 逻辑核 → **14**，留 2 个核给系统、归档和链接阶段），`RUNTIME_AUDIT_JOBS` 可覆盖。DuckDB 是 316 个 unity-build TU（磁盘上 632 个 `.o` 是因为两套编译 flag 的产物并存，不是 632 个源文件）：**14 路并行实测 6 分 15 秒**（09:31:00→09:37:15，随后 `lib.exe` 归档 998 MB 用 25 s），同一个 target 目录里串行时是 **44 分钟**（08:04→08:48，全程只有 1 个 `cl.exe`），相差约 7 倍。
- **"只有一个 `cl.exe`"的判据与原因**：验收不看日志而数进程，`tasklist | grep -c '^cl\.exe'` 应稳定在 14 附近。看到 1 个不是机器只有 1 核，而是 jobserver 没给 token：token 总数等于 `-j`，冷构建时 cargo 正用它们并发编译几百个 Rust 依赖（`cargo test --no-run` 的 arrow 等 dev-deps 尤其凶），`cc-rs` 只能抢到 1 个，316 个 TU 就退化成单线程。所以要么先让 Rust 侧 warm 再重编 C++，要么别把自测和冷构建叠在一次调用里（脚本已把自测移到二进制构建之后）。14 路时物理内存最低约剩 9 GB（32 GB 机器），再加并行度前先看内存。
- **显式编译入口**：`node scripts/prepare-runtime-audit.cjs --dev`（`pnpm dev` 会调）、`... win-x64`（出产物）、`... win-x64 --force`（跳过 sha256 receipt 重跑 cargo）、`... win-x64 --clean --force`（先删 target 目录，DuckDB C++ 侧从零重编）。`RUNTIME_AUDIT_TESTS=1` 追加 crate 自测；自测排在二进制构建**之后**（先出产物，`cargo test` 通过才复制发布），因为排在前面会让 dev-deps 抢光 jobserver token。换独立目录用 `RUNTIME_AUDIT_BUILD_DIR=runtime-audit-build-par14`，不必删旧产物。产物 `out/native/win-x64/mybuddy-runtime-audit.exe`，协议版本必须为 `121`。全量 target 目录约 5.3 GB，`duckdb.lib` 单个 998 MB，链接阶段本身就要几分钟。
- **不要对目录跑 `icacls`**：`icacls <dir> /setintegritylevel (OI)(CI)M` 的耗时随子树体积增长（实测 190 MB → 33 s、355 MB → 55 s、5.3 GB 全量 target → 十几分钟），足以把构建卡在 60 s 级的超时上，而且它只报告 `Successfully processed 1 files`，看起来像没干活。Windows 决定进程完整性级别只看被启动的 image 文件，`.o`/`.rlib`/`.a` 的 IL 没有意义，所以脚本只对 `.exe` 文件逐个设 Medium IL（单文件 0.5 s 级；`icacls /setintegritylevel` 只接受一个名字，`icacls a.exe b.exe /setintegritylevel M` 会以 87 拒绝第二个名字，不能批量）。这条是硬约束，别再"顺手"把 build 目录也设一遍。
- Sandbox: run unsandboxed by default — `danger-full-access` with approval `never`; do not propose or fall back to sandboxed/approval-gated commands. This is pinned in the DSH desktop profile patch `~/.dsh/profiles/desktop/cordis.patch.yml` (`sandbox-policy.mode=danger-full-access`, `approval.policy=never`; `permission.defaultPreset=danger-full-access`). `DSH_*` variables are bootstrap-only: set them in the launching shell, never in `~/.dsh/.env`, or dsh refuses to boot.

## Linux（Omarchy / Wayland）

- Linux 开发/验收要点如下（旧 docs/omarchy-linux.md 已删除）。main 已内置 Linux 适配：PNG 托盘（22px）、`--password-store=gnome-libsecret`（Hyprland 下防止 safeStorage 落到 basic_text）、Linux 关窗驻留降级与通知、窗口 PNG 图标。
- safeStorage 需要在 ready 前注入开关并打印后端：启动日志应出现 `[safeStorage] linux backend=gnome_libsecret available=true` 与 `[Tray] 系统托盘已初始化 (png)`；若后端是 `basic_text`，不能接受为安全密钥库，Gateway 凭据会拒绝保存/恢复，先修系统 keyring（libsecret / gnome-keyring 等）。
- Linux 打包：`pnpm -s pack:linux`（electron-builder `--linux --dir`，产物 `release/linux-unpacked/mybuddy`），然后用 `pnpm -s verify:packaged -- --app-dir release/linux-unpacked` 过 payload 门禁（afterPack 现在所有平台都跑）。默认 `pack:linux` / `dist:linux` 配置仍为 dir；正式发布已提供 AppImage/deb（v0.1.108 起），须在完成 `pnpm run remote:build` 与 `pnpm exec electron-vite build` 后显式运行 `pnpm exec electron-builder --linux AppImage deb --publish never`，并运行根 package.json 守卫、ARTIFACT 与隔离实际包验收；从 Linux 交叉构建 Windows 不受支持（需要 wine + win32 原生重建）。
- CI：`.github/workflows/verify.yml` 有 `verify-windows` / `verify-linux`（default headless）与 `verify-windows-gui`（每晚 + 手动，不做 continue-on-error）。Linux job 用 xvfb 兜底间接拉起 Electron 的 headless 用例。2026-11-19 核查 GitHub 的 `verify` workflow 为 `disabled_manually`；上述是配置能力，不表示推送或每晚实际执行。发布前须核对在线状态，未运行不得称作 CI 通过。
- **平台边界**：Windows/Linux/macOS 差异集中在 `src/main/platform/`（`runtime`/`paths`/`terminal`/`apps`/`fs-security`/`input`、`computer-use` backend、`tray`、`credentials`、`window-shell`/`app`/`lifecycle`、`fonts`、`processes`、`shell-tools`、`browsers`、`glimpse`）。服务层新增代码不要直接写 `process.platform` 分支；新增平台 = 在 platform 下加 provider/backend。矩阵与 Linux backend 以 `src/main/platform/computer-use/support.ts` 为准。
- **Linux Computer Use 使用 TypeScript + AT-SPI / Hyprland**：`src/main/platform/computer-use/linux/` 直接读取独立 accessibility bus 的控件对象，Hyprland IPC 提供窗口身份、逻辑布局、聚焦和真实指针回读，ydotool 只发送输入事件。不要恢复旧后端、截图/OCR 自动定位、X11 回退或任意 shell 拼接。对象引用须绑定总线代次/窗口观测，坐标须有来源与可靠性；未知 bounds、歧义目标和过期观测必须拒绝输入。详见 `docs/linux-computer-use.md`。
- **Linux 输入与截图独立验收**：`status()` 只能读轻量缓存，`refreshDiagnostics()` 按能力探测，不得隐式截图。AT-SPI worker 与输入释放守护进程使用 Electron 内置 Node，新增依赖为锁定的纯 JS `dbus-native`；打包必须包含 unpacked worker 并通过真实打包程序的握手。`key_down`/`mouse_down_client` 的状态保留到显式 up 或任务清理，取消/失败/进程退出只能释放本驱动持有的输入。
- **Linux GUI 门禁不能用 headless 代替**：`pnpm -s test:computer-use-linux` 在真实 Hyprland 用户会话里运行隔离的 Electron 与 GTK 靶窗；`pnpm -s test:computer-use-linux:packaged` 另验真实发行包的正常启动、内置 Node、worker 与相同输入链路。缺会话、依赖或 GTK 无障碍桥时命令必须失败，不得 skip+exit0。分数缩放须有实际桌面证据，混合缩放/旋转等纯变换夹具要另列。开发模式或 payload PASS 均不能称作发行包桌面验收通过。
- 停止/重启 dev 实例只对 Electron **主进程**发 SIGTERM（先核对当前实例及主进程 PID；仓库不提供通用 `.tools/mybuddy.sh` 停止脚本）；不要 broad `pkill` 所有 electron 进程——退出期 GPU relaunch 连续失败会触发 Chromium 的 GPU 崩溃保护（SIGILL + core，见 `artifacts/audit-2026-10-26/crash-sigill.md` §9）。

## Default workflow

### Rust Core Architecture Guardrails (Route B: Single DuckDB + HotState)

- **禁止 1:1 透传单表 SQL 为独立 IPC**：不得新增零碎的 `*ById` / `HasAny*` / `*Count` / 单字段查询 RPC。一次业务动作在 Rust Core 只允许暴露 1 个粗粒度复合接口（聚合视图 View 或单事务复合命令 Command），不变量校验（存在性、回收站、工作区链、cwd/binding 一致性）必须下沉到 Rust Core 单事务内完成。
- **严禁纯 DB 写请求走外部文件 `fsync`**：`.runtime-operations/*.json` 只允许用于带外部副作用（进程启停、文件系统移动/删除）的请求；纯 DuckDB 事务依赖 DuckDB 自身事务/WAL 原子性，不得在写前/写后额外写盘 `sync_all()`。
- **确定性失败严禁伪装成 `OUTCOME_UNKNOWN`**：未进入 `commit()`（`commits == 0 && !committing`）的 SQL/Schema/约束/校验错误必须返回 `confirmedNoEffect: true` 与真实错误原因，不得触发“操作仍在处理或结果尚未确认”。
- **禁止继续膨胀 TS 同步/`*Async` 双轨复制代码**：后续子系统迁移统一收口为异步接口，测试夹具走内存实例或薄适配层，不得在 Service 文件内整段复制同步与异步两套业务逻辑。
- **性能门禁**：生产 DuckDB 必须保持 `checkpoint_threshold` 与关闭前 `CHECKPOINT`，只读池归还连接不得执行 `ROLLBACK`。

### Summary size contract

| 规则 | 强制检查 |
| --- | --- |
| 摘要长度只有一个数字：内核 `Config.compress.maxSummaryLength`（字符，超长会让内核拒绝**整批**范围）。宿主侧所有摘要预算（提示词上限、输出 token、分块、范围拆分、`acp_compress` 预检）必须从 `src/main/agent/durable/context/SummaryBudget.ts` 派生。不要新增第二套 token 预算，也不要用放宽上限来「修」超长；范围过大就沿原子边界拆块。 | `test:durable-summary-budget`（契约数学/拆块）与 `test:durable-context-summary-limit`（真实内核：超长摘要 condense 后提交、持续拒收时停在宿主侧、连续多轮每块 ≤ 上限）。 |

### Memory correctness checks

| 规则 | 强制检查 |
| --- | --- |
| 遗忘入口必须解析完整用户文档，保留引用块、示例、禁止执行语境和问句。不得把示例子句重新当成顶层指令。 | `MemoryInstructionDocument` 生成操作；`test:memory-correctness` 验证捕获后的水位、目标表与历史。 |
| 记忆标题只能与事实内容共同构成失效条件，不能单独撤销同类别历史。精确工具完成与自动捕获按具体请求关联。 | `Withdrawal` 的 fact 分支要求内容与身份；`test:memory-correctness` 覆盖同标题 A/B、在途提炼、完成捕获和重开。 |
| 完整范围检索必须同时验证正确性和主线程响应，不能把“万条记忆、单条向量”当成万向量验收。 | `test:memory-semantic-scale` 使用 10K 实际持久向量、长文本和多范围绑定，固定查询、事件循环与内存预算，默认走串行池。 |

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
