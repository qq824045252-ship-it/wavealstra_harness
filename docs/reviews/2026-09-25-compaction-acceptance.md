# MyBuddy：Pi 原生压缩与双阈值验收

日期：2026-09-25。结论：本次限定范围验收通过。

## 范围与架构

实现设置页“比例 OR 绝对 token 阈值，先到者触发”，以及上下文用量弹窗的手动压缩、取消与结果显示。Pi 0.87.1 仍负责是否可压缩、摘要生成、近期消息保留、上下文投影、会话落盘和自动压缩恢复；没有修改 node_modules，没有自建摘要算法。

默认配置为比例 80%、绝对值 200,000 tokens；现有用户的比例值保留。绝对阈值可关闭（null），支持自定义与快捷值。1K=1000 tokens；统计的是当前会话上下文，不是累计输入/账单用量，也不是要求压缩到该大小。

实际触发线 = min(模型窗口 × 比例, 绝对阈值)。MyBuddy 将此换算为 Pi 的 reserveTokens，并同时覆盖当前模型的内存 modelOverrides，防止模型级设置覆盖产品阈值。保留 Pi 原有 enabled 和 keepRecentTokens；真实验收保持默认约 20K 的近期消息保留预算。

Pi 的原生比较为严格大于阈值，在模型/工具轮次等安全检查点执行；本功能不是瞬时硬性 token 上限。历史不足、刚完成压缩时由原生 API 返回无需压缩，不强行截断。

## 修复内容

1. **模型上下文与用户历史分离。** UI 使用 getBranch() 恢复完整当前分支；模型继续使用 Pi compact-aware projection。旧消息压缩后仍可查看，重开任务/冷启动不丢历史，也不会恢复其它废弃分支。分支、删除、重新生成使用相同的可见用户消息口径与真实 entry ID。
2. **手动压缩独占保护。** Pi compact() 自身会先 abort，因此主进程在调用前禁止正在执行、排队、审批、压缩中的任务，并在 await 前获取操作锁。压缩期间重复点击、发送、分支、重生成会被正确拒绝；取消只取消摘要，不把上一条已完成回复改成取消。冷会话通过既有 createSession 工厂恢复，缺失文件不创建空白替代会话。
3. **任务级状态。** compaction_start/end 在 assistantMessageId 过滤之前处理，手动压缩不污染上一条助手回复的生成状态。事件同步到 UI/远程投影；关闭弹窗后圆环仍提示正在压缩。
4. **真实测试发现并修复冷启动后的未知用量。** Pi 返回的 estimatedTokensAfter 作为同一上下文 leaf 的显示估算，明确标为“约”；新 leaf 不沿用旧估算，后续实际 native usage 优先。
5. **真实测试发现并修复自动压缩收尾期间发送被拒绝。** 可见回复完成不等于原生会话已 idle；自动压缩期间未指定行为的新消息使用既有 follow-up 排队链路。普通生成期间仍要求明确 streamingBehavior；手动压缩仍排他。没有自建新的队列或自动续跑机制。
6. **设置保存与说明。** 两个阈值一起保存，数值校验、实际触发线预览、低阈值提醒、失败反馈；上下文分类占比明确标注为 UI 历史估算，不能冒充实际模型请求构成。

## 真实任务验收

使用已安装并配置的真实模型 `commandcode/deepseek/deepseek-v4.1-flash`，窗口 1,000,000 tokens。通过生产 Electron 渲染器、preload、IPC 与 Pi provider 调用，实际点击设置、手动压缩、取消、分支和重生成。测试日志是专门生成的本地验收数据，由真实模型经原生工具读取；没有使用模拟模型替代此验收。

最终结果：**70 项检查全部通过**，rendererErrors=[]，测试进程关闭且隔离配置已清理。

| 真实场景 | 结果 |
|---|---|
| 实际文件写入、读取、核对与后续事实复述 | PASS |
| 手动压缩 | 74,590 → 约 9,210 tokens |
| 立即重复压缩 | 原生安全跳过，无多余摘要 |
| 重复调用、压缩期间发送/分支 | 正确拒绝；消息未意外写入会话 |
| 取消压缩 | 原会话 leaf 不变，原上下文保留 |
| 冷启动后手动压缩 | 54,776 → 约 9,561 tokens；用量立即刷新并标为估算 |
| 80% + 32K：绝对阈值先到 | PASS；1M × 80% = 800K，大于 32K |
| 10% + 200K：比例阈值先到 | PASS；1M × 10% = 100K，小于 200K |
| 自动压缩中/后连续提交下一任务 | PASS；日志核对任务完成 |
| 从已摘要化的旧消息点击创建分支 | PASS；等待后端只读预览确认 idle 后执行 |
| 分支实际续聊和重新生成 | PASS；仍能回答原始随机校准编号与主控 |
| 完整历史与 model context 分离 | UI 旧消息/entry ID 保留；原生模型上下文缩小 |

