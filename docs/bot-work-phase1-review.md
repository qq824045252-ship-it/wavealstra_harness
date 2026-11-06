# Bot / Work Phase 1 实施审查与 Codex 修复清单

| 项目 | 值 |
| --- | --- |
| 日期 | 2026-11-06，Asia/Shanghai |
| 状态 | 审查已完成；本清单的产品代码修复与正式验收待执行 |
| 设计契约 | [BOT-WORK-1.0](bot-work-design.md) |
| 完整验收 | [BW-A01～BW-A46 与第 9 节端到端故事](bot-work-acceptance.md) |
| 审查时主线 | `1d31faac8fe45d29cf4cc30f0cd821ec50722dc7` |
| 设计引用基线 | `cb9680891f8b86aed69d7ace904bca0f2ec7d8cd`；审查时 main 的设计正文与该版本一致 |
| 被审实现 | 用户上传的 `bot_work_phase1.ts` 草稿，2431 行、85507 字节；[原件归档](reviews/bot-work-phase1-2026-11-06/draft.ts.txt) |
| 原件 SHA-256 | `494d96f41113433ffb37f55fe2dd78ed5b9d2a0eda7278fd926e57b1d6a5c4a0` |
| 证据与复现 | [说明、脚本和原始输出](reviews/bot-work-phase1-2026-11-06/README.md) |

**UI 补充决策（2026-11-06）：**普通模式与 Bot 模式是两套独立页面、复用基础能力。现有账户菜单在「自动化」正上方增加「Bot 模式」入口，点击进入新 `page="bot"`；不把 Bot/Work 放进原普通 Task 树。详见 [BOT-WORK UI 双页面与入口规范](bot-work-ui.md)。

## 1. 给 Codex 的执行要求

本轮审查对象是上传的五阶段实施方案及 Phase 1 草稿。草稿中的缺陷不能直接写成“当前 main 已部署的产品漏洞”；主线用于核对实际模块、初始化契约和接线。执行时先检查当前 HEAD 是否已经有等价实现，再按本清单修复或落地对应服务，避免另建一套平行实现。

结论：**保留冻结设计与五阶段内部研发顺序，先修正本清单中的数据和控制契约，再继续实际接线。**原文字方案列的是验收目标，没有宣称全部通过。后续阶段尚未实现的能力与当前方法已暴露的错误需要分别记录。

- 遵循当前 [AGENTS.md](../AGENTS.md)：只使用现有 `main`；用户没有另行要求时不新建分支或 worktree。遵守当前任务的提交、推送与发布授权。
- 不要求旧数据兼容，不重新引入旧 Goal / Pi 数据迁移。保留数据库版本不兼容时**先备份再重建**的既有契约，不恢复直接删除旧库的行为。
- 复用现有 TypeScript、SQLite、Pi Durable、原生 Codemode 和子任务能力；执行恢复继续归 Durable，不增加第二套恢复内核。
- 把现有 Goal 语义提升为唯一 Work 真源，接回既有项目、Memory、权限、工作区、交互卡片、执行证据和诊断。内部表名/类名可以调整，业务语义不变。
- 对修复增加行为断言，不能以注释、字段存在或源码包含关键词代替行为验收。下面的归档探针仅复现旧草稿，不是产品通过门禁。
- 实现完成后按当前仓库约定运行 `pnpm -s typecheck` 和相关 `test:*`；需要界面时使用 `pnpm dev`。本任务不包含构建产物、打包或发布操作。
- 允许内部拆分实现和验证；完整 BOT-WORK-1.0 仍以全部适用 BW 场景及端到端故事为完成定义。该定义不阻止开始实现，也不能用局部完成替代整体完成。

### 建议执行顺序

1. R08：核对当前 schema 与 Goal/Work 唯一读写路径。
2. R01、R02、R03：修正幂等、可信身份和模型决定的必要版本守卫。
3. R04、R06：落实执行/委派绑定与来源、被测版本证据。
4. R05、R07：收紧验收与停止结算状态机，关闭绕过入口。
5. R09、R10：修正专家采纳与历史回执/当前投影分离。
6. 依第 4 节补齐跨阶段接口并联合验收，不缩减冻结范围。

## 2. 修复任务

