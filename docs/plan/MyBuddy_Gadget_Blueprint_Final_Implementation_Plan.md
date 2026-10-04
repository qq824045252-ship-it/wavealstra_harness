# MyBuddy Gadget + Blueprint 最终架构实施规格

> **用途**：直接交给 Codex 执行。  
> **基线 Review**：Pi 只读架构 Review，分支 `codex/recovery-20260811`，Review HEAD `b359f99 feat(multispace-ux): expose primary workspace entry`。  
> **Review 结果**：源码未修改，Git HEAD 未变化；当前 `AppDatabase` schema version = 17；现有 Multi-Space / Artifact / Project Template 基础可直接复用。  
> **本文件定义的是最终目标，不是 V1/V2，也不是探索性方案。Codex 必须按本文完成，不得擅自改产品方向。**

---

# 0. Codex Execution Contract — 强制执行契约

以下规则优先级高于 Codex 自己的“顺手优化”“架构美化”“完整验证”倾向。

## 0.1 严格按本文执行

Codex 必须：

- 只实现本文定义的 **Gadget + Blueprint** 最终架构。
- 严格遵守本文的 Domain 边界、数据语义、UI 语义、删除语义和实例化语义。
- 如当前 HEAD 相对 Review HEAD 已继续变化，必须基于**当前真实代码**适配，但不得改变本文最终目标。
- 发现已有能力时优先复用，不得重复建设第二套服务、第二套树、第二套模板体系、第二套 Artifact Runtime。
- 遇到文档中路径与当前代码存在轻微变化时，以**职责和现有真实模块**为准，不能因为路径变动而另起新架构。

## 0.2 禁止扩题

禁止：

- 顺手重构无关模块。
- 顺手整理整个代码库。
- 修改与 Gadget / Blueprint 无直接关系的 UX。
- 为“架构统一”去重写现有 Workspace、Task、Artifact、Project、Library。
- 引入 Cloudflare OS 代码、Cloudflare Workers、workerd、远程容器、多租户、云端账单模型。
- 把本任务扩展为 MCP、安全模型、权限模型、Sandbox 或 Terminal 重构。

## 0.3 测试约束：禁止长测，禁止 E2E

**这是硬约束。**

Codex 不得运行：

- E2E 测试。
- Playwright / Spectron / 全应用 UI 自动化。
- 全量测试套件。
- 长时间 soak / stress / endurance 测试。
- 无必要的全库 integration suite。
- 为“保险”而跑的长时全量 build + test 组合。

允许且要求按需执行：

- 与本任务直接相关的 targeted unit tests。
- 与 Gadget / Blueprint 直接相关的 targeted integration tests。
- 相关数据库 migration 测试。
- 相关 IPC contract 测试。
- 必要的 targeted typecheck。
- 必要的 targeted lint。
- 必要的 build 校验；若完整 build 明显耗时，优先缩小验证范围。

原则：

> **只验证本次真实改动，不进行长验证。**

若某测试预计明显耗时，应先缩小测试粒度，不得直接启动长测。

## 0.4 完成报告必须明确写出

Codex 完成后必须输出：

1. 实际修改文件清单。
2. 已完成目标清单。
3. 未完成目标清单（如果有，必须明确，不得假装完成）。
4. 实际执行的最小验证命令与结果。
5. 明确写：**未运行 E2E**。
6. 明确写：**未运行长测 / 全量测试套件**。
7. 现存风险与后续注意点。

---

# 1. 本次最终目标

本次完成后，MyBuddy 必须正式形成四类清晰的一等工作资源：

```text
MyBuddy
│
├── Workspace
│     工作的长期容器
│
├── Artifact
│     工作产生的内容 / 结果
│
├── Gadget
│     工作中可持续运行、反复使用的轻量应用
│
└── Blueprint
      可重复实例化的工作方法 / 工作环境定义
```

最终产品语义固定为：

```text
Workspace = Where work lives
Artifact  = What work produces
Gadget    = What work uses
Blueprint = How work is organized
```

中文语义：

- Workspace：工作在哪里发生。
- Artifact：工作产生了什么。
- Gadget：工作使用什么工具。
- Blueprint：这类工作应该怎样组织。

这些概念必须从 Domain 层、数据库、IPC、Renderer 到 UX 全部一致。

---

# 2. 本次明确不改的范围

以下领域已经冻结，本任务**禁止改变其现有行为**：

```text
src/main/security/McpSideEffectPolicy.ts
src/main/security/TaskFileAccessPolicy.ts
src/shared/external-write.ts（或当前真实对应路径）
src/main/security/TaskExecutionIsolation.ts
src/main/task/TaskIsolationAudit.ts
src/main/terminal/*
src/main/mcp/*
```

以及：

- MCP 权限模型。
- MCP side-effect 策略。
- External Write Approval。
- Task File Access Policy。
- OS Sandbox / guarded / cwd-only 行为。
- Terminal security。
- PC MCP / Pi MCP 行为。
- Cloudflare Gatekeeper / Capability。

若新增 Gadget / Blueprint 的 IPC 或服务必须引用现有类型，可以做**纯连接性改动**，但不得改变上述模块行为。

---

# 3. Pi Review 对当前真实代码的关键结论

Codex 执行前必须理解以下现状，避免重造。

## 3.1 Workspace 已经是稳定长期容器

现有基础包括：

