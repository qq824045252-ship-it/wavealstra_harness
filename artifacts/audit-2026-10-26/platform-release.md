# Linux 适配与发布/打包现状审计（platform-release）

- 日期：2026-10-26
- 审计对象：`/home/vivion/github/wavealstra_harness`（main = `230e8b1`，与 `origin/main` 同步）
- 环境：Omarchy（Arch）/ Hyprland / Wayland；Node v26.7.0；pnpm 12.14.0；Electron 44.5.1；electron-builder 26.15.3；electron-vite 5.0.0
- 对比分支：`origin/cursor/omarchy-linux-adapt-413c`（4 个提交，merge-base `4687852`；main 相对它有 8 个提交）
- 审计方式：**只读**。读代码/配置/脚本、`git diff/show/log`、只读 D-Bus/`/proc`/`ss` 探测、两个打包校验脚本的干跑（dry-run）；**未**执行 `pack`/`dist`/完整 `test:all`，**未**启动/重启 Electron 实例（正在运行的 dev 实例 PID 224446 未受干扰）。

---

## 0. 结论摘要（Top 问题）

| # | 问题 | 严重度 | 状态 | 一句话证据 |
|---|------|--------|------|-----------|
| 1 | main 在 Linux 上托盘图标为空：D-Bus 上托盘项存在但无 `IconName`/`IconPixmap`，关窗后窗口隐藏、图标不可见，只能靠「再启动一次」命中单实例锁恢复 | P1 | 已验证（运行时观测） | `gdbus GetAll org.kde.StatusNotifierItem` 结果无图标属性；对比 FlClash 托盘项有 `IconName` |
| 2 | main 在 Hyprland 上 safeStorage 落到 `basic_text`（Chromium 硬编码口令），Slack/MCP 凭据「静默变弱加密」而非报错；main 无 `--password-store` 开关、无后端日志/提示 | P1 | 已验证（配置+Electron 文档）；后端值本身为强推断 | `XDG_CURRENT_DESKTOP=Hyprland` 不在 Electron 文档的 GNOME 识别列表；进程 cmdline 无 `--password-store` |
| 3 | 打包 payload 门禁在 Linux（以及从 Linux 发起 `--win` 交叉构建）**被静默跳过**：`afterPack` 首行 `if (process.platform !== 'win32' ...) return` | P1 | 已验证（读代码） | `scripts/after-pack-windows.cjs:7` |
| 4 | Linux 打包产物必然缺少 `@napi-rs/keyring-linux-x64-gnu`（files/asarUnpack 只列 win32），`@napi-rs/keyring` 在缺原生绑定时 `throw`，而 `BuiltinCredentialStore` 是静态 import → 产物很可能启动即崩 | P1 | 配置已验证；崩溃为推测（未实跑 pack） | `package.json:480-481,494-495`；`node_modules/@napi-rs/keyring/index.js` 尾部 `Cannot find native binding` |
| 5 | CI 只有 `windows-latest` 且 `pnpm 9` 与 `pnpm-workspace.yaml` 的 `overrides` 不兼容，`pnpm install --frozen-lockfile` 会失败，但被 `continue-on-error: true` 掩盖 | P1（CI 可信度） | 配置结构已验证；失败场景未实跑 | `.github/workflows/verify.yml:20,27,34-36`；`pnpm-workspace.yaml:7` |
| 6 | `test:all` 的门禁排除表漏掉 `:desktop`（如 `test:consult-entry:desktop`），另有 8 个 `*-ui`/`test:tray` 等 GUI 用例不在排除表内 → 无头环境必红 | P2 | 已验证（脚本+正则枚举） | `scripts/test-all.mjs:45`；`test:*` 共 321 个 |
| 7 | `pnpm dist` 在 Linux 本机不可执行（`electron-builder --win` 交叉构建：需 wine toolset、win32 原生模块重建；本机无 wine） | P2（流程阻断） | 部分已验证（脚本/无 wine）；具体失败点推测 | `package.json:63`；`app-builder-lib/out/targets/nsis/NsisTarget.js:373` |
| 8 | AGENTS.md 写 Pi 1.0.4，代码/依赖/门禁基线全是 1.3.0 | P2（文档漂移） | 已验证 | `AGENTS.md:6` vs `src/main/capabilities/subagent/worker-launcher.mjs:11`、`scripts/test-baseline.json` 的 `$basis` |

> 不存在已对外发布的 Linux 产物，因此严格意义上的 P0=0；若「直接在 Linux 上 `pnpm pack` 并分发」，#4 按发布口径应视为阻断（P0），建议在打通 Linux 发布链路时先修。

---

## 1. 方法与边界

- 只读：`git diff/show/log`、`read/grep`、`pnpm -s typecheck`、`pnpm -s test:harness-quality`、两个打包校验脚本的干跑、`busctl/gdbus/ss/ps//proc` 只读探测。`typecheck` 与 `test:harness-quality` 属静态/无 GUI 门禁，未写源码。
- 未执行：`pnpm pack`（跑 `remote:build`+`electron-vite build`+`electron-builder`，会写 `out/`/`release/`）、`pnpm dist`（写 `release/`，需网络下载 wine，且可能污染产物）、`test:all`（321 用例、可能拉起 Electron GUI）。
- 运行中的 dev 实例（`electron-vite dev` → Electron PID 224446，`--user-data-dir=/home/vivion/.config/wavealstra_harness`）只做进程/DBus 观测，不发送任何控制指令。

---

## 2. 环境基线（均已验证）

| 事实 | 证据 |
|------|------|
| OS 为 Omarchy（Arch），会话 Hyprland + Wayland | `/etc/os-release`；`XDG_CURRENT_DESKTOP=Hyprland`、`WAYLAND_DISPLAY=wayland-1` |
| 密钥环：`gnome-keyring-daemon --components=pkcs11,secrets` 在跑，`libsecret` 已装 | `ps`；`/usr/lib/libsecret-1.so.0`；`secret-tool` 存在 |
| 状态栏托盘宿主可用：`org.kde.StatusNotifierWatcher`（quickshell PID 1505） | `busctl --user list` |
| 通知服务可用：`org.freedesktop.Notifications`（quickshell） | `busctl --user list` |
| appindicator 库存在：`/usr/lib/libappindicator3.so.1` | `ls` |
| dev 实例：Electron 44.5.1，`--ozone-platform=wayland`，**cmdline 无 `--password-store`** | `/proc/224446/cmdline`，渲染进程 argv |
| 数据根 `~/.mybuddy`：`app.db`（约 1.1MB）、`auth.json`、`backups/` | `ls -la ~/.mybuddy` |
| Electron userData（dev）= `~/.config/wavealstra_harness`（55MB：Cache/Cookies/Crashpad/…） | 进程 argv；`du -sh` |
| 无 `release/` 目录；`release/`、`release-*/` 已被 `.gitignore` 忽略 | `ls release` → No such file；`.gitignore:4-5` |
| 无 wine | `which wine wine64` 空 |
| `pnpm -s typecheck` 在 Linux **通过**（scripts 209 条基线错误、新增 0） | 实跑输出 |
| `pnpm -s test:harness-quality` 在 Linux **通过** | 实跑输出 |
| 本机 Python 存在（`/usr/bin/python`） | `which` |

