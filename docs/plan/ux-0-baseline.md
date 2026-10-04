# UX-0 基线冻结与真实 UI 盘点 — 内部记录

> 生成时间 2026-08-21 / 分支 `codex/recovery-20260811` / HEAD `a27ce8b2083e9077eda8d6d860a18cfb98693515`
> 原则：只读盘点，不改代码，不清理工作树（status clean）

## 1) Git 基线

- branch: `codex/recovery-20260811`
- HEAD: `a27ce8b fix(workspace): guard unavailable workspace files`
- `git status --porcelain`: clean（除未跟踪的 docs/plan 产出）
- 近期关键提交：
  - `a27ce8b fix(workspace): guard unavailable workspace files`
  - `5aa1835 feat(ui): polish sidebar workspace navigation`
  - `e780715 test(workspace-files-ui): update Sidebar drop handler assertion`
  - `ad71071 feat(multispace-ui): restore independent tasks and expose workspace ui`
  - `46bf1c4 feat(workspace): finalize workspace v2` 等

## 2) 页面入口（真实路由 via `appStore.page`）

`src/renderer/src/App.tsx`：

- `chat` → `ChatView`
- `workspace` (`activeWorkspaceId` != null) → `WorkspaceDetail`
- `projects` → `ProjectsPage` (`ProjectList` / `ProjectWorkspace`)
- `files` → `FilesPage`
- `library` → `LibraryPage`
- `assistant` → `AssistantPage`
- `experts|skills|mcp|connectors` → `HubPage`
- `automation` → `AutomationPage`
- `mailbox` → `MailboxPage`

Sidebar / WorkspacePicker / ChatView WorkspaceCrumb / Task context menu 均为真实入口，已存在。

## 3) 组件定位（真实文件）

- `src/renderer/src/App.tsx`
- `src/renderer/src/components/Sidebar.tsx` — 树、DnD、虚拟化、active 状态
- `src/renderer/src/components/workspace/WorkspaceDetail.tsx` — Header + Tabs (overview/context/library/files)
- `src/renderer/src/components/workspace/WorkspaceSharedContextSection.tsx` — context 来源视图
- `src/renderer/src/components/workspace/WorkspaceLibraryBindingsSection.tsx` — library 绑定
- `src/renderer/src/components/workspace/WorkspaceFilesStandalone.tsx` — standalone files
- `src/renderer/src/components/artifact/WorkspaceFilesView.tsx` — artifact 侧 files
- `src/renderer/src/components/chat/ChatView.tsx` + `WorkspaceCrumb.tsx` + `ChatProjectCrumb.tsx` + `WorkspacePicker.tsx` + `ProjectPicker.tsx`
- `src/renderer/src/components/pages/ProjectsPage.tsx` + `pages/project/ProjectWorkspace.tsx` + `pages/project/ProjectTasks.tsx`
- `src/renderer/src/components/pages/library/LibraryPage.tsx`
- `src/renderer/src/store/appStore.ts` — `spaces`, `tasks`, `activeWorkspaceId`, `openWorkspaceDetail`, `bindTaskSpace`, `moveSpace` 等
- `src/shared/workspace-tree.ts` — `buildWorkspaceTree`, `findWorkspaceNode`, `validateDrop`, 虚拟化阈值

## 4) UI 状态矩阵（A-P 覆盖）

| 状态 | 现状 | 备注 |
|---|---|---|
| A 独立任务 | 已支持 | `WorkspaceCrumb` 显示“独立任务”；`ProjectTasks` 显示“独立”；Sidebar 独立根下（`parentId==null` tasks） |
| B 根 Workspace | 已支持 | `spaces.filter(parentId==null)` |
| C 一级子 Workspace | 已支持 | path `Vivion › 子` |
| D 深层 Workspace | 已支持但无省略 | `spacePath`/`buildSpacePath` 循环 32 步，无中间省略，长名会溢出 |
| E Workspace 内无任务 | 已支持，空状态弱 | Overview 仅显示 taskCount 0、children “—”，无“创建第一个任务”引导 |
| F 大量任务 | 已部分支持 | `shouldVirtualize`/`TREE_VIRTUALIZE_THRESHOLD` + `@tanstack/react-virtual`，但 Sidebar 密度/折叠策略待 UX-2 校验 |
| G 有子空间 | 已支持 | Overview children `join(" / ")` |
| H 当前 Chat 属于当前 Detail Space | 行为存在，视觉未区分 | `activeWorkspaceId` vs `task.spaceId` 两个真相源，无“weak context indicator”区分 |
| I 当前 Chat 属于另一 Space | 同上 | 需 UX-2 引入 weak indicator，避免与 Detail active 同色 |
| J Project 含多 Workspace 任务 | 已支持显示 | `ProjectTasks` 已按 task 逐行算 `wsLabel`（独立 / `a › b › c`），但不可点击、文案“独立”与别处不一致 |
| K Context 有继承 | 已支持 | `WorkspaceSharedContextSection` scope `local/inherited/promoted` + depth |
| L Context 无继承 | 已支持 | 空组显示 emptyHint |
| M 已归档 Workspace | 已支持 | `archived/effectiveArchived` + badge“已归档”、Picker 过滤 archived |
| N 独立→Workspace | 已支持 | `bindTaskSpace(taskId, spaceId)` / Picker `draft-workspace` / DnD |
| O Workspace A→B | 已支持 | 同上 + `moveSpace` |
| P Workspace→独立 | 已支持 | `bindTaskSpace(taskId, null)` / 拖到独立根 |

