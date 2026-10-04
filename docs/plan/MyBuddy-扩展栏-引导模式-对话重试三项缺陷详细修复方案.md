# MyBuddy 扩展栏、引导模式与对话重试三项缺陷详细修复方案

> 文档状态：Review 后实施规划，尚未修改业务代码  
> 基线日期：2026-09-02  
> 适用仓库：`C:\Users\servi\Desktop\mybuddy`  
> 审查基线：本地分支 `ui/welcome-home-v1`，提交 `cb80ccd fix: 三个 Bug 修复`  
> 范围：删除当前对话时扩展栏卡死、运行中插入“引导”时回复被直接截止、助手回复“重新生成”无效  
> 非目标：不调整现有 UI 视觉设计，不改对话分支产品功能，不重构 Artifact Domain，不改变 Project/Space 业务语义

## 0. 结论先行

本次不能继续在 `cb80ccd` 上增加零散兜底。三个现象虽然同时发生在聊天页，但实际属于三个不同状态边界：

1. **删除当前对话**是 Task 生命周期与右侧原生视图生命周期没有原子收口。
2. **引导模式**是 Renderer 意图、abort 行为与主进程 SDK 队列语义互相矛盾。
3. **重新生成**是 Renderer 过早破坏旧消息、主进程取消被当成成功、消息定位依赖易漂移索引。

推荐冻结以下解决方向：

- 删除当前 Task 时，使用一个统一的 `resetTaskScopedUiState()` 收口所有 Task 级面板状态，并显式关闭 Browser/Artifact 原生视图；React effect 只作为第二道保险。
- 将运行中输入语义固定为三种：
  - `continue`：当前执行完成后再处理，映射 SDK `followUp`；
  - `steer`：不 abort 当前会话，映射 SDK `steer`，在安全边界改变当前方向；
  - `interrupt`：先 abort 并释放旧 Session，再作为普通 prompt 启动新一轮。
- 将重新生成改成**两阶段提交**：点击后保留旧消息，只显示“正在重试”；主进程完成校验并真正发出 `assistant_start` 后，Renderer 才截断旧分支并插入新回复。
- 主进程对 `regenerate` 返回明确结果；`navigateTree.cancelled`、目标漂移、会话缺失都必须是失败，不允许以空白 `assistant_end` 假装成功。
- 先补 Characterization/Regression Tests，再修改实现；三个问题分别提交，避免一次大提交无法定位回归。

目标状态：

```text
删除 Task
  -> 同步关闭原生视图
  -> 原子清理 Task 级面板状态
  -> 切换下一 Task / 首页
  -> 扩展按钮不高亮、页面可点击

运行中输入
  -> continue  -> followUp queue
  -> steer     -> steer queue（不 abort）
  -> interrupt -> abort + dispose old session -> normal prompt

重新生成
  -> 保留旧消息并进入 pending
  -> 主进程校验目标与 Session
  -> navigateTree 成功
  -> assistant_start
  -> Renderer 原子替换旧回复
  -> 正常流式输出并 assistant_end
```

---

## 1. Review 基线与证据状态

### 1.1 已检查的真实代码路径

本规划基于以下当前实现：

- Task 与聊天状态：`src/renderer/src/store/appStore.ts`
- 输入框与运行中投递模式：`src/renderer/src/components/chat/ChatInput.tsx`
- 投递意图纯函数：`src/renderer/src/utils/streamingSend.ts`
- 消息操作栏：`src/renderer/src/components/chat/MessageItem.tsx`
- 根布局与原生视图关闭：`src/renderer/src/App.tsx`
- 扩展栏：`ArtifactPanel.tsx`、`ExtensionTopBar.tsx`、`ExtensionFlyoutContent.tsx`
- Browser 原生表面：`src/main/browser/BrowserHost.ts`
- Agent prompt / abort / regenerate：`src/main/agent/AgentService.ts`
- 流式消息路由：`src/main/agent/SessionRegistry.ts`
- IPC 合约：`src/shared/agent-ipc.ts`、`src/preload/index.ts`、`src/main/index.ts`
- 现有回归脚本：`scripts/streaming-send-regression-test.ts`、`scripts/architecture-test.ts`
- Pi SDK `AgentSession.navigateTree()`、`prompt(..., { streamingBehavior })` 的本地依赖实现

### 1.2 当前 Git 状态限制

当前仓库没有配置 remote/upstream，因此“最新 Git”只代表本地 HEAD，不能等价为远端最新版本。

审查期间观察到当前工作树另有一组未提交的“对话分支”实现，曾修改或新增：

- `src/main/agent/AgentService.ts`
- `src/main/agent/session-history.ts`
- `src/main/db/AppDatabase.ts`
- `src/main/index.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/renderer/src/components/chat/MessageItem.tsx`
- `src/renderer/src/store/appStore.ts`
- `src/renderer/src/types.ts`
- `src/main/agent/ConversationBranchService.ts`
- `src/main/agent/session-branch.ts`
- `src/shared/conversation-branch.ts`

其中 `AgentService.ts`、`MessageItem.tsx`、`appStore.ts` 与本方案存在直接重叠。实施时必须先执行以下二选一：

1. 将对话分支工作形成独立、可编译的提交，再在其上实施本方案；或
2. 把对话分支改动移到独立 worktree/branch，本方案基于干净的 `cb80ccd` 后继提交实施。

禁止直接覆盖、格式化或整文件重写上述文件。

