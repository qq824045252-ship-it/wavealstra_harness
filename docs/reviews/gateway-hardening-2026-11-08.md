# Gateway 缓存、持久化交付与安全边界加固

日期：2026-11-08。代码评估基线：`de5a7496333f1f359991288582b504006d568c1c`（`feat(gateway): add bounded media ingress and reliable reply handling`）。本次保留现有 Phase 1–5 / Pi 原生执行架构，在 Gateway 传输层补齐可靠性与安全边界；没有升级产品版本，没有构建或打包产品。

## 1. 对原问题清单的复核

| 原判断 | 当前源码核验与处理 |
| --- | --- |
| Gateway 去重每次扫描，并在满额时复制、排序整个 Map | 成立。替换为公共 `BoundedTTLCache`，淘汰不再扫描或排序缓存 |
| Weixin context Map 无容量与 TTL | 成立。增加 1,024 条容量和 24 小时本地保留期；这个 TTL 不代表平台保证 token 在 24 小时内有效 |
| DingTalk 在 10,000 条记录后拒绝新消息 | 成立，但当前基线错误码为 **429**，不是 403。改成淘汰最旧去重记录；QQ 的同类问题也修复。保留真正的授权、队列与速率限制 |
| Registry 用对象 JSON 字段顺序作为队列键 | 当前源码不成立，已经是固定位置的 JSON 数组。保留这种无分隔符碰撞的身份编码 |
| `await run` 本身会导致无人处理的队列尾异常 | 需要区分交付结果与内部队列尾。原队列尾已有拒绝处理；本次明确观察 `accepted` 与完成 promise，仍让接收方识别落盘失败，不能吞掉错误后返回成功 ACK |
| Gateway 仅有内存队列 | 对非 Slack 渠道成立。Slack 已有独立 journal；本次为其余渠道增加 SQLite Inbox/Outbox，不叠加第二套 Slack 收据 |
| 单会话队列上限 32 / 全局 1,024 | 当前 registry 已是 **64 / 1,024**。个别 adapter 另有本地接收上限，不能把两层限额混为一谈 |
| 所有渠道都需要首次引入 safeStorage | 已有七种渠道加密。真正遗漏的是 Telegram 和公众号；本次补齐，并统一配置脱敏与出站过滤 |
| Bot 发送区仍是草稿占位符 | 当前 UI 已接入 `submitBotDraft`、历史、重试与取消。修正文档中的历史表述，没有重复实现另一套发送入口 |
| `NO_AT_BRIDGE=1` 能修复 AT-SPI socket EPERM | 当前环境的 AF_UNIX socket 创建本身就被拒绝；不是 Chromium 桥接噪声。保留真实失败，改善诊断与 CI 依赖，不禁用被测 AT-SPI 能力 |
| 测试基线是 353 passed / 1 failed | 属于旧记录。前一媒体提交记录的是 376 项、372 通过、4 失败；本次重新执行最终套件，结果见下文 |

动态权限热更新、长任务优先级抢占、外部副作用成本计账仍属于功能演进。现有回归脚本不能证明全部平台真实账号、物理设备断网恢复或发行包验收已经完成，本次没有作这种承诺。

## 2. 缓存与职责拆分

`src/main/gateway/BoundedTTLCache.ts` 提供固定寿命的有界 Map：键读取时惰性校验过期，写入时更新插入顺序，容量超限时删除头部一项。单次查找和容量淘汰采用 Map 常数级操作；没有全表扫描、数组复制或按时间排序。读取不会延长 TTL，更新会刷新寿命。默认时钟使用单调时间，测试可以注入确定性时钟。已过期但尚未访问的记录也计入容量，不会无界驻留。

该缓存用于 Gateway 运行期去重，以及 DingTalk、Discord、QQ、Weixin、WeCom smart 的相应去重/上下文/媒体尝试记录。SQLite 完成收据承担跨进程去重；内存缓存只负责有限运行窗口。Discord 的失败清理另外绑定具体预留对象，防止较早失败误删后来同键的预留。

