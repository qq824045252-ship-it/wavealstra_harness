# MyBuddy Computer Use 评估（2026-10-19，沙箱放开后复测）

> 评估对象：仓库内 `computer_exec`（Windows 原生 Computer Use）当前实现与真实使用数据。
> 结论先行：三个抱怨都成立，但复测修正了首版的耗时归因——
> ① 应用确实没有可用的 UIA 语义树，只能退回整屏像素（实测 0–3 个控件）；
> ② 自动化层和采集并不慢（窗口截图 0.4–0.6s、点击 0.7–1.1s），**单步耗时的大头是模型回合（3.7–9.1s）**，且随会话上下文增长；
> ③ 输入原语缺失（双击、修饰键、按住、拖拽时长、跨窗口拖拽、后台输入、滚动量）依然成立；
> ④ 首版把"委托视觉"的耗时混进了截图耗时中位数：原生多模态下 `screenshot_window` 623ms，委托视觉下 10.3s；同时强制事后截图确实存在（点击从 0.72s 变 1.08s）。

---

## 0. 与首版的差异（复测修正）

| 项目 | 首版（沙箱内，GDI 代理） | 复测（真实 Electron 路径） | 影响 |
|---|---|---|---|
| 全屏采集 | 142 ms（GDI 代理） | **281 ms**（`desktopCapturer.getSources`） | 采集比代理慢约 2× |
| PNG 编码 | 79 ms（GDI） | **140 ms**（1400×900）/ **248 ms**（2560×1440） | 编码比代理慢约 2–3× |
| 图片归一化 | 1.0 s（所有截图） | **1.10 s 仅整屏**；窗口裁剪 1400×900 只需 **58 ms** | 首版把点击截图也算成 1 s，属高估 |
| `screenshot_window` | 中位 4.7 s（混合数据） | 原生 **621 ms**；委托视觉 **10.3 s** | 首版中位数被旧模型的委托视觉污染 |
| 点击耗时 | 约 1.0 s | 原生 **1.12 s**；无截图 **0.72 s**；纯文本模型 **0.50 s** | 强制截图可量化：+0.36 s |
| `list_windows` | 22 ms（无进程名） | **253 ms**（含进程名/DPI/显示器） | 首版低估约 10× |
| 模型回合 | 9.1 s | 干净会话 **3.7 s**；240k 长会话 **9.1 s** | 真正的大头 |

首版"单步约 10s、模型占 88%"的比例是对的；错在工具侧明细：把 GDI 代理当成 Electron、把委托视觉的 10.3s 混进 `screenshot_window` 中位数、把整屏才有的 1.10s 归一化算到每次点击头上。复测后工具侧是 0.7–1.3s/步，模型侧 3.7–9.1s/步。

---

## 1. 结论摘要

| # | 用户感受 | 判定 | 根因（一句话） | 严重度 |
|---|---|---|---|---|
| 1 | 无法聚焦某个应用，像全屏扫描 | **成立** | 应用没有 UIA 树（实测 0–3 个控件）；`screenshot` 固定截主显示器整屏；`screenshot_window` 也是"整屏截取后裁剪"且必须前台；叠加框按显示器矩形画；没有"应用会话"概念 | P0 |
| 2 | 速度慢，识别太慢 | **成立，但归因修正** | 单步 = 模型回合 3.7–9.1 s + 工具 0.7–1.3 s；截图本身不慢（窗口 0.6 s、整屏 1.1–1.3 s）；慢在"每个动作一轮模型"；文本模型下每张截图再叠加 10.3 s 委托视觉 | P0 |
| 3 | 操作鼠标限制大 | **成立** | 缺原语：双击/三击、修饰键+点击、mouse down/up、拖拽时长与步数、跨窗口拖拽、滚动量语义、后台点击、长文本粘贴 | P0/P1 |

---

## 2. 测量方法与数据来源（复测）

环境：Windows，2560×1440，100% DPI，Electron 44.5.1（与仓库 devDependency 一致；打包版若使用其他 Electron 版本，采集数字会有出入），无沙箱。

### 2.1 Automation Host（`windowsAutomationHostScript.ts` 原文，12 个可见窗口）