## 5) Current UI / Existing behavior / Missing UX / Potential inconsistency

### Current UI
- WorkspaceDetail 已是独立页面（Header+Tabs），但仍像数据管理页：Header 仅“返回+路径字符串+打开文件夹”，Overview 为 6 张等权 Card（名称/路径/父空间/子空间/任务数/归档），路径作为显眼 Card 展示。
- Chat Header 已有两套：hero（draft）与 task header，均含 `ChatProjectCrumb` + `WorkspaceCrumb`，但 `cwd` 仍以 `workspace-path-banner` 横幅暴露。
- ProjectTasks 已有 workspace 列（badge），Library/Files 已有空间维度的入口。

### Existing behavior（可复用，不重写）
- `buildWorkspaceTree` / `recomputeEffectiveArchived` / `validateDrop` 已冻结且被 Sidebar 复用
- `ProjectTasks.filterProjectTasks` 已有 workspace 展示逻辑
- `WorkspaceSharedContextSection` 已有 local/inherited 分组与“提升到父空间”

### Missing UX（按规划对照）
- UX-1: Header 缺 Breadcrumb 可点击、缺“新建任务/新建子空间/更多”主操作；Overview 缺“Current/Recent Tasks + Child Workspaces + Context/Library/Files Summary”信息层级与空状态文案；cwd 过于显眼
- UX-2: Space/Task 仅靠 icon+缩进区分不足；缺少 `active workspace detail` vs `weak chat workspace` vs `active task` 三态；深层4级可读性/省略/tooltip 未验证；Search/Favorite/Archived 与树的关联待明确；DnD 目标高亮/非法反馈待验收
- UX-3: Chat 缺“Project / Workspace”两行显式 Identity（当前仅 crumb），Workspace 名称不可点击进入 Detail，Inherited 轻提示缺失，cwd 应隐藏
- UX-4: 动作分散（Task menu/Chat Header/Picker/DnD）文案未冻结：Picker 中“独立/不使用工作空间/选择工作空间”混用，ProjectTasks 用“独立”而非“独立任务”
- UX-5: Project 展示已有但需统一为“独立任务”、增加 Workspace 标签可点击进 Detail、保持 `Project ⟂ Workspace` 心智
- UX-6: Context 已可分组但缺“当前/继承/隔离”三段式可解释视图，Library 需区分“当前/继承”，Files 不应虚构继承，隔离说明缺失
- 横切: 无统一 `Workspace Path Formatter`（`spacePath`/`buildSpacePath`/`wsLabel` 三处重复实现），无统一文案常量

### Potential inconsistency
- 同一 “独立任务” 概念在 `WorkspaceCrumb`（独立任务）、`WorkspacePicker`（不使用工作空间/独立）、`ProjectTasks`（独立）文案不一致
- Path formatter 三处重复：`WorkspaceDetail.spacePath` / `WorkspaceCrumb.buildSpacePath` / `ProjectTasks.wsLabel`，分隔符同为 `›` 但截断/省略策略不统一
- `activeWorkspaceId`（Detail 激活）与 `task.spaceId`（Chat 归属）未在 Sidebar 做三态区分，易出现“Sidebar 已在 B，Header 仍显示 A”类问题（已在 store 层面有真相源，但 UI 未同步表达）
- WorkspacePicker 为扁平过滤列表，无层级/面包屑，深层空间不可理解

## 6) Do-not-touch backend contracts（本阶段冻结）

- DB schema / migrations
- `Workspace` 数据模型、`Task ↔ Workspace`、`Project ↔ Workspace` 正交关系
- Context/Memory/Library 继承算法与 Resolver
- `WorkspaceService` / `appStore` 主契约、`agent-ipc` / `SpaceDto` / `TaskDto`
- `Workspace cwd / trash_path` 绑定与任务执行隔离模型
- IPC 主契约（`window.api.db.*`, `window.api.*`）
- 仅当 UI 已证明无法正确表达真实状态且非前端 selector/adapter 可解决时才允许 Architecture Exception（需记录变更与回归）

## 7) UX-0 验收

- [x] Git 基线已记录，未清理用户工作树
- [x] 真实入口与组件已定位
- [x] A-P 状态矩阵已建立
- [x] 每阶段可复用能力已识别（tree/recompute/validateDrop/ProjectTasks wsLabel/SharedContext grouping）
- 下一步：UX-1 Workspace Detail 产品化（Header Breadcrumb + Overview 信息层级 + 空状态），严格 UI 适配现有架构