- `src/main/db/AppDatabase.ts` 中 Space/Workspace 数据模型，已有 `parentId / sortOrder`。
- `src/shared/workspace-tree.ts` 已形成稳定树模型。
- Workspace Shared Context 已有父子继承语义。
- Workspace Library Binding 已有 inherited/reference 的展示基础。
- Task 已能绑定 Workspace / Space。

**禁止新建第二套 Workspace Tree。**

## 3.2 Artifact 已是成熟独立 Domain

现有：

```text
src/main/artifact/
├── ArtifactService
├── ArtifactRepository
├── ArtifactRegistry
├── ArtifactStorage
├── ArtifactProtocol / Preview Host 等
```

Shared 中已有 `ArtifactDescriptor`、version/revision、`workspace-file | managed-content` 等语义。

Artifact Registry 是可从持久化 Truth 重建的 cache。

**因此 Gadget 绝不能通过 `Artifact + isGadget=true` 实现。**

## 3.3 当前代码中没有 Gadget Domain

Pi Review 对 `src` 搜索确认：当前没有正式 Gadget 实体、Service、Repository、Runtime、Storage、IPC 或 Renderer Domain。

因此 Gadget 需要新增，但必须与 Artifact 并列，而不是侵入 Artifact。

## 3.4 Project Template 已经是 Blueprint 的直接基础

当前已有：

```text
src/shared/project-template/
├── types
├── builtins
├── resolver
└── creation-plan
```

已有重要能力：

```text
ProjectTemplateDefinition
        ↓
resolveProjectTemplate()
        ↓
ResolvedProjectTemplate
├── resolved
├── missing
└── warnings
        ↓
buildProjectCreationPlan()
```

并且现有设计已经支持：

- capability/resource 缺失时产生 warning。
- 不因为 optional resource 缺失而整单 throw。
- creation-plan 再交由现有 Domain Service 执行。

**Blueprint 必须吸收和复用这套能力，不得新造第二套 resolver/template 系统。**

## 3.5 当前 AppDatabase schema version = 17（以 Review HEAD 为准）

新增 migration 时：

- 如果 Codex 执行时当前 schema 仍为 17，则 Gadget / Blueprint migration 可顺延为 18 / 19。
- 如果当前 HEAD 已新增 migration，必须按当前最新版本继续递增。
- **禁止硬退回 18/19，禁止覆盖后来 migration。**

---

# 4. Gadget 最终 Domain 定义

## 4.1 Gadget 是独立一等实体

定义：

> Gadget 是由 AI 或用户创建、可以持续运行、反复打开、拥有独立源代码/配置/持久数据和运行生命周期的轻量应用。

典型 Gadget：

- Calibration Analyzer
- Production Dashboard
- BOM Comparator
- Modbus Register Builder
- Test Result Viewer
- CRC Calculator
- Experiment Dashboard
- Internal Workflow UI

## 4.2 Gadget != Artifact

Artifact：

```text
Markdown / Code / HTML / SVG / Image / PDF / DOCX / ...
```

特征：

- 内容型。
- 可预览。
- 可版本化。
- 通常由任务产生。
- 不拥有独立应用进程生命周期。

Gadget：

- 应用型。
- 有正式 manifest。
- 有独立 Gadget ID。
- 有独立源码/资源目录。
- 有 start / stop / restart / dispose / health 生命周期。
- 可以长期存在。
- 可以跨 Task / Workspace 调整归属。

绝对禁止：

```text
ArtifactDescriptor.capabilities.isGadget = true
```

或任何等价“打标升级 Artifact”方案。

Artifact Registry 与 Gadget Runtime/Registry 必须独立。

---

# 5. Gadget Scope 最终模型

Gadget 不是 Project 附属品。

必须支持三种 Scope：

```ts
type GadgetScope =
  | { type: 'global' }
  | { type: 'workspace'; workspaceId: string }
  | { type: 'task'; taskId: string }
```

产品语义：

## 5.1 Global Gadget

属于用户的通用工具。

例如：

```text
My Gadgets
├── CRC Calculator
├── Modbus Tool
├── CSV Analyzer
└── BOM Comparator
```

可在任何聊天、任务或 Workspace 中重新使用。

## 5.2 Workspace Gadget

属于指定 Workspace。

例如：

```text
Workspace: VDS-100
├── Context
├── Library
├── Files
├── Tasks
├── Artifacts
└── Gadgets
    ├── Calibration Analyzer
    └── Validation Dashboard
```

Workspace Gadget 不复制到子空间。

子空间如果需要看到父空间 Gadget，应显示为：

```text
Current
Inherited / Parent reference
```

仅引用，不复制数据，不产生新 Gadget ID。

## 5.3 Task Gadget

属于一次 Task，可用于临时分析/临时交互应用。

Task Gadget 必须允许提升/迁移到长期 Scope。

---

# 6. Gadget Scope Move / Promote

Scope 迁移必须是正式 Domain 能力，不是 Renderer workaround。

必须支持：

```text
Task      → Workspace
Task      → Global
Workspace → Global
Workspace → another Workspace
Global    → Workspace
```

统一入口：

```text
GadgetService.moveScope(...)
```

要求：

- Gadget ID 不变。
- Gadget source 不重建。
- Gadget persistent data 不丢。
- createdAt 不重置。
- 只更新 scope / ownership 相关字段。
- 迁移必须原子完成。

`projectId` 不得成为 Gadget 的必填字段。

---

# 7. Gadget Main Process Domain

新增独立目录：

