# MyBuddy Android Remote Access — Final Implementation Plan

> 状态：供 Codex 直接执行  
> 日期：2026-09-04  
> 仓库：`C:\Users\servi\Desktop\mybuddy`  
> 当前分支：`ui/welcome-home-v1`  
> Review 基线 HEAD：`e1369b3e33a7cdc97193d3cf30f7bce92691157e`

---

## 0. 执行纪律（Codex 必须先读）

本文件不是讨论稿，而是本次 Android Remote Access 的实施规范。除非代码事实与本文明显冲突，否则不要擅自扩需求、换架构或把任务改写成“通用远程 RPC”。

### 0.1 开始前必须确认

执行前先运行：

```bash
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

Review 时工作区已有、且与本任务无关的修改：

```text
.commandcode/taste/taste.md
.commandcode/taste/tools/taste.md
```

**不要修改、格式化、回滚、暂存或提交这两个文件。**

若执行时出现其它用户已有修改，也必须隔离，不得覆盖。

### 0.2 测试纪律

本任务禁止为了“保险”跑整个仓库的长测试 / 全量 E2E / 全量视觉回归。

只允许：

1. 新增 Remote Access 相关的纯 Node / contract / server 测试；
2. 受影响模块的既有小测试；
3. `pnpm run typecheck`；
4. `pnpm run build`；
5. Remote Web 自己的 `typecheck/build`；
6. 最后一次非常短的本地 HTTP/SSE smoke；
7. Android 只做能证明编译和壳启动的最小验证，不做设备长测。

禁止：

- `gate:v35`
- Wave 全套 E2E
- 全仓视觉 golden
- 长时间轮询
- 无关模块测试

发现无关旧失败时，记录，不顺手修。

### 0.3 Git 纪律

本任务先实现、验证、独立 review，**不要自动提交 Git**，除非用户后续明确要求。

---

# 1. 产品目标

## 1.1 一句话目标

给 MyBuddy 增加一个 **Android / Mobile Remote Client**：手机只负责远程查看和控制，Windows MyBuddy 继续作为 Agent、任务、Memory、Workspace、Project、Skills、MCP、文件权限和执行环境的唯一真源。

目标不是远程桌面，也不是把 Electron Renderer 强行塞进 Android WebView。

最终关系：

```text
Android / Mobile Web
        │
        │ HTTPS + SSE
        ▼
Tailscale Serve（tailnet 内）
        │
        ▼
127.0.0.1:3352
MyBuddy RemoteAccessServer
        │
        ▼
Remote Application Layer
        │
        ├── AgentService
        ├── AppDatabase / Task
        ├── Conversation Runtime
        ├── NotificationService
        ├── ProjectService
        └── Workspace authority

Windows Electron Desktop 仍按原路径运行：
Renderer → preload → IPC → Main
```

## 1.2 Android 第一阶段必须完成的用户能力

P0/P1 MVP：

- 查看 MyBuddy 在线状态；
- 查看任务列表；
- 查看 Workspace 层级（只展示名称，不下发绝对路径）；
- 查看 Project 摘要；
- 打开任务并恢复聊天历史；
- 发送新消息；
- 创建新任务并发送首条消息；
- 实时接收 Agent 流式回复；
- 实时看到工具状态；
- Stop / Abort 当前任务；
- 看到“等待工具审批”；
- 手机允许 / 拒绝工具审批；
- external-write 审批支持：拒绝 / 仅本次允许 / 允许该 task-dir；
- 手机断线重连后能够恢复当前等待审批；
- 查看通知中心；
- 标记通知已读；
- 设备配对、撤销设备；
- Android Token 安全存储。

第二阶段能力，架构预留但本轮不要为了它们扩大基础实现：

- 图片 / 文件上传；
- Artifact 完整预览；
- 文件树深度浏览；
- BTW；
- Subagent 聊天；
- Android Push/Firebase；
- 后台长连接增强。

明确不做：

- 远程 Terminal；
- 远程 Computer Use；
- 任意文件系统写入 API；
- MCP 管理；
- Skill / Expert 安装与卸载；
- 模型密钥/认证管理；
- 任意 Settings 写入；
- 任意 IPC 代理；
- 任意 `/invoke` 通用 RPC；
- 公网 Funnel；
- 将 PC Bridge/MCP 暴露给手机；
- 让 Android 自己跑 Agent Runtime。

---

# 2. 本次代码 Review 结论

以下结论来自当前实际代码，不是抽象建议。

## 2.1 已有能力：可以直接复用

### A. Agent 流已经有 Main-side observer

`src/main/agent/AgentService.ts` 已有：

```ts
private readonly patchListeners = new Set<(patch: AgentUiPatch) => void>();

onPatch(listener) { ... }
```

`dispatchPatch()` 同时向 Electron Renderer 广播并通知 `patchListeners`。

因此 Remote 不需要：

- 侵入 Pi SDK；
- 监听 Session 文件；
- 复制 Agent runtime；
- 从 Renderer 转发流。

正确路径是：

```text
AgentService.onPatch()
    → RemoteEventBus
    → SSE
```

### B. Agent 已经坚持主进程权威 cwd

`AgentService.prompt()` 当前明确：

- 根据 taskId 解析 canonical cwd；
- Renderer 传入 cwd 不作为执行权威；
- Project context、Mode、权限等在 Main 侧解析。

这是 Remote 必须保留的安全边界。

**Remote API 不允许出现 `cwd` / `sessionFile` 可写字段。**

### C. Conversation Runtime 已有 snapshot

现有：

```text
ConversationRuntimeSnapshot
├── todos
├── interactions
└── activeGoal
```

Remote 可以直接复用其语义，而不是重新造 Todo / Interaction 状态。

### D. NotificationService 已经是 Main 真源

`src/main/notification/NotificationService.ts` 已经具备：

- SQLite 持久化；
- dedupe；
- list / unread / read / dismiss；
- task.action_required；
- task.completed / failed；
- desktop delivery 与业务通知真源分离。

Remote 应读取这套通知，不另建 Android 专用通知表。

### E. Memory Gateway 是很好的 HTTP 安全实现参考

`src/main/memory/MemoryGatewayServer.ts` 已实现：

- `127.0.0.1` only；
- Bearer token；
- `timingSafeEqual`；
- Zod strict validation；
- request body size limit；
- `cache-control: no-store`；
- `x-content-type-options: nosniff`；
- `/healthz`；
- 生命周期 Controller；
- 授权对象；
- 原子 token 文件处理。

Remote Access Server 应学习这个模式，但不能直接复制它的 Origin 策略，也不要把 Memory MCP 路由并进 Remote。

### F. pnpm workspace 已具备独立客户端落点

当前：

```yaml
packages:
  - 'app/*'
  - 'shared'
