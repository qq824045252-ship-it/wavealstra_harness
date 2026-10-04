# MyBuddy Computer Use Foundation — Codex 实施规划

> 目标：把当前 `computer_exec` 从“桌面级鼠标键盘遥控器”升级为可验证、窗口作用域、支持 Windows UI Automation 的可靠 Computer Use 基础设施。
>
> 本计划用于 Codex 一次性执行。**不要修改 `dimagent-debug` Skill 的方法论内容**；本阶段只补 Computer Use 基础能力。

---

## 0. 执行纪律

1. 开始前先读并确认现有实现：
   - `src/main/capabilities/ComputerAutomationService.ts`
   - `src/main/capabilities/UiAutomationService.ts`
   - `src/main/capabilities/builtin-capability-extension.ts`
   - `src/shared/pi-event-mapper.ts`
   - `src/shared/builtin-capabilities.ts`
   - `src/main/agent/PromptAssembly.ts`
   - `src/renderer/src/components/settings/CapabilitiesTab.tsx`
   - `package.json` 与 Electron 打包配置

2. **不要改 `dimagent-debug` Skill 的工作流正文。** 当前瓶颈是工具能力，不是 Debug 方法论。

3. 不做无关 UI、美化、业务重构、依赖升级。

4. **不要长测，不做完整 E2E。** 只跑本计划列出的 targeted test / smoke / typecheck / build。测试失败先定位，不要无限循环。

5. 保留已有 action 兼容性，但改变推荐路径：
   - `mouse_move / mouse_click / mouse_drag / scroll` 保留为 legacy desktop-coordinate fallback；
   - 新的正常路径必须是 window-scoped。

6. 所有副作用动作继续走现有 permission 体系。新增只读 action 必须加入 readonly 白名单；新增 invoke/set/click/focus 等必须继续判定为 side effect / dangerous。

7. **失败必须显式失败。** 禁止 focus 失败仍返回成功；禁止截图失败后用全桌面截图冒充窗口截图；禁止 HWND/PID 已变化后继续点击。

---

# 1. 最终产品目标

当前：

```text
Desktop
  ↓
screenshot
  ↓
全局坐标
  ↓
SetCursorPos
  ↓
mouse_event / keybd_event
```

完成后：

```text
Computer Use
│
├─ Desktop
│  ├─ displays
│  └─ legacy raw input
│
├─ Window
│  ├─ enumerate
│  ├─ inspect
│  ├─ focus + verify
│  ├─ screenshot
│  └─ wait / detect
│
├─ Accessibility
│  ├─ inspect_controls
│  ├─ find_control
│  ├─ invoke_control
│  └─ set_control_value
│
└─ Window-scoped Input
   ├─ move_client
   ├─ click_client
   ├─ drag_client
   ├─ scroll_client
   ├─ key_press
   └─ type_text
```

核心路径：

```text
Window identity
→ Semantic control if possible
→ Window screenshot if semantic unavailable
→ Client-coordinate guarded input
→ Post-action observation
```

正常情况下不应再出现：

```text
GetWindowRect
→ 全屏截图
→ 手工裁剪
→ VLM 猜坐标
→ desktop absolute click
```

---

# 2. 本轮必须解决的问题

| 当前缺陷 | 本轮修复 |
|---|---|
| 每 action 都 spawn PowerShell + Add-Type | 长驻 Windows Automation Host |
| screenshot 只有整个 display | `screenshot_window` |
| mouse click 不绑定 HWND | `click_client` + target guard |
| 只有 desktop absolute coordinate | client coordinate system |
| focus 不验证结果 | verified `focus_window` |
| 无 UIA | inspect/find/invoke/set |
| WindowInfo 只有 handle/title/pid | 完整窗口模型 |
| dialog 异步出现后要 sleep/list | `wait_for_window` + new-window diff |
| click 只返回“执行了” | post-action observation |
| 缺实机 contract test | Windows controlled smoke harness |

---

