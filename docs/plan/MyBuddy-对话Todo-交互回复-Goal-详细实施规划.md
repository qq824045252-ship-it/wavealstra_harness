# MyBuddy 对话 Todo、交互式回复 UI 与 Goal 详细实施规划

> 文档状态：已按规划完成核心实施与自动化验证（2026-09-02）  
> 日期：2026-09-02  
> 适用仓库：`C:\Users\servi\Desktop\mybuddy`  
> 范围：当前 MyBuddy Task 对话；不改造 Project Todo / Project Goal

## 实施结果（2026-09-02）

本规划的核心链路已经落地：

- Conversation Todo：独立表、Execution 作用域、版本化完整快照事件、两项 task-scoped agent 工具、内联可折叠卡片、完成/中止收束；
- Interaction：五类输入、持久化状态机、主进程 waiter、respond/cancel IPC、工具调用真实暂停与同轮续跑、重启 orphan 自动过期、侧栏“待回答”；
- Conversation Goal：Task 作用域持久化、用户创建/编辑/取消 UI、agent get/create/update/propose-complete 工具、完成确认、每轮有界上下文注入、对话分支独立克隆；
- 身份链：由主进程生成并贯穿 `taskId + executionId + assistantMessageId`，工具参数不能伪造作用域；
- 历史：Task 切换/重启时从独立真源恢复；对 Pi 历史合成 message id 使用时间关联兜底；分支只克隆已终结 Todo/Interaction 和独立 Goal；
- 原生表面：Goal DOM 模态框使用 `NativeSurfaceCoordinator` blocker，避免被 `WebContentsView` 覆盖。

验证结果：`pnpm run typecheck`、`pnpm run build`、`pnpm run test:conversation-runtime`、`pnpm run test:conversation-runtime-ui`、`pnpm run test:db-migration`、`pnpm run test:conversation-branch-service`、`pnpm run test:conversation-branch-ui` 均通过。真实 provider 的长轮次暂停/恢复与 Windows 125%/150% 缩放仍应在发布验收环境做人工 E2E。

## 0. 结论先行

这三个功能不应被做成三个互不相关的页面，而应形成一条完整的对话执行链：

```text
Goal（跨多轮持续的目标）
  └─ Execution（一次用户消息触发的一轮执行）
      ├─ Conversation TodoList（这一轮准备做什么、做到哪里）
      └─ Interaction（执行中需要用户选择、确认或补充什么）
```

推荐冻结以下产品定义：

1. **Conversation TodoList**：当前对话的一轮执行计划。它是 AI 运行过程的结构化状态，不是项目页里的人工待办。
2. **Interaction**：AI 在当前回复中暂停并向用户索取结构化输入；用户提交后，同一轮执行继续，不制造伪造的普通用户消息。
3. **Goal**：绑定当前 MyBuddy Task、跨多轮存在的长期目标；一条 Goal 可由多轮 Conversation TodoList 推进。

首版坚持三个边界：

- Project Todo、Project Goal、Conversation Todo、Conversation Goal 是四种不同语义，不共享同一张表，不隐式双向同步。
- 所有运行时状态必须使用 `taskId + executionId + assistantMessageId` 定位，不能从 `activeTaskId` 猜作用域。
- UI 只渲染结构化事件，不从模型自然语言、Markdown checklist 或工具摘要中反向解析状态。

---

## 1. Review 范围与证据状态

### 1.1 已检查的真实实现

本规划基于以下现有代码边界：

- Task / Agent 生命周期：`src/main/agent/AgentService.ts`、`SessionRegistry.ts`、`RuntimeContextSnapshotRepository.ts`
- 流式事件协议：`src/shared/agent-ipc.ts`、`src/shared/pi-event-mapper.ts`
- Renderer 消息模型与投影：`src/renderer/src/types.ts`、`src/renderer/src/store/appStore.ts`
- 对话展示：`ChatView.tsx`、`MessageItem.tsx`、`ExecutionTimeline.tsx`、`MessageBlockView.tsx`
- 现有轻量计划卡：`PlanCard.tsx`
- 现有工具审批 UI：`ToolCallCard.tsx`
- 现有 MCP 交互桥：`McpRuntimeService.ts`、`HubPage.tsx`
- Project Todo：`project-domain.ts`、`ProjectService.ts`、`ProjectRepository.ts`、`ProjectPlan.tsx`
- Project Goal：`ProjectSettings.tsx`、`project-context-extension.ts`、`PromptAssembly.ts`
- DB 与 IPC：`AppDatabase.ts`、`src/preload/index.ts`、`src/preload/index.d.ts`
- 对话滚动与虚拟列表：`ChatView.tsx`、`MessageList.tsx`、`scrollFollow.ts`

### 1.2 当前工作树状态带来的限制

Review 期间没有修改上述业务代码。当前工作树已有一组未提交的“对话分支”实现；其中 `AppDatabase.ts` 的新增 SQL 缺少模板字符串定界符，导致：

```text
pnpm dev
→ AppDatabase.ts:376:13
→ Expected ")" but found "TABLE"
```

因此本轮无法从当前源码启动可审计的 Electron 开发版本。已存在的打包版能够被截图，但当时停留在原生 Browser 表面，自动化无法可靠返回聊天/项目界面；该截图被判定为无效证据，没有用于下面的 UX 结论。

所以本文的结论属于：

