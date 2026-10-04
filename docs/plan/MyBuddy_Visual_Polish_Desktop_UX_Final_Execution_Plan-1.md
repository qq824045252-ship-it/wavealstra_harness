# MyBuddy Visual Polish / Desktop UX Final Execution Plan

> **用途**：本文件是下一轮交给 Codex 的唯一 UI/UX 美化执行规格。  
> **执行方式**：严格按照本文实施，不自行扩展需求，不做架构重构，不重做已经存在的能力。  
> **核心目标**：
>
> **Claude Desktop 的克制、稳定、留白 + WorkBuddy 的 Workspace 工作台感 + MyBuddy 自己已经具备的 Agent / Workspace / Tool 能力。**
>
> 最终 MyBuddy 应该是一个 **Calm AI Desktop Workspace**，而不是 VS Code / Cursor，也不是传统 SaaS Dashboard。

---

# 0. 当前真实基线

本规划基于当前 MyBuddy 真实代码重新 Review 后制定，**覆盖并纠正此前过时的 UI 判断**。

当前 Review 基线：

```text
repo:
C:\Users\servi\Desktop\mybuddy

branch:
codex/gadget-blueprint

HEAD:
25ed80d0ab3dabb9fd2915f1cef505b100fa66d2
```

Pi 独立 UI/UX Review 的当前总体符合度：

```text
≈ 52%
```

结论不是“UI 没做”。

真正现状是：

> **很多局部已经做得不错，但来自不同阶段的视觉语言没有统一，导致整机看起来仍是“干净的工程产品”，而不是成熟高级桌面产品。**

---

# 1. 必须纠正的旧认知

以下能力 **已经存在**，Codex 禁止重复实现。

## 1.1 Composer 已经有 Focus 锚点

当前 `ChatInput.tsx + global.css` 已经具备：

- `.input-box`
- 大圆角 Composer
- shadow
- `:focus-within`
- focus border
- focus shadow
- 动态 textarea
- attachment / task / file references
- Skill / MCP / Connector
- Expert / Model / Thinking Level
- Permission / Context Usage
- Prompt Enhance / Voice / BTW
- streaming continue / steer / interrupt
- drag & drop / clipboard
- Home / Project / Chat variants
- container query

所以：

> **禁止重写 ChatInput。**

只允许视觉系统统一、密度调整和局部位置收口。

## 1.2 Runtime Observatory 已经存在

当前：

```text
OverviewView
    ↓
RuntimeObservatory
    ↓
当前任务 / 主 Agent
子代理
后台任务
```

已经真实实现，包括 Main Agent、Running/Completed Subagents、SubagentDrawer、Background Tasks、Terminal Sessions、elapsed time 和事件驱动刷新。

所以：

> **禁止再造一套“当前任务 / 子代理 / 后台任务”卡片。**

Stage 2 只做视觉产品化。

## 1.3 Workspace Detail 已经是五 Tab

真实结构：

```text
Overview
Context
Library
Files
Gadgets
```

Overview 已经包含：

```text
Active Work
Spaces
Recent Artifacts
Gadgets
Context Summary
Library Summary
```

Header 也已经有 breadcrumb、title、description、summary、New Task、More、child workspace、folder bind/relocate、rename、move、Blueprint、archive、delete。

所以：

> **禁止重新设计 Workspace Detail 信息架构。**

只做视觉统一。

## 1.4 Sidebar 已经完成新 IA

当前真实 IA：

```text
Header
Primary Actions

WORK
  Independent Tasks

WORKSPACES
  Workspace Tree

RESOURCES
  My Gadgets
  Library
  More
    Assistant
    Projects
    Plugins
    Automation
    Files
    Mailbox

Account
```

所以：

> **Sidebar 不再做 IA 重构。**

只处理视觉重量和 CTA 层级。

## 1.5 右侧 Extension Panel 已经成熟

当前已经包含 Overview、Workspace、Browser、Terminal、Changes、Artifact tabs、File preview、ExtensionTopBar、FileActionBar、Flyout、Pin、Resize、Expanded、panel width state、Browser native host、Artifact native host。

所以：

> **禁止新建第二套 Right Panel。**

---

# 2. 设计北极星

MyBuddy 最终视觉性格：

```text
Claude Desktop
    ↓
克制 / 稳定 / 留白 / Composer 锚点 / 低噪声 / 连续 Surface

        +

WorkBuddy
    ↓
Workspace Presence / Current Work / Context / Agent Activity / Artifacts

        +

MyBuddy
    ↓
Agent / Subagent / Workspace / Project / Gadget / Blueprint
Browser / Terminal / Artifacts / Automation / MCP / BTW / Prompt Enhance
```