---

## 3. main 在 Linux 上到底缺什么：分支 4 个提交逐项核实

判断口径：`git diff main origin/cursor/omarchy-linux-adapt-413c`（两dot，main→分支内容）与 main 的 `git log`。注意 **`main...分支` 是「merge-base → 分支」**，不能用来判断 main 缺什么（首轮曾误用，已纠正）。

`git diff --stat main origin/branch` 显示 69 文件、+563/−1245：分支基线早于 main 的 magpie、连接器大小写、`typecheck-scripts` 棘轮等提交，**直接 merge 会把 main 的新功能回退**（例如 `integrations/magpie-agent-mybuddy/*`、`scripts/typecheck-scripts.mjs`、`src/main/connectors/ConnectorService.ts`）。结论：只能挑文件/提交移植，不能整体合并。

### 3.1 `fea36a8 feat(linux): gnome-libsecret + PNG 托盘驻留`

| 子项 | main 现状 | 是否本机真实缺口 | 证据 |
|------|----------|------------------|------|
| `--password-store=gnome-libsecret`（ready 前注入） | 无。`src/main/linux-password-store.ts` 不存在；`grep appendSwitch src/main` 为 0；运行中主进程 cmdline 无该开关 | **是** | Electron 文档：`basic_text` =「desktop environment is not recognised」；识别列表只有 `X-Cinnamon/Deepin/GNOME/Pantheon/XFCE/UKUI/unity`，Hyprland 不在内。`electron.d.ts` 中 `getSelectedStorageBackend()` 注释 |
| 后果 | Slack/MCP 走 `safeStorage.isEncryptionAvailable()`；`basic_text` 下 key 存在、`isEncryptionAvailable()` 返回 true（Electron 文档口径），于是**不报错、用 Chromium 硬编码口令弱加密落盘**；只有真正 unavailable 才会抛「系统凭据加密不可用」 | **是（安全语义）**，但分支 commit 描述「会落到 basic_text 或直接不可用 → 保存失败」只覆盖后者 | `src/main/gateway/SlackGatewayCredentials.ts:13,23`；`src/main/mcp/McpCredentialBackend.ts:14,18` |
| 托盘图标改 PNG（Linux） | `TrayService` 仍只 import `tray.ico`；`new Tray(nativeImage.createFromPath(ico) || createEmpty())` | **是** | `src/main/TrayService.ts:6,32-33`；本机运行实例的 SNI 项 `org.freedesktop.StatusNotifierItem-224446-1` 的 `GetAll` 只有 `Id/Category/Status/ToolTip/Menu/...`，**没有 `IconName`/`IconPixmap`**（工具提示为 `MyBuddy`，确系本应用）；对照组 FlClash 的托盘项有 `IconName` |
| Linux 托盘创建失败时仍驻留 | 无 `tray-residency.ts`；`shouldSuppressQuit()` = `closeToTray && tray !== null` | 方向对，但**本机触发路径与分支假设不同**：本机 `new Tray()` 不抛错，SNI 项正常注册，只是图标空 → `tray !== null` 成立 → 关窗仍隐藏；分支真正修掉可见性的是「Linux 下 `icon.isEmpty()` 就 throw → 走 degraded」那条，而非「unavailable 才驻留」 | `src/main/TrayService.ts:55-66,77-79`；分支 `06b0ccc` 版 `TrayService.ts`；`tray-residency.ts` |
| 关窗提示改通知（Linux） | `maybeShowHint()` 仅 `win32`，Linux 关窗后**无任何提示** | **是** | `src/main/TrayService.ts:142` |
| 窗口图标 Linux 用 `app.png` | `createWindow` 固定 `nativeImage.createFromPath(app.ico)` | **是（P3）** | `src/main/index.ts:12,475` |
| 托盘图标 1024px→22px 缩放 | main 无缩放（但因图标为空未暴露） | 是（健壮性） | 分支 `TrayService.ts` |
| 新增测试 `test:linux-session`、`scripts/tray-residency-test.ts` | main 无 | 是（无回归保护） | 分支文件清单（`comm` 对比 main 独有 6 文件） |

**结论**：`fea36a8` 的 4 个能力（密钥环开关、PNG 托盘、Linux 通知提示、窗口 PNG 图标）在 main 上仍全部缺失，属本机真实缺口；但提交说明里「safeStorage 不可用 → 保存失败」的描述与 main 在 basic_text 下的实际行为不符，移植时应保留「ready 后打印 backend 并在非 `gnome_libsecret` 时告警」的诊断，而不是只依赖 `isEncryptionAvailable()`。

### 3.2 `81b96ef fix(ci): pnpm 11.28.8 + frozen install`

