# 个人助理下一阶段建议核实

核对基线为 `c266a6388092940d32092afeb82427cf9c5a1521` 加当前工作区，包含上一轮 #53—#56 编排改动。三个子智能体分别核对连接器、事项汇总、Skill 与事件链；评估阶段未新增产品代码修改，未操作外部账号。

总体判断：七个方向有依据。需要区分已接通的能力、缺少的交接，以及仍未验证的收益。决定先实施统一事项查询，再分别贯通 MCP 插件、连接器插件的短操作与 Work 交接，然后补可执行方法资源和纠正规则，最后接所选插件支持的外部事件。

用户明确要求 MCP 和连接器两类插件都需要，它们是不同的插件体系。后续须分别保留配置、账号、工具发现及执行机制；可以复用前后台任务交接所需的对象身份、版本和操作回执契约，不把二者合并成单一插件，也不能只验其中一类就宣称两类都已贯通。

## 核实结果

| 建议 | 判断 | 当前边界与值得做的增量 |
| --- | --- | --- |
| MCP 与连接器分别贯通前后台 | 部分已有，缺口明确 | MCP 已共用传输、配置和 OAuth 存储；前台允许已选 MCP 写操作。连接器的 CLI 操作仍统一交 Work，前台工具结果缺少对象、版本、操作回执的结构化交接。两类插件均须支持。 |
| 主 Bot 统一掌握交办事项 | 属实，优先处理 | 自办/参与目录与发出的协作分离，协作无 Work 时也未进安排；概览筛选与分页存在实际缺口。 |
| 判断本次与旧工作的关系 | 有基础，需补可用入口与行为验证 | 历史成果查询、同 Work 修订交接、同源版本关联已有；通用新实例复用、模板与实例数据分离尚未贯通。 |
| 成功任务沉淀可执行方法 | Memory 学习路径的缺口属实 | 普通 Skill 包支持资源；learned Skill 安装输入和物化仅覆盖正文及元数据，资源清单与资源版本未进入该链。 |
| 外部变化继续原事项 | 事件接线缺口属实 | 通用 ingress、版本水位、恢复与定时 Work 已有；可宣告的生产外部 receiver 目前是本地文件，连接器增量事件尚未接入。 |
| 纠正形成一致的有效规则 | learned Skill 修订的缺口属实 | Bot/Work 归属、版本和读取校验已有；正文生成采用追加纠正 note，尚无明确的条款替换和情境例外。未复现错误产物，不能扩大成全部 Memory 纠正失效。 |
| 业务对象交付与收益评价 | 值得作为验收契约 | 当前有目标、成果、缺项和未知效果证据；外部服务对象及修改回执还需随连接器接入。现有测试不能证明普遍提速或降本。 |

## 修改前的统一事项查询行为证据

探针使用真实 `AppDatabase`、`WorkService`、`BotWorkQuery`、`BotCollaborationRepository` 和 `botScheduleOverview`，数据放在临时 SQLite。

- A 自办项进入安排。A 委派给 B 的 Work，以及尚未创建 Work 的协作均未进入。B 的无关 Work 正确隔离。
- 同一 Work 同时通过参与关系和协作关系命中时，两源直接拼接产生 4 条，实际是 3 件事项。参与者仅在测试夹具中插入以形成交集。
- 513 个 open Work 中，概览返回最新 500 项，6 个较早创建的到期事项全部遗漏。返回 `truncated:true` 和提示，但没有续页游标。
- 同一数据使用底层期限筛选与 `deadline_asc`，每页 2 项，三页准确返回 6 项，同期限无重复；读取未产生写入。
- 等用户、外部受阻和等时间已有 `waiting_input`、`blocked`、`scheduled` 事实。主状态优先显示 running 时，`needsUserInput` 仍需单独呈现。

修改前的相关入口为 `BotWorkQuery`、`BotScheduleOverview`、`BotWorkTracking`。另有协作查询断口：`BotCollaborationService.command` 固定读第一页 30 项，底层返回 `nextCursor`，但前台 command schema 未接收 cursor。这些问题的当前修复见下方实施记录。

修改前探针结果保存在 `out/diagnostics/my-work-overview-probe-results.json`，追加探针源码在 `out/diagnostics/my-work-probe-tail.mjs`。修复后的行为由正式测试 `test:bot-work-query-scale` 和 `test:bot-work-foreground-contract` 验证，不能用修改前的探针结果描述当前代码。

最小实施范围是复用现有事实做去重投影：关联 Work 按 workId 合并，未建 Work 的协作按 collaborationId 保留，提醒保持自身身份。筛选、计数和去重发生在分页之前，返回稳定续页参数。读取可见性与修改权分开，控制仍回到原 Work 或原协作；不能用增加参与者或列出同用户所有 Bot 的私人事项来实现汇总。无需新增任务真源或调度器。

## MCP 与连接器分别应补的交接