最终原则：

> **能力保持 MyBuddy 的复杂度，视觉表现保持 Claude 的克制。**

---

# 3. 明确禁止的方向

Codex 不得：

- 把 MyBuddy 改成 VS Code / Cursor 风格；
- 加 Activity Bar / IDE Tab Bar / Dock / Status Bar；
- 把 Browser / Terminal 做成中心视觉；
- 卡片化所有内容；
- 加大量渐变、玻璃拟态、neon glow、复杂 blur、弹簧动画；
- 为了“高级感”增加无意义装饰；
- 删除功能来模拟 Claude 的极简；
- 重构 Multi-Space；
- 改 Store / IPC / DB；
- 改 effectiveArchived；
- 改 Workspace DnD；
- 改 Project × Workspace 语义；
- 改 Workspace Context inheritance；
- 改 Task cwd / execution semantics；
- 改 Artifact / Gadget / Blueprint Domain；
- 重写消息滚动 / virtualization / follow state；
- 创建第二套 Subagent UI；
- 创建第二套 Runtime Observatory；
- 创建第二套 Workspace Overview。

---

# 4. 执行纪律

## 4.1 开始前

先记录：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
```

如果 working tree 有用户自己的改动：**保留。**

禁止：

```text
git reset
git checkout .
git clean
git restore .
```

不得覆盖用户已有工作。

## 4.2 验证纪律

这是 UI 收口任务。

不要：

- E2E
- 长测试
- 全量压力测试
- 长时间 Electron 自动化
- 每改一个 CSS 就跑全 build
- 与 UI 无关的测试修复

只允许：

- targeted typecheck
- targeted unit test
- renderer build / typecheck 必要时一次
- 短 dev smoke check
- 代码静态 review

目标：

> **证明没有破坏，不是重新验证整个 MyBuddy。**

---

# 5. 当前真实问题分级

# P0 — Stage 1 未冻结的核心原因

## P0-1 Surface 层级仍然不足

当前 token 类似：

```css
--bg: #f4f4f5;
--bg-panel: #ffffff;
--bg-sidebar: #f4f4f5;
--bg-elevated: #ffffff;
```

问题：

```text
App ≈ Sidebar
Panel ≈ Elevated
```

导致宏观结构还是依赖 border。

目标建立：

```text
App Surface
Sidebar Surface
Main Surface
Right Surface
Elevated Surface
Input Surface
Hover Surface
Active Surface
```

## P0-2 Border 仍然太多

当前多个区域同时拥有 Sidebar separator、main-area separator、Chat Header separator、card border、menu border、button border、input border、tool border。

目标：

> **Surface + spacing 主导，border 只用于必要边界。**

## P0-3 Radius / Shadow 仍然存在多代历史

当前实际存在：

```text
6px / 7px / 8px / 10px / 12px / 16px / 999px
```

这直接造成：

> “这些 UI 不是同一时期设计的。”

---

# P1 — 核心页面视觉层级

## P1-1 Sidebar 两个一级 CTA 仍然太重

当前：

```text
[ 新建任务 ]
[ 新建工作空间 ]
```

目标：

```text
[ + 新建任务 ]

WORKSPACES                         +
Workspace Tree                     count
```

`+` 继续调用现有 `setCreateWorkspaceOpen(true)`。

空 Workspace 状态仍保留“新建工作空间 / 绑定本地文件夹”，不牺牲 discoverability。

## P1-2 Chat Header 信息仍然过载

真实 Header 目前可能同时包含 Project crumb、Workspace crumb、Task title、Mode、Expert、RuntimeStatusChips、Search、Share、History、More、Panel toggle。

目标：

> **Header 主要回答：我在哪里。**

核心只强化：

```text
Project / Workspace / Task Title
```

其它状态降为 secondary。

## P1-3 Right Panel 已有 AI Workspace 内容，但视觉仍偏工具面板

功能不是问题。

当前已经有 RuntimeObservatory、ArtifactRail、Workspace、Browser、Terminal、Changes。

目标：

```text
AI Workspace
↓
Current Work
Subagents
Background Tasks
Artifacts
↓
Browser / Terminal = deeper tools
```

不是继续增加功能。

## P1-4 Thinking / Tool Call 仍偏工程表达

目标 Collapsed：

```text
Thinking · 12s                    >
✓ Tool · read_file                >
```

Expanded 再出现详细内容。

完成态 Tool 必须明显比 Running Tool 安静。

---

# P2 — 二级页面与微交互一致性

## P2-1 Settings 与主界面视觉语言仍有割裂

不改 Settings IA，只统一 section spacing、form controls、radius、border、surface。

## P2-2 Scrollbar 不统一

统一核心桌面 scrollbar 为 6–8px、无箭头、低对比 idle、hover 提升。

## P2-3 Motion 不统一

核心 renderer 中减少 `transition: all`，统一 fast / ui / panel 三档。

---

# 6. Phase 0 — Baseline Gate

不修改 UI。

Codex 开始前重新读取：

```text
styles/global.css
Sidebar.tsx

