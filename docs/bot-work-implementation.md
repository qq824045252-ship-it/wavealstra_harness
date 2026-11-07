# Bot / Work 实施记录

实施日期：2026-11-06；交付记录更新：2026-11-07。源码基线：`0501a10bdeff3b80996b16ad14af38521d6b0200`。Phase 1 实现与本记录在同一提交中交付，提交号可用 `git log -1 -- docs/bot-work-implementation.md` 查询。本文件记录实现与检查结果，不修改冻结设计，也不表示 BOT-WORK-1.0 已交付。

**最新待执行阶段：** [Phase 5 执行规划](bot-work-phase5-execution-plan.md)（2026-11-07，已核对远端审核基线 `main@57e6fbbdf7977d46ac2d9bf0d606b26da3bb6fe4`）。规划已确认，P5-00～P5-08 待实施，BW-A42～BW-A46 与第 9 节十步故事尚未完成阶段验收。Phase 4 已实施并加固，冻结实现为 `3153cf09125f946eb6d1a3fad7f634d132f242ee`；最新验证边界以 [Phase 4 加固复核](reviews/bot-work-phase4-followup-2026-11-07.md) 为准，两轮 Linux 全量均为 344 passed / 1 failed，整体验收仍未完成。下文各次实施/测试记录保留为历史证据，本轮只更新规划入口，不将既有测试结果改写为 Phase 5 通过。

本轮依据以下 GitHub 规划执行，本地文件内容已核对一致：

- [冻结设计](bot-work-design.md)，Git blob `387486928ff2984ab00520b1bd7729fa7758b273`。
- [R01～R10 与五阶段顺序](bot-work-phase1-review.md)，Git blob `40124aa8f24dd66453d059bf688cc042d0a83f3b`。
- [双页面与入口规范](bot-work-ui.md)，Git blob `ce52fec1dc8f6671d8be512a899f9af135663adc`。
- [BW-A01～A46 与端到端故事](bot-work-acceptance.md)。

## 当前实现与证据范围

**Phase 1 已完成，验收范围为规划第 4 节的真实 SQLite、服务行为及宿主接线。** Bot/Work 唯一数据源、可信身份和控制版本、来源快照、验收证据、渠道身份、专家配置装配与 Memory 隔离均已实现并执行联合检查。完整 Bot 前台对话与后续五阶段的总体交付仍按原规划推进。

保留用户已有的 Bot 页面、Bot/Work 模型和 Goal 适配改动。此次修复控制契约，并增加 Phase 2 原生执行适配。执行仍由现有 Pi Durable 调度、保存 checkpoint 和恢复；业务适配器只投递已保存的执行绑定、查回原提交、请求停止和接收成果。

Bot 页面发送仍是草稿占位，没有接成另一种受理流程。当前没有把这个页面当作完整 Bot 对话入口验收。

### 已修复的控制问题

| 问题 | 当前行为 | 对应规划与组件证据 |
| --- | --- | --- |
| 宿主租约一分钟后过期 | 宿主启动续租；停止时释放自身租约；旧宿主不能释放新持有者的租约 | F14、BW-A13；可控时钟与真实 SQLite |
| 修改要求直接结清已提交执行 | 保存失效标记，但保留在途状态；原生停止或结果查回后才结算 | R04/R07、BW-A24；服务测试与原生适配测试 |
| 实测反馈默认归到当前输入 | 反馈必须明确指定被测快照；A 的迟到反馈不能验证 B；变更来源不能沿用旧输入身份 | R06、BW-A34；真实 SQLite 行为测试 |
| 派发和结算覆盖预算更新 | 保留已预留额度；拒绝超额预留；结算幂等；未知用量继续占用额度 | Phase 2 预算前置接口、BW-A40 的组件部分 |
| 外部通知已发送但未保存回执时重复发送 | 发出前持久保存 unknown；非幂等渠道不盲重发；可回查渠道先核对 | F07、BW-A43 的 fixture 部分 |
| 模型经 Goal 适配器获得用户身份或当前版本 | 模型创建保留 Bot 身份；模型控制必须携带原先读取的完整守卫 | R02/R03；服务回归测试 |
| 重放和事务回滚污染当前 UI | 重放前核验当前访问权；事务提交后才广播；回滚不泄露临时投影；较旧查询响应不覆盖较新投影 | R01/R02/R10；服务与 renderer 测试 |
| 来源变化后发送旧成果通知 | 未发送的旧输入通知失效；取消停止未发送成果通知；失效不冒充用户已读 | BW-A28 的组件部分 |