```

因此新增：

```text
app/remote
```

是自然结构。

---

## 2.2 P0 问题：必须先解决

### P0-1：不能把 preload/IPC 直接网络化

当前 `src/preload/index.ts` 是非常大的 Electron API 面：Agent、DB、Workspace、Artifact、Browser、Terminal、MCP、Memory、Settings 等都在里面。

绝对禁止设计：

```text
POST /v1/invoke
{
  "channel": "db:xxx",
  "args": [...]
}
```

也禁止：

```text
Android → 远程调用 window.api
```

否则 Remote 等价于把 Electron preload 远程暴露，权限边界直接失效。

Remote 必须有独立的 **窄 Application API**。

---

### P0-2：新任务创建当前仍由 Renderer materialize

当前 `src/renderer/src/store/appStore.ts` 的 `sendMessage()` 在无 activeTask 时：

1. Renderer `uid()` 生成 taskId；
2. Renderer 创建 Task；
3. Renderer `db.upsertTask()`；
4. 再调用 `agent.prompt()`。

桌面 IPC 在本地可信 UI 环境下可以工作，但 Android 不应获得通用 DB 写权限。

Remote 必须新增 Host-side 命令服务：

```text
RemoteTaskCommandService
```

由 Main：

- 生成 taskId；
- 校验 spaceId / projectId；
- 解析默认 mode/model/permission；
- 生成首条消息 title；
- upsert task；
- 生成 userMessageId / assistantMessageId；
- 调用 `AgentService.prompt()`。

Android 只提交：

```ts
{
  text,
  spaceId?,
  projectId?,
  welcomeMode?,
  modePresetId?
}
```

禁止提交：

```text
cwd
sessionFile
absolute workspace path
credential
raw connector runtime path
```

---

### P0-3：断线重连无法可靠恢复 pending tool approval

当前待审批主要保存为：

```text
SessionEntry.pendingApprovals
SessionEntry.pendingExternalWrites
```

Map 中保存的是 resolver function。

实时审批 UI 信息来自 `tool_start(status=pending_approval)` patch。

问题：

Android 如果在：

```text
tool_start pending_approval
        ↓
手机断网
        ↓
重新打开 App
```

现有 `ConversationRuntimeSnapshot` 不含待审批工具，历史记录也不能保证包含“当前正在等待”的精确信息。

因此必须新增明确的：

```ts
PendingActionSnapshot
```

而不是让手机从 Notification 或历史文本猜。

建议结构：

```ts
interface PendingActionDto {
  taskId: string;
  assistantMessageId: string;
  toolCallId: string;
  tool: string;
  summary: string;
  detail?: string;
  dangerous: boolean;
  approvalKind: "tool" | "external-write";
  createdAt: number;
  externalWrite?: {
    targetPath: string;
    taskRoot: string;
    canonicalDir?: string;
  };
}
```

SessionRegistry 不应只保存 resolver，而应保存：

```ts
{
  resolve,
  action
}
```

或引入独立 `PendingActionRegistry`。

推荐独立 `PendingActionRegistry`，理由：

- resolver 生命周期和展示快照职责分开；
- 以后桌面、Remote、通知都可以读取同一 snapshot；
- 不污染 Conversation Runtime Todo / Goal 语义；
- 更容易测试。

必须做到：

- 发起审批时 register；
- approve/deny 后 remove；
- abort 后 remove；
- session release 后 remove；
- tool execution terminal 状态后不能残留；
- `listPendingActions(taskId?)` 为纯只读。

注意：应用进程重启会中止活跃 session，因此无需“跨 MyBuddy 进程重启恢复 resolver”。目标是 **Remote 网络重连恢复**，不是跨 Agent session 复活。

---

## 2.3 P1 问题：Remote DTO 必须重新定义

### P1-1：现有 TaskDto / SpaceDto 含内部路径

`TaskDto` 包含：

```text
sessionFile
cwd
```

`SpaceDto` 包含：

```text
path
```

这些不应成为 Android 默认 transport contract。

因此不能：

```ts
return db.listTasks();
return db.listSpaces();
```

直接 JSON 序列化。

必须做 Remote-safe mapper：

```text
Internal DTO
   ↓
RemoteDtoMapper
   ↓
Remote DTO
```

例如：

```ts
interface RemoteTaskSummary {
  id: string;
  title: string;
  spaceId?: string | null;
  projectId?: string | null;
  status?: string;
  updatedAt: number;
  welcomeMode?: "working" | "coding" | "design";
  modelId?: string;
  permissionMode?: "default" | "readonly" | "auto";
  archived?: boolean;
  expertId?: string;
  modePresetId?: string | null;
  startAt?: number | null;
  dueAt?: number | null;
  isFavorited?: boolean;
  busy: boolean;
  pendingActionCount: number;
}
```

不下发：

```text
sessionFile
cwd
Space.path
secret/token
local connector paths
```

---

### P1-2：`src/main/index.ts` 已经非常大

Main composition root 已经承担大量 IPC 注册。

Remote 不要把 30 个 HTTP handler 继续直接写进 `index.ts`。

`index.ts` 只做：

```text
new RemoteAccessController(...)
start/stop
IPC settings glue
notification event fan-out glue
```

HTTP 路由、schema、auth、SSE 全部进：

```text
src/main/remote/
```

---

### P1-3：Notification / lifecycle listener 当前是单 listener

`NotificationService.setChangedListener()` 和 Agent task lifecycle 都不是多订阅总线。

Remote 不应通过再次 `setChangedListener()` 抢走桌面监听器。

本轮推荐最小改动：

```ts
notificationService.setChangedListener((event) => {
  broadcastToWindows(...);
  remoteAccessController?.publishNotificationChanged(event);
});
```

Agent lifecycle 暂不额外订阅；Agent patch + Notification 已足以驱动 Remote。

不要为了 Remote 把整个应用重构成全局 EventBus。

---

### P1-4：`app/renderer` 不是当前桌面真实 Renderer

当前 Electron Vite 配置明确使用：

```text
src/main
src/preload
src/renderer
src/shared
```

而：

```text
app/renderer
```

目前只是旧的“阶段 1 骨架”。

Codex 不要误认为 `app/renderer` 是可直接复用的手机 UI。

Android Remote 新建：

```text
app/remote
```

不要重构当前桌面 Renderer 作为前置条件。

---

## 2.4 P2 问题：Workspace API 不可直接复用为远程 API

现有 WorkspaceService 本身有 `assertInsideRoot()` 等边界保护，这是好基础。

但桌面 IPC 仍是：

```text
workspace:listFiles(root)
workspace:readFile(root, relativePath)
```

即 Renderer 传 root。

Remote 不允许客户端决定 root。

如果后续加入 Remote 文件浏览，接口必须是：

```text
GET /v1/tasks/:taskId/files?path=relative/path
```

Host：

```text
taskId
  → AgentService.resolveTaskExecutionWorkspaceCwd(taskId)
  → list/read within canonical root
