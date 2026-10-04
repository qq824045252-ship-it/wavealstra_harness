# MyBuddy Workspace & Navigation UX Finalization
## Gadget / Blueprint / Multi-Space 最终 UI 收口实施规格

> 目标：完成 MyBuddy 从“功能入口集合”向“Workspace 驱动的 AI Desktop”转变，让 Tasks、Spaces、Gadgets、Artifacts、Blueprints 在一个统一、自然、克制的 UI 层级中被理解和使用。
>
> 本文是 **Codex 执行规格**，不是讨论稿。必须严格按本文范围执行，不得自行扩需求，不得重构无关模块。

---

# 0. Codex Execution Contract

## 0.1 必须遵守

Codex 必须：

1. 严格按照本文目标和范围执行。
2. 以当前真实代码为准，适配现有架构，不发明第二套 Domain。
3. 只处理本文明确列出的 UI 收口与已确认缺陷。
4. 保持现有 Gadget / Blueprint / Multi-Space / Artifact 核心架构不变。
5. 所有新增 UI 必须复用现有组件和设计语言，优先小步修改。
6. 完成后必须给出：
   - 实际修改文件；
   - 完成了哪些目标；
   - 哪些目标未完成；
   - 做了哪些 targeted validation；
   - 明确说明没有跑 E2E；
   - 明确说明没有跑长测；
   - 是否存在遗留风险。

## 0.2 严禁事项

本轮严禁：

- 修改 MCP 权限模型；
- 修改 `McpSideEffectPolicy`；
- 修改 `TaskFileAccessPolicy`；
- 修改 `TaskExecutionIsolation`；
- 修改 Terminal security；
- 重构 Gadget Runtime；
- 重构 Blueprint Domain；
- 重构 Artifact Domain；
- 重构 Multi-Space 数据模型；
- 重构 Workspace Tree；
- 新增 Gadget Mode；
- 新增一套 Design System；
- 全局 Theme 重写；
- 大面积 CSS Rewrite；
- 引入 Cloudflare Workers / workerd / Cloudflare OS Runtime；
- 引入新的远程运行时；
- 跑 E2E；
- 跑长测；
- 跑全量测试套件；
- 顺手修无关 Bug；
- 顺手优化无关模块；
- 为了“更优雅”重写已经稳定工作的服务。

---

# 1. 当前真实代码基线

当前 Gadget + Blueprint 架构已经完成大部分核心 Domain，并经过独立只读 Review。

已确认：

- Gadget 已是独立一等实体；
- Gadget 支持 `global | workspace | task` 三种 scope；
- Gadget Runtime 独立于 Artifact；
- Gadget 使用正式 `gadget.json`；
- Gadget 支持 `start / stop / restart / dispose / health`；
- Gadget 支持 scope move/promote，ID 与数据不丢；
- Blueprint 已形成统一 Domain；
- Blueprint 支持 `workspace | gadget | composite`；
- Blueprint 复用现有 project-template resolver / creation-plan 思路；
- Blueprint 有 `schemaVersion`；
- Blueprint capture 为白名单提取，不是 snapshot；
- Artifact / Gadget 生命周期独立；
- DB 已完成 Gadget / Blueprint schema；
- MCP / Sandbox / Terminal security 未被修改。

当前剩余的关键问题不是 Domain，而是：

1. Workspace Detail 没有真正挂载 Gadgets；
2. Sidebar 没有 My Gadgets 显性入口；
3. Workspace / Sidebar 整体 UX 仍偏开发功能页；
4. Gadget move 仍有廉价交互与归档 Workspace 校验缺口；
5. Blueprint 曾暴露未被产品 UI 使用的 `targetRootPath`，扩大了 Renderer 任意路径写入面。

因此本轮定义为：

# Workspace & Navigation UX Finalization

不是新架构阶段。

---

# 2. 最终产品目标

最终 MyBuddy 应形成以下稳定认知模型：

```text
MyBuddy
│
├── Work
│   └── Independent Tasks
│
├── Workspaces
│   └── Workspace Tree
│
├── Resources
│   ├── My Gadgets
│   └── Library
│
└── More
```