### 原生执行适配的已执行边界

`scripts/bot-work-execution-test.ts` 使用隔离的业务 SQLite、真实 Durable JSONL、fixture 模型和有实际文件追加效果的工具。关闭并重新打开两处存储，不读取真实凭据。

| 场景 | 本轮实际断言 | 结论 |
| --- | --- | --- |
| BW-A02/A06 | 归档关联的真实前台 Task，重开业务库与原生存储；原 Work 的后台工具仍产生一次实际文件效果并保存成果，归档关系保留 | passed，归档与执行链路 |
| BW-A14 | 派发绑定已提交、原生投递前关闭存储；重开后投递原操作，实际工具只执行一次 | passed，所列组件边界 |
| BW-A15 | 原生已完成，但业务库尚无回执；先取消，再关闭重开；查回原 task/store/conversation 的提交，保留结果，未增加工具效果 | passed，所列组件边界 |
| BW-A16 | 在成果回执插入处用 SQLite trigger 注入失败；成果与业务回执一并回滚；重开后读取原生结果，只产生一份成果 | passed，所列组件边界 |
| BW-A24 | 模型已准备调用工具，准入前取消；宿主拒绝新动作，实际效果次数不增加 | passed，所列组件边界 |
| BW-A33 | 原生结果含结构化 writeConflicts，最终模型仍给出回复；Work 保留冲突，不能验收该成果 | passed，所列组件边界 |

成果仅保存为待验收记录。原生 status=completed 不自动满足 Work 验收条件，也不自动关闭 Work。上述用例不代表整个 BW 场景或端到端故事完成。

## Phase 1 联合验收

新增 `scripts/bot-work-phase1-test.ts`，使用独立临时目录和真实数据库；四个 worker thread 各自打开 SQLite 连接。专家用例通过真实 `ExpertService.installByPath/update/uninstall`，不使用伪造模板服务；Memory 用例调用统一 Kernel 和生产提示投影函数。`AgentService` 将渠道 Bot 身份接入 Goal 模型调用，并在原生任务准备时安装执行绑定的完整专家快照。

| 修复项 | 已执行的 Phase 1 行为 | 后续阶段的联合验收 |
| --- | --- | --- |
| R01 | 四个独立连接并发同请求，只产生一个 Work、回执和 Outbox；省略缺省值与标题规范化后重放，嵌套变更明确冲突 | 手机/远端真实网络重连 |
| R02 | 宿主身份、用户隔离、worker 执行归属、当前授权与工具准入；绑定桌面/Gateway 渠道指向同一 Bot | Phase 2 独立 Bot 前台与完整入口体验 |
| R03 | 必需版本守卫、旧决定拒绝、遥测不推进控制版本；Goal 工具从宿主渠道解析模型 Bot | Phase 2 异步对话完整故事 |
| R04 | 不可变绑定、交接后有效旧成果、旧要求成果保留历史；拒绝把另一 Work/Bot 的执行 Task 当新上下文使用 | Phase 3 完整团队交接与实际效果核对 |
| R05 | 执行者自述不能满足验收；宿主实际读取产物后部分采纳；必需项缺失拒绝关闭，补齐当前证据后才成功；Goal 多步变更失败整体回滚 | Phase 3 资源门控与真实环境联合流程 |
| R06 | 独立用户反馈绑定被测输入/环境；同要求 A→B 不提升 intentRevision；实际文件 SHA 观测和迟到旧读不能回滚当前目标 | Phase 4 自动事件源接入；真实 Omarchy 验收未运行 |
| R07 | closing/结算/终局保护；watch 一轮不能结束职责，可信停止后只停本 Work 的订阅；原生取消后查回原提交 | Phase 3 所有外部效果与停止时限 |
| R08 | 当前 schema、备份重建、Goal/Work 唯一真源、持久渠道映射与消息卡片引用、多 Work 明确消歧；停用保留责任且阻止新派发；归档后原生继续执行 | Phase 2 完整 Bot 对话 UI |
| R09 | 明确待采纳版本；旧待审记录不被改写；真实专家更新/卸载后，在途仍装配原提示词、完整私有技能和 MCP/connector 名单；全局技能停用仍生效 | Phase 5 配置审阅交互与完整模型/外部能力故事 |
| R10 | 历史回执与当前广播分离、事务回滚、renderer 实际 store 拒绝旧投影；重开从当前业务事实读取 | Phase 5 跨端增量与真实重连 |

