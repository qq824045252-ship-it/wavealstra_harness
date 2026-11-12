# Issue #27：PDF 复核、补齐与逐项验收

## 1. 当前结论与证据范围

**S1–S3 关键链已按分批真实证据通过，但不能称全部 28 项或全平台全绿。** 最新产品源码 `b3e90b8516dba43a37bcbb22b5585e77321dda4a` 的六类 event-only Electron 批次自然 **exit 0、36/36 断言 PASS、57 次真实 V4.1 Flash 调用**，S2 三版本执行、去重、静默/通知及既有成果提醒已通过。相关专项、typecheck 与独立窄审也通过。最近一次完整 headless 仍是 `1c4966bd` 的 **484/484 PASS**，不是最新 SHA 的全量；其六类正文真实 Flash 为 **12/12 首答 PASS**。

三故事证据组合为 `5ba7e153` 长场景 + `1c4966bd` 修订/mixed 复验 + `b3e90b85` 事件 delta，并非最新 SHA 完整重跑所有 S1–S3。早期真实 FAIL 均保留，最新 S2 PASS 不回写老批。实体 960×800、1200×800 窗口已补充零模型实测通过；390 实体宽度受产品最小 960 限制，官方多主窗口仍不支持。跨端和完整测量仍有部分或未测项，它们不等于当前 S2 仍失败。主线已核实发布 `f463687f582a691b6153929dbbadb05d1e485b03`，#27 仍 open；verify 被手动停用，该 SHA 没有 CI run/check，**不是 CI PASS**。安全可补的验收现已完成，新增零模型提醒可见性与只读统计补证已冻结，仍须单独提交核验。