| 测量项 | 结果（中位） |
|---|---|
| 冷启动（`Add-Type` 编译 + UIA 装配） | **579 ms** |
| `active_window` | 14.4 ms |
| `list_windows`（12 窗口，含进程名/DPI/显示器） | **253 ms** |
| `inspect_window`（按 HWND） | 12 ms |
| `inspect_window`（按标题，走全量 `EnumWindows`） | **300 ms** |
| `inspect_controls`（6/300） | 36 ms（该窗口 2 个控件） |
| `find_control`（10/1000） | 68 ms（未找到） |

> 与首版差异：首版 22 ms 的 `list_windows` 是在进程名查询被沙箱拒绝的情况下测的；真实路径每个窗口要 `[Diagnostics.Process]::GetProcessById().ProcessName`，代价约 20 ms/窗口。

### 2.2 Electron 采集与编码（真实 `desktopCapturer`）

| 测量项 | 结果（中位） |
|---|---|
| `getSources(screen, 2560×1440)` | **281 ms**（244–312） |
| `thumbnail.crop(1400×900)` | ~0 ms |
| `crop.toPNG()`（1400×900） | **140 ms**（790 KB） |
| `thumbnail.toPNG()`（2560×1440） | **248 ms**（1.39 MB） |
| `crop.toJPEG(70)` | **5 ms**（109 KB） |
| `resize(1280×720).toJPEG(70)` | **9 ms**（90 KB） |
| `getSources(window)` 枚举 | 568 ms |

### 2.3 真实服务路径（`ComputerAutomationService`，Electron 内）

| 动作 | 结果（中位） | 备注 |
|---|---|---|
| `active_window` | 40.7 ms | 首次 1.38 s（Host 冷启动） |
| `list_windows` | 310.6 ms | 5 次 |
| `screenshot`（整屏） | **1.08 s** | 结果 PNG 1.38 MB |
| `inspect_window` | 33 ms | |
| `inspect_controls`（富 UIA 窗口） | 1.0 s | 控制台类窗口；Chromium 窗口为 4–36 ms（0 控件） |
| `focus_window` | 0.6 s（首次 1.1–1.5 s，含 Host 冷启动） | 真实会话 n=17 中位 568 ms |
| `click_client`（原始，无 taskId） | **719 ms** | 含动作前后观察 |
| `click_client`（Agent 策略，强制截图） | **1.08 s** | 截图 +365 ms，返回 8 KB（空白页） |
| `type_text`（20 字符，Agent 策略） | 940 ms | 含逐字符前台校验 + 强制截图 |
| `screenshot_window`（真实窗口，1200×800） | **395 ms** | 空白页；真实内容 0.4–0.7 s |

### 2.4 真实使用数据

数据源：`~/.mybuddy/sessions/**/*.jsonl` + `~/.mybuddy/app.db` 的 `usage_events`。

- 命中 `computer_exec` 实际调用的会话：**17 个**，调用 **126 次**。
- 按视觉路由拆分工具耗时：

| 动作 | 原生多模态 | 委托视觉 |
|---|---|---|
| `screenshot_window` | **621 ms**（n=9） | **10.26 s**（n=14） |
| `screenshot` | 1.31 s（n=3） | 0.57 s（n=4） |
| `click_client` | **1.12 s**（n=22，带强制截图） | 0.50 s（n=11，纯文本） |

- 工具结果 → 下一轮模型：中位 **9.1 s**，p90 26.6 s，最大 89 s。
- 模型回合（`usage_events`）：

| 会话 | 上下文（中位） | TTFT 中位 | 模型墙钟中位 |
|---|---|---|---|
| 2026-10-19 04:03（干净 CU 任务） | 42k tokens | **2.44 s** | **3.71 s** |
| 2026-10-19 06:45（CU + 长编码历史） | 241k tokens | **4.85 s** | **9.14 s** |

