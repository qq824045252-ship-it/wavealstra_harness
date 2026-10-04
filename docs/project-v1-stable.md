# Project V1.0 Stable

## Frozen domain boundary

- `Space` owns filesystem location and isolation.
- `Project` contributes a long-lived goal, instructions, resources, and capability policy.
- `Task` independently binds optional `spaceId` and `projectId`.
- `TaskExecutionWorkspace` remains Task filesystem infrastructure and contains no Project behavior.
- Project policy is an input to the unified Runtime Policy Resolver. Tag policy still performs the final narrowing.
- Archive hides a Project from new selection while already-bound Tasks continue resolving it.
- Delete unbinds Tasks and never deletes their conversation, artifacts, Space, or execution workspace.

## N5 decision: Templates

Project Template 已作为创建辅助进入 V1（Template-first 创建流程，`src/shared/project-template/`）。

边界：

- Template 是创建时的预填/建议机制，不是 Runtime 域。
- `instructions` / `policies` 在创建时 materialize 为 Project 数据（`ProjectCreateRequest`）。
- `templateId` 只作为来源记录（`projects.template_id`），不参与 Runtime 解析。
- `taskSuggestions`（recommendedModeId / recommendedPresetId）只用于新 Task 默认值，**不持久化到 Project**。
- Project 不拥有 Mode/Tag；`welcomeMode` / `modePresetId` 是 Task 的运行时属性（Rule 1-3）。
- 新 Task 默认值优先级：recent project task > template suggestion > system default（Rule 7）。

## Knowledge：当前实现（2026-09-13 校准）

项目资料包含两种现有能力，同在项目的「资料」入口中管理：

- 项目资料：使用绑定 projectId 的 Library Space 与 LibraryItem，导入、保存、统一搜索和按需检索。项目页和全局资料库读取同一份数据；个人资料和其它项目的文档不会列入当前项目资料。
- 补充参考：使用有序 `Project Resources`，覆盖以下类型：

- inline text;
- local text files;
- URL references.

The Project Context Resolver is the only inclusion authority. It applies enablement, ordering, file type/size checks, total character budget, and records skip reasons. Resources are direct context, not indexed retrieval.

原 V1 的「知识仅限直接上下文、索引一律不在范围内」描述已被现有 Library/ProjectKnowledgeRetrieval 实现取代。导入文档不等于全文注入、索引完成或模型已理解；Project Context Resolver 仍决定参考资料注入，知识检索沿用自己的范围与证据规则。

UI 使用统一「资料」工作流替代「资产 / 项目文档 / 任务参考」二选一心智，旧 assets/context/library 路由继续兼容。文件系统 Space 与 Library Space 仍是不同的内部域；Project UI 将文件系统 Space 呈现为「项目工作目录 / 任务工作目录」，不把 Space 作为项目内并列产品概念。独立 Task.projectId/spaceId 与删除保留边界不变。

## Stable acceptance gates

Any future Project expansion must keep these gates green:

- a Task without `projectId` has unchanged runtime behavior;
- archived Projects cannot be newly bound but remain available to existing Tasks;
- Project deletion preserves Task/Space/Artifact/TaskExecutionWorkspace data;
- capability trace is derived from actual resolution outcomes;
- every real execution records its resolved assembly fingerprint and audit snapshot;
- `projectId` 与 `spaceId` 在存储、解析和任务生命周期上保持独立；Project UI 可以把 Space 映射为工作目录，但不得静默改写已有 Task 绑定。


### 项目工作目录与执行资料（2026-09-13）

- 新建 Project 时可直接选择本地「项目工作目录」；创建流程复用/挂载内部 Space 后写 `defaultSpaceId`，但使用 `activate:false`，不得污染全局 `homeSpaceId`。资料页仍可调整该目录。目录生命周期继续由 Space 管理；Project 只保存新任务偏好，不改变已有任务绑定。
- 新建任务窗口与项目页直接发起任务：项目工作目录优先于最近任务目录；显式选择其他目录或任务独立目录优先。未指定项目工作目录时沿用原有最近任务规则。Mode / Tag 优先级不变。
- 保存时主进程拒绝不存在、归档（含父级归档）、没有磁盘路径或路径不可用的目录；删除 Space 时通过外键清空默认引用。新建 Project 的目录绑定若失败，Project 本身保持合法创建；仅对本次新建且未绑定的 Space 做补偿删除，同路径复用的旧 Space 绝不删除。
- 同一资料页的「本次实际使用资料」按项目任务、执行记录查看真实 Runtime Context 快照，包括执行时间、状态、主进程 cwd、已装配项目段和装配提示。按 taskId / projectId 双重过滤；切换任务或项目时丢弃迟到响应。
- 此处目前覆盖执行时装配的项目内容，固定引用不等于正文已读；执行中的原生 read 与 project_knowledge_search/read 已接入独立返回证据清单；MCP、bash、外部 CLI 内部读取暂不覆盖。没有快照时不使用当前配置补造历史，旧快照缺少 cwd 时明确标注。
- 验证：Project domain 真 SQLite 测试覆盖保存/清除/删除默认引用、不重绑旧任务、快照 cwd 回读；隔离 Electron 使用真实组件与 fixture IPC 验证默认选中/显式独立目录、执行资料/空状态/跨项目过滤。未代替用户运行中的 Electron 与真实模型联调。


### 执行中资料返回证据（2026-09-13）