```

本轮 MVP 可以先不开放完整 Files API。

---

# 3. 目标目录结构

完成后建议结构：

```text
mybuddy/
├── app/
│   ├── main/                 # 现有旧骨架，不动
│   ├── preload/              # 现有旧骨架，不动
│   ├── renderer/             # 现有旧骨架，不作为 Remote 基础
│   └── remote/
│       ├── package.json
│       ├── tsconfig.json
│       ├── vite.config.ts
│       ├── capacitor.config.ts
│       ├── index.html
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── api/
│       │   │   ├── RemoteClient.ts
│       │   │   ├── RemoteEventStream.ts
│       │   │   └── credentialStore.ts
│       │   ├── store/
│       │   │   └── remoteStore.ts
│       │   ├── pages/
│       │   │   ├── ConnectPage.tsx
│       │   │   ├── TasksPage.tsx
│       │   │   ├── ChatPage.tsx
│       │   │   └── NotificationsPage.tsx
│       │   ├── components/
│       │   │   ├── TaskList.tsx
│       │   │   ├── ChatTimeline.tsx
│       │   │   ├── Composer.tsx
│       │   │   ├── PendingApprovalCard.tsx
│       │   │   └── ConnectionBanner.tsx
│       │   └── styles/
│       │       └── app.css
│       └── android/           # Capacitor 生成
│
├── shared/
│   └── src/
│       ├── index.ts
│       └── remote-contract.ts
│
├── src/
│   ├── main/
│   │   └── remote/
│   │       ├── RemoteAccessController.ts
│   │       ├── RemoteAccessServer.ts
│   │       ├── RemoteAccessService.ts
│   │       ├── RemoteAccessAuth.ts
│   │       ├── RemoteAccessPairing.ts
│   │       ├── RemoteDeviceStore.ts
│   │       ├── RemoteEventBus.ts
│   │       ├── RemoteDtoMapper.ts
│   │       ├── RemoteTaskCommandService.ts
│   │       └── remoteSchemas.ts
│   ├── main/agent/
│   │   └── PendingActionRegistry.ts
│   └── shared/
│       └── ...                # 当前桌面 IPC DTO 保持
│
└── scripts/
    ├── remote-access-contract-test.ts
    ├── remote-access-server-test.ts
    ├── remote-pending-action-test.ts
    └── remote-event-stream-test.ts
```

若某文件职责很小，可以合并，但不要把这些职责重新塞回 `index.ts`。

---

# 4. Shared Remote Contract

## 4.1 为什么使用 `@mybuddy/shared`

仓库已有 `shared` workspace package，但目前只有非常薄的旧 Ping DTO。

本轮不要迁移整个 `src/shared`。

正确做法：

> 让 `@mybuddy/shared` 成为“跨 Desktop Host / Remote Client 的 transport-neutral contract”，只新增 Remote DTO。

root package 添加：

```json
"@mybuddy/shared": "workspace:*"
```

`app/remote` 也依赖：

```json
"@mybuddy/shared": "workspace:*"
```

不要把 Electron IPC channel、BrowserWindow、filesystem path 等 transport-specific 类型塞进 Remote contract。

## 4.2 必需类型

`shared/src/remote-contract.ts` 至少定义：

```ts
export const REMOTE_API_VERSION = 1;

export type RemoteConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "unauthorized";