注意：该并行工作树在本文编写期间仍在变化，后续又出现了 `ChatView.tsx`、`TaskItem.tsx`、`global.css` 等未提交改动，而先前出现过的个别文件也可能被撤回或暂存。因此上面的文件名是冲突证据，不是可长期依赖的冻结快照。真正施工前必须重新运行：

```powershell
git status --short --branch
git diff --stat
git diff -- src/main/agent/AgentService.ts `
  src/renderer/src/store/appStore.ts `
  src/renderer/src/components/chat/ChatInput.tsx `
  src/renderer/src/components/chat/MessageItem.tsx
```

若状态仍在变化，应停止施工并先隔离并行任务；不能一边追逐移动中的工作树，一边修改同一批核心文件。

### 1.3 已完成验证

- `pnpm run typecheck`：通过。
- `pnpm run test:streaming-send`：失败。
- 失败点：`resolveStreamingBehavior(true, "steer")` 实际返回 `"steer"`，现有测试期望 `undefined`。
- `cb80ccd` 没有同步更新该回归测试，也没有新增删除扩展栏或 regenerate 生命周期测试。
- 尚未完成真实 Electron 三场景 E2E，因此所有“已修复”结论都不能只依据 TypeScript 编译通过。

---

## 2. 产品行为与术语冻结

### 2.1 删除对话

“删除对话”在当前 UI 中对应删除 Task。删除当前 Task 后必须满足：

- 当前 Task 从列表中消失；
- Browser、Artifact、Terminal 等 Task 级右栏立即关闭；
- 右栏入口不再保持蓝色高亮；
- 不存在透明 backdrop 或 WebContentsView 截获点击；
- 若有下一 Task，聊天区切换到下一 Task；否则回到新任务/首页状态；
- 删除动作不得误删其它 Task 的 Browser URL、Artifact projection 或选择状态；
- 回收站语义保持不变，删除不等于 purge。

### 2.2 运行中三种输入模式

| UI 名称 | 用户语义 | 是否 abort | SDK 行为 | 新消息何时开始 |
|---|---|---:|---|---|
| 继续 | 当前执行结束后再处理 | 否 | `followUp` | 当前 agent turn 完成后 |
| 引导 | 在最近安全边界改变当前方向 | 否 | `steer` | SDK 消费 steering user message 时 |
| 打断执行 | 明确停止当前执行，再开始新请求 | 是 | 普通 `prompt` | abort/dispose 完成后 |

关键原则：**引导不是打断的别名。**

“引导”可以结束当前回答方向，但不能通过 Renderer 主动 abort 整个 Session。旧回复何时结束、新回复何时开始，必须以主进程收到的 SDK `message_start(user)` 事件为权威边界。

### 2.3 重新生成

“重新生成”定义为：

> 在同一个 Task 内，把会话 active leaf 导航到目标助手回复之前的用户消息，再使用该用户消息重新生成一条新的助手回复。旧 JSONL 分支可保留，但旧回复及其后的内容不再属于当前 UI active branch。

必须满足：

- 只允许对已终结的普通助手回复执行；
- 点击后不能立刻永久删除旧 UI 内容；
- 找不到 Session、目标消息漂移、navigate 取消时，旧消息必须完整保留；
- 新回复真正开始后，才替换旧回复及其后续消息；
- 重试中的再次点击必须去重；
- 重试失败必须给出用户可见错误；
- 不允许以空回复结束来伪装成功。

---

## 3. 问题一：删除对话后扩展栏卡死

### 3.1 已确认根因

`cb80ccd` 之前，`deleteTask(id)` 主要做三件事：

1. 从 `tasks` 中移除目标 Task；
2. 如果删除的是当前 Task，把 `activeTaskId` 指向第一条剩余 Task；
3. 异步删除 DB 行并清理 renderer Artifact projection。

但右栏的大部分状态是全局 Zustand 字段，不会随 `activeTaskId` 自动销毁：

- `panelOpen`
- `panelMode`
- `panelExpanded`
- `panelWidth`
- `artifactTabs`
- `activeArtifactId`
- `extensionFlyoutOpen`
- `extensionFlyoutPinned`
- `extensionMenuOpen`
- `sidebarBeforePanelExpand`
- `browserUrlByTask`
- `browserUrlInput`
- `selectMode`
- `selectedMessageIds`

Browser/HTML Artifact 又使用独立于 React DOM 的 `WebContentsView`。Task 被删后，如果 React 状态仍认为右栏打开，或者原生视图还没有收到 close，用户看到的结果就是：

- 扩展按钮继续蓝色高亮；
- 页面看起来已经切换，但鼠标事件被原生表面或 backdrop 截获；
- 关闭/重开扩展栏无法恢复到一致状态。

### 3.2 `cb80ccd` 已覆盖与未覆盖的内容

已覆盖：

- 删除当前 Task 时清除 `panelOpen`、`panelExpanded`、tabs、active Artifact、flyout/menu、选择态。

仍需补齐：

1. 没有删除 `browserUrlByTask[deletedTaskId]`。
2. 没有同步清理 `browserUrlInput`。
3. 将 `sidebarBeforePanelExpand` 设为 `null` 前，没有像 `closePanel()` 一样恢复原来的 `sidebarCollapsed`。
4. 原生 Browser/Artifact close 依赖 `App.tsx` effect，属于下一次 React commit 后的异步补救，不是删除动作本身的原子步骤。
5. `deleteTask` 直接写 `activeTaskId`，没有复用 `setActiveTask` 的完整切换语义。
6. 没有覆盖此场景的自动化测试和真实 Electron 点击验证。

### 3.3 推荐设计：统一 Task 级 UI 收口函数

在 store 外部或 store 内部定义纯函数：

```ts
interface TaskScopedUiResetOptions {
  deletedTaskId?: string;
  nextTaskId?: string | null;
  preserveHomeBrowser?: boolean;
}

