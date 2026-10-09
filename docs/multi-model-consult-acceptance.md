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

## 2026-10-09 变更：限制改为可配置、参与模型不设数量上限

上文的 2026-09-25 结论保持原样不改写；本节记录之后的一次变更。

### 改动内容

1. 参与模型数量不再有上限（原为 6）。`normalizeConsultConfig` 不再静默丢弃第 7 个及之后的参与者（旧行为在每次读盘/写盘都会丢，且没有任何提示）；运行时仍要求「至少 2 个不同模型」并继续拒绝重复 modelId。
2. 设置页「添加模型」下拉不再隐藏已选中的模型：候选为全部已启用模型，已添加项标为「（已添加）」并置灰；达到 6 个以上时下拉不再消失。重复选择由下拉 disabled 与 onChange 双重拦截，去重语义不变。
3. 每个参与模型的只读工具调用预算（原写死 24 次）改为设置项 `maxToolCalls`：可填 `1`–`100000`，填 `0` 表示不限制（此时只有超时或用户取消会停止该模型）。运行时校验、工具层错误与 worker 错误文案均使用该配置值。
4. 单模型超时上限由 1800 秒放宽到 86400 秒；并发上限独立为 `CONSULT_MAX_PARALLEL`（64），不再等同于参与模型数量上限。
5. 能力面板状态详情显示「已配置 N 个模型；只读工具预算 X；单模型超时 Y 秒」。
6. 兼容性：`schemaVersion` 保持 1（升版会让既有配置整体回落默认值）；旧配置缺少 `maxToolCalls` 时按默认 24 处理，行为与旧硬上限完全一致；`maxToolCalls: 0` 有专门分支，不会被钳制成 1。

### 本轮实际运行结果

- 会诊离线契约/安全/取消/持久化套件：**39/39 PASS**（`test:multi-model-consult`）。新增检查包括「参与者无上限且不丢尾部」「工具预算按用户值提前停止」「预算 0 不限制」「maxToolCalls 越界判为配置无效」「9 个模型全部完成」。
- `test:consult-selection`、`test:builtin-capabilities`、`pnpm -s typecheck`：通过。
- 真实 Electron 设置页/输入框回归（`test:consult-entry:desktop`，隔离配置、不发送模型消息）：**8/8 PASS**。新增用例实测 `candidates=8, added=8, selectableAfterRemove=1`：加满全部候选后下拉仍存在、已添加项全部置灰并带「（已添加）」，移除一个后该项重新可选。
  - 证据：`out/tests/consult-entry/built/results.json`。
  - 构建产物核验：`out/renderer` 与 `out/main` 均包含 `consult-tool-budget`、`（已添加）`、`maxToolCalls` 等新标记。

### 未包含 / 已知风险

- 本次**未**运行需要真实供应商的 `test:multi-model-consult:live`（产生真实用量与费用），因此没有 7 个以上模型的真实账单/限流验证。
- 参与模型无上限后，主模型会收到 N 份完整未截断答案，且 UI 进度快照每次整体克隆；建议单次会诊控制在 8 个模型以内，更大组合分两轮。`degraded`（仅一个成功）在时间线上仍显示为成功状态，需要看卡片文案区分。
- worker 会话仍关闭 compaction 与重试：把只读工具预算提到 100+ 时更可能先撞到模型上下文窗口，表现为「模型输出达到长度上限，答案不完整」。
- 同时运行的真实并发 session 数 = `min(最大并发, 参与模型数)`，目前没有跨调用的全局闸门。
- `pnpm -s test:all` 仍存在与本功能无关的既有失败（如 `test:subagent-mapper` 的 bash 危险命令判定、`test:memory-*`、`test:pi-*` 以及 `wave*-e2e` 300 秒超时，来自工作树中其它未提交改动）；本功能的 `test:multi-model-consult`、`test:consult-selection`、`test:consult-entry:desktop` 三项均通过。

### 本轮源码 SHA-256

- `src/main/capabilities/MultiModelConsult.ts`：`4464e597a249cd10d725b589cb7dd86b87fbd7ca0092b33d149e3252f0a09434`。
- `src/shared/multi-model-consult.ts`：`fe6b34e52e9f6807bf03a0b693f304bedd566797d974f959cd7878b5de7811b7`。
- `src/renderer/src/components/settings/MultiModelConsultSettings.tsx`：`4217bc2f77dbec5736f0bc4581036bc963c75e071df14f02a9bb9f159a8fab27`。
