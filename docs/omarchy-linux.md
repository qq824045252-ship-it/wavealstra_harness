# Omarchy / Linux 开发、验收与打包

同一套仓库在 Omarchy（Arch + Hyprland / Wayland + Quickshell）上的跑法。**main 已内置 Linux 适配**（托盘 PNG、`--password-store=gnome-libsecret`、关窗驻留降级、窗口 PNG 图标），不再需要检出 `cursor/omarchy-linux-adapt-*` 分支。Windows 的托盘、关窗与 NSIS 打包行为保持原样。

本页覆盖本机开发 + Linux 打包/验收。不含 Windows Computer Use 移植、独立 daemon，也不是 AUR 发布流程。

## 数据目录：两个，别混

| 目录 | 内容 | 谁管理 |
|---|---|---|
| `~/.mybuddy/` | `app.db`（任务/记忆）、`auth.json`、`models.json`、`plugins/`、`backups/`、`runtimes/` | 应用自己（`src/main/paths.ts`） |
| `~/.config/<app name>/` | Chromium 状态：Cache、Cookies、Crashpad、Local Storage | Electron `userData`（dev 为 `~/.config/wavealstra_harness`，打包版为 `~/.config/MyBuddy`） |

- **不要**把 Windows 的 `%USERPROFILE%\.mybuddy` 拷到 Linux 的 `~/.mybuddy`：那边的 safeStorage 密文绑的是 Windows 凭据库，换到 gnome-libsecret 解不开；库里还有 Windows 绝对路径。让应用自己生成新的 `~/.mybuddy`，再在设置里重新填写模型、API key、Slack 与 MCP。
- 排查数据问题时 `~/.mybuddy/app.db` 用只读模式打开；`~/.config/...` 里的 Cache 不属于用户数据。

## 日志与崩溃转储（崩溃可观测性）

主进程会在 ready 前装配日志与 crashReporter，证据都落在 `~/.mybuddy/`（不在 Chromium userData）：

| 目录/文件 | 内容 | 轮转 |
|---|---|---|
| `~/.mybuddy/logs/main-YYYYMMDD.log` | 主进程运行日志，行格式 `YYYY-MM-DD HH:mm:ss.SSS LEVEL [scope] message`；`uncaughtException` / `unhandledRejection` 附完整栈 + pid/Electron/Node 版本；`render-process-gone` / `child-process-gone` 附 reason/exitCode/进程类型 | 按天 + 单文件 4 MB 上限（超限改名为 `main-YYYYMMDD-N.log`）；保留最近 7 份 |
| `~/.mybuddy/crashdumps/` | Electron `crashReporter` 的本地 crashpad dump（`pending/`、`completed/`、`attachments/`），`uploadToServer:false`，不会发起上传请求 | 由 crashpad 管理，无自动清理 |

- 启动日志会打印 `crashReporter started …；本地 dump 目录：…`；只有 warn（目录不可写 / crashpad 启动失败）时不影响应用运行。
- 主进程 console 输出保持原样；关键错误额外双写到文件，便于打包版/无终端场景回溯（Windows 打包版没有 stderr）。
- 用户可见提示：渲染进程或 GPU/Utility 子进程异常退出会发 `runtime.failed` 通知，同一 `kind/reason/exitCode` 5 分钟内只提示一次；界面进程崩溃仍自动重载（最多 3 次），连续崩溃则停止重载并写日志。
- 原生 SIGILL/段错误这类 core dump 不在 crashpad 里，由 systemd 收集：`coredumpctl list | tail`、`coredumpctl info <pid>`；本机 2026-10-26 的四次 SIGILL 分析见 `artifacts/audit-2026-10-26/crash-sigill.md`。
- 快速确认日志层在工作：`ls -la ~/.mybuddy/logs/ ~/.mybuddy/crashdumps/ 2>/dev/null`，然后 `pnpm dev`，出现 `main-$(date +%Y%m%d).log` 且首行是 `INFO [crash] crashReporter started…` / `INFO [main]` 即正常。

## 系统依赖

```bash
sudo pacman -S --needed base-devel git python nodejs pnpm \
  gnome-keyring libsecret libayatana-appindicator
```