function resetTaskScopedUiState(
  state: AppState,
  options: TaskScopedUiResetOptions,
): Partial<AppState>;
```

它只负责计算状态，不执行 IPC。返回值至少包含：

```ts
{
  activeTaskId: nextTaskId,
  panelOpen: false,
  panelMode: "file",
  panelExpanded: false,
  panelWidth: PANEL_RAIL_WIDTH,
  artifactTabs: [],
  activeArtifactId: null,
  extensionView: "overview",
  extensionFlyoutOpen: false,
  extensionFlyoutPinned: false,
  extensionMenuOpen: false,
  browserUrlInput: "",
  browserUrlByTask: withoutDeletedTaskKey,
  sidebarCollapsed: restoredSidebarCollapsed,
  sidebarBeforePanelExpand: null,
  selectMode: false,
  selectedMessageIds: [],
  chatSelection: null,
}
```

该函数应被以下入口复用或至少遵循同一字段清单：

- `deleteTask()` 删除当前 Task；
- `newTask()`；
- `setActiveTask()`；
- `closePanel()`；
- Task 被 purge 后当前页面仍指向它的恢复路径。

### 3.4 原生视图关闭顺序

删除当前 Task 的推荐时序：

```text
TaskItem 点击删除
  -> close context menu
  -> deleteTask(id)
      -> 判断 deletingActive
      -> 若 active：立即调用 browser.close / artifact.close
      -> Zustand 单次 set：删除 Task + 重置 Task 级 UI + 选择 nextTask
      -> clearArtifactTask(id)
      -> db.deleteTask(id)
      -> 若 nextTask 存在，按需 hydrate nextTask Artifact
```

说明：

- `window.api.browser.close()` 与 `window.api.artifact.close()` 应在切换 state 前调用，尽量缩短原生表面残留窗口。
- `App.tsx` 的 `showArtifactPanel === false` effect 保留，作为页面切换、异常状态恢复的第二道保险。
- close 调用失败不应阻止 Task 删除，但要记录可定位日志，并允许根 effect 再次关闭。

### 3.5 问题一自动化测试

新增 `scripts/task-delete-panel-regression-test.ts`，至少覆盖：

1. 删除当前 Task，`panelOpen=false`。
2. 删除当前 Task，所有 Artifact tabs 清空。
3. 删除当前 Task，flyout/menu/pinned 均关闭。
4. 删除当前 Task，展开面板前的 sidebar 状态得到恢复。
5. 删除当前 Task，只删除它自己的 `browserUrlByTask` key。
6. 删除非当前 Task，不关闭当前 Task 正在使用的右栏。
7. 删除最后一个 Task，`activeTaskId=null`，Home Browser key 不被误删。
8. Browser close 与 Artifact close 各调用一次；重复 effect close 必须幂等。

### 3.6 问题一实机验收

真实 Electron 必测：

1. 打开 Task A。
2. 打开右栏 Browser，加载任意可交互页面。
3. 确认右栏入口蓝色高亮。
4. 从侧栏删除 Task A。
5. 连续点击聊天区、侧栏、设置、下一 Task 输入框。
6. 验证所有区域立即可点击。
7. 验证右栏入口不高亮。
8. 再次打开右栏，应进入新 Task 的概览，不显示 Task A 的网页或 Artifact tab。

---

## 4. 问题二：引导模式会直接截止对话

### 4.1 已确认的契约冲突

当前 Renderer 分两步决定运行中投递：

```ts
if (shouldAbortBeforeSend(executing, streamingSendMode)) {
  await abortActiveTask();
}

const streamingBehavior = resolveStreamingBehavior(executing, streamingSendMode);
```

`cb80ccd` 后：

- `shouldAbortBeforeSend(true, "steer") === true`
- `resolveStreamingBehavior(true, "steer") === "steer"`

这意味着同一个意图同时表达：

1. 先中止当前会话；
2. 再向仍在流式执行的会话发送 steer。

两者不可能同时成立。

此外 `executing` 是 abort 之前的 React snapshot。主进程收到新 prompt 时，旧 Session 通常已经 idle 或被释放；`AgentService.prompt()` 只有在权威 `wasStreaming === true` 时才把 `streamingBehavior` 交给 SDK。因此当前 `"steer"` 在大多数正常 abort 路径中不会形成真正 steer，只会变成普通 prompt。

### 4.2 为什么 `cb80ccd` 的解释不足

提交说明认为：`steer` 返回 `undefined`，主进程默认成 `followUp`，导致新消息被截断。

但当前主流程是先 `await abortActiveTask()`，主进程又会在 abort 后检查 `session.isStreaming`，必要时释放 Session。也就是说，单纯把 `undefined` 改成 `"steer"` 并没有修正 abort/queue 的真实边界。

现有 `test:streaming-send` 失败说明行为契约已被改了一半：实现改成 steer，测试仍描述“steer 先 abort 后普通 prompt”。

### 4.3 推荐设计：一个纯函数生成完整投递计划

删除分离的 `resolveStreamingBehavior()` 与 `shouldAbortBeforeSend()`，改为单一决策函数：

```ts
export type StreamingSendIntent = "continue" | "steer" | "interrupt";

