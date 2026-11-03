# 目标38条 routing.prompt 聚合校准与轮次证据

数据来自已脱敏 `audit-evidence.json`，关联原 task 会话中的38个assistant usage记录。新诊断脚本 `prompt_metadata.go` 仅额外读取原会话JSONL每条message.role，不输出content。结果为 `prompt-metadata-evidence.json`；末轮大小专项脚本 `prompt_chat_metadata.ps1` 与结果 `prompt-chat-metadata.json` 仅读取已脱敏数据。

## 结论

没有发现 routing.prompt 可见的system相对tools的估计大小明显增长。38条 system/tools 比值为0.5432148356430341–0.5433020018655378，相对波幅0.0160450753%。将calibrate的共同缩放、每项四舍五入、最大part吸收残差全部纳入后，所有38条存在共同恒定估计比值区间 `[0.5432466367713005,0.5432664948281056]`。这些结果与原始估计大小不变相容，不能证明字节不变。

全38条 tools 的可见name/tag/N集合签名相同，system的可见name/tag/N签名也相同。tools的24个显示item分别对tools总量的比值，24/24均存在跨38条共同的恒定估计比值可行区间。skills和memory分类在全部38条中缺失；它们的比值应记为不可用，不能填0后推断其文字不存在。

原会话累计用户消息只有4条。每条assistant调用的 routing.prompt.turns 均精确等于原会话累计role=user消息数加1（38/38）。变化只发生于真实用户继续发言，没有随工具调用递增。每次最多多出一轮的形态，与每次重建input时追加一次临时用户capsule、旧capsule不累积相容。

## 源码依据与误差模型

精确commit `833f51adcf4d880c8fd8683f71873bb16e86d74b`：

- `internal/gateway/prompt.go:308–342`：scale=counted/est；每个part与item先round(x*scale)，最后把各part的总量舍入残差归到最大part。
- `prompt.go:191–243`：按kind聚合items；非chat最多保留24项；第24项other.N记录余项数。chat按数字轮次顺序保留，超过24轮才汇总earlier。
- `prompt.go:924–940`：Responses的user消息，只有userSays判定有实质用户文字才newTurn；system/developer归systemText，function_call_output不增加用户轮次。
- `prompt.go:740–762`：userWords会滤掉系统提醒及若干注入式上下文，所以prompt.turns是分类器轮次，不等于原始wire数组长度。
- `prompt.go:1225–1234`：inspectPrompt的聚合读取 `promptOf(from, body)`；`masked` 另交给keepBody。这里的聚合不能保证后续脱敏、转换、签名后的真实上游wire字节稳定。

本案system始终小于tools，不会成为最大part，system观测误差界±0.5。tools若不是最大part，误差界±0.5；若为最大part，有K个part时误差界为±(K-1)/2，因为它等于counted减去其他K-1个已取整part。由观测S、T可构造比值区间 `[(S-0.5)/(T+E),(S+0.5)/(T-E)]`。38个区间交集非空。

工具可见身份签名：`0aefe7ce74b1eaf004b37b3d923453ba82c65a8ca8dbb0f9614851cb863e4740`（38/38）。这是对已脱敏可见name/tag/N集合再做SHA-256，不是schema正文哈希。

system可见身份签名：`21969d0b7f1cad8b7e462768179496f128ff04d5b0a1310b190b3dfa3fcfc34e`（38/38）。这不是system正文哈希。

## parts数量与N

全程system显示item=1；tools显示items=24，其中23项单独显示，other.N=25，代表48个聚合前工具条目；不能借此验证隐藏25项的身份或正文。可见列表排序由未校准估计tokens决定，诊断签名按name/tag/N再排序，排除了仅排序差异。

chat的items数量依次为2、3、4、5，均与prompt.turns一致；这些阶段所有chat-item.N都为0，未触及24轮截断。files/results随着工具输出出现并增长。这些part大小变化属于对话内容聚合变化，不能归因于system变化。

## 实际用户轮与临时最后一轮

原用户累计1条：21次调用，08:38:28–08:49:01，routing.turns=2。前一轮（第1轮）tokens从48到14074；最后一轮（第2轮）相对tools的共同估计比值区间为 `[0.07290883710941694,0.07292514239218877]`。

原用户累计2条：6次调用，09:04:05–09:06:57，routing.turns=3。前一轮tokens从16到1426；最后一轮相对tools区间 `[0.03394989463825802,0.033954659949622164]`。

原用户累计3条：5次调用，09:13:25–09:16:30，routing.turns=4。前一轮tokens从17到1823；最后一轮相对tools区间 `[0.028464143225936232,0.02849261614020924]`。

原用户累计4条：6次调用，09:16:57–09:17:36，routing.turns=5。前一轮tokens从7到1826；最后一轮相对tools区间 `[0.0715994474207352,0.07164350677891605]`。

每个阶段的最后一轮估计大小都可视为恒定，增长的工具/助手历史落在它的前一轮。这更符合“每次输入有一个临时末尾用户消息、下一次重建时被替换”的结构；仅凭聚合仍无法确定末轮正文、是否发生等估计长度变化、或后续wire排列。

## 不可越过的证据边界

稳定的估计token比值不是稳定的body hash；等长度文本、时间戳、ID、序列化差异仍可使前缀失配。name/tag/N签名不代表工具schema正文；隐藏25项只能约束其合计估计大小。skills/memory分类缺失不代表相应文字不存在。prompt.turns比实际role=user多1不等于已经恢复capsule或input数组。当前结果没有支持system估计尺寸显著漂移，也没有支持capsule作为历史用户轮不断累积，具体缓存断点仍需真实请求或实现证据。
