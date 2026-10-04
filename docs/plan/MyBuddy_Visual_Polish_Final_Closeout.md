# MyBuddy Visual Polish / Desktop UX — Final Closeout Execution Plan

> **用途**：本文件不是新一轮 UI 规划，而是当前 Visual Polish / Desktop UX 阶段的**最终收尾执行单**。
> **目标**：在不扩大范围、不重做功能、不引入新架构、不进行长测试的前提下，确认并处理当前未提交修改，完成必要的低风险清洁，做一次短验证与独立自审，然后 Git 收口并冻结本轮 Visual Polish。

---

## 0. 当前已确认状态

当前独立 Review 已确认：

```text
Branch: codex/gadget-blueprint
HEAD: 081ac79
Commit: feat(ui): complete MyBuddy visual polish and desktop UX convergence
```

核心结论：

```text
P0 = 0
P1 = 0

Visual Polish: READY TO FREEZE
```

当前已达到本轮核心目标：

- Design System 主路径已收敛
- Sidebar 已完成单主 CTA 收口
- Chat Header 已降噪
- Composer 复用现有能力，未重写
- Conversation / Thinking / Tool Call 已降噪
- Right Extension Panel 已完成视觉收敛
- Workspace Detail 五 Tab 保持冻结
- Project / Settings / Library / Secondary Pages 已进入同一视觉体系
- Light / Dark 已同步
- Multi-Space 架构未被破坏
- Store / IPC / DB / DnD / context inheritance / cwd 未被改动
- Chat scroll / virtualization / follow-state 未被改动

因此：

> **本轮禁止再次进入“重新设计 / 再规划 / 再做一版”的循环。**

本文件执行完成后，Visual Polish 阶段正式冻结。

---

# 1. 最终收尾目标

这次只做四件事：

```text
1. 识别并处理当前 3 个 dirty 文件
2. 只处理真正有价值、低风险的遗留 CSS 清洁
3. 做短验证 + 最终自审
4. Git 收口并冻结
```

完成后的目标状态：

```text
P0 = 0
P1 = 0

Working Tree:
- 无 Visual Polish 相关未提交修改
- 不误删用户已有改动
- 不包含无关文件

Architecture:
- 不变

Behavior:
- 不变

Visual:
- 保留当前已完成效果
- 只做最后一致性清洁

Tests:
- 只短验证
- 不 E2E
- 不长测
```

---

# 2. 开始前必须执行的基线检查

执行前必须先读取真实状态，不能根据旧报告猜。

只运行：

```bash
git branch --show-current
git rev-parse HEAD
git status --short
git diff -- src/renderer/src/components/chat/ChatView.tsx
git diff -- src/renderer/src/components/chat/ExecutionTimeline.tsx
git diff -- src/renderer/src/components/chat/ToolCallCard.tsx
```

如果存在其他 dirty 文件：

- 先判断是不是用户已有改动
- 不允许顺手修改
- 不允许回滚
- 不允许覆盖
- 不允许纳入本次提交

### 严禁

```bash
git reset
git reset --hard
git checkout .
git restore .
git clean
git clean -fd
```

也不要对未知来源 dirty 文件使用单文件 `checkout/restore`。

---

# 3. 当前 3 个 dirty 文件的处理规则

独立 Review 已发现当前工作区存在：

```text
ChatView.tsx
ExecutionTimeline.tsx
ToolCallCard.tsx
```

约：

```text
+34 / -12
```

这些文件必须**逐个看 diff 再决定**，不能直接丢弃，也不能未经判断全部提交。

---

## 3.1 ChatView.tsx

已知 dirty 内容主要涉及：

```text
WorkspaceCrumb / Task Title 顺序微调
```

检查目标：

### 必须回答

1. 当前 Header 是否更符合以下优先级：

```text
Project / Workspace / Task
```

且用户 3 秒内能判断：

```text
我在哪里
我在做什么
```

2. 是否保持：

- WorkspaceCrumb
- Task title
- Mode
- Expert
- RuntimeStatus
- Search
- Share
- History
- More
- Right Panel Toggle

3. 是否没有增加新的 picker / selector 重复入口。

4. 是否没有触碰：

- virtualizer
- follow state
- jump-to-bottom
- scroll anchoring
- message list sizing
- streaming behavior