- 主进程在 tool_execution_start 固定 taskId / executionId / assistantMessageId，完成时确认仍是原 Session 和原执行；只接受尚处于 running 的对应快照。迟到、失败、不支持的工具及无有效返回块不记录为成功读取。
- 原生 read 记录请求路径、请求行范围、部分返回标记、返回字符数/图片数及返回块 SHA-256，不再读磁盘猜测先前内容。Knowledge 搜索按命中记录片段或元数据；read 由工具适配器明确标注正文/元数据，PDF 抽取正文与仅返回文件位置严格区分。
- 证据保存在已有 Runtime Context 快照的 material_usage_json，幂等增列而不提升数据库版本。每次执行最多 100 项，溢出计数可见；同一调用/目标/种类去重，新增字节计入原有保留预算。正文、图片数据不复制入证据，脱敏导出仍保持白名单。
- 页面将「执行中读取」与「执行时注入」放在原位置；记录证明工具返回内容，不证明模型理解或采纳。旧快照没有读取证据时明确标注，损坏 JSON 不阻断其他历史记录查看。
- 验证：test:runtime-materials（真实 SDK read / SQLite、真实 Knowledge 适配器配受控 retrieval、真实 SessionEventCoordinator 配受控事件；失败/迟到/错误身份/去重/重开/100 项上限/损坏记录），test:project-knowledge（192 项）、test:project-domain、test:verified-write、隔离 Electron test:project-materials-ui。没有改动用户数据库或重启用户应用，未宣称真实模型端到端验证。


### 项目说明与常用资料（2026-09-13）

- Shared Context 在用户界面收口为资料页的「项目说明」：项目目标、当前阶段、协作要求。分别复用 goal / currentStage / instructions；从设置表单移走，设置页仅保留导航说明，避免两套编辑入口。保存复用 updateProject，并接入项目页已有未保存更改保护。
- Pinned Context 在资料页收口为「常用资料」，沿用 project_context_pins 引用模型与现有 pin/unpin/list IPC。打开项目文档后可设为常用；同页可查看当前常用引用与备注、取消常用。取消只删除引用，不删除或复制文档。
- 文案明确常用仅向任务提供资料引用，正文仍按需读取；执行中实际返回另看已有执行证据，不把固定配置包装成已读正文。现有常用条目（含后端允许的个人资料引用）均由 listProjectPins 展示；新增按钮针对当前项目文档，不引入全局资料页跳转。
- 遵守 10 项上限、归档只读、主进程跨项目隔离；异步刷新带项目身份和卸载保护，失败状态保留可重试。
- 隔离 Electron 验证真实 ProjectBrief/ProjectMaterials：字段保存、未保存 guard、失败保留草稿、撤销、固定失败不假成功、固定/取消不删文档、切项目迟到响应；fixture IPC 不等同真实模型或用户数据库 E2E。


### 已移动目录重新关联

资料页项目工作目录旁可选择移动后的新位置，先预览受影响任务和文件引用，再确认提交。主进程 token 五分钟有效、单次消费；提交重新校验，Space 路径与项目文件引用在同一 SQLite 事务更新，失败回滚。任务 projectId/spaceId 不改，历史执行路径不改，不移动磁盘文件。

当前支持共享项目、独立任务及物理嵌套目录；预览列出所有受影响项目、任务、目录、文件引用和已登记产物，运行中任务和外部执行阻止提交。目录按磁盘路径包含关系映射，界面父子关系不变；继承父路径的任务纳入影响范围，绑定到外部路径的子项不迁移。共享项目文件引用在同一事务更新，项目与任务归属不变。产物根目录、入口、依赖及版本随项目绑定在同一事务更新，提交后刷新缓存并广播更新；MyBuddy 托管内容的存储路径不变。产物核对使用分块 SHA256，同次预览/提交各有 256 MiB 读取预算，超过预算明确拒绝。新目录必须存在、未被其他 Space 占用，所有受影响项目文件引用需安全可读且满足 64 KiB 上限；原文件仍在时核对内容，原文件已缺失时预览明确说明核对范围。


执行路径失效：主 Agent/外部 Agent 的权威 cwd 解析不自动重建已绑定目录。路径缺失或不可用时，在工具执行前提示恢复目录或重新关联；只有无显式或继承目录绑定的任务创建隔离目录。主执行、regenerate 和分支入口均采用此边界；重新关联的只读盘点仍允许读取失效绑定。

### Project / Space / Library / Context 收敛审计（2026-09-13）

- 真实用户库只读盘点：1 个 Project、25 个可见 Task；24 个 Task 尚未绑定 Project，唯一 Project 尚未设置 `defaultSpaceId`。这证明迁移必须兼容“无 Project / 有 Project 无目录”，不能假设所有任务都已经项目化。
- 当前库 19 个带磁盘路径的 Space 中有 13 个路径在盘点时不可达。路径失效必须走显式恢复/重新关联；禁止根据同名目录静默重建、合并或改绑。
- 当前用户库暂未出现多 Project 共享目录或同 Project 多任务目录分叉；这些边界由确定性 SQLite/relocation fixture 覆盖，不以当前样本“暂时没有”作为删减能力的依据。
- Project 任务列表只显示「任务工作目录」标签，不再从目录徽标跳入全局 Workspace Detail。全局 Workspace 产品仍保留给独立工作空间管理，但 Project 日常流程无需理解内部 Space 概念。
- 资料页呈现统一为：项目说明 → 资料状态 → 项目工作目录 / 本次实际使用 → 统一搜索 → 项目资料 / 常用资料 → 补充参考。Library、Project Resource、Runtime Evidence 的内部授权与存储边界仍独立。
- 资料状态严格区分“可用/常用”和“真实执行证据”：常用只表示引用；补充参考按 `ProjectContextResolver` 的 included/budget 口径；本次使用只来自 `RuntimeContextSnapshot`，不宣称模型理解或采纳。
- 兼容策略：旧 Project/Space/Library 数据字段和路由继续保留，不做同名猜测迁移；Project 删除仍只解绑，不删除 Task、Space、Artifact 或执行工作区。