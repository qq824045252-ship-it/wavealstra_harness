# Ardot 画布联动：集成实现与排障记录（已回滚）

> ⚠️ **2026-08-07 已整体回滚**：用户决定删除全部画布定制逻辑（右侧画布联动 / 免登录注入 / 产物快捷方式 / 自动加载 / 任务隔离），恢复为通用浏览器。以下内容保留作历史排障记录。
>
> 回滚范围：`src/main/mcp/ardotCanvas.ts`、`ardotAuth.ts`、`src/main/canvas/ArdotCanvasHost.ts`、`McpRuntimeService` Ardot 联动、`CanvasIpc`/`McpIpc.canvasEvent`/`requestArdotCanvas`、preload `mcp.canvas`/`onArdotCanvas`、appStore `ardotCanvasByTask`/`ardotCanvasGlobal`、App/BrowserView/ArtifactRail/OverviewView 画布逻辑、`global.css` `.ardot-canvas-*`、画布专用脚本（7 个）与 `remote-debugging-port 9223`。**Ardot MCP 接入与技能（AI 读写设计稿）保留不变。**

---

# （原文档正文，历史记录）

> 项目：MyBuddy（Electron + electron-vite + React/zustand）
> 日期：2026-08-07（第三版：补齐自动加载 + 任务隔离 + 实现细节）
> 范围：Ardot（腾讯设计）MCP 接入 + 右侧画布自动打开 + 免登录 + 原生浏览器视图

---

## 一、背景与目标

用户在 MyBuddy 中使用 **Ardot（腾讯 AI 原生设计工具）**，需求链路：

1. **MCP 接入**：MyBuddy 的 AI 能通过 MCP 读写 Ardot 设计稿（.ardot）
2. **技能安装**：按 Ardot 官方 Skill 规范（Anthropic Agent Skills 标准）安装设计技能
3. **画布联动**：AI 操作 Ardot 时，MyBuddy **右侧自动展开 Ardot 网页画布**，实时看到设计效果
4. **免登录**：利用 Ardot 客户端已登录态，画布免二次登录

**核心矛盾**：画布是"全局的"（Ardot 客户端当前只有一个活跃文件），但 MyBuddy 的 UI 是"任务级的"（右栏产物面板绑定任务）。如何让画布自动出现、又不串到无关任务，是本功能反复迭代的焦点（见 §8 排障 #2 / #9）。

---

## 二、Ardot MCP 安装

### 2.1 MCP 服务器（本地，官方推荐）

```jsonc
// ~/.mybuddy/mcp.json → mcpServers
"ardot-local": {
  "url": "http://127.0.0.1:50501/api/v1/mcp"
}
```

- 端点由 **Ardot 桌面客户端内置 `mcp-server.exe`** 提供（`C:\Program Files\Tencent\Ardot\resources\ArdotMCP\`）
- 客户端启动并打开设计文件后，50501 监听（实测握手：`serverInfo: ardot v0.0.0`，**19 个工具**）
- ⚠️ 曾有重复条目 `ardot` + `ardot-local`（早期遗留），已清理为单一 `ardot-local`（AI 会话实际加载的是它）——**服务器名不匹配曾导致联动全 skip**（见排障 #3）

### 2.2 技能（按 Ardot 官方 Skill 规范）

```
~/.mybuddy/skills/ardot/
├── SKILL.md                    # frontmatter(name/description+Triggers/metadata) + 五段式正文
└── references/
    └── mcp-tools.md            # 19 工具清单 + batch_edit 规则（Workflow 强引用）