- 已完成：真实源码、数据流、IPC、持久化和组件边界 Review；
- 未完成：当前 HEAD + 当前未提交改动组合下的完整可视化 Flow Audit；
- 实施前置：先让现有工作树恢复可编译，再补一轮真实 Electron 截图基线。

---

## 2. 现状判断

### 2.1 Conversation Todo 现状

项目已经存在两个“看起来像 Todo”的东西，但都不能直接满足需求。

#### A. Project Todo 已经很完整，但语义不对

现有 Project Todo 已具备：

- `project_todos` 数据表；
- `todo / doing / paused / done` 状态；
- 标题、描述、处理人、优先级、标签、开始和截止日期；
- 表格、看板、列表、甘特和日历视图；
- Renderer CRUD IPC；
- `project_plan_list/get/create/update` Agent 工具；
- Project 上下文摘要注入。

它是“项目级、人工维护、所有绑定任务共享”的长期计划，不能拿来记录一次回复中的执行步骤。否则会产生以下问题：

- 简单对话会污染项目计划；
- 多个 Task 会互相覆盖当前执行状态；
- 一轮执行结束后，临时步骤长期残留；
- “完成一次工具调用”被错误等同于“完成项目待办”；
- 未绑定 Project 的普通 Task 无法使用。

#### B. `PlanCard` 是可复用的视觉雏形，但协议不足

现有 `MessageBlock` 支持：

```ts
{ type: "plan"; title: string; items: Array<{ id: string; text: string; done: boolean }> }
```

现有 `PlanCard` 能显示完成数量，并把第一个未完成项推断为运行中。但 Review 未发现稳定的上游结构化 `plan/todo` 事件生产链；其模型也只有 `done: boolean`，无法表达 blocked、skipped、cancelled、失败原因、稳定版本和所属 execution。

此外 `PlanCard` 当前通过 `ExecutionTimeline` 的过程块渲染。时间线在执行结束后会整体折叠，这与“用户需要回看这轮做过什么”相冲突。

#### C. `Task.progressSteps` 基本是遗留展示模型

`Task` 类型仍有 `progressSteps?: ProgressStep[]`，但它没有形成当前 Agent runtime 的权威写入、持久化和历史恢复链。它不能作为新功能真源。

### 2.2 专用选择 / 回复 UI 现状

现有代码已证明“Electron 内结构化交互”在技术上可行：

- `McpRuntimeService.createUiBridge()` 支持 `confirm/select/input/editor`；
- 主进程通过 `mcp:uiPrompt` 广播请求；
- Renderer 可通过 `mcp:uiRespond` / `mcp:uiCancel` 回答；
- Hub 的 MCP 页已有简单弹窗 UI。

但它不能直接成为对话内交互层：

- 订阅者位于 `HubPage` 的 MCP 标签页，用户在聊天页时看不到；
- 请求只有 `requestId + kind`，没有 `taskId/executionId/assistantMessageId`；
- Renderer 只有一个全局 `uiReq`，无法支持多个 Task 分别等待；
- options 只是 `string[]`，没有稳定 id、描述、推荐项、多选和自定义输入；
- 弹窗脱离消息上下文，用户不知道它对应哪一次回复；
- 进程重启后 waiter 消失，旧按钮无法安全恢复；
- 10 分钟超时适合临时 MCP UI，不适合用户离开电脑后回来继续的对话。

### 2.3 Goal 现状

现有两个 goal 概念都不是本需求需要的 Conversation Goal：

- `ProjectDto.goal`：Project 的长期一句话目标，长度上限 300 字；所有绑定该 Project 的 Task 共享。
- Mode Profile 的 `goal.md`：场景角色与行为指令，不是用户业务目标。

Task 表目前没有独立 Goal 实体，也没有成功标准、暂停/阻塞/完成状态、跨轮进度摘要或“一条 Goal 对多轮 execution”的关系。

### 2.4 可以复用、但不能照搬的能力

| 现有能力 | 可以复用 | 不能照搬 |
|---|---|---|
| `PlanCard` | 信息密度、完成计数、行式状态展示 | 二态模型、时间线内位置、无持久化协议 |
| `ToolCallCard` | 等待用户时保持消息可操作、任务提醒思路 | 审批语义、工具输出样式 |
| MCP UI bridge | Promise 等待/回答的主进程机制 | 全局广播、Hub 弹窗、单请求状态 |
| Project Todo | 校验、Repository/Service/IPC 分层方式 | 数据表、共享作用域、状态语义 |
| Project Goal | Prompt 注入和项目绑定经验 | 300 字单字段、Project 作用域 |
| Runtime snapshot | `executionId` 和 assistant message 关联 | 不能把完整 Todo/Interaction 数据塞进审计快照 |
| Chat scroll follow | 用户滚动让权、虚拟列表测量 | 不能在动态卡片更新时直接写 `scrollTop` |

---

## 3. 统一领域模型

### 3.1 作用域表

| 对象 | 作用域 | 生命周期 | 谁写 | 真源 |
|---|---|---|---|---|
| Project Todo | Project | 长期 | 用户 + Project Agent 工具 | `project_todos` |
| Project Goal | Project | 长期 | 用户 + Project Context 工具 | `projects.goal` |
| Conversation Goal | Task | 跨多轮 | 用户为主，Agent 更新进度 | `conversation_goals` |
| Conversation TodoList | Execution | 单轮执行 | Agent 结构化工具 | `conversation_todo_*` |
| Interaction | Execution | 等待一次用户输入 | Agent 请求，用户解决 | `conversation_interactions` |