Workspace 内：

```text
Workspace
│
├── Overview
├── Context
├── Library
├── Files
└── Gadgets
```

四种核心资源语义保持：

```text
Workspace = Where work lives
Artifact  = What work produces
Gadget    = What work uses
Blueprint = How work is organized
```

本轮 UI 收口必须强化这个心智，而不是制造新的概念。

---

# 3. Sidebar 最终信息架构

## 3.1 目标

Sidebar 必须从“入口集合”收口为清晰的三级结构：

```text
WORK
WORKSPACES
RESOURCES
```

建议最终视觉结构：

```text
┌─────────────────────────────┐
│ MyBuddy                     │
│                             │
│ + New Task                  │
│                             │
│ WORK                        │
│ Independent Tasks        6  │
│                             │
│ WORKSPACES                  │
│ ▾ VDS-100                   │
│   ├ Hardware                │
│   ├ Firmware                │
│   └ Validation              │
│ ▸ LabHub                    │
│ ▸ ERP                       │
│                             │
│ RESOURCES                   │
│ My Gadgets               5  │
│ Library                     │
│                             │
│ ─────────────────────────── │
│ More                        │
└─────────────────────────────┘
```

注意：这只是结构参考，必须适配现有 Sidebar 组件，不要重写整套 Sidebar。

---

# 4. Sidebar My Gadgets 入口

## 4.1 当前问题

当前代码已经存在：

```text
App.tsx
page === "gadgets"
→ MyGadgetsView
```

但 Sidebar 没有可发现入口。

## 4.2 必须完成

在 Sidebar 的 `RESOURCES` 区域增加：

```text
My Gadgets
```

点击后复用现有：

```text
MyGadgetsView
```

不得：

- 新增 Gadget welcomeMode；
- 新增顶级 Gadget 工作模式；
- 新建另一套 Gadget 页面体系；
- 在 Sidebar 展开所有 Gadget。

Sidebar 只负责进入 My Gadgets 资源页。

## 4.3 选中态

当当前 page 为 gadgets 时：

```text
My Gadgets
```

必须有与其他 Sidebar Resource 一致的 selected 状态。

不要做特殊颜色体系。

---

# 5. Workspace Detail 最终结构

## 5.1 当前问题

当前 Workspace Detail 已有：

```text
Overview
Context
Library
Files
```

但仍偏开发功能页。

本轮必须收口为真正的 Workspace Home。

最终结构：

```text
Workspace Detail
│
├── Workspace Header
├── Workspace Navigation
│
├── Overview
├── Context
├── Library
├── Files
└── Gadgets
```

---

# 6. Workspace Header

Workspace Header 必须解决四件事：

1. 我在哪里；
2. 这是什么；
3. 这里有什么；
4. 我现在能做什么。

建议结构：

```text
VDS-100 / Hardware / Analog Frontend

Analog Frontend
Pt100 precision analog frontend development

3 active tasks · 8 files · 2 gadgets

                           [New Task] [•••]
```

## 6.1 Breadcrumb

必须基于真实 Workspace Tree：

```text
VDS-100 / Hardware / Analog Frontend
```

不要展示底层历史 Domain 名称：

```text
Project:
Space:
Workspace:
```

UI 统一使用 Workspace / Space 层级心智。

## 6.2 Summary

只展示轻量摘要：

- active tasks；
- files；
- gadgets。

不要在 Header 塞大量统计。

## 6.3 Actions

只保留最高频：

```text
New Task
•••
```

其他操作进入 `•••`。

---

# 7. Workspace Navigation

最终固定：

```text
Overview | Context | Library | Files | Gadgets
```

Gadgets 必须成为正式 Workspace Tab。

必须复用现有：

```text
WorkspaceGadgetsSection.tsx
```

不得新造一套 Workspace Gadget List。

---

# 8. Workspace Gadgets

## 8.1 当前 Gadget

展示：

```text
Current

Calibration Analyzer
Analyze calibration datasets and curves
Running
Open ···

BOM Review
Compare BOM revisions
Stopped
Open ···
```