```

- 市场源：`mybuddyskills-main/connectors/ardot/`（connector-meta + mcp.json + skills，canva 同构，不入 git）
- 官方示例（供 Ardot 客户端上传）：`docs/ardot-skill-examples/`（hello-ardot、grid-generator-v0.3.1）
- 官方文档：docs.ardot.tencent.com（`/ardot-mcp.html`、`/skill-dev-guide.html`、`/skill-dev-guide-templates.html`）

### 2.3 关键技术发现：客户端 token 可直通 Web API

Ardot 客户端登录 token（`AppData\Local\Ardot\ardot.tencent.com\web_local_storage.json` 的 `authToken`，JWT）可直接作为 **Bearer** 调用 Web 画布 API（实测 `files/{id}` / `user` / `view` 均 200）。这是免登录画布的基础（见 §4.2）。

---

## 三、整体架构

### 3.1 链路总览（两条并行的触发路径）

```
┌─ 路径 A：启动自动加载（2026-08-07 第二轮新增）
│   App 挂载 1.5s → requestArdotCanvas IPC
│       → 主进程 fetchArdotFileInfo 直查本地 50501
│       → Ardot 客户端开着设计文件才广播 canvasEvent
│       → renderer onArdotCanvas → 打开画布（不可达则静默，不打扰）
│
└─ 路径 B：AI 工具调用检测（第一轮实现）
    AI 在本任务中调用过 ardot 工具（ARDOT_MCP_TOOLS 19 个命中）
        → 600ms 延迟 → requestArdotCanvas IPC（同上 → 广播 → 弹画布）

两条路径汇合于：
    renderer 收到 canvasEvent（McpIpc.canvasEvent）
        → ①写全局 ardotCanvasGlobal（无任务也能恢复）
        → ②有活跃任务：写任务级 ardotCanvasByTask[taskId] + setBrowserUrl(url)
        → ③无活跃任务：openArdotCanvasGlobal(url) 直接开全局面板
        → BrowserView 渲染占位 div（.browser-wcv-host）
        → ResizeObserver 上报 bounds → browser.setRect IPC
        → 主进程 DesignModeService WebContentsView 加载画布页（真 Chromium + token 注入）