### 决策

如果 dirty 修改：

- 提升 Header 层级
- 不丢功能
- 不增加噪声
- 不影响响应式
- 不碰滚动

则：

> **保留并纳入最终提交。**

如果只是顺序来回调整、视觉收益不明确：

> 保留 HEAD 现状，不继续反复试验。

禁止为了追求“更好看一点”继续大改 Header。

---

## 3.2 ExecutionTimeline.tsx

检查 dirty diff 是否仅包含：

- 文案
- 状态展示顺序
- 小范围视觉语义
- className 微调

必须保证：

```text
Active > Failed > Completed
```

视觉权重成立。

Completed 必须保持安静。

典型方向：

```text
Thinking · 12s >
✓ read_file >
```

不能退回：

- 大卡片
- debugger 风格
- 工程日志风格
- 高对比大量边框

### 决策

如果 dirty 只是进一步降噪：

> 保留。

如果增加了复杂结构：

> 不继续扩展。

---

## 3.3 ToolCallCard.tsx

必须确认：

- Tool Call 仍是现有体系
- 没有新造第二套 Tool UI
- Completed 状态足够安静
- Running / Approval / Failed 可适当突出
- 不增加不必要 border / shadow / card nesting

Approval 是真实用户决策，可以保留较明显状态。

Completed 工具不应该抢正文注意力。

### 决策

如果 dirty 改动符合：

```text
Running / Failed / Approval > Completed
```

则保留。

否则只回到当前已稳定的低噪音方向，不重构组件。

---

# 4. 禁止扩大修改范围

本次收尾不是 Visual Polish Phase 2。

禁止以“顺便”为理由继续修改：

```text
Sidebar IA
Workspace Detail IA
Project IA
Settings IA
Right Panel architecture
Composer architecture
Runtime Observatory architecture
Multi-Space architecture
Gadget / Blueprint architecture
Artifact architecture
Browser / Terminal behavior
BTW
Prompt Enhance
Subagent
MCP
Model selector
Permission system
Context usage
```

---

# 5. 冻结边界：绝对不能碰

以下内容为硬冻结。

## 5.1 Multi-Space

禁止修改：

- Workspace 数据模型
- Workspace Store
- Workspace IPC
- Workspace DB
- effectiveArchived
- Workspace DnD
- parent/child inheritance
- cwd binding
- workspace/task relation
- same-level context isolation
- parent context inheritance

Workspace Detail 保持：

```text
Overview
Context
Library
Files
Gadgets
```

不改 Tab IA。

---

## 5.2 Composer

`ChatInput.tsx` 不重写。

禁止重新实现：

- Model selector
- Thinking strength
- Permission
- Context Usage
- Prompt Enhance
- Voice
- BTW
- Skill chips
- MCP chips
- Connector chips
- Expert
- TaskRef
- File attachments
- Captured Element
- drag/drop
- clipboard
- steer
- continue
- interrupt

只允许必要的 CSS 一致性修正。

---

## 5.3 Runtime Observatory

禁止创建新的：

```text
Current Task
Subagents
Background Tasks
Agent Activity
```

现有：

```text
OverviewView
  -> RuntimeObservatory
  -> ArtifactRail
```

就是唯一体系。

---

## 5.4 Chat Scroll

绝对不碰：

- virtualization
- `useVirtualizer`
- scroll-follow
- pin/follow state
- auto-scroll
- jump-to-bottom
- streaming scroll
- item size correction

Visual Closeout 不允许以任何理由修改这部分。

---

## 5.5 Store / IPC / DB

禁止：

```text
src/main/**
src/shared/**
database migration
IPC contracts
Store schema
runtime protocol
```

除非发现真实 P0/P1 bug。

当前 Review 已确认没有此类 bug，因此本次默认 **0 行修改**。

---

# 6. 允许的 CSS 收尾

只允许低风险、明确有价值的清理。

---

## 6.1 native-scrollbar 遗留

独立 Review 已发现旧：

```text
native-scrollbar
12px
arrow buttons
```

仍存在于旧 CSS 区域，但主路径已被新版 7px scrollbar 覆盖。

处理规则：

### 如果确认该旧规则：

- 已无真实组件依赖
- 已被新规则完全覆盖
- 删除不会影响 Browser / Terminal / PDF / Code viewer 等 native viewer