chat/
  ChatView.tsx
  ChatInput.tsx
  MessageItem.tsx

artifact/
  ArtifactPanel.tsx
  ExtensionTopBar.tsx
  OverviewView.tsx
  ArtifactRail.tsx
  overview/RuntimeObservatory.tsx

workspace/
  WorkspaceDetail.tsx

Settings root
Project root
Library root
```

任何实现之前先确认“已有模式能否复用”。

禁止基于旧 Review 直接编码。

---

# 7. Phase 1 — Design System Convergence

> **第一优先级。Phase 1 完成前，不进入大布局修改。**

主要文件：

```text
styles/global.css
```

尽量 CSS-only。

## 7.1 Semantic Surface Tokens

新增/统一：

```css
--surface-app;
--surface-sidebar;
--surface-main;
--surface-right;
--surface-elevated;
--surface-input;
--surface-hover;
--surface-active;
```

允许旧 `--bg*` 保留为兼容 alias，不做破坏式 rename。

Light Mode 方向参考：

```text
App        #f6f6f7 左右
Sidebar    #f1f1f2 左右
Main       #ffffff
Right      #fbfbfb 左右
Elevated   #ffffff
```

关键是层级，不是死抠色值。

## 7.2 Dark Mode 同步

Dark mode 必须保持 App / Sidebar / Main / Right / Elevated 的相对层级，不能全部坍缩成同一个深灰。

## 7.3 Border Token

建立：

```css
--border-subtle;
--border-default;
--border-strong;
--focus-ring;
```

Macro boundary 用 subtle；Input 用 default；Focus/Selected 用 strong/accent-assisted；普通 Card 尽量无 border。

## 7.4 消灭 Double Separator

重点检查：

```text
Sidebar | Main
Main | ArtifactPanel
Header | Content
Panel TopBar | Body
```

一个边界只能有一个视觉 ownership。

---

# 8. Radius System

冻结：

```css
--radius-sm: 8px;
--radius-md: 12px;
--radius-lg: 16px;
--radius-pill: 999px;
```

语义：

- 8px：icon button / compact row / workspace row / task row
- 12px：button / menu / popover / small card / selector
- 16px：Composer / dialog / primary card / major floating surface
- pill：status / tags / compact chips

不要求机械消灭所有特殊值；只统一主要视觉语言。

---

# 9. Shadow System

保留并强化：

```css
--shadow-sm;
--shadow-md;
--shadow-lg;
```

语义：

- sm：idle Composer / subtle elevated surface
- md：Composer focus / flyout / active floating rail
- lg：dialog / modal / important overlay

禁止嵌套多层 shadow。

---

# 10. Motion System

建立：

```css
--motion-fast: 120ms;
--motion-ui: 160ms;
--motion-panel: 200ms;
```

核心区域把 `transition: all` 改成 property-specific transitions，只声明 background-color、border-color、color、box-shadow、opacity、transform 等真正需要的属性。

---

# 11. Focus Visible

所有核心互动对象统一 `:focus-visible`：

- button
- tab
- workspace row
- task row
- menus
- Composer control
- Project control
- Settings control

禁止 `outline:none` 后没有替代焦点。

---

# 12. Scrollbar Convergence

核心桌面 scrollbar：

```text
6–8px
无箭头
低对比 idle
hover 提升
dark mode 对应
```

覆盖 Sidebar、Chat、Right Panel、Settings、Workspace、Project。

代码编辑器 / PDF / native viewer 可保持特殊 scrollbar。

---

# Phase 1 验收

完成后必须达到：

- Sidebar / Main / Right Panel 有明确 Surface 层级；
- 宏观界面不再依赖密集 border；
- Composer idle/focus 统一 token；
- 主要 radius 已进入 8 / 12 / 16 / pill；
- scrollbar 不再混用旧式粗箭头；
- motion 无大量 `transition: all`；
- Light / Dark 都成立。

只有满足以上条件，**Stage 1 才允许冻结。**

---

# 13. Phase 2 — Sidebar Product Polish

涉及：

```text
Sidebar.tsx
global.css
```

## 13.1 保留 IA

绝对保留：

```text
WORK
WORKSPACES
RESOURCES
Account
```

## 13.2 新建任务作为唯一主 CTA

保留“新建任务”为 Sidebar 唯一大 CTA。

## 13.3 新建工作空间降权

把第二个大 CTA 从 stacked buttons 中移除，改为 WORKSPACES / Workspace Tree header 的 compact `+`。

点击仍然调用现有 CreateWorkspaceDialog，不改变业务行为。

## 13.4 Empty State 保留 CTA

Workspace 为空时保留：

```text
还没有工作空间
新建工作空间
绑定本地文件夹
```

## 13.5 视觉优先级

```text
1 New Task
2 Active Work / Workspace
3 Resources
4 Account
```

## 13.6 Row State

统一 hover / selected / weak-active / drag / menu-open。

不要用粗 border 表达 active，优先 surface-active + text contrast。

### Phase 2 验收

打开 App 第一眼看到的是“正在做什么”，不是两个创建按钮。

---

# 14. Phase 3 — Chat Header Simplification

涉及：

```text
chat/ChatView.tsx
global.css
```

## 14.1 Header 核心职责

回答：

> **我在哪里？**

核心：

```text
Project
Workspace
Task Title
```

## 14.2 当前能力不得删除

保留 Mode、Expert、RuntimeStatus、Search、Share、History、Task menu、Panel toggle，只降低权重。

## 14.3 目标层级

```text
Project / Workspace / Task Title
             secondary status
                          Search Share ··· Panel
