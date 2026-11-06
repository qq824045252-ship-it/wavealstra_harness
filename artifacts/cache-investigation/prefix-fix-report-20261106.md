# 缓存前缀异常测试：修复报告（2026-11-06）

被复核对象：`缓存前缀异常测试_复核报告_20261106.md`（T01–T18 逐条复核）
本次范围：把复核报告里的规则缺口落成脚本；修掉让 11-06 变成"盲区"的追踪回归；把 T11–T14 根因调查从"需授权"推进到证据闭环。
仓库：`C:\Users\servi\Documents\GitHub\wavealstra_harness`（main，未提交、未打包）

---

## 0. 结论摘要

这次不是"再写一份报告"，而是三件事都落地了：

1. **修掉一个真实代码回归**：Durable 统一执行（commit `fb393b2`）之后，主任务模型调用全部丢了 `boundary`，11-06 的 904 条请求里 900 条没有 `boundary`，导致所有按 `op=stream` 的巡检"空过"。现已补上 signal-keyed 的 `CacheTraceBoundary`（`stream` 与 `compact` 分开成链），并有真实 Durable 端到端测试。
2. **把复核报告的规则落成可复跑脚本**：`scripts/cache-prefix-audit.mjs`（纯 Node、只读日志、无网络），23 项自检全过；11-05 的所有关键数字逐条复现；11-06 的 742/746 与 `3c4eefc4`（+58）都能报出。
3. **根因调查闭环**：`+175` 已用会话 JSONL 的 `system.sections` **明文重放**证明（不是"形态吻合"），确认早已由 `d2ad724` 修复；±14/−132/+58 三条给出了逐事件判定与证据等级，并明确了"不该修"的两类。

仍未闭合：±14（BTW 瞬时会话，unresolved）、−132（subagent，inferred）、+58（Durable 每轮重算，inferred）。关闭它们需要先补"系统提示段级指纹"（F1）与"Durable 提示冻结"（F3），见 §6。

![修复与验证链路](../../../Documents/GitHub/wavealstra_harness/diagrams/cache-prefix-fix-summary.svg)

---

## 1. 修了什么（代码，未提交）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `src/main/agent/ModelInvocationAdmission.ts` | 新增 `WeakMap<AbortSignal, () => CacheTraceBoundary>` + `setRequestTraceBoundary` / `requestTraceBoundary`；`guarded()` 改为 `invocation?.boundary ?? requestTraceBoundary(options?.signal)` | Durable 没有 `AgentSession`，但 Pi 把同一个 AbortSignal 传给钩子和请求；边界可以像 `modelRequestGuards` 一样按 signal 注册。原生会话的显式 boundary 仍优先，行为不变 |
| `src/main/agent/durable/DurableBotRuntime.ts` | `GenerationTask.beforeRequest` 注册 `stream`；新增 `CompactionTask.beforeCompact` 注册 `compact`；`completeSimple` 在无注册时兜底 `compact` | 生成只走 `streamSimple`（generation.js:549），压缩摘要是独立 `CompactionTask` 只走 `completeSimple`（compaction.js:133）。此前两者共用 `.../unbound` 链，compaction 与 stream 互为 previous |
| `src/main/agent/CacheRequestTracer.ts` | `operation` 归一化后同时用于记录与 chain key；http body 非字符串时标 `coverage:'body-unobservable'` + `bodyKind`（stream/blob/form-data/…），只做 `instanceof`，不读取/不 tee | 之前 http 记录 items 为空会被读成"没变化"；34 个请求因此丢了 `items[0].bytes`。现在审计侧可回退 provider，日志侧也说得清为什么不可观测 |
| `scripts/cache-request-trace-test.ts` | 新增 4 段断言：Durable stream/compact 记录且不共链；未认领请求保持 unbound；压缩恢复隔离；body-unobservable 不消费流；最后一段是真实双钩子 + 真实序列化 + 假 fetch 的端到端 | 让"boundary 存在且 operation 正确"成为可回归的行为契约，而不是靠人工看日志 |