则：

> 可以删除。

### 如果无法 100% 确认：

> 不删。

这不是必须项。

原则：

> **不要为了 CSS “干净”冒功能风险。**

---

## 6.2 旧 radius 值

当前仍有大量：

```text
6px
7px
10px
```

禁止机械全局替换。

只允许改：

- 明确属于核心主路径
- 没有特殊视觉用途
- 替换后明显符合 shared design token

例如：

```css
var(--radius-sm)
var(--radius-md)
var(--radius-lg)
var(--radius-pill)
```

但：

> **不要为了消灭 grep 命中数而批量修改 80+ 处。**

本轮不要求 `6/7/10px = 0`。

---

# 7. Design System 最终检查

确保这些 token 仍然存在并工作：

## Surface

```css
--surface-app
--surface-sidebar
--surface-main
--surface-right
--surface-elevated
--surface-input
--surface-hover
--surface-active
```

要求：

```text
App != Sidebar
Main != Right
Elevated != App
```

Dark Mode 也必须保持相对层级。

---

## Border

```css
--border-subtle
--border-default
--border-strong
--focus-ring
```

原则：

> 一个边界只允许一个视觉 owner。

不新增双 separator。

---

## Radius

```css
--radius-sm: 8px
--radius-md: 12px
--radius-lg: 16px
--radius-pill: 999px
```

不要求所有特殊控件强制统一，但核心 UI 必须保持一致。

---

## Shadow

```css
--shadow-sm
--shadow-md
--shadow-lg
```

避免：

- nested shadow
- glow
- neon
- 重阴影

---

## Motion

```css
--motion-fast: 120ms
--motion-ui: 160ms
--motion-panel: 200ms
```

核心路径不要重新引入：

```css
transition: all
```

---

## Focus

核心交互必须保留：

```css
:focus-visible
```

禁止：

```css
outline: none
```

但没有替代 focus ring。

---

## Scrollbar

主桌面区域：

```text
6–8px
no arrows
low contrast idle
slightly stronger hover
```

特殊 native viewer 可保留独立滚动条。

---

# 8. 页面最终快速检查

只做静态/短运行检查，不做长验证。

依次看：

```text
Home
Chat
Workspace Detail
Project
Right Overview
Settings
Library
Modal
Menu
Composer Focus
Dark Mode
```

---

# 9. 3 秒产品测试

启动后只看 3 秒。

必须能自然理解：

```text
左边：
Tasks / Workspaces

中间：
当前和 AI 正在做什么

右边：
AI 当前状态 / 工具 / Artifact / Browser / Terminal

底部：
下一条指令
```

如果成立：

> 通过。

如果某一块不够明确：

> 只做最小视觉修正，不重新设计。

---

# 10. Claude / WorkBuddy / MyBuddy 三重验收

## Claude 测试

应该有：

- 安静
- 留白
- 字体层级清晰
- 低边框密度
- restrained hover
- restrained motion
- open assistant messages
- Composer 是视觉锚点

不应该有：

- 大量卡片墙
- 粗 border
- IDE debugger 感
- neon
- dashboard 拼贴感

---

## WorkBuddy 测试

应该能明显感受到：

- Workspace
- Current Work
- Agent Activity
- Artifacts
- Context
- File awareness

但不是传统项目管理软件。

---

## MyBuddy 测试

以下能力必须仍然存在：

```text
Agent
Subagent
Workspace
Project
Gadget
Blueprint
Browser
Terminal
Artifact
MCP
BTW
Prompt Enhance
Model
Thinking
Permission
Context Usage
```

任何视觉改动都不能以删除这些能力为代价。

---

# 11. 短验证要求

严禁长测。

## 允许

根据实际改动只选择必要项：

```bash
git diff --check
```

如有 renderer 类型相关修改：

```bash
pnpm typecheck
```

或项目已有的短 renderer typecheck。

如有对应短 unit：

```bash
pnpm vitest <specific-test>
```

只运行直接相关测试。

最多做一次短 renderer build/typecheck。

---

## 禁止

```text
E2E
全量测试
长时间测试
stress test
benchmark
大范围 automation
Playwright 全量
长时间 pnpm dev 等待
```