```

Mode / Expert / Runtime 不应与 Title 同权。

## 14.4 Responsive Priority

中心区域变窄时保留顺序：

```text
1 Task Title
2 Workspace
3 Panel Toggle
4 More
5 Secondary status
```

优先 collapse Runtime text、Expert text、Mode text、Share、History，但功能不能消失；可进入 More 或仅显示 icon。

## 14.5 不重复 Composer 控件

Composer 已存在对应编辑入口时，Header 不再造第二套 Picker；Header status 可以只读。

### Phase 3 验收

```text
Header = location
Conversation = work
Composer = next action
```

---

# 15. Phase 4 — Composer Visual Consolidation

涉及：

```text
chat/ChatInput.tsx
global.css
```

原则：**不重写。**

## 15.1 Idle

- quiet border
- surface-input
- shadow-sm
- 16px major radius
- 不发光
- 不主动抢正文

## 15.2 Focus

保留 `.input-box:focus-within`，统一使用 border-strong / focus-ring / shadow-md。

禁止 scale / neon / thick accent border。

## 15.3 Toolbar 权重

Primary：

```text
Send / Stop
```

Secondary：

- Add
- Permission
- Context Usage
- Model
- Enhance
- Voice
- BTW

不能所有工具都同等显眼。

## 15.4 Chips

统一 Skill / MCP / Connector / Expert / Task Ref / File / Terminal / Captured Element 的 height、radius、padding、icon geometry、close button、hover。

差异主要由 icon / label / semantic state 表达。

### Phase 4 验收

Focus 后 Composer 是视觉锚点；Idle 时 Conversation 仍然是视觉主体。

---

# 16. Phase 5 — Conversation / Thinking / Tools

涉及：

```text
MessageItem.tsx
Thinking styles
Tool Call styles
global.css
```

## 16.1 滚动逻辑冻结

禁止修改：

- virtualization
- follow state
- pin user message
- jump-to-bottom
- ResizeObserver
- message height estimation

## 16.2 User Message

保持区别，但避免传统 IM 大气泡；使用 subtle user surface、合理 max-width、较大圆角、无重 border。

## 16.3 Assistant

尽量开放式：

```text
无外框
Typography hierarchy
Markdown rhythm
Whitespace
```

## 16.4 Thinking

Collapsed：

```text
Thinking · 12s                    >
```

Active：

```text
● Thinking                        >
```

Expanded 可保留 muted left guide，但降低 border/background，internal scrollbar 变薄。

## 16.5 Tool Call

Collapsed：

```text
✓ read_file                       >
```

Active：

```text
● Running read_file               >
```

Failed：

```text
! read_file failed                >
```

权重：

```text
Running > Failed > Completed
```

Completed Tool 必须明显淡化。

## 16.6 Approval

Approval 是真实用户决策，可以更显眼；warning surface 只用于 Approval，不扩散到整个 Tool stack。

### Phase 5 验收

长对话中正文是主要扫描路径，Thinking / Tool 不形成卡片墙。

---

# 17. Phase 6 — Right Extension Panel Productization

涉及：

```text
artifact/ArtifactPanel.tsx
artifact/ExtensionTopBar.tsx
artifact/OverviewView.tsx
artifact/overview/RuntimeObservatory.tsx
artifact/ArtifactRail.tsx
global.css
```

## 17.1 保留真实架构

绝对保留：

```text
Overview
Workspace
Browser
Terminal
Changes
File Preview
```

## 17.2 Right Surface

使用 `--surface-right` 与 Main 轻微区分。

不要大 border / 大 shadow / 浮成另一个窗口。

## 17.3 ExtensionTopBar

统一 height、active indicator、icons、tab spacing、hover、flyout、pin、expanded。

Selected 明确但克制。

## 17.4 Runtime Observatory

继续使用现有实现，只做视觉 hierarchy：

```text
CURRENT TASK
● Main Agent               Working