复跑命令与实测结果：

```pwsh
pnpm -s typecheck                  # PASS，[typecheck-scripts] 新增 0
pnpm -s test:cache-request-trace   # PASS，14 段；新增 4 段全过
pnpm -s test:cache-boundary-matrix # PASS，9 scenarios（compaction 1 次断裂为预期契约）
pnpm -s test:context-ledger        # PASS，8 段（原生 admission 路径未回归）
pnpm -s test:mcp-section-stability # PASS 5/5，networkRequests=0
```

---

## 2. 审计脚本：把复核报告的"三处规则改动"落成事实

新增 `scripts/cache-prefix-audit.mjs`（1,195 行，`node:fs` 只读，无新依赖）：

```pwsh
node scripts/cache-prefix-audit.mjs --selfcheck
# 复现复核报告的 11-06 快照（742/746）：
node scripts/cache-prefix-audit.mjs --date 2026-11-06 `
  --cutoff "2026-11-06T09:34:32.023+08:00" --selfcheck
```

参数：`--dir`、`--json`、`--date`、`--cutoff`、`--mcp-json`、`--selfcheck`、`--quiet`；退出码 0 全过 / 1 自检硬失败 / 2 用法错误。

### 2.1 与复核报告一致的数（独立复跑）

| 项 | 复核报告 | 脚本实测 |
|---|---|---|
| T01 基线 | 7 条（5 系统提示 + 2 首条 user） | 7 唯一（developer 5 / user 2） |
| T02 时间戳 | 12:18:40 / 15:04:18，均 +175 | 12:18:40.680（23571→23746）、15:04:18.911（13090→13265） |
| T03 恢复率 | 97.156 / 65.346 / 94.698 | 同；另 99.241 / 86.287 / 97.661 |
| T04 抖动 | 全库唯一 ±14 对 | 1 对，gap **7875 ms** |
| T05 | 9 唯一 / 14 行 | 9 / 14；50.284% / 94.033% |
| T07 | 14 唯一 / 28 行 | 同；变化在 items[1] |
| T08 | 90 条（159 行） | 90 pick 链首 / 159 行 / 124 任一行为首 / 32 条 hitRate=0（三种口径拆开） |
| T09 | null 14；无 items 80 行 | 14；80 行（provider 46 + http 34）/ 80 唯一 |
| T10 | 34 个 http 空 items 回退 | 34/34 成功 |
| T18 | 201c0806 input=30057 唯一 | 同；11-06 为 0 |
| 11-06 缺口 | 742/746 无 boundary | 报告快照精确复现；实时已 900/904 |
| 11-06 异常 | 3c4eefc4 +58、1.21%、op 为空 | 09:10:31.070、+58、1.207%，在 T05 / unbound 旁证三处可见 |

### 2.2 脚本反过来纠正复核报告的 8 处

复核报告本身仍有与日志不符的地方，以脚本可复现结果为准（证据在 `artifacts/cache-investigation/prefix-audit-20261106/findings.md` §6）：

1. `usage.input=0` 的空记录：报告 9 条，实测 **14 条**（全部 outcome=error/aborted）。
2. T09 的"46 个请求"：46 是 **provider 行数**；唯一请求是 80。
3. T08 的"90/159"：是两个口径混写（pick 链首唯一 90；previous 缺失行 159；任一行为首唯一 124）；原报告的 121 = 124 − 3 条 hitRate=null，属第三种口径。
4. T03 的"b45b140e 无后续"：`b45b140e` 是 sessionHash；真正无后续的是链末请求 `1edf5161`。
5. 11-06 的 746/742 是时点快照，报告未标 cutoff；实时值随日志增长。
6. "29.4 MB" 是 MiB（11-05 六文件 23.95 MiB）。
7. mcp 描述 58/60 是**字符数**（UTF-8 字节 94/116），不影响 T15 结论。
8. "11-06 的 4 条 boundary 属当前 lead 会话"日志无法验证（只有 sessionHash，没有 UI/进程标识）。

---

## 3. 根因：+175 已证，另外三条分层

完整报告：`artifacts/cache-investigation/prefix-root-cause-20261106.md` + `.json`；链路图 `diagrams/prefix-break-chain.svg`、事件判定 `diagrams/prefix-event-timeline.svg`。

### 3.1 `items[0]` 是什么

不是"首条聊天消息"，而是**整段系统提示**：OpenAI Responses 序列化默认 `includeSystemPrompt=true`，系统提示进 `input[0] = {role:"developer", content:<全文>}`。所以系统提示任意位置变 1 字节，后面全部历史的前缀缓存都会断。

### 3.2 +175 = MCP 自述首行（proven）

- 会话 JSONL 把系统提示按 `sections` 持久化（`preamble/tools/rules/docs/addendum/project_context/skills/cwd/mcp_servers`），每段变化追加一条只含变化段的补丁。
- 566393c3：`sections.mcp_servers` 295 字符/295 字节 → 418 字符/470 字节（+175）；重放拼接后 `items[0].bytes` 23571→23746，与 tracer 逐字节相等。215c8360 同法 13090→13265。
- 变化的文字就是 WaveAlstra-ERP 的实时自述首行：
  `先 erp_resources 看资源。常用 erp_list / erp_get / erp_create / erp_update / erp_delete / erp_action。目录外接口用 erp_call。写操作走现有业务服务。`
- 机制：Pi `serverSummary()` 在服务器没有静态 `description` 时回退读**实时** `connection.instructions`；MCP stdio 异步连接 → 首轮只有标题行 → 连上后长出这段 → 系统提示改写。已由 `d2ad724`（serverSummary 只读 config.description）修复；本次实跑 `test:mcp-section-stability` 5/5。
- 结论：复核报告 T13 假设（`serverSummary` 吃 description）**成立**；`mcp-cache.json` 不是上游（它是工具目录缓存，mtime 2026-09-24）。

### 3.3 不该修的两类（proven）

| 事件 | 判定 | 证据 |
|---|---|---|
| 1a9e5385 / 9a8cc082 | 压缩边界 | compaction 条目与请求同秒；`d84c543c.summary` 正好 9737 字节 = Δ+9737 |
| d8043128 / 5b600690 | 一次性 prompt 误报 | `op=prompt`、`inputCount=1`、`items[0].role=user`，与 stream 主链不同请求形态 |

T06 的正确排除条件是 `op=prompt AND (inputCount=1 OR items[0].role=user)`；`fields.tools` 缺失会命中 37 行，不能用作判据。

### 3.4 仍分歧的三条

| 事件 | 结论 | 等级 | 关闭条件 |
|---|---|---|---|
| 6e8aaed3 −14 → 604f4eba +14（16:43） | 同一 user 轮内 A→B→A 可逆抖动；BTW 瞬时会话不落盘，明文不可得；已排除 ERP 175 路径（当时 5 台 working 服务器都有 description） | unresolved | F1 段级指纹落地后，同类事件直接读出 `changedSections` |
| 1edf5161 −132（15:01，subagent） | 同一 user 轮内缩短，无合法边界；subagent 会话不落盘 | inferred | F1 + 子代理会话至少保留段级指纹 |
| 3c4eefc4 +58（11-06 09:10，Durable） | Durable 每次生成重算 `botInstructions`（`AgentService.ts:1337-1349`）；assembly 已证未变（50 个快照 `assembly_hash` 恒定），变化只能落在每轮重算的 `## Skills` 列表 | inferred | F3：skills 列表并入 `durableAssembly` 版本键或搬进 `assembly.segments` |