# 3. 架构决定：长驻 Windows Automation Host

## 3.1 本轮实现

不要立刻新建独立 .NET/Rust 可执行文件。本轮先采用：

```text
Electron Main
    │
    │ NDJSON over stdin/stdout
    ▼
persistent powershell.exe
    │
    ├─ Add-Type once
    ├─ Win32 helper once
    ├─ UIAutomationClient once
    └─ receive many commands
```

原因：

- 现有 PowerShell + C# P/Invoke 已证明可工作；
- 可以立即消除“每 action 重新启动 PowerShell”的主要延迟；
- 不引入额外构建链/运行时/安装包；
- C# 调 Windows UI Automation 最直接；
- 将来切 native sidecar 时，上层 JSON contract 可以保持不变。

目标不是永久绑定 PowerShell，而是先把 **Computer Use contract** 做正确。

## 3.2 新模块

建议新增：

```text
src/main/capabilities/windows/
├─ WindowsAutomationHost.ts
├─ windowsAutomationProtocol.ts
├─ windowsAutomationHostScript.ts
└─ WindowCaptureService.ts
```

### `WindowsAutomationHost.ts`

职责：

- lazy start；
- MyBuddy 进程内只保留一个 host；
- stdin/stdout NDJSON；
- request id -> Promise map；
- 每 request timeout；
- stderr 与 protocol stdout 分离；
- host crash 后当前 pending 全部 reject；
- 下一次请求允许自动重启一次；
- 不允许无限重启；
- app 退出时 clean shutdown；
- side-effect 请求至少全局串行。

### `windowsAutomationProtocol.ts`

集中定义：

```ts
WindowInfo
ControlInfo
Rect
Point
TargetIdentity
WindowsAutomationRequest
WindowsAutomationResponse
AutomationErrorCode
```

不要让 schema/service/host 各自复制一套字段。

### `windowsAutomationHostScript.ts`

PowerShell host 启动时只做一次：

```powershell
Add-Type <Win32 C# helper>
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
```

然后循环：

```text
ReadLine(stdin)
→ ConvertFrom-Json
→ dispatch
→ ConvertTo-Json -Compress
→ WriteLine(stdout)
```

**stdout 只能输出 protocol response。** 普通日志写 stderr，防止 JSON 协议被污染。

---

# 4. Window Identity：窗口成为一等实体

## 4.1 完整 `WindowInfo`

把当前：

```ts
{ handle, title, processId }
```

升级为：

```ts
interface WindowInfo {
  handle: string;
  processId: number;
  processName?: string;
  title: string;
  className?: string;

  visible: boolean;
  minimized: boolean;
  foreground: boolean;

  windowRect: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };

  clientRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  clientOrigin: {
    x: number;
    y: number;
  };

  dpi: number;
  scaleFactor: number;
  monitorHandle?: string;
}
```

Windows API：

```text
windowRect   = GetWindowRect
clientRect   = GetClientRect
clientOrigin = ClientToScreen(hwnd, 0,0)
dpi          = GetDpiForWindow
scaleFactor  = dpi / 96
minimized    = IsIconic
foreground   = GetForegroundWindow == hwnd
className    = GetClassName
```

## 4.2 新 action：`inspect_window`

支持：

```text
window_handle
window_title
process_id
```

匹配规则：

1. handle 最精确，优先；
2. process_id + title 次之；
3. 仅 title substring 时：
   - 0 个 -> `WINDOW_NOT_FOUND`
   - >1 个 -> `WINDOW_AMBIGUOUS`
   - 禁止自动选第一个。

`list_windows` 同步返回完整 `WindowInfo[]`。

---

# 5. Target Guard：窗口操作前确认目标没变

新增统一内部路径：

```text
resolve target
→ HWND still exists
→ PID still matches expected PID
→ visible
→ restore if minimized
→ focus if required
→ verify foreground HWND == expected HWND
```

稳定错误码至少包含：

