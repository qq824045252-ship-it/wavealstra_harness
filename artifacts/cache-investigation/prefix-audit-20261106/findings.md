# 缓存前缀巡检 T01–T18：脚本化复跑与数字核对

- 生成时间：2026-11-06T02:12:55.452Z（Asia/Shanghai 10:12:55，即 facts.json 的 `generatedAt`）
- 审计脚本：[`scripts/cache-prefix-audit.mjs`](../../../scripts/cache-prefix-audit.mjs)（纯 Node，只读日志，无网络、无凭据）
- 机器结果：[`facts.json`](facts.json)（含全部中间结果、逐请求行、自检表）
- 输入：`~/.mybuddy/logs/cache-requests-2026110{5,6}*.log`，8 个文件 / 32,230,741 字节（30.74 MiB）
- 规则来源：`缓存前缀异常测试_复核报告_20261106.md` 第 131–169 行"三处规则改动"，以及任务 task-2 的验收清单
- 本文所有数字均取自 facts.json 与脚本自检输出，未手工改动；11-06 为实时快照（日志仍在追加），报告口径的快照另见 §2.3

## 0. 结论摘要

1. 复核报告给出的"取数 / 前置过滤 / T04 抖动 / T05 阈值 / T06 排除 / T10 回退 / T18 判据"已全部落成脚本，**23 项自检全部通过**（0 硬失败、0 提示项）。
2. 11-05 的稳定数字**逐条复现**：T01=7（developer 5 / user 2）、T02 两次 +175 的真实时间戳、T03 六条恢复率、T04 全库唯一 ±14 对（7875 ms）、T05 14 行 / 9 唯一、T07 28 行 / 14 唯一、T08 90 唯一 / 159 行 / 32 条 hitRate=0、T09 14 条 null 命中率、T10 34/34 回退成功、T18 命中 1 条。
3. 11-06 的缺口成立且更严重：**报告快照 742/746 行无 boundary**（可精确复现），实时已增长到 **900/904**；4 行带 boundary 全部落在进程 epoch `6b89f1db`（08:20:10–08:20:13），其后的 3 个 epoch（`4017aeb9` 684 行、`fd5605de` 200 行、`09f66d38` 16 行）**一条 boundary 都没有**。因此 11-06 的 T01/T02 标"不可判（无 boundary）"，不计为通过。
4. 11-06 唯一断裂异常 `3c4eefc4`（09:10:31.070，items[0] 5140→5198 / +58，hitRate 1.207%）在不受 op 过滤影响的口径下被报出（`T05` 与 `T02.unboundSupplement`、`T03.unboundRecovery` 三处可见）。
5. 复核报告自身仍有 **8 处需要修正（D1–D8，见 §6）**：4 处数字/口径（usage.input=0 的"9 条"实为 14 条、T09 的"46 个请求"实为 46 个 provider 行、T08 的"90/159"未写明去重口径、11-06 的 4 条 boundary 归属无法验证），4 处表述/单位（T03 的 b45b140e 是 sessionHash 而非 request、746/742 是时点快照、报告"MB"实为 MiB、mcp 描述长度是字符数）。

## 1. 复跑方式

```pwsh
# 全量复跑（实时快照），写默认 facts.json，并逐条核对验收数字
node scripts/cache-prefix-audit.mjs --selfcheck

# 复现复核报告的 11-06 时点快照（742/746）
node scripts/cache-prefix-audit.mjs --date 2026-11-06 `
  --cutoff "2026-11-06T09:34:32.023+08:00" `
  --json artifacts/cache-investigation/prefix-audit-20261106/facts.json --selfcheck
```

- 退出码：0 = 自检全过；1 = `--selfcheck` 有硬失败；2 = 用法/输入错误。
- 可用参数：`--dir`、`--json`、`--date`、`--cutoff`、`--mcp-json`、`--selfcheck`、`--quiet`。
- 脚本对外只做只读：日志与 `mcp.json` 均已 `readFileSync` 打开，未写入 `logs` / `plugins` / `src`，未引入依赖。

## 2. 采样与事件对账

### 2.1 按日期（实时快照）

| 日期 | 文件 | 字节 | request 行 | 唯一 request | result 行 | http-result 行 | 缺 boundary 行 / 唯一 | op 分布 |
|---|---|---|---|---|---|---|---|---|
| 11-05 | 6 | 25,114,902（23.95 MiB） | 2091 | 1134 | 1133 | 957 | 0 / 0 | stream 2054、prompt 37 |
| 11-06 | 2 | 7,115,839（6.79 MiB） | 904 | 452 | 452 | 452 | **900 / 450** | stream 2、prompt 2、缺 boundary 900 |

