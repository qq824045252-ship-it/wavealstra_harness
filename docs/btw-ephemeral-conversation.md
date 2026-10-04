# BTW（By The Way）临时上下文分支 — 系统边界与生命周期

> 冻结架构说明：BTW = 基于「点击 BTW 瞬间」主对话上下文的只读临时会话分支。
> 本文件固化系统边界与生命周期语义，作为手工验收与后续修改的红线参考。

## 1. 架构总览

```
┌─ renderer（每个 BrowserWindow 一份）─────────────────────────────┐
│  ChatInput（btw-trigger 入口 + 独立 btwText 草稿）                │
│  btwStore（ephemeral 状态：active/starting/ready/streaming/…）    │
│  BtwPanel（状态条 / 展开面板 / 折叠条，位于 message-scroll 之外）  │
│     │  window.api.btw.*（invoke）      ▲  btw:event（订阅）       │
└─────┼──────────────────────────────────┼─────────────────────────┘
      ▼                                  │
┌─ 主进程 AgentService ──────────────────┼────────────────────────┐
│  btwSessions: Map<btwId, BtwSessionEntry>                        │
│  · SessionManager.inMemory（persist=false，绝不写 sessionFile）  │
│  · 工具白名单 read/grep/find/ls（写能力在工具层不存在）            │
│  · noExtensions（不挂 MCP/EventBus）                             │
│  · 事件经 btw:event 广播（携带 btwId），renderer 按 btwId 路由    │
│  · keepalive（90s 超时）+ prune（10s 轮询）+ 上限 5（硬闸门）      │
└──────────────────────────────────────────────────────────────────┘
```

## 2. 隔离红线（不可破坏）

| 维度 | 保证 | 防线 |
|---|---|---|
| Task.messages | BTW 消息只存在于 btwStore.messages | btwStore 无 tasks 写入；行为测试断言主任务消息数不变 |
| Task Registry | 不入 SessionRegistry（无 taskId 条目） | BTW 区块源码无 `registry.set/delete`；arch 测试 |
| sessionFile | 内存态会话（persist=false） | `SessionManager.inMemory`；无 `setSessionFile` |
| DB | 只读（listTasks/getTask/getSpace） | BTW 区块无 db 写调用；arch 测试 |
| Memory / 项目记忆 | 不读写 | 无调用路径 |
| 消息 id 空间 | btwId/消息 id 用 `btw-*` 前缀 + 时间戳 + 计数器 + 随机段（多窗口全局唯一） | 前缀断言 + 唯一性测试 |
| 事件通道 | 独立 `btw:event`，绝不经过 `agent:event` | 通道字符串不同；preload 分别订阅；主进程只 `emitBtwPatch` |
| 任务状态派生 | 不影响 taskHasActiveExecution / deriveTaskStatus / 侧栏 / 标题 / 恢复 / 搜索 | 不入 registry + 不写 Task.messages |

## 3. 上下文继承（点击瞬间冻结）

- 系统上下文基底 = 主任务当前生效装配（`runtimeAssembly.segments`，live 优先；
  无 live 会话时从 DB 配置经 `assembleModePreview` 只读重装配，失败显式降级为仅快照）。
- 对话快照 = 用户/助手文本（≤60 轮 / 24k 字符，截断带显式标注）。
- 冻结语义：快照后主对话任何变化与 BTW 无关；每轮 BTW 只基于快照 + BTW 自身历史。

## 4. 生命周期矩阵

| 场景 | 行为 | 机制 |
|---|---|---|
| 正常 close | 立即销毁 | renderer 清状态（UI 即退）→ btw.close → 主进程 settle+dispose |
| 生成中 close | 同上，不等待主进程 abort | 主进程 `btwClose` 先 settle 再 dispose；late patch 被 btwId 守卫丢弃 |
| start 在途 send | 首轮排队，start 完成后自动补发 | starting/ready/pendingSend 状态机 + promptBtwTurn 统一入口 |
| start 失败 | 明确错误；排队首轮被 settle（不卡 streaming） | start.catch 分支 |
| prompt 失败（同会话） | 重试一次后 settle，error 写回本会话 | promptBtwTurn attempt 上限 1 |
| prompt 失败（跨会话 late） | 完全丢弃 | 身份守卫 `!active \|\| btwId !== sessionBtwId` |
| abort | 主进程 clearQueue+abort+settle；renderer streaming=false | btwAbort |
| abort 极端失败 | 主进程仍 settle；renderer 另有 10min 超时兜底 | settleBtwTurn + isStreamingStalled |
| 切任务 / 删任务 / 回首页 | 自动销毁，不漂移不恢复 | destroyIfParentChanged（activeTaskId 变化触发） |
| renderer reload / 窗口销毁 | 会话孤儿 → keepalive 停止 → 90s TTL 回收 | 主进程 prune；上限 5 兜底 |
| 应用退出 | 全部释放 | disposeAllBtwSessions（AgentService.dispose） |
| 会话数超上限 | 拒绝新建（明确错误） | canStartBtwSession（BTW_MAX_SESSIONS=5） |

## 5. 多窗口语义

- 每个 renderer 独立 btwStore；主进程 btwSessions 全局共享（跨窗口）。
- **btwId 全局唯一**（时间戳+计数器+随机段）：窗口 A 的会话不会被窗口 B 的
  start/keepalive/patch 误命中。
- btw:event 广播到所有窗口，非 owner 窗口按 btwId 不匹配丢弃（幂等路由）。
- 会话上限为全局硬闸门（防泄漏）；owner→webContents 映射**不引入**：
  全局唯一 id + 90s TTL + 上限 5 已保证有界、不串会话、不泄漏。

## 6. 带回主线

- 本地结构化整理（最后问题 + 最后一条已完成回答，答案 ≤1000 字截断），不做 LLM summarization。
- 只写入 composerDraft（已有草稿时以 `---` 分隔追加，绝不覆盖）；不自动发送。
- 幂等：同一轮结论只带回一次（lastBringBackUserMsgId 键）；新一轮完成后可再次带回。
- streaming 未完成轮次不参与。

## 7. 测试与守卫

- `test:btw`（btw-isolation-test）：行为级——隔离、竞态、排队、幂等、超时、id 唯一性。
- `test:btw-arch`（btw-architecture-test）：通道隔离 + 源码级红线扫描 + 发送路由/身份守卫/生命周期字段断言。
