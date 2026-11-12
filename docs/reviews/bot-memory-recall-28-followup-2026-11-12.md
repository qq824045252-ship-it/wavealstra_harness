# #28 并行修复后的独立复核与窄补丁

## 基线与边界

- 起始检查远端 `5743cbc8`：原审查的 2 个 P1、3 个 P2 仍在。当时的隔离补丁未发布。
- 发布前重新 fetch 发现用户另一工作已将同批修复推入 `e35fafd621e2f8b707013f2d6cea2e4b212b1c0c`。保留该提交及此前所有他人提交，未覆盖或重复合入旧补丁，改为从 e35fafd6 补缺。
- 本轮产品补丁：`c1eca435` 与 `0cb1ae71`。冻结验证源码：`0cb1ae71f181067c2a73b07a9dbdc6753fd0ca99`。
- 执行位置为 Omarchy 独立 clone；合成 SQLite / 临时 HOME。未触碰用户主 checkout、Vivion、#32 或真实 profile/凭据。
- **#28 仍保留 open。** 下文方法级证据不冒充真实模型或完整范围矩阵通过。

## 最新基线仍可复现的缺口

### P1：短首项、多 cookie 与编码值仍能进入历史

e35fafd6 的 Cookie 值正则限定 `[A-Za-z0-9._~+/=-]{8,}`。执行其原函数，以下纯合成输入均未被阻断：

- `Cookie: a=b; sid=FAKE_REVIEW_ONLY_abcdefghijk`
- `Cookie: sid=%46%41%4B%45`
- `Cookie: s=abc`

同样的多值 JSON 请求头也会漏过。测试强制建立旧 L0 指针后检查最终历史引文，而不是仅检查 capture 返回值；e35 对该断言失败。

修复：保留共用 `MemoryTextSafety` 与其他安全规则，仅取消 Cookie 值的不成立的长度/字符集假设。普通无赋值 cookie 术语仍通过。

### P2：首批三条旧证据仍会阻止后页的新纠正

205 条较旧普通事实均命中 `PagedCorrectionTopic production service port` 四词，最新纠正只命中 `PagedCorrectionTopic port` 两词。e35 首批选满 3 条就停止，最新 9090 未进入上下文。使用 e35 的真实 `BotHistoryContext` 与合成数据库，新增断言失败。

修复：related 不因已有 3 条证据提前停止，先完成有界候选检查，再分配最新有效纠正的证据位。SQL 使用 `LIMIT workCap + 1`（1201/901）保留一条 lookahead，防止无上限排序；单次游标避免每一页重复 OFFSET 排序。JS 仍限制 1200/900 条与累计 8000000 字符，并单独报告不完整结果。recent 本来按时间排序，得到 3 条有效样本可停止。

### P2：同毫秒更正缺少持久顺序

把旧 8080 与新更正 9090 设为同一 `created_at`，旧实现只比较时间，旧事实没有被撤销。新增方法回归失败。

修复：纠正来源保留时间和全局自增 `ordinal`；先比较时间，同毫秒再比较 ordinal。保留原有查询词近似语义，不声称实体级冲突解析。

## 新增验证深度

- 相同普通技术事实不带 SHA、带完整 SHA、含普通 cookie 术语，各自经过真正 `remember`、后台 `extractAndStore`、L1 持久化及**新会话** hybrid 回查。直写和提炼使用不同 Bot，避免重复去重导致假阳性。
- 入口合格但模型候选包含 Cookie 时，L1 仍拒收。
- 延迟 hybrid mock 在暂停前明确持有非空真实命中；关闭记忆后返回空，避免用原本无结果的查询假通过。
- 在真实 `BotPeerCallService` evidence 闭包中使用真实 `BotConversationMemory` / `MemoryService`：多 scope detach、过期、validFrom 后移，均撤下已预取的参考，而其他绑定仍存在。
- 恰好 1200 候选不误报不完整；1201 触发 lookahead 警告。少于行数上限但原文达到字符预算也必须明确报告。
- 窄范围独立静态审查指出初版游标仍让 SQLite 全量排序；已按建议加入 SQL LIMIT 后冻结。该审查没有冒充运行测试。

## 命令与本轮结果

所有 headless 使用 `TMPDIR=/home/vivion/i28tmp`。初次默认 `/tmp` 的 peer 用例遇到 `SQLITE_IOERR_WRITE`；该挂载在执行环境只读，改用本轮独立目录后通过，没有修改产品逻辑或失败基线。

- 精确红回归：`pnpm -s test:bot-history-context`，分别对 e35 安全规则、e35 历史函数复现上述断言失败；随后恢复固定源码。
- 已通过专项：`test:bot-history-context`、`test:bot-memory`、`test:bot-peer-calls`、`test:memory`、`test:memory-assistant-scopes`、`test:bot-memory-forget-watermark`、`test:bot-memory-runtime`。
- `pnpm -s typecheck`：PASS，web/node/scripts 新错误 0。
- `pnpm -s test:all`：**486/486 PASS**，失败 0、已知失败 0、新增回归 0，4.7 分钟；未修改失败基线。
- `pnpm -s perf:bot-history-recall`：PASS，30000 组 / 200 个来源，埋藏原问答找到。相关召回 median 130.05ms / p95 132.10ms；高频噪声 193.51 / 201.65ms；recent 27.04 / 27.35ms；无命中 103.41 / 106.77ms。没有把不同环境的旧报告数字当作本轮同机 A/B 对照。

逐用例结果、红回归断言与日志哈希、性能结果：[机器可读验证记录](evidence/issue28/0cb1ae71-verification.json)。

## 模型与未测

本轮新模型调用 **0**，新增模型费用 **0**。没有重复运行 e35 已报告的 9 类实模型批与 1100 组合成历史 + 真实 Bot 召回；那些结果属于上游报告，不是本轮最终源码的实模型通过声明。此轮修复的秘密过滤、候选选择和顺序问题用确定性最终上下文断言验收。

Team / Work / 项目范围完整实时模型矩阵仍未在本轮完成。相关隔离、公共共享、forget 后重启/迟到提炼有方法回归；它们不能替代完整 live 矩阵。没有打包、GUI/ARTIFACT 门禁或版本升级。