- 上下文构成（06:45 会话，约 240k tokens）：assistant 消息 **159.6k**（主要是 thinking 历史）、`toolResult` **80.9k**、`computer_exec` 仅 **8.5k**、图片 7 张（约 8.4k）、system prompt 约 14.4k 字符（≈5k tokens）。
- 图片：7 张，累计 **6.4 MB base64**；`screenshot` 单张 1.9M base64 字符。
- 压缩阈值 500k tokens（`settings.json: compactionTriggerTokens=500000`），全程未触发。

> 结论：CU 自身内容只占上下文的约 3.5%；"识别慢"更多是长会话的模型回合成本，而不是截图或视觉管线。

---

## 3. 逐条分析

### 3.1 "无法聚焦某个应用，像全屏扫描"

1. **语义层实际不可用。** `inspect_controls` 用 `ControlViewWalker`（`windowsAutomationHostScript.ts:378-415`）。实测：

   | 窗口 | 类 | 控件数 |
   |---|---|---|
   | MyBuddy | `Chrome_WidgetWin_1`（Electron） | **1** |
   | 腾讯会议 | `Qt680QWindowIcon` | **0** |
   | 粉尘仪确认窗口 | `Qt680QWindowIcon` | **0** |
   | WinPet | `Tauri Window` | 3（窗口外壳） |
   | DSH Shell | `MyGoWindow` | **0** |

   Electron / Qt / Tauri / 自绘窗口默认不向 UIA 暴露内容树，`find_control` / `invoke_control` 基本无对象可操作。

2. **观察是显示器级的。**
   - `screenshot`：`getPrimaryDisplay()` → `desktopCapturer.getSources` 全屏物理像素（`ComputerAutomationService.ts:383-396`）；只截主显示器，没有 `list_displays`。
   - `screenshot_window`：先截整块显示器再按窗口矩形 `crop`，缩到 DIP（`WindowCaptureService.ts:54-86`）；默认要求目标在前台（`ComputerAutomationService.ts:401-407`），**要观察窗口就必须抢焦点**。

3. **窗口身份只有一个可变字符串。** `Resolve-Target` 按标题子串匹配（`windowsAutomationHostScript.ts:293-305`）；重名 `WINDOW_AMBIGUOUS`，标题变化失配；客户区尺寸变化判 `STALE_OBSERVATION`（`ComputerAutomationService.ts:361-371`）。

4. **叠加提示框是整块显示器。** `dipBounds()` 用 `window.monitorRect`，注释明确是 "screen-level mode… whole controlled screen"（`ComputerUseOverlayService.ts:218-240`）。

5. **没有应用会话。** 每次调用重新传 `window_title`/`window_handle`；`list_windows` 全量枚举且**忽略调用方传入的 `window_title`**（host `windowsAutomationHostScript.ts:490`、服务层 `ComputerAutomationService.ts:221-224`）；本机 11–12 个窗口返回约 400 行 JSON，一次动作前/后各一遍。

6. **UI 里没有目标选择。** 渲染层只有能力开关（`CapabilitiesTab.tsx:518`），没有"选择应用/窗口"入口。

### 3.2 "速度慢，识别太慢"（复测后的正确归因）

#### 单步预算

```
干净会话（42k ctx）:  模型 3.7s ██████████████████  82%   +  工具 0.8s ████ 18%
长会话（240k ctx）:  模型 9.1s ████████████████████ 89%   +  工具 1.1s ███ 11%
```

#### 工具侧：主要是窗口枚举和强制截图，不是截图本身