职责拆分如下：

| 模块 | 责任 |
| --- | --- |
| `GatewayService` | 构造渠道、配置、授权、激活、QR 登录与应用事件 |
| `GatewayRouter` | 原生会话与 turn 身份、项目投递、模型选择、Agent 调用、答案准备 |
| `GatewayRateLimiter` | 运行期去重守卫及既有 allowlist 语义 |
| `GatewayLifecycleManager` | Webhook listener 的并发启动/关闭、端口回退、精确路由与 HTTP 错误接收 |
| `GatewayPlatformRegistry` | 来源校验、会话 FIFO、持久接受、恢复调度与回复交付 |
| `GatewayDeliveryJournal` | SQLite 不可变输入/答案、保留上限、状态迁移及崩溃恢复 |
| `GatewaySecrets` / `GatewayRouteCredentials` | 配置凭据过滤、临时回复能力加密与输出脱敏 |

Webhook 路由不再用任意前缀匹配，body 上限为 4 MiB；HTTP server 对异步 listener 错误有明确接收。停止中的 listener 不会在端口回退完成后重新挂起。

## 3. Inbox/Outbox 的可靠性保证

### 持久接受边界

桌面 `GatewayService` 默认启用 `gateway_inbox` / `gateway_outbox`，嵌入方或夹具可以显式 `durableInbox: false`。经过平台认证、来源校验和附件准备的输入，先以 SQLite 事务提交，再进入原有会话串行队列。稳定身份绑定 channel、已验证账号、chat 和平台 message ID；没有平台 ID 的输入只保证首次接受后生成的本地身份能用于恢复，不能凭空判定未来另一次无 ID 投递是同一事件。

HTTP callback 与 DingTalk 在 `accepted` 成功后才返回成功 ACK。轮询路径按接受结果推进游标；Weixin 持久化失败不会推进 cursor，也不会误计为媒体永久拒绝。接受前的下载失败、尚未收到的平台事件及任意离线历史补扫不在本次保证内。

数据库辅助表通过幂等建表加入，没有提高 `CURRENT_DATABASE_SCHEMA_VERSION`。这个项目在主 schema 不兼容时会备份并重建数据库，增加传输表不应触发清空既有原生任务和 WAL。

### 恢复与发送分类

| 状态 | 处理 |
| --- | --- |
| pending | 使用原消息身份、原会话顺序和当前账号/allowlist 恢复 |
| running 且支持原生收据 | 以原稳定身份取得已有收据，或在崩溃早于原生接收时首次提交；不构造新 task / turn，工具副作用继续服从已有 WAL 恢复规则 |
| running 但无原生幂等收据 | 保存 unknown，不重新调用可能已有副作用的普通 handler |
| 答案已落盘、reply_pending | 发送已存答案，不重新调用 Agent |
| 平台明确证明未发送且错误可重试 | 有限退避重试，默认最多五次 |
| 崩溃时发送中、已部分发送、响应丢失或无法判断 | 标记 unknown，停止自动重发 |
| 账号不符、授权撤回、附件损坏或临时回复能力失效 | 保留待处理记录并显示状态，不改投其他用户/账号/渠道 |
| completed | 在有限收据保留窗口内抑制重投，包括主进程重启之后 |

每次恢复和发送重新验证账号、生命周期与发送者权限。相同账号重连使用当前认证和原存储路由重建 sender；不能沿用旧连接闭包，也不能换到另一个账号发送。没有存储路由的运行期回调仍能使用当前闭包；进程重启后不能恢复的路由明确阻塞。

附件恢复核对 Gateway 缓存目录、无 symlink、大小、内容 SHA-256 与文件名哈希；缺失或篡改时拒绝执行，不能静默删除附件再让 Agent 回答。答案也校验原始摘要，损坏记录停止重试，避免零延时循环。

默认上限：未解决输入 10,000 条，已完成收据 100,000 条且最长保留 30 天。未解决记录不因容量不足被淘汰；满额施加背压。关闭渠道取消恢复 timer，只有显式恢复/连接才重新启用；离线轮询退避且不消耗实际发送次数。

