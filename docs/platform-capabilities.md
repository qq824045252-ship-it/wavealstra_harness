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
| `platform/computer-use/linux/LinuxComputerUseBackend.ts` | Linux backend：动作分发（窗口/截图/OCR/控件/指针/键盘/批量），坐标与 DIP 换算 |
| `platform/computer-use/linux/culClient.ts` | computer-use-linux MCP 客户端（`<binary> mcp`，stdio 惰性启动/超时/诊断 stderr tail） |
| `platform/computer-use/linux/culBinary.ts` | CUL 原生二进制定位（打包 asar.unpacked / pnpm `.pnpm` / `MYBUDDY_CUL_BIN`）+ `doctor` 报告解析 |
| `platform/computer-use/linux/culProtocol.ts` | CUL JSON → Computer Use DTO 的纯函数适配层（窗口/显示器缩放/按键名/AT-SPI 控件/tesseract TSV/错误码） |
| `platform/computer-use/linux/hyprlandMonitors.ts` | `hyprctl -j monitors` 读取（物理布局 + scale） |
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
| Computer Use（观察/输入） | ✅ `WindowsComputerUseBackend`（UIA + SendInput + WGC/PrintWindow + Windows OCR） | ✅ `LinuxComputerUseBackend`（computer-use-linux MCP：Hyprland IPC + xdg-desktop-portal 截图 + uinput/wtype 输入 + AT-SPI + tesseract） | `platform/computer-use/{backend,windows,linux}` |
| Computer Use 屏幕反馈 | ✅ 叠加框 + 光标 + 停止按钮 | ⚠️ 只有阶段通知（`hyprctl notify`），画不出窗口外框 | `supportsComputerUseOverlay`（Windows）/ `supportsComputerUseActivityNotice`（Linux） |
| 安装包 / 快捷方式 / 自启动 | ✅ NSIS/.lnk | ⚠️ `pack:linux` 仅 dir；需 AppImage/deb + `.desktop` + XDG autostart | 待做 |
| 后台截取被遮挡窗口 | ✅ WGC/PrintWindow | ❌ Wayland 不提供；只能 portal 录屏/前台截图 | 产品上接受限制 |

## 3. Linux Computer Use：接 computer-use-linux（CUL），不自研