1. **窗口截图 0.4–0.6 s**：getSources 281 ms + crop 0 + toPNG 140 ms + 归一化 58 ms。整屏 `screenshot` 1.1–1.3 s（整屏 PNG 248 ms + 归一化 1.10 s）。
2. **每次"会改状态"的窗口动作都被强制截图**：`prepareComputerUseInput` 无条件 `next.captureAfter = true`（`ComputerUsePolicy.ts:42-45`），显式 `capture_after:false` 也被覆盖——直接调用验证：`{action:"click_client", captureAfter:false, observeAfter:false}` 被改写为 `{captureAfter:true, observeAfter:true}`。实测点击从 **719 ms → 1.08 s**，且每次多返回一张 8–180 KB 图。设计文档要求 `capture_after=false`（`docs/plan/MyBuddy_Computer_Use_Foundation_Implementation_Plan.md:665-672`）。
3. **事后观察固定 2 次全量窗口枚举 + 150 ms**：`withObservation`（`ComputerAutomationService.ts:488-535`）；`list_windows` 单次 0.25–0.31 s（12 窗口），点击一步就 2 次。
4. **整屏截图的归一化 1.10 s**：Pi 默认 `2000×2000 / 4.5MB / jpegQuality 80`（`dist/utils/image-resize-core.js:8-15`），实现会 PNG + 5 档 JPEG 全编码（`76-88`）。窗口裁剪（1400×900）不触发缩放，只需 58 ms。
5. **文本模型下每张截图再叠加 10.3 s**：`visionAwareImageResult` 走委托 Vision（`builtin-capability-extension.ts:135-164`），126 次里 13 次命中；这会把 `screenshot_window` 从 0.62 s 拉到 10.3 s。

#### 模型侧：真正的大头，且随会话增长

- 干净 CU 会话：TTFT 2.44 s / 墙钟 3.71 s（42k ctx）。
- 长会话：TTFT 4.85 s / 墙钟 9.14 s（241k ctx）。
- 该长会话上下文构成：assistant 159.6k（thinking 历史）、toolResult 80.9k、computer_exec 仅 8.5k、图片 7 张约 8.4k。
- 每一步都要一轮模型，没有批量/脚本接口：126 次调用 = 126 轮模型。
- 图片常驻历史；整屏 PNG 1.9M base64/张，7 张 6.4 MB——对 240k 上下文来说 token 占比不大（约 3.5%），但**每轮请求体都要重传**，对上传带宽敏感。

### 3.3 "操作鼠标限制大"

| 能力 | 现状 | 代码位置 |
|---|---|---|
| 后台点击 | 无。`click_client` 先 `Focus-Target`，注入前 `Confirm-InputTarget` 校验前台 | host `457-470`、`472-479`、`557-563` |
| 双击/三击 | 无参数；只能两次独立调用（中间隔一轮模型） | schema `291-332` |
| 修饰键+点击 | 无 `modifiers`；`SendMouseClickAt` 不接收按键状态 | host `157-159` |
| 按住/松开 | 无独立 down/up | host `150-162` |
| 拖拽 | 固定 12 个绝对移动 + down/up 一次性发送，无 duration/steps | host `163-173` |
| 跨窗口拖拽 | 禁止：起终点必须同一客户区 | host `457-470`、`564-571` |
| 滚轮 | 单次原始 wheel（mouseData=120/格），无"行/页"语义、无平滑 | host `174-185`、`572-581` |
| 键盘 | 白名单键名，无 Win/Insert/PrintScreen/媒体键；无 key_down/up | `ComputerAutomationService.ts:103-115`、host `593-599` |
| 长文本 | 逐字符 `SendUnicode`，每字符两次前台校验；无剪贴板通道；上限 20k 字符 | host `601-625` |
| 坐标 | 客户区 DIP，越界 `POINT_OUTSIDE_CLIENT`；窗口一动 `STALE_OBSERVATION` | `windowsAutomationProtocol.ts:205-216` |

实测：`type_text` 20 字符 940 ms（含强制截图与逐字校验）；`focus_window` 真实会话中位 568 ms（首次含 Host 冷启动时 1.1–1.5 s）。多选 10 个文件 = 10 次点击 + 10 轮模型 ≈ 50–100 s。

---

## 4. 修复方案（按投入产出排序）

### P0 — 减少"每步一轮模型"的成本