BW-A07/A08 的 Memory 接线使用已有 Kernel：绑定的 Bot 前台读取自己的私有记忆；Work 执行者按持久绑定读取自己的 Bot 与当前项目共享事实。实际提示投影排除其他 Bot 和个人 Global；模型不能替换绑定的 Bot 身份，不能将执行推测自动提升到团队/全局。普通任务的既有 Global 行为保留。

后续联合场景仍属于冻结范围。本次 passed 是 Phase 1 的代码与服务接线验收；不把服务夹具中的环境反馈称作真实 Omarchy 实测，也不把静态 renderer 检查称作完整 GUI 验收。

## 运行检查

2026-11-07 提交前复核：58 个源码、脚本和配置文件与全量门禁通过时的 SHA-256 一致；重新运行 `pnpm -s typecheck` 和 `pnpm -s test:bot-work-phase1` 均通过。暂存检查随后仅清除了 `bot-work-schema.ts` 末尾的多余空行，业务代码未变。下表的全量 314 项结果来自前次运行，本次没有重复运行全量套件。

| 命令 | 结果 |
| --- | --- |
| `pnpm -s typecheck` | passed；scripts 新增类型错误为 0 |
| `pnpm -s test:all` | passed；Windows headless 314 项通过，0 失败，0 已知失败；2 项 Linux 平台限定用例未选中 |
| `pnpm -s test:bot-work-phase1` | passed；并发 SQLite、渠道与消息引用、可信证据/部分验收/补齐、来源乱序与真实文件变化、专家装配、Memory 实际提示投影、重开持久化 |
| `pnpm -s test:bot-work-control` | passed；包含此次修复的回归断言 |
| `pnpm -s test:bot-work-execution` | passed；包含上表五组原生边界断言 |
| `pnpm -s test:bot-workspace` | passed；这是 renderer/store 与静态 React 渲染检查 |
| `pnpm -s test:durable-tool-policy` | passed；保留普通模式、只读、MCP、Codemode 嵌套工具与已有恢复策略 |
| `node scripts/test-all.mjs --audit` | passed；新增原生组件测试归 headless |
| `node scripts/ipc-channel-inventory.mjs --check` | passed；已核对本轮原有新增的 7 个 Bot 通道并更新生成清单 |
| `pnpm -s test:durable-bot`，额外探查 | failed；既有套件先在最终 busy 断言失败。诊断中等待原生 idle 后继续遇到 Codemode fork store 断言失败；诊断改动均撤回。该套件属于 NETWORK 分类，不在本轮 default headless 通过范围内 |
| GUI、移动端、完整 BW 端到端故事、Omarchy | not-run |
| 本地提交 | 2026-11-07 按用户要求在 `main` 提交 Phase 1 实现与验收记录 |
| 构建、打包、安装、推送 | not-run；本轮未执行 |

第一轮 headless 的 7 个失败已修复，没有增加 `test-baseline.json` 条目。修复包括把测试中的当前 schema 常量硬编码改成读取代码、为 Bot 状态登记独立 store 契约，以及把 Bot 建表代码移至 `src/main/db/bot-work-schema.ts`。原有 store 成员冻结列表保留，新增成员单独登记。

本机本阶段日志保存在 `out/diagnostics/bot-work-review/`：`phase1-final-test-all.log` 为最终全量门禁，`phase1-typecheck.log`、`phase1-control.log`、`phase1-regressions.log`、`phase1-execution.log` 为定向证据。中途一次复核因新增输入快照检查先于授权检查而返回不同错误码，已恢复授权优先并复跑通过；没有放宽测试断言或失败基线。`phase1-source-manifest.json` 保存执行源码的 SHA-256。该目录是生成证据，不是冻结设计或源码真源。

## 后续阶段

### 2026-11-07 GitHub 复审补充

对 Phase 1 提交 `8e558289a16ae2b964cf968ecd7af96eab033dc9` 的后续审查发现并修复了控制身份、租约接管、历史成果、执行证据范围、共享记忆写入、初始专家快照和 renderer 刷新问题。问题、修复、27 组新增行为回归及环境限制见 [GitHub 复审记录](reviews/bot-work-phase1-2026-11-07.md)。上述提交前的原始检查记录保留为历史证据；不要将它与本次复跑范围合并为一次完整验收。