### 3.2 统一身份链

每个对象至少记录：

```text
taskId
executionId
assistantMessageId
```

Conversation Goal 只要求 `taskId`；TodoList 与 Interaction 必须同时记录三者。Renderer 收到任意事件时，都以事件自带作用域更新目标 Task，不能读取全局 `activeTaskId` 来补全。

### 3.3 统一版本与幂等规则

- 每个可变实体有单调递增 `version`；
- 主进程事务提交成功后才广播 Renderer patch；
- Renderer 只接受 `version >= current.version` 的快照；
- 提交 Interaction 使用 `interactionId + expectedVersion`；
- 重复提交返回同一 resolved 结果，不触发 Agent 二次继续；
- Todo item id 由 Agent 在首次创建时给出并在本轮保持稳定；主进程校验唯一性。

---

## 4. 功能一：Conversation TodoList

### 4.1 用户目标

用户在一轮复杂对话中能够立即看懂：

- AI 准备做哪几步；
- 当前正在做哪一步；
- 哪些已完成；
- 哪一步被阻塞以及原因；
- 执行结束时还有什么没做。

简单问答不应强制出现 TodoList。

### 4.2 首版触发策略

Agent 仅在以下情况创建 TodoList：

- 用户明确要求规划、分步骤执行或持续处理；
- 预计有 2 个以上相互依赖步骤；
- 需要多个工具调用、多个文件或明显跨阶段验证；
- 已绑定 Goal，当前轮是在推进 Goal；
- 执行预计超过约 30 秒，并且步骤状态对用户有价值。

以下情况默认不创建：

- 一句解释、翻译、改写；
- 单一查询或单一小改；
- 只有“思考—回答”而没有可验证步骤；
- 为了显得忙而拆出的伪步骤。

建议每轮 2–7 项，硬上限 12 项。

### 4.3 数据模型

新增 `src/shared/conversation-todo.ts`：

```ts
export type ConversationTodoItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "skipped"
  | "cancelled";

export type ConversationTodoListStatus =
  | "active"
  | "completed"
  | "interrupted"
  | "cancelled";

export interface ConversationTodoItemDto {
  id: string;
  title: string;
  detail?: string;
  status: ConversationTodoItemStatus;
  blockedReason?: string;
  position: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationTodoListDto {
  id: string;
  taskId: string;
  executionId: string;
  assistantMessageId: string;
  goalId?: string;
  title: string;
  status: ConversationTodoListStatus;
  version: number;
  items: ConversationTodoItemDto[];
  createdAt: number;
  updatedAt: number;
  finalizedAt?: number;
}
```

### 4.4 持久化

新增两张表，不塞 JSON 到 `tasks`：

```text
conversation_todo_lists
  id PK
  task_id FK tasks ON DELETE CASCADE
  execution_id UNIQUE
  assistant_message_id
  goal_id nullable
  title
  status
  version
  created_at / updated_at / finalized_at

conversation_todo_items
  list_id FK conversation_todo_lists ON DELETE CASCADE
  item_id
  position
  title / detail
  status / blocked_reason
  created_at / updated_at
  PK(list_id, item_id)
```

一次 list 更新与全部 item 更新必须在同一事务内完成。首版每列表最多 12 项，整份快照很小，事务内 replace items 比复杂差量 SQL 更可靠；对 Renderer 仍广播完整快照。

### 4.5 Agent 工具协议

新增 task-scoped 内建扩展，建议两个工具：

```text
conversation_todo_write(title, items[])
conversation_todo_update(updates[])
```

约束：

- 工具参数不接受 `taskId/executionId/assistantMessageId`；由 `AgentService` bridge 注入；
- `write` 首次建立列表，重复调用视为显式替换并保留同 id 项；
- `update` 只能更新当前 execution 的既有 item；
- 同一时刻最多一个 item 为 `in_progress`；
- `blocked` 必须带 `blockedReason`；
- 不允许 Agent 把 Project Todo id 写进 Conversation Todo；
- 这两个工具在普通 ToolCall 时间线中隐藏，改为专用 Todo patch 和卡片；
- 工具结果仍写入 session transcript，保证 Agent 自己知道写入是否成功。

### 4.6 事件协议

在 `AgentUiPatch` 中新增：

```ts
{ type: "conversation_todo_snapshot"; taskId; executionId; messageId; list }
```

不要设计多个易乱序的 `item_added/item_updated` 前端事件。主进程内部可以用操作式 API，跨 IPC 一律发送版本化完整快照。

### 4.7 UI 设计

新增 `ConversationTodoCard.tsx`，放在 `MessageItem` 的 `ExecutionTimeline` 与最终回答之间。

#### 活跃态

- 标题：`Todo · 2/5`；
- 默认展开；
- 当前项使用现有强调色和轻量运行指示；
- completed 降低视觉权重但保持可读；
- blocked 显示原因和“等待用户回答”关联提示；
- 更新同一 DOM 节点，不追加重复卡片。

#### 完成态

- 如果全部完成：默认折叠为一行 `已完成 5/5`，用户可展开回看；
- 如果 interrupted/blocked：保持展开，突出未完成项；
- 历史卡片属于原 assistant message，不移到全局侧栏。