```text
WINDOW_NOT_FOUND
WINDOW_AMBIGUOUS
TARGET_CHANGED
WINDOW_NOT_VISIBLE
FOCUS_FAILED
STALE_OBSERVATION
CONTROL_NOT_FOUND
CONTROL_AMBIGUOUS
CONTROL_NOT_ACTIONABLE
CAPTURE_FAILED
POINT_OUTSIDE_CLIENT
WAIT_TIMEOUT
```

details 必须保留结构化 code，不要只有自由文本。

---

# 6. `focus_window` 改为强验证

当前：

```text
ShowWindow
→ sleep 50ms
→ SetForegroundWindow
→ 永远返回 focused
```

改成：

```text
inspect target
→ restore if minimized
→ SetForegroundWindow
→ bounded wait 50~500ms
→ GetForegroundWindow
→ compare HWND
```

成功返回：

```json
{
  "focused": true,
  "foregroundBefore": "...",
  "foregroundAfter": "...",
  "window": { }
}
```

失败必须 `FOCUS_FAILED`。

---

# 7. `screenshot_window`：窗口作用域观察

新增：

```text
screenshot_window
```

输入：

```text
window_handle / window_title / process_id
client_only?: boolean          default false
ensure_foreground?: boolean    default true
```

## 第一版 capture 策略

本轮不强制实现 Windows Graphics Capture。采用：

```text
resolve target
→ restore
→ focus
→ verify foreground
→ inspect window/client rect + monitor
→ Electron desktopCapturer capture exact monitor
→ 按 display.bounds + scaleFactor 正确映射
→ crop 到目标 window/client rect
```

返回 details：

```text
window identity
display id
scale factor
capture rect DIP
capture rect physical pixels
capture mode = foreground-display-crop
```

### 多显示器跨屏

如果窗口跨多个 display：

- 不自动移动窗口；
- 不静默截半张；
- 返回 `CAPTURE_SPANS_MULTIPLE_DISPLAYS`。

显式失败优于错误证据。

### Artifact 名称

- `screenshot` -> `desktop-screenshot.png`
- `screenshot_window` -> `window-${safeTitleOrPid}.png`

---

# 8. Windows UI Automation（UIA）

新增：

```text
inspect_controls
find_control
invoke_control
set_control_value
```

正常路径：

```text
inspect_window
→ inspect_controls
→ find_control
→ invoke / set
```

只有 UIA 不可用时才走视觉 fallback。

## 8.1 `ControlInfo`

```ts
interface ControlInfo {
  runtimeId: string;
  automationId?: string;
  name?: string;
  controlType: string;
  className?: string;
  frameworkId?: string;

  enabled: boolean;
  offscreen: boolean;
  keyboardFocusable: boolean;
  hasKeyboardFocus: boolean;

  bounds?: {
    left: number;
    top: number;
    width: number;
    height: number;
  };

  patterns: string[];
}
```

## 8.2 `inspect_controls`

输入：

```text
window target
max_depth?: 6
max_nodes?: 300
```

要求：

- 以窗口 root AutomationElement 为起点；
- bounded tree；
- 只返回 meaningful controls；
- `truncated: true/false`；
- 禁止把复杂 IDE/浏览器的整个 accessibility tree 塞进上下文。

## 8.3 `find_control`

支持：

```text
name
automation_id
control_type
class_name
exact_name?
```

规则：

- automation id exact；
- type/class exact；
- name 默认 case-insensitive contains；
- 0 -> `CONTROL_NOT_FOUND`；
- >1 -> `CONTROL_AMBIGUOUS`，返回候选，禁止自动选第一个。

## 8.4 `invoke_control`

优先 `InvokePattern`。

允许有限 fallback：

```text
SelectionItemPattern
TogglePattern
ExpandCollapsePattern
```

不能 semantic invoke 时返回 `CONTROL_NOT_ACTIONABLE`，不要乱猜。

## 8.5 `set_control_value`

只使用 `ValuePattern.SetValue`。