## 8.2 Inherited Gadget

子空间必须能看到 inherited/reference Gadget，但不得复制。

展示：

```text
Inherited

Project Dashboard
From VDS-100
Open
```

必须明显显示来源：

```text
From <parent workspace>
```

Inherited Gadget 仅是 reference。

不得：

- 复制 Gadget entity；
- 复制 Gadget data；
- 修改 ownership；
- 自动创建子空间副本。

---

# 9. Workspace Overview 收口

Overview 不再是信息堆积页。

它必须回答：

> 这个 Workspace 当前在做什么？

推荐内容：

```text
Active Work
────────────────────────
● Pt100 thermal drift analysis
  Running · 12 min

● PCB review
  Waiting for input


Spaces
────────────────────────
Hardware
Firmware
Validation


Recent Artifacts
────────────────────────
Calibration Report.pdf
Schematic Review.md


Gadgets
────────────────────────
Calibration Analyzer
BOM Review


Context
────────────────────────
Inherited from VDS-100
2 local context items


Library
────────────────────────
8 linked resources
3 inherited
```

重点：

- Active Work 优先；
- 子空间结构可见；
- Recent Artifacts 可见；
- Gadgets 有摘要；
- Context / Library 只显示摘要，不重复完整页面。

---

# 10. 限制 Card Wall

本轮视觉要求：

```text
70% flat list / row
20% subtle container
10% prominent card
```

禁止把页面做成后台 Dashboard 卡片墙。

优先：

```text
Section title

Row
Row
Row
────────────────────

Section title

Row
Row
```

---

# 11. 视觉语言统一

本轮不要重做 Theme，只收口以下基本规则。

## 11.1 Border

使用弱边框：

```text
1px subtle
```

避免每个区域都有明显框。

## 11.2 Radius

统一少量值：

```text
small control   6
panel/card      8
large surface  10
```

不要同页面出现大量不同圆角。

## 11.3 Spacing

统一层级：

```text
4   icon/text
8   compact
12  row
16  group
24  section
32  page section
```

## 11.4 Typography

建议：

```text
Workspace title      20–22
Section heading      13–14 semibold
Primary row          13–14
Secondary text       12
Metadata             11–12
```

不要靠大量 Bold 制造层级。

---

# 12. My Gadgets 页面

最终定位：

> Personal toolbox / reusable tools

不是 App Store。

建议：

```text
My Gadgets

Reusable tools available across MyBuddy

[ Search ]                     [+ New Gadget]

─────────────────────────────────────────

CRC Calculator
General purpose CRC calculation
                                       Open

BOM Comparator
Compare BOM revisions
                                       Open

CSV Analyzer
Explore CSV datasets
                                       Open
```

要求：

- 默认列表式；
- 不做巨大卡片；
- 不做商城风格；
- 状态信息克制；
- 操作统一。

---

# 13. Gadget 状态展示

默认只展示：

```text
Running
Stopped
Error
```

不要默认暴露：

```text
PID
PORT
Node process
Health endpoint
runtime internals
```

高级信息进入：

```text
••• → Details
```

---

# 14. Task Gadget UX

Task 页面中的 Gadget 必须轻量。

建议：

```text
Gadgets 1

Calibration Analyzer
Temporary · Running
```

主要操作：

```text
Open
Save to Workspace
Save to My Gadgets
Delete
```

UI 不要显示：

```text
Promote Scope
Move Scope
```

Domain 可保留 scope 术语，但 UI 使用用户能理解的语言。

---

# 15. Gadget Move UI

## 15.1 当前问题

目前存在：

```text
window.prompt("global 或 Workspace ID")
```

这是开发期交互，不可保留为最终产品体验。

## 15.2 必须改为 Workspace Picker

复用现有：

```text
WorkspacePicker
```

最终交互：

```text
Move Gadget

○ My Gadgets

○ Workspace
   Search workspace...

   VDS-100
   ├ Hardware
   └ Validation

Cancel        Move
```

归档 Workspace 不可选择。

---

# 16. Gadget effectiveArchived 校验