export interface RemoteServerInfo { ... }
export interface RemoteSpaceSummary { ... }
export interface RemoteProjectSummary { ... }
export interface RemoteTaskSummary { ... }
export interface RemoteHistoryMessage { ... }
export interface RemoteTaskHistory { ... }
export interface RemotePendingAction { ... }
export interface RemoteRuntimeSnapshot { ... }
export interface RemoteNotification { ... }
export interface RemoteBootstrap { ... }
export interface RemotePromptRequest { ... }
export interface RemotePromptResponse { ... }
export interface RemoteApprovalRequest { ... }
export interface RemotePairRequest { ... }
export interface RemotePairResponse { ... }
export interface RemoteDeviceSummary { ... }
export interface RemoteEventEnvelope<T = unknown> { ... }
```

Remote contract 必须保持：

- JSON-safe；
- 无 Electron 类型；
- 无 Node Buffer；
- 无函数；
- 无绝对路径作为普通列表字段；
- 有 `apiVersion`；
- 能向后兼容 additive fields。

---

# 5. PendingActionRegistry — 必须先做

## 5.1 新文件

```text
src/main/agent/PendingActionRegistry.ts
```

建议 API：

```ts
class PendingActionRegistry {
  register(action: PendingActionRecord): void;
  remove(taskId: string, toolCallId: string): void;
  removeTask(taskId: string): void;
  get(taskId: string, toolCallId: string): PendingActionRecord | undefined;
  list(taskId?: string): PendingActionRecord[];
}
```

Record 不存 resolver，只存展示和决策所需事实。

Resolver 仍留 SessionRegistry，避免大改核心执行语义。

## 5.2 AgentService 接入位置

所有发出：

```text
status: "pending_approval"
```

的路径都必须 register。

当前至少包括：

- 普通 dangerous tool approval；
- CAD requestApproval；
- external-write approval。

不要只改其中一个路径。

## 5.3 清理位置

必须覆盖：

- `approveTool()` success；
- `approveTool()` deny；
- external-write allow-once；
- external-write allow-task-dir；
- external-write deny；
- `abort(taskId)`；
- session release；
- tool terminal error / success（兜底）；
- task purge（如有必要）。

## 5.4 AgentService 新增只读 API

```ts
listPendingActions(taskId?: string): PendingActionSnapshot[]
```

不可提供外部任意 mutation。

## 5.5 Desktop 行为不得回归

现有桌面工具审批 UI 必须继续走：

```text
AgentUiPatch tool_start
→ appStore
→ approveTool IPC
```

不要把桌面强行改为 Remote API。

PendingActionRegistry 只是补 snapshot，不替换当前流。

---

# 6. RemoteTaskCommandService — Host 权威任务命令

新建：

```text
src/main/remote/RemoteTaskCommandService.ts
```

依赖只注入：

```text
AppDatabase
AgentService
AppSettingsStore
ProjectService（若需校验 project）
```

## 6.1 创建新任务 + 首条消息

入口：

```ts
createAndPrompt(request, principal)
```

服务端：

1. validate text；
2. 校验 `spaceId` 存在且可用；
3. 校验 `projectId` 存在；
4. server-side `randomUUID()` 生成 taskId；
5. 解析 welcomeMode；
6. modePresetId 不合法则回退当前模式默认；
7. model/permission 默认遵循现有 Main 逻辑，不允许 Android 任意注入 provider secret；
8. 生成 title；
9. `db.upsertTask(...)`；
10. 生成 userMessageId / assistantMessageId；
11. 调用 `agentService.prompt()`；
12. 返回 task summary + ids；
13. 失败时不要留下“永久空任务”；如果 Agent 在 session 创建前失败，按明确规则回收；若已生成 session 则保留错误任务事实。

### 标题规则

不要在 Remote Client 自己决定最终标题。

可以将当前 `taskTitleFromFirstMessage()` 中“纯文本截断”部分抽成一个小 shared pure helper，或在 Main 实现等价简化规则。

不要为了标题迁移整个 appStore utility。

## 6.2 已有任务继续 prompt

入口：

```ts
promptExisting(taskId, request, principal)
```

必须：

- task 存在；
- task 未 trashed；
- 生成 message IDs 由 Host 完成；
- 不接受 client cwd/sessionFile；
- 默认沿用 task 已保存的 mode/model/permission；
- streaming 中行为第一版固定为现有安全默认；若需要 followUp/steer，再显式定义 Remote contract，不要照搬所有桌面 composer 行为。

## 6.3 Abort

仅：

```ts
agentService.abort(taskId)
```

不要额外直接清 SessionRegistry。

## 6.4 Approval

Remote request：

```ts
{
  taskId,
  toolCallId,
  decision: "deny" | "allow-once" | "allow-task-dir"
}
```

Host 先从 PendingActionRegistry 找到当前 action。

如果不存在：

```text
409 stale_action
```

不要继续“猜测”批准。

映射到现有：

```ts
AgentApproveToolRequest
```

external-write 的 path 必须使用 PendingActionRegistry 中由 Host 记录的 canonical facts，不允许 Android 自己发任意 path。

这是重要安全要求。

---

# 7. Remote DTO Mapper

新建：

```text
src/main/remote/RemoteDtoMapper.ts
```

所有 HTTP 输出都必须过 mapper。

## 7.1 Task

允许：

```text
id
title
spaceId
projectId
status
updatedAt
welcomeMode
modelId
permissionMode
archived
expertId
modePresetId
startAt
dueAt
isFavorited
busy
pendingActionCount
```

禁止：

```text
sessionFile
cwd
internal DB columns
```

## 7.2 Space

允许：

```text
id
name
archived
parentId
sortOrder
effectiveArchived
pathMissing
```

默认禁止：

```text
path
```

## 7.3 History

Remote history 只需要手机渲染的信息：

```text
message id
role
createdAt
text
thinking（可选）
tool summary/status
artifact metadata
attachment name
modelName
duration
```

不要把：

```text
history.sessionFile
history.cwd
attachment absolute path
artifact local disk path
```

直接返回。

如果 Artifact 暂时没有安全 ID-based read API，第一版只展示名称，不提供点击完整本地路径。

---

# 8. RemoteEventBus + SSE

## 8.1 为什么选 SSE

第一版主要是：

```text
Host → Android
```

的 Agent delta / lifecycle / notification 推送。

客户端命令仍走普通 POST。

因此无需引入 Socket.IO / WebSocket 框架。

## 8.2 新建

```text
src/main/remote/RemoteEventBus.ts
```

事件：

```ts
interface RemoteEventEnvelope {
  id: number;
  at: number;
  type:
    | "agent.patch"
    | "notification.changed"
    | "task.changed"
    | "pending_action.changed"
    | "server.status"
    | "resync_required";
  payload: unknown;
}
```

## 8.3 序号与短期 replay

维护单调递增 `eventId`。

建议环形缓存：

```text
max 1000 events
或 5 分钟
```

客户端 SSE 断线重连带：

```text
Last-Event-ID
```

如果缓存仍存在：补发。

如果已过期：

```text
event: resync_required
```

客户端重新：

```text
GET /v1/bootstrap
GET /v1/tasks/:id/history
GET /v1/tasks/:id/runtime
```

不要实现无限历史 event log。

## 8.4 Heartbeat

每约 15–25 秒发送 SSE comment：

```text
: ping
```

只为避免移动网络 / proxy 空闲断开。

连接 close 后必须：

- clear heartbeat；
- remove response；
- remove subscriber；
- 不残留 listener。

## 8.5 Agent patch 转换

订阅：

```ts
agentService.onPatch(...)
```

Remote 不需要原样转发所有字段。

经 `mapAgentPatchToRemoteEvent()`：

- text_delta：保留；
- thinking_delta：第一版可保留；
- assistant_start/end：保留；
- tool_start/update：保留安全字段；
- artifact_ref：只保留安全 metadata；
- context_usage：可保留；
- capability notices：可保留；
- 不应出现 host secret。

---

# 9. Remote Auth 与设备配对

## 9.1 双层安全模型

网络层：

```text
Tailscale tailnet
```

应用层：

```text
MyBuddy device token
```

即使 Tailscale 已限制网络访问，也保留 app-level device auth，以实现：

- 单设备撤销；
- 审计；
- 手机丢失后不必改整个 tailnet；
- 避免“tailnet 内所有设备自动有 MyBuddy 控制权”。

## 9.2 RemoteDeviceStore

新建：

```text
src/main/remote/RemoteDeviceStore.ts
```

存储：

```text
~/.mybuddy/remote-devices.json
```

只存：

```ts
{
  id,
  name,
  tokenHash,
  createdAt,
  lastSeenAt,
  revokedAt?,
  capabilities
}
```

永久 token 只在配对成功时返回客户端一次。

Token：

```text
randomBytes(32).toString("base64url")
```

Host 保存 SHA-256 高熵 token hash 即可；比较使用 timing-safe 思路。

文件写入：

- 原子 tmp + fsync + rename；
- Windows ACL 尽量收紧；
- 参考 Memory Gateway secret file 策略；
- 不改 Memory Gateway 现有实现，避免扩大回归面。

## 9.3 PairingService

配对 pending 只存内存，不落盘。

PC 用户点击：

```text
添加远程设备
```

生成：

```ts
{
  pairingId,
  secret,
  expiresAt: now + 5min
}
```

要求：

- 128 bit+ 随机 secret；
- 5 分钟过期；
- 单次使用；
- 成功后立即删除；
- 失败次数有限；
- 日志不打印 secret/token。

## 9.4 Pair endpoint

唯一无需 Bearer 的业务 endpoint：

```text
POST /v1/pair/exchange
```

body：

```json
{
  "pairingId": "...",
  "secret": "...",
  "deviceName": "Pixel ..."
}
```

返回：

```json
{
  "deviceId": "...",
  "deviceToken": "...",
  "server": {...}
}
```

其它 `/v1/*` 一律需要：

```text
Authorization: Bearer <deviceToken>
```

## 9.5 QR payload

PC 端可把以下 JSON/URL 编码为 QR：

```ts
{
  v: 1,
  baseUrl,
  pairingId,
  secret
}
```

**不要把长期 device token、Memory Gateway owner token 或任何模型 API key 放 QR。**

`baseUrl` 由用户在 Remote 设置里配置/确认，例如：

```text
https://vivion.<tailnet>.ts.net
```

本轮不要调用 Tailscale 管理 API 自动查域名。

---

# 10. RemoteAccessServer

## 10.1 基本约束

新建：

```text
src/main/remote/RemoteAccessServer.ts
```

默认：

```ts
REMOTE_ACCESS_HOST = "127.0.0.1";
REMOTE_ACCESS_DEFAULT_PORT = 3352;
```

constructor 必须拒绝非 loopback host，像 MemoryGatewayServer 一样 fail closed。

禁止：

```text
0.0.0.0
LAN bind
UPnP
router port forward
Funnel auto-enable
```

## 10.2 同源部署

Production 中 RemoteAccessServer 同时服务：

```text
/
  → app/remote/dist static app

/v1/*
  → JSON API

/v1/events
  → SSE
```

这样通过 Tailscale Serve 后：

```text
https://xxx.ts.net/
https://xxx.ts.net/v1/...
```

完全同源，不需要宽松 CORS。

不要在 production 配：

```text
Access-Control-Allow-Origin: *
```

## 10.3 Origin 策略

Memory Gateway 当前只允许 localhost browser Origin；这个逻辑 **不能原样复制**，因为 Remote SPA 最终 Origin 是 `https://*.ts.net`。

Production 推荐：

- same-origin browser request；
- Bearer token 才是主认证；
- 对 mutation endpoint 检查 Origin / Host 与配置 baseUrl 一致（存在时）；
- non-browser client 无 Origin 可允许，但仍需 token；
- pair endpoint 同样受一次性 pairing secret 保护。

## 10.4 HTTP hardening

至少：

```text
Cache-Control: no-store（API）
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy（static app）
X-Frame-Options: DENY 或 frame-ancestors 'none'
```

request body 上限：

- 普通 JSON 建议 512 KiB；
- 第一版无 multipart upload；
- 超限 413。

Zod `.strict()` 校验所有写接口。

统一错误：

```ts
{
  ok: false,
  error: {
    code: string,
    message: string
  }
}
```

不要把 stack trace 发手机。

---

# 11. API 规范

建议第一版固定以下路由。

## 11.1 Public

```text
GET  /healthz
POST /v1/pair/exchange
```

`/healthz` 只返回：

```json
{
  "ok": true,
  "service": "mybuddy-remote",
  "apiVersion": 1
}
```

不要泄露模型、路径、token 状态。

## 11.2 Authenticated bootstrap

```text
GET /v1/bootstrap
```

返回一次初始化所需：

```text
server info
safe spaces
task summaries
project summaries
unread notification count
current device info
```

不要把每个任务完整 history 一次性塞进 bootstrap。

## 11.3 Tasks

```text
GET  /v1/tasks
GET  /v1/tasks/:taskId/history
GET  /v1/tasks/:taskId/runtime
POST /v1/tasks
POST /v1/tasks/:taskId/prompt
POST /v1/tasks/:taskId/abort
```

`POST /v1/tasks` 可直接“创建+首条 prompt”，不要制造空任务。

请求示例：

```json
{
  "text": "帮我继续检查这个项目",
  "spaceId": "optional",
  "projectId": "optional",
  "welcomeMode": "coding"
}
```

## 11.4 Approval

```text
POST /v1/tasks/:taskId/actions/:toolCallId/respond
```

body：

```json
{
  "decision": "deny"
}
```

或：

```json
{
  "decision": "allow-once"
}
```

external-write 才允许：

```json
{
  "decision": "allow-task-dir"
}
```

普通 tool 收到 `allow-task-dir` → 400。

stale toolCallId → 409。

## 11.5 Notifications

```text
GET  /v1/notifications?unreadOnly=0&limit=100
POST /v1/notifications/:id/read
POST /v1/notifications/read-all
```

第一版可不提供 dismiss。

## 11.6 Devices

PC Desktop 管理设备走 IPC→Controller，不必通过 Remote 自己管理所有设备。

Android 只需要：

```text
GET  /v1/device/me
POST /v1/device/revoke-self
```

可选。

## 11.7 Event stream

```text
GET /v1/events
```

返回 SSE。

---

# 12. RemoteAccessController 与 AppSettings

参考 `MemoryGatewayController` 的生命周期模式。

## 12.1 AppSettings 新字段

`AppSettings` / `AppSettingsDto` 增加：

```ts
remoteAccessEnabled?: boolean;
remoteAccessPort?: number;
remoteAccessBaseUrl?: string;
```

默认：

```text
remoteAccessEnabled = false
remoteAccessPort = 3352
remoteAccessBaseUrl = ""
```

端口：1024–65535。

不要默认开启 Remote。

## 12.2 Controller

新建：

```text
RemoteAccessController.ts
```

职责：

```text
start
stop
configure
status
listDevices
revokeDevice
createPairingSession
cancelPairingSession
publishNotificationChanged
```

使用 lifecycle queue，避免快速启停端口 race。

配置失败必须回滚原 settings，参考 MemoryGatewayController。

## 12.3 Main composition root

`src/main/index.ts` 只加入少量 wiring：

- 构造 RemoteAccessController；
- app ready 后按 settings start；
- app quit 时 stop；
- Notification changed 同时推给 Remote；
- 注册 Remote settings IPC；
- staticRoot 由 composition root 提供。

不要把 HTTP route 实现放 index。

---

# 13. Desktop Settings UI

建议放：

```text
设置 → 安全 / Security
```

增加卡片：

```text
远程访问

[开关] 启用 Android / Mobile Remote
端口        3352
访问地址    https://...
状态        已运行 / 未运行 / 错误

Tailscale
复制命令：tailscale serve --bg 3352

已配对设备
Pixel ...         最近在线 ...   [撤销]

[添加设备]
```

点击“添加设备”：

1. Main 创建 pairing session；
2. Renderer 显示过期倒计时；
3. 显示 QR；
4. 可复制 pairing link；
5. 配对成功后刷新设备列表；
6. Modal 关闭时 cancel pending pairing。

不要在 Renderer 生成 pairing secret。

QR 只是 presentation，secret 必须来自 Main。

### Tailscale 一键化边界

本轮不要让 MyBuddy 自动登录 Tailscale、改 ACL、开 Funnel。

可以提供：

```text
[复制 Serve 命令]
```

用户执行一次：

```bash
tailscale serve --bg 3352
```

Tailscale 官方当前支持把 localhost 端口映射为 tailnet 内 HTTPS，并保留 tailnet ACL。Remote 后端继续只监听 `127.0.0.1`。

---

# 14. `app/remote` — Mobile Web

## 14.1 技术栈

保持轻量：

```text
React 19
Vite 7
TypeScript
Zustand
lucide-react（可选）
@mybuddy/shared
```

不要把桌面 renderer 整包依赖进来。

UI 风格可以沿 MyBuddy / Claude 简洁方向，但移动端优先：

- 触摸目标 >= 44px；
- 单栏；
- 底部 composer；
- 审批按钮明显；
- 不复制桌面三栏布局；
- 流式时不要整页 re-render；
- 长对话只追加当前 message delta。

## 14.2 页面

### ConnectPage

状态：

```text
未配对
已配对但无法连接
认证失效
```

支持：

- QR deep link；
- 手动输入 pairing payload 作为调试 fallback；
- revoke / clear local credential。

### TasksPage

展示：

```text
任务标题
Workspace / Project 名称
状态
更新时间
待审批 badge
```

支持：

- 打开任务；
- 新建任务；
- 按最近更新时间排序；
- archived 第一版不展示。

### ChatPage

展示：

- user message；
- assistant text；
- thinking 折叠；
- tool card；
- pending approval card；
- status；
- Stop；
- composer。

第一版不要做桌面 Artifact panel / Browser / Terminal。

### NotificationsPage

展示：

- action_required；
- completed；
- failed；
- project attention；
- unread。

点击 action_required 应导航对应 task，并定位 pending action。

## 14.3 Store

`remoteStore.ts` 必须与 Desktop appStore 分开。

最小状态：

```ts
connection
serverInfo
spaces
tasks
projects
notifications
activeTaskId
historiesByTask
runtimeByTask
pendingActionsByTask
streamingMessages
```

不要复制桌面 store 的 Browser/Artifact/Mode Marketplace 等状态。

## 14.4 重连策略

SSE 断开：

```text
connected → reconnecting
```

指数退避但有上限，例如：

```text
1s, 2s, 4s, 8s, 15s
```

恢复后：

- 若 event replay 完整，继续；
- 收到 `resync_required`，重新 bootstrap + active task snapshot；
- App 从后台回前台，也主动一次 lightweight resync；
- 禁止重复叠加 delta。

---

# 15. Android / Capacitor

当前 Capacitor 官方文档为 v8，适合将现有 Web React 应用作为 Android native container，并按需接入原生能力。

## 15.1 添加依赖

在 `app/remote`：

```text
@capacitor/core v8
@capacitor/cli v8
@capacitor/android v8
```

按官方标准：

```bash
npx cap init
npx cap add android
```

`webDir` 指向 Remote Vite 的 `dist`。

## 15.2 Credential 必须进 Android Keystore

不要把长期 `deviceToken` 明文存：

```text
localStorage
Capacitor Preferences plaintext
URL
QR history
```

实现一个非常小的 Android native Capacitor plugin：

```text
RemoteCredentialPlugin
```

职责仅：

```text
saveToken
loadToken
clearToken
```

底层使用 Android Keystore 保护 AES key，token 加密后存 SharedPreferences。

不要引入大而不明来源的 secure-storage plugin 作为核心安全依赖。

Web 浏览器调试模式可以使用 session/local fallback，但 UI 必须明确是 dev-only；Android production 一律走 Keystore plugin。

## 15.3 Deep Link / QR

定义 app scheme，例如：

```text
mybuddy://pair?... 
```

扫码后：

1. Android 收 pairing payload；
2. 调 `/v1/pair/exchange`；
3. token 写 Keystore；
4. 清除内存中的 pairing secret；
5. 进入 TasksPage。

第一版若系统相机扫码 deep link 配置过于扩大范围，可以先让 Android App 内置扫码作为后续；但 pairing URL parser 和 deep-link contract 必须先稳定。

## 15.4 Network security

生产使用：

```text
https://*.ts.net
```

Android 不允许 cleartext HTTP 作为生产默认。

本地开发 HTTP 例外只能通过 debug variant / 明确 dev config。

---

# 16. Packaging

Remote static web 必须随 MyBuddy Windows 安装包存在。

## 16.1 Build script

新增 root scripts，例如：

```json
"remote:build": "pnpm --filter @mybuddy/remote build",
"remote:typecheck": "pnpm --filter @mybuddy/remote typecheck",
"remote:android:sync": "pnpm --filter @mybuddy/remote cap:sync",
"test:remote-access": "..."
```

Windows `pack/dist` 前确保 Remote Web build 已完成。

不要强迫日常 `electron-vite dev` 每次都编 Android。

## 16.2 electron-builder

`build.files` 加入 Remote static dist：

```text
app/remote/dist/**/*
```

Main composition root 注入 static path：

```text
app.getAppPath()/app/remote/dist
```

RemoteAccessServer 不直接 import Electron `app`，保证 server 可纯 Node 测试。

---

# 17. Tailscale 部署约束

本轮网络正式路径：

```text
Android Tailscale
      ↓