- main：`.github/workflows/verify.yml:27` 仍是 `version: 9`；`package.json` 无 `packageManager` 字段；`pnpm-workspace.yaml:7` 起有 `overrides`（含 `app-builder-lib@26.15.3>@electron/get: 3.1.0`、`vite>esbuild: 0.28.2`）。
- 结构判断：pnpm 9 不读 `pnpm-workspace.yaml` 的 `overrides`（pnpm 10 起才支持），而 `pnpm-lock.yaml` 顶部有 `overrides:` 段 → `--frozen-lockfile` 期望的配置指纹不一致，典型报错 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`。CI 里该步还有 `continue-on-error: true`，会把「依赖没装上」伪装成后面的 tsc 失败。
- **状态：已验证配置结构 + 分支提交说明；未实跑 pnpm 9（禁止安装依赖）。**判定：main CI 的安装步骤不可信，属真缺口。
- 额外漂移：本机 pnpm 12.14.0、分支 pin 11.28.8、main CI 9 —— 三套版本并存，lockfile 为 `lockfileVersion: '9.0'`。

### 3.3 `a1835bb fix(ci): 缩短 Windows 原生编译路径（C:\r）`

- main 无此步；main 的 Windows job 直接在工作区 `D:\a\wavealstra_harness\wavealstra_harness` 下做 `npmRebuild`（node-pty patch + node-addon-api 的 MSBuild 中间路径）。
- **本机 Linux 不受影响**（无 MSBuild），属 Windows CI 专属缺口；具体是否有 260 字符超限只能由 Windows runner 复现（**推测**，依据提交说明）。
- 注意：该修复强绑定 `shell: pwsh` 与 `robocopy`，是「Windows CI 补丁」，不是 Linux 适配；移植时只应挑 CI 片段。

### 3.4 `70e1028 fix(ci): 修掉 Windows 全量门禁里的五项新失败`

| 项 | main 现状 | 判定 |
|----|----------|------|
| Durable 夹具必须返回 `{tools, contextHooks}` | main **已有**等价修复：`scripts/gateway-durable-test.ts:44` 返回 `{ tools:[hold], contextHooks:[] }`（main `3e8a26e` 提交引入） | 已等价修复，无需移植 |
| shell 用例改 node（不依赖 python） | main 仍用 `python - <<'PY'`：`scripts/builtin-capabilities-test.ts:204`；本机与 GitHub Windows runner 都有 python | 低价值缺口（P3，可移植性） |
| `test:consult-entry:desktop` 等 `:desktop` 排除 | main **未修**：`scripts/test-all.mjs:45` 仅 `/-desktop$/`；而仓库确有 `test:consult-entry:desktop` | **真缺口**（P2） |
| `consult-card-ui` 修 flaky | main **已有更强修复**（`687ba52`：Linux 上不可靠的 `setContentSize` 换成 CDP `Emulation.setDeviceMetricsOverride`；`git diff` 可见 main 比分支版本更彻底） | 已等价/更优，无需移植 |
| test-guard POSIX `/proc` 采样用 ESM import | main **已修**（`1fb66b5`，`scripts/test-guard.mjs:23,121`）；且 main 还有 `78f71e0` 的沙箱 HOME 隔离，比分支版本更新 | 已等价修复；**不要**用分支版覆盖 main 的 test-guard（会丢 `GUARD_HOME` 隔离） |

### 3.5 分支 package.json 中与 Linux 打包相关的增量（main 缺失）

- `files` / `asarUnpack` 增加 `@napi-rs/keyring-linux-x64-gnu`（main 只列 `-win32-x64-msvc`）→ **Linux 包缺原生模块**，见 §4.3。
- 新增 `build.linux`（`icon: build/icon.png`、`category: Utility`、`executableName: mybuddy`、target `dir/x64`）——分支自己的 `docs/omarchy-linux.md` 明确写着「`build.linux` 目前只是 dir 草稿，`pnpm dist` 仍是 Windows NSIS」。
- 新增 `packageManager: pnpm@11.28.8`（版本策略见 §3.2）。

---

## 4. 打包 / 发布：Windows-only 假设与 Linux 可执行性

### 4.1 脚本与配置现状（均已验证）

| 脚本/配置 | 内容 | Windows-only 点 |
|---|---|---|
| `package.json:62` `pack` | `remote:build && electron-vite build && electron-builder --dir` | 无显式平台；`--dir` 在当前平台出 `linux-unpacked`（若跑在 Linux） |
| `package.json:63` `dist` | 同上 + `electron-builder --win` | **硬编码 `--win`（NSIS）** |
| `build.afterPack` `package.json:452` | `scripts/after-pack-windows.cjs` | 首行 `process.platform !== 'win32'` 直接 return；`icacls /setintegritylevel` 纯 Windows |
| `build.icon` `package.json:461` | `build/icon.ico` | Linux 期望 png（顶层 `build/icon.png` 存在但未被引用；`build.linux` 缺失） |
| `build.files` `package.json:471-488` | 白名单式 `node_modules`：better-sqlite3、node-pty、keyring（仅 win32）、onnxruntime（显式排除 `{darwin,linux}`）、jiti | **Linux 原生模块被排除** |
| `build.asarUnpack` `package.json:490-503` | keyring 仅 win32 | 同上 |
| `build.extraResources` `package.json:465-469` | `scripts/windows-ocr.ps1` → `windows-ocr.ps1` | Windows 专用资源（Linux 无害但无用） |
| `verify:packaged` | `node scripts/verify-packaged-app.cjs` | `:112` 在 app 目录里找 `.exe`；`:249-254` 默认 `release/win-unpacked`；文档/帮助均为 win-unpacked |
| `validate:packaged-image-resize` | `node scripts/validate-packaged-image-resize.cjs` | `:53-58` 硬编码 `release/*/win-unpacked` + `MyBuddy.exe` |
| `scripts/repair-mybuddy-windows-shortcuts.cjs` | 更新桌面/开始菜单 `.lnk` | 纯 Windows（AGENTS 发布流程依赖它） |
| `electron.vite.config.ts` | 无平台分支；`?asset` 资源由 electron-vite emit | 本身可跨平台（dev 实例已证） |

补充事实：`src/main` 中 `process.platform` 引用 76 处，其中 61 处是 Windows 判断，**`=== "linux"` 的判断为 0 处**（唯一相关是 `TrayService.ts:142` 的 `!== "win32"` 提前返回）。即 main 对 Linux 的行为完全是「非 Windows 的缺省路径」，没有针对性实现。

### 4.2 `pnpm -s pack` 在 Linux 会怎样？（读脚本推断，未实跑）

1. `remote:build`（vite 构建 remote SPA）——跨平台，预期通过。
2. `electron-vite build`——dev 实例证明该链路在本机可用，预期通过（写入 `out/`）。
3. `electron-builder --dir`：
   - 当前平台 = linux，无 `build.linux` → 用默认值（target `dir`，`linux-unpacked`）；
   - 图标来源 `config.icon = build/icon.ico`：electron-builder 的 Linux 图标解析走 `resolveIcon`（`LinuxTargetHelper.computeDesktopIcons`），期望 png/icns；给 ico 可能报「image format not supported」或回退默认 Electron 图标（**推测**，未实跑）；
   - `npmRebuild: true` + `electronDist: node_modules/electron/dist` → 会对 better-sqlite3/node-pty 做 linux/Electron-44 ABI 重建（本机有编译工具链，dev 已在用，大概率可过）；
   - `afterPack` **静默跳过**（`after-pack-windows.cjs:7`）→ 没有 payload 门禁、没有 asar 解包完整性校验。
4. 即使构建成功，产物**必然**缺 `@napi-rs/keyring-linux-x64-gnu` 与 onnxruntime 的 linux 二进制（配置白名单），见 §4.3。

结论：`pack` 可能「能跑完」，但产出的 `linux-unpacked` 不是可发布物，且构建过程没有任何 Linux 门禁。

### 4.3 Linux 打包产物缺原生模块（配置已验证，运行后果推测）

- `@napi-rs/keyring` 的平台二进制是 optionalDependencies（`node_modules/@napi-rs/keyring/package.json` 列出 12 个平台包），本机 dev 已装 `keyring-linux-x64-gnu`，所以**开发模式正常**；但 `files`/`asarUnpack` 白名单只列 win32，打包后 wrapper 找不到 linux 绑定，`index.js` 末尾会 `throw new Error("Cannot find native binding")`。
- 该模块的引用链是**静态 import**：`src/main/capabilities/BuiltinCredentialStore.ts:1` → `BuiltinCapabilityRuntime` → `AgentService.ts:9` / `SessionExtensionAssembler.ts:21` → `src/main/index.ts`。若整条链在启动时被求值，Linux 包会**启动即崩**（推测：需实际构建一次验证，但静态 import 使崩溃概率很高）。
- onnxruntime 的 linux 二进制被 `package.json:485` 显式排除：影响语义检索/embedding 模型（`src/main/retrieval/SemanticModelManager.ts`），预期是「功能缺失/降级」而非崩溃（推测）。

### 4.4 `pnpm -s dist` 在 Linux 会怎样？（读配置推断）

- `electron-builder --win` = 交叉构建 Windows NSIS：
  - 图标/版本资源写入走纯 JS `resedit`（`app-builder-lib/out/util/resEdit.js`），不需要 wine；
  - 但生成卸载器时 `NsisTarget.js:373-374` 会 `WineVmManager.exec(installerPath)`，即需要 wine（electron-builder 会尝试下载 `wine-11.0-linux-x86_64` toolset，`toolsets/wine.js`）；
  - `npmRebuild: true` 需要为 **win32** 重建 better-sqlite3/node-pty（node-pty 还带 patch）；从 Linux 交叉编译 MSVC 原生模块通常不可行 → 这是更可能的第一个硬失败点（**推测**）。
  - 本机 `which wine` 为空；即使 electron-builder 能下载自带 wine，也依赖外网与数百 MB 下载。
- 结论：`dist` 在本机属于「不可执行/不可复现」的发布路径；AGENTS 的 Windows 发布流程在当前机器上**无法闭环**（见 §6）。

### 4.5 `verify:packaged` / `validate:packaged-image-resize` 干跑（已验证）

```
$ pnpm -s verify:packaged
[verify-packaged] app dir: /home/vivion/github/wavealstra_harness/release/win-unpacked
[verify-packaged] FAIL app directory not found: ...
[ELIFECYCLE] Command failed with exit code 1.

$ pnpm -s validate:packaged-image-resize
PACKAGED-VALIDATION-FAIL: no packaged win-unpacked/MyBuddy.exe found
[ELIFECYCLE] Command failed with exit code 1.
```

- 两者都是「默认路径 + `.exe`」双重 Windows 假设；即使把 `--app-dir release/linux-unpacked` 传进去，`verify-packaged-app.cjs:112-114` 也会以「no application executable found」失败（Linux 产物是 `mybuddy` 无扩展名）。
- `verify-packaged-app.cjs` 的 worker 探针部分其实已跨平台（`findNode()` 在非 win32 下找 `node`，`:87`），只需改「可执行文件判定」与默认目录即可复用，改造成本低。
- AGENTS.md 把该门禁写成「构建的一部分」，但现实是：**Windows 本机构建有门禁，Linux 本机构建没有门禁，Linux 交叉 Windows 构建也没有门禁**（`process.platform` 判断的是**宿主**，不是目标）。

### 4.6 `afterPack` 在 Linux 上是否有意义？

- 无意义且有害（有害 = 给了「已校验」的错觉）：`after-pack-windows.cjs:7` 在非 Windows 宿主直接返回，`verifyPackagedApp()` 与 `icacls` 都不执行；Linux 产物因此**从不**经过 asar/解包完整性校验。
- 建议把「payload 校验」与「Windows integrity 标注」拆成两个 hook/模块：payload 校验平台无关（改 `.exe` 判定为「可执行文件或 linux 无扩展名主程序」），integrity 部分保留在 win32 分支。

---

## 5. CI 现状与影响

### 5.1 事实（已验证）

- 仅一个 workflow：`.github/workflows/verify.yml`，`runs-on: windows-latest`（`:20`），jobs 只有 typecheck → harness-quality → artifact-gate → `test:all`。
- `pnpm/action-setup` 固定 `version: 9`（`:27`）；`pnpm install --frozen-lockfile` 带 `continue-on-error: true`（`:34-36`）。
- 注释仍写「过期常量（断言 Pi 1.0.0 而实际 1.0.4）」（`:4-5`），与仓库现状（1.3.0）再次漂移。
- main 的 `test:all` 排除表见 `scripts/test-all.mjs:41-56`：只有 `/-desktop$/`，没有 `:desktop`。

### 5.2 影响

1. **Linux 专属代码零 CI 覆盖**：分支引入的 `linux-password-store`、`tray-residency`、PNG 托盘分支一旦合并，只能在开发机手测；CI 永远绿/永远不暴露 Linux 回归。若再加 ubuntu job，还要先解决：
   - 无头环境需要 `xvfb`（`test:tray`、`test:memory-ui`、`test:expert-ui`、`test:project-*-ui`、`test:consult-card-ui`、`test:settings-records-ui` 等 9 个非排除项会直接拉起 Electron）；
   - `test:consult-entry:desktop` 因正则漏写仍会进入门禁（main 现状）。
2. **Windows 门禁本身不可信**：pnpm 9 的 frozen install 大概率失败却被 `continue-on-error` 吞掉；缺 `C:\r` 短路径修复时 node-pty 原生编译可能因 260 字符路径失败。即「CI 红/绿」当前不能等价于「代码门禁结果」。
3. **本机 Linux 开发无任何 CI 兜底**：本机已证明 `typecheck` + `test:harness-quality` 在 Linux 可通过（正向），但 `test:all` 的 321 条在 Linux 上是否全绿**没有证据**（本次未跑，属未知风险；建议后续单独跑一次并记录基线）。
4. 分支出包（若将来做 Linux 发布）也没有「Linux 构建 job」，`afterPack` 跳过意味着坏包可以直接产出（见 §4.6）。

---

## 6. AGENTS.md 与代码/环境的漂移（「文档说的 vs 实际」）

| # | 文档说的 | 实际 | 严重度/状态 |
|---|---------|------|------------|
| 1 | 「只支持当前 Pi 版本（**1.0.4**）」（`AGENTS.md:6`） | 依赖与代码均为 **1.3.0**：`worker-launcher.mjs:11` 的 `EXPECTED_PI_VERSION = "1.3.0"`；`@earendil-works/pi-*` 全部 1.3.0；`scripts/test-baseline.json` 的 `$basis` 也写「本仓库只支持当前 Pi 版本 1.3.0」 | P2 文档；建议直接改 AGENTS + 清 docs/pi104 旧文档标注 |
| 2 | 发布流程 = 构建 Windows 分发、更新桌面/开始菜单快捷方式、`verify:packaged --app-dir <win-unpacked>`（`AGENTS.md:18-20`） | 本机 Linux：无 wine、无 `release/`、无 `.lnk`（`scripts/repair-mybuddy-windows-shortcuts.cjs` 纯 Windows）；`dist` 为 `--win`（`package.json:63`） | P1/P2 流程漂移：该流程在本机**不可执行** |
| 3 | 「`electron-builder` 的 `afterPack` 会调用 `verify-packaged-app.cjs`…构建失败就不要接受产物」（`AGENTS.md:19`） | 仅在 **Windows 宿主**成立；Linux 宿主/交叉构建时 `after-pack-windows.cjs:7` 直接 return，门禁不执行 | P1（对 Linux 发布是「门禁不存在」） |
| 4 | 「Life app data: `~/.mybuddy/app.db`」（`AGENTS.md:12`） | 数据根确为 `~/.mybuddy`（已验证 `app.db` 存在），但 Electron userData 是**另一个目录**：dev `~/.config/wavealstra_harness`（已验证，55MB Chromium 状态），打包版预期 `~/.config/MyBuddy`（推测）。`DurableStorageLease.ts:10` 注释明确「打包版与 dev 版 userData 不同」→ 这是有行为影响的差异，文档未提 | P2/P3 文档 |
| 5 | 「Run esbuild via pnpm scripts, not by hand in Git Bash: MSYS path conversion…」（`AGENTS.md:11`） | 本机是 Linux（无 MSYS），该条只在 Windows Git Bash 有意义；Linux 上按此条排查会误导 | P3 文档 |
| 6 | 「GUI/desktop suites … 用 `pnpm -s test:all:live` 在自托管 runner 上验证」（`verify.yml:18-19` 注释） | 仓库里没有自托管 runner / live job，唯一 workflow 是 windows-latest 无头门禁 | P2 流程缺口 |
| 7 | `docs/架构分析.md:375-376`：`pnpm pack` = 「electron-vite build + electron-builder --dir」、`pnpm dist` = 「electron-vite build + electron-builder --win」 | 真实脚本两者都多了 `pnpm run remote:build`（`package.json:62-63`）；且仍未描述 Linux 路径；同文档 `:38` 写「pnpm 11.x」，本机 12.14.0、main CI 9 | P3 文档 |
| 8 | `verify.yml:4-5` 注释「断言 Pi 1.0.0 而实际 1.0.4」 | 实际 1.3.0（见 #1） | P3 注释漂移 |
| 9 | 隐含期望「托盘关窗 = 最小化到托盘，可点图标恢复」 | Linux 上托盘项无图标（§3.1），关窗后窗口隐藏且**没有可见入口**；只能靠「再启动一次」命中 `requestSingleInstanceLock`（`index.ts:336-345`）恢复 | P1 行为差距（文档未声明 Linux 降级） |
| 10 | 「开机自启」被列为待核对项 | 代码里**完全没有**自启实现：`grep setLoginItemSettings/getLoginItemSettings/openAtLogin/XDG autostart` 命中 0；文档也未承诺。→ 不是 Linux 缺口，是「任何平台都没有该功能」 | P3 澄清 |

---

## 7. 其它

### 7.1 release/ 与可复现性

- 仓库根**没有** `release/`（`ls` 失败），且 `release/`、`release-*/` 被 `.gitignore` 忽略 → AGENTS「Keep one accepted desktop release / 快捷方式指向 accepted build」在本机无对象可指；`verify:packaged` 的默认路径 `release/win-unpacked` 因此**永远失败**（已干跑验证）。
- `artifacts/` 中有 **73 个文件、375 处** `C:\Users\servi\...` 绝对路径（例：`artifacts/computer-use-browser-repair/deployment.json`、`artifacts/dependency-upgrade/latest-build.json`、`artifacts/magpie-desktop/results.json`）。这些是历史验收快照：不影响编译，但**不可在 Linux 复现/引用**；做跨平台验收复盘时应标注「Windows 历史证据」。
- 本机 live DB `~/.mybuddy/app.db` 中未检出 `C:\` 路径（`strings | grep` 0 处），说明当前数据是 Linux 原生生成，不存在「Windows 数据目录搬过来」的即时风险（与分支 `docs/omarchy-linux.md` 的警告一致）。

### 7.2 托盘/通知/自启/remote 的 Linux 实际行为小结

| 能力 | main 在 Linux 的实际行为 | 证据 |
|------|--------------------------|------|
| 托盘 | `new Tray()` 成功、SNI 项注册（Id `wavealstra_harness_status_icon_1`、ToolTip `MyBuddy`、自带 dbusmenu），但**无图标**；`click`/`right-click` 在 Chromium/SNI 下可能不触发（未验证）；关窗 → hide；`window-all-closed` 因 `shouldSuppressQuit()` 为 true 不退出 | `TrayService.ts:31-57,77-79`；`index.ts:637,3441-3443`；D-Bus Get/GetAll |
| 通知 | `Notification.isSupported()` 依赖 `org.freedesktop.Notifications`（本机存在）→ 预期可用；但 `icon` 传 `.ico`（`TrayService.ts:110`），libnotify 大概率丢弃；`displayBalloon` 是 Windows 专属回退（`:121,154`） | 代码 + `busctl` |
| 开机自启 | 无实现（任何平台） | `grep` 0 命中 |
| Remote 监听 | 默认 loopback `127.0.0.1`；`lan` 模式 `0.0.0.0`，且要求 HTTPS/受信局域网 HTTP（`RemoteAccessController.ts:77,80`）；无 Windows-only 代码，Linux 预期等价可用；但 `docs/android-remote-access.md:3,29` 全程以 Windows 为 host（含 Windows Firewall 说明） | 代码 + 文档 |
| 托盘的「关窗提示」 | Windows-only（`TrayService.ts:142`）；Linux 无提示 | 代码 |

### 7.3 electron-builder `afterPack` 校验在 Linux 上的意义

- 意义：**当前为零**（§4.6）。但 `verify-packaged-app.cjs` 的检查项（asar 索引 `unpacked:true` 条目都在 `app.asar.unpacked`、worker 能起、版本 pin 一致、原生模块解包）**内容本身平台无关**，且脚本已有跨平台的 `findNode()`。改造两处（可执行文件判定、默认目录）即可在 Linux 复用 → 这是打通 Linux 发布链路里**性价比最高**的一步。

---

## 8. 问题清单（按严重度）

> 约定：`已验证` = 本次实际读/跑/探测得到；`推测` = 只由代码与配置结构推断、未实跑。

| ID | 严重度 | 问题 | 已验证/推测 | 证据 | 建议 | 修复成本 |
|----|--------|------|-------------|------|------|----------|
| P1-1 | P1 | Linux 托盘图标为空，关窗后无可见恢复入口（进程仍驻留） | 已验证 | 运行实例 SNI 项 GetAll 无 `IconName/IconPixmap`；`TrayService.ts:6,32-33`；`icon.ts` 的 ico 在 Linux 不可解码 → `createEmpty()` | 移植分支 `trayIconAsset()`（Linux→`tray.png`，转 22px）；Linux `isEmpty()` 时走降级 + 通知 | S（~0.5 人日，含测试） |
| P1-2 | P1 | Linux safeStorage 落 `basic_text`，Slack/MCP 凭据弱加密且无告警 | 已验证（文档+环境）；后端值强推断 | `electron.d.ts` `getSelectedStorageBackend` 注释；`XDG_CURRENT_DESKTOP=Hyprland`；cmdline 无 `--password-store`；`SlackGatewayCredentials.ts:13,23`、`McpCredentialBackend.ts:14,18` | 移植 `linux-password-store.ts`（ready 前 appendSwitch，ready 后打印 backend，非 `gnome_libsecret` 时 warn/UI 提示）；同时保留 `isEncryptionAvailable` 检查 | S（~0.5 人日） |
| P1-3 | P1 | `afterPack` 门禁在 Linux/交叉构建被跳过，Linux 产物无 payload 校验 | 已验证 | `after-pack-windows.cjs:7`；`verify-packaged-app.cjs:112-114,249-254` | 拆出平台无关 `after-pack-payload.cjs`（校验逻辑复用现有模块）；Windows integrity 单独保留 | S（~0.5 人日） |
| P1-4 | P1 | Linux 包缺 keyring（及 onnx）原生模块；静态 import 使启动即崩风险高 | 配置已验证；崩溃推测 | `package.json:480-481,485,494-495`；keyring `index.js` 尾部 throw；`BuiltinCredentialStore.ts:1` → `AgentService.ts:9` | 加 `files`/`asarUnpack` 的 `keyring-linux-*`；onnx 保留 linux 或按目标平台裁剪；加一个 linux `--dir` 构建冒烟 | M（~1 人日，含实跑一次 pack） |
| P1-5 | P1 | CI pnpm 9 与 workspace overrides 不兼容；install 失败被 `continue-on-error` 掩盖 | 结构已验证；未实跑 | `verify.yml:20,27,34-36`；`pnpm-workspace.yaml:7`；`pnpm-lock.yaml` 顶部 `overrides:` | pin 与 lockfile 一致的 pnpm（并写 `packageManager`）；删 `continue-on-error`；`pnpm config set virtualStoreDirMaxLength`（Windows） | S（~0.3 人日） |
| P2-1 | P2 | `test:all` 排除表缺 `:desktop`；另有 9 个 GUI 用例未排除 → 无头/非 Windows 必红 | 已验证（枚举） | `test-all.mjs:45`；`test:consult-entry:desktop` 等；321 个 `test:*` | 改成 `/[-:]desktop$/`；对 `*-ui`、`test:tray` 增加显式排除或标 live | S（~0.2 人日） |
| P2-2 | P2 | `pnpm dist` 在 Linux 不可执行（交叉构建 + 无 wine + win32 原生重建） | 脚本/环境已验证；失败点推测 | `package.json:63`；无 wine；`NsisTarget.js:373-374` | 明确「Windows 产物只在 Windows/Windows CI 出」；Linux 侧只保留 `--dir` 自测 | S（文档/流程）～M（加 Windows CI 发布 job） |
| P2-3 | P2 | AGENTS.md Pi 版本 1.0.4 已过时（实际 1.3.0） | 已验证 | `AGENTS.md:6` vs `worker-launcher.mjs:11`、`package.json` 依赖、`test-baseline.json $basis` | 更新 AGENTS；给 `docs/pi104-*.md` 加「历史」标注 | XS（~10 分钟） |
| P2-4 | P2 | `~/.mybuddy`（数据根）与 Electron userData（`~/.config/wavealstra_harness` / 打包 `~/.config/MyBuddy`）不一致且未文档化；影响 Durable 锁/多实例语义 | dev userData 已验证；打包路径推测 | `AGENTS.md:12`；`paths.ts:13-17`；`DurableStorageLease.ts:10`；进程 argv | AGENTS 写明两个目录的职责；诊断脚本统一 | XS |
| P2-5 | P2 | Windows 发布流程（快捷方式、ICACLS、win-unpacked 验收）在本机无对应实现 | 已验证 | `AGENTS.md:18-20`；`scripts/repair-mybuddy-windows-shortcuts.cjs`；`dist --win` | 增加「Linux 本地验证清单」小节（dev + linux-unpacked + D-Bus 检查） | S（文档 + 少量脚本） |
| P2-6 | P2 | a1835bb 的 Windows 短路径 CI 修复未进 main | 提交证据；未在 Windows 复现 | 分支 `a1835bb`；`verify.yml` main 无 `C:\r` 步骤 | 只在 Windows CI 步骤移植（与 Linux 无关） | S |
| P3-1 | P3 | Linux 通知/窗口图标仍用 `.ico`（可能被 libnotify/窗口管理器丢弃） | 代码已验证；渲染效果推测 | `TrayService.ts:110`；`index.ts:12,475` | 随 P1-1 一起改 png | XS |
| P3-2 | P3 | `No autostart` 被误当成 Linux 缺口 | 已验证 | `grep` 0 命中 | 澄清为「未实现功能」，不要写成 Linux 回归 | — |
| P3-3 | P3 | artifacts 中 375 处 Windows 绝对路径，削弱可复现性 | 已验证 | `grep -ro 'C:\\Users\\servi' artifacts \| wc -l` = 375 / 73 文件 | 历史证据加「Windows-only」标注；新验收记录用相对路径 | XS |
| P3-4 | P3 | 文档版本/命令漂移（`docs/架构分析.md:38,375-376`；`verify.yml:4-5` 注释） | 已验证 | 同上 | 顺手更新 | XS |
| P3-5 | P3 | 分支整体 merge 会回退 main 新功能（magpie/ConnectorService/typecheck 棘轮等） | 已验证 | `git diff --stat main origin/branch`（−1245 行，含删除 `integrations/magpie-*`） | **禁止整体 merge**；只 cherry-pick/移植 §3 列出的最小文件集 | 决策成本 |

---

## 9. 建议的最小行动路径

1. **先补 Linux 正确性（不动打包）**：移植 `fea36a8` 的 `src/main/linux-password-store.ts`、`TrayService` 的 `trayIconAsset`/PNG/Linux 降级通知、`index.ts` 的 `app.png` 窗口图标、`tray-residency.ts`（P1-1、P1-2、P3-1）。跑一次 dev 后按分支 `docs/omarchy-linux.md` 的验收步骤看两条日志：`[safeStorage] linux backend=...`、`[Tray] ... (png)`。
2. **修 CI 可信度**：pnpm pin + 去掉 `continue-on-error` + `:desktop` 排除（P1-5、P2-1），再决定是否加 ubuntu job（先只跑 typecheck + 非 GUI 用例）。
3. **打通 Linux 打包验收**：`files/asarUnpack` 加 linux keyring（+ onnx 决策）；把 payload 校验拆成平台无关 hook；`verify:packaged` 支持「无扩展名可执行文件 + `--app-dir release/linux-unpacked`」（P1-3、P1-4）。
4. **文档对齐**：AGENTS.md 的 Pi 版本、双数据目录、Linux 发布替代流程、`docs/架构分析.md` 的 pack/dist 命令（P2-3、P2-4、P2-5、P3-4）。
5. **Windows 发布保持原样**；`dist --win` 只在 Windows 机器/CI 执行（P2-2）。

---

## 10. 附录：本次使用的关键只读命令

```bash
# 分支/差异
git log --oneline 4687852..main
git log --oneline $(git merge-base main origin/cursor/omarchy-linux-adapt-413c)..origin/cursor/omarchy-linux-adapt-413c
git diff --stat main origin/cursor/omarchy-linux-adapt-413c
git diff main origin/cursor/omarchy-linux-adapt-413c -- src/main/TrayService.ts src/main/index.ts package.json .github/workflows/verify.yml
git show fea36a8 --stat; git show 81b96ef; git show a1835bb; git show 70e1028