- 对照来源：[Issue #27](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/27) 及附件 `mybuddy_bot_scheduling_review_2026-11-11(1).pdf`。附件 23 页，逐页提取与 Issue 内嵌 PDF 原文去空白后均为 37,512 字符，内容完全一致。
- PDF 审查基线：`77d0d59a39a1e225288b46c722c18ba34636a19a`；本次施工起点：`14a650406359b5c4bd4cc358b2a7623364242298`。
- 日期：2026-11-12（Asia/Shanghai）；日志中的 ISO 时间及下述模型调用区间用 UTC。机器：Omarchy。施工 clone：`/home/vivion/github/wavealstra-issue27-completion-20261112`。
- 实机测试使用独立源码快照、HOME/profile、SQLite 和自有 Electron；没有修改用户原工作目录、重启用户实例或 Magpie。未运行产品 build、pack、安装或发行包验收。
- 本文 01–28 是按 **Issue §9** 顺序添加的对账编号，不是 PDF 原生编号。原 §9 本地对照在 `out/diagnostics/issue27-section9-source.md`。
- **PASS 只对注明的层级与范围成立。** 服务级故障注入可以验证状态机、持久化、工具准入和正文一致性，但不能替代 S1–S3、在途文件、忙时交互、真实 Electron 导航或重启。明确的本地测试数据允许用于真实任务链，但不冒充真实外部账号。
- [旧报告](bot-scheduling-27-2026-11-11.md) 只保留历史事实。其“最多四次续办”“运行中有界”“B-6 移至后续”等旧结论已经本轮重新审查，不能沿用为当前验收结论。

### 1.1 固定版本与测试账

| 固定源码 | 实际运行 | 结果与解释 |
| --- | --- | --- |
| `eef651e2602308d4298ae05f7eb640f17ecce351` | 第一批完整 Electron：11 类任务 + 8 个忙时短问，192 次 Flash 调用；第一批六类正文：12 次调用 | Electron 自然 exit 1；正文 11/12。发现真实产品失败，也保留后核确认的脚本误判。 |
| `f576144c79877c8179fe642932070638ff8f8ad5` | 首轮失败修复后 headless | 482/484，2 FAIL，exit 1。两项为已过期方法夹具契约，未改失败基线。 |
| `5ba7e153c258ea9b1574047bfd3585040b4d1340` | 仅纠正三份方法测试；完整 headless；第二批完整 Electron；第二批六类正文 | headless 484/484；Electron 276 次调用、exit 1，原 82/84 之外另发现真实缺口；正文 4/12，12/12 正文语义正确但 8 次精确路径选择失败。 |
| `bc9f23303f2fa4fa12fea41bac7004283cee894b` | 精确主成品短 ID 映射；完整 headless；第三批六类正文 | headless 484/484；正文 8/12，0 引用错误，仍有 4 次格式/字段契约失败。没有在此 SHA 重跑完整 Electron。 |
| `1c4966bde7778d4002d36724defce757f239d575` | 范围/通知证据/格式校正/修订交接窄修；专项、typecheck；第四批六类正文 | 专项、typecheck 及完整 headless 484/484 PASS；正文 12/12 首答 PASS。8 case Electron 130 HTTP、40/44 原始断言、自然 exit 1；两项后核脚本误判、两项真实 S2 失败，不能全绿。 |
| `b3e90b8516dba43a37bcbb22b5585e77321dda4a` | 来源事件 ID 传递、triggered_execution 与同版本续办继承；三项专项、typecheck、独立窄审 | 专项/类型/窄审 PASS；六类 event-only 36/36 PASS、57 次真实 Flash、自然 exit 0；不重复完整 headless。 |

`5ba7e153` 相比 `f576144c` 只有方法测试变更，产品、共享 schema、资源、package 与当时场景脚本相同。后续 `bc9f2330`、`1c4966bd`、`b3e90b85` 均有产品改动，因此不能把 `5ba7e153` 的 Electron 结果写成“最新 HEAD 完整 E2E 已过”。报告/证据提交也不改变它们各自实际测试的 SHA。

## 2. 本次实现与修复边界

### 2.1 运行中成果和前台调度

- `DurableWorkProgressReader` 读取本次 submission 的真实 LiveDoc。A 已完成而 B 仍在执行时，成功子项进入现有持久 inbox/PartialResults，不再只等最终 toolResult。可能由父调用恢复的临时失败不提前冻结为终态缺口。
- 每轮至多读一页 200 条原生记录，每批交付至多 40 子项；冷启动 45 项分批完整保留。只有 inbox 接收成功后才确认游标，失败重放同批；重启仍从持久事实恢复。游标不是第二份执行真源。
- 原生根记录终态但 harness 任务仍活跃时不丢子项；文件入口只来自已登记不可变快照。里程碑语义摘要含更正后的任务、摘要与文件证据，相同证据重放不重复通知。
- 跨会话前台队列按控制/短问优先级与保留容量调度；等待超过 30 秒的普通请求同时获得排序和准入机会，总并发仍不超过 10。提示优先级本身不修改事项，定位、归属和版本仍由原工具守卫。
- **性能边界：** 运行中读取已增量有界，终态仍进行一次完整输入核算。这不是任意长 transcript 恒定耗时的保证。

### 2.2 完成核对、续办与主成品

- 结果整理从本次已登记不可变快照读取实际文本，核对大小和 SHA-256，明确空文件、占位迹象、篡改、不可读、截断及未检查数量。正文作为不可信证据，不作为指令。
- 预算为每轮 20 文件、每文件实际读取不超过 1 MiB、正文不超过 12,000 字符、总正文不超过 48,000 字符。二进制及超预算证据明确不可用；没有实现或声称 PDF/PPT 渲染、图片/OCR 验收。
- 续办依据真实持久进展，不以固定第二次/第四次截止；新 binding ID 或改写同一摘要不算进展。unknown 动作不重放；独立只读补查在实际工具准入处拒绝写入，不依赖已退休的授权 scope，也没有新增权限框架。
- 宿主不继续时整体替换未获支持的继续承诺，正文、outcome、nextStep 同步，不靠关键词删除几句模型话术。
- `bc9f2330` 起，当前 availableFiles 提供短 selectionId，宿主只还原该上下文的精确已登记 ref。未知/旧上下文 ID、大小写变化、Unicode 归一化或只猜文件名均不接受。未选为主成品的真实附件仍可在“其他文件与引用”找到。
- 文件集合、正文证据、Bot、事件和稳定语义上下文参与结果缓存；仅排除重试时钟。同证据关闭重开复用原结果，证据变化不能借旧 ID 选择新文件。

### 2.3 未来安排、真实文件事件及同源去重

- ongoing 有可行动步骤即可立即执行，不必虚构 cron/nextWakeAt；持续执行与只读 observe 区分，需要等待才保存真实时刻或已支持事件。一次未来执行完成原一次目标后结案，不误当无限持续目标。
- `work_watch_sources` 只公开同时具备 adapter 与 receiver 的能力。当前文件来源是实际 fs.watch、来源回读、版本 hash、ingress 和派发；PR JSON 为显式测试输入，**不是 GitHub webhook**。
- file receiver 限已存在的规范绝对路径常规文件、每文件 4 MiB、至多 64 订阅；覆盖 atomic rename，同 bytes 不产生新事件。只保证 latest/skip，不保证离线期间所有版本。暂停/取消/关闭释放监听，读取失败不得伪报 unchanged。
- 来源稳定键为 provider/account/objectId/action，version 单独保存。双观察器同版本关联原 Work，已处理版本不重复建单/催促；可比较的新 revision 更新原来源输入，关闭后的新回归关联原事项。
- **去重边界：** 单调 revision 必须有可信源端回读/比较依据，不能用本地到达时间或模型自编序号替代。不可比较 opaque version 返回 `source_version_unverified`；首次缺 revision 的历史来源缺比较基线。这里不宣称任意外部来源、任意跨渠道去重已完成。
- 纯提醒可引用原会话已有 Work 的已登记不可变成果，到期直接发送原提醒正文和已有文件，不调模型、不建 Work、不重跑业务。hash/大小/权限或预算不满足则如实说明，不从任意输入路径取文件。

### 2.4 `1c4966bd` 的范围、格式及修订修补

1. **当前 Work 的验收范围。** `single_work` reviewTarget 取精确 binding 持久 executionInput；完整原用户要求保留，助理计划只是建议，不能删用户约束。独立提醒缺回执不拖死检索 Work，也不因此宣称提醒成功。范围与原文纳入缓存、review 身份及模型后复读。
2. **条件通知的产物正文证据。** 仅当前 binding 登记、当前 result 明确引用、hash/size 匹配且全文未截断的 text 可作通知依据；ID 绑定实际来源与版本。旧 lineage 文件仍可显示，不能冒充本轮证据。来源集合参与缓存和复读，不扩展 stop、unknown 独立性或只读权限。
3. **一次持久格式校正。** 完整回复发生 Syntax/Zod 错误才允许一次无业务工具纠错；固定 requestId 重开复用，原回复保留。可解析的 decision/outcome 由宿主硬锁；纯非法 JSON 无可锁字段，不能声称机械保证自然语言语义不变。合法首答不增加调用，第二次错误仍失败。外层原两次 attempt 保留，最坏四次生成，不重跑业务。
4. **真实子代理收到冻结修订。** 每次 dispatch 定点读取原生 operation 的冻结 submission 并 memo，将完整最新用户修订、有界 handoff 和至多 4096 B 的建议计划传入实际 child，不查询最新可变 Work、不额外扫描产物或整段历史。
5. **缺父 result 的子项事实。** 仅核精确 pi.tool owner/callId 和至多 250 个直属 child 身份/回执；分页不全或身份不足为 unknown，明确 aborted 才是 stopped，只有证明无 child 才是 not_started。stopped 不证明无副作用，也不授权重跑。第二批原 r1 store 的离线副本经生产投影后，真实 B child 122 为 stopped/child_unanswered:aborted；原 store 未修改或 resume。

这些修补已有生产方法、SQLite、实际工具准入及本地 fake 模型 transport 的专项证据。fake 模型本身只能验证冻结修订进入 child 和缓存/纠错分支。当前 Flash 短批另有真实 receipt 证明受控修订中的 A 不重写；这不等于整批 S2 或所有自然任务已通过。

### 2.5 源码与行为证据入口

以下链接随对应源码提交固定，实际测试 SHA 仍以 §1.1 为准。

| 路径 | 生产实现 | 主要行为测试 |
| --- | --- | --- |
| 在途成果与有界读取 | [DurableWorkProgressReader](../../src/main/agent/durable/DurableWorkProgressReader.ts)、[WorkMilestones](../../src/main/agent/work/WorkMilestones.ts) | [scheduling-gaps](../../scripts/bot-scheduling-gaps-test.ts)、[work-milestones](../../scripts/bot-work-milestones-test.ts) |
| 完成范围、正文与精确选择 | [WorkCompletionReviewTarget](../../src/main/agent/work/WorkCompletionReviewTarget.ts)、[BotWorkResultTurn](../../src/main/agent/work/BotWorkResultTurn.ts)、[WorkResultArtifactSelection](../../src/main/agent/work/WorkResultArtifactSelection.ts) | [automatic-completion](../../scripts/bot-work-automatic-completion-test.ts)、[artifact-selection](../../scripts/bot-result-artifact-selection-test.ts) |
| 可靠性与条件通知 | [WorkContinuationProgress](../../src/main/agent/work/WorkContinuationProgress.ts)、[WorkWatchSupervision](../../src/main/agent/work/WorkWatchSupervision.ts) | [continuation](../../scripts/bot-scheduling-continuation-test.ts)、[watch-supervision](../../scripts/work-watch-supervision-test.ts) |
| 当前修订传入实际 child | [DurableWorkRevisionContext](../../src/main/agent/durable/DurableWorkRevisionContext.ts)、[DurableSubagents](../../src/main/agent/durable/DurableSubagents.ts)、[DurableMissingSubitems](../../src/main/agent/durable/DurableMissingSubitems.ts) | [durable-subagent](../../scripts/durable-subagent-test.ts)、[delegation-fidelity](../../scripts/bot-delegation-fidelity-test.ts) |
| 实际文件来源及关联去重 | [WorkFileEventSource](../../src/main/agent/work/WorkFileEventSource.ts)、[WorkSourceAssociation](../../src/main/agent/work/WorkSourceAssociation.ts) | [scheduling-gaps](../../scripts/bot-scheduling-gaps-test.ts)、完整 headless 门禁 |
| 真实模型/桌面批次 | [live runner](../../scripts/bot-scheduling-live-test.cjs)、[live scenario](../../scripts/bot-scheduling-live-scenario.cjs) | [六类正文 runner](../../scripts/bot-completion-evidence-live-test.cjs)、下列逐批原始证据 |

## 3. §9 逐条验收矩阵

| 编号 | 验收项 | 状态 | 证据与未覆盖范围 |
| --- | --- | --- | --- |
| 01 | 11 类分流；直接答、短工具/单步不平白建 Work | PASS（已测 11 类） | `5ba7e153` 实际提交直接答、天气、状态、提醒改期、分析、执行、提醒、定时、事件、持续、混合；短路径未以 Work 代替。混合结案及改向缺口另见 02/05，不把“前台完成”当全部目标完成。 |
| 02 | 混合请求先答，Work/提醒关联原请求且不重做 | PASS（`1c4966bd` 实链） | `1c4966bd` 短批混合检索真实修复、records 保留且 closed/succeeded，独立提醒按同 request 关联。真实登记 txt 内容为诊断/验证 JSON 与 EXIT=0；脚本硬找 verification.json 的原 FAIL 保留并单列纠正，不影响本批 S2 的真实失败。 |
| 03 | B 仍运行时 A 快照可见/可打开，最终保留 A | PASS（实链） | 第二批实际 A 早交付/快照点击/最终 A+B 有证据；`1c4966bd` 受控门槛再次取得 B 忙时 A 真交付，修订后 A 只写一次、digest 不变。第二批重复写的失败历史仍保留。 |
| 04 | 进度读持久事实，不新建/等待 B/令 B 重写 | PASS（第二批实链 + 服务） | 真实中途查询与里程碑同源；增量读、失败重放、冷启动 45 子项方法回归。前台仍需模型时间，“即刻”不被改写成 500 ms SLA。 |
| 05 | 并行改向/停止命中正确 Work，工具边界生效 | PASS（`1c4966bd` 受控修订 + 已测暂停） | `1c4966bd` 短批同 Work 1→2 成功，原生 receipt 证明 A 一次、旧 B 一次、新 B 一次，A digest 不变，冻结修订进入实际 child。精确暂停和独立 Work 不受影响有第二批证据；不把局部通过当整批通过。 |
| 06 | 提醒创建/修改/到期/恢复；到期 0 模型、0 Work | PASS（实链 + 生命周期回归） | 第二、三批均有同 ID 改期、单次到期、0 模型/新 Work/benchmark 重跑及旧快照字节核验；第三批按钮已点，但 JSON 默认查看器未成功打开，不记打开 PASS。暂停/恢复与幂等另由服务回归补足。 |
| 07 | 定时真执行、正确来源版本、unsupported 明示 | PASS（已测定时与本地事件关键链） | `5ba7e153` 一次定时实执行；`b3e90b85` V2/V3/V4 各真实执行一次，首基线/登记/通知、同 bytes 去重、无退化静默、退化通知均通过；本批 36/36、exit 0。仅本机 fs.watch，不是外部 webhook；不回填旧缺事件 ID 的派发绑定。 |
| 08 | 持续行动→验证，新实测更新原成果 | PASS（第二批实链） | mini-DOM 真实优化→无障碍步骤→DATA-V2 后 8,200 行实测，追加原 CSV；等待实际事件，不靠定时看一眼替代执行。此长场景未在 `1c4966bd` 重跑。 |
| 09 | 充分 unchanged 时 review 0；来源失败不静默 | PASS（实链 + 负向服务回归） | 第二批原生充分 read/登记后真实 host_proven_unchanged，review attempts=0、通知=0；读取失败/unverified/偏好变更等由生产方法负例验证，不伪称真实外部故障测试。 |
| 10 | S1–S3 三故事，包括提醒改期/天气不串扰 | PASS（分批关键链，非同 SHA 全重跑） | `5ba7e153` 长 mini-DOM/天气/持续目标与提醒独立性，`1c4966bd` A/B 修订复用及 mixed 成功结案，`b3e90b85` 只复验事件 delta 的 S2 三版本/去重/静默/通知/提醒。b3 批次已 36/36 自然 exit 0；不能称 S1–S3 全在 b3 完整重跑。 |
| 11 | 会话/团队/Work/渠道/归属/版本隔离、去重、重启 | 部分（本机路径通过，真实跨端未测） | 服务隔离、第三批两个真实会话往返/0 额外模型、正常重启回原会话/订阅均通过；零模型实体窗补证保留同原会话。旧 l4 一次 UI 重启新增 offline-gap blocker，不是重复结果/提醒，before/after 保留。QQ 等真实跨端未测，见 #29/#31。 |
| 12 | 紧凑分页、按需详情与长对话不因回报全扫 | PASS（有界运行路径） | 200 条/页、40 项/批、游标重放、query-scale 与 Electron lazy detail 回归；终态仍一次完整输入核算，不承诺无限长历史恒定耗时。 |
| 13 | 第三次有真实进展仍续做 | PASS（生产服务故障注入） | `bot-scheduling-continuation` 实际持久进展与第三次产物 bytes 变化获准续办，五次进展续办均执行；无进展对照停止。不是长期外部业务 E2E。 |
| 14 | unknown 写不重放，独立只读仍可推进 | PASS（生产服务故障注入） | 真实 admission/SQLite unknown 保留；原 action 不重新派发，当前独立只读计划实际拒写。团队恢复/监督专项同过；未制造真实支付等外部未知副作用。 |
| 15 | 宿主不继续，主回复不承诺继续 | PASS（生产服务故障注入） | 无进展/同 lineage unknown/watch 拒绝续办后，实际投递正文及报告整体改写，outcome/nextStep 一致；不是只检查提示词。 |
| 16 | r2 有效成果不被无关旧 r1 unknown 拖死，保留风险 | PASS（生产服务故障注入） | 真实 settleAdmission→诊断→amend→r2 路径与结算检查；无关旧风险留存、当前依赖/unknown 仍不能假成功；旧运行与回执不改写。不证明任意迟到外部写入已撤销。 |
| 17 | 本次登记内容证据；文件名/空占位不假完成 | PASS（受支持文本范围） | `1c4966bd` 六类 12 例真实 Flash 首答全过，6 缺项 partial/6 完整 completed，12 精确引用；空/占位/篡改/预算另有方法负例。不是业务执行 E2E、PDF/PPT/OCR 或任意二进制保证。 |
| 18 | 同源多观察器去重、已处理不催、新回归关联 | PASS（可比较来源范围） | 实际 SQLite 双观察器/版本/乱序/重启回归；真实文件同 bytes 重写不增 inbox/binding/runlog。opaque/unverified 安全拒绝，不宣称任意外部 adapter 已接通。 |
| 19 | 跟踪 B-3：300/301/SHA/hybrid | PASS（仅跟踪） | [#28](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/28) 已建/open；缺陷未在本轮修好，#26 不是替代覆盖。 |
| 20 | 跟踪 B-4：桌面→QQ→桌面、task/bot scope | PASS（仅跟踪） | [#29](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/29) 已建/open；跨端身份与自动记忆差异未实现/未实测。 |
| 21 | 跟踪 B-7：个人跨 Work Skill 与修订收益 | PASS（仅跟踪） | [#30](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/30) 已建/open；不以 Skill 数量或读取次数当真实复用效果。 |
| 22 | 跟踪跨渠道主动文件及常驻宿主 | PASS（仅跟踪） | [#31](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/31) 已建/open；本地事件/提醒不代表 QQ/Discord/钉钉送达或离线电脑外常驻。 |
| 23 | 首实质答、真正可用部分、最终可用时刻 | 部分（持久成果时刻已补） | 第二至四批按真实 request/message 与登记不可变快照补齐阶段时间，见 §6.2/§6.4；失败结案中的可用文件不等于整体成功，持续目标无最终完成时刻。仍不是所有场景的真实输入→GUI首见测量。 |
| 24 | 入库→可见、插话→版本生效、忙时 P50/P95 | 部分（有界可见性/控制时刻已补） | 第二批忙时8样本、首A createdAt→按钮775ms；两批改向时刻见§6.5。零模型纯提醒8样本DOM首见经验P50界183.33–194.68ms/P95界198.57–209.54ms，7条自动进入视口另计，屏外第8条手动滚动单列，见§6.6。精确事务commit→paint及其余类别仍未测。 |
| 25 | 每目标分阶段模型/工具调用、重复及承诺错配 | 部分（阶段/完整诊断已补） | 第二/三/四批HTTP仍276/130/57，精确token/时刻补证后未知1/1/0；真实诊断工具266/129/45，原transport可见264/127差额为取消后失败工具，计入成本。独立总结/观察阶段、金额及全量承诺错配计数仍未知。 |
| 26 | 各类各自先实测再设目标，不以收条冒 SLA | 部分 | 11类前台、忙时样本及第二至四批登记附件时刻分开呈现，事件/定时包含主动等待。离线审计未增加模型样本；另8条零模型纯提醒只有单路径小样本经验分位界，不外推Work/模型回复或通用SLA。各类别完整屏幕可见分布仍未测。 |
| 27 | 隔离 profile 真 Electron+模型+任务链全项 | 部分（本机受支持窗宽通过） | 四批实链及零模型复制 profile 实体 960×800/1200×800 无溢出、原会话文件按钮可见均通过；独立 profile 的8条纯提醒自然投递、0新模型/Work并完成有界可见性采样。390 请求被钳 960，旧 CDP390 非实体窗；真实第二 instance exit0 且只留原窗，符合 singleton，不算多主窗通过。JSON 外部打开仍未证实。 |
| 28 | 固定 SHA 的通过/失败/未测、证据/命令/限制 | PASS（报告记录）；CI 未运行 | b3 实链 36/36、最后完整门禁 1c 484/484；f463687f 已在 main 核实，#27 open。verify=disabled_manually，固定 SHA run/check 均0，不是CI PASS。本次新增补证待单独提交，UI/metrics边界不抹去。 |

## 4. 历史真实失败与修复复验

### 4.1 第一批 Electron：`eef651e2`，未通过

11 类任务及 8 个忙时样本，192 次 `opendesign/deepseek-v4.1-flash`，自然 exit 1，冻结源码前后 hash 相同。[简明证据](evidence/issue27/eef651e-electron-first-batch.json) 指向冻结副本的原始 report、provider 请求、数据库及截图。

- 真实 A 已在 B 仍运行时可点击；mini-DOM 实测中位 33.7→14.7 ms，8,000 行不丢，DATA-V2 后 8,200 行更新原 CSV。它是合成测试页面，不是用户产品首屏性能。
- 真实失败包括：最终 B 复核忽略已投递里程碑而误判未完成；改向后重写 A；共享标题片段误拒暂停；一次未来目标错误保留为长期目标；S2 生成 benchmark.json 却只登记另一个报告；简报缺原生读取证据无法走 unchanged。后续修补不改写首批失败结果。
- **更正此前对 latest 空 FK 的归类：** 首轮只按 binding.inbox_event_id 单独 join 为空，本身不足以判定整个事件未受理；当时用来源版本/输入快照补查只能证明 ingress 与关联事实，不能证明执行上下文完整。当前真实短批进一步证明 source 派发确实漏传 inboxEventId，导致 binding 缺来源事件、原生输入丢 sourceEvent/watchFollowUp，影响执行阶段。因此撤回“此项只是脚本假设差异/纯误判”的结论，按真实产品缺陷修复；首轮原始报告和后核记录不覆盖。
- 其余两类仍为已核实的脚本误判：后来的暂停计划不能反推首次未立即执行；同 eventId 的 A 和 A+B 不同内容不是重复投递。
- 首轮未捕获 DOM 里程碑时刻，重启因持续简报超时未执行，提醒当时还没有成品附件入口，均不补写为通过。

此前还有一次被用户要求停工而安全中止的预检批，隔离 HOME `/home/vivion/iq27-live-59ntH9`，70 条请求诊断（停止点 69 完成、1 进行中）。它不是完成批次或 70 个完成目标；旧 `scheduling-progress.json` 中 running 为中止时检查点，不代表仍运行。停止仅针对该批自有进程。

### 4.2 第二批 Electron：`5ba7e153`，仍未通过

[简明证据及原始文件 hash](evidence/issue27/5ba7e153-electron-second-batch.json)。真实 11 类任务 + 8 忙时短问，276 次 Flash；冻结 runtime fingerprint 前后相同。原报告 **82/84**，自然 exit 1；后核真实缺口未被原计分捕获，因此不得只引用 82/84 作为整体成功率。

**取得的实际成功证据：** A 早交付并实际点击；同一 B Work 修订 1→2，独立分析 A 未被改向；最终 B-AMENDED 真实登记并成功结案。mini-DOM 优化、无障碍、DATA-V2 后追加原 CSV 与精确暂停通过。定时一次执行产物后 closed/succeeded。fs.watch→回读→benchmark 及相同 bytes 去重通过；PR-V4 受控退化确实通知。已有成果提醒同 ID 改期，到期 0 模型/0 Work/0 benchmark 重跑，实际打开字节相同快照。自有 Electron 正常退出重启回原会话，订阅恢复；充分 read/登记证据的 unchanged 轮 review 0、通知 0。

| 真实缺口 | 证据与修复位置 |
| --- | --- |
| PR-V3 无退化却通知 | benchmark.regression=false，模型也给 not_met；来源读取走 bash，没有结构化 readEvidence，宿主拒绝仅摘要引用。`1c4966bd` 增加本轮登记且完整 hash/size 核验正文的通知证据；结合后续来源阶段修补，`b3e90b85` 实际 V3 已执行/登记后 silent，0 result 通知。旧批失败仍保留。 |
| 混合检索已修复却错误结案 | records 未改、diagnose/verify 真实完成；独立提醒创建到期。结果模型却把独立提醒缺回执当检索 Work 缺项，closed/ended_unsuccessfully。当前精确 binding reviewTarget 已修，`1c4966bd` 短批真实检索已 closed/succeeded；独立提醒按原 request 关联，实际诊断/验证产物已登记。 |
| 修订后新 child 重演旧 A/B | r2 收到 handoff、先回读 A，仍将 A 从 7 字节改为 8 字节带换行；B-ORIGINAL 两次、B-AMENDED 一次。receipt 证明第二次写来自 r2，不是旧 r1 在途重试。当前冻结用户修订传 child 与缺父 result 的真实 child 状态已修；`1c4966bd` 短批实际 A/旧 B/新 B 各写一次，A digest 不变。 |

**脚本误判不混入产品通过：** 原 brief 的当前内容明确 SOURCE-V2/confirmed Friday，SOURCE-V1/pending 只在标明的历史段。禁止全文出现任何 V1 的断言过严。原 report 原样保留，后核单列；正确验收口径是核对当前版本、原文和登记 bytes，不禁止明确标示的合法历史。后续短批没有重跑这段长简报，不能把后核纠正冒充新的模型执行。

**失败成本不剔除：** S1 第一次误选 agentScope=project 导致 Unknown agent，模型自行查阅并纠正，所有相关调用计入 276。PR-V3 结果复核首轮约 2.206 s 已有首 delta，59.962 s 被 60 s 上限中止；第二次 57.062 s 完成，completion 5,587，其中 reasoning 4,971。不是网关始终无连接，也不是因第三批 B6 并发导致该次超时。

## 5. 六类登记正文：四批真实 Flash 账

六类均为销售 CSV、项目报告、代码测试证据、翻译、操作清单回滚、结构化订单 JSON，每类一缺项一完整对照。通过生产 `inspectDurableArtifact → WorkGeneratedArtifacts.record/submitDeliverable → completionArtifactEvidence → BotWorkResultTurn.review` 与真实模型 transport。正文、binding 和完成摘要是**显式夹具**，不是业务原生执行、Electron UI 或完整 Coordinator 结算 E2E；也未用篡改文件替代语义缺项。

| 批次/源码 | 严格总结果 | 真实失败或复验结论 | 调用 |
| --- | --- | --- | --- |
| [第一批/eef651e2](evidence/issue27/eef651e-registered-text-first-batch.json) | 11/12 | 六负例均 partial，五完整例 completed；销售完整例 JSON 前多自然语言，严格解析失败。准备单例重试时源码门禁在 HTTP 前拒绝，新增调用 0。 | 12 |
| [第二批/5ba7e153](evidence/issue27/5ba7e153-registered-text-second-batch.json) | 4/12 | 12/12 正文语义正确，8 次路径 ce-bEUAMi 被改为 ce-BEUAMi，主成品选择无效。宿主精确过滤，真实文件仍在折叠区；不能因语义正确把总结果标绿。 | 12 |
| [第三批/bc9f2330](evidence/issue27/bc9f2330-registered-text-third-batch.json) | 8/12 | 2 次完整例纯自然语言而非 JSON；2 次负例 deliver 却填 missing。9 次非空短 ID 精确映射、1 次正确空选择、2 次未解析，0 路径引用错误。没有外部重试/放宽断言。 | 12 |
| [第四批/1c4966bd](evidence/issue27/1c4966bd-registered-text-fourth-batch.json) | **12/12 首答 PASS** | 六负 partial、六正 completed，12 个短 ID 精确还原，0 引用/格式错误。候选正文和脚本与第三批相同，229 编译输入 hash 前后不变。**内置格式校正实际 0 次，外部重试 0 次。** | 12 |

第四批全部首次合法，证明当前这 12 个真实样本通过，**不证明真实模型触发纠错分支时已测，也不抹掉前三批失败**。纠错语义硬锁/错误拒绝/重开缓存目前由方法与本地 fake transport 验证。

| 批次 | HTTP 区间（UTC） | prompt / completion / total | cached prompt / reasoning |
| --- | --- | --- | --- |
| 第一批 | 2026-11-11 22:34:27.359–22:35:33.197 | 31,738 / 6,250 / 37,988 | 14,208 / 4,146 |
| 第二批 | 2026-11-11 23:21:56.058–23:23:05.199 | 33,610 / 6,905 / 40,515 | 24,576 / 4,833 |
| 第三批 | 2026-11-11 23:33:51.400–23:34:56.940 | 35,241 / 5,718 / 40,959 | 22,528 / 4,274 |
| 第四批 | 2026-11-12 00:02:45.344–00:04:16.367 | 37,693 / 8,353 / 46,046 | 23,040 / 6,879 |

全部为 `opendesign/deepseek-v4.1-flash`。接口未提供可核验金额，货币成本未知，SDK 的零费率不能解释为免费。每批简明 JSON 保存源码/编译/请求与结果 hash、各例判定、原始诊断目录及覆盖限制；原始请求/响应未用摘要替代。

## 6. 响应、成果时刻与调用成本

### 6.1 忙时短问与可见性

| 实际批次 | 样本 | 首实质回答 P50 / P95 | 前台完成 P50 / P95 |
| --- | --- | --- | --- |
| eef651e2 | 8，4–5 个 Work 活跃 | 8.792 / 15.216 s | 9.134 / 15.922 s |
| 5ba7e153 | 8，多 Work 活跃 | 10.063 / 14.908 s | 10.478 / 15.035 s |

按 empirical nearest-rank；排除“收到”“我来查询”等空收条/计划话语。是小样本，不是 SLA，不把不同负载两批直接当优化对照。两批各自 8 个忙时样本都在对应 B6 调用前结束，当时没有并行 headless；之后共享网关/门禁重叠另在证据记录，不称全程独占。

第二批首 A 持久消息 createdAt→按钮出现在 DOM 且 viewport 可见为 **775 ms**。另两次 DOM present 为 1,012/1,221 ms，但进入 viewport 为 140,622/55,951 ms，涉及后来滚动，不能混作自动可见延迟。观测来自 DOM mutation/history 获取后的 rAF，既不是 SQLite 精确 commit 时刻，也不是精确屏幕 paint。

### 6.2 按任务类别保留实际样本

第二批 `report.json.cases[].timing` 的首次实质宿主文字/前台完成（秒）：

| 类别 | 首实质文字 | 前台完成 |
| --- | --- | --- |
| 直接回答 | 44.923 | 44.988 |
| 天气短查询 | 11.671 | 12.573 |
| 状态查询 | 11.003 | 11.296 |
| CSV 分析 | 34.008 | 40.911 |
| A/B 实际执行 | 39.933 | 53.188 |
| 纯提醒创建 | 48.516 | 48.770 |
| 定时实际执行受理 | 25.176 | 25.872 |
| 文件事件受理 | 18.011 | 40.175 |
| 持续优化受理 | 11.432 | 26.113 |
| 持续简报受理 | 16.353 | 28.163 |
| 混合请求 | 7.285 | 15.577 |

这些是单次并发突发下的宿主文字/前台受理完成，不是后台目标完成，也不是原生键盘输入到屏幕可见时延。轻量提醒改期另有实际 tool/到期证据，不把它混进独立长任务。直接答 44.923 s 这个较慢实测仍保留。

同批按原请求与持久成果消息复核：A/B 请求→首 A 里程碑 **233.287 s**，→最终双文件结果 **451.964 s**；独立 CSV 分析→含真实附件的结果消息 **75.306 s**。原始定位为第二批 `report.json.history.messages` 中 messageId `work-feedback-f419881aac2cf1352142f5719fbc2efaaa21fa907c478d49bb3e0eba6548c8e4` 的首 A 消息及最终 result 消息（createdAt 分别 1794439418335、1794439637012）；独立分析 result 的 createdAt 为 1794439260539。分析 case 原来的 267.766 s 是后来查询观察时刻，不是首份可用成果时刻。上述仍是持久投递/已验证快照时刻，不冒充逐项 GUI 首次看见；未测的场景阶段保持未测。

### 6.3 离线补证：阶段调用、完整工具数与不一致

[只读时刻及调用审计](evidence/issue27/saved-timing-accounting-audit-2026-11-12.json) SHA-256 `32cf7f59e48562637c2633eae7a947c415531d1b7a1968f7933b50156d75ff73`。只读取保存的 SQLite/原 HTTP/usage/receipt，**新增模型调用 0、产品或 harness 运行 0**。三个 DB 读前后 hash 不变；第四批使用后来 UI 重启前留存的 `before-app.db`，不把后续 blocker 混进原批终态。

先要求诊断开始位于 HTTP 前 0–1000 ms、结束相差不超过 10 ms，且 completion tokens 及 prompt=input+cacheRead+cacheWrite 精确相同；不满足时仅保留原本唯一 ±100 ms 开始匹配。映射须一对一，review 还用原始结构化 context.workId 核归属。逐条 transportIndex/diagnosticId/方法/时差保留在 JSON。它是事后相关性，不是从入口贯穿的 request-ID trace，歧义不猜测。

| 实际批次 | 前台 | 原生主执行 | 原生 child | 普通完成复核 | Watch 结果复核 | 未归属 | HTTP 总数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5ba7e153 | 65 | 178 | 20 | 3 | 9 | 1 | 276 |
| 1c4966bd | 24 | 81 | 16 | 4 | 4 | 1 | 130 |
| b3e90b85 | 15 | 37 | 0 | 2 | 3 | 0 | 57 |

单独总结和原生观察可能发生在执行 generations 内，没有独立插桩，均为 **null/未知，不是 0**，不可捏造阶段再加总。每个目标的 initial foreground、执行/child/review、实际工具及来源 ID 在补证 JSON 中。货币成本仍未知。

| 批次 | 原 HTTP transcript 可见唯一 toolCallId | 完整持久诊断唯一 toolCallId | 差额 |
| --- | --- | --- | --- |
| 5ba7e153 | 264 | **266** | 取消后失败 subagent、bash 各1，没有进入后续模型请求 |
| 1c4966bd | 127 | **129** | 取消后失败 subagent、bash 各1，没有进入后续模型请求 |
| b3e90b85 | 45 | **45** | 0 |

失败工具仍计入实际成本；failed/stopped 不证明没有副作用。原 compact 的264/127并非完整工具总数，作为旧“transport可见”口径保留，不覆盖原证据。原第二批 Work199/前台65/未知12、第三批111已匹配/19未知、第四批50已匹配/7未知，是早期较粗归属；本次使用新增时间+精确usage证据将未知降至1/1/0，没有增加或删除任何真实 HTTP。

scope 误选/模型自恢复、第二批 A 重写两次/旧 B 两次/新 B 一次、错误通知与混合错误结案都保留。仍没有全量独立总结/观察阶段、全部承诺与状态错配计数或可信金额，因此矩阵25继续部分。

### 6.4 离线补证：真实登记附件的投递时刻

只计同 Work 已登记 snapshotPath 且现存 SHA-256/size 与登记相符的不可变文件；未登记 working-path 引用保留在原消息，但不为其历史字节或可用性背书。下表从原请求 submittedAt 到持久消息 createdAt，**不是精确 DB commit、按钮可见或屏幕 paint**。

| 批次/目标 | 首个合格附件投递 | 最终状态/说明 |
| --- | --- | --- |
| 5ba 混合检索 | 90.481 s | 文件可用但原 Work ended_unsuccessfully，仍是错误结案，不能据文件宣布整体成功 |
| 5ba 持续优化 | 160.980 s | 原 CSV/代码等已登记；持续目标无最终完成时间 |
| 5ba 持续简报 | 104.460 s | 初版brief；持续目标无最终完成时间 |
| 5ba 定时读取 | 168.509 s | 成功最终附件，包含等待到点的时间 |
| 5ba 独立分析 | 75.306 s | 成功最终附件；纠正原稍后观察267.766s口径 |
| 5ba A/B | A 233.287 s；最终451.964 s | 已登记A早交付；旧r1仅含未登记working-path的结果不另算合格交付 |
| 1c 分析 / 执行 | 62.248 / 60.356 s | 两个一次目标成功最终附件 |
| 1c mixed | 131.870 s | 成功最终诊断/验证附件；更早97.445s无合格不可变引用，不算成品交付 |
| 1c 改向 | A 47.435 s；最终B 156.737 s | A保持原字节；最终新B交付，沿用此前A成果 |
| b3 分析 / 执行 | 45.115 / 42.854 s | 两个一次目标成功最终附件 |
| b3 事件首benchmark | 127.911 s | 实际benchmark.json，而非只登记状态报告；包含等待来源变化，不是纯处理延迟 |

第二/三批事件目标还有状态报告与后续成果的时间，补证 JSON 分开记录 first verified artifact 与 first requested benchmark。不能把较早状态报告当作已完成 benchmark。各批负载、任务内容和等待不同，不据这些单次时刻宣称优化倍数或通用 P95。

### 6.5 离线补证：插话到新版本与工具生效

用原 user messageId 关联 intent snapshot.source_message_id，再定位精确 Work 的 r2 binding、admission 和最早实际 task_tool_diagnostics.started_at。下表起点是用户消息持久 createdAt，不是物理按键或精确事务提交。

| 改向批次 | r2 revision / amend receipt | r2 binding submitted | 首r2实际工具开始 |
| --- | --- | --- | --- |
| 5ba7e153 | 14.930 s | 15.487 s | 26.163 s |
| 1c4966bd | 23.933 s | 24.385 s | 28.827 s |

两批已失效 r1 在 revision 变化后均没有新的工具开始记录；已在途工具可能到取消时才结束，不证明既有效果已撤销或未发生。第二批 r2 重写旧A/B的失败不会因 r1 未再开新工具而消失。纯提醒有界可见性补证见§6.6，与这里的改向时刻分开，不冒充 commit→paint。

### 6.6 零模型纯提醒：持久化到 DOM/视口的有界采样

[8条提醒采样证据](evidence/issue27/b3-zero-model-reminder-latency.json)，17,692 B，SHA-256 `d436b245ddda15a88ac217bc83cb32ebd923d44d1aa1264c0f33ad80bb60c7fe`。使用 `b3e90b85` 冻结源码、独立新 profile 与真实960逻辑宽度窗口，经官方 `window.api.cron.upsert → CronService → CronReminderDelivery` 创建8条一次纯提醒，间隔3秒；没有直接写业务数据库。8条均自然 delivered/disabled，app正常退出，全部自有进程已关闭。

以最后一次查无消息的查询 **START** 为持久化区间下界L、首次查到消息的查询 **END** 为上界U，DOM/视口观察时刻为V，报告延迟区间 `[V-U, V-L]`。同宿主墙钟假定采样期间没有跳变，保留单调时刻供核查；createdAt不是commit，rAF及裁剪检查也不是compositor/物理屏幕paint。

| 观察范围 | 样本数 | 经验P50保守界 | 经验P95保守界 |
| --- | --- | --- | --- |
| DOM首次存在 | 8 | 183.33–194.68 ms | 198.57–209.54 ms |
| 自动进入视口 | 7 | 193.33–204.68 ms | 208.57–219.54 ms |

第8条在屏外到达，手动滚回后进入视口为 **2492.73–2504.09 ms**，单列为导航等待，不加入自动可见分位样本。分位数按上下界分别取nearest-rank；小样本P95不代表稳定尾延迟或SLA。

SQLite共2749次查询，请求轮询间隔10 ms，实际均值10.914 ms、最大13.882 ms；单次查询均值0.097 ms、最大3.553 ms。轮询与DOM观察开销已保留，不能把请求的10 ms当成实际采样分辨率。前后模型诊断 **57→57**、binding **5→5**、Work **3→3**，新增模型调用与 Work 绑定均0，仅新增上述8条纯测试提醒，未启动proxy。本补证只覆盖纯提醒路径，不新增真实模型批次，不外推Work结果、模型回复或其他类别；精确commit→paint仍未测。

## 7. 第三批 Electron：`1c4966bd`，40/44，未通过

冻结源码 `/home/vivion/i27-src3-3z_undyw`，3149 个 git blobs，manifest SHA-256 `e9eee51205307ec45fe85f8cee906a36a477045363baa0aa592b288438c804b8`；隔离 HOME `/home/vivion/iq27-tmp/l3-nlh_kjm8`。2026-11-12 00:06:33.046 UTC 启动，自然 **exit 1**，原始 **44 断言中 40 PASS、4 FAIL**，真实 **130 HTTP 调用、127 个 transport 可见工具调用**（离线完整诊断为129，见§6.3），全部模型为 V4.1 Flash，源码 runtime fingerprint 前后相同。

原始证据目录：`/home/vivion/i27-src3-3z_undyw/out/diagnostics/bot-scheduling/batch-2026-11-12T00-06-33-046Z-1415643/`。[仓库简明证据](evidence/issue27/1c4966bd-electron-focused-third-batch.json) 与原 `compact-focused-third-batch.json` 字节一致，SHA-256 为 `dc95eb9f0d273cdae4279513f379553552641712c6bd19bde9fdc6b63c489617`，保留原始四个 FAIL、后核分类、原生写入回执、实际产物内容及各原始文件 hash。没有覆盖原 report 或改写原分数。

本批是 8 case（7 类任务及受控 A/B 修订门槛），满足单批至少六类；等待第四批 B6 完成后才启动。长 mini-DOM/天气场景及服务故障注入未重跑。原 compact 按持久 task/scope 与唯一 ±100 ms 开始时间匹配为111条、19未知；§6.3 新增结束时刻/精确usage后映射129条，仍1条未知。两种证据各自保留，费用未知，不增加模型次数。案例 completedObservedAt 是稍后采样，不能用作首实质回答或首个成果的时间。

### 7.1 当前已验证的修复与独立路径

- B 真实等待受控测试 gate 时，A 已交付。同一 Work 1→2 后，原生 receipt 证明 A 只写一次、digest 不变，旧 B 一次、新 B 一次；修订目标 closed/succeeded。gate 是显式模拟外部条件，等待/读写/模型均真实执行，不当作真实外部服务。
- 混合检索真实修复、records.json 保留且 closed/succeeded，独立提醒按原 request 关联；原先把提醒分工缺回执拖入检索 Work 的结案缺陷没有重现。
- 提醒同 ID 改期、原第二会话投递、同槽一次到期、额外模型 0、新 Work 0、benchmark 重跑 0；登记不可变快照字节与现有成果相同。
- 官方 UI 新建两个真实持久会话，往返显示各自准确原请求与回答，导航额外模型调用 0。自有 Electron 正常退出重启，原会话及 file 订阅恢复。会话往返不是多 OS 主窗口。

### 7.2 四个原始 FAIL 的后核分类

| 原 FAIL | 后核分类 | 真实证据 |
| --- | --- | --- |
| `verified closure analysis: 短验分析 exists` | 脚本标题全等误判 | 实际标题加了说明，按原 source_message_id/request 定位的 Work 已 closed/succeeded，analysis.csv 128 B、登记 digest 与实际内容一致，销售合计 118、最高 Coffee 50。 |
| `短验混合检索 actual registered immutable file` | 脚本硬编码文件名误判 | 原请求只要求诊断/验证成品，未指定 verification.json。实际 `diagnose-output.txt` / `verify-output.txt` 已登记且 hash 匹配，内容为真实 JSON 诊断/验证和 EXIT=0；验证 actual=[1]/expected=[1]/passed=true。 |
| `event PR-V2: ENOENT ... benchmark.json` | **真实 S2 失败** | V2 没有执行 benchmark，缺文件不是仅查看路径问题。 |
| `event PR-V3: timeout ... native execution and reviewed result` | **真实 S2 失败** | V3 初始事件/结果复核超时，后续自动续做才把 V3 当首基线。实际 runlog 只有 V3、V4，没有 V2。 |

V3 实测中位 9.431884 ms、baseline 同值、regression=false；V4 受控延迟 100 ms 后中位 105.062028 ms、regression=true，实际登记并通知成功。V4 成功不能补出 V2；本批**不声称无退化静默或同版本去重通过**，也不把两项脚本误判纠正后的局部成功写成整批通过。

### 7.3 来源事件上下文的真实缺陷与后续窄修

source 派发的 Queue 调用 `applyObservedSources` 漏传 original.eventId，Service 生成的 source_dispatch outbox 没有 inboxEventId，binding 也为空；原生输入因此没有 sourceEvent/watchFollowUp 或明确的 triggered_execution，只剩创建监听时的原文。执行代理/结果复核会反复把已到达事件理解为建立监听，而不执行当前事件任务。

这更正了首轮“latest 空 FK 只是脚本 join 假设”的推断：只按 FK join 无结果本身不能证明 ingress 未受理，但新证据证明缺 link 确实损害后续执行语义，不能继续全部归为脚本误判。原证据和历史失败不覆盖。

该窄修已固定为 **`b3e90b8516dba43a37bcbb22b5585e77321dda4a`**，7 文件、82 新增/22 删除（生产/专项 5 文件，harness 2 文件）。三项专项 `work-file-event-source`、`work-watch-supervision`、`bot-watch-scheduler` 与完整 typecheck PASS，独立窄审通过，见 [专项证据](evidence/issue27/b3e90b85-focused.json)。该 JSON 是方法/类型/窄审证据，不是模型批次。六类 event-only 最终实链结果见 §7.5：36/36 PASS，exit 0。

新路径保证新受理/派发保留已验证事件 ID；同版本续办仅继承经持久来源绑定证明的触发事实，不因为订阅存在就声称事件已到。**不会自动回填旧版本已经派发、缺 eventId 的 binding**，不把老运行原地升级成有完整上下文，也不重写其失败历史。按当前验证安排，小改不再重跑完整门禁；`1c4966bd` 的 484/484 仍是最后一次全量，不能宣称 `b3e90b85` 已跑完全量。实链结果已另行核验，但本报告本身不执行发布或关闭，也不把部分 UI/测量项改写为通过。

### 7.4 文件查看器与窗口限制

- 第三批 JSON 快照附件及字节核验通过，按钮可见且实际点击。**点击不等于外部查看成功**：dev.log 显示未设置 JSON 默认查看器，外部 viewer 未成功打开。源码已有 IPC catch，但本批没有采集打开 API 返回值或用户 notice，不能声称已验证错误提示，也不能写 JSON“打开 PASS”。
- 1280/390 的无横向溢出仅为同一 Electron renderer 的 CDP viewport。尝试观测自有实体窗时 compositor bounds 656×852、Electron outerWidth 960、innerWidth/scrollWidth 1280；外部 CDP session 的 clear 没有移除主会话原 1280 override。**此批实际 OS 窄屏 DOM 未确立，不记 PASS。** 后续 §7.6 使用同一主 CDP 会话清仿真，另取得支持宽度的实体窗证据，不回写此批结论。
- 产品 main window minWidth 为 960，只有一个主窗口；第二次启动聚焦原窗，没有官方第二 Bot 主窗口入口。两个真实会话、外部编辑器、预览或空白页均不替代多主窗口验收。
- 原始日志、profile、数据库、快照保留。自有 runner/Electron 自然退出；按冻结 source/home/root PID 检查无残留，没有停止用户进程。

### 7.5 第四批 Electron：`b3e90b85` 六类 event-only，36/36 PASS

本批自然 **exit 0，36/36 断言 PASS、0 FAIL，57 次真实 `opendesign/deepseek-v4.1-flash` HTTP 调用、45 个唯一工具调用**。冻结源码 `/home/vivion/i27-src4-2n97ai_7`，runtime fingerprint 前后同为 `fa44173fa7b18d2aac9f6e8441f3123e56d08a7b295eb1402285fcf0e9adbde2`（1265 文件）。原始 report 为 `/home/vivion/i27-src4-2n97ai_7/out/diagnostics/bot-scheduling/batch-2026-11-12T00-26-04-773Z-1465892/report.json`。 [仓库简明证据](evidence/issue27/b3e90b85-electron-event-fourth-batch.json) SHA-256 `f644c5d6e02b002a3efea8a59cc46c144548bd2b37ce30ac4752c1d7fc4cc5d3`，源码完整 manifest SHA-256 `7613e28f281913bf02c919334f5f886cd2e843e4901a0b5251affd5b9147e40f`。

真实 HTTP 区间为 **2026-11-12 00:26:41.545–00:32:01.889 UTC**。原 compact 的50条匹配/7条未知经§6.3离线精确usage+时刻补证后，57条全部可关联；不是新模型调用。金额未知，不写 0。没有其他计划内模型批次或完整回归并跑，但无关宿主负载未测，不用于性能 SLA。

本批只重验来源事件修补及六类配套入口，**没有重跑长 mini-DOM/天气、受控 A/B 修订或 mixed**。已核实的业务链：

- PR-V2 真实首基线执行、登记并通知；随后两次同 bytes 重写均未新增 inbox、binding 或 benchmark run。
- PR-V3 实际运行并登记，结果 review=silent，0 result 通知。这里是业务条件不满足后的静默，不冒充“host_proven_unchanged 结果模型 0 次”。
- PR-V4 实际退化执行、登记并通知；V2/V3/V4 三版本各只跑一次。

| 事件版本 | 真实中位耗时 | 结果整理 | review attempts | result 通知 |
| --- | --- | --- | --- | --- |
| PR-V2 | 8.946621 ms（首基线） | delivered | 1 | 1 |
| PR-V3 | 8.074288 ms（无退化） | silent | 1 | 0 |
| PR-V4 | 111.518442 ms（受控退化） | delivered | 1 | 1 |

三条真实 binding 均有各自 inboxEventId，原生输入同时包含 sourceEvent 与 triggered_execution；runlog 恰好 V2/V3/V4 三次，没有靠人工补写 SQLite 冒充执行。上述耗时属于明确的本地合成 benchmark，不是用户产品性能。
- 已有成果提醒同 ID 改期，到期额外模型 0、新 Work 0、benchmark 重跑 0；既有不可变 JSON、原会话投递及单次提醒均通过。文件 bytes/附件证明仍与外部查看器打开成功分开。

真实重启保留原会话和 file 订阅，1280/390 CDP viewport 无横向溢出；自有进程已退出。后两项仍不证明实体 OS 窄窗或多主窗口。Issue 三故事的证据组合是 `5ba7e153` 长场景 + `1c4966bd` 修订/mixed 复验 + `b3e90b85` 事件 delta，不是所有 S1–S3 在最新 SHA 完整重跑。后续实体窗补证见 §7.6；390 实体宽度、多主窗口、跨端和测量边界仍按矩阵保留。

### 7.6 零模型实体窗补证：960/1200 通过，390 与多主窗口限制实证

[补证摘要](evidence/issue27/b3-zero-model-window/summary.json) SHA-256 `ecf806e698400a04d023bf5c345f04dd3df69e8ef3e887f68a72de84b1213009`。使用同一 `b3e90b85` 冻结产品源码、复制测试 profile 和真实 Omarchy/Hyprland，只针对已确认测试 PID/窗口地址调整尺寸，没有修改系统配置。主 CDP session 清除继承的仿真后，不再设置 viewport emulation。

| 请求/观测 | compositor | outer / inner / scroll 宽度 | 结论 |
| --- | --- | --- | --- |
| 实体 960×800 | 960×800 | 均 960 | PASS，无横向溢出，原会话 JSON 文件按钮在 viewport 内 |
| 实体 1200×800 | 1200×800 | 均 1200 | PASS，无横向溢出，原会话 JSON 文件按钮在 viewport 内 |
| 请求实体 390×800 | 实际 960×800 | 均 960 | 被 minWidth 正确钳至 960；不是 390 实体窗 PASS |

[960 逻辑宽度截图](evidence/issue27/b3-zero-model-window/requested-960.png) 与 [1200 逻辑宽度截图](evidence/issue27/b3-zero-model-window/requested-1200.png) 已目视核对，显示原提醒、benchmark.json 保存版本入口及三条事件执行记录；截图像素尺寸不冒充逻辑窗宽。本检查仅验证显示/路径，仍不证明 JSON 外部查看器成功打开。

对同一复制 profile 真正第二次启动 `pnpm dev`（不同调试端口），第二 instance exit 0，仅原 PID/窗口身份留存、没有第二主窗，符合生产 `requestSingleInstanceLock` 分支。singleton handler 事件本身没有插桩；证据是实际启动/退出、保留原窗与生产分支，不是额外制造 BrowserWindow。官方不支持同时两个主会话窗口仍是边界。

零新增业务/模型证据：持久模型诊断 **57→57**、执行绑定 **5→5**，未启动模型 proxy、端口原本不监听，UI 日志无新模型请求失败；没有单独网络抓包，不扩张成任意网络行为证明。复制 profile 下没有新建业务请求，全部测试进程已关闭，未操作用户进程。

**旧测试 profile 的额外启动如实保留：** 此次补证最初曾正常启动旧 l4 profile 一次，随后关闭并改用复制 profile。旧库新增一条 `unqueryable-offline-gap` blocker：本地来源不提供历史回查，不能证明离线期间无遗漏。这不是重复 result/reminder，也没有新增模型诊断或业务 binding。保存前后观察，不恢复/覆盖旧 DB，不抹去原始 report。正式实体窗证据来自之后的复制 profile。

## 8. 命令、门禁和可复核证据

### 8.1 实际完成的检查与未运行套件

- `1c4966bd` 相关专项与完整 `pnpm -s typecheck` PASS：result-delivery、completion-evidence、automatic-completion、team-recovery、delegation-fidelity、work-watch-supervision、work-revision-handoff、durable-subagent；覆盖缓存重开、格式失败、判定硬锁、当前证据和真实子项投影。独立窄范围代码复核未发现确认的阻塞，但代码复核不替代实链。
- `5ba7e153` 完整 default headless：**484/484，0 failed/known/regressions，exit 0，4.6 min**，见 [摘要](evidence/issue27/5ba7e153-headless.json) 与 `out/diagnostics/issue27-headless-5ba7e153.log`。
- `bc9f2330` 完整 default headless：**484/484，0 failed/known/regressions，exit 0，4.8 min**，见 [摘要](evidence/issue27/bc9f2330-headless.json) 与 `out/diagnostics/issue27-headless-bc9f2330.log`。
- 最后一次完整 default headless，`1c4966bd`：**484/484，0 failed/known/regressions，exit 0，4.8 min**；源码运行前后不变。见 [摘要](evidence/issue27/1c4966bd-headless.json) 与 `out/diagnostics/issue27-headless-1c4966bd.log`。通过范围仍仅为 default headless。
- 最新 `b3e90b85` 已跑 `work-file-event-source`、`work-watch-supervision`、`bot-watch-scheduler` 与完整 typecheck，全部 PASS；独立窄审无确认阻塞。最新六类 Flash Electron 36/36 PASS、57 调用、exit 0。未重跑完整 headless，不把窄审/专项或实链子集当完整门禁。
- Electron 纯 UI 夹具 `test:bot-work-conversation-desktop` 已 PASS：13 Work-link 用例，personal/team × active/completed/closed，390/760/1100/1440 renderer 宽度，点击/返回/Escape/焦点/滚动/lazy detail/历史团队/文件目标。没有模型，不充当真实任务链。
- 当前分类：headless 484；排除的 GUI 89、NETWORK 43、DATASET 3、ARTIFACT 3 **没有全部执行**。分类 audit 通过不等于这些套件执行通过；有针对性实机/联网测试不等于全部 GUI/NETWORK 通过。未运行产品 build/pack，亦未运行发行包 ARTIFACT 验收。

历史门禁失败不抹去：首次 472/482、10 FAIL 中，六项由仓库内 TMPDIR 继承 AGENTS/Git 或 Unix socket 路径过长导致，换仓库外短路径后通过；其余完成相应产品/合法回归修正。后续集成曾有 483/483；`f576144c` 仍有 482/484 两项旧断言失败，两项分别误把历史 handoff 中保留的 unknown operationId 当成新动作重放，以及只读 Watch 夹具没有显式 observe；修改为检查新任务不含旧动作、历史区保留原身份，并让只读夹具明确 observe 且继续验证拒写。纠正后才有 `5ba7e153` 的 484/484。未修改失败基线掩盖失败。当前 durable-subagent 也曾因仓库内临时目录继承 AGENTS 改变并发计划，使用仓库外短 TMPDIR 重跑通过，未为该环境误差改产品。

### 8.2 再现入口

下列命令要求对应固定源码、已有依赖及授权的宿主网络/真实桌面；不是离线可重复调用模型的承诺。每次 live 都生成新诊断目录，不覆盖旧证据；通过 env/manifest 核实源码与模型，使用新隔离 HOME，不复用真实用户 profile。

```sh
TMPDIR=/home/vivion/iq27-tmp pnpm -s typecheck
TMPDIR=/home/vivion/iq27-tmp pnpm -s test:all
node scripts/test-all.mjs --audit
node scripts/bot-scheduling-live-test.cjs --check-harness
BOT_COMPLETION_EVIDENCE_EXPECT_COMMIT=1c4966bde7778d4002d36724defce757f239d575 \
  TMPDIR=/home/vivion/iq27-tmp node scripts/bot-completion-evidence-live-test.cjs --live
# 完整 Electron 使用固定快照、新隔离 HOME 与相应模型配置：
env -u ELECTRON_RUN_AS_NODE BOT_SCHEDULING_SNAPSHOT=<tested-sha> \
  BOT_FRONTDOOR_MODEL=opendesign/deepseek-v4.1-flash \
  BOT_SCHEDULING_HOME=<new-isolated-home> TMPDIR=/home/vivion/iq27-tmp \
  pnpm run test:bot-scheduling-live
# 1c4966bd 的八例短批另加 BOT_SCHEDULING_FOCUSED=1。
# b3e90b85 的六类 event-only 批次另加 BOT_SCHEDULING_EVENT_ONLY=1。
```

运行中源指纹不变是证据要求；源码变动必须另记一批。服务/纯 UI 入口及 package 脚本在各 SHA 保留，语法 `--check-harness` 本身不启动 app 或 inference。首次默认隔离 shell 的网关 ECONNREFUSED 只说明该 shell 路径失败，随后宿主只读 HTTP 200 确认服务及模型存在；未启动/重启服务或复制用户凭据。

### 8.3 主线发布与 CI 实际状态

[发布核验记录](evidence/issue27/f463687f-publication.json) 于 2026-11-12 00:44:05.658 UTC 确认主线为 **`f463687f582a691b6153929dbbadb05d1e485b03`**，此前版本验收报告已在 GitHub 读回。发布提交相对 `b3e90b85` 未改变产品源码或测试脚本；真实测试仍按各自实际 SHA 记账，不说它们在文档提交上重新执行。此后新增的 UI/统计补证属于后续文档变更，不能仅凭该次发布记录称它们已经推送。

- `verify`（`.github/workflows/verify.yml`）状态为 **disabled_manually**。
- 固定 f463687f 的 workflow runs **0**、check runs **0**，因此 **CI 未运行，不是 PASS**。
- 没有擅自启用 workflow 或更改 CI 设置；本地实测/门禁与远端 CI 分开记录。
- Issue #27 仍为 **open**，没有执行关闭。

## 9. 独立跟踪与未实现能力

以下问题已获准创建并读回 open，满足 19–22 的“记录并跟踪”，**不是本轮实现完成**：

- [#28 / B-3](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/28)：候选先 LIMIT 300、来源 301/总预算 300 边界、普通技术词/完整 40hex SHA 误过滤及非 hybrid 入口。后续须真实验证 >1000 历史、纠正优先、forget/scope 与召回质量，不用 #26 替代。
- [#29 / B-4](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/29)：桌面与网关 Bot 身份、自动 task 与显式 bot 记忆 scope 及事项指向。后续须真实桌面→QQ→桌面，同 Bot 最新偏好、不同 Bot/会话不串、并行 Work 控制；不能只靠恰巧显式 memory 工具。
- [#30 / B-7](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/30)：无 project 的个人 Work/聊天经验跨 Work 技能复用与修订收益。已有 global/project/workspace 范围不等于 bot/work；须证明下一相似任务实际用修订版、少重复纠正，并记失败和成本。
- [#31 / 跨端交付与常驻](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/31)：QQ/Discord/钉钉主动通知、真实文件送达，以及离线电脑之外常驻执行。当前本机在线要求仍在。

当前源码、相关检查与真实复验结果已按批次记录，完整门禁仍注明最后实际运行的 SHA。主线 f463687f 已核实；CI 未运行、Issue 未关闭。安全可补的验收已结束，新增只读时刻/调用归因、实体窗口和零模型提醒可见性证据已全部到齐并冻结，待核阅后仅发布文档；没有模型批次或全量门禁仍在运行。singleton/minWidth、跨端、JSON外部查看器及旧采样无法追溯的精确时刻/完整阶段数据仍是边界，不把全部28项或metrics标绿。
