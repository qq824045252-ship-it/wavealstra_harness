# BOT-WORK UI：普通模式与 Bot 模式双页面（2026-11-06 已确认入口）

> **执行状态：UI 方案已确定，产品实现与验收待 Codex 完成。**本文件是对 [BOT-WORK-1.0 冻结设计](bot-work-design.md) 第 12、13 节的界面落点细化，不改变 F01～F14，也不覆盖 [BW-A01～BW-A46 验收规范](bot-work-acceptance.md)。参考 [Phase 1 审查与执行清单](bot-work-phase1-review.md)；代码实现需要按当前 HEAD 核查，切勿把本文件当成已经上线的 UI。

## 0. 用户已定的页面边界

1. **新建独立一级页面，不往现有普通 Task 对话 UI 里塞 Bot/Work 总览。**
2. **普通模式和 Bot 模式两套界面，复用共通组件与底层服务。**普通模式原有体验保留；Bot 模式针对长期 Bot 身份、持续交流与 Work 承诺单独组织界面。
3. **入口位置固定：现有左侧栏底部账户菜单中的「自动化」正上方，新增「Bot 模式」。**点击进入新的 Bot UI 页面。不是自动化的子页面，不是原来任务树中的新 Task，也不是覆盖已有「助手」页。
4. 两套页面可来回切换，原普通 Task 的选择、草稿和执行状态不被 Bot 页面覆盖；Bot 当前选择和会话草稿也单独保存。

## 1. 精确入口与路由

目前 [src/renderer/src/components/Sidebar.tsx](../src/renderer/src/components/Sidebar.tsx) 的 `popup === "account"` 菜单中已有「助手 / 项目 / 自动化 / 插件」项。**在「项目」之后、「自动化」之前插入：**

```tsx
<button className="sidebar-popup-item" onClick={() => go("bot")}>
  <IconBot size={14} /> Bot 模式
</button>
```

示意次序：

```text
[账户菜单]
  助手           // 原页保留：Gateway/IM 历史
  项目           // 原页保留
  Bot 模式       // 新增：点击进入独立 Bot UI
  自动化         // 原页保留：现有规则管理
  插件
  ──────────
  我的工作台
  任务成果
  ...
```

- [src/renderer/src/types.ts](../src/renderer/src/types.ts)：`Page` 联合类型新增 `"bot"`，保留 `"chat"`、`"assistant"`、`"automation"` 等旧值不变。
- [src/renderer/src/App.tsx](../src/renderer/src/App.tsx)：新增 `page === "bot"` 路由，加载独立 `BotWorkspacePage`，不渲染普通 `ChatView`。普通页路由和右侧工具面板行为保持原样。
- 「Bot 模式」与现有 `WelcomeMode = "working" | "coding" | "bot"` **不是同一个概念**：现有 Task 的 `welcomeMode="bot"` 不等于长期 Bot 的独立 Work UI；不可把换 `welcomeMode` 当作跳转。
- 原 [AssistantPage.tsx](../src/renderer/src/components/pages/AssistantPage.tsx) 是 Gateway/IM 会话查看页，先保持原职能；其渠道会话后续通过持久 Bot 绑定映射到新 Bot 页面，不直接把该页替换掉。
- 账户菜单继续作为所有页面的统一导航；Bot 页面内另有「返回普通模式」入口（`setPage("chat")`，恢复上次普通 Task 或普通首页）。点击菜单中的其他现有入口也正常退出 Bot 页面。

## 2. 两套页面的外观与职责

```text
普通模式（现有）
┌──────────────────┬──────────────────────────┬────────────────────┐
│ 普通 Sidebar     │ Task ChatView            │ ArtifactPanel      │
│ 新建任务          │ Task 消息和执行            │ 成果/浏览器/终端    │
│ 独立任务          │ 项目/Goal/工具             │                    │
│ 工作空间          │                          │                    │
└──────────────────┴──────────────────────────┴────────────────────┘

Bot 模式（独立）
┌──────────────────┬──────────────────────────┬────────────────────┐
│ Bot 导航          │ Bot 长期对话              │ Work 详情          │
│ Bot 身份列表      │ 与普通交流不冲突            │ 目标/责任/状态      │
│ 该 Bot 的 Work   │ 事项引用/成果/待决卡片       │ 成果/验收/下一步    │
│ 进行中/待确认     │ Bot Composer             │ 可展开执行证据      │
└──────────────────┴──────────────────────────┴────────────────────┘
```