#### 交互原则

- V1 为 AI-owned，只读；用户不直接勾选，避免人和 Agent 同时改状态；
- 可提供“让 AI 调整计划”入口，点击后把自然语言草稿放进 composer，而不是直接改 DB；
- 不复用 Project Plan 的表格/看板 UI；
- Todo 高度变化必须触发虚拟列表重新测量，但只有现有 follow 状态允许时才继续贴底；
- 用户已经向上滚动时，Todo 更新不能抢回滚动位置。

### 4.8 生命周期

```text
assistant execution start
  → 可选：write TodoList
  → update item statuses
  → 可选：Interaction 使 item blocked
  → 用户回答后 item 恢复 in_progress
  → assistant_end
      ├─ 全部 terminal 且无 blocked → completed
      ├─ abort / steer / interrupt → interrupted
      └─ 用户取消 → cancelled
```

`assistant_end` 不得把所有未完成项伪装成 completed。主进程只终结 list 状态，保留各 item 的真实状态。

---

## 5. 功能二：对话内专用选择 / 回复 UI

### 5.1 产品定义

当 AI 无法安全继续，或一个用户选择会实质改变结果时，AI 发起 Interaction。卡片出现在当前 assistant turn 内；Agent 的对应工具调用保持 await，用户回答后工具返回结构化结果，Agent 在同一轮继续。

它不是：

- 普通 Markdown 问句；
- 全局模态弹窗；
- 危险工具审批的替代品；
- 自动伪造的一条 user chat message；
- MCP Hub 页面专用 elicitation。

### 5.2 首版类型

```ts
export type ConversationInteractionKind =
  | "confirm"
  | "single_select"
  | "multi_select"
  | "short_text"
  | "long_text";

export interface ConversationInteractionOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  disabled?: boolean;
}

export interface ConversationInteractionDto {
  id: string;
  taskId: string;
  executionId: string;
  assistantMessageId: string;
  kind: ConversationInteractionKind;
  title: string;
  description?: string;
  options: ConversationInteractionOption[];
  minSelections?: number;
  maxSelections?: number;
  allowCustom?: boolean;
  customPlaceholder?: string;
  status: "pending" | "resolved" | "cancelled" | "expired";
  answer?: unknown;
  version: number;
  createdAt: number;
  resolvedAt?: number;
}
```

首版不做任意 JSON Schema form。复杂表单等 V2 再加，避免一开始变成低质量表单引擎。

### 5.3 Agent 工具

新增 `request_user_input`：

```text
request_user_input({
  title,
  description?,
  kind,
  options?,
  minSelections?,
  maxSelections?,
  allowCustom?,
  customPlaceholder?
})
```

规则：

- 一次 execution 最多一个 pending Interaction；
- 问题必须短、互斥选项必须真正互斥；
- `recommended: true` 最多一个；
- 仅在答案会改变实现、范围、风险或外部影响时询问；
- 能从当前上下文可靠推断的内容不询问；
- 不通过该 UI 索取密码、验证码、私钥、API key 等秘密；
- 危险操作仍走 `pending_approval`，不能包装成普通 confirm 绕过审批。

### 5.4 主进程等待模型

新增 `ConversationInteractionService`：

1. 工具调用时事务创建 pending 记录；
2. 广播 `conversation_interaction_requested`；
3. 保存 runtime waiter，工具 Promise 暂停；
4. Renderer 通过 Agent IPC 提交 answer；
5. Service 用 `id + version + task/execution` 原子 resolve；
6. 广播 resolved 快照；
7. waiter 返回结构化结果，Agent 同一 turn 继续。

与现有 MCP UI 的差别：Conversation Interaction 默认不设 10 分钟超时。用户可以切换 Task、离开电脑后再回来。只有以下事件终结等待：

- 用户提交；
- 用户显式取消；
- 当前 execution 被 abort / steer / interrupt；
- 应用进程退出；
- 运行时异常。

### 5.5 重启与恢复

桌面进程重启后，旧 Agent Promise 无法复活。启动恢复规则必须明确：

- DB 中 `pending` 且没有对应 live execution 的 Interaction 标记为 `expired`；
- UI 显示“本次执行已中断，请重新发起”，按钮禁用；
- 不尝试把旧答案注入一个新 execution；
- 如果用户仍需继续，点击“继续处理”生成一条明确的新用户消息草稿。

### 5.6 UI 设计

新增 `ConversationInteractionCard.tsx`，与 TodoCard 同属 assistant message 的独立结构化区域。

#### single_select

- 每项是完整按钮/单选行；
- 显示 label + description；
- recommended 只显示轻量“推荐”；
- 允许键盘方向键与 Enter；
- 提交后卡片变为只读摘要，不消失。

#### multi_select

- Checkbox 语义；
- 显示已选数和 min/max；
- 未满足下限时提交按钮禁用；
- 达到上限后未选项 disabled，但仍可取消已选项。

#### short_text / long_text

- 使用受控 input/textarea；
- 支持 placeholder、字符上限和错误文案；
- `Ctrl+Enter` 提交长文本，普通 Enter 保留换行；
- 不使用 Electron `window.prompt`。

#### confirm