- 全库：request 2995 行 / 唯一 1586；result 1585；http-result 1409；另 `started` 450、`execution` 434、`first-response` 442（只计数，不参与判定）。
- 重复请求行（同 `(epoch, request, stage, attempt)`）：0；JSON 解析失败行：0；`previous.prefix=false & sharedItems=0` 但缺 `firstDifference` 的异常：0。

### 2.2 逐文件

| 文件 | 字节 | mtime (UTC) | request | result | http-result |
|---|---|---|---|---|---|
| cache-requests-20261105-6.log | 4,189,394 | 2026-11-05T04:14:42.764Z | 374 | 261 | 111 |
| cache-requests-20261105-7.log | 4,185,329 | 2026-11-05T05:13:34.857Z | 519 | 270 | 247 |
| cache-requests-20261105-8.log | 4,187,028 | 2026-11-05T07:20:40.849Z | 368 | 186 | 184 |
| cache-requests-20261105-9.log | 4,185,684 | 2026-11-05T08:11:05.162Z | 158 | 79 | 79 |
| cache-requests-20261105-10.log | 4,190,284 | 2026-11-05T08:26:48.641Z | 348 | 175 | 174 |
| cache-requests-20261105-11.log | 4,177,183 | 2026-11-05T08:44:12.052Z | 324 | 162 | 162 |
| cache-requests-20261106-1.log | 4,174,298 | 2026-11-06T01:16:27.479Z | 640 | 320 | 320 |
| cache-requests-20261106.log | 2,941,541 | 2026-11-06T02:09:34.039Z | 264 | 132 | 132 |

> 报告里的"11-05 24.0 MB / 合计 29.4 MB"是 MiB 口径（11-05 实测 23.95 MiB）。11-06 文件在此后继续追加，所以实时总字节（30.74 MiB）比报告时点大。

### 2.3 报告快照：11-06 742/746 的复现口径

脚本在实时运行里用固定 cutoff `2026-11-06T09:34:32.023+08:00` 对同一份读取结果再切一刀（`facts.reportSnapshot`）：

| 口径 | request 行 | 唯一 request | 无 boundary 行 | 带 boundary 行 |
|---|---|---|---|---|
| 报告快照（≤ 09:34:32.023） | 746 | 373 | **742** | 4 |
| 实时（截至本 facts.json） | 904 | 452 | 900 | 4 |

11-06 的 boundary 只在 epoch `6b89f1db`（00:20:10–00:20:13 UTC，即 08:20 本地）出现过 4 行 / 2 个请求；之后：

| epoch | request 行 | 唯一 request | 带 boundary 行 | 时间窗（UTC） |
|---|---|---|---|---|
| 6b89f1db | 4 | 2 | 4 | 00:20:10–00:20:13 |
| 4017aeb9 | 684 | 342 | 0 | 00:26:22–01:19:32 |
| fd5605de | 200 | 100 | 0 | 01:30:18–01:48:15 |
| 09f66d38 | 16 | 8 | 0 | 01:54:27–02:09:08 |

带 boundary 的 4 行对应 2 个请求：`aea0cfe3`（op=stream）与 `1315027e`（op=prompt），都在 session `cf8f75f1…`。报告称这 4 条属于"当前 lead 会话"，日志只能给出 sessionHash，无法验证归属（见 §6-D8）。

## 3. 规则落地对照（复核报告 131–169 行 → 脚本实现）