**左列：**选 Bot 身份，而不是选 Task。显示 Bot 名称、在线/离线可核实状态、目前负责的 Work、需要用户处理的事项。切换 Bot 只换 Bot 上下文。Bot 的专家配置是能力标签，不把专家、worker/subagent 伪装为必须长期存在的独立 Bot。

**中列：**用户直接和当前 Bot 长期交流；普通问答不必创建 Work。Bot 接受委托之后插入有稳定 ID 的 Work 卡片，摘要展示“目标、当前负责人、已确认进展、下一步、需要用户决定什么”；相同对话可关联多个 Work，点击具体卡片确定目标 Work。Bot 持续负责，后台执行不阻塞前台聊天。

**右列：**选择 Work 时打开 `WorkInspector`。默认呈现「概览 / 成果与验收 / 历史与执行」三级内容：目标与模式 once/watch、责任、是否暂停/结算、验收缺口、当前要求/来源版本、证据、交接、订阅。高级详情可打开关联 Task、Durable 执行、子代理、诊断与用量，不把内部进度平铺在主对话。未选 Work 时显示 Bot 的职责/待办概览，不假造活跃任务。右列可以折叠；窄窗口改为抽屉，手机使用 Bot 列表→对话→Work 详情下钻。

**跨模式公共区域：**沿用当前品牌、账户菜单、设置和统一系统通知。可以复用 `Sidebar` 的外层、头部和账户菜单，但在 `page === "bot"` 时必须**替换普通的「新建任务/独立任务/工作空间」侧栏内容**为 Bot 专用导航；不能让普通 Task 树与 Bot Work 列表同时挤占同一左栏。恢复普通页面时原有 Task 侧栏原样呈现。

## 3. 复用边界：视图分离，基础能力共享

| 对象 | 普通页面 | Bot 页面 | 复用要求 |
| --- | --- | --- | --- |
| 导航与布局 | 现有 Sidebar/ChatView/ArtifactPanel | BotNavigation/BotConversation/WorkInspector | 共用 App shell、账户导航、可调整面板基础组件；不共用整个页面 DOM |
| 消息 | Task 对话 | Bot 对话 + Work 引用 | 抽取并复用 MessageItem、Markdown、附件展示、工具/成果卡片等纯渲染能力 |
| 输入 | 现有 Task ChatInput | Bot 专属 Composer | 共用输入基础控件与附件/引用功能，分别接入 Task 发送命令与 Bot 消息/Work 控制入口 |
| 专家与工具 | Task 专家/能力选择 | Bot 配置与执行时快照 | 复用 ExpertService、工具、权限、项目/工作区及文件操作能力；配置绑定对象不同 |
| 后台 | Task/Pi 直接执行 | Work→ExecutionBinding→Pi Durable | 执行内核、子代理、checkpoint 与恢复只保留一套，Work 增加业务调度/责任层 |
| 成果查看 | 已有 ArtifactPanel | Work 关联成果/证据 | 抽取文件、浏览器、终端和产物的通用 Viewer；Bot 面板按 Work 的授权和来源定位 |
| 状态 | `activeTaskId` 与 Task store | `activeBotId`/`selectedWorkId` 的独立 UI 选择 | 不借用 Task ID 充当 Bot/Work ID；权威事实来自 Work 服务的持久投影 |

注意：当前 `ChatInput.tsx` 直接依赖 `activeTaskId`、Task 草稿及 Task 发送路径；`ArtifactPanel.tsx` 同样依赖 Task 活动态。**不应只 import 旧组件并传假 `taskId` 来假装复用。**提取合适的纯输入/渲染/查看子组件和公共 hooks，再分别由普通模式与 Bot 模式的容器调用；不要复制两份完整的消息/输入实现，也不破坏普通模式现有功能。

## 4. 数据流与核心交互