# 运行时/环境
ps -eo pid,etime,cmd | grep -i electron
tr '\0' ' ' < /proc/224446/cmdline
echo $XDG_CURRENT_DESKTOP $WAYLAND_DISPLAY
busctl --user list | grep -iE "StatusNotifier|Notifications"
gdbus call --session --dest org.freedesktop.StatusNotifierItem-224446-1 \
  --object-path /StatusNotifierItem \
  --method org.freedesktop.DBus.Properties.GetAll org.kde.StatusNotifierItem
gdbus call --session --dest :1.27 --object-path /org/ayatana/NotificationItem/FlClash \
  --method org.freedesktop.DBus.Properties.GetAll org.kde.StatusNotifierItem   # 对照组
which wine wine64; pnpm -v; node -v

# 打包链路（干跑，未构建）
pnpm -s verify:packaged
pnpm -s validate:packaged-image-resize
grep -n "files\|keyring\|onnxruntime\|afterPack\|linux" package.json
grep -n "desktop\$\|names = " scripts/test-all.mjs

# 门禁健康（只读）
pnpm -s typecheck
pnpm -s test:harness-quality

# 可复现性
grep -ro 'C:\\Users\\servi' artifacts | wc -l
grep -rl 'C:\\Users\\servi' artifacts | wc -l
```

---

## 11. 实施记录（task-5，2026-10-26 晚，实施阶段）

> 本节记录审计结论落地为代码后的状态；审计结论本身（§0-§10）保留为当时的快照。

### 11.1 已实施（§5 第 1–2 项 + 第 3 项 CI）

| 项 | 改动 | 说明 |
|---|---|---|
| Linux 密码库 | 新增 `src/main/linux-password-store.ts`（从分支 `fea36a8` 移植）；`src/main/index.ts` 作为**第一条 import** 引入 | Linux ready 前 `appendSwitch("password-store", "gnome-libsecret")`；ready 后打印 `[safeStorage] linux backend=… available=…`，非 `gnome_libsecret` 时 `console.warn`；提供纯函数 `installLinuxPasswordStore` / `describeLinuxSecretStore` 供测试 |
| Linux 托盘 | `src/main/TrayService.ts`（分支版移植 + 手工核对 main 无漂移）：`trayIconAsset()` Linux→`tray.png`、缩放到 22px、PNG 解码失败即抛错进入 degraded；Linux 关窗提示改用 `Notification`；新增 `hasTray()` | 已用真实 Electron 测试验证：`[Tray] 系统托盘已初始化 (png)`，16/16 通过 |
| 关窗驻留 | 新增 `src/main/tray-residency.ts`（纯函数） | Windows：托盘存活才驻留；Linux：托盘创建失败仍驻留（避免误杀提醒/cron/Gateway），再次启动命中单实例锁恢复窗口 |
| 窗口图标 | `src/main/index.ts` Linux 用 `app.png`，Windows 保持 `app.ico` | 同 `fea36a8` |
| payload 门禁 | `scripts/after-pack-windows.cjs` → **`scripts/after-pack.cjs`**（平台无关）；`package.json` 的 `build.afterPack` 同步 | payload 校验所有平台都跑；`icacls` 仅 Windows 宿主 + win32 目标 |
| Linux 验收 | `scripts/verify-packaged-app.cjs` 支持 `linux-unpacked`/无扩展名主程序（排除 `chrome-sandbox`/`chrome_crashpad_handler`/`*.so`）、默认目录取 `release/` 下最新 `win-*`/`linux-*`；Linux 包额外要求解包 `@napi-rs/keyring-linux-x64-gnu`（否则主进程静态 import 会 `Cannot find native binding`） | 已在构造的 `linux-unpacked` 夹具上验证 PASS（worker 1.3.0），并验证 3 个负例（缺 keyring/缺主程序/缺原生模块 → FAIL） |
| Linux 原生模块 | `build.files`/`build.asarUnpack` 增加 `@napi-rs/keyring-linux-x64-gnu` | §4.3 的 P1 缺口 |
| Linux 构建配置 | `build.linux`（icon `build/icon.png`、category Utility、`executableName: mybuddy`、target `dir` x64）；`pack:linux`/`pack:win`、`dist:linux`/`dist:win`（`dist` 保持 `--win` 不变） | Linux 产物 = `release/linux-unpacked` 目录包，暂不产出 AppImage/deb |
| 测试 | 新增 `scripts/linux-password-store-test.ts`、`scripts/tray-residency-test.ts`、`scripts/linux-password-store-electron-stub.ts`；`scripts/build-tray-test.mjs` 改为解析真实 `?asset` 路径；`scripts/tray-service-test.cjs` 增加 Linux PNG/降级用例；`package.json` 接线 `test:linux-session` | `test:linux-session` 已进 default 套件 |
| CI | `.github/workflows/verify.yml`：pnpm 统一 `12.14.0`（新增 `packageManager: pnpm@12.14.0`）；去掉 install 的 `continue-on-error`；Windows job 移植 `C:\r` 短路径；新增 `verify-linux`（ubuntu-latest，xvfb + Electron 运行库，`xvfb-run -a pnpm -s test:all`） | Linux job 是「按现状跑通」；若个别 GUI 用例在 xvfb 下失败应挪 live job，不改 `test:all` |
| 文档 | 新增 `docs/omarchy-linux.md`（从分支移植并校正：当前 main 已内置、pnpm 12/CI 两条 job、pack/verify 命令、已知缺口） | 分支文档里「build.linux 只是草稿」等过时说法已替换 |

### 11.2 实际跑过的验证

| 命令 | 结果 |
|---|---|
| `pnpm -s typecheck` | exit 0（scripts 209 基线错误、新增 0） |
| `pnpm -s test:linux-session` | exit 0（`linux-password-store: ok`、`tray-residency: ok`） |
| `env -u ELECTRON_RUN_AS_NODE pnpm -s test:tray` | exit 0，**16/16 passed**，日志 `[Tray] 系统托盘已初始化 (png)` |
| `pnpm -s build`（electron-vite） | exit 0，28s；`out/main/index.js` 含 `gnome-libsecret`/`password-store`，`out/main/chunks/app-8aZtaoV3.png`（tray.png/app.png 同内容去重） |
| `pnpm -s test:harness-quality` | PASS |
| `node scripts/verify-packaged-app.cjs --app-dir <构造的 linux-unpacked>` | PASS（platform=linux、executable=mybuddy、worker=1.3.0）；3 个负例按预期 FAIL |
| `node -e "require('./scripts/after-pack.cjs')(…)`（linux 目标） | PASS 后正确跳过 icacls（输出 `payload gate passed for linux … Windows integrity labelling skipped`） |
| `pnpm -s verify:packaged`（无 release/） | 失败信息现在指向 `release/linux-unpacked`（Linux 宿主默认） |
| workflow YAML | PyYAML 解析通过：`verify-windows`(9 steps) + `verify-linux`(9 steps) |