1. **批量动作（收益最大）**：`computer_exec` 增加 `actions: [...]`（最多 8 个窗口作用域动作 + `settle_ms`），一次 Host 往返执行、只回最终观察；多步任务的模型轮数直接降 3–5×。
2. **停止强制事后截图**：`prepareComputerUseInput` 尊重 `input.captureAfter`，默认 `false`；实测点击 -0.36 s、-1 张图；事后观察保留窗口集合 diff，去掉固定 150 ms。
3. **截图端瘦身**：`WindowCaptureService.capture()` / `captureDesktop()` 直接输出 1280 宽 JPEG q70（实测 **9 ms / 90 KB**，对比 PNG 140–248 ms / 790 KB–1.39 MB）；整屏截图不再触发 1.10 s 归一化。
4. **图片生命周期**：历史截图只留最近 1–2 张，其余替换为占位文本；或落 artifact 只回路径 + 缩略图。整屏截图 1.9M base64/张，7 张 6.4 MB 的请求体重量可直接消掉。
5. **`list_windows` 瘦身 + 缓存**：支持 `process_id`/`title` 过滤，默认只回 `handle/pid/title/foreground/className`（几何按需），过滤输入法/托盘/工具窗口；300 ms 缓存 + 前台事件失效。单次 0.25–0.31 s × 2 次/动作。

### P1 — 让"聚焦应用"成为一等能力

6. **应用会话**：`attach_app(process_name/class/title)` → `app_session_id` + 客户区 + DPI；后续动作默认作用于它；overlay 改为窗口矩形；`screenshot_window` 不再要求每次前台。
7. **后台捕获**：Host 增加 `PrintWindow(PW_RENDERFULLCONTENT)` / Windows.Graphics.Capture，非前台窗口也能截；`getSources(window)` 枚举本身 568 ms，不适合当主路径。
8. **语义增强**：Chromium/Electron 优先 CDP；Agent 启动的外部 Chromium 加 `--force-renderer-accessibility`；UIA 为空时用本地 OCR + Set-of-Marks 编号，模型点编号而不是猜像素。
9. **输入原语**：`click_count`、`modifiers`、`mouse_down/up`、`drag duration/steps`、`scroll amount(unit)+duration`、`key_down/up`、`paste_text`；可选后台输入（`PostMessage`）。
10. **Host 生命周期**：取消/超时按请求 id 取消而不是 `terminateHost`（`WindowsAutomationHost.ts:100-114`），避免每次 Stop 后 579 ms 冷启动。

### P2

11. 自动 O-A-V 改成证据驱动；`wait_for_window` 替代 sleep。
12. 多显示器：`list_displays` + 任意显示器截图 + 跨屏拼接。
13. 视觉路由策略：文本模型下避免"每步截图"，改为按需截图或使用原生多模态模型（委托视觉 10.3 s/张）。

---

## 5. 验收建议（复测基准）

| 指标 | 现状（复测） | 目标 |
|---|---|---|
| 单步工具耗时（窗口截图） | 0.4–0.6 s | ≤0.4 s |
| 单步工具耗时（点击，Agent 策略） | 1.08 s | ≤0.6 s |
| 整屏截图 + 归一化 | 2.2 s | ≤0.6 s（JPEG 直出） |
| 每张截图请求体 | 1.9 MB base64（整屏） | ≤200 KB |
| 每步模型回合 | 1 轮（3.7–9.1 s） | 批量后 1 轮覆盖 3–5 个动作 |
| 10 步任务总时长 | 50–100 s | ≤30 s |
| 窗口定位依据 | 标题字符串 | 应用会话 + HWND/PID 双校验 |
| 首屏观察 | 整屏 2560×1440 | 应用窗口级 |

复用脚本：`out/tmp/cu-host-bench.cjs`（Host RPC）、`out/tmp/capture-bench2.cjs`（Electron 采集/编码）、`out/tmp/cu-live-bench.ts`（服务路径）、`out/tmp/cu-click-bench.ts`（点击/输入 + 强制截图）、`out/tmp/resize-live.mjs`（归一化）、`out/tmp/cu-route-split.cjs`（原生/委托拆分）、`out/tmp/context-composition.cjs`（上下文构成）。

---

## 6. 附：为什么不是"模型不行"

- 长会话 222 次模型调用里 205 次以工具调用收尾，规划是连续的；126 次 CU 调用只有 4 次失败（焦点/截图/超时）。
- 干净 CU 会话模型回合 3.7 s，长会话 9.1 s——差异来自上下文，不是 CU 逻辑。
- CU 自身在上下文里只占约 3.5%（8.5k / 240k），工具耗时 0.7–1.3 s；可优化空间主要在"每步一轮模型"和"强制截图/窗口枚举"。
