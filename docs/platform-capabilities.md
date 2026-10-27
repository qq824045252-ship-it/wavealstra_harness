# 平台能力边界（Windows / Linux / macOS）

本文件说明「Windows 独有能力」与「Omarchy/Linux 能力」是如何拆开的、当前边界在哪里、以及新增平台时要改哪里。
原则：**业务服务不写平台分支**；平台专属实现与能力探测集中在 `src/main/platform/`，服务只依赖工厂/接口。

## 1. 目录与职责

业务服务不写平台分支；平台专属实现、能力探测与策略集中在 `src/main/platform/`：

| 模块 | 职责 |
|---|---|
| `platform/index.ts` | `PlatformId`（windows/linux/macos）、`platformId()`、`currentPlatformId` |
| `platform/runtime.ts` | 唯一读取 `process.platform` 的运行时模块：Node 平台名、PATH 分隔符、可执行名、ProgramFiles、Python/uv 布局、杀树/spawn 选项 |
| `platform/paths.ts` | 路径大小写语义、路径比较/归一化、symlink 类型、PATH key、toPosixPath |
| `platform/terminal.ts` | 默认 shell、ConPTY、终端环境变量 |
| `platform/apps.ts` | where/which、可执行后缀优先级、adb/npx 候选、connector platformKey、FreeCAD/外部 Agent 入口、APPDATA→XDG |
| `platform/fs-security.ts` | Windows ACL（icacls/SystemRoot）、POSIX 可执行位 |
| `platform/input.ts` | 全选等输入修饰键（macOS meta / 其它 control） |
| `platform/processes.ts` | 端口归属/镜像名/PID 可执行路径；Linux `ss` + `/proc`；统一进程树终止 |
| `platform/fonts.ts` | 系统字体：Windows PowerShell/注册表、Linux `fc-list`、macOS `[]` |
| `platform/shell-tools.ts` | 平台附加 shell 工具：Windows PowerShell；Linux/macOS 空（CodingTools 自带 bash） |
| `platform/window-shell.ts` | 窗口图标格式（.ico/PNG）、Windows `titleBarOverlay`（构造 + 主题切换）、`setAppDetails` 任务栏身份；其它平台 no-op |
| `platform/app.ts` | 应用级初始化：Windows `AppUserModelID`、崩溃上报用的 Node 平台事实字段 |
| `platform/lifecycle.ts` | `window-all-closed` 是否退出（macOS 常驻）、macOS 文件对话框 `createDirectory` |
| `platform/credentials/index.ts` | `installPlatformCredentialBackend()`：Linux ready 前注入 `--password-store=gnome-libsecret`、ready 后打印/告警后端；其它平台 no-op；主进程第一条 import |
| `platform/tray/index.ts` | 托盘平台行为：图标资源/格式、Linux 22px 缩放、日志标签、关窗提示策略 `balloon`/`notification`/`none`、`supportsBalloon`、`degradedResidency` |
| `platform/tray/residency.ts` | 关窗驻留纯逻辑（`shouldRemainResidentAfterClose`，不判断平台） |
| `platform/computer-use/support.ts` | Computer Use 能力探测：`{platform,backend,supported,missingDependencies,installHint,reason}`、PATH 探测、overlay 支持 |
| `platform/computer-use/protocol.ts` | 跨平台 Computer Use DTO / 动作枚举（服务与 backend 共用） |
| `platform/computer-use/backend.ts` | `ComputerUseBackend` 接口（platform/backend/available/status/execute/shutdown） |
| `platform/computer-use/index.ts` | `createComputerUseBackend(platform)` 工厂/缓存 |
| `platform/computer-use/windows/` | Windows 完整实现：`WindowsComputerUseBackend`、UIA/WGC/PrintWindow 宿主、窗口截图、overlay |
| `platform/computer-use/linux/` | Linux backend（当前 `available=false`，status 返回缺失依赖/安装提示；观察层待接线） |
| `platform/computer-use/macos/` | macOS backend（unsupported） |
| `platform/computer-use/ocr.ts` | OCR 候选/Provider：`MYBUDDY_OCR_CLI`、打包资源、`windows-ocr.ps1`；Linux tesseract 描述 |
| `platform/browsers.ts` | 浏览器 Cookie 平台层：macOS/Linux 浏览器配置、Keychain/secret-tool 密码、PBKDF2 迭代数、平台浏览器启动命令（Windows 不支持 Cookie 提取） |
| `platform/glimpse.ts` | Glimpse 内嵌浏览器（仅 macOS）：模块解析、window 接口、open；非 macOS 返回 null |