| 规则 | 脚本实现 | 说明 |
|---|---|---|
| 三类事件解析 | `readEvents` + `indexEvents` | request 按 `(epoch, request, stage, attempt)` 入表；result 取最后一条非 null hitRate；http-result 只取 status |
| pick(request) | `pickRow` | http items 非空 → http；否则 provider items 非空 → provider；否则第一条；`http-empty-items->provider` 单列计数 |
| 缺 boundary 告警 | `snapshotByDate` / `buildViews.flags` | 行数与唯一数都计，`missing-boundary` 进入 flags，不静默丢弃 |
| hitRate=null 跳过 | `buildViews`（`hitrate-null`）+ 自检 S13 | 最后一条 hitRate=null 的 result 不进命中率统计 |
| usage.input=0 排除 | `empty-usage` flag + T18 前置过滤 | 11-05 实际 14 条（报告写 9 条，见 §6-D1） |
| http-result 异常 | `transport-anomaly` flag（有 http-result 且 status!=200） | 11-05 的 14 条 null 里 4 条命中该口径：1 条 503 + 3 条无 status |
| T04 抖动 | `collectFlapping` | 同 session 内相邻两条断裂事件 `delta(a) = -delta(b)` 且非零；两边都进报告 |
| T05 阈值 | `breakRows` + role 分档 | 不用 hitRate<0.5；按 `items[0].role` 分 developer/user，hitRate 只排序分档 |
| T06 排除 | `t06Excluded` | `op=prompt 且 (inputCount=1 或 items[0].role=user)`；不用 `fields.tools` 缺失判 |
| T10 取数 | `pickRow` + `T10.pickStats` | http 缺失或 items 为空都回退 provider；34 个回退全部成功 |
| T18 判据 | `buildChecks` 中 T18 段 | 同 `(epoch, sessionHash)` 相邻请求五元指纹全同 + cacheRead=0 + input>0 |
| 无 boundary 日期 | `byDate[date].T01/T02.verdict` | 标"不可判（无 boundary）"，另给不受 op 过滤影响的 `unboundSupplement` |

## 4. 验收数字对照

| 项 | 任务/复核报告给出的值 | 脚本结果（facts.json） | 判定 |
|---|---|---|---|
| T01 基线 | 7 条（5 系统提示 + 2 首条 user） | 11-05：7 唯一（developer 5 / user 2） | 复现 |
| T02 时间戳 | 566393c3 12:18:40、215c8360 15:04:18，均 +175 | 566393c3 12:18:40.680（23571→23746）、215c8360 15:04:18.911（13090→13265） | 复现 |
| T03 主三条 | 97.156% / 65.346% / 94.698%，b45b140e 无后续 | 566393c3→`aadc99bc` 97.156%；215c8360→`f293506e` 65.346%；6e8aaed3→`d6607687` 94.698%；`1edf5161`（session b45b140e…）无后续 | 复现（b45b140e 是 sessionHash，见 §6-D4） |
| T03 补充三条 | 1a9e5385→99.241%、9a8cc082→86.287%、604f4eba→97.661% | 1a9e5385→`e2ec51c3` 99.241%；9a8cc082→`227095ad` 86.287%；604f4eba→`663652db` 97.661% | 复现 |
| T04 | 全库唯一 ±14 对，同 session，间隔 8 秒 | 1 对：6e8aaed3(−14) → 604f4eba(+14)，session `3894a8e2…`，gap **7875 ms** | 复现 |
| T05 | 9 唯一（14 行）；1a9e5385=50.28%、604f4eba=94.03% | 9 唯一 / 14 行；50.284% / 94.033%；developer 5 / user 4（T06 排除前） | 复现 |
| T06 | `op=prompt 且 (ic=1 或 items[0].role=user)` → 排除 | 排除 d8043128、5b600690；11-05 prompt 行 37（20 唯一），ic=1 3 行、items[0].role=user 3 行；按 tools 缺失会命中 37 行（不能用作判据） | 复现 |
| T07 | 14 唯一 / 28 行，全 prompt、ic=2、items[0] 4133→4133 | 14 / 28；allPrompt、allIc2、items[0] delta 全 0，变化在 items[1]（firstDifference.index=1） | 复现 |
| T08 | 唯一首请求 90 条（159 行），hitRate=0 恰好 32 | pick 行链首 90 唯一（provider 首行同为 90）；previous 缺失行 **159**；任一行为首唯一 **124**；hitRate=0 **32** | 复现（三种口径见 §5.2） |
| T09 | hitRate=null result 14 条；无 items 80 行 / 46 个请求 | 14 条（传输异常 4 + 无 http-result 7 + 200 缺 usage 3）；无 items **80 行**（provider 46 + http 34）/ **唯一 80** | 行数复现；"46 个请求"不成立（§6-D2） |
| T10 | 1a9e5385 只有 provider 一条 | `stages=[provider]`（其余 6 条为 provider+http 两条） | 复现 |
| T10 回退 | 34 个 http items 为空的请求回退 provider 取到 items[0].bytes | 34/34 成功，失败 0 | 复现 |
| T15/T16/T17 | 9 服务器；5 个 working 未 disabled 全有 description；缺 modes=rea,github；Remote disabled | 9 服务器；working 5 个（缺 description 0）；缺 modes `[rea, github]`；disabled `[WaveAlstra-ERP-Remote]` | 复现 |
| T18 | 201c0806（12:17:20.355，input=30057）全库 1 条；11-06 为 0 | 1 条：201c0806，input=30057，cacheRead=0，hitRate 0；11-06 0 条 | 复现 |
| 11-06 缺口 | 742/746 request 无 boundary | 报告快照 742/746；实时 900/904（§2.3） | 复现（快照口径） |
| 11-06 唯一异常 | 3c4eefc4 09:10:31，+58，hitRate 1.21% | 09:10:31.070/114，5140→5198（+58），hitRate 1.207%，op=null | 复现 |
| T01/T02 @11-06 | 要求标"不可判（无 boundary）" | T01=不可判（无 boundary）、T02=不可判（无 boundary） | 复现 |