### 平台回复边界

- Feishu、Telegram、Discord、QQ、公众号和 WeCom callback 保存原目标路由。Discord 使用稳定 nonce，QQ 使用稳定 msg_seq；这些标识不把平台 API 变成全局 exactly-once。
- DingTalk session webhook 与 Weixin context token 由主机注入的 OS 密钥库 codec 加密，绑定原账号、消息、发送者、目标和有效期。持久表不保存明文临时能力，解密后再次验证目的地。
- 临时回复能力的编码/容量超限与系统密钥库故障分开处理：Weixin 在入箱前遇到确定性不可编码的能力时明确拒绝该输入并继续游标，避免异常 token 永久堵住后续消息；密钥库和持久接收故障保留游标等待重投。加密密文仍有 32,768 字符硬上限。
- WeCom smart 的 req_id 依赖原请求；断线或重启后不能假设仍有效，待回复可进入 blocked。
- Telegram 429 不再无限递归重试；已发送部分分片的失败不能整条重发。WeCom/公众号检查 HTTP 与业务返回码；WeCom 群消息使用对应的群发送接口。
- 暂未实现持久化 Telegram offset、Weixin sync_buf、Discord sequence/history backfill，或通用跨平台降级发送。发送目标与用户授权不能在重试时扩张。

## 4. 凭据与生命周期

九种渠道的配置秘密现在均通过 Electron safeStorage 持久化，Telegram 与公众号支持已存明文配置的受控升级；恢复 transport 前先完成密封。安全存储不可用或 Linux 返回 `basic_text` 时拒绝保存/恢复，没有明文回退。renderer 只读回占位符。

统一出站过滤覆盖配置凭据本体、URL 编码/JSON 转义形式、常见 token/Bearer 错误文本、Agent 正常或错误回复、Work 文本与 Gateway 持久化/广播事件。长 turn 保留启动时凭据快照，避免轮换数次后旧错误泄漏旧 token；格式异常的 surrogate 不会使错误处理再次抛错。鉴权请求本身仍使用真实凭据。

复审额外修复了三类并发缺陷：

1. stop/suspend 跨越异步恢复后，旧循环不能继续激活后续渠道或重新启用 journal。
2. webhook 渠道还在获取 token、`isConnected` 仍为 false 时，停止操作仍会 invalidate 该连接尝试。
3. 同一渠道 A/B 连接重叠时，较早 A 的失败不能清理较晚 B 的 transport、密文配置或 allowlist；A 的失败信息使用 A 的凭据快照脱敏。

## 5. 测试运行器与 CI

没有在这次可靠性修复中把数百个自执行脚本整体改写成 Vitest。既有脚本依赖 esbuild alias、Electron stub、native externals 与隔离子进程，直接换 loader 会同时改变执行语义。本次保留原脚本入口和 test-guard，在 `test:all` 内用共享 esbuild service 批量编译可精确识别的命令，保持原 format/alias/external/输出路径；没有持久缓存。复杂命令或共享输出回退原路径，批量失败会归因到具体脚本，失败产物不会被当成成功结果运行。

`--no-batch-build` / `TEST_ALL_BATCH_BUILD=0` 可使用原逐脚本入口。性能敏感与真实强杀恢复测试保持串行池。非法 jobs/timeout 参数会立即失败，不能意外得到“零测试通过”。

产品产物断言显式列为 ARTIFACT：`image-resize-assets`、`oauth-build-assets`、`pi-codemode-assets`。OAuth 源码冒烟和 Pi SDK 功能仍保留在 default；ARTIFACT 单独命令不会隐式构建，缺产物必须失败。Windows/Linux CI 在既有 build 后强制执行此层，GUI gate 也包括它。未修改 `scripts/test-baseline.json`。