---

## 4. 验证（Lead 亲自实跑，非队友自报）

| 检查 | 结果 |
|---|---|
| `pnpm -s typecheck` | PASS，新增 0 |
| `pnpm -s test:cache-request-trace` | PASS，14 段（含 4 段新增） |
| `pnpm -s test:cache-boundary-matrix` | PASS，9 scenarios |
| `pnpm -s test:context-ledger` | PASS，8 段 |
| `pnpm -s test:mcp-section-stability` | PASS 5/5 |
| `node scripts/cache-prefix-audit.mjs --selfcheck` | PASS 23/23，0 硬失败 |
| 归因实验 | `test:durable-bot` 失败与本修复无关：临时 `git checkout --` 回退本次 3 个 src 文件后，同一断言（busy true!==false）同样失败；已从备份恢复 |

**附带发现（不属于本次修复）**：`test:durable-bot` 在 HEAD 上就失败，而 `scripts/test-baseline.json` 的 `knownFailing` 为空——说明是**已提交的既存回归**，疑似来自 `6f0ec61`（durable 生成速度统计）。需要该提交负责人单独处理，不要记到本次修复账上。

详细复核记录：`artifacts/cache-investigation/verify-prefix-20261106.md`。

---

## 5. 产物清单

代码（未提交）：
- `src/main/agent/CacheRequestTracer.ts`
- `src/main/agent/ModelInvocationAdmission.ts`
- `src/main/agent/durable/DurableBotRuntime.ts`
- `scripts/cache-request-trace-test.ts`