自检编号与上面一一对应：S01–S23（见 §9）。

## 5. 明细

### 5.1 断裂事件（11-05 共 9 个唯一请求 / 14 行；11-06 另 1 个）

| request | 时间（11-05） | op | items[0].role | items[0].bytes 变化 | hitRate | 后续命中率（同链下一请求） | 日志行 |
|---|---|---|---|---|---|---|---|
| 1a9e5385 | 11:56:51.217 | stream | user | 294→10031（+9737） | 50.284% | `e2ec51c3` 99.241%（+3995 ms） | 1 |
| 566393c3 | 12:18:40.680 | stream | developer | 23571→23746（**+175**） | 44.029% | `aadc99bc` 97.156%（+64580 ms） | 2 |
| 9a8cc082 | 12:39:48.868 | stream | user | 10031→22060（+12029） | 43.368% | `227095ad` 86.287%（+30411 ms） | 1 |
| d8043128 | 12:52:06.232 | prompt | user | 347→29144（+28797） | 0% | `5b600690` 0%（+201082 ms） | 1 |
| 5b600690 | 12:55:27.314 | prompt | user | 29144→16749（−12395） | 0% | 无后续 | 1 |
| 1edf5161 | 15:01:32.482 | stream | developer | 47005→46873（−132） | 0.919% | **无后续**（session `b45b140e…` 链末） | 2 |
| 215c8360 | 15:04:18.911 | stream | developer | 13090→13265（**+175**） | 7.11% | `f293506e` 65.346%（+6899 ms） | 2 |
| 6e8aaed3 | 16:43:19.306 | stream | developer | 48851→48837（−14） | 0% | `d6607687` 94.698%（+3084 ms） | 2 |
| 604f4eba | 16:43:27.181 | stream | developer | 48837→48851（+14） | 94.033% | `663652db` 97.661%（+4467 ms） | 2 |
| 3c4eefc4（11-06） | 09:10:31.070 | **null** | developer | 5140→5198（**+58**） | 1.207% | `bab965a7` 99.544%（+6419 ms） | 2 |

- d8043128 / 5b600690 被 T06 排除（prompt 族误报）；剔掉后 7 条 = T01 基线（developer 5 / user 2）。
- T05 分档（9 条）：hitRate=0 共 3 条，0<hitRate<0.5 共 4 条，0.5≤hitRate<0.9 共 1 条，hitRate≥0.9 共 1 条。
- 原报告 T01"4 条"可复现为 `hitRate∈(0,0.5)` 的 4 条（566393c3 44.029%、9a8cc082 43.368%、1edf5161 0.919%、215c8360 7.11%）——这正是被错误阈值筛出的残留，不作为基线。

### 5.2 T08 的三种口径（原报告 121 的由来）

| 口径 | request 行 | 唯一 request | hitRate=0 |
|---|---|---|---|
| previous 缺失的**行** | 159 | — | — |
| **任一行为首**的唯一 request | — | 124 | 32 |
| **pick 行（真正链首）**的唯一 request | — | 90 | 32 |

- 复核报告的"90 条（159 行）"= pick 行链首 90 唯一 + previous 缺失行 159；两者都对，但混在一句里容易被读成"90 个唯一、159 行"的同一集合。
- 原报告的"121 条"= 124 − 3（这 3 个唯一首请求的 hitRate 为 null：`934dcd40`、`cfce0b1d`、`cde290cb`）。所以 121 不是错误，只是**第三种口径**（任一行为首且 hitRate 非 null）；报告与复核都没写明口径 → 建议补口径（见 §7）。