export interface StreamingSendPlan {
  abortBeforeSend: boolean;
  behavior?: "steer" | "followUp";
}

export function resolveStreamingSendPlan(
  executing: boolean,
  intent: StreamingSendIntent,
): StreamingSendPlan {
  if (!executing) return { abortBeforeSend: false };
  if (intent === "continue") {
    return { abortBeforeSend: false, behavior: "followUp" };
  }
  if (intent === "steer") {
    return { abortBeforeSend: false, behavior: "steer" };
  }
  return { abortBeforeSend: true };
}
```

这样测试只需要验证一张真值表，不会再出现两个 helper 相互矛盾。

### 4.4 ChatInput 提交流程

推荐改为：

```ts
const plan = resolveStreamingSendPlan(executing, streamingSendMode);

if (plan.abortBeforeSend) {
  await abortActiveTask({ releaseSession: true });
}

sendMessage(..., plan.behavior);
```

附加要求：

- `plan` 在任何 `await` 前一次性计算，防止 intent、Task 或 executing 在异步间隙漂移。
- abort 失败时不得继续发送普通 prompt；保留输入内容并显示错误。
- `steer` 和 `continue` 入队成功后，输入框可以清空，但对应 assistant placeholder 由 pending turn 管理。
- 快速连续 steer 必须遵循现有“后一个 steer 替换尚未开始的旧 steer”策略。

### 4.5 主进程权威校验

Renderer 的 `executing` 只是 UI 快照，主进程必须以 `entry.session.isStreaming` 为权威。

推荐规则：

```text
session idle + behavior undefined
  -> normal prompt

session streaming + behavior steer/followUp
  -> SDK queue

session idle + behavior steer/followUp
  -> 记录降级日志，作为 normal prompt 执行，result.queued=false

session streaming + behavior undefined
  -> 拒绝请求，不允许静默默认 followUp
```

最后一条很重要。当前代码的：

```ts
const streamingBehavior = req.streamingBehavior ?? "followUp";
```

会把调用方漏传意图静默改成 followUp，掩盖 Renderer/IPC bug。应改成显式校验并返回可见错误。

### 4.6 interrupt 的 Session 隔离

`interrupt` 必须避免旧 Session 的迟到 `agent_end` 被映射到新 `assistantMessageId`。

推荐在 `AgentService.abort(taskId)` 中：

1. 递增 `promptQueueEpoch`，使预处理中旧请求失效；
2. 清 SDK steer/followUp 队列；
3. 记录并结束所有 pending assistant turns；
4. await `session.abort()`；
5. 无论 `isStreaming` 是否已经变成 false，都 unsubscribe 并 release 当前 Session；
6. 下一条普通 prompt 从现有 session file 创建新 Session entry。

若因为无 session file 无法安全重建，则 interrupt 失败，Renderer 保留草稿，不得盲目发送。

这种做法比复用刚 abort 的 Session 更保守，但能明确切断迟到事件与新消息之间的路由关系。

### 4.7 消息路由要求

已有的 `pendingAssistantTurns` 思路应保留：

- steer/followUp 入队时，不覆盖当前 `entry.assistantMessageId`；
- SDK 真正发出下一条 `message_start(user)` 时，再 `activateNextAssistantTurn()`；
- 此时才结束旧 assistant UI，并启动新 assistant UI；
- 入队 Promise 只代表 queued，绝不能触发 `assistant_end`；
- 被新 steer 替换或被 abort 清理的 placeholder 必须收到明确终态。

### 4.8 问题二回归测试

重写 `scripts/streaming-send-regression-test.ts` 的意图矩阵：

| executing | intent | abort | behavior |
|---:|---|---:|---|
| false | continue | false | undefined |
| false | steer | false | undefined |
| false | interrupt | false | undefined |
| true | continue | false | followUp |
| true | steer | false | steer |
| true | interrupt | true | undefined |

另外覆盖：

1. steer 入队不覆盖当前 assistant message id。
2. `message_start(user)` 到来后才切换目标。
3. 新 steer 替换旧 pending steer，不删除 followUp。
4. interrupt 使所有 pending queue 失效。
5. abort 后的迟到 `agent_end` 不得结束新消息。
6. idle Session 收到 steer 时降级为普通 prompt，并返回 `queued=false`。
7. streaming Session 未指定 behavior 时明确失败。
8. 热更新旧主进程返回 `undefined` 时，不得根据 `Boolean(streamingBehavior)` 猜生命周期；应使用协议版本或明确 fallback。

### 4.9 问题二实机验收

使用可稳定产生长回复/多工具调用的测试任务：

#### Continue

1. 当前回复生成中输入新消息。
2. 选择“继续”。
3. 当前回复完整结束。
4. 新消息随后开始，不覆盖旧回复。

#### Steer

1. 当前回复执行中输入“不要继续 A，改为只做 B”。
2. 选择“引导”。
3. 不出现“已停止”或整轮立即空白结束。
4. 当前 Session 在安全边界消费 steer。
5. UI 中旧 assistant 与新 assistant 的边界只出现一次。

#### Interrupt

1. 当前回复执行中输入新任务。
2. 选择“打断执行”。
3. 旧回复显示已停止。
4. 旧工具与 pending queue 不再继续执行。
5. 新回复作为普通 prompt 开始。

---

## 5. 问题三：对话重试不起作用

### 5.1 当前 regenerate 链路

```text
MessageItem 点击“重新生成”
  -> appStore.regenerateMessage(messageId)
  -> 找 assistant index
  -> 找前一条 user + 计算 userMessageIndex
  -> Renderer 立即截断旧 assistant 及后续消息
  -> 插入 streaming=true 的空 assistant
  -> IPC agent.regenerate
  -> AgentService.regenerate
      -> abort stale stream
      -> create/reuse session
      -> getUserMessagesForForking()[userMessageIndex]
      -> navigateTree(target.entryId)
      -> prompt(editorText)
