# ADR-001: Future Work Graph — Architecture Foundation (Phase 6.0)

> 状态：Proposed → 待 Review 通过后才建表  
> 范围：`Phase 6 Foundation` 前置冻结，回答路线图 §18 十问  
> 关联主文档：[MyBuddy_Workspace_V2_Post_Phase5_Full_Execution_Roadmap.md](../../MyBuddy_Workspace_V2_Post_Phase5_Full_Execution_Roadmap.md)  
> 封板基线：`feat(workspace): finalize workspace v2` (46bf1c4)

---

## 1. 决策总纲

```text
Workspace Tree = Context hierarchy
Work Graph    = Typed relation graph
Resource Locator = Discovery
Permission = Access
Source of Truth = 真实 Resource / Service
```

| 维度 | 负责者 | 语义 |
|---|---|---|
| **Workspace Tree** | [AppDatabase.ts](../src/main/db/AppDatabase.ts) `spaces.parent_id` + [workspace-tree.ts](../src/shared/workspace-tree.ts) + [workspace-resolver.ts](../src/shared/workspace-resolver.ts) | 层级上下文边界，决定 `Task>Current>Parent>Root` 继承与 `sibling隔离` |
| **Work Graph** | 新增 `work_graph_edges` + `WorkGraphService` | 类型化关系，不承载 hierarchy，不改变 Context/Permission |
| **Locator / Provider** | [WorkspaceResourceLocator.ts](../src/main/workspace/WorkspaceResourceLocator.ts) | 只定位，Agent 再 `library_read` |

**冻结原则（§17, §63）：**

```text
Graph relation 默认不改变 Workspace Context
Graph relation 默认不改变 Permission
需要 Context 的能力必须显式走 Context Resolver
```

---

## 2. §18 十问冻结答案

### Q1. 什么是 node？

现有业务实体的**引用**，非复制。

| node_type | entity_id 示例 | Source of Truth |
|---|---|---|
| `workspace` | `sp-123` | `spaces.id` |
| `task` | `task-456` | `tasks.id` |
| `project` | `proj-789` | `projects.id` |
| `plan` (= project_todo) | `todo-xxx` | `project_todos.id` |
| `artifact` | `art-xxx` | `artifacts.id` |
| `library_item` | `lib-item-xxx` | `library_items.id` |
| `agent_run` | `run-xxx` | Phase 8 再定义（当前仅占位，不建表） |

> `library_chunk` 不作为 node：chunk 只是 `library_item` 的定位辅助（R2 约束）。

Node identity = `(node_type, entity_id)` 组合键。Phase 6 **不建** `work_graph_nodes` 表；存在性由各 Service 实时校验。

### Q2. 什么是 edge？

有向、类型化关系：

```text
work_graph_edges(from_type, from_id, relation, to_type, to_id, metadata_json, created_at, updated_at)
```

首版仅开放最小集合（§21）：

```text
RELATES_TO   — 通用关联（允许环）
DEPENDS_ON   — 依赖（DAG，禁止环）
PRODUCES     — 产出（如 Task PRODUCES Artifact）
DERIVED_FROM — 溯源
```

其余 `contains / belongs_to / blocks / spawned_by / references / promoted_from` 等**暂不开放**，按 Phase 7/8 真实需要再增。

### Q3. 哪些现有实体只是被引用，而不是复制？

**全部**现有实体均只引用：`Workspace / Task / Project / Plan(Todo) / Artifact / LibraryItem / AgentRun` 都不复制到 graph。

Graph 不持有 `title / content / status` 等可变字段；UI/查询时按 `from/to` 实时 join 读取。若 source 删除，edge 随之清理（见 Q9）。

### Q4. Workspace parent 是否进入 graph？

**否。**

`spaces.parent_id` 是 **Context hierarchy 的唯一真源**，不投影为 `BELONGS_TO` edge 的可编辑副本。