不可写时返回 `CONTROL_NOT_ACTIONABLE`。

**不要自动退化成键盘输入**，避免误输。

---

# 9. Client Coordinate：正常输入必须从属 Window

新增：

```text
move_client
click_client
drag_client
scroll_client
```

`x/y` 定义为 **目标窗口 client area 的 DIP 坐标**。

底层流程：

```text
validate target
→ focus + verify
→ bounds check
→ ClientToScreen
→ SendInput
```

默认：

```text
allow_outside_client = false
```

超界：

```text
POINT_OUTSIDE_CLIENT
```

Agent 不再自己计算：

```text
window.left + titlebar + dpi + offset
```

---

# 10. Legacy desktop action 保留但降级

保留：

```text
mouse_move
mouse_click
mouse_drag
scroll
```

但在 description 中明确标记：

```text
legacy desktop-coordinate fallback
```

新 action 排在 promptSnippet / description 的正常路径前面。

`key_press / type_text` 新增可选 window target：

```text
window_handle / window_title / process_id
```

提供 target 时：

```text
validate + focus + verify
→ send key/text
```

不提供时保留旧行为，但 detail 明确：

```text
legacy foreground-targeted input
```

---

# 11. Action Verification：动作后返回证据

副作用动作不能只返回：

```text
left click at 1500,340
```

统一记录：

```ts
interface ActionObservation {
  targetBefore?: WindowInfo;
  targetAfter?: WindowInfo;
  foregroundBefore?: string;
  foregroundAfter?: string;
  focusPreserved?: boolean;
  newWindows?: WindowInfo[];
  closedWindows?: WindowInfo[];
}
```

执行前记录 visible top-level HWND set，动作后 bounded settle 100~250ms，再比较。

点击 “Open Folder” 后可直接返回：

```text
newWindows: [native dialog]
```

不必再 `sleep -> list_windows`。

默认：

```text
observe_after = true
capture_after = false
```

不要每次自动 screenshot，避免新性能问题。

---

# 12. `wait_for_window`

新增 readonly：

```text
wait_for_window
```

输入：

```text
title?
process_id?
class_name?
state?: visible | foreground | closed
timeout_ms?: 5000, max 30000
```

host 内 100ms bounded polling，支持 cancellation，timeout -> `WAIT_TIMEOUT`。

---

# 13. 轻量 Observation ID

`screenshot_window / inspect_window / inspect_controls` 返回：

```text
observation_id
```

内部保存短 TTL（建议 30 秒）：

```ts
{
  hwnd,
  pid,
  title,
  clientRect,
  dpi,
  capturedAt
}
```

`click_client` 可选传 `observation_id`。

执行前验证：

```text
same HWND
same PID
client size 未明显变化
```

变化则：

```text
STALE_OBSERVATION
```

缓存 bounded，例如最多 64 条，TTL 到期淘汰。

---

# 14. `ComputerAutomationService.ts` 重构目标

该文件最终只负责：

```text
input validation
→ host request
→ Electron screenshot bridge
→ normalized output
→ observation cache
```

PowerShell/C# 实现细节全部移到 `windows/` 子目录。

建议：

```ts
export class ComputerAutomationService {
  constructor(
    private readonly host = windowsAutomationHost,
    private readonly capture = windowCaptureService,
  ) {}
}
```

---

# 15. `computer_exec` schema

至少加入 actions：

```text
status

active_window
list_windows
inspect_window
focus_window
wait_for_window

screenshot
screenshot_window

inspect_controls
find_control
invoke_control
set_control_value

move_client
click_client
drag_client
scroll_client

mouse_move      legacy
mouse_click     legacy
mouse_drag      legacy
scroll          legacy

key_press
type_text
```

新增参数至少：

```text
process_id
class_name

control_name
automation_id
control_type
control_runtime_id
exact_name

client_only
ensure_foreground
observation_id

max_depth
max_nodes
timeout_ms

observe_after
capture_after
```