Linux 后端**不是**自己拼 `grim` + `hyprctl` + `ydotool`，而是接 [computer-use-linux](https://github.com/agent-sh/computer-use-linux)
（npm `@agent-sh/computer-use-linux`，Rust 原生二进制 + MCP server）。原因：Wayland 的坐标/缩放、
portal 截图授权、AT-SPI 差异用 shell 拼装极易错（实测 `ydotool --absolute` 的入参被当成物理像素
再用到逻辑坐标上，1.6x 缩放下差 1.6 倍），CUL 已把这些封在原生实现里。

集成方式：主进程 spawn `<binary> mcp`（stdio MCP），`CulMcpClient` 按工具名调用，`culProtocol.ts`
把返回 JSON 映射成 `WindowInfo` / `ControlInfo` / `OcrLine`。二进制缺失时 `available=false`，`status()`
给出 `pnpm install` 提示，工具不注册。

| 能力 | 来源 |
|---|---|
| 窗口枚举/焦点/几何 | CUL `list_windows` / `focused_window` / `activate_window`（内部走 `hyprctl -j clients`） |
| 窗口移动/改尺寸 | `hyprctl repl` 的 Hyprland Lua（`linux/hyprlandWindows.ts`），CUL 自己不支持 |
| 操作中用户反馈 | `hyprctl notify`（`linux/activityNotice.ts`），按 phase 配色 + 目标名 |
| 截图（全屏 / 窗口） | CUL `screenshot`（走 `xdg-desktop-portal`；首次可能弹一次授权框） |
| 输入（指针/键盘） | CUL `click`/`drag`/`scroll`（uinput 绝对指针）、`type_text`（wtype）、`press_key` |
| 语义树 | CUL `get_app_state` + **自动 `get_tree_page` 翻页**（AT-SPI）。CUL 会把树 compact 到内联 ~37 个节点且仍报 `accessibility_tree_truncated:false`，真总数只在 `accessibility_tree_spill.node_count`；后端据此翻页收全（上限 8 页 / 3000 节点）。Electron 需 `--force-renderer-accessibility` 才暴露 renderer 内容 |
| OCR | 本地 `tesseract`（`--psm 6 tsv`）+ `parseTesseractTsv`；不依赖 CUL |

实测坐标语义（Hyprland 1.6x，eDP-1 2160×1440）：
`WindowInfo.windowRect/clientRect` 是**物理**像素，`click_client`/`move_client` 的 `x/y` 是**客户区 DIP**，
`clientDipToScreenPhysical = clientOrigin + dip × scaleFactor`。截图 `image_scale = 物理像素 / 图像像素`，
OCR 行坐标用 `image_scale / scaleFactor` 折回 DIP。

AT-SPI 控件坐标在 GTK 上不可用（2026-10-27 真机复核）：zenity（GTK3 对话框）9 个节点、
Nautilus（GTK4 主窗，2 页共 75 个节点）的 `bounds.x/y` **全部为 0**，只有宽高是真的；
照坐标点会稳定点到客户区左上角。CUL README 同样把这种情形列为「GTK3 HiDPI extents /
GTK4 zero-origin bounds」，它对元素点击优先走原生 AT-SPI action。后端因此做能力降级：
同一窗口 ≥3 个有尺寸节点原点全是 (0,0) 时 `inspect_controls`/`find_control` 返回
`boundsReliable=false`，并把 `clientBoundsDip`/`screenBoundsPhysical` 清空（控件身份、
`runtimeId`、`patterns` 保留，`invoke_control`/`set_control_value` 照常可用），
detail 里提示改用 OCR 文字行坐标。真机验证：GTK 对话框上 `set_control_value` + `invoke_control(OK)`
能把 zenity 的输入回读出来（端到端 PASS）。

截图与几何：`screenshot_window` 会先 raise（portal 只能截前台窗口）。raise 一个**平铺**窗口会触发
Hyprland 重排，客户区尺寸随之变化，旧实现直接报 `CAPTURE_FAILED: 截图期间窗口几何发生变化`；
现在按新几何**重试一次**，仍然不一致才报错。

按下/释放分离与长按（2026-10-27 真机验证，推翻旧结论）：
- `mouse_down_client`/`mouse_up_client`/`key_down`/`key_up` **可用**，走 `ydotool`（`ydotool click 0x40|0x80`、`ydotool key <code>:1|0`）。
  不能用 `wtype`：虚拟键盘协议在进程退出时自动释放，按住状态保不住；`ydotool` 直写 uinput，跨进程持久
  （实测 `ydotool key 42:1` 后 `hyprctl repl 'hl.is_key_down("Shift_L")'` = true）。
- **按住状态会一直保持到显式释放**，用完必须 `key_up`/`mouse_up_client`，否则用户桌面残留按下的键。
- `click_client` 的 `modifiers`（Ctrl+点击）与 `hold_ms`、`drag_client` 的 `steps`/`duration_ms`、`key_press` 的 `hold_ms` 都真的生效；
  `move_client` 不接受 `modifiers`/`hold_ms`，会显式报错而不是静默忽略。
- `paste_text` 走 `wl-copy` + Ctrl+V（`wl-clipboard`），比逐字 `wtype` 快一个数量级；剪贴板不可用会回落逐字输入并在 detail 说明。
  注意：`wl-copy` 会 fork 常驻进程持有选区并**继承 stderr 管道**，所以不能用 `close` 事件等它
  （父进程 100ms 就 exit，`close` 要等选区被替换才到，`paste_text` 会一直挂住）；后端按 `exit` 判定 + 3 秒兜底。
  真机验证：`paste_text` → GTK 对话框 entry → 点 OK 回读文本，端到端 PASS；终端类应用要 Ctrl+Shift+V，`Ctrl+V` 不会粘贴。
- 指针定位仍由 CUL 负责（`scroll pages=0` 只定位不滚动）：`ydotool mousemove -a` 的坐标系是「逻辑 DIP × 2」，与 Hyprland 物理像素不等价。

Wayland 的真实限制（后端显式报错，不做假成功）：
- 没有后台截图：`background=true` 被拒绝；portal 只能截前台窗口。
- **没有窗口外框叠加层**（`supportsComputerUseOverlay()` 仅 Windows）。这不是没做，是三条路都实测不成立：
  1. Electron 透明窗口会被拍进 agent 自己的截图。Wayland 没有 `WDA_EXCLUDEFROMCAPTURE` 等价物，
     `setContentProtection(true)` 在 Hyprland 上是空操作，`hl.window_rule({no_screenshare=...})` 三种写法都返回 ok
     但 grim 照样拍到叠加层（实测洋红边框像素仍在）。叠加层会污染 `screenshot`/`screenshot_window` 的输入。
  2. 分数缩放下铺不满：CSS px ≠ 逻辑 px（dpr 0.90625 vs scale 1.6），按逻辑尺寸建窗只覆盖 1956×1302 / 2160×1440；
     `setZoomFactor`、按物理尺寸建窗、`setContentSize(2383,1589)` 都仍有约 100px 缺口。只有启动期全局
     `force-device-scale-factor=1.6` 能铺满，但那会影响整个 app 的所有窗口。
  3. CUL 自带的 `computer-use-linux-indicator` 不是可靠替代：它确实走 wlr-layer-shell 并起 4 条边框 + 1 个 pill，
     但只在 CUL 内部 `screenshot` 时被拉起（我们无法按 phase 驱动）、抓帧里**完全不显色**、
     D-Bus 名 `dev.avifenesh.ComputerUseLinux.WindowControl` 在 Hyprland 上不注册，
     `$XDG_RUNTIME_DIR/computer-use-linux-indicator.sock` 是 SOCK_DGRAM 但发任意事件都不改变可见状态。
  → Linux 的反馈改走**阶段通知**（`hyprctl notify` + `linux/activityNotice.ts`）：不污染截图、无外部依赖。
  不用 `hyprctl dismissnotify`（会把用户自己的通知一起关掉），每条通知靠 `time_ms` 自己过期。
- GNOME 专用的 `setup_window_targeting` 在 Hyprland 上不可用。
- **窗口移动/改尺寸已接线**：CUL 的 `move_window`/`resize_window` 在 Hyprland 上直接失败（需要 GNOME Shell 扩展或
  X11/EWMH），后端改用 `hyprctl repl` 的 Lua（`hl.dispatch(hl.dsp.window.move/resize)`，`linux/hyprlandWindows.ts`）。
  要点：`hl.dsp.window.*` 只构造 dispatcher 对象，**必须** `hl.dispatch(...)` 包住才执行；平铺窗口先
  `hl.dispatch(hl.dsp.window.float({mode="toggle"}))`；坐标是逻辑/布局像素（与 `hyprctl clients` 的 `at`/`size` 同域）；
  返回值 `window_geometry` 是合成器实际采纳值（可能差 1–2px），不是请求值。
  `hl.dsp.window.set_prop` 在 Hyprland 0.56.2 上是**静默空操作**（`prop="bogus"` 也返回 ok，改 bordercolor 后抓帧零变化），
  所以不能用它画高亮边框。

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

CUL 自身用 `doctor` 检查这些依赖；原生二进制由 `pnpm install` 的 postinstall 解包到
`node_modules/@agent-sh/computer-use-linux/npm/bin/`（打包时进 `app.asar.unpacked`）。
`MYBUDDY_CUL_BIN` 可覆盖二进制路径（自定义安装/测试）。