tailnet HTTPS
      ↓
Tailscale Serve
      ↓
http://127.0.0.1:3352
```

一次性 PC 配置示例：

```bash
tailscale serve --bg 3352
```

官方当前文档说明 Serve 是 tailnet 内访问，不是公网 Funnel；ACL 仍适用，并推荐 backend 监听 localhost。

MyBuddy Remote：

- 不自动启用 Funnel；
- 文档明确 Funnel 禁用；
- 不开放 Windows Firewall LAN 入站端口作为默认方案；
- 不要求 DDNS；
- 不做公网反代。

如果以后需要无 Tailscale 的用户，再单独设计 Relay，不在本轮埋“公网模式”。

---

# 18. 测试计划

所有新增测试尽量纯 Node、短运行。

## 18.1 `remote-pending-action-test.ts`

覆盖：

1. 普通 approval register；
2. external-write register；
3. list by task；
4. approve 后 remove；
5. deny 后 remove；
6. abort 后 remove；
7. 同 toolCallId 不串 task；
8. stale action 返回 false/404/409 语义；
9. external-write action 保留 canonical decision facts。

## 18.2 `remote-access-contract-test.ts`

覆盖 mapper：

- RemoteTask 不含 `cwd`；
- 不含 `sessionFile`；
- RemoteSpace 不含 `path`；
- History 不下发 internal path；
- zod reject unknown write fields；
- API version 固定。

建议增加 hard assertion，防未来有人把内部 DTO 直接 spread：

```ts
assert(!("cwd" in remoteTask))
assert(!("sessionFile" in remoteTask))
assert(!("path" in remoteSpace))
```

## 18.3 `remote-access-server-test.ts`

使用随机 loopback port。

覆盖：

- 非 loopback host constructor 拒绝；
- healthz；
- unauthorized 401；
- malformed bearer 401；
- valid device bearer；
- body too large 413；
- strict schema 400；
- create task 服务端生成 id；
- client 传 cwd → 400；
- stale approval → 409；
- notification read；
- static file path traversal 不允许。

## 18.4 `remote-event-stream-test.ts`

覆盖：

- event id 单调；
- agent delta 转换；
- Last-Event-ID replay；
- ring buffer 超出 → resync_required；
- disconnect subscriber 回收；
- heartbeat timer stop 后清理；
- 不重复 listener。

## 18.5 Pairing/Auth test

覆盖：

- pairing secret 过期；
- single-use；
- wrong secret；
- token hash 验证；
- revoked token 401；
- lastSeen 更新节流，避免每请求写磁盘；
- device store atomic persistence；
- 日志无 token。

## 18.6 Remote Web

不要上大型浏览器 E2E。

至少：

- reducer/store event application unit test；
- duplicate delta 防御；
- `resync_required`；
- approval decision mapping；
- typecheck；
- Vite build。

## 18.7 最终短验证命令

最终建议只跑：

```bash
pnpm run test:remote-access
pnpm run remote:typecheck
pnpm run remote:build
pnpm run typecheck
pnpm run build
```

以及非常短的本地 smoke：

```text
GET /healthz
pair
GET /v1/bootstrap
SSE connect
```

不要顺手跑全仓 E2E。

---

# 19. Codex 分阶段执行顺序

必须按顺序推进，不要并行大改。

## Phase 0 — Baseline / Contract Freeze

- 记录 git status；
- 不碰用户 dirty files；
- 新建本文件涉及目录；
- 确认 Remote API scope；
- 不写 UI。

完成标准：无业务改动。

## Phase 1 — Shared Remote Contract

- 扩展 `shared` package；
- 增加 remote-contract；
- root 与 app/remote 可依赖；
- 增 contract test。

完成标准：contract compile，Internal DTO 不直接暴露。

## Phase 2 — PendingAction Snapshot

- 新 PendingActionRegistry；
- 接入所有 pending approval 路径；
- approve/abort/session release 清理；
- AgentService `listPendingActions`；
- targeted test。

完成标准：模拟网络断线后通过 snapshot 能完整重建 approval card。

## Phase 3 — Remote Application Services

- RemoteDtoMapper；
- RemoteTaskCommandService；
- RemoteAccessService；
- task/history/runtime/notification read model；
- 服务器权威 create/prompt/abort/approval。

完成标准：不用 HTTP 也能用 service unit test 驱动完整任务命令。

## Phase 4 — Auth / Device / Pairing

- DeviceStore；
- PairingService；
- token hash；
- revoke；
- atomic persistence；
- tests。

完成标准：设备 token 可独立撤销。

## Phase 5 — Event Bus / SSE

- RemoteEventBus；
- agent.onPatch；
- notification changed；
- replay/resync；
- heartbeat；
- cleanup tests。

完成标准：短断线无重复 delta；长断线要求 snapshot resync。

## Phase 6 — HTTP Server / Controller

- RemoteAccessServer；
- Zod schemas；
- static hosting；
- Controller；
- settings；
- Main wiring；
- server tests。

完成标准：localhost 3352 完整工作，0.0.0.0 明确不支持。

## Phase 7 — Desktop Remote Settings UI

- enable/port/baseUrl；
- status；
- device list/revoke；
- add-device pairing session；
- QR / copy link；
- Tailscale command helper。

完成标准：PC 用户无需手改 JSON 即可管理 Remote。

## Phase 8 — Mobile Web

- app/remote；
- pairing/connect；
- tasks；
- chat；
- SSE；
- approval；
- notifications；
- reconnect/resync；
- responsive UI。

完成标准：Android Chrome 经 Tailscale 可以完整完成“打开任务→发送→看流→审批”。

## Phase 9 — Capacitor Android

- Capacitor v8；
- Android shell；
- Keystore credential plugin；
- deep link；
- production HTTPS policy；
- build/sync scripts。

完成标准：APK 壳启动、token 不落 localStorage、与 Web 同一 Remote API。

## Phase 10 — Packaging / Docs

- Remote dist 打入 Windows installer；
- 操作文档：Tailscale install/login/serve；
- Android install/pair；
- revoke；
- troubleshooting；
- 禁止 Funnel 说明。

## Phase 11 — Independent Review

Codex 完成后必须自己再做一轮只读 review，重点回答：

1. 有没有任何 route 接受 `cwd/sessionFile/root` 并直接信任？
2. 有没有 `/invoke` / generic IPC proxy？
3. Remote task 是否由 Host 生成 ID？
4. pending approval 网络重连能否 snapshot 恢复？
5. external-write path 是否来自 Host action，而不是 Android body？
6. 是否有任何监听 `0.0.0.0`？
7. 是否出现 CORS `*`？
8. permanent token 是否写日志/URL/localStorage？
9. revoked device 是否立即 401？
10. SSE close 是否清 listener/timer？
11. Remote DTO 是否泄漏 absolute path？
12. Android 是否直接依赖 Desktop preload？
13. 是否误改现有 Gateway/Memory Gateway 语义？
14. 是否误改 `.commandcode/taste/*`？
15. 是否跑了无关长测试？

有任一答案不符合，先修正再汇报。

---

# 20. 必须保持不变的现有能力

本轮绝不能破坏：

- Desktop Renderer → preload → IPC；
- AgentService current prompt flow；
- Task execution workspace isolation；
- external-write grant 语义；
- Memory Gateway；
- PC Bridge；
- Gateway 飞书/企微/微信/Telegram；
- Notifications；
- Project/Workspace current behavior；
- Artifact Domain；
- Browser / Terminal / Computer Use；
- Mode / Skill / MCP Gate。

Remote 是新入口，不是替代现有入口。

---

# 21. 明确禁止的“看似省事”实现

Codex 不得采用：

### 禁止 A

```text
把 preload API JSON-RPC 化
```

### 禁止 B

```text
把整个 src/renderer 直接改成同时适配 Electron + Android
```

### 禁止 C

```text
Android WebView 注入假的 window.api
```

### 禁止 D

```text
让 Android 调 PC Bridge MCP
```

### 禁止 E

```text
Remote Server bind 0.0.0.0
```

### 禁止 F

```text
为了方便开启 Tailscale Funnel
```

### 禁止 G

```text
把 Memory Gateway token 复用为 Remote token
```

### 禁止 H

```text
把 TaskDto / SpaceDto 直接 JSON.stringify
```

### 禁止 I

```text
用 Notification 文本反推 pending approval
```

### 禁止 J

```text
external-write approval 允许客户端自己指定任意 target path
```

### 禁止 K

```text
为了共享 UI，大规模重构 appStore
```

---

# 22. 最终验收场景

完成后至少人工走通以下场景。

## 场景 1：首次配对

```text
PC 开启 Remote
→ 配置 Tailscale Serve
→ PC 添加设备生成 QR
→ Android 配对
→ Android token 存 Keystore
→ Tasks 列表出现
```

## 场景 2：创建新任务

```text
Android 新任务
→ 输入“检查项目状态”
→ Host 创建 taskId
→ DB 落库
→ Agent 开始执行
→ Desktop 同时能看到该任务
→ Android 实时流式显示
```

## 场景 3：继续桌面已有任务

```text
PC 先创建任务
→ Android 打开
→ history 正确
→ Android 发送后
→ PC Desktop 收到同一 Agent patch
→ 两端最终状态一致
```

## 场景 4：工具审批

```text
Agent 请求危险工具
→ Desktop 出现审批
→ Android 同时出现 pending approval
→ Android Allow once
→ Agent 继续
→ Desktop card 更新
→ Android card 更新
```

## 场景 5：审批期间断网

```text
Agent 请求 approval
→ Android 收到
→ 关闭 Wi-Fi / SSE 断开
→ 恢复网络
→ Remote GET runtime/snapshot
→ approval card 仍存在
→ 可以批准
```

这是 P0 验收，不允许省略。

## 场景 6：external write

```text
Agent 请求 task root 外写入
→ Android 显示 Host 提供 target path
→ Android 只发送 decision
→ allow-task-dir 后 Host canonicalize / persist grant
→ Android 不能篡改 path
```

## 场景 7：设备撤销

```text
PC 撤销 Pixel
→ Pixel 下一个 API/SSE reconnect 立即 401
→ 其它 Android 设备不受影响
```

## 场景 8：安全边界

确认：

```text
http://LAN-IP:3352 不能连接（因为仅 127.0.0.1）
Tailscale Serve URL 可以连接
无 token API 401
Funnel 未启用
```

---

# 23. 完成后的 Codex 汇报格式

最后不要只说“完成”。必须按以下格式汇报：

```text
1. 实现概览
2. 新增/修改文件清单
3. Host Remote API
4. PendingAction 重连修复
5. Pairing/Auth 安全边界
6. Android/Capacitor 状态
7. Tailscale 使用方式
8. 执行过的测试（只列实际运行的）
9. 未执行的长测试
10. git status
11. 已知剩余问题（必须真实）
12. 独立 review 结论
```

若 Android 原生构建环境缺 SDK/Gradle，不要伪称 APK 已验证；Web/Host 完成多少就如实报告多少。

---

# 24. 最终架构判定标准

本方案成功的标准不是“手机能打开一个网页”，而是：

> MyBuddy 获得一个正式、受权限控制、可重连、可撤销设备、不会暴露 Electron IPC 的 Remote Client 架构。

最终必须满足：

```text
Desktop Client ─────┐
                    │
Android Remote ─ Remote Access Layer ─ MyBuddy Main/Core
                    │
Future iOS/Web ─────┘
```

而不是：

```text
Android → Electron IPC over Internet
```

如果实现过程中必须在“少写代码”和“守住这个边界”之间选择，优先守住边界。