- 文案必须是具体动作；
- 默认按钮顺序“取消/拒绝”在左，“继续/确认”在右；
- 如果动作属于危险操作，不允许使用此 kind，必须走 Tool Approval。

### 5.7 与 Composer 和 Task 切换的关系

- Interaction pending 时，不硬锁整个 composer；用户仍可 steer / interrupt；
- 如果用户在 composer 发新消息，先原子 cancel Interaction，再执行既有 streaming send 行为；
- 当前 Task 侧栏显示“待回答”状态，优先级与 pending approval 相同；
- 切走 Task 不取消 Interaction；
- 回到 Task 后卡片仍在原 assistant message；
- UI 不自动把焦点从正在输入的 composer 抢走；只使用 `aria-live` 和视觉提示；
- 点击侧栏“待回答”可定位该消息。

### 5.8 与 MCP UI 的整合策略

MVP 不立即重写 MCP transport，但抽出通用 Renderer 原子组件：

```text
StructuredPromptCard
  ├─ ConversationInteractionAdapter
  └─ McpUiPromptAdapter（后续）
```

MCP 请求只有在能补齐真实 task/execution owner 时才允许进入聊天；否则继续使用独立 MCP 系统弹层。不要用 `activeTaskId` 给全局 MCP 请求强行归属。

---

## 6. 功能三：Conversation Goal

### 6.1 推荐定义

Goal 是当前 Task 中跨多轮持续的“要达成什么”，不是这一轮“准备做什么”。

例子：

```text
Goal：把 MyBuddy 的对话图片显示做到可发布
成功标准：
1. 生成图出现在所属回复中
2. 历史恢复后仍可显示
3. Gateway 不串 Task 图片
4. 真实 provider E2E 通过
```

每一轮可以产生自己的 TodoList：检查协议、修复渲染、补测试、跑 E2E；这些 Todo 完成不等于 Goal 自动完成。

### 6.2 首版约束

- 一个 Task 同时最多一条 active/blocked Goal；
- Task 可以保留历史 achieved/cancelled Goal；
- Goal 默认由用户显式创建，或用户明确说“设为目标/持续做到……”时由 Agent 创建；
- Agent 不能因为一次长任务就偷偷创建 Goal；
- Agent 可以自动更新 progress summary，但不能无条件自动标记 achieved；
- 达成时展示“建议完成”，由用户确认或用户原指令明确授权完成。

### 6.3 数据模型

新增 `src/shared/conversation-goal.ts`：

```ts
export type ConversationGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "achieved"
  | "cancelled";

export interface GoalCriterionDto {
  id: string;
  text: string;
  status: "pending" | "met" | "not_met" | "waived";
  evidence?: string;
}

export interface ConversationGoalDto {
  id: string;
  taskId: string;
  title: string;
  description?: string;
  status: ConversationGoalStatus;
  criteria: GoalCriterionDto[];
  progressSummary?: string;
  version: number;
  createdBy: "user" | "agent_explicit_request";
  createdAt: number;
  updatedAt: number;
  achievedAt?: number;
}
```

新增 `conversation_goals` 表；criteria 首版使用有界 JSON（最多 12 条，每条限制长度），因为 criteria 只随 Goal 整体编辑，暂不需要跨 Goal SQL 查询。使用 partial unique index 保证一个 Task 最多一条 active/blocked Goal。

### 6.4 Agent 能力

建议工具：

```text
conversation_goal_get()
conversation_goal_create(title, description?, criteria[])
conversation_goal_update(progressSummary?, criterionUpdates?, status?)
conversation_goal_propose_complete(summary, evidence[])
```

规则：

- 工具作用域自动绑定当前 Task；
- create 仅响应用户明确意图；
- update 不允许删除历史 evidence；
- propose_complete 只产生本地待确认 Interaction，不直接 achieved；
- achieved 后保持只读历史，继续工作需新 Goal 或显式 reopen；
- Goal 摘要按小预算注入每轮 runtime assembly，完整 criteria 通过 `goal_get` 按需读取；
- Gateway/Cron/BTW 是否支持 Goal 必须显式定义，MVP 建议只支持普通本地 Task。

### 6.5 Prompt 注入

新增独立 assembly segment，例如 `conversationGoal`：

```text
## 当前对话 Goal
- 目标：...
- 状态：active
- 成功标准：2/4 met
- 当前进展：...

规则：Goal 是跨多轮目标；当前轮的执行步骤使用 conversation_todo_*，
需要用户决策使用 request_user_input。不要把 Goal 当 Project Goal 或 Project Plan 修改。
```

预算建议 800–1200 字符，不注入全部历史 evidence。

### 6.6 UI 设计

Goal 不应在每一条回复里重复占大卡片。建议：

- Chat header 中，在 Workspace / Project crumb 附近增加 `GoalChip`；
- 显示 `目标名称 · 2/4` 与状态色；
- 点击打开轻量 `GoalPopover` / `GoalSheet`；
- 详情包含描述、criteria、进度摘要、暂停/继续/取消、标记完成；
- 新 Task 没有 Goal 时不占空间；
- Task 菜单和首条用户消息菜单提供“设为 Goal”；
- Goal 更新不使用右侧 Artifact Panel，避免与文件/Gadget/Browser 工作面争用。

### 6.7 Goal 与 Todo / Interaction 联动