```text
src/main/gadget/
├── GadgetService.ts
├── GadgetRepository.ts
├── GadgetStorage.ts
├── GadgetRuntime.ts
├── GadgetRegistry.ts
└── GadgetLifecycle.ts   # 若职责必要，可合并但不能散到 renderer
```

Shared：

```text
src/shared/gadget-types.ts
src/shared/gadget-ipc.ts
```

职责固定：

## 7.1 GadgetRepository

- SQLite durable truth。
- CRUD。
- Scope 查询。
- Scope move transaction。
- 不负责启动进程。

## 7.2 GadgetStorage

负责 Gadget 源码/资源/持久数据目录。

推荐长期根：

```text
~/.mybuddy/gadgets/<gadgetId>/
```

可以在内部区分：

```text
code/
data/
```

Task-scoped Gadget 如果需要利用 TaskExecutionWorkspace 作为工作 cwd，可以引用现有 Task workspace，但 **Gadget durable identity/storage 不能依赖 Task workspace 的可销毁临时状态**。

## 7.3 GadgetRegistry

- 只保存可重建的 runtime registry / descriptor cache。
- 可以从 Repository 重建。
- 不承担 durable truth。

## 7.4 GadgetRuntime

唯一负责 Gadget 运行生命周期：

```text
start
afterStart / health
stop
restart
dispose
```

Renderer 不得 spawn。

Renderer 不得自己维护 PID / port / child process。

GadgetRuntime 必须统一管理所有运行实例，确保关闭 MyBuddy / 删除 Gadget 时能正确 dispose。

## 7.5 GadgetService

所有业务操作统一从 Service 进入：

```text
create
list/get
moveScope
start
stop
restart
dispose
delete
createFromBlueprint
convertFromArtifact
```

Renderer / IPC 不得绕过 GadgetService 直接组合 Repository + Storage + Runtime。

---

# 8. Gadget Durable Descriptor 与 Runtime State 分离

最终模型必须避免把运行时 PID/port 当成 Gadget durable truth。

建议 durable entity：

```ts
interface GadgetDescriptor {
  id: string
  name: string
  description?: string
  scope: GadgetScope
  type: 'web'
  manifestPath: string
  sourcePath: string
  createdByTaskId?: string
  blueprintId?: string
  metadata: Record<string, unknown>
  createdAt: number
  updatedAt: number
}
```

Runtime state：

```ts
interface GadgetRuntimeState {
  gadgetId: string
  status: 'stopped' | 'starting' | 'running' | 'error'
  url?: string
  port?: number
  pid?: number
  startedAt?: number
  error?: string
}
```

Runtime state 默认可以是内存态。

若产品需要崩溃恢复/重启恢复，可建立独立 runtime-state 持久结构，但不得把 PID/port 混进 Gadget definition 本体。

---

# 9. Gadget Manifest

每个 Gadget 必须存在 MyBuddy 自己的正式 manifest：

```text
gadget.json
```

`package.json` 不得作为 Gadget 唯一识别方式。

推荐目录：

```text
<gadget-root>/
├── gadget.json
├── package.json        # 可选/依实现存在
├── src/
└── data/
```

`gadget.json` 至少包含：

```ts
interface GadgetManifest {
  schemaVersion: number
  name: string
  type: 'web'
  entry: string
  defaultConfig?: Record<string, unknown>
}
```

不要在本任务中扩展 Cloudflare 式 permission/capability 系统。

如后续需要 Gadget 权限，可在未来单独设计；本次不得借机修改 MCP/Sandbox。

Manifest 写入必须原子、安全，优先参考现有 `.mybuddy-task.json` 的写法。

---

# 10. Gadget Runtime 最终运行语义

首个正式运行类型固定为：

```text
web
```

但 Domain 结构应允许以后新增其他 runtime type，而不需要重写 Gadget 实体。

运行链：

```text
GadgetDescriptor
      ↓
GadgetRuntime.start(id)
      ↓
Runtime Instance
      ↓
local URL
      ↓
MyBuddy Gadget View
```

要求：

- 端口由 Main Process 管理。
- 进程由 Main Process 管理。
- Runtime 实例与 Gadget ID 绑定。
- start 必须幂等/可识别 already running。
- stop 必须可靠释放。
- restart = stop + start 的受控生命周期。
- delete 前必须 dispose。
- App shutdown 时必须统一 dispose 所有运行 Gadget。
- 失败必须形成可读 error state，不得静默吞掉。

不要复用 `WebArtifactRuntime` 作为 Gadget 进程宿主。

`WebArtifactRuntime` 属于 Artifact/Preview 语义；Gadget Runtime 是长期应用宿主，两者生命周期必须独立。

---

# 11. Gadget UX 最终要求

Gadget 是一级资源，但**不是新的一级工作模式**。

禁止：

```text
办公 | 代码 | 设计 | Gadget
```

## 11.1 Global 入口

现有 Sidebar 资源区增加：

```text
My Gadgets
```

它展示 `scope=global` 的 Gadget。

这不是新的 Mode，而是资源入口。

## 11.2 Workspace Detail

现有 Workspace Detail 当前已有：

```text
Overview | Context | Library | Files
```

增加正式：

```text
Gadgets
```

最终：

```text
Overview | Context | Library | Files | Gadgets
```

Gadgets 页面/区域需区分：

```text
Current Space Gadgets
Inherited / Parent Gadgets
```

继承项只引用，不复制。

## 11.3 Task Gadget

Task Detail / Task 相关 UI 必须能显示该 Task 的 Gadget。