`BotComposerRuntime` 与 `DurableBotService` 已共用 `DurableMcp`、`McpConfigService` 和加密 OAuth 存储。`AgentService` 给前台的 `readOnly` 为 false，因此不能描述为 Bot 不支持前台连接器写入。真实限制见 [ConnectorRuntimeContext](../../src/main/connectors/ConnectorRuntimeContext.ts#L15)：MCP 可直接调用，CLI 转 Work。

当前 Work 会冻结所选 MCP/connector ID，但执行时读取当前服务配置。同一服务 ID 不足以证明跨阶段仍使用同一个账号。前台同一轮 `work_create` 时，完整 transcript 尚未最终保存；需求原文和附件已交接，实际 tool-result 并没有通用的已完成操作交接结构。

MCP 插件和连接器插件各自的可验收切口均应包含：原插件的操作入口、真实账号和对象身份、读取版本、操作身份、成功或 unknown 回执、取消与超时。每类插件自己的前台短操作和 Work 复用其执行适配，二者的插件配置和发现方式保留独立。前台已成功的步骤带入原回执，unknown 先回读，不能换执行身份当作未发生重试。

旧 Google 工具存在可复用的短写及回执实现，但 `5e310105` 有意移除了默认挂载，改为由用户选中的服务提供能力。后续应保留这个决定，按 selected provider 接入。旧 Google 报告不能直接证明当前 Bot 原生接线仍在。

[连接器 readiness 报告](bot-connector-readiness-2026-11-11.md#L22) 的六类真实模型用例读取测试 Skill 并如实报告账号未验证，没有完成真实邮件、日历或文档操作。跨应用业务链仍需真实服务验收。

## 复用和纠正应如何界定

同源重复、活动 Work 新版本和已关闭 Work 新版本已经有处理：同版本复用原 Work；可比较的新 revision 更新活动 Work 的输入；关闭后的新 revision 建立带旧 Work 来源的后继项。[WorkService](../../src/main/agent/work/WorkService.ts#L322) 与本轮 `test:bot-scheduling-gaps` 的行为测试均支持此结论。它不是通用模板复用协议；来源字段也不自动成为可信连接器回读。不可排序的版本令牌不能按到达时间判断新旧。

[learned Skill 安装输入](../../src/main/skills/SkillsService.ts#L81) 没有资源字段，安装只写正文和元数据后替换包目录。普通安装与 authoring 已有整包复制能力。值得补的是有来源、内容指纹和验证记录的资源清单，并在修订时保留未变资源。脚本和模板应与客户数据、月份、路径等实例输入分开绑定，不能把整次任务的目录直接作为通用方法。

[Skill 修订正文生成](../../src/main/memory/MemorySkillRevisionService.ts#L107) 会把纠正原文追加到旧正文。下一步应明确当前例外、类别默认和替换关系，形成当前一致的有效正文，旧版继续留历史。这个结论仅针对 learned Skill 修订，普通 Memory 更新不能一概而论。

#30 的历史真实模型对照证明：启用修订技能后，下一项 Work 实际读取精确 candidate，并产出用户未重复要求的核验文件。该对照中两组业务均成功，调用次数为 11 与 17；启用组还经历了 provider 流式错误和恢复。因此不能把它作为更省、更快或普遍提高成功率的证据。记录见 `out/diagnostics/bot-cross-channel/method-ab/comparison.md`；本轮没有重跑真实模型。

## 外部事件与验收顺序

已有定时 Work 可以调用连接器观察变化。新增的连接器事件接线，应把账号、对象、事件身份和来源版本绑定到原订阅，再进入 `WorkWatchIngress`，持久接收成功后才推进连接器游标。

入口去重本身不证明外部业务动作恰好发生一次。应复用原操作身份，结合服务幂等能力或实际回读处理响应丢失，保留 unknown；同时验证重复、乱序、断线补查、暂停/取消及修订后旧事件。

建议按以下顺序验收：

1. 一次查询覆盖自办、委派、无 Work 协作和提醒；完整过滤到期/待回复事项；能沿原身份控制和打开成果。
2. 分别选一个 MCP 插件和一个连接器插件，验证真实短查询、明确短写、成功后转 Work、账号切换/版本冲突/unknown 恢复。两类都通过才接受完整贯通。
3. 第二个客户或月份复用实际脚本和模板，校验新输入与产物；临时例外不污染长期规则，长期替换在下一项相关任务生效。
4. 同一连接器的新事件继续原 Work，验证重复事件和离线恢复，再扩展到多服务连续故事。

以上评估阶段的验证为源码、Git 历史、已有验收记录复核，以及真实 SQLite 探针和 `test:bot-scheduling-gaps`、`test:bot-scheduling-routing`。评估阶段没有重跑 full gate、GUI 或真实服务链；上一轮 525 项通过不冒充这些新增能力已验收。

## 本轮采用范围

本轮采用并实现统一交办事项查询和完整分页。连接器新操作、外部事件接线和 learned Skill 资源学习留待各自的真实业务验收，不与本轮查询改动混做。

`schedule_overview` 现在合并本人负责或参与的 Work、沿原协作委派的 Work、尚无可读 Work 的协作，以及纯提醒。`work_query_status` 也能读到原委派事项；委派详情只返回原协作公开的摘要、消息和成果，不加载对方私人执行投影。`bot_collaborate query` 接通列表和往来的分页参数，返回可以直接续查的 `nextQuery`。

过滤与计数发生在分页之前，支持完整搜索、Work 承诺期限窗口、待用户输入筛选和期限排序。展示用的文本截断不影响搜索。`open/all` 覆盖各类事项；其余 `status` 是 Work 生命周期筛选。提醒时间不冒充承诺期限，无 Work 协作也不推测用户输入阻碍。

读取与控制使用不同目录。新增可见性必须同时匹配当前用户、发起 Bot、原协作的精确 Work 以及当前执行归属；普通 `work_*` 控制保持原权限。委派修改沿原协作读取当前守卫后执行。团队和共享会话不纳入私人发出协作。

同一事项按稳定来源身份去重。协作后来创建 Work，仍沿用原协作的排序锚点；负责人交回发起 Bot，或变更后发起 Bot 仍有原参与权限，也只显示一次。失去 Work 读取权时仅保留原协作并标出范围变化，不透露新负责人的事项内容。取消的协作不会因为范围变化重新成为待办。

续页绑定用户、Bot、会话和筛选。普通进度变化不使游标失效；匹配集合或排序键变化会明确要求重新查询，避免静默漏项。实现每页扫描匹配事项的轻量标识来计算结构指纹，仅展开当前页详情，没有建立新的状态库。这是准确性与查询成本的取舍，不能称为与事项总量无关的固定成本。

正式行为测试调用真实 SQLite、Work 服务和前台工具入口，覆盖权限、原协作控制、同项去重、513 项完整遍历、较早到期事项、晚绑定、负责人变化、长文本搜索、取消状态及查询无写入。

## 本轮验证

- `test:bot-work-query-scale` 通过。新增用例由 `scripts/bot-responsibility-query-cases.ts` 接入，既有规模用例还直接调用新 `botScheduleOverview`；禁止 `getWork/getProjection/listWorks`，防止列表退化为全量加载。
- 最终优化版单次测量：513 项首 50 条 34.1ms、完整 11 页 333.9ms；12,000 条长正文、约 400MB 的 SQLite 库，新概览首 20 项 921.9ms，续页 926.5ms，首屏 JSON 45,996 字节。是本机单次运行，不是 p95，不证明普遍提速。
- `test:bot-work-foreground-contract` 通过，新增真实工具 schema/execute 用例验证公开成果读取、委派控制隔离、协作分页与守卫、team/shared 隔离。日志：`out/diagnostics/bot-responsibilities-foreground.log`。
- `test:bot-scheduling-routing` 通过，包含安排投影、原多事项控制和持续事项路由。日志：`out/diagnostics/bot-responsibilities-routing.log`。`test:bot-peer-ingress` 在前台接线后通过。
- `pnpm -s typecheck` 通过，web、node、scripts 均无错误。协作查询顺序和并行 UI 测试修复后再次通过，最终日志：`out/diagnostics/bot-responsibilities-typecheck.log`。
- 独立审查另以生产查询函数和隔离 SQLite 检查权限、晚绑定、交接、游标和搜索；诊断脚本为 `out/diagnostics/bot-responsibility-independent-review.cjs`。这不是完整数据库或真实模型验收。

首轮完整门禁发现 `bot-cross-channel-contract` 回归：游标校验顺序调整后，方法反馈捕获早于当前请求与原协作建立关联。已改为在同一事务中先验证游标、再关联请求、最后记录守卫和方法反馈；操作回执查询不建立关联、不捕获反馈。`test:bot-cross-channel-contract` 和 `test:bot-work-foreground-contract` 已通过，仍保留非法游标零写入断言。日志为 `out/diagnostics/bot-query-cross-channel-focused.log`、`out/diagnostics/bot-query-foreground-focused.log`。

首轮结果为 523 通过、2 失败，日志为 `out/diagnostics/bot-responsibilities-first-gate.log`。另一个失败 `bot-workspace` 仍断言旧 UI 栏目名称和层级。当前工作区的 Work 详情排版由并行会话修改，已通过 Lody 将失败证据交原负责人维护；对方保留新 UI，将测试改为实际 DOM 行为，检查结果优先、次级信息默认折叠和原始记录保留，并消除缺失栏目 `indexOf=-1` 导致的误通过。

修复后最终 `pnpm -s test:all` 通过：525 项通过，0 失败、0 已知失败、0 新增回归，耗时 8.0 分钟。日志为 `out/diagnostics/bot-responsibilities-final-gate.log`。这是 Windows 默认 headless 套件，两个 Linux 专属用例按既有平台分类排除；GUI、联网模型和 ARTIFACT 不包含在该结果中。参与本轮实现及界面测试同步的文件另保存了运行前哈希，运行后回读未变化，记录为 `out/diagnostics/bot-responsibilities-source-hashes.json`。

本轮没有执行产品构建、GUI、发行包或真实外部账号业务链；没有提交或推送。当前新增能力能否被联网模型稳定选用，仍需真实模型行为验收。