以下行号均指归档草稿，当前仓库位置另外注明。R01～R10 是本次审查任务 ID，不替代冻结验收 ID。

### R01 — 修正幂等摘要、回执作用域与重放授权

**优先级：P1。位置：草稿第 2430 行；`findReceiptByOperationId`、`createWork`、`executeMutatingControl`。对应 BW-A05、F05/F07。**

当前 `JSON.stringify({ operationType, payload }, Object.keys(payload).sort())` 使用属性白名单。正常参数没有外层 `operationType`/`payload` 键，序列化结果变成 `{}`；不同正文和不同操作得到相同摘要。创建回执查询还只按 `operation_id` 搜索，回执早退发生在权限核验之前。

已复现：相同操作 ID 的 amend 后再 cancel，cancel 返回 `ok:true/replayed:true` 而 Work 仍为 active；更换用户、负责人和标题的 create 返回旧 Work（P01、P02）。

- [ ] 对操作类型与完整有效业务参数做递归稳定序列化，保持数组顺序；明确缺省值与无业务意义字段的规范化规则。
- [ ] 不再使用会过滤嵌套字段的数组 replacer；只补两个外层键不构成修复。
- [ ] 明确创建操作和已有 Work 操作的幂等命名空间；持久唯一约束与查询范围一致，避免跨用户/跨目标碰撞。
- [ ] 在返回历史回执前验证主体对目标和回执的访问权限；同一 ID 的不同操作或不同有效正文必须显式冲突。
- [ ] 受理、Work 变更、回执与必要 outbox 在相同事务中保持一致，补并发重复提交行为检查。

**验收：**同一主体同请求重放返回原回执，不新增 Work/指令；异正文、异操作、异主体的碰撞不能被错误成功重放；嵌套授权/criteria 字段变化必须影响摘要。

### R02 — 将可信调用身份与模型业务参数分离

**优先级：P1。位置：草稿第 2386 行，worker 开关第 1938 行。对应 F05/F11；关联 BW-A08、BW-A13、BW-A27 的授权边界。**

`actorUserId` 非空即跳过 owner 判断，`allowWorkerActor:true` 也跳过主体核验。已复现另一用户的 Bot 暂停目标 Work，以及不存在的 Bot/execution 成功提交成果（P04、P05）。这是草稿服务方法的确定缺陷，本轮没有证明现有 IPC/前台已经对外暴露该路径。

- [ ] 身份从已认证入口或宿主绑定注入，不能相信模型载荷自行声明的 actor。
- [ ] 核验 Work 用户归属、owner/参与者角色、委派范围和当前授权；回执重放同样检查访问权。
- [ ] worker 提交核验 Bot、有效委派和执行归属；worker 模式应选择独立授权策略，不能免检。
- [ ] 新 Work 授权继承当前已批准范围与仓库约束，不能由默认参数自动扩大为可写/可新建分支或 worktree。

**验收：**伪造 actor、另一用户、无委派 worker、无效 execution 均被拒绝；合法用户/owner/worker 在各自权限内正常工作。只根据字符串存在与否放行不算完成。

### R03 — 为异步模型控制决定强制提供相关版本

**优先级：P1。位置：草稿 `ExpectedVersionGuard`、第 295 行及第 2347、2361、2374 行。对应 BW-A21/BW-A22、F06。**

`versionGuard` 及其所有字段均可选；不传就完全跳过检查。已复现要求从 r1 更新到 r2 后，无守卫的旧 pause 决定仍被接受（P03）。

- [ ] 异步模型控制请求必须携带其依据的 `stateVersion`、`intentRevision` 和适用的 `ownerEpoch`，事务内核验。
- [ ] 缺少必要守卫返回明确参数错误；旧快照拒绝/重评，不默认解释为基于最新状态。
- [ ] 如支持可信即时用户命令对当前状态操作，定义独立宿主契约；不能让模型控制决定复用无守卫入口。
- [ ] 保留推理期间不占用数据库事务、高频 token/心跳不推进控制版本的约束。

**验收：**旧要求/旧状态/旧负责人决定均无法覆盖当前事实；缺守卫不能绕过；遥测持续写入不使合法控制决定因无关版本变化饥饿。

### R04 — 分开控制决定代次与 worker 成果来源

