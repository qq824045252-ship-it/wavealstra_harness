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

## 系统依赖

```bash
sudo pacman -S --needed base-devel git python nodejs pnpm \
  gnome-keyring libsecret libayatana-appindicator
```

- `base-devel`/`python`：`pnpm install` 本地编译 `better-sqlite3` / `node-pty` 需要。
- `gnome-keyring` + `libsecret`：Electron `safeStorage` 的 `gnome-libsecret` 后端。
- `libayatana-appindicator`：Wayland 状态栏托盘（Quickshell 的 StatusNotifier）。
- Node ≥ 24（本机 26.x）；pnpm 用 `package.json` 的 `packageManager`（12.14.0）。pip/uv 由应用自己的受管 Python 运行时处理，不要求系统 pip。

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

`.github/workflows/verify.yml` 有两条 job：

- `verify-windows`（`windows-latest`）：pnpm 12.14.0 + 短路径原生编译 + typecheck / harness-quality / artifact-gate / `test:all`。
- `verify-linux`（`ubuntu-latest`）：装 xvfb/Electron 运行库，`xvfb-run -a pnpm -s test:all`，同样跑 typecheck / harness-quality / artifact-gate。`ELECTRON_DISABLE_SANDBOX=1` 只作用于 CI 容器；不代表 Linux 桌面要以该参数运行。

由于 default 套件里仍有真 Electron 用例（`test:tray`、`test:*:ui`、`test:consult-entry:desktop` 等），Linux 无头 job 是「按现状跑通」；若某条用例在 xvfb 下必然失败，应挪到 live job，而不是削弱 `test:all`。

## 与 Windows 发布流程的关系

AGENTS.md 的发布流程（Windows 分发、桌面/开始菜单快捷方式、`verify:packaged --app-dir <win-unpacked>`）保持不变，适用于 Windows 机器；Linux 机器上的等价校验是 `pack:linux` + `verify:packaged --app-dir release/linux-unpacked`。两者共用同一个 payload 门禁。
