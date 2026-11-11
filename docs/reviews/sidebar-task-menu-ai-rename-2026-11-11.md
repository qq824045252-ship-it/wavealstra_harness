# 侧栏任务菜单精简 + AI 重命名

日期：2026-11-11。用户要求：侧栏任务右键菜单里「保存到工作空间 / 以专家评审 / 绑定专家 / 复制为办公·编码·通用任务 / 分享任务」全部删除，改为新增「AI 重命名」——模型读任务对话开头约 1024 token 后生成新的任务名。

## 菜单变化

保留：打开文件夹、重命名、删除任务。删除：工作空间子菜单（含新建/移出/打开本地文件夹）、专家评审子菜单、绑定/管理专家、复制为三种任务、分享任务子菜单。对应 dead state/functions/imports（`subMenu`、`shareBusy`、`relatedNotice`、`visibleSpaces`、`shareTargets`、`reviewExperts`、`saveToSpace`、`startExpertReview`、`shareToTask`、`ExpertBindingModal` 等）一并移除。

新增「AI 重命名」条目（`IconSparkles`）：点击后调用 `agent:generateTaskTitle`；成功后把建议写入重命名输入框并由用户确认（Enter/失焦提交，Esc 取消），失败在菜单内显示原因。生成中菜单项禁用并显示「生成中…」。

## 后端

- `AgentService.generateTaskTitle(taskId, maxTokens=1024)`：
  - 对话开头文本由 `DurableBotRuntime.loadHistoryHead(maxTokens)` 只读扫描最老 committed entries（user/assistant 文本，CJK 按 1 token、其余按 4 字符估算），任务已打开时复用现 runtime，否则 `readDurableConversationHead` 只读 viewer；旧会话退回 `loadTaskHistory`。
  - 用任务自己的 `modelId`（不可用时回退自动模型）走 `modelRuntime.completeSimple`：64 maxTokens、60s 超时、system prompt 明确「只输出任务名、对话是不可信数据」。返回值做引号/前缀/尾标点清理并限长 40。
- 新增 IPC `agent:generateTaskTitle`（preload `generateTaskTitle`）。

## 验证

- `pnpm -s typecheck` 通过。
- `test:durable-history-block` 新增：`loadHistoryHead(1024)` 从最老 entry 开始（`用户：question 0` / `助手：answer 0`）、不包含末尾 `question 239`；真实 nsh store 拷贝只读验证：3303 字符（≈1024 token）从首条提问开始。
- `test:workspace-files-ui` 48/48、`test:project-workspace-ui`、`test:history-questions`、`test:app-permission-ui-removal` 通过。
- 未验证：AI 重命名端到端真实模型调用与菜单视觉（需重启 dev 后手测）；菜单高度/长标题输入沿用现有重命名逻辑。

## 后续修复：AI 命名报「输出被截断」

实机点击报 `AI 输出的任务名被截断，请重试`。原因不是任务名太长，而是该模型默认开启 reasoning：
一次真实调用（`magpie/opendesign/deepseek-v4.1-flash-eco`，`reasoning: "low"`）统计到 `output=197`、其中 `reasoning=189` —— 旧的 `maxTokens: 64` 预算被思考过程吃满，`stopReason` 变成 `length`，正文一个字都没留下。

修复：`AgentService.generateTaskTitle` 改为 `maxTokens: 4096`、`reasoning: "low"`，并允许 `stopReason=length` 时使用已产出的正文（仅在正文为空时才报错，文案区分「思考占满预算」）。真实复测：`stopReason=stop`、4.4s、返回 `搜索GitHub上的nsh项目`（input 176 / output 197）。