**优先级：P1。位置：草稿第 1897、1920、1938、2347 行。对应 BW-A23/BW-A27、F04/F06/F11。**

已复现两种错误：交接后仍对应同一要求的 worker 成果因旧 ownerEpoch 被拒绝；旧要求成果不传版本时被盖上当前 intentRevision（P10、P11）。

- [ ] 通过持久执行/委派绑定读取成果的 Work、来源 Bot、输入快照、要求版本和来源代次，不能用接收时的当前版本补缺。
- [ ] 检查委派/执行是否仍有效；负责人变化本身不等于该成果失效。
- [ ] 旧 owner 的新控制决定失效，仍有效的原 worker 成果允许由新 owner 核验接管。
- [ ] 旧要求成果保留为历史证据；复用时记录对当前验收的重新核对依据，不自动提升成当前成果。
- [ ] 输入版本缺失、未知 execution、错 Work 或错 producer 的成果不能进入当前有效结论。

**验收：**交接不自动重跑或丢弃正确成果；旧 owner 无法继续创建有效控制决定；迟到旧要求结果可追溯但不覆盖当前结果。

### R05 — 取消“修改要求即可写成验收通过”的通路

**优先级：P1。位置：草稿第 1530、1533、1964、1995、2029 行。对应 BW-A33/BW-A34、F13。**

已复现：amend 直接把 Omarchy 实测条件设为 satisfied，服务自动生成当前 verifiedIntentRevision，随后可 succeeded 关闭；带 `hasWriteConflicts:true` 和必需写入缺口的成果也可经状态 patch 验收并关闭（P06、P07）。

- [ ] 修改目标、约束和验收条件不能直接写入“已经验证”的事实；新/变更条件应按证据重新核验。
- [ ] 用户明确修改或豁免必要条件时，保留要求变更及授权依据；不得把豁免记成真实实测通过。
- [ ] 验收结论来源于受控证据记录，不由模型提供的 status/boolean 自行成立。
- [ ] 将实际效果、blocked/rejected/writeConflicts、未覆盖范围与必要验收项关联；必要缺口没有补齐前不能 succeeded。
- [ ] 保留有效部分并允许有依据的部分采纳；不要把任意冲突简单变成整批成果作废或整批重跑。
- [ ] 后续解决冲突/补齐必要项时记录对应证据，再满足受影响的验收项。

**验收：**P06/P07 的路径无法误报完成；自动检查通过但必要 Omarchy 反馈缺失时明确等待；补齐当前版本的真实证据后才满足条件。

### R06 — 增加来源/代码/产物版本的证据约束

**优先级：P1。位置：草稿 `WorkCriterionDto`、`WorkDeliverableDto`、`SubmitDeliverableParams`、`AcceptDeliverableParams` 和第 1986、2004 行。对应 BW-A23/BW-A34/BW-A35。证据性质：契约静态分析。**

同一用户要求可以检查提交 A、B，两者 intentRevision 相同。当前代码主要核验要求版本，并接受 `verifiedByRealEnvironment:true`，没有落实被测 SHA/输入快照/产物版本与当前目标的匹配。由此推导旧 A 的实测可能用于确认 B；本轮未执行真实多提交/Omarchy 场景。

- [ ] 持久化当前目标的来源版本和有效执行引用；来源顺序依权威指向/明确快照，不依到达时间。
- [ ] 验收证据能追到被测输入快照、来源 SHA 或产物身份、环境与可信来源，并与当前目标核对。
- [ ] 用户实测允许作为独立反馈，不强制伪装成后台 execution；必须明确绑定被测版本并有可核验来源。
- [ ] 不用提高 intentRevision 来替代所有来源版本变化，也不把布尔标志当成已认证实测事实。

**新增行为用例：**要求不变、B 已成为当前目标，A 的成功反馈晚到；保留 A 证据但 B 仍待验。B 对应环境与版本的反馈到达后再通过；另测来源事件乱序与外部文件变化。

### R07 — 统一取消、结算与终局状态机

**优先级：P1。位置：草稿第 1742、2176、2187、2222 行。对应 BW-A24/BW-A26、F08。**

已复现：已有 unknown 外部效果仍直接 cancel 成 closed；有在途执行和 unknown blocker 仍可 close(cancelled)；已 closed/succeeded 又被新 close 请求改为 cancelled（P08、P09、P12）。P08 的在途执行前置条件通过真实 SQLite 写入，因为草稿没有公开 dispatch 实现；关闭调用仍是原方法。