UI 禁止选择归档 Workspace，但 Main Process 必须仍做最终校验。

在：

```text
GadgetService.assertScopeTarget
```

或等价真实落点中增加：

```text
effectiveArchived
```

校验。

要求：

- 归档 Workspace 不可成为 move / promote / convert 的目标；
- Main 层必须拒绝，不能只依赖 Renderer；
- 复用现有 Workspace effectiveArchived 逻辑；
- 不新增第二套 archive 判断。

---

# 17. Blueprint UI 定位

Blueprint 是：

> 创建 / 沉淀工作方法

不是日常浏览资源。

因此本轮不新增 Sidebar Blueprint 一级入口。

主要入口只有两个：

```text
New Workspace
→ From Blueprint
```

以及：

```text
Workspace •••
→ Save as Blueprint
```

---

# 18. Create Workspace from Blueprint

建议：

```text
Create Workspace

Name
[ VDS-200 ]

Start with

○ Blank

Blueprint
● Instrument Development
○ PCB Debug
○ Field Commissioning

                          Create
```

Blueprint 详情显示：

```text
Instrument Development

Includes
• 5 workspace sections
• 8 suggested tasks
• 2 gadgets
• context structure
```

不要展示 Blueprint JSON / Definition。

---

# 19. Save as Blueprint

Workspace `•••` 菜单：

```text
Rename
Move
────────────
Save as Blueprint
Archive
Delete
```

创建 Blueprint 页面：

```text
Create Blueprint

Instrument Development

Include
✓ Workspace structure
✓ Context structure
✓ Task definitions
✓ Gadget definitions
✓ Selected files

Runtime data and workspace history
will not be included.

                    Save Blueprint
```

必须明确表达：

```text
Blueprint = 工作方法
≠ Workspace Snapshot
```

---

# 20. Blueprint 实例目录收口

## 20.1 当前问题

`targetRootPath` 没有正式产品入口，却允许 Renderer 指定任意文件系统目录。即使做精确 rollback，也仍扩大了 Main Process 写入权限面。

## 20.2 最终修复

公共 Blueprint IPC 不再接受 `targetRootPath`。所有实例统一创建在 Main 管理的 `workspaceInstancesRoot/bp-<uuid>` 下；Workspace / Task / Memory / Gadget 的数据库物化使用同一事务，失败删除本次生成目录，启动时按当前 DB truth 清理崩溃窗口 orphan root。

---

# 21. Sidebar / Detail 统一语言

Sidebar：

```text
VDS-100
  Hardware
    Analog Frontend
```

Detail：

```text
VDS-100 / Hardware / Analog Frontend
```

必须共享同一 Workspace Tree 语义。

不要 UI 出现：

```text
Project: VDS-100
Space: Hardware
Workspace: Analog Frontend
```

底层 Domain 可保留，UI 不暴露历史命名混乱。

---

# 22. Sidebar 交互状态统一

所有 Sidebar Row 统一：

```text
Normal
Hover
Selected
Focused
Disabled
Error
```

原则：

- hover 轻；
- selected 清晰；
- focus 可访问；
- 不叠加多重高亮；
- 不同时使用强背景 + 强边框 + 强图标色。

---

# 23. 空状态统一

至少收口以下空状态。

## My Gadgets

```text
No gadgets yet

Create a reusable tool or save a task gadget to My Gadgets.
```

## Workspace Gadgets

```text
No gadgets in this workspace

Create a tool for this workspace or move an existing gadget here.
```

## Inherited Gadgets

为空时不需要额外空卡片。

## Blueprint

```text
No blueprints yet

Save a workspace as a blueprint to reuse its structure later.
```

避免大插画、巨型占位卡。

---

# 24. 实施顺序

这是同一个最终目标内的依赖顺序，不是 V1/V2。

## Step A — Sidebar Navigation

完成：

- WORK / WORKSPACES / RESOURCES 层级；
- My Gadgets 显性入口；
- My Gadgets selected state；
- 保持现有 Workspace tree 行为；
- 不改 Mode 系统。