1. 用户从账户菜单点「Bot 模式」→ `setPage("bot")` → `BotWorkspacePage` 渲染；左侧 Bot 导航在 Bot UI 内显示。路由仅切换展示，不创建 Task、不触发 Durable submit。
2. 选择一个 Bot → 读取持久 `botId` 映射的身份、渠道会话与未完成 Work。未查到 Bot/无法连接时给出真实空态或离线态，不回退成伪造的活跃 Task。
3. 用户发送普通问题 → Bot 消息入口；用户委托/改变目标/暂停等 → 经可信宿主创建或控制目标 `workId`，完成受理后在对话显示事实卡片。多个 Work 有歧义时用选中 Work/卡片引用消歧。
4. 单击 Work 卡片/左栏 Work 条目 → 更新 `selectedWorkId`，右侧展示唯一 Work 真源的投影。执行/日志只作为可展开的关联对象。
5. 通知/成果/验收数据经统一 Work 服务投影并按版本排序；重放历史回执不能广播旧 UI 状态。实际的离线、未知副作用、写入被阻止、待 Omarchy 实测都必须如实呈现。
6. 返回普通模式 → 恢复原来的 `activeTaskId`、普通页面右侧面板及输入草稿；再次进入 Bot 模式 → 恢复原来的 Bot/Work 选择及安全保存的输入草稿。模式间不得交叉发送和展示错误上下文。
7. 其他一级页面（项目、自动化、插件、设置等）仍为现有公共入口，不因为 Bot 页面存在而复制一套。

## 5. Codex 具体落点与验收

建议新增 `src/renderer/src/components/pages/BotWorkspacePage.tsx`、`src/renderer/src/components/bot/BotNavigation.tsx`、`BotConversation.tsx`、`WorkInspector.tsx`、`WorkCard.tsx`；确切命名可以随已有代码调整，但页面/状态边界不可合并回 Task。公共消息组件仍在 `components/chat/`；拆分只做到可以复用且不引入双真源为止。

- [ ] **UI-01 入口：**账户菜单「项目 → Bot 模式 → 自动化」顺序正确；点击「Bot 模式」进入新 `page="bot"`，不是旧 `assistant`、`automation` 或 `chat`。
- [ ] **UI-02 两套导航：**普通页保留现有 Task 树、新建任务、工作空间和 Task 右栏；Bot 页显示 Bot/Work 导航，不叠加普通 Task 树；两页都有可靠返回/切换入口。
- [ ] **UI-03 隔离：**在普通任务输入未发送内容 → 切到 Bot → 再切回，草稿与选中任务不丢；Bot 的消息/Work 选择不被普通 Task 改动覆盖，不能发送到错误身份。
- [ ] **UI-04 对话关联：**同 Bot 会话同时引用 Work A/B，点击不同卡片只切对应 Work；归档一段会话不消灭 Work；普通交流不强制建 Work。
- [ ] **UI-05 事实显示：**Bot 的状态、Work 成果与待确认事项来自权威投影；没有运行记录时不显示伪造进度；旧回执/乱序投影不能回滚当前 UI。
- [ ] **UI-06 复用：**消息、Markdown、附件、工具/成果查看复用现有基础组件；没有复制第二套执行内核，也没有用假 Task 记录承载 Bot 身份。
- [ ] **UI-07 响应式：**窄窗口右栏可收起，手机从 Bot→对话→Work 详情逐层浏览；重要待决项不会因右栏折叠而不可见。
- [ ] **UI-08 同步：**跨端/重启恢复 Bot/Work 权威状态、当前责任与通知事实；窗口关掉不取消 Work，离线不可伪装为继续运行。
- [ ] **UI-09 回归：**普通 `chat`、旧 Gateway `assistant`、`projects`、`automation` 与 Task 工具菜单/诊断/文件成果的既有操作正常。
- [ ] **UI-10 可执行交付：**完成后运行仓库现有 typecheck、相关 headless/GUI 验证；用户未授权时不打包。为新页面补路由、模式隔离、卡片定位与空态的行为测试。仅画静态 UI 或展示空壳不能宣称 Bot 功能完成。

**实施时序：**Codex 应在 Bot/Work 主服务接线时就建立独立页面路由、Bot 导航和受理/详情入口；Phase 5 再完成通知去重、跨端增量/重连和全链路验收，而不是到 Phase 5 才决定两套页面位置。可以分内部提交，但完整 BOT-WORK-1.0 以冻结 BW 场景和端到端故事为最终完成定义。