可复用同一个 Gadget Section/Card 组件，不得为 Task/Workspace/Global 写三套不一致 UI。

## 11.4 默认体验

用户创建 Gadget 后默认看到：

```text
Calibration Analyzer
[Open]
```

而不是：

```text
npm install
vite
localhost:5173
package.json
PID
```

开发细节可放到 Advanced / Files / Developer 信息区，但不是默认产品体验。

---

# 12. Artifact ↔ Gadget 关系

两者独立，但允许显式转换/产出。

## 12.1 Artifact → Gadget

允许：

```text
HTML Artifact
   ↓ Convert to Gadget
New Gadget
```

转换要求：

- 创建新的 Gadget ID。
- 复制必要内容到 Gadget Storage。
- 创建正式 `gadget.json`。
- 不共享 Artifact ID。
- 不共享 Artifact version/revision 生命周期。
- 原 Artifact 保留。

禁止：

```text
artifact.isGadget = true
```

## 12.2 Gadget → Artifact

Gadget 可以导出正式工作成果：

```text
Calibration Analyzer
      ↓ Export
PDF / HTML / Markdown Artifact
```

导出的 Artifact 是独立资源。

删除 Gadget 不得删除已经产生的 Artifact。

---

# 13. Blueprint 最终 Domain 定义

Blueprint 不是“Project Template 改个名字”这么简单，但必须复用其成熟能力。

定义：

> Blueprint 是一个可重复实例化的工作环境定义，用来固化结构、默认资源、任务组织、Gadget 和工作方法。

核心语义：

```text
Blueprint
=
Schema
+ Structure
+ Configuration
+ Behavior
```

绝不是：

```text
Blueprint = Workspace Snapshot
```

---

# 14. Blueprint Kind

Shared 统一定义：

```ts
type BlueprintKind =
  | 'workspace'
  | 'gadget'
  | 'composite'
```

产品层统一叫：

```text
Blueprint
```

不要暴露多个互相竞争的术语：

```text
Project Template
Workspace Template
Gadget Template
Composite Template
```

内部可以保留兼容旧代码的 adapter，但最终 Domain Language 统一为 Blueprint。

---

# 15. Blueprint 必须复用现有 Project Template 基础

当前：

```text
src/shared/project-template/
├── types
├── builtins
├── resolver
└── creation-plan
```

这是本任务最重要的复用点。

目标管道：

```text
BlueprintDefinition
       ↓
BlueprintResolver
       ↓
Resolved Blueprint
├── resolved
├── missing
└── warnings
       ↓
BlueprintInstantiationPlan
       ↓
BlueprintService.instantiate()
       ↓
Existing Domain Services
```

必须保留现有 resolver 的优点：

- optional resource 缺失不整单 throw。
- `missing` 明确记录。
- `warnings` 明确返回。
- 能创建的部分继续创建。

禁止：

- 新建第二套与 `resolveProjectTemplate` 平行、重复的 capability resolver。
- Renderer 自己解释 Blueprint definition。
- Renderer 自己串多个 IPC 完成实例化。

Codex 可以：

- 重命名/抽象现有 `project-template` 中可泛化逻辑。
- 提取共享 resolver helper。
- 为旧 Project Template 提供 adapter。

但必须保证现有 Project Template 行为不退化。

---

# 16. Workspace Blueprint

Workspace Blueprint 用来描述一棵可实例化的工作空间树及默认工作内容。

示例：

```text
Instrument Development
│
├── Product Definition
├── Hardware
│   ├── Schematic
│   ├── PCB
│   └── BOM
├── Firmware
├── Validation
└── Production
```

定义至少支持：

```ts
interface WorkspaceBlueprintNode {
  key: string
  name: string
  children?: WorkspaceBlueprintNode[]
  defaultContext?: string
  libraryBindings?: BlueprintLibraryBinding[]
  files?: BlueprintFile[]
  tasks?: BlueprintTaskDefinition[]
  gadgets?: BlueprintGadgetReference[]
}
```

`key` 是 Blueprint 内稳定引用键。

实例化前没有真实 `workspaceId`。

实例化时：

```text
Blueprint key
    ↓
new workspaceId
```

不要在 definition 中保存真实实例 ID。

---

# 17. Gadget Blueprint

稳定 Gadget 可以保存为 Blueprint。

保存：

- Gadget 源代码。
- `gadget.json`。
- 必要资源文件。
- 默认配置。
- Blueprint metadata。

绝对不保存：

- PID。
- port。
- Runtime status。
- 当前运行缓存。
- 用户私有数据。
- 历史执行数据。
- Credential。
- Workspace/Task 的实例 ID。

实例化：

```text
Gadget Blueprint
       ↓
new Gadget ID
new Gadget Storage
new Scope
fresh runtime state
```

---

# 18. Composite Blueprint

Composite Blueprint 是最终核心能力。

它可以一次定义：

```text
Workspace Tree
+
Context
+
Library Bindings
+
Files
+
Tasks
+
Gadgets
```

示例：

```text
Blueprint: Instrument Development

Workspace Tree
├── Product Definition
├── Hardware
│   └── Gadget: BOM Review
├── Firmware
├── Validation
│   ├── Gadget: Calibration Analyzer
│   └── Gadget: Validation Dashboard
└── Production
```

实例化后形成全新的长期工作环境。

Blueprint 实例与 Blueprint 本体之后互不绑定生命周期。

删除 Blueprint 不得删除已实例化 Workspace/Gadget/Task。

---

# 19. Blueprint Definition 数据红线