### 5.3 T18 命中明细（全库唯一 1 条）

| 字段 | 值 |
|---|---|
| request | `201c0806-ac5d-46da-8d93-172e5011f057` |
| 请求时间 | 12:17:20.355（result 12:17:24.569） |
| 前一条同 session 请求 | `2942a896-1b1f-4f15-b1a9-acac7f665a04`（12:17:17.139） |
| items[0].bytes / hash | 23571 / `52aebb60b0d069141613f2cb8c81681f6b67b07e81c97bd2d44f82f39715379a` |
| prompt_cache_key | `9157f5616d1673db4ca5e5fa1373631974ddf57b0739436d1f0698fab232a7d6` |
| affinityHash / endpointHash | `0e967f07…` / `b971c13d…` |
| usage | input 30057、output 32、cacheRead **0**、cacheWrite 0 |
| hitRate | 0 |

- 判据前置过滤：`usage.input=0` 跳过（同 session 相邻对里 10 次命中该过滤）；无 items 指纹跳过 7 次。
- 11-06：0 条。

### 5.4 T10 取数分布（11-05，1134 个唯一请求）

| 取数来源 | 数量 |
|---|---|
| http（items 非空） | 924 |
| provider（无 http 记录） | 130 |
| first-row（http/provider 均无 items） | 46 |
| **http-items-empty → provider 回退** | **34** |

回退后 34/34 都取到了 `items[0].bytes`；**其中就包含 `9a8cc082`**（它的 http 行 items=0、previous 为空，正是报告"缺口二"举的例子，回退 provider 后取到 items[0]=22060）。

- 报告那句"1a9e5385 只有 provider 一条"已复现：它的 stages 只有 `provider`；其余 6 条 T01 基线请求都是 provider+http 两条。

### 5.5 mcp.json（T15–T17，只读结构字段）

| 服务器 | type | modes | disabled | description（字符/字节） |
|---|---|---|---|---|
| rea | stdio | **无** | false | 58 / 94 |
| drawio-ai | 隐式 stdio | working | false | 70 / 106 |
| penpot | 隐式 stdio | design | false | 60 / 94 |
| WaveAlstra-ERP | 隐式 stdio | working | false | 121 / 173 |
| slack | http | working | false | 93 / 93 |
| github | http | **无** | false | 60 / 116 |
| tencent-lighthouse | 隐式 stdio | working | false | 53 / 101 |
| cloudflare | http | working | false | 126 / 158 |
| WaveAlstra-ERP-Remote | http | working | **true** | 85 / 117 |

- T15 通过：modes 含 working 且未 disabled 的 5 个（drawio-ai / WaveAlstra-ERP / slack / tencent-lighthouse / cloudflare）全部有 description。
- T16 缺口确认：`rea`、`github` 没有 `modes` 字段。补充：`mcp.json` 里没有"是否启用"字段，启用与否由会话场景白名单决定，单列复核必须查运行时状态。
- T17 通过：`WaveAlstra-ERP-Remote` 因 `disabled=true` 被排除出 working 集合。
- 脚本只输出名称/type/modes/disabled/描述长度，**不输出 url、headers、env 与描述正文**（该文件含 Bearer/token 占位）。

## 6. 与复核报告仍有出入的地方（含证据）

> 原则：以脚本可复现结果为事实；下列每条都可用 `facts.json` 的对应字段复核。

**D1. usage.input=0 的空记录：报告 9 条，实测 14 条。**
证据：`checks.byDate['2026-11-05'].T09.emptyUsageResults = 14`，即 `result` 里最后一条 `usage.input=0` 的请求共 14 个，全部 `outcome ∈ {error, aborted}`（error 6 / aborted 8）、`usage` 全零、`reportedUsage` 缺失：`a0d58a5a、6d6737b6、c5b93e8d、e922c033、2f582c84、99776487、934dcd40、d3460311、f089011b、5dd6b64f、57298f54、2964473f、cde290cb、99998c52`。报告只写"9 条"，无法反推出是哪 9 条或额外的排除条件 → 列入 §7。