### 11.3 未完成 / 新发现的风险

1. **未实跑 Linux 打包**（`pnpm -s pack:linux` 会跑 `electron-builder`，远超单命令 5 分钟预算且会写 `release/`）：`build.linux` 的 ico→png 图标解析、linux 原生 rebuild 只在 CI 首跑时才能真正确认。payload 门禁本身已在构造夹具上验证。
2. **`pnpm-lock.yaml` 被 pnpm 自动追加了 158 行**（`packageManagerDependencies: pnpm 12.14.0`），这是设置 `packageManager` 后 pnpm 自我管理版本的元数据（纯新增、不改已有条目）。为满足 Lead 的「packageManager 与 lockfile 一致 + frozen install」要求而保留；若团队不接受改 lockfile，替代方案是删掉 `packageManager` 字段并在 workflow 里显式 pin 版本。
3. **`.github/workflows/verify.yml` 的 Linux job 是新增门禁**：`ELECTRON_DISABLE_SANDBOX=1` 是否被 Electron 44 采纳、xvfb 下 GUI 用例是否全绿，未在本机 CI 复现（本机是有 Hyprland 的真桌面，不是 xvfb）。已知 default 套件混入的真 Electron 用例（见 §4/§6）是最大风险点。
4. `scripts/after-pack.cjs` 的 `verifyPackagedApp` 现在会要求 win32 包里有 `@napi-rs/keyring-win32-x64-msvc` 解包目录；若既有 Windows 包构建里该目录走的是 asar 内路径而非 unpacked，门禁会在首次 Windows 构建时报错——需要 Windows 机器上跑一次 `pnpm -s dist` 确认（本机无法验证）。
5. `dev` 实例未做热重启验证：运行中的实例（PID 224446）在本次改动后仍未重建 `out/main`（21:12 之后无写入），因此**没有**用运行实例的 D-Bus 复验新托盘图标；托盘修复由 `test:tray` 的真实 Electron 进程验证（PNG 托盘创建成功）。应用重启后应能在 quickshell 状态栏看到图标。