不要为了证明 Visual Polish 正确而跑几百个不相关测试。

---

# 12. 最终自 Review

提交前必须重新检查：

```bash
git diff --check
git status --short
git diff --stat
git diff
```

必须明确回答：

### A. 修改是否仅限本次收尾

```text
YES / NO
```

### B. 是否触碰 Multi-Space

```text
NO
```

### C. 是否触碰 Store / IPC / DB

```text
NO
```

### D. 是否触碰 Chat virtualization / follow state

```text
NO
```

### E. 是否重写 Composer

```text
NO
```

### F. 是否重复实现 Runtime Observatory

```text
NO
```

### G. 是否新增无关 UI 体系

```text
NO
```

### H. P0

```text
0
```

### I. P1

```text
0
```

如果其中任何一项不能明确回答：

> 不允许提交，先修正范围。

---

# 13. Git 收口规则

确认 diff 后再提交。

不要自动把用户已有 unrelated dirty 文件带进去。

只 `git add` 本次确认属于 Visual Polish closeout 的文件。

建议 commit：

```text
fix(ui): finalize visual polish closeout
```

如果最终只是把未提交的 Header / Timeline / ToolCall 调整收进去：

```text
fix(ui): finalize chat visual polish
```

如果没有需要保留的改动：

> 不制造空提交。

---

# 14. 最终输出格式

执行完成后只给清晰结果，不写长篇过程日志。

必须包含：

## 1. 最终基线

```text
branch:
HEAD:
commit:
```

## 2. 实际保留的 dirty 修改

逐文件写：

```text
ChatView.tsx
- ...

ExecutionTimeline.tsx
- ...

ToolCallCard.tsx
- ...
```

若某文件最终未保留，也明确说明。

## 3. CSS 清洁

说明：

```text
native-scrollbar legacy:
- removed / kept
- reason

legacy radius:
- only targeted cleanup / untouched
```

## 4. 冻结能力确认

明确列出：

```text
Composer not rewritten
Runtime Observatory not duplicated
Workspace Detail IA unchanged
Multi-Space unchanged
Store/IPC/DB unchanged
scroll-follow/virtualization unchanged
```

## 5. 验证

只列实际执行过的短验证。

不要虚构。

## 6. Findings

目标必须是：

```text
P0 = 0
P1 = 0
```

P2 若仍存在，可写：

```text
non-blocking historical CSS debt
```

不要为了消灭 P2 扩大修改。

## 7. Git

```text
commit hash:
working tree:
```

---

# 15. 最终冻结声明

如果：

```text
P0 = 0
P1 = 0
```

且：

- 没有架构回归
- 没有功能丢失
- 没有滚动回归
- 没有 Multi-Space 回归
- 没有未处理的 Visual Polish dirty 修改

则最终明确输出：

```text
MyBuddy Visual Polish / Desktop UX: FROZEN
```

并停止继续修改本轮 UI。

---

# 16. 本轮之后禁止继续做什么

收尾完成后，不要继续：

```text
再统一一遍 radius
再清一遍 border
再换一版 Sidebar
再重排 Header
再做一版 Right Panel
再重新设计 Workspace
再重写 Composer
再“顺便”统一 Settings
```

除非未来真实用户使用中出现：

```text
明确 bug
明确可用性问题
明确功能阻塞
明确视觉回归
```

否则 Visual Polish 视为正式完成。

---

# 17. 最终产品原则

最终 MyBuddy 应保持：

> **Claude 的安静 + WorkBuddy 的工作台 + IDE 的能力，但不要 IDE 的视觉。**

同时坚持：

> **强能力隐藏在低噪音界面后面。**

以及：

> **用户不应该看得出哪些功能是不同阶段、不同时间加入的。它们应该像从一开始就属于同一个产品。**

---

# 18. 最终执行指令

从当前真实工作树开始。

不要重新规划。

不要重新设计。

不要扩大范围。

不要长测。

不要 E2E。

不要重写已有系统。

不要处理无关 dirty 文件。

先检查当前 3 个 dirty diff。

只保留真正提升当前 Visual Polish 的修改。

完成最小必要清洁。

短验证。

自 Review。

Git。

最后输出：

```text
P0 = 0
P1 = 0
MyBuddy Visual Polish / Desktop UX: FROZEN
```
