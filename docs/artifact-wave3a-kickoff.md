# Wave 3A 开工记录 — Task Hydration / Artifacts Projection

> 日期：2026-08-08
> 前置：Wave 2 checkpoint `c89bc73`（feat(artifact): establish task-scoped artifact domain）
> 规格：V3.5 Frozen Execution Spec（§20-25 / §57-60）

## 六项事实调查结论

### ① task 切换唯一入口
- **唯一入口 = `appStore.setActiveTask(id)`**（`appStore.ts:965`）。
  它统一完成：activeTaskId 设置、draft 丢弃、artifactTabs/activeArtifactId 初始化、contextUsage 拉取、history restore。
- 其他设置 activeTaskId 的点：`sendMessage` materialize（`:1149-1170`，首条消息创建任务）、`duplicateTaskWithMode`（`:562`，复制任务）。
- 启动时 `activeTaskId = null`（`initRuntime` 加载 tasks 后不自动恢复 active task）。
- **hydrate 挂点：`setActiveTask`（唯一入口）+ materialize + duplicateTaskWithMode（新 task，顺带 hydrate 空集）**。不在任何组件里重复触发。

### ② task.artifacts writer/readers 完整清单
Writers（直接 mutation，3A 不动，列迁移清单）：
| 位置 | action | 角色 |
|---|---|---|
| appStore.ts:832-839 | `applyAgentPatch`（artifact 类型） | **主 writer**：Agent 事件流创建/更新 |
| appStore.ts:1067-1081 | `setActiveTask` history restore | 重启后直接覆盖 task.artifacts（**双 writer 风险点**） |
| appStore.ts:1916-1943 | `openLocalFile` | 本地文件打开 |
| appStore.ts:1990-2034 | `openWorkspaceFile` | 工作区文件打开 |
| appStore.ts:2070-2112 | `ensureCanvasArtifact` | canvas/svg 注册（含 existing replace :2111-2112） |
| appStore.ts:553/654/1161 | 初始化 `artifacts: []` | duplicateTaskWithMode / materialize / 启动加载 |

Readers（3A 不迁，3D/3E 处理）：
`ChatInput.tsx:454`、`ChatView.tsx:205/556`、`Markdown.tsx:32`、`FilesPage.tsx:36/125`、`ArtifactRail.tsx:7`、`InputAddMenu.tsx:126/150/615/645-696`、`appStore.ts:967/1760/1784/1875/2425/2430`

### ③ snapshot/事件顺序字段现状
- **无 task-level revision**。`ArtifactSnapshot` = {taskId, artifacts, state, error?}；事件 = {artifactId, taskId, version}。
- `ArtifactDescriptor.version` 是单 artifact 内容版本，不解决 snapshot/事件竞态。
- **结论：3A 开始前补 task-level revision**（snapshot + created/updated/removed 事件都带；stale-race 由 renderer revision guard 处理）。

### ④ history restore 注入路径
- `setActiveTask` → `window.api.agent.loadTaskHistory(id)`（Main `AgentService.loadTaskHistory` 读 session jsonl）→ 直接 `set()` 写 `task.messages` + `task.artifacts`（appStore.ts:1067-1081）。
- **确认会与 Domain hydrate 形成双 writer**。3A 对策：projection 独立后 history restore 仍写旧 `task.artifacts`（3B 迁移时改为只恢复 messages，artifacts 一律走 Domain hydrate）。

### ⑤ Domain 事件 payload 形态
- 现状：created/updated = {artifactId, taskId, version}；removed = {artifactId, taskId}。
- 修订（3A 前置）：**created/updated 带完整 `ArtifactDescriptor` + revision**（renderer 无需额外 get()，避免竞态和 IPC）；**removed = {artifactId, taskId, revision}**。

### ⑥ task/space 删除清理责任
- renderer `deleteTask` → `db.deleteTask`（AppDatabase 只删 tasks 行，无 FK 级联）。
- **Domain artifacts（DB row + managed-content 文件）当前无删除路径 → 会残留**。3A 不实现，记录到 3G（或 3B 顺带做 `Repository.removeByTask` + storage 清理 + removed 广播）。

## 前置决策（已拍板，不讨论）
1. **Artifact version = 单 Artifact 内容版本**；**Task Artifact revision = task 的 Artifact 集合/事件序列版本**。两者分离。
2. **Renderer projection = 可丢弃、可重新 hydrate**；**ArtifactRepository = 不可由 Renderer 反向覆盖**。

## 3A 范围
只改"Artifact 数据怎么进入 Renderer"：
- `artifactsByTask` / `artifactLoadState` / `artifactRevisions` slice（**唯一写入口 = snapshot/event reducer**，纯函数放 shared 可测试）
- active task 启动 hydrate；task switch 未加载 task lazy hydrate；error 可 retry
- snapshot/event stale-race 处理（revision guard）
- created 幂等 append / updated 按 id replace 不换位 / removed 删 id
- Domain 事件订阅（onCreated/onUpdated/onRemoved）

不碰：ArtifactPanel / DetailCard / PreviewHost.registry / artifact-index / 旧 task.artifacts writer / RefreshCoordinator（3C 再接）/ history writer。

## 3A DoD
```
[ ] renderer 有明确 artifactsByTask / loadState projection（+revision guard）
[ ] projection 唯一写入口为 snapshot/event reducer（纯函数 + 单测）
[ ] active task 启动时 hydrate；task switch 未加载 task lazy hydrate
[ ] hydrate error 可 retry
[ ] created 幂等 append；updated 不改变 FIFO 位置；removed 正确删除
[ ] snapshot/event 有明确 stale-race 处理
[ ] Domain contract tests（65 + revision 新增）全绿；char tests 10/10
[ ] typecheck / build 通过；electron 冒烟
[ ] renderer 之外现有 Artifact consumer 暂不迁移；PreviewHost.registry / artifact-index 未动
```

## Wave 3 后续顺序（不变）
3A task hydration/projection → 3B task switch + history restore → 3C creation/write paths → 3D ArtifactPanel/DetailCard → 3E FilesPage/references/changes → 3F Preview source resolution cutover → 3G 删除（artifact-index / PreviewHost.registry / renderer direct writes）→ machine gate。