完成判据：用户可以从 Sidebar 正常进入 My Gadgets。

## Step B — Workspace Detail

完成：

- Workspace Header；
- Breadcrumb；
- Summary；
- New Task / More；
- Tabs：Overview / Context / Library / Files / Gadgets；
- 挂载现有 `WorkspaceGadgetsSection`。

完成判据：Workspace 级 Gadget 可从 Workspace Detail 正常查看和打开。

## Step C — Workspace Overview

完成：

- Active Work；
- Spaces；
- Recent Artifacts；
- Gadgets 摘要；
- Context 摘要；
- Library 摘要；
- 降低 Card Wall。

完成判据：Overview 能在一屏内回答“这个 Workspace 当前在做什么”。

## Step D — Gadget UX

完成：

- My Gadgets 列表收口；
- Workspace Gadget 列表；
- inherited/reference 展示；
- Task Gadget 轻量展示；
- Gadget 状态统一；
- move/promotion 使用 WorkspacePicker；
- UI 不暴露 scope / pid / port 等内部概念。

完成判据：Global / Workspace / Task Gadget 的归属与操作对用户可理解。

## Step E — Blueprint UX

完成：

- Create Workspace → From Blueprint；
- Blueprint Preview；
- Workspace → Save as Blueprint；
- UI 明确“定义而非快照”。

完成判据：用户可以自然地使用和沉淀 Blueprint，而无需理解内部 JSON/schema。

## Step F — 已确认正确性缺陷

完成：

1. `effectiveArchived` Workspace 禁止作为 Gadget target；
2. Blueprint instantiate 只能写入 Main 管理目录，失败与重启均按当前 DB truth 收敛。

完成判据：不存在归档 Workspace 幽灵 Gadget；不存在 Blueprint 失败后的用户目录残留。

## Step G — Visual Consistency

只对本轮修改区域做：

- spacing；
- typography；
- border；
- radius；
- row/card 比例；
- hover；
- selected；
- empty state。

不得全局重写 CSS。

---

# 25. 验证约束

## 25.1 禁止

禁止：

- E2E；
- Playwright；
- 全量测试；
- 长测；
- 长时间 dev-server 人工测试；
- 与本轮无关的 regression suite。

## 25.2 允许

只做按需 targeted validation：

- Gadget / Blueprint 相关 unit test；
- 相关 integration test；
- DB migration targeted test；
- 相关 renderer component test；
- TypeScript typecheck；
- 必要的 build；
- 必要的 lint；
- 少量针对实际改动的 smoke-level check。

如果一个验证明显耗时，先缩小测试范围，不能直接跑全量。

---

# 26. 必须保留的现有实现

## Gadget

保留：

```text
GadgetRepository
GadgetStorage
GadgetRegistry
GadgetRuntime
GadgetService
```

保留：

```text
~/.mybuddy/gadgets/<id>/
├── gadget.json
├── code/
└── data/
```

保留：

```text
global | workspace | task
```

保留 moveScope：

```text
ID 不变
data 不变
sourcePath 不变
```

## Blueprint

保留：

```text
definition
→ resolver
→ plan
→ service
```

保留：

```text
missing → warnings
schemaVersion
captureDefinition = 白名单提取
```

禁止变成 Workspace Snapshot。

## Artifact

保持：

```text
Artifact = 输出 / 内容
Gadget = 工具 / 应用
```

禁止：

```text
Artifact.capabilities.isGadget
```

---

# 27. 最终验收场景

## 场景 A — Sidebar

用户打开 MyBuddy：

```text
WORK
Independent Tasks

WORKSPACES
VDS-100
LabHub
ERP

RESOURCES
My Gadgets
Library
```

用户能自然理解三层结构。

## 场景 B — Workspace

进入：

```text
VDS-100 / Validation
```

看到：

```text
Validation
Product validation and testing

Overview Context Library Files Gadgets
```

## 场景 C — Workspace Gadget

进入 `Gadgets`：

```text
Current
Calibration Analyzer
Validation Dashboard

Inherited
Project Dashboard
From VDS-100
```

Inherited 不复制。