- 创建 TodoList 时可记录 `goalId`；
- Todo 卡片标题可显示轻量 Goal 归属，但不复制全部 Goal 内容；
- Interaction 阻塞当前 Todo 时，Goal 可进入 `blocked`，回答后恢复 `active`；
- 每轮 assistant_end 后，Agent 可更新 Goal progressSummary；
- Todo 全部 completed 只代表该 execution 完成；
- 只有 success criteria 有充分 evidence 时才 propose complete；
- 用户取消 Goal 时，不自动删除历史 Todo 和 Interaction。

---

## 7. 架构与文件落点

### 7.1 Shared

新增：

- `src/shared/conversation-todo.ts`
- `src/shared/conversation-interaction.ts`
- `src/shared/conversation-goal.ts`

修改：

- `src/shared/agent-ipc.ts`：新增 patch、请求/响应和 IPC 常量；
- `src/shared/runtime-policy.ts` 或相关能力声明：登记新内建工具；
- `src/shared/native-tools.ts`：明确这些本地状态工具的 side-effect 分类。

不要继续扩张 `src/renderer/src/types.ts` 中的遗留 `PlanItem/ProgressStep` 作为领域真源。Renderer 可引用 shared DTO。

### 7.2 Main / DB

新增：

- `src/main/agent/ConversationTodoRepository.ts`
- `src/main/agent/ConversationTodoService.ts`
- `src/main/agent/ConversationInteractionRepository.ts`
- `src/main/agent/ConversationInteractionService.ts`
- `src/main/agent/ConversationGoalRepository.ts`
- `src/main/agent/ConversationGoalService.ts`
- `src/main/agent/conversation-runtime-extension.ts`

修改：

- `AppDatabase.ts`：幂等建表、索引、启动 orphan recovery；
- `AgentService.ts`：把 execution identity 注入 extension bridge；拦截专用工具 UI；在 end/abort 时 finalize；
- `PromptAssembly.ts`：注入 active Goal 摘要和 Todo 使用规则；
- `session-history.ts`：恢复消息时合并该 assistant message 的 Todo / Interaction；
- `main/index.ts`：注册 IPC 和 service lifecycle。

`AppDatabase.ts` 当前正被对话分支实现修改。实际施工时必须先合并/修复那部分，再以小 patch 添加新表，避免两个功能同时大段改同一迁移区域。

### 7.3 Preload

新增 API：

```text
agent.getConversationRuntime(taskId)
agent.respondInteraction({ interactionId, expectedVersion, answer })
agent.cancelInteraction({ interactionId, expectedVersion })
agent.createGoal(...)
agent.updateGoal(...)
agent.listTaskGoals(taskId)
```

同步修改 `src/preload/index.ts` 和 `src/preload/index.d.ts`，不可只改一侧。

### 7.4 Renderer

新增：

- `components/chat/ConversationTodoCard.tsx`
- `components/chat/ConversationInteractionCard.tsx`
- `components/chat/GoalChip.tsx`
- `components/chat/GoalSheet.tsx`
- `lib/conversationRuntime.ts`

修改：

- `MessageItem.tsx`：在 timeline 与 final answer 之间渲染 Todo / Interaction；
- `ChatView.tsx`：GoalChip、定位 pending interaction、动态高度滚动保护；
- `MessageList.tsx`：确保 todo/interaction 版本变化触发目标行 measure；
- `appStore.ts`：按 task/message 归一化接收 patch，禁止 activeTaskId 补作用域；
- `Sidebar.tsx` / task filters：增加 `awaiting_input` 可见状态；
- `global.css`：复用现有 token，不新增另一套颜色系统。

### 7.5 推荐的 Renderer 状态形态

首版可将 TodoList 和 Interaction 嵌入拥有它们的 `ChatMessage`，Goal 保存在 Task 级：

```ts
interface ChatMessage {
  // existing...
  conversationTodo?: ConversationTodoListDto;
  interactions?: ConversationInteractionDto[];
}

interface Task {
  // existing...
  activeGoal?: ConversationGoalDto;
}
```

历史 Interaction 可能多条，pending 最多一条。数据量小于 Artifact，不需要立即另建复杂的 Zustand normalized store；但所有 reducer 更新必须用 id/version 精确匹配。

---

## 8. 状态机与竞态处理

### 8.1 Interaction 与新用户消息竞态

用户几乎同时点击选项和发送 steer 时：

1. 主进程以 DB 事务/单 execution mutex 串行化；
2. 第一个把 pending 改为终态的操作获胜；
3. 后到操作收到 `already_resolved` 或 `execution_aborted`；
4. Renderer 重新拉取权威快照；
5. 不允许既返回 answer 又执行 cancel。

### 8.2 Todo 更新与 assistant_end 竞态

- assistant_end 先获取 execution mutex；
- finalize 后拒绝新的 todo update；
- 迟到更新记录为诊断 warning，不重新打开历史 execution；
- Renderer 以 final version 为准。

### 8.3 多 Task 并行

- 每个 Task 可有自己的 active execution 和 pending Interaction；
- sidebar 汇总状态，但回答 IPC 必须带 interaction id；
- 任何全局 broadcast 都必须包含 task scope；
- 切换 active task 只影响展示，不改变 waiter。

### 8.4 删除消息、重试与对话分支