保持 `additionalProperties: false`。

---

# 16. Tool Description 必须改

当前 description 太像“桌面遥控器”。改成明确策略：

```text
Windows 原生 Computer Use。优先按窗口操作：
inspect_window → inspect/find UIA control → invoke/set；
UIA 不可用时 screenshot_window → click_client。
只有无法绑定窗口的特殊场景才使用 legacy desktop mouse actions。
所有窗口级输入会验证 HWND/PID/前台焦点，目标变化会拒绝执行。
```

---

# 17. Permission 更新

`src/shared/pi-event-mapper.ts`

### readonly / non-dangerous

```text
status
active_window
list_windows
inspect_window
wait_for_window
screenshot
screenshot_window
inspect_controls
find_control
```

### side effect / dangerous

```text
focus_window
invoke_control
set_control_value

move_client
click_client
drag_client
scroll_client

mouse_move
mouse_click
mouse_drag
scroll

key_press
type_text
```

`focus_window` 也算 side effect，因为会改变用户桌面状态。

---

# 18. 性能验收

新架构必须证明：

```text
first request:
启动 host + Add-Type once

subsequent requests:
same PowerShell host PID
```

最低验收：

- 连续 20 次 readonly request 使用同一 host PID；
- 不产生 20 个新的 powershell.exe；
- host crash 后下一次调用可重建；
- 不留下 orphan host。

不要求极端 benchmark，只要实证 process reuse。

---

# 19. 测试

## 19.1 禁止

不要：

- 完整长 E2E；
- 依赖用户当前桌面随机软件；
- 自动乱点用户正在使用的应用；
- 为测试安装第三方软件。

## 19.2 Contract test

新增：

```text
scripts/computer-automation-contract-test.ts
```

覆盖：

- action/schema 对齐；
- permission 分类；
- WindowInfo normalization；
- ambiguous target；
- stale observation；
- client point bounds；
- error code mapping。

## 19.3 Windows controlled smoke

新增：

```text
scripts/computer-automation-windows-smoke.ts
```

测试自己启动 WinForms 小窗口：

```text
Title: MyBuddy Computer Use Smoke

[ TextBox ]
[ Smoke Button ]
[ Label: idle ]
```

按钮点击后 label -> `clicked`。

测试流程：

```text
1. 启动 smoke window
2. list_windows 找到它
3. inspect_window
   - rect/client/dpi 存在
4. focus_window
   - foregroundAfter == hwnd
5. inspect_controls
   - Button / Edit / Text 可见
6. find_control("Smoke Button")
   - exactly one
7. set_control_value(textbox, "hello")
8. invoke_control(button)
9. 再 inspect/read
   - label == clicked
10. screenshot_window
    - non-empty PNG
    - identity == smoke hwnd
11. click_client
    - client bounds 保护正常
12. stale target test
    - close/recreate same title new HWND
    - old observation 必须拒绝
13. cleanup smoke window + host
```

## 19.4 Target guard 是 P0 测试

必须验证：

```text
inspect old HWND
→ close it
→ recreate same title new HWND
→ old observation click
```

结果必须：

```text
TARGET_CHANGED / STALE_OBSERVATION
```

绝不能点新窗口。

---

# 20. Window Screenshot 验证

测试：

```text
A 前台
B 后台
screenshot_window(B)
```

第一版 `ensure_foreground=true` 时：

- B 先 focus；
- 验证 foreground = B；
- 生成 B 的 screenshot；
- 若 focus 失败，直接 error；
- 禁止拿 A 的画面标成 B。

不要求 VLM 自动判断截图内容，只验证 identity / rect / PNG 非空 / foreground guard。

---

# 21. UIA fallback

custom-drawn app 可能 UIA 暴露为空。

这种情况：

```text
inspect_controls(hwnd)
```

应正常返回：

```json
{
  "controls": [],
  "uiaAvailable": true,
  "detail": "No meaningful controls exposed"
}
```

