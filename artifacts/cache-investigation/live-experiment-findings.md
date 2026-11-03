# 本轮 live 实验账号 / HTTP 尝试元数据核查

范围：用户指定runtime fullbody约10:08:49/10:08:54、next-turn约10:11:27，以及2026-11-02T02:15:30–02:16:35Z（北京时间10:15:30–10:16:35）的两个工具循环实验。本诊断只读本机usage.jsonl与routing/2026-11-02.jsonl，不发送网络请求，不读取或输出实验正文、凭据、session原ID。

## 结论

本轮11条实验记录已从本轮审计独立重新核验，扫描时没有按旧账号预过滤。全部使用同一最终providerAccount哈希、同一路由账号ID；均order=1、tries=1、Try.Net.asks=1、status=200、route.done=true。每条的routing.order.who哈希与usage.providerAccount吻合，tries.id哈希与order.id吻合。没有again/replan/retried_ms/handed_on记录。缓存回落不能用这11条可见的网关账号切换或重试解释。

这不排除供应商内部负载均衡、缓存分片、缓存传播/写入时机或其他未记录的上游行为；审计没有给出这些机制。实验“append-only/moving-tail”的输入构造由主代理实验确定，审计元数据本身不证明请求前缀关系。

最终providerAccount SHA-256：`6b3c67abbaec8a45af0d5e591fc626246558d867af06cafff69b93209599f62b`。

路由order/tries账号ID SHA-256：`57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93`。

所有11条最终模型与served均gpt-6.1-terra。

## fullbody / next-turn

- route1793500712909：usage.t=10:08:45.6567792，ms=3913，估计结束10:08:49.5697792；input未缓存111318，cache_read47616，prompt_total158934，out5。
- route1793500712910：usage.t=10:08:49.6645557，ms=5304，估计结束10:08:54.9685557；input未缓存86，cache_read158848，prompt_total158934，out5。
- route1793500712915：usage.t=10:11:23.007509，ms=4322，估计结束10:11:27.329509；input未缓存111465，cache_read47616，prompt_total159081，out5。

三条session哈希均为 `a3b3b3211ffe147074069e0d4564f8fcb6e1172b638f9f501166dfc57fb818d3`。请求开始时间与主代理实验日志完成时间不同；使用usage.t+usage.ms对齐结束时间后吻合。估计结束时间不是另行记录的客户端接收时间。

## append-only arm

session SHA-256：`5e675f3a9e1e1817b255ef7f9fc0672e570b2ebebc6023a652ccd3db30523701`。

四条route依次为1793500712923、1793500712924、1793500712925、1793500712926。

请求开始北京时间依次10:15:28.5609671、10:15:36.0670896、10:15:45.6039646、10:15:51.4899132；估计结束10:15:36.0519671、10:15:45.5920896、10:15:51.4799646、10:15:59.5309132。

cache_read序列 `[0,19584,0,26112]`；未缓存input序列 `[19506,3245,26129,3285]`；prompt_total序列 `[19506,22829,26129,29397]`；out序列 `[246,169,169,180]`。

第三条cache_read回落到0，与前后条相同账号、相同单次HTTP尝试。

## moving-tail arm

session SHA-256：`100bdcfc0de79f214ae816f86c5c2b5009e6976687b638352754ffa5b7d86695`。

四条route依次为1793500712927、1793500712928、1793500712929、1793500712930。

请求开始北京时间依次10:15:59.5540425、10:16:07.3035809、10:16:15.4502247、10:16:22.1263831；估计结束10:16:07.2900425、10:16:15.4395809、10:16:22.1102247、10:16:30.3243831。

cache_read序列 `[0,0,3968,25984]`；未缓存input序列 `[19531,22867,22208,3432]`；prompt_total序列 `[19531,22867,26176,29416]`；out序列 `[259,178,141,177]`。

这些0/小read/高read也全部发生在同一可见账号与单次HTTP尝试前提下。

## 可复核文件

`live_audit_match.go` 从本机审计读取10:08:35–10:16:50的所有codex terra/sol调用，不按账号预过滤；输出 `live-experiment-audit.json`（26条全脱敏候选，含routing与tries摘要）。

`live_audit_select.ps1` 从脱敏候选中按精确route与预期cache序列选出11条，逐条核验order.who/usage.providerAccount、tries.id/order.id和HTTP asks，输出 `live-experiment-selected.json`。该结果包含原审计行号、完整数值route ID、时间与耗时、模型、token用量、session/账号/响应ID哈希与所有重试字段状态。

`live-experiment-account-evidence.svg` 显示本轮重新核验的同账号关系与真实cache_read序列。
