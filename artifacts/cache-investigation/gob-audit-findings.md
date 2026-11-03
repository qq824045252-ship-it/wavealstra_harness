# calls-v15 与网关审计脱敏证据

目标：2026-11-02 08:38–09:18 北京时间，MyBuddy task `01a199b1-7a56-7415-b47b-0cdd635c3fc0`，`codex/gpt-5.6-terra` / `codex/gpt-6.1-terra`。本诊断只读原始数据；所有脚本与结果在本目录。脚本编译设置 GOTOOLCHAIN=local、GOPROXY=off、GOSUMDB=off，没有网络请求。

## 已验证

- 先读取本机 `C:/Users/servi/bin/go.cmd`，其仅代理到 `C:/Users/servi/AppData/Local/Programs/Go/bin/go.exe`，Go 版本 go1.27.1 windows/amd64。
- calls-v15 解码时共 1174 shards，1184 frames，28680 calls；全部通过帧长度、CRC32-IEEE、原生 encoding/gob 解码、字符串表索引及 patch index 检查，失败 0。缓存活跃写入，初次清点为1172文件，最终解码扫描为1174。
- 目标时间窗 call.Time 记录 0；State.Session / Call.Session / Call.ThreadID / 源路径中的目标 task 匹配也为 0。不能把 calls-v15 当作所有网关调用的原始记录。
- 精确源码 commit `833f51adcf4d880c8fd8683f71873bb16e86d74b` 的 internal/sessions/call_cache.go:457–535 与实际 gob wire schema 一致：8字节 header（little-endian uint32 length + CRC32）后是 callFrame gob；按 patch Index 重建调用，Text[13] 由 frame.Strings 反查。
- callFrame/Call 主要保留 Tokens、路由/账号标识、时间、source File + From/To 范围与解析继续状态；无完整请求/响应字段、prompt_cache_key 或原始 input 数组。Dsh 是解析继续状态，不应误称请求体。
- 读取主代理新指派的 usage.jsonl、routing/2026-11-02.jsonl，并与原 task 会话 JSONL 的38个 assistant.message.usage 关联。全部38条通过 (input,cacheRead,output) 唯一匹配；session 与 native_session 均直接吻合目标task。MyBuddy usage.input 与 Magpie usage.in 相等，均不含 CacheRead。
- gpt-5.6-terra：21条，08:38:28.2074492–08:49:01.8468222，sum input=1391095，sum cache_read=440320，sum output=8439；首条0，其后20条均22016。
- gpt-6.1-terra：17条，09:04:05.7583945–09:17:36.3591222，sum input=2103402，sum cache_read=370688，sum output=3334；首条0，其后16条均23168。
- 全38条 provider=codex、HTTP status=200、order_count=1、tries_count=1、Try.Net.asks=1；同一账号哈希，同一路由账号ID哈希。持久化证据不支持换账号或路由重试解释。
- 全38条均无 archive 字段、无 prompt_cache_key、无原始 input 项。routing.prompt 的 parts/items 只有归类名称、数量与校准 token 计数；名称哈希不等于 input 项正文哈希。
- 全38条都记录 masking_ms（16–171ms）。这只能证明有耗时记录，不能单凭耗时断言正文变化，需主代理检查实现。

## 仅脱敏标识

SHA-256 对精确 UTF-8 字符串计算，未截断：

- providerAccount / routing.order[].who：`6b3c67abbaec8a45af0d5e591fc626246558d867af06cafff69b93209599f62b`
- routing.order[].id / tries[].id：`57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93`
- session / native_session：`a3b3b3211ffe147074069e0d4564f8fcb6e1172b638f9f501166dfc57fb818d3`

## 证据文件

- `gob_decode.go`：按源码结构离线读取全部帧，校验CRC并重建patch；输出仅允许标签、数字、哈希。
- `gob-evidence.json`：完整gob扫描汇总及目标筛选（空）；原文件只读。
- `gob_probe.go`：早期只读gob wire结构探针。正式结论以原生gob解码脚本为准。
- `audit_decode.go`：读取usage/routing与原task会话usage；全字符串默认哈希，少量固定枚举/目标模型/合法RFC3339时间保留；敏感正文从不输出。
- `audit-evidence.json`：38条原task usage、132条时间窗目标模型候选及132条routing候选，均已脱敏；含38条唯一匹配索引。
- `audit_summary.ps1`：仅读取上述脱敏JSON，生成精确38条目标记录汇总。
- `audit-target-summary.json`：最终逐条可复核证据，含原文件行号、route_id、模型、input/cache_read/output、账号哈希、tries/net.asks、masking耗时与prompt分块tokens。
- `gob-audit-evidence.svg`：已验证的跨文件证据关系图。

## 尚不能回答

这些持久化元数据无法恢复目标38条的 prompt_cache_key 哈希、真实 input 每项哈希、请求/响应原始正文哈希；没有原请求归档的已知引用。若需要证明前缀变化，需另行找到授权的真实请求记录，或由主代理结合转换/脱敏实现说明可推导边界。不能把聚合prompt名称/计数当作输入正文证据。