**D2. T09"80 行 / 46 个请求"：46 不是请求数，是 provider 行数。**
证据：`T09.noItemsRows = 80`、`T09.noItemsByStage = {provider: 46, http: 34}`、`T09.noItemsUnique = 80`。80 行分属 80 个不同请求（46 个请求缺 provider items、34 个请求缺 http items，两组不相交）。"46 个请求"应改写成"46 行（provider）+ 34 行（http）/ 80 个请求"。

**D3. T08"唯一首请求 90 条（159 行）"缺口径说明。**
证据：`T08.pickFirstUnique = 90`、`T08.rowsWithMissingPrevious = 159`、`T08.uniqueAnyRowFirst = 124`、`T08.hitRateZeroUnique = 32`。90 与 159 都对，但属于两套口径（pick 链首 vs 全行），且与"任一行为首 124"并列时会自相矛盾。建议表格里写明"行/唯一、按 pick 还是按任一 stage"。

**D4. T03 的"b45b140e 无后续"：b45b140e 是 sessionHash，不是 request id。**
证据：`T03.noFollowUp = [{event: 1edf5161…, sessionHash: b45b140eee51638e4e72643b833f1fa9be02e1dd77384058d1b50a0dd60c917e, op: stream}]`。该 session 在 11-05 15:01 段有多个请求（`aa521a7f` 15:01:12、`25e55003` 15:01:17、`8eb31f6a` 15:01:23、`1edf5161` 15:01:32…），所以"b45b140e 无后续"作为**会话**陈述不成立；成立的是"该链末请求 `1edf5161` 无后续"。结论对、表述要改。

**D5. "11-06 746 条 / 742 无 boundary"是时点快照，报告未标时点。**
证据：`reportSnapshot.byDate['2026-11-06'] = {requestRows: 746, requestRowsMissingBoundary: 742, requestRowsWithBoundary: 4}`（cutoff 09:34:32.023）；实时 `snapshot.byDate['2026-11-06'].requestRows = 904`、`requestRowsMissingBoundary = 900`。同一份日志在不同时刻跑会得到不同数字，建议报告记录 `cutoff` + 文件 size/mtime。

**D6. 体量数字单位：报告 29.4 MB 是 MiB。**
证据：11-05 六文件合计 25,114,902 B = 23.95 MiB（报告写 24.0 MB）；实时八文件 32,230,741 B = 30.74 MiB。

**D7. mcp.json 描述长度：报告的 58/60 是字符数。**
证据：`checks.mcp.servers` 里 `rea` = 58 字符 / 94 字节，`github` = 60 字符 / 116 字节。报告 D 组写"58 字节 / 60 字节"，差在 UTF-8 中文字符占 3 字节。不影响 T15 结论。

**D8. "11-06 的 4 条 boundary 属当前 lead 会话"无法从日志验证。**
证据：4 行 = 2 个请求（`aea0cfe3` op=stream、`1315027e` op=prompt），session `cf8f75f1…`，epoch `6b89f1db`，时间 08:20:10–08:20:13，远早于 Durable 统一执行后的 epoch `4017aeb9`（08:26:22 起 0 boundary）。日志只有 sessionHash，没有"哪个 UI 会话/哪个 agent"的标识；建议改写成"4 行来自 2 个请求（session cf8f75f1…）"或不写归属。

## 7. 无法复现项与建议补口径

| 项 | 现状 | 建议 |
|---|---|---|
| 原报告"11-05 首请求 121 条" | 能推出 121 = 124（任一行为首唯一）− 3（hitRate=null），但它与复核报告的 90 是不同口径；表格里的 121 与"32 条 hitRate=0"并列时没有说明用哪种去重 | 报告里固定写：①按行还是按唯一 request；②按 pick 行还是任一 stage；③是否要求 hitRate 非空。本脚本三种口径都输出（§5.2） |
| 复核报告"usage.input=0 空记录 9 条" | 实测 14 条（§6-D1），无法复现 9 的口径 | 给出筛选条件（是否限定 outcome、是否要求有 result、是否只算主进程 main）与 9 个 request id |
| 复核报告"无 items request 46 个请求" | 实测 46 是 provider 行数，唯一请求 80（§6-D2） | 拆成行/唯一两列 |
| 复核报告"11-06 的 4 条 boundary 属当前 lead 会话" | 日志无会话归属可判（§6-D8） | 删除归属判断，或补 UI/进程标识字段 |
| 复核报告"T01 原结论 4 条" | 能复现为 hitRate∈(0,0.5) 的 4 条，但那是被错误阈值筛出的残留 | 已在 §5.1 说明，不再作为基线 |
| 复核报告 C 组 `mcp-cache.json`（17 server / 186,428 字节，mtime 2026-09-24 16:17） | 本任务只做 T01–T10/T15–T18 只读项，未复核 | 归 T11–T14 根因调查（task-3） |