- 校验仍在 [AppDatabase.ts:2045](../src/main/db/AppDatabase.ts#L2045) `collectSpaceDescendants` + [AppDatabase.ts:2086](../src/main/db/AppDatabase.ts#L2086) `moveSpace` 的 `cycle` 事务内完成。
- Graph **可提供只读投影** `listRelated(workspace)` 供查询，但不得双写；若必须展示，可在 Service 层由 `spaces` 实时计算。

> 禁止：`spaces.parent_id` + `graph edge BELONGS_TO` 两个可编辑真源（路线图 §22）。

### Q5. Task ownership 与 graph relation 区别？

| 关系 | 真源 | 可编辑 | Graph 角色 |
|---|---|---|---|
| `Task belongs to Workspace` | `tasks.space_id` ([AppDatabase.ts](../src/main/db/AppDatabase.ts)) | 唯一真源 | 仅只读投影 |
| `Task DEPENDS_ON Task` | `work_graph_edges` | Graph 真源 | 新型关系 |
| `Task PRODUCES Artifact` | `work_graph_edges` (Phase 6) / `artifacts.task_id` 存量 | 以 `artifacts.task_id` 为主，graph 补充跨实体溯源 | 需明确主从 |

原则：**ownership 单一真源，不双写**。Graph 只承载 `tasks.space_id` 无法表达的横向关系。

### Q6. Project membership 与 Workspace scope 区别？

```text
Project = 业务目标 / 工作组织维度（[project-domain.ts](../src/shared/project-domain.ts) ProjectDto）
Workspace = Context boundary（[workspace-tree.ts](../src/shared/workspace-tree.ts)）

Project ≠ Workspace
Plan ≠ Workspace
```

- `ProjectContextResolver` ([ProjectContextResolver.ts](../src/main/project/ProjectContextResolver.ts)) 独立于 `WorkspaceSharedContextService`。
- Prompt 最终装配 = `Task Context + Workspace Context + Project Context + Expert/Skill`，各来源 `source/type/trust` 显式标注。
- `Project RELATES_TO Workspace` 可作为 graph edge（Phase 7），但**不自动继承对方上下文**。

### Q7. Plan contains Task 是否是 graph edge？

**是，但 Phase 6 不实现。**

- `Plan` = `ProjectTodo` ([project-domain.ts](../src/shared/project-domain.ts#L74))，当前由 `project_todos.project_id` 归属 Project。
- `Plan CONTAINS Task` / `Plan BELONGS_TO Project` 在 Phase 7 才开放；Phase 6 仅保留 `RELATES_TO / DEPENDS_ON` 通用能力，避免提前把 `Project/Plan` 塞进 Workspace Tree（路线图 §64-1 禁止）。

Graph 不因 `CONTAINS` 自动扩大 Task 的 Workspace Context。

### Q8. Agent execution spawned-by 是否是 edge？

**是，但 Phase 8 才实现。**

- 运行时 `Task → AgentRun → SubagentRun → Artifact` 的 `SPAWNED_BY / PRODUCED` 属于 Execution Graph（路线图 §40-42）。
- Phase 6 不持久化 `Subagent` 为 Workspace child；长期保存的是 `execution record + relation`。
- Phase 6 预留 `agent_run` node_type 占位，不建表、不提供写 API。

### Q9. Graph 是否影响 Permission？

**否。**（§63.2）

```text
related ≠ authorized
```

- Resource 读权限仍由 `WorkspaceResourceLocator` 的 `scope + binding + permission` 链决定（[WorkspaceResourceLocator.ts](../src/main/workspace/WorkspaceResourceLocator.ts)）。
- `Task A DEPENDS_ON Task B` 不自动让 A 的 Agent 读到 B 的 Workspace 绑定资源。
- Project/Plan/Artifact 的读权限仍由各自 Service 校验，Graph 不绕过。

Delete 清理：删除 entity 时，其关联 edges 由 `WorkGraphService` 显式清理（无 FK 级联删业务数据，仅删 `work_graph_edges` 行）。

### Q10. Graph 是否影响 Context inheritance？

**否。**（§63.1）

```text
Workspace ancestor → Context inheritance
Graph relation → 不自动 Context inheritance
```

- `Task A DEPENDS_ON Task B` 不自动把 B 的 `Workspace Shared Context` 注入 A 的 Prompt。
- 需要跨 Workspace 上下文时，必须显式走 `Context Resolver` / `ProjectContextResolver` 并标注 `source`，或由 Agent 显式 `query_work_graph` 后再 `library_read` 真实源。
- Graph 查询结果 `≠ Prompt injection`（§63.3）。

---

## 3. 数据模型（Phase 6 首版）

```sql
CREATE TABLE IF NOT EXISTS work_graph_edges (
  id            TEXT PRIMARY KEY,
  from_type     TEXT NOT NULL,  -- workspace|task|project|plan|artifact|library_item|agent_run
  from_id       TEXT NOT NULL,
  relation      TEXT NOT NULL,  -- RELATES_TO|DEPENDS_ON|PRODUCES|DERIVED_FROM
  to_type       TEXT NOT NULL,
  to_id         TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE(from_type, from_id, relation, to_type, to_id)
);
CREATE INDEX IF NOT EXISTS idx_wge_from ON work_graph_edges(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_wge_to   ON work_graph_edges(to_type, to_id);
CREATE INDEX IF NOT EXISTS idx_wge_rel  ON work_graph_edges(relation);
```

- **不建** `work_graph_nodes`。
- **迁移幂等**：`IF NOT EXISTS` + `user_version` 递增；旧库升级不丢数据。
- **entity existence validation**：`addEdge` 时校验 `from/to` 存在（查 `spaces/tasks/projects/...`），不存在则拒绝。
- **cycle 校验**：仅 `DEPENDS_ON` 需 DAG 检测（DFS/BFS 从 `to` 追 `DEPENDS_ON` 是否可达 `from`），`RELATES_TO` 允许环。
- **delete cleanup**：`deleteTask / deleteProject / deleteSpace` 等已有路径追加 `DELETE FROM work_graph_edges WHERE (from_type,from_id) OR (to_type,to_id)`。

---

## 4. Service 契约

```text
WorkGraphService
  addEdge(input) -> { id, created } | throw(validation/cycle/duplicate)
  removeEdge(id) -> void
  listOutgoing(from_type, from_id, relation?) -> Edge[]
  listIncoming(to_type, to_id, relation?) -> Edge[]
  listRelated(node, relation?) -> Edge[]   // outgoing ∪ incoming，去重
```

- **Centralized validation**：所有写入口收口于 Service，Renderer/IPC 不直写表。
- **去重**：`(from,to,relation)` 唯一约束幂等；重复 `addEdge` 返回已存在 id。
- **只读 Agent 工具**：`query_work_graph`（Phase 6 仅读），写操作需后续显式 mutation 权限。

---

## 5. UI / Agent 约束

- **首版 UI（Phase 6）**：`Entity detail panel` 内 `Related / Depends on / Produced / Derived from` 列表，支持 `添加/删除/跳转`，**不做无限画布/力导向图**。
- **Agent**：Phase 6 仅开放 `query_work_graph` 只读；写 edge 工具后置且需明确授权。
- **Scope filter**：Phase 9 前不提供全量 Graph View；后续若提供，默认按 `current Workspace/Project scope` 过滤，不渲染全库。

---

## 6. 非目标（Explicitly Out of Scope for Phase 6）

- `Project / Plan / Task` 与 Workspace Tree 的融合
- `Subagent` 永久化为 Workspace child
- `FileProvider / ArtifactProvider / MemoryProvider` 新 Provider
- `R3 Semantic` 全库 vector search（保持 `OPTIONAL/DEFERRED`）
- 复杂 Graph Canvas / 全量加载

---

## 7. 验收标准（Phase 6 DoD, §29）

```text
Existing entities remain Source of Truth
No duplicate ownership truth
Typed edge works (RELATES_TO / DEPENDS_ON / PRODUCES / DERIVED_FROM)
DEPENDS_ON cycle blocked, RELATES_TO can cycle
Delete entity cleanup safe
Query deterministic
UI can inspect relation
Agent can query relation
Workspace Context semantics unchanged
Permission semantics unchanged
P0=0 P1=0 P2=0
```

---

## 8. 风险与回滚

- 风险：早期把 `Workspace parent` 双写进 graph 导致分裂 → **ADR 已禁止**，Review 时重点核 `AppDatabase.moveSpace` 仍为唯一真源。
- 回滚：`work_graph_edges` 无 FK，删表即回滚，不影响 `spaces/tasks/projects` 真实数据；重大迁移沿用 `pre-migration backup` 策略。

---

## 9. 后续 Phase 锚点

- **Phase 7**：`Project RELATES_TO Workspace / Plan CONTAINS Task` 等 Bridge，复用本 ADR 的 `from_type/to_type` 与 `Source of Truth` 原则。
- **Phase 8**：`AgentRun` 实体与 `SPAWNED_BY` 关系，不改变 Workspace Context 规则。
- **Phase 10**：`orphan edge / invalid ref / dependency cycle` 的 `integrity check` 只读检查。

> 任何后续设计若违反「Workspace 管 Context；Work Graph 管 Relation；Locator 管 Discovery；Permission 管 Access；真实 Service 永远是 Source of Truth」，先停下来重审 ADR。