Blueprint 只保存“工作方法和结构”，不得保存业务事实或运行态。

禁止进入 definition：

- ERP 当前库存。
- ERP 当前订单。
- 客户真实数据。
- 历史实验结果。
- Task conversation history。
- Agent session。
- Credential / token / OAuth state。
- Gadget runtime data。
- PID / port。
- cache。
- `node_modules`。
- `.next` / build cache。
- `.mybuddy-task.json`。
- 临时日志。
- 用户 home 中无关文件。

Blueprint 可以保存：

- “ERP Dashboard Gadget 的定义”。
- “从 ERP 读取什么”的配置结构（不包含 secret）。

但不保存 Gadget 当前读出来的 ERP 数据。

原则：

```text
Blueprint defines HOW to work / HOW to fetch
not the current fetched data
```

---

# 20. Blueprint schemaVersion

每个 Blueprint definition 必须存在：

```ts
schemaVersion: number
```

Blueprint schema migration 与 AppDatabase migration 是两个概念。

需要提供：

```text
BlueprintDefinitionMigrator
```

或等价明确迁移入口。

读取旧 Blueprint 时先 migration/normalize，再交给 resolver。

禁止依赖数据库版本去猜 Blueprint JSON 结构。

---

# 21. Blueprint Main Process Domain

新增：

```text
src/main/blueprint/
├── BlueprintService.ts
├── BlueprintRepository.ts
├── BlueprintResolver.ts
├── BlueprintInstantiationPlanner.ts
├── BlueprintSerializer.ts / Migrator.ts
└── ...仅按真实职责需要增加
```

Shared：

```text
src/shared/blueprint-types.ts
src/shared/blueprint-ipc.ts
```

职责：

## BlueprintRepository

- durable definition truth。
- CRUD。
- 不创建 Workspace / Task / Gadget。

## BlueprintResolver

- 复用/泛化现有 Project Template resolver。
- 输出 `resolved / missing / warnings`。

## BlueprintInstantiationPlanner

把 definition 转换为明确可执行 plan。

示意：

```ts
interface BlueprintInstantiationPlan {
  workspaces: ...[]
  tasks: ...[]
  files: ...[]
  libraryBindings: ...[]
  gadgets: ...[]
  warnings: ...[]
}
```

## BlueprintService

只负责协调现有 Domain：

```text
WorkspaceService
Task / Project existing service
ArtifactService（仅确实需要初始化 Artifact 时）
WorkspaceLibraryBindingService
WorkspaceSharedContextService
GadgetService
```

**BlueprintService 不得自己重新实现这些 Domain 的 CRUD。**

---

# 22. Blueprint 实例化必须 Main Process 单入口

必须：

```text
window.api.blueprint.instantiate(...)
           ↓
BlueprintService.instantiate(...)
           ↓
resolve
           ↓
plan
           ↓
transaction / coordinated execution
```

禁止 Renderer：

```text
createWorkspace IPC
createTask IPC
createFile IPC
createGadget IPC
bindLibrary IPC
...
```

自己拼流程。

Renderer 只发“实例化这个 Blueprint”的意图。

---

# 23. 从 Workspace Capture Blueprint

必须支持：

```text
Workspace
   ↓ Save as Blueprint
Blueprint Definition
```

正式入口建议：

```text
BlueprintService.captureDefinition(workspaceId, options)
```

这里必须采用**白名单提取**，不能做目录 snapshot。

允许提取：

- Workspace Tree 结构。
- Context 定义/结构。
- Library binding definition。
- 用户明确选择的模板文件。
- Task definitions / suggestions。
- Gadget definitions / Blueprint references。

禁止提取：

- Conversation history。
- Task execution logs。
- Runtime state。
- Credential。
- `node_modules`。
- cache。
- build output。
- `.mybuddy-task.json`。
- 实际实验数据，除非用户明确将某文件作为 Blueprint seed/template 文件并且该行为符合现有文件语义。

方法名和实现语义必须是：

```text
captureDefinition
```

而不是：

```text
cloneWorkspace
snapshotWorkspace
```

---

# 24. 数据库最终结构

以当前真实 schema 版本为基础新增 migration。

## 24.1 gadgets

建议字段：

```text
id                  PK
name
description
scope_type          global | workspace | task
scope_id            nullable，或 workspace_id/task_id 分列（按现有 DB 风格选择）
type                web
manifest_path
source_path
created_by_task_id
blueprint_id
metadata_json
created_at
updated_at
```

必须有数据库级 scope invariant。

例如：

```text
global    => no workspace/task scope id
workspace => exactly workspace id
task      => exactly task id
```

可以采用单 `scope_id` + type，也可以分 `workspace_id/task_id`，但必须清晰且有 constraint/index。

## 24.2 gadget runtime state

默认不要求把 runtime state 放入 `gadgets` 表。

若确实需要重启恢复，可独立表：

```text
gadget_runtime_state
```

不要让 durable descriptor 与 PID/port 强耦合。

## 24.3 blueprints

至少：

```text
id
name
description
kind                 workspace | gadget | composite
schema_version
definition_json
created_at
updated_at
```

Definition JSON 必须通过 shared schema/type 验证，不得当任意 blob 无校验使用。

是否需要拆 `blueprint_gadget_refs` 等辅助表，由当前查询需求决定；**不要为了“数据库正规化”过度设计**。

Blueprint 的主体真相是 versioned definition。

---

# 25. 删除语义

## 25.1 Delete Gadget

必须：