```

### 5.2 已确认问题

#### A. 目标 streaming 自解锁不可从正常 UI 到达

`cb80ccd` 增加“若目标助手自身 stuck streaming，先设为 false”。但 `MessageItem` 的 footer 在 `message.streaming` 时使用 `visibility:hidden`，用户看不到也点不到重新生成按钮。

因此该分支不能解决用户通过正常界面点击重试无效的问题。若需要“停止并重试”，必须设计独立、可见的操作，而不是在隐藏按钮处理器内兜底。

#### B. Renderer 在主进程确认前破坏旧 UI

当前点击后立即：

```ts
messages: [...t.messages.slice(0, idx), reply]
```

随后任何错误都会让旧回复和后续消息已经从 UI 消失。即使 JSONL 仍保留旧分支，用户看到的也是破坏性失败。

#### C. `navigateTree.cancelled` 被当成成功

主进程当前：

```ts
const result = await entry.session.navigateTree(target.entryId);
if (result.cancelled) return;
```

IPC Promise 会正常 resolve，但没有执行 prompt，也没有新内容。

`cb80ccd` 在 Renderer `.then()` 尾部强制发送 `assistant_end`，只会把空 placeholder 从 streaming 改成 completed。用户仍然得不到重新生成的回答。

#### D. sessionFile 同步与消息生命周期耦合

旧逻辑在 DB row 没有 `sessionFile` 时提前 return；新逻辑移除了 return，但又把 `assistant_end` 兜底放在 DB 同步之后。

正确边界应是：

- Session/消息生命周期由 AgentService 事件与明确 regenerate result 决定；
- DB sessionFile 回读只是持久化同步，失败不能决定消息是否结束。

#### E. “索引漂移”没有真正修复

最新代码虽然重新读取 `updatedTask`，但继续使用最初计算的 `idx`。如果消息数组在中间发生变化，仍然可能：

- 解锁错误位置；
- 计算错误的前一条 user；
- 截断错误范围。

稳定定位必须重新按 `messageId` 查找，不能把旧数组下标跨 state update 使用。

### 5.3 推荐设计：两阶段 regenerate

#### Phase A：prepare

Renderer 点击时：

1. 按 `taskId + assistantMessageId` 读取最新 Task。
2. 再次确认目标存在、role=assistant、已经终结。
3. 找最近 user，并计算 user ordinal。
4. 创建 `newAssistantMessageId` 与 `requestId`。
5. 记录 pending regenerate，但不截断 messages：

```ts
pendingRegenerations: Record<string, {
  requestId: string;
  taskId: string;
  sourceAssistantMessageId: string;
  sourceUserMessageId: string;
  userMessageIndex: number;
  newAssistantMessageId: string;
  startedAt: number;
}>;
```

6. 原回复 footer 显示“正在重新生成”，并禁用重复点击。
7. 调用 IPC。

#### Phase B：commit

主进程完成 Session/目标校验、`navigateTree()` 成功并准备开始 prompt 后，会发出新 `assistant_start`。

Renderer 收到该事件时：

1. 通过 `newAssistantMessageId` 找到 pending record。
2. 重新按 `sourceAssistantMessageId` 定位最新 index。
3. 若目标已不存在，向主进程 abort 本次 regenerate，并报告冲突。
4. 原子执行：保留目标前内容、插入新 assistant shell、删除 pending record。
5. 后续 delta/end 按普通流式消息处理。

这样在主进程校验失败前，旧 UI 始终完整。

### 5.4 regenerate IPC 返回类型

把 `Promise<void>` 改为明确结果：

```ts
export type AgentRegenerateResult =
  | {
      ok: true;
      requestId: string;
      assistantMessageId: string;
      sessionFile?: string;
    }
  | {
      ok: false;
      requestId: string;
      code:
        | "TASK_NOT_FOUND"
        | "SESSION_NOT_FOUND"
        | "TARGET_NOT_FOUND"
        | "TARGET_DRIFTED"
        | "SESSION_BUSY"
        | "NAVIGATION_CANCELLED"
        | "PROMPT_FAILED";
      message: string;
    };
```

建议主进程对失败直接 throw 一个带 code 的错误，或者返回上述 union；两者只能选择一种，不能混用“部分错误 throw、部分错误 resolve”。

Renderer 收到失败：

- 删除 pending record；
- 保留原 messages；
- 恢复重试按钮；
- 显示用户可见错误；
- 不发送伪造 `assistant_end`。

### 5.5 目标定位与漂移防护

短期可采用“ordinal + 内容指纹”双校验：

```ts
interface AgentRegenerateRequest {
  taskId: string;
  requestId: string;
  userMessageIndex: number;
  expectedUserTextHash: string;
  sourceAssistantMessageId: string;
  assistantMessageId: string;
  // existing model/permission/mode fields...
}
```

主进程：

1. `getUserMessagesForForking()` 获取目标列表；
2. 按 ordinal 取 target；
3. 提取 editor text 并计算同一规范化 hash；
4. hash 不一致则返回 `TARGET_DRIFTED`，绝不导航到错误消息。

中期更稳妥的方案是让历史 DTO 暴露 Pi session entry id，Renderer 直接传稳定 `targetEntryId`。但这会影响历史恢复、live message 与 Gateway 消息模型，建议作为独立增强，不阻塞本轮修复。

### 5.6 主进程 regenerate 状态机

推荐顺序：

```text
validate request
  -> acquire per-task regenerate lock
  -> resolve canonical cwd
  -> resolve/create session
  -> if session streaming: reject or explicit stop-and-retry path
  -> resolve target + verify fingerprint
  -> navigateTree
      -> cancelled => typed failure
  -> validate editorText
  -> prompt(...)
      -> assistant_start commits Renderer branch switch
      -> normal streaming events
      -> assistant_end from AgentService lifecycle owner
  -> return ok
  -> release lock
