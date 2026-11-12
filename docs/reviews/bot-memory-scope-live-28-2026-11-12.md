# #28 真实模型范围矩阵与撤权复核

## 基线与结果

生产基线为 `e47790045bd2286323bff1620866434bb741b2e9`，包含 #26、#27 和前一批 #28 修复。本批没有修改产品逻辑，只新增可复现验收驱动及证据。执行于 Omarchy 独立 clone，使用合成 HOME、SQLite、Bot/Team/项目和 native 日志，没有读取真实用户 profile 或凭据。

- 首批冻结源码 `a4725d786db41c254b4d98d62c8dc28556e09b54`：13 类，**23/24**。保留唯一失败，解释见下文。
- 调整验收条件后的冻结源码 `a41288742c96cd504734e210b8201ca420212243`：13 类，**24/24**。
- 两批各 38 次真实 Flash HTTP 调用：20 次有工具的业务请求、18 次无工具的辅助请求。分类依据请求是否含 tools，是可审计启发式，不是业务来源的通用证明。
- 每批 649 个编译输入/驱动/依赖锁文件的前后 hash 一致。各有 15 条 native context ledger 记录，保留来源引用，不内联合成参考码。

这不是 GUI 点击验收，也不是完整 Work 调度、验收、交付闭环。使用真实 `AgentService`，前台经过 `sendBotMessage`，任务经过 `prompt`、原生 admission/receipt、Durable 持久化及实际记忆投影。只给提供方接入本地无密钥 gateway，没有给模型手拼记忆上下文，也没有替换答案、提炼结果或检索结果。

## 矩阵

13 类实际任务为库存、会议议程、改写、排序、标点、单位换算、时长、姓名提取、清单、翻译、百分比、均分和温度换算。通常正例同时检查提供方请求与最终答案；修订批的 exactTask 例外，要求请求中存在而答案中禁止输出。所有跨 scope 反例同时检查请求与答案没有禁止的参考码。

- 个人 Bot：本人及明确公共共享可用，其他 Bot、双 Team、双项目和非公共 global 不出现。
- Team A/B 前台：各自 Team 加明确公共共享可用，不带负责人/成员私有 Bot 记忆，也不带另一 Team。
- 当前 conversation 的记忆在本会话可用；归档后新 conversation 不出现。
- 个人 Work：真实执行绑定确定 Work 和项目，即使 task 元数据指向另一个项目，仍以 Work 的项目为准。
- 同一 Work 两次独立 native execution：共享 Work、项目、负责人及 public；第二执行不取得首执行**未发布**的 task-only 参考码。
- Team Work：由真实 Team API 建立分工，通过原生执行 binding 运行成员；可用 Team、Work、项目及 public，排除负责人/成员个人 Bot、外部 Work、其他 Team/项目。
- 普通项目任务：P 的两个独立任务共享 P，Q 不带 P，P 不带 Q。普通非 Bot 任务保留既有 legacy global 合同；助手身份下非公共 global 被排除。测试没有扩大查询范围来取得正例。
- 多 scope detach：旧 task 拒绝恢复，原项目的新 task 完成且无撤权码；保留绑定的另一个项目仍可用。
- 到期、forget、memoryEnabled=false：先证明旧请求实际持有对应 L1，变更后重建服务；旧上下文以明确历史 Memory 不可见/停用错误拒绝，零业务推理；新上下文仍能完成任务且不带旧码。关闭开关的持久值读回仍为 false。

这些变更使用产品记忆 facade，不直接改记忆 SQL 行。Team/Work 拥有关系使用产品服务 API。头两批的“重启”边界是重新构建 AgentService 并重新打开磁盘 native 日志，不是完整进程重启；后续冷进程证据单列，不能混称。

## 首批失败及调整条件

首批要求首执行“列出所有当前参考码”，其中包含仅 task 范围的码。因此首执行把该码主动写进最终 Work 答案。随后：

1. `DurableWorkExecutionProjection` 把最终答案变成原生 observation summary。
2. `WorkNativeResultInbox` 把 summary 提交为 proposed Work deliverable。
3. `WorkMemoryCapture` 按既有合同复制到 work 范围的“Work 事实与未决事项”。
4. 第二执行取得这份 Work 成果摘要并复述该码。**原 task atom 本身没有被跨作用域选择。**

首批的 byte-level 禁止断言确实失败。它把已主动发布的 Work 成果与仍未发布的 task-only 证据混在一起；现有 Work 连续执行回归明确要求成果摘要在同 Work 可读。删除成果摘要既不能实现完整派生信息追踪，还会破坏已有工作延续能力。

