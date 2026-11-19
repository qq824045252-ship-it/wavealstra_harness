# Computer Use reliability

## 2026-11-19 实际使用检查

一次“保存到工作空间”的任务留下了三条未解决的 `ui-element-not-found`。其中两次的点击参数与上一步 `find` 返回的引用逐字相同。模型随后尝试在 `.workspace-popup` 内定位，工具校验拒绝了 `within` 参数。最后一次失败后的截图显示聊天页，原先的“保存 Gadget 副本”弹窗已离开。记录可以确定这几步的先后顺序，触发页面切换的来源仍未知。

| 环节 | 已补齐的行为 | 验收依据 |
| --- | --- | --- |
| 看清界面 | `status` 列出当前可用界面及动作。主界面快照在同一次文档读取中取得正文和控件。`within` 限定弹窗，`elementsTotal`、`elementsTruncated` 和 `textTruncated` 提醒模型何时需要缩小范围。 | 限定弹窗的快照排除页面同名按钮。24 个匹配项返回前 20 个时，等待仍能发现第 24 个可见控件。 |
| 找到目标 | `find/inspect` 和动作共用 `within`、`role/name`、`exact`、`label`、`placeholder`、`testId`。可在同一次点击中按弹窗和名称定位。 | 真实 WorkspacePicker 旁放置同名按钮，检查实际选中的工作空间。 |
| 操作控件 | 模型可调用 `hover`、`check`、`select` 和指针 `drag`，也能指定右键、双击、修饰键和逐字符输入。 | 通过注册给模型的工具检查勾选值、选项、悬停事件和拖动终点。 |
| 控件消失 | 当前文档保留最近 512 条有角色和名称的控件线索。旧引用被拒绝后，工具只读查找同区域同名候选。原弹窗消失会返回区域状态。模型核对候选后才能再次输入。 | React 菜单关闭又打开后，新引用可以选择正确项。整个弹窗重建时，旧引用无法点击页面上的同名控件。 |
| 判断结果 | 输入动作可带 `after`，在同一时间预算内等候指定控件出现或消失。回执分别说明输入是否派发、是否收到确认、预期界面是否出现。预期落空时返回 `stage=verify`。 | 已点击但目标状态未出现，应用只收到一次点击。仅收到按下事件就消失的控件，结果保留为未知。 |
| 决定谁处理 | 输入前的普通定位失败直接交给模型重新观察。输入已经产生影响或结果未知时显示恢复提示。旧的普通定位提示按读取规则过滤，原始任务证据保留。原生桌面的错误结果也向模型提供有界的候选控件、完整可用的控件 ID、搜索截断信息和恢复建议。 | SQLite 恢复测试区分定位失败与已派发错误。原生错误序列化测试覆盖候选标识和截断。 |

### 这次在 Windows 上实际走过的流程

Windows 发布验收任务里，Agent 调用 `find_control(control_name="RELEASE_FIXTURE_OK", control_type="Text", timeout_ms=3000)`。当时 Windows 只查了一次，随后读取的 UIA 树和 OCR 结果都没有这个标记。现在 Windows 在给定等待时间内重新读取同一窗口，到期再检查一次。完整读取后仍缺失会返回 `matched: false`、查找条件、读取次数和耗时。输入动作仍需唯一的实际控件。树不可读、搜索截断和窗口消失各有独立结果。

- `test:computer-use-control-lookup-electron` 通过模型使用的 `computer_exec` 工具和真实 Windows UIA 验证等待文本出现、到期未找到、动作预检失败、浅层搜索截断、等待期间关窗，以及提交按钮的点击次数为零。
- `test:computer-use-recovery` 通过 SQLite 验证历史只读查找落空的提示退出恢复列表，原始记录保留。窗口读取故障和结果未知的输入仍然可见。

- `test:ui-workspace-picker-electron` 使用注册给模型的工具、真实 Electron 输入事件和产品的 GadgetMoveDialog / WorkspacePicker。测试提供隔离的工作空间列表，并核对复制 API 收到的调用次数和目标 ID。
- `test:gadget-save-workspace-desktop` 启动完整开发版，用真实菜单保存副本，核对独立目录、文件内容和预览服务。重新加载界面后，保存的副本仍可打开。这个用例使用临时用户目录与数据库。
- `test:computer-use-agent-desktop` 经 AgentService 调用界面和 Windows 工具，验证点击后的指定状态、原生控件调用、截图之后的物理点击，以及最终回复写入任务历史。模型端使用固定脚本，测量真实模型临场选择工具的成功率仍需单独验收。