兼容薄层：`src/main/capabilities/ComputerAutomationService.ts` / `ComputerUseOverlayService.ts` 仅 re-export 平台实现，自身不含平台逻辑。
允许在 `src/main/platform/**` 内出现 `process.platform`/`PlatformId` 判断。截至 2026-10-27，`src/main` 业务层已无 `process.platform` 分支或 `"win32"/"darwin"` 平台判断（`grep -rnE 'process\.platform|platform\(\)|currentPlatform' src/main | grep -v platform/` 仅剩注释）；`platform/runtime.ts` 是唯一读取 `process.platform` 的运行时模块。
唯一例外：`src/main/memory/external-cli-memory-assets-content.ts` 里生成给用户机器的独立 CLI 字符串模板（无模块依赖，模板里保留平台判断）。

## 2. 当前能力矩阵

| 能力 | Windows | Linux（Omarchy/Wayland） | 处理 |
|---|---|---|---|
| 窗口图标 / titleBarOverlay / 任务栏身份 | ✅ | Linux 用 PNG 图标；无 titleBarOverlay（no-op） | `window-shell` 已拆 |
| 托盘 / safeStorage / 单实例 / 窗口关闭驻留 | ✅ ico + balloon 提示 | ✅ PNG 托盘 22px、gnome-libsecret、通知提示、降级驻留 | `platform/tray` + `platform/credentials`；`TrayService` 只读 behavior，无 `process.platform` |
| 系统字体枚举 | ✅ PowerShell/注册表 | ✅ `fc-list` | `platform/fonts` |
| 端口归属 / 进程名 / PID 路径 | ✅ netstat/tasklist/CIM | ✅ `ss` + `/proc` | `platform/processes` |
| PowerShell 工具 | ✅ | ➖ 不需要（bash 已由 CodingTools 提供） | `platform/shell-tools` |
| Computer Use（观察/输入/UIA） | ✅ `WindowsComputerUseBackend`（UIA + SendInput + WGC/PrintWindow + Windows OCR） | ❌ backend 已抽象，Linux 观察层待接线；`status()` 返回 `linux-wayland` + 缺失依赖/安装提示 | `platform/computer-use/{backend,windows,linux}` |
| Computer Use 叠加框 | ✅ | ❌ Wayland 无全局 overlay；需重设计 | `supportsComputerUseOverlay` |
| 安装包 / 快捷方式 / 自启动 | ✅ NSIS/.lnk | ⚠️ `pack:linux` 仅 dir；需 AppImage/deb + `.desktop` + XDG autostart | 待做 |
| 后台截取被遮挡窗口 | ✅ WGC/PrintWindow | ❌ Wayland 不提供；只能 portal 录屏/前台截图 | 产品上接受限制 |

## 3. Linux Computer Use 的实现路线（backend，不在本步范围）

1. **观察**：`hyprctl -j monitors/clients/activewindow`（窗口/显示器/几何）、`grim`（截图/区域）、`tesseract`（OCR，需 `tesseract-data-chi_sim`）。
2. **输入**：`wtype`（键盘）、`ydotool`（鼠标/点击/拖拽，需要 uinput 权限 + daemon）；Hyprland 0.56 的 `hyprctl eval` Lua dispatcher 作为窗口控制的版本相关补充。
3. **语义**：AT-SPI2（`org.a11y.Bus`）作为 UIA 等价物；Chromium/Electron 目标需 `--force-renderer-accessibility`。
4. **降级**：只装 `grim/hyprctl` → 只读；`wtype` → 键盘；`ydotool` → 鼠标；AT-SPI 缺失时 OCR 兜底。
5. **不做**：后台截取被遮挡/最小化窗口、PostMessage 后台点击、全局悬浮框 1:1 复刻。

`ComputerUseBackend` 接口与 `WindowsComputerUseBackend` 已落地；Linux backend 目前是能力探测 + unsupported 壳，下一步在 `LinuxComputerUseBackend.execute()` 接观察层（hyprctl/grim/tesseract），再接 wtype/ydotool 输入与 AT-SPI2 语义层。

## 4. 新增一个平台要做什么

1. 在 `platform/<feature>.ts` 里加该平台的 provider 分支（或 `platform/<feature>/<platform>.ts`），业务服务不改。
2. 需要外部命令时全部走可注入 runner（便于测试），不要在主线程 `execSync` 阻塞；失败返回空/`unsupported`，不要抛到 UI 顶部。
3. 更新能力探测（缺失依赖 + 安装提示），让 UI 只展示可用动作。
4. 测试：纯解析函数 + 注入 runner 的单测进 default 套件；真实桌面/CLI 的放在 GUI/live 套件。
5. 更新本文件的矩阵。

## 5. 本机（Omarchy）依赖

```bash
sudo pacman -S --needed grim slurp wtype ydotool \
  tesseract tesseract-data-chi_sim at-spi2-core python-gobject
# ydotool 需要 uinput 权限（ydotoold + udev/组），否则鼠标动作会报“未安装/无权限”
```