- [ ] 用持久化准入、执行回执、外部效果核对事实判断结算状态；不能依赖调用者的 `hasInFlightSideEffects` 提示。
- [ ] 对相关控制入口统一执行冻结生命周期转换表；未确认外部效果保持 closing 和明确阻碍。
- [ ] 停止、回执查回、结算指令不能被“已取消，禁止新业务”的过滤器吞掉。
- [ ] 普通 close 不能重写已关闭事项的终局结论和关闭时间；相同操作重试走原回执。
- [ ] once/watch/有限跟进按各自完成与停止语义处理；关闭时停用该 Work 专属订阅，不影响其他 Work。

**验收：**取消准入前阻止新动作，准入后结算已入场效果；unknown 不被当作未发生；仅在符合关闭条件时 closed；终局不被新普通 close 改写。

### R08 — 对齐 current-only 数据库与唯一 Work 真源

**优先级：P1。位置：草稿第 459、664、721、877 行；当前 `AppDatabase`、`ConversationGoalRepository`、`ConversationGoalService`、`AgentService`。对应 BW-A01～BW-A06 的数据/接线部分、F02/F14。**

审查基线的 AppDatabase schema=27，打开前先备份重建不兼容库，初始化只接受 0 或 CURRENT；草稿无条件写 user_version=28。单独插入迁移调用或只改常量均无法按其描述执行旧库复制。这里的版本数字是审查事实，实施和测试应读取当前常量，不能硬编码。

草稿将旧 Goal 复制到新 works；基线 AgentService 仍实例化旧 Goal 服务和仓储。已复现新 Work 标题变化但旧 Goal 标题不变。只有把仍活跃的读写入口一起接回才解决双真源问题；保留只读历史档案本身不是双真源。

- [ ] 新结构纳入现有当前 schema 初始化，保留不兼容库备份重建；移除无需求的旧 Goal 数据迁移。
- [ ] 将现有 Goal 语义、工具、查询、控制、归档关系及 UI/remote 适配到一个权威 Work 模型；不保留两套独立活跃主记录。
- [ ] Work 与会话多对多，具体消息/卡片引用可确定目标；对话归档不级联删除 Work、责任或在途记录。
- [ ] 接线 Bot 身份/渠道映射与 Work 所有权；停用保留责任和结算，新增调度受阻。
- [ ] 更新当前 schema 与服务行为测试，引用当前 schema 常量；不恢复旧数据迁移测试。

**验收：**当前结构重新打开保持新对象；现有入口读写同一 Work；更改不会只出现在新表而旧 UI 仍读旧表；多事项与归档行为按冻结场景联合验收。

附带实测：草稿将真实旧 criterion `met` 变为 pending，将 `agent_explicit_request` 变为 user。应删除不需要的兼容路径，不把修旧迁移变成本任务额外目标。

### R09 — 将专家显式采纳绑定到确定配置版本

**优先级：P1。位置：草稿第 971、992、995 行。对应 BW-A07、F06/F11。**

已复现：stage v2 后用户审阅期间又 stage v3，再 adopt(v2 的 hash)，最终 activeVersion=3 而提示词 hash 属于 v2。采纳函数也没有将新版本的 MCP/skill 名单一起切换的契约。

- [ ] 采纳携带用户确认的 `expectedPendingVersion` 或不可变配置 snapshotId，并在同一事务中核对。
- [ ] 由宿主读取该版本的完整配置，原子绑定提示词、能力名单和其他配置，不从互不关联的输入拼装版本。
- [ ] 与现有 ExpertService/绑定机制衔接；新配置仅按约定边界生效，在途执行继续使用固定快照。

**验收：**审批期间出现更新版本时明确冲突或按明确版本采纳；不能出现版本号与内容错配；另一 Bot 与在途执行不被串改。

### R10 — 分开历史操作回执和当前 UI 状态广播

**优先级：P2。位置：草稿第 2334、2421 行。对应 F13；关联 BW-A45/BW-A46。**

已复现 pause(v2)→resume(v3)→重放旧 pause 后，数据库 active/v3，最后 emitUiPatch 却是 paused/v2（P13）。只确认服务发出旧快照，本轮未验证 renderer 是否接受并回滚。