### 平台与剩余边界

| 界面 | 用户可用的路径 | 当前边界 |
| --- | --- | --- |
| MyBuddy 主界面、Artifact | `ui_exec` 的 DOM 与 Electron 输入 | 弹窗已关闭时需要重新进入。目标业务是否完成，取决于请求方选择的验收条件。 |
| MyBuddy 内置网页 | `browser_exec` 可定位标签页、frame、开放 Shadow DOM，也有基于截图的操作 | 封闭 Shadow DOM 没有普通 DOM 遍历能力。网页任务需要通过浏览器自己的上下文观察。 |
| Windows 原生应用 | `computer_exec` 可用 UIA、窗口截图、OCR 和绑定到窗口的输入 | 第三方控件导出的信息、焦点以及输入是否产生预期业务结果，都需要在目标应用中核对。 |
| Linux 原生应用 | Hyprland / Wayland 上的 AT-SPI、合成器窗口信息和已校验输入 | 需要真实桌面会话。缺少可信对象或坐标时会拒绝输入。 |
| macOS 原生应用 | 平台探测会说明不可用 | 跨应用原生后端尚未实现。 |

## 2026-11-03

## Root causes and scope

Real task sessions were inspected read-only. The SerialPortTool task “帮我把项目跑起来” did produce real application screenshots and normal terminal events. Other recent MyBuddy task sessions exposed concrete harness failures: `snapshot:120` was returned as a locator but later passed to `querySelectorAll`; `ui_exec(target=app)` selected `__MYBUDDY_COMPUTER_USE_CONTROLS__`; conflicting `action=list_windows` and `actions=[...]` ran the batch against a dummy PID. These are orchestration and contract defects, not evidence that native input is universally broken.

The historical optional-parameter serialization problem had already been corrected separately. This change rejects contradictory modes at runtime too, before window lookup or input. The exact cause of every historical residual overlay cannot be reconstructed from terminal events alone. Native reproduction confirmed the cancelled settlement path skipped cleanup when cleanup depended on notification lifecycle emission.

## Changed contracts

- App UI automation binds the main BrowserWindow explicitly. Creating a CU overlay or another BrowserWindow cannot change `target=app`.
- UI snapshots return actual CSS references attached to exact DOM nodes. Reordering preserves identity; replacing a node, navigating, or taking a new snapshot invalidates old references. Ambiguous, disabled and covered elements fail before clicking.
- CU lifetime belongs to the execution. Settlement, abort, session release and disposal release it independently of notifications. A late old-turn completion cannot close a new turn. Nested scopes cannot resurrect a user-cancelled run.
- Windows overlay visibility belongs to the desktop operation, not the whole Agent reply. After an operation completes, the existing 260 ms deadline retracts both native windows while leaving CU permission active. A following operation reopens them and cancels any previous hide deadline; only explicit Stop revokes the execution. This corrects the previous test contract that required indefinite `waiting` visibility during non-desktop work.
- Windows operations serialize entire observe/act/verify transactions. Cancelled queued input never reaches the desktop. A partial batch reports the completed steps and is never replayed as a whole.
- Changes to HWND identity, PID, class, client geometry or DPI invalidate observations. Recovery must obtain fresh evidence before sending input; it cannot remove `observation_id` and replay old coordinates, including when a focus retry coincides with a DPI change.
- A captured screenshot is reported as captured. Successful input is `executed`; business success is `verified` only when explicit `expected_outcomes` pass.
- Windows UIA inspection defaults to depth 10 instead of 6. `max_depth` can reach 32 and is passed through inspect/find/invoke/set. Actions bind the exact control runtime ID seen in their preview. Incomplete searches still cannot claim that a name is unique.

## Which interaction path is used?