```

### 3.2 分层职责

| 层 | 模块 | 职责 |
|---|---|---|
| 主进程 | `mcp/ardotCanvas.ts` | MCP 直连：拿 fileId / 构造画布 URL |
| 主进程 | `mcp/ardotAuth.ts` | 免登录：token 注入到 default session |
| 主进程 | `mcp/McpRuntimeService.ts` | 广播调度：状态事件 → 节流 → fetch → broadcast |
| 主进程 | `browser/DesignModeService.ts` | **实际生效的画布宿主**：WebContentsView 生命周期 |
| 主进程 | `canvas/ArdotCanvasHost.ts` | ⚠️ 遗留：早期 CanvasIpc 宿主，renderer 已改用 browser API（见 §4.4） |
| IPC | `shared/agent-ipc.ts` + `preload/*` | 通道定义 + contextBridge 暴露 |
| 渲染 | `App.tsx` | 事件订阅 + 触发检测 + 面板条件 |
| 渲染 | `store/appStore.ts` | 三张状态表 + 打开/关闭 action |
| 渲染 | `BrowserView.tsx` / `ArtifactRail.tsx` / `OverviewView.tsx` | 占位 div / 快捷方式 / 重开入口 |

---

## 四、主进程实现（详细）

### 4.1 `src/main/mcp/ardotCanvas.ts` —— MCP 直连

**端点**：`ARDOT_MCP_ENDPOINT = "http://127.0.0.1:50501/api/v1/mcp"`（streamable HTTP）
**画布 URL**：`ARDOT_WEB_BASE = "https://ardot.tencent.com/file"`，`ardotCanvasUrl(fileId) = ${base}/${fileId}`

**`fetchArdotFileInfo()` 协议三步**（Node 原生 fetch，不依赖 pi-mcp-adapter）：

1. **initialize**（id:1, protocolVersion `2025-06-18`）→ 拿响应头 `Mcp-Session-Id`
2. **notifications/initialized**（fire-and-forget，失败忽略）
3. **tools/call** `fetch_file_info`（id:2）→ 解析 SSE 响应取最后一条 `data:` 的 JSON

**解析规则**：
- SSE 按 `\ndata: ` 切分取最后一段（`parseSseMessage`）
- `tools/call` 返回 `content[]`，取第一个 `type === "text"` 块 → JSON.parse
- 判定条件（任一不满足返回 null）：`parsed.success` 为真、`data.fileId` 存在、text 不含 `NO_ADAPTER`、`isError` 非真
- **全部失败静默返回 null**（Ardot 客户端未运行 / 未打开文件 / 端口未监听 / 超时 8s）

### 4.2 `src/main/mcp/ardotAuth.ts` —— 免登录注入

```
token 来源：%LOCALAPPDATA%\Ardot\ardot.tencent.com\web_local_storage.json
读取：正则 /authToken=([^;\s]+)/ 提取 JWT
注入：session.defaultSession.webRequest.onBeforeSendHeaders
      urls: ["https://ardot.tencent.com/*"]
      对所有匹配请求头加 Authorization: Bearer <token>
```

关键点：
- **幂等**：模块级 `injected` 标志，启动时 `setupArdotAuthInjection()` 只执行一次
- **注入对象是 defaultSession** → 所有用它创建的 WebContentsView（含 DesignModeService 画布宿主）都生效——这是"白屏修复"的根本（排障 #5/#6 的后续）
- **降级**：客户端未安装 / 未登录 / 读文件失败 → 打 warning 返回 false，不阻塞应用（画布页会走登录页兜底）

### 4.3 `src/main/mcp/McpRuntimeService.ts` —— 广播调度

```
MCP 状态事件（adapter.MCP_STATUS_EVENT）
  → statusSnapshot 存档 + broadcast(McpIpc.statusEvent)
  → maybeNotifyArdotCanvas(snapshot)：
      仅当存在 ardot / ardot-local 且 status === "connected" 才调度
  → scheduleArdotCanvas(force=false)：
      1.2s 节流（ardotCanvasTimer 去重，状态事件风暴只调度一次）
      fetchArdotFileInfo() → 无 info 直接 return（不可达静默）
      按 fileId 去重（lastArdotCanvasKey，force 时跳过）
      broadcast(McpIpc.canvasEvent, { url, fileId, fileName, server:"ardot" })

renderer 主动拉取：ipcMain.handle(McpIpc.requestArdotCanvas)
  → requestArdotCanvas() → scheduleArdotCanvas(true)   // force，无视去重
```

**设计要点**：`requestArdotCanvas` **不依赖状态快照**（无活跃会话时快照为 null 会误 skip），直查 50501——这是排障 #4 的修复。

### 4.4 画布宿主：DesignModeService（实际生效） vs ArdotCanvasHost（遗留）

**实际生效的是 `src/main/browser/DesignModeService.ts`**（Design Mode 功能复用，BrowserView 通过 `window.api.browser` 驱动）：

- `attach(win)`：创建 `WebContentsView`（`contextIsolation: true, sandbox: true, nodeIntegration: false`，**无 preload**）；`did-navigate` / `did-navigate-in-page` 回传 URL（`BrowserIpc.urlChanged`）
- `open(url)`：空 URL → `close()`；协议补全 `https://`；**幂等**（与 `currentUrl` 相同不重复 load）；加载后 `setViewVisible(true)`
- `setBounds(rect)`：宽或高 `< 8px` 视为隐藏；记录 `lastBounds`
- 新窗口一律 `deny`（画布页不允许脱离宿主）
- **用默认 session** → ardotAuth 注入对其生效

**遗留 `src/main/canvas/ArdotCanvasHost.ts` + `CanvasIpc`**：
- 第一轮实现的画布专用宿主，`index.ts` 仍注册 `CanvasIpc.load/resize/hide` handler 并 `attach`
- 但 renderer 已完全改用 `browser.*` API，`mcp.canvas.*` 无调用方 → **死代码**，暂保留（避免动 index.ts 影响并行开发），后续可清理

### 4.5 `src/main/index.ts` 接线

```
setupArdotAuthInjection()                    // 启动即注入 token
attachDesignMode(win)                        // DesignModeService 挂主窗口
ipcMain.handle(McpIpc.requestArdotCanvas, …) // renderer 主动拉取
ipcMain.handle(CanvasIpc.load/resize/hide, …)// 遗留 ArdotCanvasHost（无调用方）
remote-debugging-port 9223                   // 排障临时开关，确认后可移除
```

---

## 五、IPC / Preload

### 5.1 通道表（`src/shared/agent-ipc.ts`）

| 通道 | 方向 | 载荷 | 用途 |
|---|---|---|---|
| `McpIpc.canvasEvent` | 主→渲染 | `McpCanvasEventDto` | 画布事件（url/fileId/fileName/server） |
| `McpIpc.requestArdotCanvas` | 渲染→主 | `{}` → `{ok}` | 主动拉取当前文件（force 广播） |
| `BrowserIpc.open` | 渲染→主 | `url` | 打开/关闭 WebContentsView（空串=关闭） |
| `BrowserIpc.setRect` | 渲染→主 | `Rectangle` | 同步占位 div bounds（DIP） |
| `BrowserIpc.urlChanged` | 主→渲染 | `url` | 画布页导航回传 |
| `CanvasIpc.load/resize/hide` | 渲染→主 | 见 DTO | ⚠️ 遗留，无调用方 |

### 5.2 DTO

```ts
export interface McpCanvasEventDto {
  url: string;        // https://ardot.tencent.com/file/{fileId}
  fileId: string;
  fileName?: string;
  server?: string;    // "ardot"
}
```

### 5.3 Preload 暴露（`src/preload/index.ts`）

```ts
mcp: {
  onArdotCanvas: (cb) => void,   // 订阅画布事件，返回退订函数
  requestArdotCanvas: () => Promise<{ok}>,
  canvas: { load, resize, hide }, // ⚠️ 遗留
},
browser: { open, close, setRect, onUrlChanged, … }  // 实际驱动画布宿主
```

⚠️ 排障 #8 教训：`canvas` 定义在 `mcp` 对象**内**，调用必须是 `window.api.mcp.canvas`，不是 `window.api.canvas`。

---

## 六、Renderer 状态模型（详细）

### 6.1 三张状态表（`store/appStore.ts`）

| 状态 | 类型 | 生命周期 | 用途 |
|---|---|---|---|
| `browserUrlByTask[taskId]` | `string` | 「清除预览」即删 | 当前活跃 URL，驱动 BrowserView 加载 |
| `ardotCanvasByTask[taskId]` | `{url,fileId,fileName?}` | 收到画布事件后常驻（任务会话内） | 产物栏快捷方式、任务隔离判断 |
| `ardotCanvasGlobal` | 同上 \| null | 收到画布事件后常驻 | 无活跃任务时兜底 + 自动加载恢复 |

**关系**：事件到达时三者全写（`setArdotCanvasGlobal` + 有任务则 `setArdotCanvas` + `setBrowserUrl`）；「清除预览」只删 `browserUrlByTask`，快捷方式靠 `ardotCanvasByTask` 存活。

### 6.2 `onArdotCanvas` 处理器（App.tsx，最终逻辑）

```ts
const info = { url: ev.url, fileId: ev.fileId, fileName: ev.fileName };
setArdotCanvasGlobal(info);                       // ① 全局缓存（永不丢）
if (activeTaskId) {
  setArdotCanvas(activeTaskId, info);             // ② 任务级持久化（快捷方式）
  setBrowserUrl(ev.url);                          // ③ 打开任务画布
} else {
  openArdotCanvasGlobal(info);                    // ④ 无任务：开全局面板
}
```

`setBrowserUrl(url)` 内部：删 `browserArtifactIdByTask[taskId]` → 写 `browserUrlByTask` → `panelMode:"browser"` → `panelOpen:true` → `panelWidth: canvasPanelWidth(sidebarCollapsed)`（主区 ~85%）。

### 6.3 触发矩阵（何时弹 / 不弹）

| 场景 | 弹画布？ | 机制 |
|---|---|---|
| Ardot 客户端开着文件 + MyBuddy 启动 | ✅ 弹到当前任务 | 启动 1.5s 自动加载（路径 A） |
| AI 在本任务调用过 ardot 工具 | ✅ 弹 | 工具检测（路径 B，每任务一次） |
| 切到无画布任务 | ❌ 不弹 | `canvasActive` 任务级隔离 |
| 切回有画布的任务 | ✅ 画布仍在 | `browserUrlByTask[taskId]` 缓存 |
| Ardot 客户端未运行 | ❌ 静默 | `fetchArdotFileInfo` 返回 null，不广播 |
| 无活跃任务 | ✅ 开全局画布 | `openArdotCanvasGlobal` |

`ARDOT_MCP_TOOLS`（19 个，App.tsx 顶部）：`fetch_editor_state, fetch_file_info, batch_read, capture_screenshot, capture_layout, fetch_variables, apply_variables, fetch_component_lib, fetch_guidelines, search_style_guide, build_style_guide, batch_edit, locate_available_space, create_new_page, scan_exportable_resources, export_nodes` …匹配规则：`t === a || t.endsWith(\`_\${a}\`) || t.includes(a)`（兼容前缀/命名空间变体）。

### 6.4 面板显示条件（App.tsx）

```ts
const canvasActive = useAppStore((s) =>
  s.activeTaskId
    ? Boolean(s.browserUrlByTask[s.activeTaskId] ?? s.ardotCanvasByTask[s.activeTaskId])
    : Boolean(s.ardotCanvasGlobal),
);
const showArtifactPanel =
  page === "chat" && panelOpen && activeTask &&
  ((activeTask.messages.length ?? 0) > 0 || canvasActive);
```

⚠️ 关键：`canvasActive` **必须任务级**（第一版用了全局短路 `Boolean(ardotCanvasGlobal) || …`，导致所有任务都弹画布——排障 #9）。`ArtifactPanel` 无任务时仅放行 `panelMode === "browser"`。

### 6.5 产物快捷方式（ArtifactRail / BrowserView / OverviewView）

- `ArtifactRail` 新增可选 props：`canvasShortcut?: {url,fileId,fileName?} | null` + `onCanvasOpen?`，在「产物」列表顶部渲染置顶项（`.ardot-canvas-shortcut`，accent 圆点 `.ardot-canvas-dot`）
- 点击 → 有任务 `setBrowserUrl(url)`，无任务 `openArdotCanvasGlobal(info)`
- 空态兜底：BrowserView `browser-link-item` 样式按钮（「Ardot 画布 · 文件名」）
- 覆盖：浏览器侧栏 / 概览页 / 悬浮产物列表

---

## 七、画布尺寸与坐标（遗留 #2 上下文）

**宽度计算**（`src/renderer/src/lib/panelWidth.ts`）：

```ts
canvasPanelWidth(sidebarCollapsed):
  main = window.innerWidth - (sidebarCollapsed ? 0 : 248)   // 侧栏 248px
  maxByRatio = main * 0.85                                   // 比全局 72% 更宽
  maxByChat  = main - 280 - 3                                // 聊天区下限 280
  max = max(200, min(maxByRatio, maxByChat))
```

**实测数据（CDP，窗口 1478×821）**：
- WCV 宿主占位 div rect = `{x:662, y:105, w:1022, h:678}`
- 右缘 662+1022 = **1684 > 1478**，右侧溢出 206px → 画布右侧工具栏被裁
- y=105 对应 titleBarOverlay 下缘，x=662 含侧栏 248 + 聊天区

**疑点**：按公式 main=1230 → 上限 947，但实测 w=1022（超过上限）——疑似面板宽度 CSS transition 中间态或 `panelExpanded` 全屏展开残留，`reportRect` 在 transition 结束/窗口变化后未再次校准。**待校准**：对比 `panelExpanded` 状态、transitionend 同步时机、与 titleBarOverlay 坐标换算。

---

## 八、排障记录（踩坑与根因）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 误装云端 OAuth MCP（`https://ardot.tencent.com/mcp`） | 初始理解错误，官方主推本地客户端 MCP | 改为本地 `127.0.0.1:50501`；云端条目删除 |
| 2 | 画布不自动打开 | ①广播时用户未进对话（`activeTaskId` 空 → `setBrowserUrl` 丢弃）；②启动兜底与任务进入兜底导致**所有任务强制弹右栏** | 删除无条件兜底；触发改为「检测到 ardot 工具调用」 |
| 3 | 状态快照 `ardot not-found`，联动全部 skip | **服务器名不匹配**：AI 会话实际加载的是 `ardot-local`（mcp.json 重复条目遗留），联动代码只查 `ardot` | 匹配兼容 `ardot`/`ardot-local`；清理 mcp.json 重复 |
| 4 | `requestArdotCanvas` 误 skip | 依赖 `statusSnapshot`（无活跃会话时为 null） | 改为直查本地 50501，不可达才不广播 |
| 5 | iframe 画布空白（98.7% 白屏） | 内嵌 HTML iframe 渲染能力受限（用户结论：浏览器本身不支持） | 升级为 **Electron 原生 WebContentsView**（完整 Chromium 渲染） |
| 6 | 画布网页打不开（401 登录页） | Web 画布页需登录态，MyBuddy 独立环境 | 客户端 token 注入（`ardotAuth`），免登录 |
| 7 | **build 全挂**：`pick-injector.ts:11:54 Unexpected "*"` | 并行开发文件注释里写了 `aria-*/data-*`，其中 `*/` 提前结束注释块（既有 bug，非本功能引入） | 注释措辞改为 `aria-* 与 data-*`（仅动注释，不动逻辑） |
| 8 | typecheck：`Property 'canvas' does not exist on type 'PreloadApi'` | **BrowserView 写错层级**：`window.api.canvas` 应为 `window.api.mcp.canvas`（canvas 定义在 mcp 对象内） | 修正调用路径 |
| 9 | **画布不自动加载 + 串到别的任务**（2026-08-07 第二轮） | ①`showArtifactPanel` 要求 `messages.length>0`，无消息任务右栏不渲染；②`onArdotCanvas` 无任务直接 `return` 丢弃；③`canvasActive` 用全局短路 → 任何任务都弹 | 见 §3.1 路径 A + §6.2/6.4 任务级隔离 + `ardotCanvasGlobal` 兜底 |

---

## 九、改动文件清单（本功能）

**新增：**
```
src/main/mcp/ardotCanvas.ts        # MCP 直连（initialize→tools/call）+ 画布 URL 构造
src/main/mcp/ardotAuth.ts          # 客户端 token 读取 + webRequest 注入（幂等）
src/main/canvas/ArdotCanvasHost.ts # ⚠️ 遗留（已被 DesignModeService 取代，保留待清理）
```

**修改：**
```
src/main/index.ts                       # 注入 + IPC + attach + 调试端口 9223
src/main/mcp/McpRuntimeService.ts       # 广播调度（节流/去重/force/直查 50501）
src/shared/agent-ipc.ts                 # CanvasIpc / McpIpc.canvasEvent / McpCanvasEventDto
src/preload/index.ts + index.d.ts       # mcp.onArdotCanvas / requestArdotCanvas / canvas.* / browser.*
src/renderer/src/App.tsx                # 事件订阅 + 双路径触发 + canvasActive 隔离 + 启动自动加载
src/renderer/src/store/appStore.ts      # browserUrlByTask / ardotCanvasByTask / ardotCanvasGlobal + actions
src/renderer/src/components/artifact/BrowserView.tsx  # WCV 占位 div + bounds 上报 + 空态重开
src/renderer/src/components/artifact/ArtifactRail.tsx # 产物栏 Ardot 画布快捷项
src/renderer/src/components/artifact/OverviewView.tsx # 概览产物栏支持重开
src/renderer/src/styles/global.css      # .ardot-canvas-host / .ardot-canvas-shortcut / .ardot-canvas-dot
src/main/browser/pick-injector.ts       # 注释 */ 笔误修复（既有 bug）
```

**配置 / 技能（运行态，不入 git）：**
```
~/.mybuddy/mcp.json                      # ardot-local（本地 50501）
~/.mybuddy/skills/ardot/                 # SKILL.md + references/mcp-tools.md
mybuddyskills-main/connectors/ardot/     # 市场连接器（gitignore）
docs/ardot-skill-examples/               # 官方示例 zip（已下载解压）
```

---

## 十、当前状态与遗留问题

### 已验证 ✅
- MCP：50501 握手成功，19 工具可用；`fetch_file_info` 返回 fileId（实测 `712213410906292` / 「新文件」）
- 免登录：客户端 token Bearer 直通 Web API（files/user/view 200）；`webRequest` 注入对 WCV 生效
- 广播链路：状态事件 → fetch → broadcast canvasEvent（日志确认）
- 自动加载：页面刷新后 panel/browserView/wcvHost 全渲染（CDP 实测）
- 任务隔离：切到无画布任务右栏不弹（CDP 实测）
- 画布渲染：WCV target 标题「新文件 - Ardot」、图层内容正常（非白屏）
- token 过期 / 调试端口：已按现状处理（用户确认）

### 遗留 / 待验证 ⏳（当前 2 项）
1. **坐标偏移**：实测 WCV 宿主 rect {x:662, y:105, w:1022}（窗口 1478×821）——右缘 1684 超出窗口 206px，画布右侧被裁；疑点见 §7（transition 中间态 / panelExpanded / titleBarOverlay 校准）
2. **面板结构**：用户曾反馈「少了某个部分」（对照 Ardot 客户端完整界面），画布正常渲染后需对比补全

### 已知边界
- 应用重启后 `ardotCanvasByTask`/`ardotCanvasGlobal` 为内存态，需启动自动加载重新拉取（路径 A）
- token 过期（如 2026-08-22）后需 Ardot 客户端重新登录 / refreshToken，当前未实现刷新
- ArdotCanvasHost + CanvasIpc 为死代码（保留待并行方收尾后清理）

---

## 十一、复现与验证命令

```bash
# 构建与类型检查
pnpm typecheck
pnpm build