工具与证据：
- `scripts/cache-prefix-audit.mjs`（可复跑审计）
- `artifacts/cache-investigation/prefix-audit-20261106/{facts.json, findings.md}`
- `artifacts/cache-investigation/prefix-root-cause-20261106.{md,json}`
- `artifacts/cache-investigation/verify-prefix-20261106.md`
- `diagrams/cache-prefix-fix-summary.svg`、`diagrams/prefix-break-chain.svg`、`diagrams/prefix-event-timeline.svg`

纪律：日志与 `plugins/mcp/mcp.json` 只读，未写入；未 build / pack / dev / commit / push。工作区里 `AgentService.ts`、`DurableSubagents.ts`、`write-conflict.ts` 等改动属于用户并行会话，未触碰。

---

## 6. 下一步（按性价比排序）

| # | 动作 | 收益 | 风险/代价 |
|---|---|---|---|
| F1 | 追踪记录里加"系统提示段级指纹"：`systemSections{name:bytes,hash}` + `previous.changedSections`（只存段名/字节/hash，不存明文；Pi 会话 branch 里的 `SystemMessage.sections` 可直接取） | ±14 / −132 这类"看不到哪段变"的问题当场可定性；未来异常不用再靠明文 dump | 低；需要改 tracer 的比较链，注意日志体积 |
| F2 | 把 `test:mcp-section-stability` 的反向断言固化（回退未打补丁的 `node_modules` 实现时用例必须失败） | 防 Pi 升级后补丁静默失效，+175 不会"复发" | 低；CI 需造一个未打补丁的导入路径 |
| F3 | Durable 系统提示冻结：`resolveSkillsForContext` 结果并入 `durableAssembly` key（或搬进 `assembly.segments`），让变化显式触发新 assembly | 消除 +58 这一类"每轮重算技能列表"导致的漂移 | 中；技能在会话中途启用的语义要重新确认，需回归 `test:durable-bot` / `test:subagent-*` |
| 其他 | `drawio-ai`/`rea` 等无 `modes` 字段的服务器；界面改 MCP 是否保留手写 `description` | 防止 +175 机制换入口复发 | 低；配置/回归各一条 |

---

## 7. 本次仍未验证 / 不能声称的部分

- 修复后的新构建没有在**真实运行中的 MyBuddy** 里重放一遍（用户要求不 build、不打包、不重启）；本报告的验证是类型检查 + 测试 + 日志只读复跑。新构建启动后，11-06 之后的新日志应带 `boundary.operation`，可用 `node scripts/cache-prefix-audit.mjs` 直接复核。
- ±14 / −132 / +58 的具体文本没有拿到，仍维持 unresolved / inferred；不要把它们写成"已修复"。
- 11-06 的数字随日志增长变化，引用时必须带 `generatedAt` 或 `--cutoff`。
- 环境里存在用户并行改动与并行提交（`6f0ec61`、`decb767`），本报告只对上述 4 个代码文件与新增脚本/产物负责。