SUBAGENTS 2
● Review Agent             1m 32s
✓ Test Agent               Done

BACKGROUND 2
● terminal
✓ build
```

section title = muted；status dot = state；name = identity；elapsed/status = secondary；description = tertiary。

禁止每一行变 card。

## 17.5 ArtifactRail

目标是“当前工作的产出物”，不是第二个文件浏览器。

统一 Sidebar / Workspace 的 active / hover / row / metadata。

## 17.6 Browser / Terminal

保留专业工具感，但不能用它们的 IDE 风格反向定义 Overview。

## 17.7 Resize

保留现有行为。Hit area 可宽，但 visible handle 要细；resizing 时禁 transition；expanded 不产生夸张阴影。

### Phase 6 验收

右栏打开后首先理解 Agent / Subagents / Background Tasks / Artifacts，而不是“这里是一块 IDE Pane”。

---

# 18. Phase 7 — Workspace Detail Consistency

涉及：

```text
workspace/WorkspaceDetail.tsx
相关 CSS
```

## 18.1 五 Tab 冻结

保持：

```text
Overview
Context
Library
Files
Gadgets
```

## 18.2 Header

统一 breadcrumb、H1、description、summary、badge、action。

推荐层级：

```text
Breadcrumb

Workspace Name                 New Task  ···
Description
2 active tasks · 14 files · 3 gadgets
```

## 18.3 Overview 禁止回到 Card Wall

当前 flat list 是正确方向。

保持：

```text
Active Work
────────
Spaces
────────
Recent Artifacts
────────
Gadgets
────────
Context / Library
```

主要依赖 spacing / section heading / subtle separator。

## 18.4 Empty State

统一：

```text
Short title
One sentence
Primary action
```

不要大量 dashed border。

### Phase 7 验收

Workspace Detail 像 AI Workspace Home Page，而不是项目管理 Dashboard。

---

# 19. Phase 8 — Project Visual Alignment

Project 当前已有一些质量较高的模式：

- project-config-rail
- narrow overlay
- 6px scrollbar
- 16px card
- border-light surfaces
- project-post-box
- subtle shadow

这些应作为 MyBuddy 内部设计参考。

不重做 Project，只做 token migration。

Workspace 与 Project 必须像兄弟产品，而不是两个应用。

---

# 20. Phase 9 — Settings / Account / Library / Secondary Pages

前面完成后再做。

## 20.1 Settings

不改 Tabs / IA，只统一 page heading、section spacing、form row、toggle、input、card、border、radius、scrollbar。

减少“card around every section”。

## 20.2 Account Popup

保留所有现有入口，只统一 width、row height、separators、typography、hover、focus、theme switch。

## 20.3 Library / Gadgets / Plugins / Automation / Files / Mailbox

不做新 IA。

复用统一：

```text
Page Header
Search
Filter
Tabs
List/Card
Empty State
Actions
Modal
```

---

# 21. Phase 10 — Shared Overlay System

统一：

- Modal
- Context Menu
- Dropdown
- Flyout
- Toast
- ConfirmDialog

## 21.1 Menu

标准：

```text
radius-md
shadow-lg
surface-elevated
8–10px internal padding
compact row
subtle divider
```

## 21.2 Dialog

标准：

```text
radius-lg
shadow-lg
clear heading
quiet description
bottom action area
```

## 21.3 Toast

保留已有 entrance animation，只统一 surface、radius、shadow、icon、semantic color、spacing。

---

# 22. Phase 11 — Global Polish Audit

完成所有阶段后短自检。

## 22.1 Surface

确认不再是“大量同色 panel + 大量 border”。

## 22.2 Border

搜索所有 border 声明，逐项判断它是否真的承担信息职责；不是机械删除。

## 22.3 Radius

搜索 6px / 7px / 10px；无特殊理由则迁移到 token。

## 22.4 Transition

搜索 `transition: all`；核心 renderer UI 应尽量归零。

## 22.5 Scrollbar

检查 Sidebar / Chat / Right Panel / Workspace / Project / Settings。

## 22.6 Light / Dark

至少短检：

```text
Home
Chat
Workspace Detail
Project
Right Overview
Settings
Modal
Menu
Composer Focus
```

---

# 23. Final Product Acceptance Criteria

不能用“改了多少 CSS”验收。

## 23.1 3 秒测试

打开 MyBuddy 三秒内应看懂：

```text
左边：我的任务 / Workspace
中间：我正在和 AI 做什么
右边：AI 当前工作的状态 / 相关工具
底部：下一步告诉 AI 什么
```

## 23.2 Claude Test

应接近 Claude Desktop 的：

- calm
- whitespace
- typography
- low border density
- Composer focus
- restrained hover
- restrained motion
- open assistant messages

但不要求功能一样少。

## 23.3 WorkBuddy Test

应比 Claude 更强地体现：

- Workspace presence
- task/workspace relationship
- current work
- agent activity
- artifacts
- context
- file awareness

## 23.4 MyBuddy Test

必须仍然明显是 MyBuddy：

- Agent
- Subagent
- BTW
- Prompt Enhance
- Model
- Thinking
- MCP
- Workspace
- Project
- Gadget
- Blueprint
- Browser
- Terminal
- Artifact

没有核心能力因为“极简”被删除。

---

# 24. Stage Gates

# Stage 1 — Visual Foundation

完成：

```text
Surface
Border
Radius
Shadow
Motion
Focus
Scrollbar
Composer convergence
```

验收：

> **整个 Shell 看起来已经贵一档。**

当前约 52%，Stage 1 完成后目标约 70%。

# Stage 2 — Core Desktop UX

完成：

```text
Sidebar hierarchy
Chat Header
Conversation
Thinking
Tool Call
Right Panel
Runtime Observatory visual hierarchy
```

验收：

> **MyBuddy 从“工程产品”进入“成熟 AI Desktop”。**

# Stage 3 — Global Consistency

完成：

```text
Workspace
Project
Settings
Account
Library
Gadgets
Plugins
Automation
Modal
Menu
Toast
Dark Mode
```

验收：

> **整个 MyBuddy 像同一个产品。**

---

# 25. Codex 最终输出要求

全部完成后只输出：

## A. 实际修改

按 Phase 说明。

## B. 实际 touched files

列文件。

## C. 保留的已有能力

必须明确说明：

- Composer 未重写
- Runtime Observatory 未重复实现
- Workspace Detail IA 未改变
- Multi-Space 未修改
- Store/IPC/DB 未重构
- scroll-follow 未修改

## D. Verification

只列实际运行过的短验证。

禁止为了报告漂亮声称跑过没有跑的测试。

## E. Remaining Issues

原则上：

```text
P0 = 0
P1 = 0
```

如果真的存在 blocker，明确列出；禁止偷偷留 TODO。

---

# 26. Git

不要在一开始 commit。

全部完成并完成短 review 后：

```bash
git diff --check
git status --short
```

如果用户工作树原本存在非本任务修改，不要一并提交。

只提交本轮 Visual Polish 修改。

建议 commit：

```text
feat(ui): complete MyBuddy visual polish and desktop UX convergence
```

---

# 27. 最终不可违反的原则

这轮不是：

> “重新设计 MyBuddy。”

而是：

> **把已经完成度很高的 MyBuddy，统一成一个成熟桌面产品。**

不要追求：

```text
更多
更炫
更复杂
```

追求：

```text
更安静
更稳定
更统一
更清楚
更有层级
更像完成品
```

最终判断标准只有一个：

> **用户看不到“这些功能是什么时候加的”，只会觉得它们本来就应该这样存在。**