# 画布链路日志（dev 模式）
Get-Content dev-out.log | Select-String '\[ArdotCanvas\]|\[ArdotAuth\]'

# 直连本地 MCP 拿 fileId（无 UI 验证链路）
node scripts/ardot-fetch-state.mjs

# CDP 诊断（MyBuddy 需带 9223 调试端口）
node scripts/mcp-status.mjs        # MCP 状态快照 + 触发画布
node scripts/probe-main.mjs        # 主窗口 DOM/占位 rect + 截图
node scripts/probe-wcv.mjs         # WebContentsView 画布页渲染状态（需画布打开）
node scripts/trigger-canvas.mjs    # 手动触发画布广播
```

**CDP 排障方法论**（无日志时的三层定位）：

1. **主进程层**：`http://127.0.0.1:9223/json/list` → 看是否有 `ardot.tencent.com/file/{id}` 的 page target（有 = WCV 已加载画布；标题「新文件 - Ardot」= 渲染成功非白屏）
2. **Renderer 层**：连 `localhost:5173` target → `document.querySelector('.browser-wcv-host')` 的 rect（有 = BrowserView 渲染 + bounds 已上报）；`.artifact-panel` 存在 = 面板打开
3. **事件层**：`window.api.mcp.onArdotCanvas(e => window.__x = e?.url)` 注册监听 → `window.api.mcp.requestArdotCanvas()` → 等 4s → 检查 `window.__x`（有 = 广播链路通，问题在 renderer 处理；无 = 主进程 50501 不可达或未广播）
4. **画布层**：连画布 target → `document.body.innerText.slice(0,80)`（有「草稿箱/文件/组件/图层」= 画布正常；`/drive/login` = 登录态失效）