| Surface | Structured path | Fallback |
| --- | --- | --- |
| MyBuddy renderer, embedded browser, Artifact | `ui_exec`: DOM, role/name, CSS references, Electron input events | screenshot |
| Windows applications | `computer_exec`: UI Automation control tree, runtime ID/automation ID, Invoke/Value patterns | OCR, screenshot and client coordinates |
| Linux Omarchy/Hyprland/Wayland | `computer_exec`: AT-SPI object references, Action/EditableText/Value; Hyprland logical geometry and cursor readback | Explicit unsupported capability when no reliable structural target exists; screenshots remain independent observation |
| Canvas or applications without usable accessibility controls | exposed application API where available | Windows may use visual observation; Linux requires a reliable structured interface/bounds or reports unsupported |

UIA is returned as structured JSON, not XML. Coordinates are an input method; vision and UIA are observation/targeting methods. They can be combined. Client-DIP coordinates from a matching window screenshot must not be confused with desktop physical pixels. Linux uses the TypeScript AT-SPI/Hyprland backend described in [linux-computer-use.md](linux-computer-use.md). Its discovery, targeting, input and verification paths have no screenshot/OCR fallback. Windows acceptance does not prove Wayland behavior.

## Regression coverage

| Command | What it proves |
| --- | --- |
| `pnpm -s test:computer-use-boundaries` | contradictory/empty/oversized requests have no Host effects; stale size/DPI/PID/class rejects singles and batches; title changes remain valid; truthful screenshot verification; old-turn isolation; nested cancellation; queued cancellation; partial batch failure; three simultaneous eight-step batches do not interleave |
| `pnpm -s test:computer-use-behavior` | real Electron snapshot-to-click round trip; reorder/replacement/navigation; ambiguity/disabled/occluded targets; Unicode fill and Ctrl+A; idle retraction without final/Stop; later CU reopens without permission loss; same-task/cross-task hide races; explicit Stop still revokes; native windows hide on normal/aborted/error settlement |
| `pnpm -s test:computer-automation-windows` | actual Windows UIA and physical input, DIP screenshots, stale window identity, host cancellation, in-flight crash and restart |
| `pnpm -s test:computer-use-overlay` | actual border, hittable Stop, click-through areas, automatic retraction/reopening and scoped Stop |
| `pnpm -s test:computer-use-agent-desktop` | real AgentService and Responses tool wire: CU → main-app DOM snapshot/click while overlays exist → truncated then deeper native UIA inspection/invocation → screenshot → physical coordinate click bound to that observation → final; cancellation while provider is held; provider EOF after CU; both native windows hidden |

The last test scripts only the model endpoint; it does not replace the AgentService, native host, adapters or overlay. It uses an isolated HOME/userData with fake credentials. Set `MYBUDDY_DESKTOP_EXECUTABLE` to a packaged `MyBuddy.exe` to run the same chain against the actual distribution; the test verifies the packaged main bundle hash against the built source. `MYBUDDY_CU_TEST_OUT` selects the diagnostics directory. Native desktop tests must run sequentially to avoid competing for focus.

These checks intentionally assert visible effects and terminal cleanup, not only returned tool success. They cover deterministic regression mechanisms, not arbitrary model planning or every third-party application's accessibility implementation.


## Linux replacement and evidence boundaries

Linux now serializes complete observe/act/verify transactions, including structured observations and batches. Window handles remain opaque Hyprland address strings. AT-SPI references include bus connection generation, unique bus/object identity, window identity and observation; queries are bounded and truncation is explicit. A successful D-Bus action reply only proves that the request was accepted. Readback failure, timeout and cancellation can leave execution unknown; none authorizes replay of a click, toggle, submit or whole batch.

Linux pointer movement uses compositor logical coordinates and a real `cursorpos` readback. It does not initialize from a screenshot or multiply global coordinates by a monitor scale. A control at `(0,0)` is not rejected merely for its origin. Units, client mapping, current layout and target identity must be established before using bounds. Held key/button ownership survives successful calls and is released explicitly at task cleanup; an independent input guardian also handles parent IPC loss.

The focused headless suites are `test:platform-computer-use`, `test:atspi-driver`, `test:atspi-transport`, `test:linux-native-backend`, and `test:linux-worker-packaging`. The real transport test starts isolated D-Bus daemons and fixture services; it is not a GTK/Electron desktop test. `test:computer-use-linux` and `test:computer-use-linux:packaged` are strict GUI gates with dedicated targets, capture/OCR blockers and application-side event/state assertions. They fail when the actual graphical session or a required fixture is absent. Detailed commands, evidence paths and current validation limits are recorded in [linux-computer-use.md](linux-computer-use.md).
