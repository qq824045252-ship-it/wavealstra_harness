# Omarchy / Linux 开发跑法

同一套仓库，用平台分支跑在 Omarchy（Arch + Hyprland / Wayland + Quickshell）上。不要另起仓库或长期 fork。Windows 的打包、托盘和关窗行为保持原样。

本页只覆盖本机开发。不包含 Windows Computer Use 移植、独立 daemon，也不是 AUR 发布流程。

## 拉代码

合并前，检出本分支：

```bash
git fetch origin cursor/omarchy-linux-adapt-413c
git checkout cursor/omarchy-linux-adapt-413c
```

合并进 `main` 之后：

```bash
git checkout main
git pull origin main
```

## 不要拷 Windows 数据目录

不要把 Windows 的 `%USERPROFILE%\.mybuddy` 拷到 Linux 的 `~/.mybuddy`。

那边的 safeStorage 密文绑的是 Windows 凭据库，换到 gnome-libsecret 解不开。库里还有 Windows 绝对路径。在 Omarchy 上让应用自己生成新的 `~/.mybuddy`，再在设置里重新填写模型、API key、Slack 和 MCP。

## 系统依赖

```bash
sudo pacman -S --needed base-devel git python nodejs pnpm \
  gnome-keyring libsecret libayatana-appindicator
```

`base-devel` 和 `python` 给 `pnpm install` 里的 `better-sqlite3` / `node-pty` 本地编译用。`gnome-keyring` + `libsecret` 给 Electron safeStorage。`libayatana-appindicator` 给 Wayland 状态栏托盘（Quickshell 的 StatusNotifier）。

Node 按 `docs/架构分析.md` 用 24 或以上。包管理用 pnpm（本仓库 lockfile 是 pnpm）。

Hyprland 不会被 Chromium 当成 GNOME。主进程启动时会自行加上 `--password-store=gnome-libsecret`，不需要再手动传这个参数。密钥环本身要在当前会话里解锁，否则开关加上了也存不了凭据。Omarchy 若还没拉起密钥环，在登录会话里执行一次：

```bash
eval "$(gnome-keyring-daemon --start --components=secrets)"
```

需要的话把同一行放进 Hyprland 的 `exec-once`。确认守护进程在：

```bash
ps -C gnome-keyring-daemon -o pid,cmd
```

## 安装并启动

在仓库根目录：

```bash
pnpm install
pnpm dev
```

`pnpm dev` 走 electron-vite，直接用本机 `node_modules`。`package.json` 里 `files` 对 `onnxruntime-node` 的 linux/darwin 排除只影响 Windows 安装包体积，不会拿掉开发时已经装好的 Linux 原生模块。`build.linux` 目前只是 `dir` 草稿（图标、类别、x64 目录包），`pnpm dist` 仍是 Windows NSIS。Linux 上的 `@napi-rs/keyring-linux-x64-gnu` 已放进 `files` / `asarUnpack`，避免以后在 Linux 上打目录包时把 keyring 原生模块漏掉。

启动日志里应看到：

```text
[safeStorage] linux backend=gnome_libsecret available=true
[Tray] 系统托盘已初始化 (png)
```

`available=false` 或后端不是 `gnome_libsecret` 时，Slack、API、MCP 凭据会拒绝保存。先修密钥环，再重启应用。

## 在 Omarchy 上怎么验

1. 凭据。看上面的 safeStorage 日志。然后在设置里保存一条 API key、一条 MCP 凭据，以及 Slack 私聊的 App Token / Bot Token（入口：设置 → 助理设置 → Slack 私聊）。保存成功即可；失败文案是「系统凭据加密不可用」时，密钥环没接上。
2. 托盘关窗。Quickshell 状态栏应出现 MyBuddy 图标。关掉主窗口后进程还在（`pgrep -af mybuddy` 或 `pgrep -af electron`）。点击托盘图标，窗口回来。菜单里的「退出」才会停掉进程。
3. 托盘失败时的降级。若日志是「创建系统托盘失败」而不是「系统托盘已初始化」，关窗后进程仍应驻留，提醒、cron、Slack Gateway 不停。此时没有图标，再执行一次 `pnpm dev`（或再次启动）会命中单实例锁并恢复窗口。这是降级，不是崩溃。常见原因是没装 `libayatana-appindicator`，或 Quickshell 没开系统托盘。
4. cron。在应用里设一个一两分钟后触发的定时任务，关掉窗口，等它到点。主进程日志里不应出现退出；到点后通知或任务仍应发生。用托盘「退出」之后，cron 才会停。
5. Slack。按第 1 步连上私聊并确认日志里没有凭据加密错误。关掉窗口，从 Slack 给机器人发一条私聊。Gateway 应继续接消息（主进程里会有 Gateway / Slack 日志，应用里出现对应任务）。托盘「退出」后，这条链路才会断。