Phase 1 交付时，Phase 2 的前台独立对话、Work 受理与控制工具、事件消费和业务派发入口仍待实现；当时的适配器只能恢复已有派发绑定。之后的 Phase 2 实施见下节。

**最新可执行 Phase 2 计划（2026-11-07，审核基线 `ac2b458`）：[bot-work-phase2-execution-plan.md](bot-work-phase2-execution-plan.md)。** 作为 Codex 的实施清单，含 M1～M3、P2-00～P2-08、完整 BW-A09～A20 故障注入门禁。按该计划**复用** Phase 1 的服务/租约/执行适配器，优先补独立前台真实发送、受守卫工具、持久结果消费、预算与同步边界；Pi 1.3 离线类型垫片明确禁止。该计划获批时是待实现任务，当前逐项实施与检查见下节。

2026-11-07 已同步至 `63e42fe` 并完成 P2-00 预检：本机真实 Pi 1.5 依赖齐全，规定的七项基线、类型检查与完整 `test:durable-bot` 均通过。修复了工具装配异常时读取历史的执行隔离问题，新增原生只读、损坏日志不写回、并发发送及 purge 回归；全量 headless 319 项通过、失败 0。问题、撤回的中间方案与最终证据见 [Phase 2 预检记录](reviews/bot-work-phase2-2026-11-07.md)。该次仅完成前置门禁，当时未将 Phase 2 标记完成；M1～M3 随后按同一执行规划继续实施。

Phase 3 继续完成资源门控、结算、部分成果和交接。Phase 4 完成真实订阅、离线补处理、因果防环与原生用量记账。Phase 5 完成通知渠道、双页面交互、跨端同步，以及全部适用 BW 场景与端到端故事。Phase 3～5 及 BOT-WORK-1.0 总体尚未验收完成。

**Phase 3 已按 [执行规划](bot-work-phase3-execution-plan.md) 完成 P3-00～P3-08 实施（审核基线 `main@a6bb4a5`），不是只有文档确认。** 资源身份与成组准入（`WorkResourceGate`）、文件/Shell/MCP/Code Mode 统一动作 gate、桌面与浏览器输入边界、多源产物指纹与写前/验收前重验、部分成果与缺口定向补跑、暂停积压与在途结算、八类协作消息与原子交接、通知发送前重验均已接入现有 SQLite schema（32）、Inbox/Outbox 与投影；未引入旧数据迁移层。逐项证据见 [Phase 3 实施与验证记录](reviews/bot-work-phase3-2026-11-07.md)：typecheck 与 `test:all`（336 项，失败 0）通过，`test:bot-work-phase3:dev` 真实 dev 页面通过；BW-A31 真实 Windows 桌面输入仍受 `FOCUS_FAILED` 阻塞，Linux/Omarchy、移动端与发行包桌面未运行，因此 Phase 3 不得整体标记验收通过。


## Phase 2 实施与验收（2026-11-07）

**M1～M3、P2-00～P2-08 已完成本阶段实施及 Windows 组件验收。** 独立 Bot 持久消息、真实发送/历史/取消、前台工具白名单及 actor/CAS、后台独立原生 root、统一持久 Inbox/Outbox、精确预留与 owned-child 用量、未知效果恢复、列表水位/tombstone 已实际接线。

真实 Pi 1.5、临时 SQLite/JSONL 和实际外部效果 fixture 覆盖 BW-A09～A20 及规划关联项。8 个后台强杀窗口各只有一份原绑定、一个实际效果和一份结果；前台取消跨两次强杀没有产生 Task/Work/效果。原生配额/业务失败/工具之后失败保持分类边界，owned child 用量父 10 加子 17 只记 27，原预算和期限不重置。真实 Bot 对话归档时后台继续；普通问答不创建 Task 或 Work；正常退出恢复原请求后仍可发送下一条。

最后冻结源码后 `pnpm -s typecheck` 通过，`pnpm -s test:all` 为 324 passed / 0 failed / 0 known failed。独立运行 NETWORK 的 durable-bot、durable-subagent，以及临时用户配置下真实 `pnpm dev` 页面发送、后台原生结果、卡片和成果/证据详情，均通过。真实 Omarchy、Linux 专属桌面、移动端未运行，不标通过。