- 删除某条用户消息及其后续对话时，同步删除对应 assistant message 的 Todo/Interaction；
- regenerate 创建新的 assistantMessageId 和 executionId，不能复用旧 Todo；
- 对话分支复制历史时，只复制分支点之前的已终结 Todo/Interaction 快照；
- pending Interaction 不允许成为可继续的分支历史；先取消/停止执行；
- 分支 Goal 默认复制为独立快照并生成新 goal id，不能让父子 Task 共写同一 Goal；
- 若用户选择“仅对话分支”，Goal 是否复制应在分支预览中明确展示。

---

## 9. UX 与可访问性要求

### 9.1 共同要求

- 结构化卡片必须在 125%/150% Windows 缩放和窄聊天栏下重排；
- 状态不能只靠颜色，必须有图标和文本；
- 每个按钮有可见 label 或准确 `aria-label`；
- focus ring 使用现有设计 token；
- 最小可点击区域建议 32×32，主要选项行建议至少 40px 高；
- 不在流式更新时反复抢焦点；
- `aria-live=polite` 只播报关键状态转换，不播报每个 token 或每次版本号；
- reduced motion 下关闭运行指示动画；
- resolved/expired 状态仍能被屏幕阅读器理解。

### 9.2 动态高度和滚动

这是高风险点。MyBuddy 已有复杂的用户消息置顶、虚拟列表测量和 follow 状态机。新卡片必须遵守：

- 更新卡片后请求 virtualizer 重新 measure 当前 message；
- follow=true 时才允许维持底部/当前轮视图；
- follow=false 时保持用户视觉锚点；
- Interaction 出现可显示一次“待回答”定位按钮，不直接循环 `scrollIntoView`；
- 卡片折叠/展开属于用户操作，不触发全局跳底；
- 必须实测“正在准备回答 → Todo 出现 → Interaction 出现 → 回答 → final reply”的完整高度变化。

### 9.3 原生表面遮挡

Browser / HTML Artifact 使用 `WebContentsView` 等原生表面时，DOM 弹层可能被覆盖。本文推荐 Interaction 内联而非全局 modal，可大幅降低风险；GoalSheet 若使用 portal，必须接入现有 NativeSurfaceCoordinator / overlay blocker，不能只提高 z-index。

---

## 10. 实施顺序

### Phase 0：恢复可实施基线（阻塞项）

- 修复或完成当前未提交的 Conversation Branch 代码；
- 消除 `AppDatabase.ts` / `main/index.ts` 中的语法、重复 import 和 BOM 问题；
- `pnpm run typecheck` 通过；
- 能从当前源码启动 Electron；
- 捕获聊天空态、流式态、工具态、Project Task 态截图基线；
- 记录当前滚动、任务切换和重启恢复行为。

验收：没有先完成 Phase 0，不进入新功能 DB/AgentService 大改。

### Phase 1：共享协议与持久化骨架

- 增加三个 shared DTO；
- 建表、索引、Repository、Service；
- execution identity 贯穿 bridge；
- 增加全量 snapshot 查询；
- orphan Interaction 启动清理；
- 不接 UI、不让模型调用。

### Phase 2：Conversation Todo MVP

- 注册 todo write/update 工具；
- 产生 todo snapshot patch；
- `ConversationTodoCard` 接入 MessageItem；
- end/abort finalize；
- 历史恢复；
- 滚动/虚拟列表回归。

### Phase 3：Interaction MVP

- 注册 `request_user_input`；
- service waiter 与 respond/cancel IPC；
- 五类内联 UI；
- Task 切换、sidebar awaiting_input；
- steer/interrupt 竞态；
- 重启 expired 恢复。

### Phase 4：Goal MVP

- Goal CRUD、单 active 约束；
- GoalChip/GoalSheet；
- runtime assembly 摘要；
- Goal 与 Todo 关联；
- propose complete → Interaction 确认；
- 进度跨多轮恢复。

### Phase 5：三功能集成与收口

- Goal → Todo → Interaction → Todo → Goal 完整链；
- 消息删除、regenerate、分支、归档和 Task 删除；
- Gateway/Cron/BTW 明确降级；
- 视觉与无障碍 QA；
- feature flag 灰度；
- 文档与迁移说明。

---

## 11. 测试计划

### 11.1 单元测试

新增脚本建议：

- `scripts/conversation-todo-test.ts`
- `scripts/conversation-interaction-test.ts`
- `scripts/conversation-goal-test.ts`
- `scripts/conversation-runtime-race-test.ts`

覆盖：

- 状态转换合法/非法；
- item id 唯一、数量和长度边界；
- 单 in_progress 约束；
- blocked reason 必填；
- Interaction selection min/max；
- 重复提交幂等；
- stale version 拒绝；
- 单 Task 单 active Goal；
- Goal 完成提议不直接 achieved。

### 11.2 DB / Service 集成测试

- 事务失败不留下半张 TodoList；
- 删除 Task 级联清理；
- startup 将 orphan pending Interaction 标为 expired；
- assistant_end/abort 与 update 竞态；
- 两个 Task 并行互不串状态；
- 旧数据库升级不破坏 Project Todo/Goal。

### 11.3 Renderer 测试

- Todo 活跃、完成、阻塞、中断；
- 五种 Interaction；
- 已解决答案摘要；
- GoalChip 无 Goal/active/blocked/achieved；
- 键盘导航和焦点可见；
- sidebar awaiting_input 定位；
- activeTaskId 切换时事件仍更新真实 owner task。