```text
stop/dispose runtime
→ remove Gadget entity
→ remove Gadget storage / data according to explicit lifecycle
→ remove scope references
```

不得删除它已经生成的 Artifact。

## 25.2 Delete Workspace

Workspace-scoped Gadget 属于 Workspace 生命周期。

删除 Workspace 时：

```text
workspace-scoped gadgets → delete/dispose
```

Global Gadget 不受影响。

Task Gadget 按 Task 自己生命周期处理，不因为另一个 Workspace 删除被误删。

如果现有 DB 更适合显式 service cleanup 而不是 FK cascade，应沿用现有风格；关键是语义必须成立。

## 25.3 Delete Blueprint

只删除 Blueprint definition。

绝对不得删除：

- 已实例化 Workspace。
- 已实例化 Gadget。
- 已实例化 Task。
- 实例后生成的 Artifact。

---

# 26. IPC / Preload

必须建立正式 shared contract：

```text
src/shared/gadget-ipc.ts
src/shared/blueprint-ipc.ts
```

Preload 只暴露所需 API。

建议语义：

```text
window.api.gadget.list(...)
window.api.gadget.get(id)
window.api.gadget.create(...)
window.api.gadget.moveScope(...)
window.api.gadget.start(id)
window.api.gadget.stop(id)
window.api.gadget.restart(id)
window.api.gadget.delete(id)
window.api.gadget.convertFromArtifact(...)

window.api.blueprint.list(...)
window.api.blueprint.get(id)
window.api.blueprint.capture(...)
window.api.blueprint.instantiate(...)
window.api.blueprint.delete(id)
```

具体命名遵循当前项目 IPC 风格，不要求逐字一致，但必须：

- 类型真源在 shared。
- Renderer 不使用 any 绕过 contract。
- Renderer 不直接访问数据库。
- Renderer 不直接 spawn。

---

# 27. Renderer 最终结构

建议：

```text
src/renderer/src/components/gadget/
├── GadgetCard.tsx
├── GadgetSection.tsx
├── GadgetView.tsx
├── MyGadgetsView.tsx
└── GadgetActions.tsx

src/renderer/src/components/blueprint/
├── BlueprintPicker.tsx
├── BlueprintDetail.tsx
├── BlueprintCaptureDialog.tsx
└── BlueprintInstantiateFlow.tsx
```

路径可按当前项目 component convention 调整。

原则：

- 一个 Gadget presentation 组件体系服务 Global / Workspace / Task。
- 不写三套业务逻辑。
- inherited Gadget 使用 reference presentation，不 clone。
- Runtime control dispatch 到 Main Process。
- Renderer store 只是 read/projection/cache，不是 durable truth。

---

# 28. Blueprint UX 最终闭环

必须支持以下用户行为：

## 28.1 New from Blueprint

在合适的 Workspace/创建入口：

```text
Blank
Blueprints
├── Instrument Development
├── PCB Debug
├── Field Commissioning
└── ...
```

选择后由 `BlueprintService.instantiate()` 完整执行。

## 28.2 Save as Blueprint

成熟 Workspace 可以：

```text
Save as Blueprint
```

用户看到的是提取后的结构定义，不是整个文件系统 snapshot。

## 28.3 Gadget Save as Blueprint

稳定 Gadget 可以：

```text
Save as Blueprint
```

产生 `kind='gadget'` 的 Blueprint definition。

---

# 29. 必须打通的四个最终产品场景

这四个场景是验收核心，不允许只完成数据库/API 而没有产品闭环。

## 场景 A：独立任务/聊天创建 Gadget

```text
用户：给我做一个 CRC 计算器
          ↓
Agent / Task 创建 Gadget
          ↓
Task Gadget
          ↓
Open
          ↓
Move/Promote → My Gadgets
```

## 场景 B：Workspace 专属 Gadget

```text
Workspace: VDS-100
用户：做一个标定分析工具
          ↓
Workspace Gadget
Calibration Analyzer
```

重新进入 Workspace 后仍能看到并打开。

## 场景 C：保存成熟工作方法

```text
Workspace: VDS-100
          ↓
Save as Blueprint
          ↓
Instrument Development Blueprint
```

Definition 不包含 runtime/history/credential/脏数据。

## 场景 D：Blueprint 创建全新工作环境

```text
New Workspace / New from Blueprint
          ↓
Instrument Development Blueprint
          ↓
New Workspace Tree
+ Context
+ Library bindings
+ Tasks
+ Gadgets
```

实例与 Blueprint 后续生命周期独立。

---

# 30. 实施依赖顺序（不是 V1/V2）

这是同一个最终目标内部的工程依赖顺序，Codex 应顺序完成，不能把它解释为“先做简化版以后再说”。

## Step 0 — 当前代码再核对

执行前只做快速静态核对：

- 当前 HEAD。
- 当前 DB schema version。
- `project-template` 当前真实路径/接口。
- Workspace Detail 当前 tabs。
- Artifact Domain 当前接口。

不要长测。

## Step 1 — Shared types + DB migration

完成：

- Gadget shared model。
- GadgetScope invariant。
- GadgetManifest。
- Runtime state type。
- BlueprintDefinition / BlueprintKind / schemaVersion。
- BlueprintInstantiationPlan。
- DB tables/migration/index/constraints。

## Step 2 — Gadget durable Domain

完成：

- Repository。
- Storage。
- Registry。
- Service。
- create/get/list/delete。
- global/workspace/task scope。
- moveScope/promote。