---

## 12. 实施记录：平台拆分 A —— Computer Use 边界（task-12，2026-10-27）

> 目标：把 Windows 专属常量/路径/判断从 Computer Use 业务服务剥离；只做平台边界与能力探测，不实现 Linux 后端。

### 12.1 新增/修改

| 文件 | 内容 |
|---|---|
| `src/main/platform/computer-use.ts`（新） | `ComputerUseSupport`（platform/backend/supported/missingDependencies/installHint/reason）、`detectComputerUseSupport(platform, {pathValue,refresh})`（按平台缓存）、`probeLinuxComputerUseTools()`（纯 PATH 扫描 `hyprctl/grim/slurp/tesseract/wtype/ydotool`，不 spawn）、`executableInPath()`、`supportsComputerUseOverlay()`（仅 Windows）、`computerUseUnsupportedMessage()`。Windows→`windows-uia/supported`；Linux→`linux-wayland/unsupported` + pacman 安装提示（已装的不列）；macOS→`unsupported`。 |
| `src/main/platform/computer-use/ocr.ts`（新） | OCR 候选/provider 从服务搬出：`ocrInstallCandidates()`（**不再含 `C:\Users\servi\...`**，只用 `LOCALAPPDATA`/`ProgramFiles` 标准位置 + 仓库相对路径）、`resolveOcrCli()`（`MYBUDDY_OCR_CLI` 优先）、`windowsOcrScriptPath()`（packaged resources → 仓库 scripts → cwd）、`resolveOcrProvider()`（语义不变）、`ocrSearchCandidates()`；另导出 Linux tesseract 描述 `describeLinuxOcrProvider()`（命令/语言参数/安装提示），不执行。 |
| `src/main/capabilities/ComputerAutomationService.ts` | `available` 改用 `detectComputerUseSupport().supported`；`status` 返回 `platform/backend/supported/missingDependencies/installHint/reason`（原有 `action/detail/hostPid` 兼容）；非 Windows `execute` 抛带安装提示的可诊断错误（不再写「仅支持 Windows」）；OCR 候选/错误清单改从 platform 模块取；文件从 1401→1388 行。 |
| `src/main/capabilities/ComputerUseOverlayService.ts` | `electronAvailable()` → `overlaySupported()`（= Electron 运行时 && `supportsComputerUseOverlay()`），并新增 `get isSupported()`；行为等价（Windows 才启用）。 |
| `scripts/platform-computer-use-test.ts`（新，207 行） | 注入 platform/PATH 的 12 项断言：Linux unsupported+PATH 一致性+pacman 提示+缓存、Windows supported、macOS unsupported、overlay 仅 Windows、OCR 候选无个人路径、`MYBUDDY_OCR_CLI` 优先、Linux tesseract 描述。 |