压缩后数值是 Pi 的 estimatedTokensAfter，不声称为供应商重新计量的精确账单 tokens。

## 回归与构建

15 组检查全部 PASS；生产构建 PASS；本轮相关文件 git diff --check PASS，全部 LF。

| 命令 | 结果 | 说明 |
|---|---|---|
| `typecheck` | PASS | 退出码 0；完整日志见下方目录 |
| `test:compaction` | PASS | 退出码 0；完整日志见下方目录 |
| `test:compaction-policy-history` | PASS | PASS all 13 policy/history checks |
| `test:session-history-recovery` | PASS | 退出码 0；完整日志见下方目录 |
| `test:conversation-branch:native` | PASS | conversation-branch-native: passed=7 failed=0 |
| `test:conversation-branch` | PASS | conversation-branch: passed=71 failed=0 |
| `test:conversation-branch-service` | PASS | conversation-branch-service: passed=73 failed=0 |
| `test:conversation-branch-ui` | PASS | conversation-branch-ui: passed=32 failed=0 |
| `test:conversation-branch:workspace` | PASS | conversation-branch-workspace: passed=18 failed=0 |
| `test:regenerate-lifecycle` | PASS | 退出码 0；完整日志见下方目录 |
| `test:regenerate-connection-runtime` | PASS | 退出码 0；完整日志见下方目录 |
| `test:regenerate-stop-runtime` | PASS | 退出码 0；完整日志见下方目录 |
| `test:models-settings-overlay` | PASS | 9/9 passed |
| `test:prompt-context` | PASS | ===== PromptContext: 35/35 通过 ===== |
| `test:architecture` | PASS | [architecture-test] passed=321 failed=0 |
| `pnpm build` | PASS | 生产 Electron 构建，日志保留 |

架构测试中的旧 mock 未提供现代码要求的 SessionManager，改为真实 Pi inMemory SessionManager；分支索引旧断言改为完整 UI 分支口径，同时断言模型投影仍被压缩。保持失败保护与分支边界断言，不通过削弱生产检查换取通过。

## 可追踪源码

- 双阈值纯函数：`src/shared/compaction-policy.ts:19`
- 手动压缩入口与冷恢复：`src/main/agent/AgentService.ts:3244`
- 自动压缩期间输入行为：`src/main/agent/PromptSubmissionCoordinator.ts:13`
- 任务级事件映射：`src/main/agent/SessionEventCoordinator.ts:128`
- 完整历史恢复：`src/main/agent/session-history.ts:164`
- 设置 UI：`src/renderer/src/components/settings/CompactionSettingsControl.tsx`
- 手动 UI：`src/renderer/src/components/chat/ManualCompactionControl.tsx`

## 复测命令与证据

`pnpm typecheck`

`pnpm test:compaction`

`pnpm test:compaction-policy-history`

`pnpm build`

`pnpm test:compaction:live`（使用当前已授权模型；真实 API 调用可能产生供应商用量费用。只使用自动创建的隔离测试配置。）

完整证据：

- `out/tests/compaction-acceptance.json`：验收结果、源码 SHA-256、构建/会话证据路径。
- `out/tests/compaction-regression/report.json`：15 组结果；同目录包含每组完整日志。
- `out/tests/compaction-live/report.json`：最终 70 项真实检查、实际模型响应、工具事件、前后 token 数。
- `out/tests/compaction-live/parent-session.jsonl`、`child-session.jsonl`：仅隔离验收对话，无测试配置凭据副本。
- `out/tests/compaction-live/*.png`：设置、压缩结果与分支重生成截图。
- `out/tests/compaction-live/report-attempt*.json`：先前失败记录保留，包括已修复的冷用量和自动压缩期间提交问题、一次上游 520 暂时不可用，以及测试脚本分支就绪/界面同步条件调整。
- `out/tests/compaction-build.log`：构建输出。

## 工作区与交付边界

基于原有 dirty 工作树增量修改，未撤销之前的分支实现，未提交 Git。基线 HEAD：`88d4f3328c7d153aaf000b8eb97df342be45a95f`。本次相关文本文件为 LF。未重启用户正在使用的正式实例；启动/关闭的是隔离测试 Electron。生产 build 已更新，但未制作安装包或声称发布新 release。

测试覆盖本次上下文压缩、设置、历史、分支/重生成和相关集成范围；不将此宣称为整个 MyBuddy 的无缺陷证明。