- `base-devel`/`python`：`pnpm install` 本地编译 `better-sqlite3` / `node-pty` 需要。
- `gnome-keyring` + `libsecret`：Electron `safeStorage` 的 `gnome-libsecret` 后端。
- `libayatana-appindicator`：Wayland 状态栏托盘（Quickshell 的 StatusNotifier）。
- Node ≥ 24（本机 26.x）；pnpm 用 `package.json` 的 `packageManager`（12.14.0）。pip/uv 由应用自己的受管 Python 运行时处理，不要求系统 pip。

**Computer Use（Linux）**：`computer_exec` 的后端是 [computer-use-linux](https://github.com/agent-sh/computer-use-linux)（npm `@agent-sh/computer-use-linux`，在 `optionalDependencies` 里，只对 `linux` 生效）。原生二进制由它的 postinstall 解包到 `node_modules/@agent-sh/computer-use-linux/npm/bin/`，不需要额外 npm 包。系统侧还需要它调用的工具：

```bash
sudo pacman -S --needed grim slurp wtype ydotool \
  tesseract tesseract-data-chi_sim at-spi2-core python-gobject
```

- `wtype`：键盘输入（CUL 的 `type_text`/`press_key` 走它）。
- `ydotool` + `ydotoold`：指针/滚轮**以及按住/释放分离与长按**。需要 `/dev/uinput` 可写（`input` 组或 udev 规则），daemon 要在跑：`systemctl --user enable --now ydotool`（或 `ydotoold` 手动起，socket 默认 `/run/user/$UID/.ydotool_socket`）。
  **排障**：若 `systemctl --user status ydotool` 显示 `start-limit-hit`，socket 文件会残留而 daemon 已死，
  ydotool 报 `failed to connect socket ... Connection refused`（与「没装」极易混淆，后端会单独识别并给出恢复命令）。
  恢复：`rm -f /run/user/$(id -u)/.ydotool_socket && systemctl --user reset-failed ydotool && systemctl --user restart ydotool`。
  `mouse_down_client`/`mouse_up_client`/`key_down`/`key_up`/`click_client` 的 `hold_ms`/`drag_client` 的 `steps`+`duration_ms` 都依赖它；缺 `ydotool` 时这些动作报 `HOST_UNAVAILABLE` 并给出 pacman 安装提示（不会静默降级）。
- `wl-clipboard`（`wl-copy`/`wl-paste`）：`paste_text` 写剪贴板 + Ctrl+V；缺失时回落逐字 `wtype`，速度慢很多。
- `tesseract` + `tesseract-data-chi_sim`：`ocr_window` 的本地 OCR（不联网）；缺 `chi_sim` 时中文识别为空。
- `at-spi2-core` + `python-gobject`：CUL 的 AT-SPI 语义树（`inspect_controls`/`find_control`）。
- 截图走 `xdg-desktop-portal-hyprland`（Omarchy 已装），**首次截图会弹一次授权框**，允许后长期有效。

自检：`node_modules/@agent-sh/computer-use-linux/npm/bin/computer-use-linux-linux-x64 doctor` 会打印 `preferred`/`capabilities`/缺依赖项。应用内对应 `computer_exec({action:"status"})` 的 `missingDependencies`。

## 安装并启动

```bash
pnpm install
pnpm dev
```

`pnpm dev` 走 electron-vite，直接用本机 `node_modules`。启动日志应出现：

```text
[safeStorage] linux backend=gnome_libsecret available=true
[Tray] 系统托盘已初始化 (png)
```

- `backend=basic_text`（或 `available=false`）：Chromium 没把 Hyprland 认成 GNOME，主进程会在 ready 前自动加 `--password-store=gnome-libsecret`；若后端仍是 `basic_text`，说明密钥环没起来/没解锁。Chromium 的 `basic_text` 用硬编码口令「加密」，Slack/MCP/API 凭据会静默变成弱加密。修法：
  ```bash
  eval "$(gnome-keyring-daemon --start --components=secrets)"
  ps -C gnome-keyring-daemon -o pid,cmd
  ```
  必要时把上一行放进 Hyprland 的 `exec-once`，然后重启应用。
- `[Tray] 创建系统托盘失败`：没有 StatusNotifier 宿主（未装 libayatana-appindicator 或 Quickshell 没开托盘）。此时 Linux 仍会驻留（提醒/cron/Gateway 不停），但没有图标，**首次关窗会弹一次桌面通知**说明如何恢复（再次启动命中单实例锁）。

## 在 Omarchy 上怎么验

1. **凭据**：看上面的 safeStorage 日志；在设置里保存一条 API key、一条 MCP 凭据、一条 Slack 私聊 Token（设置 → 助理设置 → Slack 私聊）。失败文案「系统凭据加密不可用」= 密钥环没接上。
2. **托盘关窗**：Quickshell 状态栏出现 MyBuddy 图标；关掉主窗口后进程还在（`pgrep -af electron`）；点托盘图标恢复；托盘菜单「退出」才停进程。
3. **托盘失败降级**：日志是「创建系统托盘失败」而不是「系统托盘已初始化」时，关窗后进程仍驻留；再执行一次 `pnpm dev`（或再次启动）会命中单实例锁并恢复窗口。这是降级，不是崩溃。
4. **cron**：设一个 1–2 分钟后触发的定时任务，关窗等待，主进程不应退出，到点通知/任务仍发生；托盘「退出」后才停。
5. **Slack**：连上私聊后关窗，从 Slack 发一条私聊，Gateway 应继续收消息；托盘「退出」后链路才断。
6. **托盘与密码库的自动测试**（不需要真实窗口）：
   ```bash
   pnpm -s test:linux-session   # linux-password-store 开关/后端判定 + tray-residency 纯逻辑
   env -u ELECTRON_RUN_AS_NODE pnpm -s test:tray   # 真实 Electron Tray（会临时拉起一个 Electron 进程）
   ```
7. **Computer Use**：`computer_exec({action:"status"})` 应报 `supported:true`、`missingDependencies:[]`；再按 `list_windows` → `screenshot_window` → `ocr_window` → `click_client` 的顺序手动走一遍。截图/点击会真实动鼠标，验证前把目标窗口摆好。
   真机自动冒烟（不需要常驻前台窗口，只读步骤即可自证 CUL/portal/AT-SPI 链路）：
   ```bash
   pnpm -s test:computer-use-linux                 # 只读：status / doctor / list_windows / 语义树翻页 / 截图
   node out/tests/computer-use-linux-smoke.cjs --allow-input   # 追加 ydotool 按住→hyprctl 验证→释放 / 一次性靶窗的 move_window+resize_window / paste_text
   ```
   注意它必须跑在**真实 Hyprland 会话**里（`GUARD_HOME=host` 已写进脚本）：隔离 `XDG_CONFIG_HOME` 会把
   `org.gnome.desktop.interface toolkit-accessibility` 变成 `false`，GTK 就不再启 atk-bridge，AT-SPI 会一颗节点都拿不到。
   语义树排查：CUL 报 `accessibility_tree_truncated:false` 不代表树完整（它把内联压到 ~37 个），
   真总数在 `accessibility_tree_spill.node_count`；后端据此自动翻页，`inspect_controls` 的 `accessibilityPages`
   给出实际页数。Electron 应用需要 `--force-renderer-accessibility` 才暴露 renderer 内容。
8. **GUI 套件（本机全量，需要真实桌面会话）**：不要用 xvfb 代替，否则会掩盖 Wayland/托盘/截图类问题。
   ```bash
   pnpm -s build                                   # consult-entry / startup perf 需要 out/main/index.js
   node scripts/test-all.mjs --include-gui         # default + GUI 类（并行池 + 串行性能池）
   node scripts/test-all.mjs --list                # 看分类与选中数量（headless/GUI/NETWORK/DATASET/pending）
   node scripts/test-all.mjs --audit                # 分类自检：GUI 清单 vs 命令里真的启动 electron
   ```
   单条 GUI 用例仍按老办法跑：`env -u ELECTRON_RUN_AS_NODE pnpm -s test:<name>`。
9. **停止/重启 dev 实例必须优雅**：只对 Electron **主进程**发 `SIGTERM`，等它自己关闭 GPU/renderer/utility，再停 dev server。不要 `pkill -f electron` 同时杀所有子进程——主进程会把 GPU 的死亡当成崩溃并尝试 relaunch，退出期连续 5 次 `launch-failed` 后 Chromium 会主动 `ud2`（SIGILL + core dump，见 `artifacts/audit-2026-10-26/crash-sigill.md` §9）。`.tools/mybuddy.sh stop` 已按此实现；正常托盘「退出」不受影响。
   `test:consult-entry:desktop` 默认用空夹具（不读真实 `~/.mybuddy`）并明确 SKIP；想用本机「已保存的多模型会诊配置」跑深层流程时显式 opt-in：`CONSULT_ENTRY_SEED_USER_PROFILE=1 env -u ELECTRON_RUN_AS_NODE pnpm -s test:consult-entry:desktop`。

## Linux 打包与验收

```bash
pnpm -s pack:linux     # remote:build + electron-vite build + electron-builder --linux --dir
pnpm -s verify:packaged -- --app-dir release/linux-unpacked
```

- `pack:linux` 产出 `release/linux-unpacked/mybuddy`（`build.linux`：icon `build/icon.png`、category Utility、`executableName: mybuddy`、target `dir` x64）。
- `afterPack` 现在是平台无关的 **payload 门禁**：校验 asar 索引里所有 `unpacked:true` 的条目都在 `app.asar.unpacked` 里存在，并实际启动 `node worker-launcher.mjs <pi-runtime.mjs> --version`（版本必须等于 `EXPECTED_PI_VERSION` = 1.3.0）。Linux 额外要求 `node_modules/@napi-rs/keyring-linux-x64-gnu` 解包存在——缺它主进程 `require("@napi-rs/keyring")` 会抛 `Cannot find native binding`。Windows 宿主上还会做 `icacls` 完整性级别（仅 win32）。
- `verify:packaged` 支持 `win-unpacked` 与 `linux-unpacked`：Linux 主程序是无扩展名的 `mybuddy`（自动排除 `chrome-sandbox`/`chrome_crashpad_handler`/`*.so`）；不传 `--app-dir` 时取 `release/` 下最新的 `win-*`/`linux-*` 目录。
- `dist`/`dist:win` = Windows NSIS（AGENTS 的发布流程保持不变，**只能在 Windows 或装好 wine 的机器上跑**）；`dist:linux` = 当前 `build.linux` 定义的 `dir` 目录包（还不是 AppImage/deb）。
- 从 Linux **交叉构建 Windows** 不受支持：`electron-builder --win` 需要 wine + 为 win32 重建原生模块（better-sqlite3/node-pty）。Windows 产物请在 Windows 机器/CI 出。
- 已知缺口：`build.files` 仍排除 `onnxruntime-node` 的 linux 二进制，Linux 包内语义检索/embedding 不可用（记忆语义检索会降级）；补它需要按包体积单独评估。

## CI

`.github/workflows/verify.yml` 现在有三条 job，GUI 与 default 分层：

- `verify-windows`（`windows-latest`，push/PR/手动 `suite=default`）：pnpm 12.14.0 + 短路径原生编译 + typecheck / harness-quality / artifact-gate / `pnpm -s test:all`（headless default 套件）。
- `verify-linux`（`ubuntu-latest`，push/PR/手动 `suite=default`）：装 xvfb/Electron 运行库，`xvfb-run -a pnpm -s test:all`，同样跑 typecheck / harness-quality / artifact-gate。`ELECTRON_DISABLE_SANDBOX=1` 只作用于 CI 容器；不代表 Linux 桌面要以该参数运行。
- `verify-windows-gui`（`windows-latest`，每晚 18:00 UTC / 手动 `suite=gui` 或 `all`）：`pnpm -s build` 后跑 `node scripts/test-all.mjs --include-gui`（default + GUI 类）。**不加 `continue-on-error`**：GUI 用例腐烂必须可见。

default 套件已不含真 GUI 用例：`scripts/test-all.mjs` 把 `test:*` 显式分为 headless / GUI / NETWORK / DATASET（+ 临时 pending 桶），`node scripts/test-all.mjs --list` 可查分类与选中数量，`--audit` 做分类自检。GUI 用例（`test:tray`、`test:*:ui`、`test:consult-entry:desktop`、`test:*-e2e` 等）只在 GUI job 与本机手动跑；`test:workspace-files-ui` 目前 headless 但有 1 条既有红，先留在 pending 桶（只有 `--include-live` 会跑到），修好后应移回 default。

> GUI job 在 GitHub 托管 runner 上的稳定性尚未在本仓库实测（托管 Windows runner 是否支持 Tray/桌面自动化取决于 runner 会话）；如果 nightly 因环境（而不是代码）长期红，正确做法是给 GUI job 换自托管 runner，而不是把它挪回无头门禁或加 `continue-on-error`。

## 与 Windows 发布流程的关系

AGENTS.md 的发布流程（Windows 分发、桌面/开始菜单快捷方式、`verify:packaged --app-dir <win-unpacked>`）保持不变，适用于 Windows 机器；Linux 机器上的等价校验是 `pack:linux` + `verify:packaged --app-dir release/linux-unpacked`。两者共用同一个 payload 门禁。