### 12.2 验证（2026-10-27）

```bash
pnpm -s typecheck                                                        # exit 0
./node_modules/.bin/esbuild scripts/platform-computer-use-test.ts --bundle --platform=node \
  --format=cjs --outfile=out/tests/platform-computer-use-test.cjs --external:electron \
  && node scripts/test-guard.mjs out/tests/platform-computer-use-test.cjs # 12 checks passed
pnpm -s test:harness-quality                                             # PASS
pnpm -s test:artifact-gate                                               # 32/32 PASS
pnpm -s test:architecture-graph                                          # PASS 5/5
pnpm -s test:architecture                                                # passed=323 failed=0
pnpm -s test:computer-automation / test:computer-use-run                 # 在 Linux 上失败（既有行为：这两个用例被 test-all 归为 GUI/Windows，仅在 verify-windows-gui 跑）
```

### 12.3 建议的 package.json 接线（本次不改 package.json）

```json
"test:platform-computer-use": "esbuild scripts/platform-computer-use-test.ts --bundle --platform=node --format=cjs --outfile=out/tests/platform-computer-use-test.cjs --external:electron && node scripts/test-guard.mjs out/tests/platform-computer-use-test.cjs"
```

`test:all` 的分类按显式名单 + 兜底正则（`GUI_PATTERNS = [/-e2e$/, /-desktop$/, /-electron$/, /:desktop$/, /^test:computer-/]`）；`test:platform-computer-use` 不命中任何一条，接线后会自动落进 headless default 套件，无需改 `test-all.mjs`。