AT-SPI 与输入守护测试只编译隔离 worker 夹具到 `out/tests`，不再隐式生成产品 `out/main`。Linux CI 补齐 dbus 依赖，并保留现有 xvfb。AT-SPI 缺依赖和 socket EPERM 各自给出诊断；没有通过设置 `NO_AT_BRIDGE=1` 禁用所要验证的功能。

## 6. 实际验证

| 命令 / 验证 | 实际结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过，web / node / scripts 全部完成；scripts 0 错误、0 新增 |
| `TEST_ALL_JOBS=2 pnpm -s test:all` | **381 项：380 通过、1 失败；exit 1，完整门禁未通过**。最终补丁后复跑墙钟 245.041 秒，knownFailing 仍为 0 |
| 唯一 default 失败 | `test:atspi-transport`：`dbus-daemon` 创建 AF_UNIX socket 被宿主拒绝，`Operation not permitted`；独立 `socket(AF_UNIX, SOCK_STREAM)` 探针也得到 EPERM |
| Gateway 新旧专项 | 本轮全量内全部通过，包括 cache、security、lifecycle、delivery-journal、inbox-crash、各平台与媒体测试 |
| 串行恢复 / 性能池 | Phase 2 recovery、Phase 5 native story、core-performance、Gateway SIGKILL 四项全部通过 |
| `pnpm -s test:all:artifacts` | 单独执行为 **0 通过 / 3 失败**，均为未生成产品构建产物的前置条件失败；没有为了转绿运行产品 build，没有把这三项记为通过 |
| `node scripts/test-all.mjs --audit` | 通过；headless 381 / GUI 55 / NETWORK 29 / DATASET 2 / ARTIFACT 3 / pending 0 |
| `git diff --check` | 通过；`scripts/test-baseline.json` 未修改 |
| GUI / 真实账号 / 发行包 | 未验收，不计为通过 |

本轮 357 个可识别脚本经 73 批共享 esbuild 编译，编译阶段 8.4 秒；24 个脚本保留原命令入口。这是本机一次运行的记录，没有同机 A/B 基准，不据此宣称整体提速倍数。

AT-SPI 在日志中仍被棘轮标为新增失败，因为 `knownFailing` 为空；“宿主前置条件失败”的归因不等于门禁成功。要关闭这一验收项，必须在允许 AF_UNIX 的 Linux 环境执行真实 private-bus 测试。`NO_AT_BRIDGE`、xvfb 或更换 socket 目录不能为本机授予该权限。

新增重点回归包括：缓存 100,000 次写入仍有界；DingTalk 超过 10,000 条后继续接受；Weixin TTL/容量、落盘失败 cursor、异常 token 编码超限的终止拒绝与临时密钥库故障恢复；SQLite 接受/重投/不可变输入/授权撤回/附件篡改/回复重试/unknown/暂停；正常回复与异步错误的凭据过滤；listener 并发启停和连接竞态。

真实 SIGKILL 用例通过实际 `GatewayService → DurableBotService` 路径：第一条输入的 unsafe tool 已写入副作用文件且仍在 running，第二条处于 pending，此时杀死子进程。重启后第一条工具效果没有重复，第二条保持 FIFO，回复使用原 message ID；两条 completed 再次平台投递不再执行或回复。这是隔离进程和本地 SQLite 的崩溃证据，不是物理断电、跨平台文件锁或真实平台长期离线验收。

## 7. 未宣称完成的事项

微信群聊、Discord/DingTalk/QQ/Weixin 自主 Work sender、通用出站媒体、流式编辑、交互审批、全部 Hermes 插件和跨平台 fallback 不在本次实现范围。临时 webhook 与 context token 的恢复还受提供方有效期限制。真实账号与 QR 登录、Windows/Omarchy 桌面会话、跨平台文件锁、长时间网络中断以及安装包验收仍需相应环境运行，不能用这些 headless 夹具代替。

继续参考：[Gateway 架构](../hermes-gateway-architecture.md)、[Hermes 能力矩阵](../hermes-gateway-parity.md)、[Phase 1–5 历史实施记录](../bot-work-implementation.md)。