第二批只调整驱动：首请求必须仍包含 task-only 码，但明确要求不得将其输出或发布到 Work 成果；首答案必须没有它；第二请求和答案仍必须没有它。独立静态复核确认这一改动区分了两种合同。**这不是产品漏洞修复，也不是原失败在相同条件下转绿。** 它证明未发布 task 证据的隔离，不证明信息一旦被主动发布为 Work 成果之后还能阻止全部下游传播。

原批次、原错误、答案和请求 hash 全部保留于[机器可读证据](evidence/issue28/scope-live-20261112.json)。

## 执行与模型用量

运行命令（固定对应源码 SHA）：

```sh
TMPDIR=/home/vivion/i28tmp BOT_RECALL_SCOPE_EXPECT_COMMIT=<40-character-sha> \
  node scripts/bot-recall-scope-live-test.cjs --live
```

零推理夹具检查：`node scripts/bot-recall-scope-live-test.cjs --check-harness`。集成 e4779004 后 `pnpm -s typecheck` 通过，web/node/scripts 新错误 0。没有重复之前已完成的全量 486 项或 30K 性能测试。

两批提供方均读回 `opendesign/deepseek-v4.1-flash`，每个请求都去掉 authorization，未继承调用者 API key。公开 `/models` 提供上下文与输出限制，驱动未自行伪造容量。全部 76 次请求有原始 usage：

- 首批：input 443952、output 9186、cached read 58240 tokens。
- 第二批：input 444025、output 7960、cached read 58368 tokens。
- 成本：实际账单金额不可得。SDK catalog 的零价格不能当作真实费用为零。

测试只验证功能，不使用此次运行耗时作性能结论。raw 请求、响应、原生 ledger 和编译输入清单保留在每个独立 out 目录；公共证据包含逐项结果、完整调用 hash/usage 和原始 report hash，没有上传真实用户资料。

## 完整进程重启补验

新增驱动 `scripts/bot-recall-scope-cold-test.cjs`，冻结 `15185ce5c81d57d92db761cc53895a524a41b31f`。验证前一批进程已退出；新 OS 进程重用其合成数据库与 native 磁盘日志，不重新创建或修补旧证据。前一批 commit 必须是本次 commit 的祖先，前一批所有编译输入 hash 必须保持一致，避免以新的产品实现冒充原 fixture 的冷恢复。

结果 **9/9 PASS**：

- forget、detach、到期三个旧 task 返回明确的历史 Memory 已撤销/不可见错误。各窗口业务请求 0、辅助请求也为 0。
- 六类新任务（库存、议程、翻译、单位换算、排序、清单）正常完成，撤权码与其他 scope 的码均未进入其业务请求或答案。
- 六个新 task 各自有一条新的 context ledger；没有拿继承的旧 ledger 数量当本次证据，没有内联参考码。
- 13 次真实 Flash HTTP 请求（7 次业务，6 次辅助），全部 HTTP 200 且有原始 usage。调用数不是任务数，一项任务使用了额外模型轮次。
- input 153647、output 3388、cached read 21120 tokens。三批共 **89 次**；费用仍不可得。
- 一次正常后台辅助提炼在用例窗口之外完成，记录为 background，不给它伪造 task 归属。进程退出后复核三批的全部响应 hash/status/usage 完整；冷报告的 finishedAt 早于最后这一辅助响应，不将其当完整网络结束时刻。
- **冷 OS 重启后的禁用开关未单独测。** 禁用已有前两批持久值读回、服务重建、旧会话拒绝及新任务无记忆的证据；本次不会扩大该声明。

运行方式：

```sh
TMPDIR=/home/vivion/i28tmp BOT_RECALL_SCOPE_EXPECT_COMMIT=15185ce5c81d57d92db761cc53895a524a41b31f \
  node scripts/bot-recall-scope-cold-test.cjs --live \
  out/diagnostics/bot-recall-scope/2026-11-12T04-37-09-135Z-2032402
```

该路径是本轮合成 fixture，不是用户配置目录；复现者应传自己完成的、未改编译输入的 24/24 live fixture。统一 typecheck 及最终脚本类型检查通过，新错误 0。详见[冷进程机器证据](evidence/issue28/scope-cold-20261112.json)。

## 完成边界

本报告补充 [前一批 #28 独立复核](bot-memory-recall-28-followup-2026-11-12.md)，不替代上游 1100 组长历史真实 Bot、技术文本与禁止保存负例及方法回归。不能因为此矩阵通过就声称完整派生信息防泄漏、所有 UI 路径或所有 Work 生命周期已经覆盖；是否关闭 #28 必须对照其原始完成标准，而不能随 #26/#27 状态自动关闭。