- [ ] 重放仍可返回原操作结果，但不将它当作当前状态广播；选择不发 patch，或另读当前 Work 发布。
- [ ] UI/remote 对乱序版本做适用的丢弃/重同步，当前权威事实来自业务库。

**验收：**重放不会广播比当前事实更旧的状态；重连从当前事实恢复，历史回执仍可查询。

## 3. 已执行探针与待落地的行为断言

下表 P01～P13 按 [logic-results.json](reviews/bot-work-phase1-2026-11-06/results/logic-results.json) 数组顺序编号。结果中的 `ok:true` 是草稿返回“接受操作”，不代表测试 PASS。把这些反例改造成当前服务的正式行为断言，覆盖正向路径；不能仅运行旧草稿探针作为修复验收。

| 探针 | 已观察到的草稿行为 | 修复后必须断言 | 任务 |
| --- | --- | --- | --- |
| P01 | 相同 create ID、不同主体/正文返回旧 Work | 权限隔离且异请求冲突，不泄露其他主体回执 | R01/R02 |
| P02 | amend ID 被 cancel 复用，成功重放但仍 active | 不同操作明确冲突，取消不能被假成功吞掉 | R01 |
| P03 | 要求改版后无守卫旧控制决定被接受 | 必需守卫缺失/过期决定被拒绝 | R03 |
| P04 | 另一用户填 actorUserId 后暂停 Work | 可信身份与授权不匹配时拒绝 | R02 |
| P05 | 不存在的 Bot/execution 提交成果 | 无有效执行/委派的提交拒绝 | R02/R04 |
| P06 | amend 直接标实测满足，再成功关闭 | 要求编辑不能生成验证事实 | R05 |
| P07 | 必需写入被阻止仍 accepted/succeeded | 必要缺口未解决前不能满足/成功关闭 | R05 |
| P08 | 在途执行和 unknown 仍 close(cancelled) | 未结算不能 closed | R07 |
| P09 | 已记录 unknown 被 cancel 忽略 | 从持久事实进入 closing 与阻碍 | R07 |
| P10 | 交接后有效旧 worker 因 epoch 被拒 | 核对有效委派后可接收，不自动重跑 | R04 |
| P11 | 缺版本旧成果被标为当前版 | 从绑定确定来源；不默认升级版本 | R04 |
| P12 | 新 close 改写已 closed 的结论 | 终局不能由普通 close 改写 | R07 |
| P13 | 重放旧回执广播旧 UI 快照 | 保持当前投影，历史回执单独返回 | R10 |

[schema-results.json](reviews/bot-work-phase1-2026-11-06/results/schema-results.json) 另包含：DDL 成功创建 12 张表、专家采纳版本错配、旧枚举转换错误、Goal/Work 分裂和 schema 常量差异。DDL 可执行是正向观察，不能据此说 SQL 跑不起来；数据库重启备份重建的后果来自实际 AppDatabase 分支分析，本轮没有运行整个 Electron 宿主。

R06 的“同要求、不同代码版本”需要新增正式行为用例。不要将静态推导混入上述已执行反例计数。

## 4. 保留五阶段，补齐前置依赖和联合验收

| 工作组织 | 负责实现 | 组件证据 | 必须联合闭合的行为 |
| --- | --- | --- | --- |
| Phase 1 | Bot/Work 数据模型、可信控制、版本、验收契约 | 真实 SQLite 与服务行为检查 | A01～A08/A23 的渠道、归档继续执行、配置装配、Memory 隔离仍需真实接线 |
| Phase 2 | 前后台分离、Inbox/Outbox、Durable 绑定与双向恢复 | 原生执行适配与持久化边界故障注入 | A15 恢复前发生取消时仍找回原 submission 并核对/停止 |
| Phase 3 | 结算、交接、资源门控 | 实际效果、资源冲突与接管检查 | A33/A34 使用先确定的证据/验收内核判断真实缺口 |
| Phase 4 | 订阅、离线、因果防环、共享预算窗口 | 可注入时钟与乱序事件；并发预算记账 | 预算依赖 Phase 2 派发时已经存在的持久预留/核销身份 |
| Phase 5 | 通知、卡片、同步投影与完整 E2E | 投递恢复、跨端重连、展示与证据 | 全部适用 A01～A46 与第 9 节端到端故事 |