逐项代码、故障计数、最终源码指纹和门禁日志见 [Phase 2 实施与验收记录](reviews/bot-work-phase2-2026-11-07.md)。Git 基线为 `main@63e42fe`，Phase 2 实现与验收记录随同一 main 提交交付，提交号可用 `git log -1 -- docs/reviews/bot-work-phase2-2026-11-07.md` 查询。验收完成后，用户明确授权更新、提交并推送；没有运行发布构建、打包、安装或快捷方式更新。

## Phase 3 实施与验证（2026-11-07）

**P3-00～P3-08 已完成实施，组件与 headless 门禁通过；Phase 3 整体验收未完成。** 资源身份、成组准入与单调 fencing 集中在 `WorkResourceGate`；普通 Task、owned child、Code Mode、文件/Shell/MCP 写、桌面与浏览器输入走同一动作 gate，`WorkResourceRecovery` 在安静的原生图与释放回执后才接管。部分成果、必要缺口与只读重新核验接入统一结果 Inbox；暂停积压只消费原 Inbox，each/latest/skip 各自保存事实。八类协作消息、原子交接、发送前重验与通知认领/投递按当前 schema（32）落地，未写旧版本迁移层。

八个 `test:bot-work-phase3-*` headless 用例与 `test:bot-work-phase3:dev` 真实 dev 页面通过；最终 `pnpm -s typecheck` 通过，`pnpm -s test:all` 为 336 passed / 0 failed / 0 known failed / 0 new regressions。本轮较早一次全量门禁的两项新增回归（`test:architecture-graph`、`test:conversation-runtime`）已修复后重跑，未修改失败基线。

BW-A31 的真实 Windows 桌面输入链仍阻塞：目标窗口聚焦请求返回 `FOCUS_FAILED`，真实前台未改变；没有操作用户业务窗口或关闭用户进程。Linux/Omarchy、移动端与发行包桌面未运行，不标通过。逐项场景、故障窗口和门禁日志见 [Phase 3 实施与验证记录](reviews/bot-work-phase3-2026-11-07.md)。用户明确授权实现、提交和推送；没有升级版本、运行发布 build/pack/dist、安装或更新快捷方式。

### Phase 3 加固后的最新验证边界（2026-11-07）

恢复探针 fencing/attempt、Windows 系统浮层及原宿主输入释放回执、交接迟到成果保留已在 `671574ab8e5bfddbdce6e97866c82c6775623ee7` 加固，`e454341ae3268e7a2ab1cdbc55d84231171f0aa3` 冻结 [后续复核报告](reviews/bot-work-phase3-followup-2026-11-07.md)。正常交接本来就原子保存 owner/epoch 和 adoption；`pending_adoption` 继续保护缺接纳的迟到回执，不重复运行或记账。

该次 Linux 环境 typecheck 与九项 Phase 3 headless 专项通过；完整 `test:all` 为 **338 passed / 1 failed，退出码 1**，唯一失败是原始基线亦可复现的 `test:atspi-transport` socket `EPERM`，没有修改失败白名单。dev 编译完成后 Electron singleton socket 同样 `EPERM`，未进入页面；真实 Windows BW-A31、Linux/Omarchy、移动端与发行包没有新增通过证据。不得将上节历史 336 项通过/dev 通过套用到这次加固验证。

## Phase 4 规划与执行入口（2026-11-07）

