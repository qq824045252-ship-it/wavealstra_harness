> Latest closure audit and actual long-history limits: [Issue #26 matrix](issue26-closure-matrix-20261112.md). A successful automatic-compression story is not proof that every closure requirement is complete.

# 自动上下文管理（billion-context / acp-kernel 原生接入）

对应 Issue #26。本文说明 Durable 主执行路径如何自动管理模型上下文、如何回查原文、如何持久化/恢复，以及当前已验证与未验证的边界。

## 后续安全复核（2026-11-12）

原实现复核发现 assistant ref 解析、持久提交失败、单条超长摘要输入、跨 head ref 重用和原文分页边界问题。修复、专项命令与验收状态见 [Issue #26 安全修复验收](issue26-safety-verification-20261112.md)。下文 Windows 数字是先前 fixture 记录，不代表最新 SHA 的真实模型/桌面或完整 issue 验收。1K/10K/100K 的测试仅模拟 refs 元数据，不能当作真实归档条目冷存储、RSS 或完整内核热态有界的证据。

## 1. 行为概览

- 默认自动运行（billion-context）：无需用户点击，达到产品阈值（窗口比例 0.8 与绝对阈值 200K 取先达到者，可在设置中修改）或内核增长建议时，历史被分层摘要折叠，最新任务与当前指令保留。
- 设置页「上下文管理方式」可切换：**分层摘要（billion-context）** 或 **按比例压缩（Pi 原生）**；切换后下一轮请求生效，无需重开会话。native 模式复用同一套比例/绝对阈值（`reserveTokens = 窗口 − 触发线`），但不再有 BC 投影、能力工具写入与原文按 ref 回查。
- “立即整理上下文”只是高级可选操作；没有可整理内容时返回 `skipped`，不伪报成功。
- 原文永不删除：Durable entry 仍是唯一事实源；摘要只替换**发送给模型的视图**。
- 模型可通过 `acp_search`（摘要/原文分开标注）、`acp_retrieve`（按 ref/block/entry 分页读原文）、`acp_status`、`acp_compress` 主动查询与整理。
- 设置页展示真实引擎（`billion-context` / `native`）、当前窗口、触发线与最近整理结果。

## 2. 代码落点

| 位置 | 责任 |
| --- | --- |
| `vendor/acp-kernel/` | 按固定 SHA `dc041dd1ab1a014efa352ba47a6f31fc47f55284`（kernel 0.0.195）入库的上游源码；`SOURCE.md` 记录来源与升级流程 |
| `src/main/agent/durable/context/DurableContextManager.ts` | 单 conversation 协调器：请求前投影、自动摘要、原生压缩协调、手动整理/取消、状态 |
| `.../DurableContextState.ts` | conversation-scoped `rewindable + asOf` 文档：内核 state、refs、摘要镜像、水位、代次 |
| `.../DurableContextTools.ts` | `acp_status` / `acp_search` / `acp_retrieve` / `acp_compress` |
| `.../CompactionPolicy.ts` | 产品阈值 → pi-durable `CompactionSettings`（`reserveTokens = window - triggerTokens`，`enabled:true` 保 overflow，`backgroundTokens:0`） |
| `src/main/agent/durable/DurableBotRuntime.ts` | `Harness.open(settings getter)`、beforeRequest 投影、beforeCompact 协调、工具注册、每个 conversation 一份协调器、状态/手动整理结果 |
| `src/main/agent/durable/DurableBotService.ts` | 注入产品阈值 getter、状态推送、`compact()` 真实结果、已打开运行时刷新 |
| `src/main/agent/AgentService.ts` | 设置变更热生效、手动压缩 completed/skipped 与真实前后 token、自动整理状态映射 |
| `src/shared/compaction.ts` / `src/shared/context-management.ts` | 状态 DTO（engine/tokensAfter/blocks/automatic/estimated）与上下文管理状态契约 |
| `CompactionSettingsControl` / `ManualCompactionControl` / `ContextUsageControl` / `SettingsModal` | 自动管理文案、引擎显示、skipped/估算口径、署名 |

## 3. 关键机制

1. **单一策略**：BC 健康时 `beforeCompact(reason=threshold)` 返回 `{decline:true}`，由请求前投影负责整理；原生 overflow 恢复保持开启，BC 用有界摘要接管其输入。
2. **有界兜底**：原生压缩选定前缀超过窗口预算时，宿主分块滚动摘要（实测 82K 输入 → 5 块，每块 ≤20.8K tokens），不会把整段 raw prefix 交给摘要模型。
3. **refs 身份**：内核 ref 定位 `e<entryId>:<slot>`，assistant content slot 使用 `.t` / `.cN` 后缀。原生边界变化只退役覆盖关系，保留 ref / block 分配高水位。已存在跨代次歧义的旧 ref 拒绝任意解析，须先检索明确 entryId。
4. **压力口径**：`max(最近 assistant usage, 逐条消息独立估算) + 工具 schema 估算`，避免复制历史里过期 usage 低估出站体积（分支首次请求已验证）。
5. **持久化节流**：摘要/边界变化立即落盘；普通轮次每 8 轮落盘一次，关闭前强制 flush（崩溃后 refs 可由消息顺序确定性重建）。refs 保留摘要覆盖 entry + 最近 2000 条，超过 20K 时裁剪。
6. **分支**：会话 fork/regenerate 通过 `asOf` 文档拿到锚点时的状态，不复制“现在”的摘要；独立新任务分支按复制后的可见历史确定性重建。
7. **覆盖范围**：主会话、Bot/Work、Gateway、辅助运行时、子代理、会诊各自持有独立 state；Code Mode 私有 conversation 不接管。

## 4. 命令

```bash
pnpm -s typecheck
pnpm -s test:durable-context-management      # 自动整理/原文回查/重启/设置生效
pnpm -s test:durable-context-branch-cancel   # 分支 as-of/取消/overflow 兜底/子会话/独立任务分支
pnpm -s test:durable-context-performance     # 合成 refs 元数据与活动视图测量，不是冷存储/RSS 验收
pnpm -s test:durable-context-safety          # 原文身份/提交故障/分块/分页/超限输入
pnpm -s test:durable-context-dev:live        # opt-in 真 Electron + 模型六类任务（需实机与本地模型网关）
pnpm -s test:durable-compaction-settings     # 阈值换算
pnpm -s test:compaction-settings-ui          # 设置页引擎切换/手动控件 skipped 文案（headless UI）
pnpm -s test:durable-bot
pnpm -s test:all
```

## 5. 已验证（本机，Windows）

- 自动整理：`90007 → 30204 tokens`，摘要标记出现、旧 marker 消失，后续轮次持续投影。
- 原文回查：真实执行 `acp_retrieve`，toolResult 逐字包含种子原句与细节，标注来源 entry；摘要不含这些细节。
- 重启恢复：同 options 重开，摘要继续生效，摘要模型调用增量 0。
- 设置生效：ratio 0.9 不整理 / ratio 0.2 自动整理；`triggerTokens` 与产品设置一致（128K 窗口 = 102400，非 native 111616）。
- 分支：会话 fork 后摘要按锚点重建（实测 `summariesBeforeFork=3` → fork 后仅 2 块且均 ≤ 锚点）；独立任务分支 `82038 → 12204 tokens` 且 refs 只引用自身 entry。
- 取消：手动整理取消后 `phase=cancelled`、`applied=false`、`skippedReason=已取消`。
- 子代理：独立 conversation `80000 → 22165 tokens`，拥有自己的摘要块。
- Code Mode：模型只看到 `codemode`，脚本内 `await tools.acp_status({})` 真实返回 `engine/triggerTokens`（摘要投影在 Code Mode 下同样生效）。
- 运行中改设置：同一会话 ratio 0.9（trigger 115200）→ 0.2（trigger 25600），下一轮即自动整理，无需重开会话。
- 多模型会诊：会诊 conversation `80000 → 22163 tokens`，自己的摘要块；与主会话/子代理互不共享 refs。
- 引擎切换：同一会话 `billion-context 22169 tokens → native 82024（完整历史）→ 切回 22203（摘要投影恢复）`，无需重开；native 下「立即整理上下文」走 Pi 原生路径（`engine=native, applied=true`），不伪报 BC。
- native 比例阈值：ratio=0.3（trigger 38400）下切换到 native 后的第一个请求可能沿用旧 usage 估算（BC 投影请求较小），第二次请求按真实 usage 触发 Pi 原生压缩，请求降到 60K 以下；超窗时仍有 Pi overflow 恢复兜底。
- native 压缩后切回 BC：按新 head 重建（实测 resumed=22112 tokens），不沿用旧 refs。
- 设置持久化：默认 `billion-context`，写入 `native` 后重启仍为 native，非法值回退默认。
- 设置页 UI（headless linkedom）：默认选中“分层摘要”、点击“按比例压缩”后保存会写入 `compactionEngine=native` 且保留阈值；重新加载回显 native，当前引擎显示 Pi 原生压缩；手动控件 skipped 显示“没有可整理的历史”、按钮文案“立即整理上下文”。
- 性能（headless fixture）：归档 1K/10K/100K 时请求准备 p50 = 1.62/1.82/1.36 ms（不随归档增长，`conversation.entries` 扫描 0 次）；活动视图 200/800/2000 条 p50 = 1.62/6.58/12.14 ms；100K refs 裁剪到 1899，state 文档 114KB。
- `pnpm -s test:all`：435 通过；15 个失败全部在 HEAD `7b11a2bd` 复现（Windows symlink/缺外部 CLI/既有断言/子进程 SIGABRT），非本次引入。

## 6. 未验证 / 已知限制

- **真实模型与 `pnpm dev` 桌面故事未执行**（连续长会话 → 自动压缩 → 原文回查 → 重启 → 继续）。真实 provider 的 overflow/usage 行为仍需实测。
- 请求准备仍是 O(活动视图)：每轮重建 CoreMessage 并跑内核完整管线（归档不影响，但活动视图 >2K 条时成本线性增长）；incremental/checkpoint 读取尚未实现。
- 独立任务分支是“按可见历史确定性重建”，不复制源分支摘要（首次请求会重新摘要一次，产生一次摘要模型成本）。
- 未覆盖：真实 GUI e2e（`durable-bot-desktop`）、打包产物 payload 校验、1K/10K/100K 归档下的 RSS/heap 峰值。
- 「立即压缩」已改名为「立即整理上下文」、「取消压缩」改为「取消整理」，并同步更新 `compaction-live-test.cjs` / `durable-bot-desktop-test.cjs` 的字符串断言；GUI 套件本轮未运行，需在实机验收时复跑。

## 7. 许可

acp-kernel 为 MIT + 附加署名条款；`docs/third-party/acp-kernel-NOTICE.md` 随安装包发布，关于页展示出处与两个上游链接。