## 场景 D — Task Gadget

任务中生成临时 Gadget：

```text
Calibration Analyzer
Temporary · Running
```

用户可以：

```text
Open
Save to Workspace
Save to My Gadgets
Delete
```

## 场景 E — Move Gadget

用户选择 Move to Workspace，看到 WorkspacePicker，而不是输入 Workspace ID。

归档 Workspace 不可选。

## 场景 F — Blueprint

用户：

```text
New Workspace
→ From Blueprint
→ Instrument Development
```

创建完整 Workspace Structure。

## 场景 G — Save Blueprint

成熟 Workspace：

```text
••• → Save as Blueprint
```

保存的是结构、上下文结构、任务定义、Gadget 定义与 selected files，不包含 runtime、credential、历史运行数据或 ERP 当前数据。

---

# 28. Definition of Done

只有以下全部满足，本轮才算完成：

- [ ] Sidebar 有清晰 WORK / WORKSPACES / RESOURCES 层级；
- [ ] Sidebar 可直接进入 My Gadgets；
- [ ] My Gadgets 页面可正常访问；
- [ ] Workspace Header 有 breadcrumb / title / summary / primary action；
- [ ] Workspace Detail 有 `Overview / Context / Library / Files / Gadgets`；
- [ ] Workspace Gadget 正常展示；
- [ ] inherited Gadget 明确来源且不复制；
- [ ] Overview 从“信息堆积”收口为“当前工作状态”；
- [ ] Sidebar / Workspace Detail 使用统一 Workspace 层级语言；
- [ ] My Gadgets 使用列表式个人工具箱设计；
- [ ] Task Gadget 交互轻量；
- [ ] Gadget Move 不再使用 `window.prompt` 输入 Workspace ID；
- [ ] Gadget Move 使用现有 WorkspacePicker；
- [ ] 归档 Workspace 不可成为 Gadget target；
- [ ] Main Process 同样拒绝 archived target；
- [ ] Blueprint Create Flow 可从 Blueprint 创建 Workspace；
- [ ] Workspace 可以 Save as Blueprint；
- [ ] Blueprint UI 不暴露内部 JSON/schema；
- [ ] Blueprint IPC 不暴露任意 `targetRootPath`，失败后无 orphan instance；
- [ ] Artifact Domain 未被重构；
- [ ] Gadget Runtime 未被重构；
- [ ] Blueprint Domain 未被重构；
- [ ] Multi-Space Tree 未被重构；
- [ ] MCP 未修改；
- [ ] Sandbox 未修改；
- [ ] Terminal security 未修改；
- [ ] 没有新增 Gadget Mode；
- [ ] 没有全局 Theme Rewrite；
- [ ] 没有 E2E；
- [ ] 没有长测；
- [ ] 没有全量测试套件；
- [ ] targeted validation 通过；
- [ ] Codex 最终报告列出修改文件、验证、遗留风险。

---

# 29. 最终产品状态

本轮完成后，MyBuddy 应稳定呈现：

```text
                         MyBuddy
                            │
          ┌─────────────────┼─────────────────┐
          │                 │                 │
          ▼                 ▼                 ▼
        Work            Workspaces         Resources
          │                 │                 │
   Independent Tasks        │         My Gadgets / Library
                            │
                            ▼
                        Workspace
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
         Context          Artifacts         Gadgets
                            │
                            ▼
                        Blueprint
                   “How work is organized”
```

最终用户感受应是：

> Claude Desktop 的克制  
> + WorkBuddy 的工作结构感  
> + MyBuddy 自己的 Workspace / Agent / Gadget / Blueprint 能力

而不是后台管理 Dashboard，也不是 Cloudflare OS 的复制品。

---

# 30. 最终目标一句话

> **完成 MyBuddy 从“功能入口集合”向“Workspace 驱动的 AI Desktop”转变，让 Tasks、Spaces、Gadgets、Artifacts、Blueprints 在一个统一、自然、克制的 UI 层级中被理解和使用，并同时关闭已确认的 Gadget 可达性与 Blueprint 回滚缺陷。**
