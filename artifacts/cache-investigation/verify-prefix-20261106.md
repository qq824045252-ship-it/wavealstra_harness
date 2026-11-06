# 独立复核：缓存前缀修复、审计数字与根因证据

复核时间：2026-11-06 10:19–10:25（Asia/Shanghai）
复核人：Lead（原 verifier 子代理启动失败，改由 Lead 直接执行全部命令；不采信队友自报数字，以下均为本机实跑结果）
复核对象：task-1（tracer boundary 修复）、task-2（修正版审计脚本）、task-3（根因调查）

## 结论

**可交付。** 5 项门禁 PASS、23 项审计自检 PASS、修复归因实验完成。两个附带发现（`test:durable-bot` 在 HEAD 就失败；工作区存在他人未提交改动）已隔离，不属于本次修复。

## 1. 代码与门禁（亲自实跑，非转述）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `pnpm -s typecheck` | PASS（web/node 工程 + `[typecheck-scripts] 新增 0`） |
| 追踪契约 | `pnpm -s test:cache-request-trace` | PASS，14 段断言全过；新增 4 段：Durable stream/compact 记录且不共链、未认领请求保持 unbound、压缩恢复隔离、body-unobservable 不消费流、真实双钩子端到端 |
| 边界矩阵 | `pnpm -s test:cache-boundary-matrix` | PASS，9 scenarios；compaction 仍按既有契约 1 次断裂（预期） |
| 原生路径回归 | `pnpm -s test:context-ledger` | PASS，8 段；证明 boundary 优先级改动没破坏 AsyncLocalStorage 原生链 |
| MCP 段稳定性 | `pnpm -s test:mcp-section-stability` | PASS 5/5，`networkRequests=0` |

读 diff 结论：Durable 的 boundary 通过 `WeakMap<AbortSignal, () => CacheTraceBoundary>` 注册，`guarded()` 里显式 `invocation?.boundary ?? requestTraceBoundary(options?.signal)`，原生会话优先；`operation` 归一化同时用于记录与 chain key；http body 只做 `instanceof` 类型判定，未读取/tee。未发现阻塞性缺陷。

## 2. 审计脚本独立复跑

`node scripts/cache-prefix-audit.mjs --selfcheck` → **23 项全过，0 硬失败**。关键数字核对（本机输出）：

| 项 | 期望 | 实测 | 判定 |
|---|---|---|---|
| T01 基线 | 7（developer 5 / user 2） | 7 | PASS |
| T02 时间戳 | 566393c3 12:18:40、215c8360 15:04:18，均 +175 | 12:18:40.680（23571→23746）、15:04:18.911（13090→13265） | PASS |
| T04 抖动 | 全库唯一 ±14 对，约 8 秒 | 1 对，gap 7875 ms | PASS |
| T07 | 14 唯一 / 28 行 | 同 | PASS |
| T08 | 90 / 159 / 32 | 90 pick 链首 / 159 行 / 124 任一行为首 / 32 | PASS（口径已拆开） |
| T09 | null 14；无 items 80 行 | 14；80 行（provider 46 + http 34）/ 80 唯一 | PASS |
| T18 | 201c0806 input=30057 | 同，11-06 为 0 | PASS |
| 11-06 缺口 | 742/746（报告快照） | 742/746；实时 900/904 | PASS |
| 3c4eefc4 | +58、hitRate 1.21%、op=null 仍报出 | 09:10:31.070、+58、1.207% | PASS |

## 3. 根因证据抽查

- **+175（proven）**：由会话 JSONL 的 `role=system.sections` 重放，`mcp_servers` 295→470 字节（+175），重放 `items[0]` 23571→23746 / 13090→13265 与 tracer 逐字节闭合；变化文字为 WaveAlstra-ERP 自述首行。该项对应 Pi 的 `serverSummary` 实时 `connection.instructions` 回退，已由 `d2ad724` 修复，本次回归 5/5。
- **1a9e5385 / 9a8cc082**：压缩条目 summary 字节数 9737 与 delta +9737 精确相等，判定"压缩边界，不该修"成立。
- **±14 / −132 / +58**：分别 maintain `unresolved / inferred / inferred`，未发现被包装成 proven 的表述。根因报告明确写了关闭条件（F1 段级指纹、F3 Durable 冻结）。

## 4. 回归风险与工作区纪律

- `git status --short`：本次只动 4 个文件（`CacheRequestTracer.ts`、`ModelInvocationAdmission.ts`、`durable/DurableBotRuntime.ts`、`scripts/cache-request-trace-test.ts`）+ 新增 `scripts/cache-prefix-audit.mjs` 与 3 个产物目录/文件。其余 M/?? 项是用户或其他并行会话的改动（`AgentService.ts`、`DurableSubagents.ts`、`write-conflict.ts` 等），未被触碰。
- `~/.mybuddy/logs`：只有运行中的应用在写（`cache-requests-20261106.log` 仍在增长）；`plugins/mcp/mcp.json` 未被写（mtime 早于本次会话）。
- 未执行 build / pack / dev / commit / push。

## 5. 附带发现

1. **`pnpm -s test:durable-bot` 失败（`snapshot.busy` 断言 true!==false），与本次修复无关（已归因）。**
   归因实验：把本次 3 个 src 文件用 `git checkout --` 临时回退到 HEAD（其余保持），同一断言在同一 bundle 位置（9538）以同样方式失败；随后已从 `out/diagnostics/attribution-20261106-101930/` 恢复，`git diff --stat` 一致。`scripts/test-baseline.json` 的 `knownFailing` 为空，说明该失败是 HEAD 上的**既存回归**，疑似来自已提交 `6f0ec61`（durable 生成速度统计），建议由该提交负责人单独修，不计入本次门禁。
2. 原 verifier 子代理创建后未产出即失败；本文件即补位的复核记录。

## 6. 可交付判定

**PASS**。代码修复、审计脚本、根因报告三件产物均通过独立复跑；唯一失败项已证明为 HEAD 既存问题且不在本次改动面内。