## 8. 已知限制

1. 日志只有 HMAC 哈希与字节数，**不含明文**；本脚本不还原内容，`items[0]` 只能归因到 role / 字节数 / 哈希，无法归因到具体文案段落。
2. 不同进程 epoch 的哈希不可比；T18 只在同一 `(epoch, sessionHash)` 内比较相邻请求。
3. "未观测"不等于"没有变化"：http-result 缺失、http items 为空、body 不可观测都单独标记（`http-observation-missing` / `http-items-empty` / `transport-anomaly`）。
4. 11-06 日志仍在追加（Durable 路径无 boundary），实时计数随时间增长；引用数字请带 `generatedAt` 或固定 `--cutoff`。
5. 请求级 `op` 取自已入表的 boundary；缺 boundary 的请求 `op=null`，任何 `op=stream` 过滤都会漏掉它们，因此 11-06 的 T01/T02 不判通过。
6. T15–T17 只读 `mcp.json` 结构字段，不判断运行时启用状态（该状态由会话场景白名单决定）。
7. 本脚本不做 T11–T14 根因调查（需要写操作/重启，归 task-3）。

## 9. facts.json 结构与自检

顶层字段：`script`、`generatedAt`、`run`（命令/参数/cutoff/node）、`inputs`（逐文件字节/mtime/事件数、其它事件计数、重复行、断裂事件异常）、`snapshot`（按日期与合计，含 epoch 明细、op 分布）、`reportSnapshot`（报告时点快照）、`rules`（11 条口径）、`checks`（T01–T10、T03/T04/T18、mcp、byDate）、`requests`（1586 条逐请求行：op/stages/pickVia/items[0]/指纹/previous/delta/hitRate/usage/flags）、`breakEvents`（16 条断裂事件行：11-05 14 行 + 11-06 2 行）、`selfcheck`（23 项）、`limits`（7 条限制）。

自检 23 项（本次全部 PASS，0 硬失败）：

| 编号 | 内容 | 结果 |
|---|---|---|
| S01 | 11-05 事件对账（2091 行 / 1134 唯一 / result 1133 / http-result 957） | PASS |
| S02 | 11-05 全部 request 带 boundary（0 条缺失） | PASS |
| S03 | T01 11-05 = 7（developer 5 / user 2） | PASS |
| S04 | T02 时间戳 12:18:40 / 15:04:18，均 +175 | PASS |
| S05 | T03 六条恢复率 97.156 / 65.346 / 94.698 / 99.241 / 86.287 / 97.661 | PASS |
| S06 | T03 无后续 = `1edf5161`（session b45b140e…） | PASS |
| S07 | T04 唯一 ±14 对，gap 7875 ms | PASS |
| S08 | T05 14 行 / 9 唯一 | PASS |
| S09 | T05 1a9e5385=50.284%、604f4eba=94.033% | PASS |
| S10 | T06 排除 d8043128、5b600690 | PASS |
| S11 | T07 14 唯一 / 28 行，prompt+ic2+items[0] delta 0 | PASS |
| S12 | T08 三种口径：pick 首 90 / 行 159 / 任一行为首 124 / hitRate=0 32 | PASS |
| S13 | T09 hitRate=null 14 条（其中传输异常 4） | PASS |
| S14 | T09 无 items 80 行（provider 46 + http 34） | PASS |
| S15 | T10 34/34 回退成功 | PASS |
| S16 | T10 1a9e5385 stages=[provider] | PASS |
| S17 | 11-06 报告快照 742/746（实时只校验不变量） | PASS |
| S18 | 11-06 T01/T02 = 不可判（无 boundary） | PASS |
| S19 | 11-06 `3c4eefc4` 09:10:31 / +58 / hitRate 1.207% | PASS |
| S20 | 11-06 http items 为空 0 行 | PASS |
| S21 | T18 11-05 命中 1 条（201c0806，input=30057）/ 11-06 0 条 | PASS |
| S22 | T15–T17 mcp.json 只读检查 | PASS |
| S23 | 解析完整性（0 行 JSON 解析失败） | PASS |