**规划提交时状态（历史记录）：规划已确认，待 agent 实施，尚未验收。** 后续实施与加固结果见本节下方记录，当前待执行阶段已转为 Phase 5。完整任务书为 [bot-work-phase4-execution-plan.md](bot-work-phase4-execution-plan.md)，执行入口为 [GitHub Issue #16](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/16)。基于已核对远端的 `main@e454341ae3268e7a2ab1cdbc55d84231171f0aa3`，覆盖 BW-A36～BW-A41，按 M1～M3 连续完成 P4-00～P4-08。

- M1：真实来源接线、多订阅独立路由、分目标 source-version 比较、固定合并上界/冻结批次、each 队列与有限持久溢出和来源背压。
- M2：单权威宿主中的注入时钟、IANA/DST 唯一 tick、时钟跳变、宿主/来源离线事实、latest/each/skip 补处理与零 Hook 承诺到期跟进。
- M3：可信因果链与专家互调收敛、真实 provider 请求上的共享预算、unknown/迟到回执一次结算、跨重启/交接保持额度及受控窗口。
- 联合交付：受守卫 IPC/配置、真实监控投影和 dev 流程、六项行为专项、适用原生集成与完整门禁、冻结实现 SHA 和独立审查报告。

规划已校正实际方法/路径和预算职责：复用 `ingestSourceEvent/tick`、原 Inbox/Outbox/WorkDispatchQueue，以及 `reserveBudget/commitBudgetUsage/openBudgetWindow`；`EvidenceBudget` 保持上下文注入裁剪职责。新增表、承诺字段、调度/事件生产接线与预算服务均是待实现任务，不能因当前存在基础方法而标记完成。

本次只提交规划和实施入口，P4 清单未勾选；仅核对文档内容、路径、链接和差异，不宣称执行了 Phase 4 功能门禁。开发 agent 完成后须按任务书更新本节和执行 Issue；只有实际任务启动回执才能记录“执行中”。

### Phase 4 实施与 headless 验收（2026-11-07）

**P4-00～P4-08 已实施并完成 headless/native 回归；Phase 4 整体验收仍未完成。** 代码基线 `main@a6c55ba`，未提交工作区实现。新增 `bot-work-phase4-schema`（schema 33）、Phase 4 共享契约、`WorkWatchIngress`、`WorkWatchScheduler`、`WorkCausalGuard`、`WorkBudgetService`，并接入真实 `WorkService.ingestSourceEvent/tick/listDueInbox`、`WorkDispatchQueue` 冻结/回填、`AgentService`/`WorkHostAuthority` 启停与 suspend/resume、`DurableBotRuntime` 的 provider 请求/compaction 边界、IPC/preload/投影和 `BotWorkspacePage`。

六个 `test:bot-work-phase4-*` 专项覆盖 BW-A36～BW-A41：路由扇出/latest-source/不可变 each、离线 gap 与 latest/each/skip、IANA/DST/回拨/前跳/零 Hook 期限、因果防环与跨 Work 扇出、共享预算三桶与窗口、固定合并截止和有限背压。Phase 3 九项专项和真实 Pi 原生结算回归通过。最终 `pnpm -s typecheck` 通过；`pnpm -s test:all` 为 **343 passed / 0 failed / 0 known failed / 0 new regressions**；`--audit` 为 headless 345 / GUI 54 / NETWORK 29 / DATASET 2 / pending 0。既有 `test:bot-work-phase3:dev` 在隔离 HOME 下真实 `pnpm dev` 通过；本轮在该页面通过 preload/IPC 保存 Phase 4 订阅并断言「关注与运行/共享预算」投影渲染。期限/预算按钮未逐项点击。

未运行/blocked：Phase 4 dev 期限/预算按钮逐项点击、Linux/Omarchy/移动端、发行包桌面、真实外部连接器 webhook。Issue #16 回填未由实施会话执行，按交接约定由主会话完成。完整证据、故障修复和实现 SHA 见 [Phase 4 复核报告](reviews/bot-work-phase4-2026-11-07.md)。

### Phase 4 后续加固（2026-11-07）

基于 `main@60a50eec58fbb96cefb1fa4690e430546f2bb57d` 复核并修复来源水位回退、暂停目标分区/容量/回读 CAS、离线分页越过拒收及无回查结果虚报完成；保留并用双连接竞争和故障回滚验证既有 Ingress 即时事务。补充用户/主负责人三版本守卫的 unknown 预算核销、持久审计、迟到可信回执与历史窗口结算；修正多 Work/多冲突阻碍身份和时钟回拨下的请求归属。页面新增核对表单与已结束事项入口，保持列表读取作用域。

恢复测试改为真实核对被强杀 PID 与持久租约到期，并在全量中串行执行该重型套件；原 timeout、业务断言和失败白名单均保持。最终 `pnpm -s typecheck` 通过；两轮完整 `pnpm -s test:all` 均为 **344 passed / 1 failed / 0 known failed / 1 new regression，退出码 1**，唯一失败 `test:atspi-transport` 在基线源码快照也以 D-Bus socket EPERM 复现。两轮 Phase 4 六项、Phase 3 九项以及恢复/性能专项均通过，恢复套件分别 22.8s / 22.7s。

真实 `pnpm dev` 已尝试，Electron 启动时被 Unix socket EPERM 阻碍，新增按钮实际点击仍为 blocked；不宣称全量门禁全绿、Windows 瞬时失败已完成复验或 Phase 4 整体验收完成。schema 保持 33，版本保持 0.1.107，无发布 build/pack/dist。冻结源码指纹 `cd7c759ccbc14a170b8824586b7a19a1ad70ef03c9731e4b874d7ea690141b26`；完整事实、门禁和逐文件指纹见 [Phase 4 加固复核](reviews/bot-work-phase4-followup-2026-11-07.md)。

## Phase 5 规划与执行入口（2026-11-07）

**状态：规划已确认，P5-00～P5-08 待实施，尚未验收。** 完整任务书为 [bot-work-phase5-execution-plan.md](bot-work-phase5-execution-plan.md)。审核基线为已读取远端确认的 `main@57e6fbbdf7977d46ac2d9bf0d606b26da3bb6fe4`，Phase 4 实现冻结 SHA 为 `3153cf09125f946eb6d1a3fad7f634d132f242ee`。覆盖 BW-A42～BW-A46、冻结验收第 9 节十步故事，终局逐项核对 BW-A01～BW-A46、R09/R10 与 UI-01～UI-10。

| 里程碑 | 规划内容 | 完成判据 |
| --- | --- | --- |
| M1（P5-01～P5-03） | 原 accept/close 事务补齐唯一语义卡片；真实通知宿主接线、渠道幂等/回查及 unknown；当前负责人汇总、多专家降噪、服务端阅读事实 | 崩溃/重放只恢复原投递；卡片不重复；不可确认渠道不盲重发；阅读不改变 Work 控制状态 |
| M2（P5-04～P5-05） | 桌面/手机持久 journal 同步、Remote 权限/API/store/UI 接入；epoch/scope 全量替换；摘要与按需诊断、版本化未验证范围；双页面与 Bot 配置审阅 | 旧缓存不压住新真源；同 stateVersion 的阅读/投递仍同步；用户能按版本追溯产物、交接、回执和实测缺口 |
| M3（P5-06～P5-08） | 同库原生十步故事、有限 watch 关闭与对照 B 隔离、三项专项/前序回归、全景证据与实机台账 | 真实原执行恢复、成功分支不重跑、手机反馈绑定原测试产物、可信入口关闭；门禁及剩余 blocked 如实记录 |

本规划已按当前代码校正以下实施要点：

- `acceptDeliverable/closeWork` 已有即时事务，`work_notifications.semantic_key` 已唯一；新增 `work_result_cards` 是已有验收事实的持久投影，不是第二套 Work 或通知真源。
- 当前通知接口是 `idempotent + lookup`，未有独立 payload hash；自动重试的稳定 provider 效果键必须与本地 attempt 分开。Work 通知生产 drain/真实渠道接线列为明确交付项，不以 fixture 类测试替代。
- 实际文件为 `src/main/agent/work/WorkProjectionJournal.ts`、`shared/src/remote-contract.ts`；Work 的 epoch/sequence 与 Durable 对话 epoch/revision、SSE 事件 ID 分责。Remote 转发 patch 不代表手机已有 Work 同步/页面。
- 全量重建必须替换跨 epoch 的旧投影；已读返回服务端持久事实，不能以客户端时间或 Work 控制版本推导。
- 有限 watch 已有按 Work 停订阅及可信关闭守卫；十步故事补有效唤醒清理/隔离断言，沿用可信用户入口。Omarchy 反馈须绑定实际 input/source/artifact 版本，不能仅凭相同 intentRevision 验证修复后的新产物。
- Schema 基于本基线预计 33→34，实施时按当前常量核对；不做旧数据/旧 Pi 兼容，保留不兼容库改名备份。应用版本保持本轮未变。

**本次仅提交规划与实施索引，P5 清单全部未勾选。** 核对了固定 SHA 的设计、验收、代码接线、文件路径、相对链接和文档差异；没有运行 Phase 5 功能门禁，没有开始实现或启动外部执行 agent。

前序证据继续保留：Phase 4 两轮 Linux 全量均为 **344 passed / 1 failed，exit 1**；真实 dev 因 Unix socket EPERM 受阻。Windows 恢复/BW-A31、宿主 D-Bus/AT-SPI、真实 dev 点击、Omarchy、桌面/手机 Remote、外部连接器与真实用量仍按任务书分别补证。缺少必要证据时不能宣称 Phase 5 或 BOT-WORK-1.0 整体验收完成；发行包只在另行发布授权下验证。