## Step 3 — Gadget Runtime

完成：

- start。
- health。
- stop。
- restart。
- dispose。
- App shutdown cleanup。
- delete cleanup。

Renderer 仍不得 spawn。

## Step 4 — Blueprint Domain

完成：

- Repository。
- versioned definition。
- migrator/normalizer。
- Resolver（复用 project-template）。
- Planner。
- Service instantiate。
- warning/missing/resolved。

## Step 5 — Workspace/Gadget/Composite Definition

完成三 kind 的正式 schema 与 instantiate：

```text
workspace
gadget
composite
```

Composite 能一次落 Workspace tree + Tasks + Gadgets + bindings/files/context。

## Step 6 — Renderer / IPC 闭环

完成：

- My Gadgets。
- Workspace Gadgets tab/section。
- Task Gadgets。
- current/inherited/reference。
- open/start/stop/restart/delete/move scope。
- Blueprint picker。
- capture/save as Blueprint。
- instantiate。

## Step 7 — Capture / Convert / Delete semantics

完成：

- Workspace → Blueprint white-list capture。
- Gadget → Gadget Blueprint。
- Artifact → Gadget explicit conversion。
- Gadget → Artifact export 接口若现有 Artifact 流程可自然落地，则接通；不得为此重构 Artifact。
- Delete Workspace / Gadget / Blueprint 语义全部闭环。

## Step 8 — Targeted validation only

只做本文第 32 节列出的最小验证。

---

# 31. Codex 必须避免的具体反模式

以下任何一种出现，都视为执行偏离：

1. `Artifact.capabilities.isGadget`。
2. `Artifact.kind = gadget`。
3. Gadget 与 Artifact 共用同一 Registry/Lifecycle。
4. `projectId` 成为 Gadget 必填。
5. 只有 Workspace 才能创建 Gadget。
6. Task Gadget 无法提升为长期 Gadget。
7. 子空间继承 Gadget 时复制 Gadget 数据。
8. `package.json` 是 Gadget 唯一识别方式。
9. Renderer `child_process.spawn/fork`。
10. Renderer 自己维护 port/PID。
11. 用 `WebArtifactRuntime` 直接充当 Gadget Runtime。
12. Blueprint = workspace 文件夹 snapshot。
13. Blueprint definition 包含 credential/session/runtime/cache。
14. Blueprint 新造一套 resolver，绕开现有 `project-template`。
15. Renderer 串多个 create IPC 拼 Composite Blueprint。
16. 删除 Blueprint 级联删除实例。
17. 删除 Gadget 级联删除它已经产生的 Artifact。
18. 新增顶级 “Gadget Mode”。
19. 改 MCP / Sandbox / Terminal security。
20. 引入 Cloudflare OS/runtime。
21. 为实现本任务跑 E2E。
22. 为实现本任务跑长测试/全量测试。
23. 因为发现旁支 bug 就顺手大修无关模块。

---

# 32. 最小测试与验证要求

**禁止 E2E，禁止长测。**

Codex 只需要覆盖关键 Domain 真实性。

建议 targeted tests（按现有测试框架和路径调整）：

## 32.1 Gadget Scope

验证：

- global 创建合法。
- workspace 创建合法。
- task 创建合法。
- scope invariant 非法组合被拒绝。
- 不要求 projectId。
- Task → Workspace move 后 ID 不变、data/source 不丢。
- Workspace → Global 后 ID 不变。

## 32.2 Gadget Repository / Storage

验证：

- CRUD。
- manifest 读写。
- source path 稳定。
- delete 清理 Storage。
- 删除 Gadget 不影响 Artifact。

## 32.3 Gadget Runtime

使用最小 dummy Gadget：

- start → running。
- health 正常。
- stop。
- restart。
- dispose。
- runtime error 可观测。

测试应快速结束，不做 soak。

## 32.4 Blueprint Resolver

验证：

- definition 可解析。
- missing optional resource → warning，不整单失败。
- schema migration/normalize。
- workspace/gadget/composite kind 正常。

## 32.5 Blueprint Capture

验证白名单：

- 能提取 workspace tree/context/bindings/task defs/gadget defs。
- 不包含 credential。
- 不包含 runtime state。
- 不包含 conversation/session。
- 不包含 `node_modules/cache/.mybuddy-task.json`。

## 32.6 Blueprint Instantiation

快速 targeted integration：

- 一个最小 composite blueprint。
- 创建 workspace tree。
- 创建一个 task。
- 创建一个 gadget。
- warning 正确返回。

无需启动完整 Electron UI E2E。

## 32.7 Migration

- 从当前 schema 前一版本升级。
- 空库初始化。
- existing data 不损坏。
- migration 幂等行为符合现有 AppDatabase 规范。

---

# 33. 完成 Definition of Done

以下项目全部成立，任务才算真正完成：

## Gadget

- [ ] Gadget 是独立正式 Entity，不依赖 Artifact Entity。
- [ ] Gadget 支持 `global | workspace | task` 三种 Scope。
- [ ] `projectId` 不是必填。
- [ ] Gadget Scope move/promote 不改变 ID、不丢数据。
- [ ] Gadget 有独立 `gadget.json` manifest。
- [ ] Gadget 有 Repository / Storage / Service / Runtime / Registry 边界。
- [ ] Renderer 不 spawn。
- [ ] Gadget 支持 start / stop / restart / dispose / health。
- [ ] My Gadgets 能展示 Global Gadget。
- [ ] Workspace Detail 有正式 Gadgets 入口。
- [ ] Task 能展示 Task Gadget。
- [ ] 子空间能看到 inherited parent Gadget reference，但不复制。
- [ ] 删除 Gadget 不删除其 Artifacts。
- [ ] Artifact → Gadget 是显式创建新实体，不是打标。

