# #50 缓存报表归一化补修

基线：`2a8b0732a3fe9d5607917759cfae5d2199646d69`。仅修改验收报表和测试登记，不修改产品、模型适配器、原始运行记录或用户工作区。

## 已复现问题

原报表支持 `cache_read_input_tokens` 累计缓存 token，但冷热分组仅读取 `prompt_tokens_details.cached_tokens`。合成一条 `prompt_tokens=100, cache_read_input_tokens=80` 的记录，真实报表 CLI 输出 `cacheReadTokens=80`、`cacheState=unknown`，两者不一致。

## 格式与边界

共用一个解析结果同时决定缓存计数和分类：

1. Chat Completions：`prompt_tokens_details.cached_tokens`。
2. Responses 兼容 usage 对象：`input_tokens_details.cached_tokens`。
3. 网关保留的平铺计数：`cache_read_input_tokens`。

优先级依上述顺序，保留原有 Chat Completions 优先语义；显式 0 不能被后面的正数覆盖。缺失或 null 可以继续查找下一别名；出现负数、小数、字符串、布尔、非有限数或不安全整数则标记 unknown，不用次要字段掩盖无效主计数。

这不是通用跨协议 token 解析器。当前生产基准走 OpenAI-compatible Chat Completions，采集顶层 `frame.usage`。本补修不新增 Responses 的 `response.usage`、Anthropic 的 `message.usage` 或 Google `usageMetadata` 流采集，不将 Anthropic 的非缓存 input_tokens 当作含缓存 prompt_tokens，不推断它们的总成本。缓存别名的支持也不代表整个原生协议已经通过。

零缓存读取只代表该请求明确报告 0，不保证实验获得了真正冷缓存。缺失 usage、缓存创建成本及金额继续保留 unknown。字符数仍不是精确 token；本补修没有新增真实 A/B 数据。

## 回归

`pnpm -s test:browser-benchmark-report`：18 组字段/边界检查和实际报表 CLI 分组检查通过。明确检查 warm、显式 zero、unknown 分组，以及存在缺失值时总缓存与费用不能填 0。测试为纯 Node、合成数据，登记在 headless；无 GUI、无网络模型或真实费用。

仍待 #49/#50 最终生产 A/B、真实模型请求及成本证据收尾；此补修不能独立作为关闭依据。