而不是把整个 Computer Use 判失败。

然后可继续：

```text
screenshot_window
→ visual identify
→ click_client
```

UIA 是主路径，不是唯一路径。

---

# 22. 生命周期与并发

- host lazy start；
- one host per MyBuddy process；
- 不要每 task 一个 host；
- app quit 时 clean terminate；
- side-effect computer actions 全局串行；
- 最简单可先全部 request 串行，优先稳定；
- 后续再开放 readonly concurrency。

桌面是全局资源，不能让两个 Agent 同时抢鼠标/焦点。

---

# 23. 日志

允许：

```text
[WindowsAutomationHost] started pid=...
[WindowsAutomationHost] restarted after exit
[ComputerAutomation] focus hwnd=... success
[ComputerAutomation] stale target rejected
```

禁止记录：

- `type_text` 的完整用户文本；
- screenshot 内容；
- 整棵 UIA tree。

---

# 24. 本轮明确不做

1. 不修改 `dimagent-debug` 工作流。
2. 不重构 `ui_exec`。
3. 不扩展 browser runtime。
4. 不做 macOS/Linux Computer Use。
5. 不做 OCR 自动坐标。
6. 不做通用 VLM planner。
7. 不新增 Playwright/nut.js/robotjs 等自动化框架。
8. 不做 unrelated renderer UI。
9. 不改业务功能。
10. 除非实证 Electron foreground crop 完全不可用，否则本轮不强制实现 Windows Graphics Capture native backend。

---

# 25. 文件改动建议

至少：

```text
MODIFY
src/main/capabilities/ComputerAutomationService.ts
src/main/capabilities/builtin-capability-extension.ts
src/shared/pi-event-mapper.ts
src/shared/builtin-capabilities.ts                  # 仅工具 metadata 需要时
src/renderer/src/components/settings/CapabilitiesTab.tsx  # 仅文案需要时

ADD
src/main/capabilities/windows/WindowsAutomationHost.ts
src/main/capabilities/windows/windowsAutomationProtocol.ts
src/main/capabilities/windows/windowsAutomationHostScript.ts
src/main/capabilities/windows/WindowCaptureService.ts

ADD TEST
scripts/computer-automation-contract-test.ts
scripts/computer-automation-windows-smoke.ts
```

目录名可按现有项目规范调整，但职责必须保持分层。

---

# 26. package.json scripts

新增短测试：

```text
test:computer-automation
test:computer-automation-windows
```

Windows smoke 不要强塞到所有平台默认 test。

---

# 27. 严格执行顺序

## Step 1 — Freeze contracts

- protocol types；
- WindowInfo / ControlInfo；
- error codes；
- contract test。

## Step 2 — Persistent host

- 把现有 Win32 helper 移入 host；
- active/list/focus/raw mouse/key 先跑通；
- 证明 20 次请求同一 host PID。

## Step 3 — Window inspect + verified focus

- 完整 WindowInfo；
- inspect_window；
- focus 强验证；
- 消灭假成功。

## Step 4 — Client input + target guard

- client coordinate；
- HWND/PID guard；
- stale observation；
- legacy desktop input 保留。

## Step 5 — Window screenshot

- exact target focus；
- display/DPI mapping；
- crop；
- artifact；
- multi-display explicit error。

## Step 6 — UI Automation

- inspect_controls；
- find_control；
- invoke；
- set value；
- ambiguity contract。

## Step 7 — Action observation + wait

- new/closed window diff；
- wait_for_window；
- post-action observation。

## Step 8 — Schema + permission + tool copy

- TypeBox；
- description；
- permission mapper；
- settings 文案若需要。

## Step 9 — Controlled smoke

- WinForms harness；
- UIA；
- target guard；
- screenshot identity。

## Step 10 — Relevant validation

只跑：

```text
pnpm run test:computer-automation
pnpm run test:computer-automation-windows
pnpm run test:builtin-capabilities
pnpm run test:dimagent-debug
pnpm run typecheck
pnpm run build
git diff --check
```