### 11.4 现有回归集

至少运行与本功能直接相关的现有检查：

```text
pnpm run typecheck
pnpm run test:message-lifecycle
pnpm run test:scroll-follow
pnpm run test:timeline-focus
pnpm run test:project-domain
pnpm run test:project-todo
pnpm run test:btw-isolation
pnpm run test:external-write-ui
pnpm run build
git diff --check
```

实际命令名以实施时 `package.json` 为准；不存在的别名不应凭空声称已运行。

### 11.5 Electron 真实场景

必须人工/自动化结合验证：

1. 普通一句问答：无 Todo，无多余 UI。
2. 多步骤任务：Todo 从 pending → in_progress → completed。
3. AI 请求单选：卡片出现，回答后同一回复继续。
4. 切换 Task：A 等待回答，B 正常聊天；回 A 仍可回答。
5. pending 时 steer：Interaction 被取消，新指令开始，无双重继续。
6. 应用重启：旧 pending 显示 expired，不存在无效可点击按钮。
7. Goal 跨三轮：每轮 Todo 独立，Goal 进度持续。
8. 达成 criteria：只显示完成建议，用户确认后 achieved。
9. 用户上滚时 Todo 更新：不抢滚动；点定位按钮才返回。
10. Browser/Artifact 原生表面打开时 GoalSheet 不被遮挡。
11. 删除消息/regenerate：旧 runtime 卡片不串到新回复。
12. 对话分支：历史快照独立，父子 Goal 不共写。

---

## 12. Feature Flag 与回滚

建议三个独立 flag：

```text
conversationTodoEnabled
conversationInteractionEnabled
conversationGoalEnabled
```

依赖关系：

- Todo 可独立开启；
- Interaction 可独立开启；
- Goal 可单独展示，但 Goal 自动推进建议要求 Todo + Interaction 开启。

关闭 flag 时：

- 不向 Agent 注册对应工具；
- 不注入对应 prompt；
- 已有历史数据保持可读；
- pending Interaction 在关闭前先安全 cancel；
- 不删表、不做破坏性 downgrade。

---

## 13. 风险清单

| 风险 | 严重度 | 应对 |
|---|---:|---|
| 把 Project Todo 与 Conversation Todo 混用 | P0 | 独立类型、表、工具、文案和测试 |
| 全局 activeTaskId 导致串 Task | P0 | 事件自带三重 identity；reducer 精确匹配 |
| Interaction 提交与 steer 双重继续 | P0 | execution mutex + 原子状态迁移 + 幂等键 |
| 重启后按钮仍可点但 waiter 已丢 | P0 | startup orphan → expired；resolved UI 只读 |
| Todo 动态高度破坏滚动 | P0 | virtualizer measure + follow ownership + 真实 Electron 回归 |
| Agent 过度创建 Todo/Goal | P1 | Prompt 触发规则、硬上限、显式 Goal 意图 |
| Todo 完成被误当 Goal 完成 | P1 | 独立状态机；Goal completion 需 criteria + 用户确认 |
| 专用输入绕过危险审批 | P0 | Interaction 与 Tool Approval 类型隔离；主进程 policy guard |
| 对话分支复制 live runtime 引用 | P1 | 只复制终态快照，新 id，不复制 waiter |
| 新卡片被 WebContentsView 遮挡 | P1 | Interaction 内联；Goal portal 接 NativeSurfaceCoordinator |
| 当前未提交分支代码与 DB 迁移冲突 | P0 | Phase 0 先稳定；迁移小 patch；独立 Review |

---

## 14. 明确不做

MVP 不包含：

- 把 Project Todo 自动同步到 Conversation Todo；
- 多层嵌套 Todo、子任务树或甘特图；
- 任意 JSON Schema 动态表单；
- Goal 自动创建多个后台 Agent；
- Goal 自动定时继续、无限循环或无人值守执行；
- 让 AI 无条件自动宣告 Goal 完成；
- Gateway/Cron/BTW 的完整 Goal 支持；
- 通过解析 Markdown `- [ ]` 构造权威 Todo；
- 在右侧 Artifact Panel 再做一套重复的 Todo/Goal 管理器。

---

## 15. Definition of Done

功能完成必须同时满足：

### Conversation Todo

- 复杂执行能稳定显示结构化步骤和真实状态；
- 简单问答无 UI 噪音；
- 历史恢复、Task 切换、abort、regenerate、删除消息不串状态；
- 用户滚动权不被抢走。

### Interaction

- 用户无需在普通文本里猜回复格式；
- 回答后 Agent 在同一 execution 继续；
- 多 Task 等待互不影响；
- 重启/取消/steer 无悬挂 waiter、无双重提交；
- 不能绕过危险操作审批。

### Goal

- Goal 跨多轮持续，并与单轮 Todo 清晰区分；
- 成功标准和进度可见；
- Agent 能读取并更新进度；
- 完成需要可靠 evidence 与用户确认；
- Project Goal 不被隐式覆盖。

### 总体验收

用户能够在同一条清晰链路中看到：

```text
我的长期目标是什么
→ AI 这轮准备做什么
→ 当前卡在哪里、需要我回答什么
→ 回答后继续做到哪里
→ 这一轮完成了什么
→ Goal 离完成还差什么
```

达到这一体验后，三个功能才算真正完成，而不是只增加了三个入口或三张卡片。
