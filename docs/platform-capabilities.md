# 平台能力边界（Windows / Linux / macOS）

本文件说明「Windows 独有能力」与「Omarchy/Linux 能力」是如何拆开的、当前边界在哪里、以及新增平台时要改哪里。
原则：**业务服务不写平台分支**；平台专属实现与能力探测集中在 `src/main/platform/`，服务只依赖工厂/接口。

## 1. 目录与职责

| 模块 | 职责 |
|---|---|
| `src/main/platform/index.ts` | `PlatformId`（windows/linux/macos）、`platformId()`、`currentPlatformId` |
| `src/main/platform/window-shell.ts` | 窗口图标格式（.ico/PNG）、Windows `titleBarOverlay`、Windows `setAppDetails` 任务栏身份；其它平台 no-op |
| `src/main/platform/computer-use.ts` | Computer Use 能力探测：`{ platform, backend, supported, missingDependencies, installHint }`；Windows=`windows-uia` supported，Linux=`linux-wayland` 未实现但返回缺失依赖与安装提示；`supportsComputerUseOverlay()` |
| `src/main/platform/computer-use/ocr.ts` | OCR 候选/常量：`MYBUDDY_OCR_CLI` 环境变量、打包资源、`scripts/windows-ocr.ps1`；删除个人路径硬编码；定义 Linux OCR（tesseract）provider 描述 |
| `src/main/platform/fonts.ts` | 系统字体枚举：Windows PowerShell/注册表、Linux `fc-list`、macOS 暂空 |
| `src/main/platform/processes.ts` | 端口归属/进程名/PID 可执行路径：Windows netstat/tasklist/CIM、Linux `ss` + `/proc` |
| `src/main/platform/shell-tools.ts` | 平台附加 shell 工具：Windows PowerShell；Linux/macOS 返回空（CodingTools 自带 bash） |
| `src/main/platform/computer-use/windows/`（规划） | 将来的 Windows backend（现暂由 `src/main/capabilities/windows/` 承载并由能力探测保护） |
| `src/main/platform/computer-use/linux.ts`（规划） | 将来的 Linux backend：hyprctl/grim/tesseract/wtype/ydotool/AT-SPI2 |

允许在 `src/main/platform/**` 内出现 `process.platform`/`PlatformId` 判断；**服务层新增代码禁止直接判断平台**。
现有的路径分隔符、大小写语义、`~/.mybuddy` 等跨平台通用逻辑不在此列。

## 2. 当前能力矩阵

| 能力 | Windows | Linux（Omarchy/Wayland） | 处理 |
|---|---|---|---|
| 窗口图标 / titleBarOverlay / 任务栏身份 | ✅ | Linux 用 PNG 图标；无 titleBarOverlay（no-op） | `window-shell` 已拆 |
| 托盘 / safeStorage / 单实例 / 窗口关闭驻留 | ✅ | ✅ 已实现（PNG 托盘、gnome-libsecret） | 已在 `TrayService`/`linux-password-store` |
| 系统字体枚举 | ✅ PowerShell/注册表 | ✅ `fc-list` | `platform/fonts` |
| 端口归属 / 进程名 / PID 路径 | ✅ netstat/tasklist/CIM | ✅ `ss` + `/proc` | `platform/processes` |
| PowerShell 工具 | ✅ | ➖ 不需要（bash 已由 CodingTools 提供） | `platform/shell-tools` |
| Computer Use（观察/输入/UIA） | ✅ UIA + SendInput + WGC/PrintWindow + Windows OCR | ❌ 尚未实现；能力探测返回 `linux-wayland` 未支持 + 依赖清单 | `platform/computer-use`（下一步 backend） |
| Computer Use 叠加框 | ✅ | ❌ Wayland 无全局 overlay；需重设计 | `supportsComputerUseOverlay` |
| 安装包 / 快捷方式 / 自启动 | ✅ NSIS/.lnk | ⚠️ `pack:linux` 仅 dir；需 AppImage/deb + `.desktop` + XDG autostart | 待做 |
| 后台截取被遮挡窗口 | ✅ WGC/PrintWindow | ❌ Wayland 不提供；只能 portal 录屏/前台截图 | 产品上接受限制 |

## 3. Linux Computer Use 的实现路线（backend，不在本步范围）

1. **观察**：`hyprctl -j monitors/clients/activewindow`（窗口/显示器/几何）、`grim`（截图/区域）、`tesseract`（OCR，需 `tesseract-data-chi_sim`）。
2. **输入**：`wtype`（键盘）、`ydotool`（鼠标/点击/拖拽，需要 uinput 权限 + daemon）；Hyprland 0.56 的 `hyprctl eval` Lua dispatcher 作为窗口控制的版本相关补充。
3. **语义**：AT-SPI2（`org.a11y.Bus`）作为 UIA 等价物；Chromium/Electron 目标需 `--force-renderer-accessibility`。
4. **降级**：只装 `grim/hyprctl` → 只读；`wtype` → 键盘；`ydotool` → 鼠标；AT-SPI 缺失时 OCR 兜底。
5. **不做**：后台截取被遮挡/最小化窗口、PostMessage 后台点击、全局悬浮框 1:1 复刻。

实现时应新建 `ComputerUseBackend` 接口，把 `ComputerAutomationService` 编排层与 `windows/` 宿主分离；Linux backend 实现同一接口，服务只依赖接口。当前这一步先把「能力探测 + Windows 专属常量/路径」拆出来，保证 Linux 用户能看到「为什么不可用 + 怎么装」。

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