三个前置依赖必须体现在实现接口中：

1. **恢复与停止：**Phase 2 adapter 从第一版区分“新业务准入”与“原 task/store/conversation 命名空间的查回、停止、结算”。Phase 3 再完善完整流程，不能先写一个取消时拒绝一切恢复的投递器。
2. **成果验收：**现在确定来源、实际效果、条件、环境证据的关系。Phase 3 组合验证 A33/A34，通知投递与 UI 仍可在 Phase 5 完成，无需把整个阶段前移。
3. **共享预算：**Phase 2 派发留出事务预留/核销身份，Phase 4 再实现窗口、预留防超额与未知用量策略；重启/交接不能重置已有额度。

方案中的“禁止前台耗时工具”应按冻结语义落实：实际业务操作经后台入口，不能按耗时长短放行。宿主排他控制需要一个明确的权威身份与接管语义；两处存储各自存在一个租约并不自动证明单主。

## 5. 测试安排与完成记录

### 5.1 测试基线

- [app-store-transactions-test.ts](../scripts/app-store-transactions-test.ts) 验证 renderer 的 createAppStore 状态事务，保留为 UI 回归；它不承担 SQLite Work/Inbox/Outbox 原子性证明。
- 复用 [db-migration-test.ts](../scripts/db-migration-test.ts) 与 [db-schema-discard-test.ts](../scripts/db-schema-discard-test.ts) 的当前 schema/备份重建契约，新增 Work 服务的真实临时数据库行为断言。
- 崩溃恢复按冻结验收在持久化边界注入故障并关闭、重新打开存储。仅丢弃内存对象或跑本归档内存 SQLite 不构成恢复验收。
- 原生 Durable、跨端 UI、真实 Omarchy 与发行包证据分别记录；本任务不添加打包要求，适用环境缺失时如实标 blocked/not-run。
- 测试脚本名称可遵守仓库现有约定；如新增 `test:*`，按 AGENTS 和 test-all 分类规则登记，不扩大已知失败基线掩盖回归。

### 5.2 交付记录

执行后在本节或关联实施报告记录，不把勾选任务代替证据：

| 字段 | 要求 |
| --- | --- |
| 源码 | 实际执行与测试的 SHA、关键改动文件 |
| 任务 | R01～R10 各自处理方式与剩余项；保留未完成复选框 |
| 验证 | 命令、环境、实际输出、对应 BW 场景与证据位置 |
| 结论 | 每项使用 passed / failed / not-run / blocked |
| 边界 | 区分代码检查、服务测试、原生集成、真实桌面与发行包 |

本轮已经执行：原上传 TS 的类型转换、原方法与原 SQL、Node 24.22.1 + node:sqlite 同步薄适配、13 条服务反例及 5 项 schema 观察。未执行目标仓库 better-sqlite3 集成、仓库类型检查、原生 Durable、renderer、Omarchy 或完整 BW/E2E。因此本次文档提交不能视作代码修复或功能验收通过。

## 6. 固定来源

- [冻结设计基线](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/cb9680891f8b86aed69d7ace904bca0f2ec7d8cd/docs/bot-work-design.md)
- [验收规范审查版本](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/1d31faac8fe45d29cf4cc30f0cd821ec50722dc7/docs/bot-work-acceptance.md)
- [AppDatabase 审查版本](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/1d31faac8fe45d29cf4cc30f0cd821ec50722dc7/src/main/db/AppDatabase.ts)
- [AgentService 审查版本](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/1d31faac8fe45d29cf4cc30f0cd821ec50722dc7/src/main/agent/AgentService.ts)
- [ConversationGoalRepository 审查版本](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/1d31faac8fe45d29cf4cc30f0cd821ec50722dc7/src/main/agent/ConversationGoalRepository.ts)
- [原 Goal 共享契约](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/1d31faac8fe45d29cf4cc30f0cd821ec50722dc7/src/shared/conversation-goal.ts)
- [AGENTS.md 审查版本](https://github.com/qq824045252-ship-it/wavealstra_harness/blob/1d31faac8fe45d29cf4cc30f0cd821ec50722dc7/AGENTS.md)