如果 package script 名有差异，以实际 package.json 为准。

**不要跑完整 E2E。**

---

# 28. 最终验收标准

## Capability

- [ ] 后续 computer action 不再每次 spawn PowerShell。
- [ ] 可 inspect 指定 HWND。
- [ ] WindowInfo 有 client rect/origin/DPI。
- [ ] focus 真正验证 foreground。
- [ ] 可按窗口截图。
- [ ] 可 UIA inspect/find control。
- [ ] 可 UIA invoke button。
- [ ] 可 UIA set value。
- [ ] UIA 不可用时安全 fallback screenshot_window + click_client。
- [ ] client input 不需要 Agent 计算标题栏/DPI。
- [ ] HWND/PID 变化时拒绝输入。
- [ ] side-effect action 返回 post-action observation。
- [ ] 异步 dialog 可 wait_for_window。

## Safety

- [ ] old observation 不能作用于新 HWND。
- [ ] focus 失败不能继续 guarded input。
- [ ] ambiguous window/control 不自动选第一个。
- [ ] screenshot identity 与真实 target 一致。
- [ ] legacy desktop actions 保留但不是主推荐路径。

## Performance

- [ ] persistent host process reuse verified。
- [ ] 连续 20 readonly action 不产生 20 个 PowerShell。
- [ ] 无明显 orphan host。

## Tests

- [ ] contract PASS。
- [ ] Windows smoke PASS。
- [ ] builtin capability PASS。
- [ ] dimagent debug skill PASS。
- [ ] typecheck PASS。
- [ ] build PASS。
- [ ] diff check PASS。

---

# 29. 最终独立 Review

Codex 实现后必须做独立 review，不得只报告 tests pass。

必须逐项回答：

1. 是否还有正常 Computer Use 场景需要 Agent 自己写 PowerShell 获取 rect/DPI/client origin？
2. 是否还有“截图 A、点击 B”的路径？
3. `focus_window` 是否可能假成功？
4. title 相同的两个窗口是否会误选？
5. UIA 多个同名控件是否会误选？
6. 窗口关闭后相同标题的新 HWND 是否可能被旧 observation 操作？
7. 125%/150% DPI 下 client coordinate 是否正确？
8. 双屏负坐标是否能正确表达？
9. 新 action 的 permission 是否有漏网？
10. host stdout 是否可能被 PowerShell 日志污染？
11. host crash 是否会留下 pending Promise 永久挂起？
12. 测试是否真正验证了 Computer Use 行为，而不是只验证注册？

发现 P0/P1 必须同一任务内修完后再交付。

---

# 30. Codex 最终交付格式

最终只需要简洁给：

```text
Implemented
- persistent host
- window identity
- verified focus
- screenshot_window
- UIA
- client input
- target guard
- post-action observation

Evidence
- contract test ...
- Windows smoke ...
- typecheck ...
- build ...

Known limitations
- ...

Git
- branch
- HEAD
- status
```

不要输出大量中间日志。

---

# 31. 最终产品判定

完成后的目标不是：

> MyBuddy 能移动鼠标。

而是：

> MyBuddy 能可靠识别一个 Windows 窗口、观察它、优先使用 accessibility 语义操作；语义不可用时能够对该窗口本身截图并使用窗口客户区坐标进行有 target guard 的真实输入，而且可以验证动作发生在正确目标上。

完成后再用 Waku Reader 原问题重新跑 `dimagent-debug`。理想路径应收敛到：

```text
inspect_window(Waku)
→ inspect_controls(Waku)
→ [UIA unavailable]
→ screenshot_window(Waku)
→ click_client(Waku, x, y)
→ newWindows: folder dialog
→ inspect_controls(dialog)
```

如果仍然需要大量：

```text
GetWindowRect
crop
full desktop screenshot
manual DPI arithmetic
absolute coordinate click
```

则说明 Computer Use Foundation 仍未真正完成。