## Blueprint

- [ ] Blueprint 成为统一模板 Domain language。
- [ ] 现有 Project Template resolver/creation-plan 能力被复用，而非重复建设。
- [ ] 支持 `workspace | gadget | composite` 三种 kind。
- [ ] Definition 有 `schemaVersion`。
- [ ] Workspace Blueprint 能描述 Workspace Tree。
- [ ] Workspace Blueprint 能描述 context/library/files/tasks/gadget refs。
- [ ] Gadget Blueprint 不复制 runtime/user data。
- [ ] Composite Blueprint 能一次实例化 Workspace + Tasks + Gadgets。
- [ ] Blueprint instantiate 通过 Main Process 单入口。
- [ ] Renderer 不串多 IPC 组装。
- [ ] optional resource 缺失返回 warning/missing，不整单失败。
- [ ] Workspace 可以 capture/save as Blueprint。
- [ ] Capture 使用白名单，不是 snapshot。
- [ ] 删除 Blueprint 不影响已实例化资源。

## Regression / Boundaries

- [ ] Multi-Space 现有行为不退化。
- [ ] Workspace Tree 没有第二套实现。
- [ ] Artifact 现有行为不退化。
- [ ] Project Template 现有能力不退化。
- [ ] MCP 行为没有改变。
- [ ] Sandbox / Isolation 行为没有改变。
- [ ] Terminal security 没有改变。
- [ ] 没有引入 Cloudflare runtime。
- [ ] 没有新增 Gadget Mode。
- [ ] 没有 E2E。
- [ ] 没有长测 / 全量测试。

---

# 34. 最终目标架构图

```text
                             MyBuddy
                                │
        ┌───────────────────────┼────────────────────────┐
        │                       │                        │
        ▼                       ▼                        ▼
    Workspace                Artifact                  Gadget
 “工作在哪里”             “产生了什么”              “用什么工作”
        │                       │                        │
        │                       │                  ┌─────┴─────┐
        │                       │                  │           │
        │                       │               Runtime      Storage
        │                       │                  │           │
        │                       │                  └─────┬─────┘
        │                       │                        │
        └───────────────────────┼────────────────────────┘
                                │
                                ▼
                            Blueprint
                         “工作应该怎么做”
                                │
                     ┌──────────┼───────────┐
                     ▼          ▼           ▼
                  workspace    gadget    composite
                                │
                                ▼
                   BlueprintInstantiationPlan
                                │
                                ▼
                      Existing Domain Services
```

资源归属：

```text
MyBuddy
│
├── My Gadgets
│   └── Global Gadgets
│
├── Independent Task
│   └── Task Gadgets
│
└── Workspace / Multi-Space
    ├── Context
    ├── Library
    ├── Files
    ├── Tasks
    ├── Artifacts
    ├── Gadgets
    │   ├── Current
    │   └── Inherited References
    └── Child Workspaces
```

Blueprint：

```text
Blueprint
    │
    ▼ instantiate
Workspace
├── Context
├── Library Bindings
├── Files
├── Tasks
├── Artifacts（工作运行后产生）
└── Gadgets
```

---

# 35. 最终工程判断

本任务不是“把 Cloudflare OS 的 Gadget / Blueprint 移植进 MyBuddy”。

正确目标是：

> **在保持 MyBuddy Electron、本地优先、Multi-Space、Task、Artifact、Project Template 真实基础不变的前提下，把 Gadget 建成独立应用资源，把 Blueprint 建成统一的可实例化工作方法。**

Pi Review 已确认：

- Multi-Space 不需要推翻。
- Artifact 不需要重做。
- Project Template 已经为 Blueprint 提供成熟 resolver / warning / creation-plan 基础。
- Gadget 当前没有正式 Domain，因此必须独立建立。
- Gadget / Blueprint 可以以最小侵入方式加入当前主架构。

完成后，MyBuddy 的产品能力应从：

```text
AI + Task + Workspace + Files + Artifact
```

升级为：

```text
AI
+ Task
+ Workspace
+ Artifact
+ 可持续运行的 Gadget
+ 可重复实例化的 Blueprint
```

最终达到：

> **AI 不仅能完成任务和产生内容，还能创造以后持续使用的工具，并把成熟工作方法沉淀成可重复创建的工作环境。**

---

# 36. 最后的 Do Not Do（再次强调）

Codex 在整个任务结束前再次检查：

- **不要改 MCP。**
- **不要改 Sandbox / Isolation。**
- **不要改 Terminal security。**
- **不要重做 Artifact。**
- **不要重做 Multi-Space。**
- **不要创建第二套 Project/Workspace Template 系统。**
- **不要把 Gadget 限制为只能存在于项目/Workspace。**
- **不要让 Renderer spawn。**
- **不要把 Blueprint 做成 snapshot。**
- **不要新增 Gadget 顶级 Mode。**
- **不要引入 Cloudflare OS/runtime。**
- **不要跑 E2E。**
- **不要跑长测。**
- **不要跑全量测试套件。**
- **不要偏离本文最终目标做“以后可能有用”的额外架构。**

严格执行本文，按依赖顺序完成同一个最终目标，并用最小 targeted tests 验证真实行为。