```

约束：

- `navigateTree.cancelled` 不再 `return` 成功。
- 不能在 Renderer `.then()` 无条件补 `assistant_end`。
- `AgentService.prompt()` 已有普通 prompt 完成后的 `assistant_end` 兜底，应由它统一负责终态。
- 同一 Task 同时只能有一个 regenerate。
- regenerate 与 delete message、conversation branch、Task delete 必须互斥或通过版本校验拒绝。

### 5.7 stopped streaming 的显式处理

如果产品需要对卡住的流式消息重试，增加独立操作：

- 按钮文案：`停止并重试`
- 仅在消息 streaming 且超过阈值，或当前 execution 明确可 abort 时显示；
- 操作顺序：abort/release -> 等待主进程确认 -> 再走两阶段 regenerate；
- abort 失败时不启动 regenerate；
- 不复用隐藏 footer 中的普通“重新生成”按钮。

V1 也可以不提供此按钮，只要求用户先点击输入框停止按钮，再对已终结回复点击重新生成。两种方案必须选定并写入 UX 文案。

### 5.8 问题三自动化测试

新增 `scripts/regenerate-lifecycle-test.ts`：

#### Renderer

1. 点击 retry 后旧消息仍存在。
2. pending 状态阻止双击。
3. `assistant_start` 到来后才截断。
4. commit 时重新按 messageId 定位，不使用旧 idx。
5. Session 缺失失败，旧消息保留。
6. navigate cancelled，旧消息保留且显示错误。
7. 主进程成功但 DB row 暂时无 sessionFile，新回复仍正常完成。
8. 用户在 pending 期间切换 Task，事件仍按原 taskId 落到正确 Task。
9. pending 期间目标被删除，返回 TARGET_DRIFTED，不截断其它消息。

#### Main

1. user ordinal 越界返回 TARGET_NOT_FOUND。
2. hash 不一致返回 TARGET_DRIFTED。
3. navigate cancelled 返回 NAVIGATION_CANCELLED。
4. editorText 为空返回明确错误。
5. prompt 成功恰好产生一次 assistant_start/end。
6. prompt 失败产生一次带 error 的 assistant_end。
7. stale streaming 能安全 abort/release，或明确拒绝。
8. connectorIds、model、permission、welcomeMode、expert、preset 继续沿用当前 Task 合约。

### 5.9 问题三实机验收

1. 对最后一条成功回复点击重新生成，新回复正常流式出现。
2. 对中间回复点击重新生成，仅在新回复开始时截断其后分支。
3. 模拟 provider 错误，旧回复不丢失，显示错误。
4. 快速双击，只发起一次 regenerate。
5. 重试过程中切换 Task，再返回时状态正确。
6. 重启应用后，active session leaf 与 UI 历史一致。
7. 连续重试同一轮三次，每次生成独立 JSONL 分支，UI 只显示当前 active branch。

---

## 6. 跨问题统一约束

### 6.1 生命周期只能有一个权威 owner

| 状态 | 权威 owner | Renderer 是否可猜测 |
|---|---|---:|
| Session 是否 streaming | Main / Pi SDK | 否 |
| assistant turn 开始/结束 | Main Agent events | 否 |
| Task 当前消息投影 | Renderer store | 可投影，不可伪造 Main 结果 |
| 原生 Browser 是否挂载 | Main BrowserHost | Renderer 发意图，Main 执行 |
| 面板是否显示/高亮 | Renderer store | 是 |
| regenerate 是否成功导航 | Main AgentService | 否 |

### 6.2 所有异步回写必须显式带 scope

禁止从异步回调中的当前 `activeTaskId` 猜目标。以下信息必须在动作开始时捕获并贯穿全链：

- `taskId`
- `assistantMessageId`
- `userMessageId`
- `requestId`
- streaming behavior / intent
- 必要时 execution/session generation

### 6.3 不依赖数组 index 跨越异步边界

数组 index 只能在同一个同步 state snapshot 内使用。经过以下任一步骤后必须重新按 id 查找：

- `set()`
- `await`
- IPC 调用
- Task 切换
- agent patch
- history hydrate

### 6.4 错误必须用户可见

禁止：

- `return` 后留下空 streaming shell；
- catch 只 `console.warn`；
- 强制 `assistant_end` 把失败伪装成成功；
- 因 close native view 失败而让整个删除动作悬空。

推荐错误文案：

- `引导发送失败，当前回复仍在继续。`
- `无法停止当前执行，新消息尚未发送。`
- `重新生成失败，原回复已保留。`
- `所选消息已变化，请刷新后重试。`
- `会话记录不存在，无法重新生成。`

---

## 7. 分阶段实施计划

### Phase 0：冻结基线与隔离并行改动

目标：得到可审计、可编译的施工起点。

- [ ] 处理当前未提交的对话分支工作，形成独立提交或迁移到独立 worktree。
- [ ] 记录施工基线 commit。
- [ ] 保存三问题的 Electron 截图/录屏基线。
- [ ] 运行 `pnpm run typecheck`。
- [ ] 运行 `pnpm run test:streaming-send`，保留当前失败证据。
- [ ] 不在此阶段修业务代码。

退出条件：工作树中的并行业务改动已隔离，现有失败可稳定复现。

### Phase 1：先补行为测试

目标：测试先描述正确产品语义。

- [ ] 重写 streaming intent 真值表测试。
- [ ] 新增 Task 删除面板状态测试。
- [ ] 新增 regenerate 两阶段生命周期测试骨架。
- [ ] 为 AgentService abort 迟到事件增加测试。
- [ ] 为 navigate cancelled 增加失败测试。

退出条件：测试在旧实现上按预期失败，且每个失败都对应一个明确缺陷。

### Phase 2：修复删除 Task 与扩展栏

目标：先完成风险最低、边界最独立的问题一。

- [ ] 增加 `resetTaskScopedUiState()`。
- [ ] 删除当前 Task 前显式 close Browser/Artifact 原生视图。
- [ ] 清理删除 Task 对应 Browser URL key。
- [ ] 正确恢复 sidebar collapsed 状态。
- [ ] 保持删除非当前 Task 时的当前面板状态。
- [ ] 通过单元测试和 Electron 场景验收。

建议独立提交：

```text
fix(ui): reset task-scoped extension state on conversation delete
```

### Phase 3：修复 continue / steer / interrupt

目标：统一运行中投递契约。

- [ ] 用 `resolveStreamingSendPlan()` 替代两个互相独立的 helper。
- [ ] steer 不再调用 abort。
- [ ] interrupt abort 后强制 release Session。
- [ ] Main 拒绝 streaming + behavior undefined。
- [ ] 保持 pending assistant turn 的激活边界。
- [ ] 更新并通过 `test:streaming-send`。
- [ ] 真实验证 continue、steer、interrupt 三条路径。

建议独立提交：

```text
fix(chat): make streaming send intents authoritative
```

### Phase 4：重构 regenerate 为两阶段提交

目标：任何 preflight 失败都不破坏旧消息。

- [ ] 增加 pending regeneration 状态与去重。
- [ ] Renderer 点击时不再立即 slice messages。
- [ ] assistant_start 时按 messageId 原子 commit。
- [ ] IPC 返回 typed result/error。
- [ ] navigate cancelled 变成明确失败。
- [ ] 增加 ordinal + text hash 校验。
- [ ] 移除 Renderer blind assistant_end。
- [ ] sessionFile 同步与消息生命周期解耦。
- [ ] 覆盖成功、失败、取消、切 Task、双击和重启。

建议独立提交：

```text
fix(chat): make response regeneration transactional
```

### Phase 5：整体验收与清理

- [ ] 运行所有新增定向测试。
- [ ] 运行 `pnpm run typecheck`。
- [ ] 运行 `pnpm run test:architecture`。
- [ ] 运行 `git diff --check`。
- [ ] 执行三问题 Electron 测试矩阵。
- [ ] 重启应用复测一次。
- [ ] 检查 DB Task 状态、Session JSONL active branch 与 UI 是否一致。
- [ ] 更新本规划“实施结果”章节或新增执行报告。

---

## 8. 测试矩阵

| 编号 | 场景 | 预期 |
|---|---|---|
| D1 | Browser 打开时删除当前 Task | 原生页关闭，UI 可点击，扩展不高亮 |
| D2 | Artifact 打开时删除当前 Task | tabs 清空，无旧 Artifact 泄漏 |
| D3 | 删除非当前 Task | 当前右栏保持不变 |
| D4 | 删除最后 Task | 回到无 Task 状态，Home Browser 不误删 |
| D5 | 面板 expanded 时删除 | sidebar 恢复删除前状态 |
| S1 | streaming + continue | followUp 排队，旧回复正常结束 |
| S2 | streaming + steer | 不 abort，安全边界改变方向 |
| S3 | streaming + interrupt | 旧 Session 停止并释放，新普通 prompt 开始 |
| S4 | 连续两次 steer | 新 steer 替换尚未开始的旧 steer |
| S5 | abort 后迟到 agent_end | 不影响新 assistant |
| S6 | idle + stale steer behavior | 降级普通 prompt，queued=false |
| R1 | 重试最后一条回复 | 新回复正常开始并完成 |
| R2 | 重试中间回复 | 新开始前旧分支可见；开始后正确截断 |
| R3 | target 不存在 | 原消息不变，显示错误 |
| R4 | target hash 漂移 | 不导航错误位置 |
| R5 | navigate cancelled | 原消息不变，不生成空回复 |
| R6 | provider 失败 | 新回复显示明确失败，生命周期终结一次 |
| R7 | 快速双击 retry | 只有一个请求 |
| R8 | retry 时切换 Task | patch 不串 Task |
| R9 | DB 暂无 sessionFile 回读 | 不影响已开始回复生命周期 |
| X1 | 对话分支与 retry 同时操作 | 互斥或版本冲突，不破坏 leaf |
| X2 | delete Task 与 pending retry | retry 被取消，迟到事件不重建已删 Task |

---

## 9. 验收标准

### 9.1 功能验收

- 删除当前对话后，右栏在一个可见帧内消失，任何区域均可点击。
- Continue、Steer、Interrupt 的行为与第 2.2 节完全一致。
- Steer 不调用 `agent.abort`。
- Interrupt 不复用旧 Session 的事件路由。
- regenerate preflight 失败不会删除旧回复。
- regenerate 成功时只有一次 assistant_start 与一次最终 assistant_end。
- 不再存在空白 completed 回复冒充重试成功。

### 9.2 自动化验收

- `pnpm run typecheck` 通过。
- `pnpm run test:streaming-send` 通过。
- 新增 Task delete panel regression 通过。
- 新增 regenerate lifecycle regression 通过。
- `pnpm run test:architecture` 通过，或只存在有证据的正交既有失败。
- `git diff --check` 通过。

### 9.3 代码质量验收

- 不再存在相互独立且可能矛盾的 abort/behavior helper。
- 不再跨 `set/await/IPC` 使用旧 message index。
- 不再由 Renderer 用 blind `assistant_end` 猜主进程结果。
- Task 删除状态字段清单只有一个权威实现。
- 新 IPC 类型在 shared、preload、main、renderer 四层一致。
- 未覆盖或改写对话分支并行开发内容。

---

## 10. 风险与回滚

| 风险 | 等级 | 缓解措施 |
|---|---:|---|
| steer 不 abort 后旧工具继续到安全边界 | 中 | UI 文案明确；真正立即停止使用 interrupt |
| abort 总是 release 增加 Session 重建成本 | 低/中 | 仅 interrupt 使用；记录耗时 |
| regenerate 两阶段使点击后短暂无空 shell | 低 | 原回复 footer 显示“正在重新生成” |
| 对话分支实现与 regenerate 同改 Session leaf | 高 | 先隔离分支开发；加 per-task mutation lock/version |
| Browser close IPC 偶发失败 | 中 | 删除前显式 close + App effect 双保险 |
| 新 IPC 结果与热更新旧主进程不兼容 | 中 | 加协议版本或重启提示，不再猜 undefined |

回滚策略：

- 三个问题分别提交，可单独 revert。
- 不回滚 DB schema，因为本方案原则上不新增 DB 表。
- regenerate 若两阶段上线后出现严重问题，可暂时禁用“重新生成”按钮并保留原逻辑代码分支；不得恢复“先删旧消息再试”的破坏性行为。
- steer 若 SDK 行为与实测不符，可临时隐藏 steer，只保留 continue/interrupt；不得再次把 steer 静默映射为 abort。

---

## 11. 建议文件改动清单

### 问题一

- `src/renderer/src/store/appStore.ts`
- `src/renderer/src/App.tsx`（仅保留/加强保险关闭逻辑时）
- `scripts/task-delete-panel-regression-test.ts`
- `package.json`

### 问题二

- `src/renderer/src/utils/streamingSend.ts`
- `src/renderer/src/components/chat/ChatInput.tsx`
- `src/renderer/src/store/appStore.ts`
- `src/main/agent/AgentService.ts`
- `src/main/agent/SessionRegistry.ts`
- `src/shared/agent-ipc.ts`（若增加明确结果/错误）
- `scripts/streaming-send-regression-test.ts`

### 问题三

- `src/shared/agent-ipc.ts`
- `src/preload/index.ts`
- `src/preload/index.d.ts`
- `src/main/index.ts`
- `src/main/agent/AgentService.ts`
- `src/renderer/src/store/appStore.ts`
- `src/renderer/src/components/chat/MessageItem.tsx`
- `src/renderer/src/types.ts`（pending 状态若进入类型模型）
- `scripts/regenerate-lifecycle-test.ts`
- `scripts/architecture-test.ts`
- `package.json`

---

## 12. 实施时禁止事项

- 不要为了通过测试只把旧断言从 `undefined` 改成 `"steer"`，而不调整 abort 语义。
- 不要在 `deleteTask` 继续堆一份与 `closePanel` 不同的字段清单。
- 不要依赖 `setTimeout` 延迟关闭 WebContentsView。
- 不要在 regenerate `.then()` 无条件发送 `assistant_end`。
- 不要把 `navigateTree.cancelled` 当作成功。
- 不要跨异步边界保存并复用 `idx`。
- 不要在错误时静默清空用户输入或旧回复。
- 不要整文件格式化当前存在并行改动的 `AgentService.ts`、`appStore.ts`、`MessageItem.tsx`。
- 不要把对话分支与本次三项修复合并为一个巨大提交。

---

## 13. 最终 Definition of Done

只有同时满足以下条件，才能宣布三个问题已解决：

1. 三条自动化回归链全部通过。
2. TypeScript 类型检查通过。
3. 当前工作树没有因本方案产生的无关格式化或并行改动覆盖。
4. Electron 中逐项完成 D1、S2、S3、R1、R2、R5 场景。
5. 删除 Task 后原生网页层确实关闭，不只是 React 按钮取消高亮。
6. Steer 的 Main 日志显示 SDK queued steer，且没有 abort 调用。
7. Interrupt 的旧 Session 事件无法结束新消息。
8. Regenerate 取消/失败时旧回复保持完整。
9. Regenerate 成功后 Session JSONL active branch、重启恢复内容和 UI 一致。
10. 每项修复都有独立提交与清晰验证记录。

未完成真实 Electron 验证时，只能表述为“源码与定向测试通过”，不能表述为“用户问题已完全解决”。
