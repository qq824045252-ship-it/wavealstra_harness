# 多模型会诊 · 实施与验收记录

## 最终结果

**PASS。** 以下是本次实际运行记录，不是预计结果。

完整真实模型/UI 测试时间：2026-09-25T00:26:48.688Z → 2026-09-25T00:30:30.115Z（UTC）。

- 新增会诊离线契约、安全、取消与持久化检查：**35/35**。
- 最终完整真实模型 / Electron UI 验收：**37/37**。
- 16 条测试命令全部通过，其中包含新增会诊测试和 15 条既有回归。
- 主进程/renderer 类型检查、远端类型检查、生产构建均通过。
- `git diff --check` 通过；源码文本使用 LF；未执行 Git commit。

## 真实模型与任务

主模型：`commandcode/deepseek/deepseek-v4.1-flash`。

会诊模型均由测试显式选择，使用 Pi 已有认证及原生 high 思考等级：
- `commandcode/deepseek/deepseek-v4.1-flash`
- `openai-codex/gpt-6-astra`

实际测试通过主界面输入框与加号菜单触发，没有用桩模型代替真实 Provider。代码 Review 读取的是本次真实源文件的字节一致副本，文件被放入隔离任务目录以避免影响日常项目。

| 场景 | 实际结果 |
|---|---|
| 普通问答 | 主模型真实回复 READY，没有被自动强制触发会诊。 |
| 代码 Review | 主模型显式调用一次；两个不同模型都实际 read 当前代码，返回各自原始答案。 |
| 非 Review 工程计算 | 两模型分别计算 Buck 输入总电流约 3.726 mA / 3.73 mA，均判断超过 3.5 mA；只做计算时 Worker 零工具调用。 |
| 模型部分失败 | 一个真实模型成功、另一个显式无效 ID 失败：报告为 degraded，保留原始错误，没有自动替换或假称完整会诊。 |
| 执行中取消 | 在真实模型读代码期间停止主任务，两个 Worker 都进入取消终态，没有后续答案变化。 |
| 状态与详情 | 会诊卡片独立于折叠执行日志显示；Tab 切换逐字匹配模型原文；420px 视口布局边界通过。 |
| 刷新恢复 | 页面刷新后从侧栏重开原任务，原始回答和工具记录恢复，逐字比对通过。 |
| 继续调查 | 只追加到主输入框，不自动发送、不恢复 Worker。 |
| 设置与输入框 | 本条标签发送后消失；未配置入口跳转工具能力；移除/重新添加模型、思考等级、超时编辑、保存均通过。 |

## 真实测试中发现并修复

1. 会话创建/模型请求挂起时取消无法及时返回：加入与真实取消信号竞争的有界等待，迟到会话只清理。
2. 清理或 UI 观察回调异常影响兄弟模型/结果返回：按 Worker 收敛并保留错误，清理失败不被伪装成正常完成。
3. 原生只读工具取消信号不完整：合并会诊与 SDK 信号，并在执行等待处处理取消。
4. 原始回答受通用工具预览长度截断：使用结构化 details，经实时 IPC 和 Pi 历史回放保留全文。
5. 上一轮 artifact 异步收尾借用了下一轮消息 ID：完成、失败及 artifact 归属固定到发起请求 ID；已结束回复不重复发送兜底 end。新增三项迟到收尾回归。
6. 超时字段逐键钳制导致多位数字难以输入：改为允许输入过程，在失焦和配置写入时校验。

既有 `user-prompt-display` 测试中三条旧断言与当前 Memory 来源证明设计冲突，已改为保留没有来源证明的用户原文，并补充显式引用标记过滤用例。没有重新引入按 Memory 标题删除文本的行为；架构与消息展示测试均通过。

## 失败记录与验收边界

首轮 Gemini 3.8 Flash 实际返回 HTTP 429 / RESOURCE_EXHAUSTED。产品正确输出部分失败/降级；该轮没有作为成功验收。之后仅在隔离测试配置中明确换用 GPT-6 Astra，完整成功链路才通过。产品本身没有自动模型替换。

中间测试暴露的刷新选择假设、CDP DOM 序列化及旧轮次事件归属问题均保留在历史报告目录，最终结果来自重新完整运行，不是拼接失败轮次或把失败改名为成功。

验收证明的是调用、原始结果、权限、状态、界面与持久化契约，不意味着多个模型的自然语言结论必然正确。少数意见、模型间分歧和待核验项仍需由主模型结合证据处理。

能力默认关闭、参与模型默认为空；没有修改用户日常模型选择或认证。启用并配置后在新会话使用；原来正在运行的安装包未被自动替换。

## 可复核文件

- 使用/架构说明：`docs/multi-model-consult.md`。
- 完整真实报告：`out/tests/multi-model-consult-live/report.json`。
- 验收摘要与清理/源文件核验：`out/consult-delivery-evidence.json`。
- 最终测试命令退出码：`out/consult-final-suite-status.txt`。
- 独立 UI 复测：`out/tests/multi-model-consult-ui-live/report.json`（7 项通过，与完整验收有重叠，不相加统计）。
- Gemini 429：`out/tests/multi-model-consult-live-gemini-429/report.json`。
- 主界面/详情/窄屏/设置截图：`out/tests/multi-model-consult-live/*.png`。

原始报告包含真实模型输出及实际工具记录，不含认证密钥。所有已记录隔离测试目录的临时认证副本均已删除，并检查实际路径已不存在。

### 验收读取的真实源文件 SHA-256

- `src/main/capabilities/MultiModelConsult.ts`：`1a3b84d71718db0af3bea403e8e0982cb05ef7d0c8541a484e8728d49d09abbf`。
- `src/shared/multi-model-consult.ts`：`1fa25582e7e449ec637e359f0f572289c4b94f8a5fb4d6d31c6b8ecbff42df6e`。

### 最终测试命令

```text
test:multi-model-consult=0
test:builtin-capabilities=0
test:architecture=0
test:streaming-send=0
test:session-history-recovery=0
test:timeline-focus=0
test:models-settings-overlay=0
test:subagent-model-ui=0
test:mcp-composer-focus=0
test:model-refresh=0
test:prompt-failure-recovery=0
test:session-lifecycle=0
test:prompt-submission=0
test:prompt-execution=0
test:native-surface=0
test:user-prompt-display=0
typecheck=0
remote:typecheck=0
git-diff-check=0
```
