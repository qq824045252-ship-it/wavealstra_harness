# Bot / Work Phase 2 实施与验收记录

日期：2026-11-07，Windows，Asia/Shanghai。按 GitHub 已批准的 [执行规划 2b78044](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/2b78044d4190e01e915ef1a7ec277a5ab5000765) 实施 M1～M3，没有改动冻结设计或 BW 验收语义。

状态：**M1～M3、P2-00～P2-08 已完成本阶段实施及 Windows 组件验收。** 下方保留 P2-00 原始预检历史，不能将其 319 项结果当作本阶段最终证据。

代码基线为 `main@63e42fef874216bb770c71d840cc0ee9da6b6d07`；Phase 2 实现与本记录随同一 main 提交交付，提交号可用 `git log -1 -- docs/reviews/bot-work-phase2-2026-11-07.md` 查询。源码 SHA-256 指纹为 `7859b47ea252e7135fb6dd9187db43e89e6b66fac9fd7793b08b4352aaa422f4`，覆盖 49 个变更或新增的源码、脚本和 package.json 文件。逐文件 SHA 保存在 `out/diagnostics/bot-work-phase2/source-manifest.json`，该指纹由提交前的 `node scripts/bot-work-phase2-source-evidence.mjs` 生成；此命令统计当前工作树相对 HEAD 的未提交源码差异。Git 提交身份以实际提交记录为准。

## 本阶段实现

- M1：SQLite 持久 Bot 会话、用户/助手消息、稳定发送请求与回执、取消意图、历史分页及 Work 引用。前台使用独立 Pi root，不创建普通 Task；普通问答不创建 Work。IPC/preload/renderer 已实际接线，草稿按 Bot 保存，未知发送回执按原 requestId 重试，只有匹配的受理回执清空对应草稿。
- 前台工具是代码白名单，只有已知事实查询、当前 Bot 私有 Memory 与五种 Work 控制。模型不能传 actor、扩大授权、续权或验收；既有 Work 必须使用本回合读取的完整三元版本守卫。工具原始消息从原生不可变 entry 和持久 task memo 解析，不使用可变的当前消息指针。多 Work 模糊控制先澄清。
- M2：Work 决定与持久派发请求在同一业务写事务提交。异步准备后接入现有 `WorkExecutionAdapter` 与 `DurableBotService.workExecutionPort()`；每个业务输入使用独立原生 store/root，沿用现有 owned children、工具准入和恢复。变更输入生成独立绑定，旧成果保留为历史，普通控制不制造输入快照。
- 原生事件只唤醒统一持久 Inbox。完整 task/store/conversation/workspace/operation 与原生 submission/entry 参与事实身份；结果、成果证据、执行状态、准确的 reservation 核算、后续 Outbox 与消费标记在一笔 SQLite 事务内处理。收到但未消费的事实可在重启后补读，坏事实不堵塞其他 root。
- 终态不可被迟到 running/unknown 回退。终态用量补读禁止重新提交业务，也不能因原回执缺失而按零结算。独立 store 的原生总账包括 root、owned children 与 compaction；未完整报告的中断用量保留 unknown、原预留和 blocker。连续回查最多 5 次，可靠终态唤醒或显式控制可以开启新的受控核验；成功事实结束当前恢复周期。
- Phase 3 资源门控前，同一权威宿主管理的可变 root 保守串行；两个已证明只读的 root 可以并行。未知外部效果保留阻碍，不把已有 write-conflict 守卫宣传为全局锁。
- M3：用户作用域的持久 epoch/sequence 日志、一致快照水位、open/all 范围、列表移除 tombstone、缺口/新 epoch 全量补读。renderer 通过序号合并，原无序推送只唤醒补读，旧包不能复活已移除成员，通知 readAt 保持单向。

## 环境与验收方法

Node.js 24.19.0、pnpm 12.14.0，真实 Pi 1.5.0。没有旧 Pi 兼容层、lockfile 修改或失败基线放宽。所有新增模型、外部效果和故障 fixture 使用临时 SQLite/JSONL、确定性模型或本地 HTTP；没有使用用户真实凭据。测试中的 HTTP fixture 证明真实 SDK 和 IPC 链路，不代表外部真实账号或互联网服务验收。

新增可重跑的检查：

| 命令 | 实际覆盖 |
| --- | --- |
| `pnpm -s test:bot-work-phase2` | 真实独立前台、后台未结束时查询/新委托/控制、模糊消歧、旧消息和归档、输入修订、新 root、历史成果隔离、关闭/重开与 cancel-close 竞态、跨用户/actor/停用/过期授权 |
| `pnpm -s test:bot-conversation-ui` | 实际 renderer store：重复点击、延迟/丢失回执、稳定请求、Bot/Task 草稿隔离、乱序历史、取消/归档及列表协议 |
| `pnpm -s test:bot-work-phase2-recovery` | 8 类实际 SIGKILL 故障窗口与 2 次前台取消恢复强杀；关闭并重开真实业务库、Pi JSONL 和外部效果库 |
| `pnpm -s test:bot-work-phase2-invariants` | 完整命名空间、精确/晚到用量、坏事实隔离、有界未知回查、持久周期/显式唤醒、终态缺回执不重跑/不补零、未知预算不提前关闭、lease/CAS 和异步准备竞态 |
| `pnpm -s test:bot-work-phase2-usage` | 真实 owned child：父 5+5 与 child 17 合计 27，只核算一次；供应商配额、普通业务失败、工具之后失败的原生分类，以及原始预算/期限 |
| `pnpm -s test:bot-work-phase2:dev` | 真正 `pnpm dev` 的 Electron、preload、页面、HTTP 模型、Work root、结果和最新投影，使用临时 HOME/USERPROFILE/APPDATA |

前五项属于 headless；最后一项显式归为 Windows GUI，不能用 headless 结果替代。另实际运行 NETWORK 分类的 `test:durable-bot`、`test:durable-subagent`。开发验收期间没有运行发布 build、pack、dist、安装、快捷方式更新或版本升级。验收完成后，用户另行明确授权在 main 更新、提交并推送；没有扩大为发布授权。

## BW 与 UI 矩阵

| 规划项 | 本轮可观察证据 | 结果 |
| --- | --- | --- |
| A02/A05 | 真实 Bot 对话归档时后台原 binding 仍运行，原效果后来只发生一次；旧消息仍可读。两个有效 Work 的模糊“暂停”不改变任一事项，选中/明确 workId 后只控制目标 | passed |
| A09 | 普通问答得到原生回复，Task=0、Work=0；委托 A 在后台工具未结束时，前台仍可查询、新建 B、暂停/取消 B | passed |
| A10/A11 | 独立 root 与真实 owned child；前台实际模型请求只收到白名单，越权 write 不落文件；沿用 native/MCP/Code Mode/child 准入回归 | passed |
| A12 | 原生 child 配额拒绝仅有界补试并保留成功恢复诊断；普通业务失败不重试，已有工具调用后不重试且实际效果=1。各 Work 只有一个绑定/预留，原预算窗口和 child deadline 不变 | passed |
| A13 | 本轮多连接 lease/CAS、第二宿主拒绝；现有 Phase 1 四个真实 worker/SQLite 连接并发相同操作仍只有一个 Work/回执/Outbox，当前重新运行 | passed |
| A14 | Outbox 已提交、native 投递前强杀，重开后只使用原绑定；真实外部效果=1 | passed |
| A15 | native 已接受并完成、业务回执尚未保存时强杀；重开追加取消，从原命名空间查回完成结果，不先 stop，不增加效果 | passed |
| A16 | 结果送达前、可靠接收后未消费、接收/游标事务中强杀。前者补读；已接收事实保留；事务内强杀接收和游标共同回滚；最终效果=1、结果=1 | passed |
| A17 | 消费事务更新标记前强杀：成果/回执/预算等一并回滚，已接收 Inbox 仍待消费。重开一次结算，重复消费不增加效果或费用；另有 poison row 不阻塞健康 root | passed |
| A18 | 外部 SQLite 已产生效果、成功工具响应丢失时强杀。真实原生恢复使用同一效果身份回读，证据含 durable-business-receipt；效果=1，准入结算 consumed | passed |
| A19 | 无幂等/回查契约的工具已产生效果后强杀。重开不重发，准入与外部效果保持 unknown/blocker；另检验回查上限、跨重启保留和受控重新核验 | passed |
| A20 | 真实不同 root 使用同号 numeric conversation=1，但 store/task/input 独立。业务 Inbox 同号 submission/entry 在两个完整 namespace 下分别归属，无串结果或预算 | passed |
| A21 | 模型读取的三元守卫保留到控制事务，用户先改后旧决定被拒绝；原生前台推理不占业务数据库长事务 | passed |
| A23 | 修订后原成果保留为 superseded 历史，不自动满足新输入；旧执行/旧来源晚到的权威源与当前要求回归在本轮重新运行 | passed |
| 幂等/派发 | stable request/operation 与原派发；重复请求无第二份消息或 Work；prepare 期间 pause/resume 只保留原请求，绑定已提交但队列回执丢失不重派 | passed |
| A24 | 原生业务工具准入前取消阻止效果；效果已发生后取消查回原结果、不承诺撤销。前台取消前后两次实际强杀，旧控制不归给新消息，重开后 Task/Work/effect=0 | passed |
| A25 | 两个有效事项中的模糊暂停被要求明确目标，两个事项均未改变；显式选中或引用稳定 workId 只改变该事项 | passed |
| 关联 A34 | 输入/环境反馈及旧要求成果的既有回归本轮重新运行；真实输入修订使用独立 store/root，旧成果保留历史 | passed |
| UI-03/04/05/09 适用部分 | 实际界面发送、匹配受理回执、持久消息、Work 卡片/详情/成果/证据；per-Bot 草稿、普通 Task 状态隔离；cursor/tombstone 与旧包/缺口/epoch/scope/readAt 行为 | passed |

强杀 fixture 的外部效果计数来自独立外部 SQLite 及实际追加文件，不是“方法被调用次数”。每次只强杀该测试新建、已核对 PID 与 checkpoint 的进程，不停止用户已有应用。真实开发界面截图为 `out/diagnostics/bot-work-phase2/dev/bot-page.png`。

## 最终门禁

以下结果均来自最后冻结源码后的实际运行。中间失败与修复保留在决定记录中；最终全量日志为 `phase2-final-gate.log`。全量通过后仅为 Windows dev 驱动补充平台限定元数据，未改变 Windows 选中集或产品源码；分类自检已重新通过。

| 检查 | 最后结果 |
| --- | --- |
| `pnpm -s typecheck` | passed；脚本新增类型错误 0，`phase2-typecheck-final.log` |
| `pnpm -s test:all` | passed；Windows 324 passed / 0 failed / 0 known failed；2 个 Linux 专属用例未选中，`phase2-final-gate.log` |
| `pnpm -s test:bot-work-phase2:dev` | passed；最新页面回复及成果/证据详情已渲染；`dev-ui.log`、`dev/report.json`、`dev/bot-page.png` |
| NETWORK `test:durable-bot` / `test:durable-subagent` | passed；`phase2-durable-bot-final.log` / `native-subagent.log`，没有用默认 headless 冒充 |
| IPC / 分类自检 / diff check | passed；新增 5 个已接线 Bot IPC，无重复或未解析；GUI 单独分类，失败基线未修改 |

真实 Omarchy、Linux 专属桌面链路与移动端：not-run，本机没有相应会话/设备；不标作通过。Phase 5 的真实手机、多端重连、通知渠道精修和整体 BW-A01～A46 仍未交付。Phase 3 的完整资源声明/门控与团队交接、Phase 4 的订阅及更全面真实供应商用量仍按原范围继续。

独立源码复核为 gpt-6-astra。审查发现的具体 P1 已逐项修复并加入行为回归；最终决定轨迹已按本次会话工具记录核对，gpt-6-astra 跨模型审计无剩余 flags；较早 subagent 记录的时间措辞问题已通过冻结源码后的真实补跑和追加记录纠正。追加记录为 `out/diagnostics/bot-work-phase2/decisions.tsv`。交付方式为用户明确授权的 main 直接提交与推送；Git 提交记录标识本次交付，未执行发布。

---

以下为进入 M1 前的历史预检。其状态仅针对当时的 P2-00。

# P2-00 历史预检记录

日期：2026-11-07。执行规划为 [2b78044](https://github.com/qq824045252-ship-it/wavealstra_harness/commit/2b78044d4190e01e915ef1a7ec277a5ab5000765)，本地主线已快进到 `63e42fef874216bb770c71d840cc0ee9da6b6d07`，包含 `ac2b458` 的 Phase 1 复审修复。该时点的记录与未提交改动只覆盖 P2-00 前置检查及其发现的问题。

**以下历史段落记录 P2-00 时点：当时 M1～M3、P2-01～P2-08 尚未实现或验收。** 原 Phase 1 检查结果保留为历史记录，没有用来代替本轮测试。

## 环境与发现

Windows、Node.js 24.19.0、pnpm 12.14.0。本机实际安装的 `pi-coding-agent`、`pi-durable`、`pi-ai`、`pi-codemode` 均为 1.5.0，`dbus-native` 与 `@xterm/headless` 已存在。无需重装依赖；未更改 lockfile、版本校验或失败基线，也没有添加旧 Pi 类型垫片。

开发前规定的七项检查已实际运行并通过：`typecheck`、`test:bot-work-phase1`、四项 `test:bot-work-review-*` 及 `test:bot-work-execution`。

额外的 `test:durable-bot` 初次运行失败。依据本机 Pi 1.5 源码和实际 JSONL 核对后，修正了以下测试假设，并保留精确的行为断言：

- 输入回执完成不等于会话空闲；需要断言 idle 的位置先等待原生 `waitForIdle`。
- `CodemodeStoreDoc` 使用 `fork: "asOf"`；指定第一轮 entry 的 fork 应读到第一轮的 store，父会话仍保持第二轮值。
- `read` 的结构化结果直接是图片块；测试使用当前返回值，未增加旧格式兼容分支。
- fixture 为不同逻辑工具调用生成不同 ID，避免历史结果引用碰撞；元数据测试同时核对实际恢复值与持久 Code Mode 输出。
- 按 `AGENTS.md` 移除仅针对 Pi 1.0 的两项迁移用例，保留当前版本恢复、MCP 与真实工具检查。

随后确认了实际产品缺陷：扩展工厂抛错会阻断只读历史。初次尝试的降级执行缓存经过独立复核后被撤回，因为普通 Harness 打开可能恢复任务、重写 Code Mode 配置，并与并发发送发生生命周期冲突。最终实现使用独立、短期的原生只读查看器，不放入执行缓存：

- Pi `Harness.readOnly` 阻止调度与事务写入；适配层跳过配置、重新生成受理和审计回执写入。
- JSONL 文件系统适配器拒绝写入、追加、截断、重命名和删除，也禁用应用层日志修复。损坏日志返回错误，不在查看时静默修复。
- 严格执行会等待只读查看器结束，再按正常工具装配打开；装配失败仍拒绝执行。
- 服务关闭、任务 release 与永久 purge 均等待正在读取的查看器释放存储租约。

最新主线的 `WorkService.ts` 还触发了现有 2500 行架构门禁。将三个原样的规范化函数移至 `WorkControlNormalization.ts` 后，服务文件为 2485 行，未修改业务规则。

## 实际证据

`test:durable-history-readonly` 使用真实 Pi 1.5、临时 SQLite、Durable JSONL、确定性模型和实际文件工具，覆盖：

| 场景 | 原生/业务状态与可观察结果 | 结果 |
| --- | --- | --- |
| 已持久化 Code Mode 配置与待受理重新生成 | 打开、读取、关闭查看器后配置和 pending 身份相同，所有 JSONL 文件 SHA-256 不变，模型请求及文件效果均未增加 | passed |
| 查看器被调用写入 API | submit/configure 被原生只读契约拒绝，日志不变 | passed |
| 重复提交序号、截断的 JSONL 尾行 | 查看器拒绝打开；应用修复和 SDK 尾行恢复都不能更改文件 | passed |
| 工具装配失败时读取历史 | 真实已保存消息仍可读取，工具与待执行业务没有运行 | passed |
| 历史读取与严格发送重叠 | 发送等待查看器完成，历史没有被关闭；正常执行恢复后仅发生一次实际文件追加，内容为一行 `effect` | passed |
| 读取期间永久删除 Task | purge 等待读取结束，随后才删除对应原生目录 | passed |

这些是 P2-00 恢复边界回归，不替代 BW-A09～A20 的完整验收。没有把已有 Task 历史当成新的独立 Bot 对话。

| 命令 | 本轮结果 |
| --- | --- |
| `pnpm -s typecheck` | passed，新增脚本类型错误 0 |
| 规划规定的七项基线 | passed，分别保存日志 |
| `pnpm -s test:durable-bot` | passed，真实 Pi 1.5，包含 busy/idle、fork store、元数据恢复、模型目录与只读历史 |
| `pnpm -s test:durable-history-readonly` | passed，上表六类边界 |
| `pnpm -s test:all` | passed，Windows headless 319 项通过，失败 0，已知失败 0；2 项 Linux 平台限定用例未选中 |
| 测试分类与 IPC 清单检查 | passed，未新增 IPC 通道 |
| GUI、移动端、真实 Omarchy | not-run |
| M1～M3 及全部 BW-A09～A20 故障注入 | not-run，本轮未实现 |
| 构建、打包、安装、提交、推送 | not-run |

原始日志与追加式决定记录保存在本机 `out/diagnostics/bot-work-phase2/`：`final-typecheck.log`、`passive-history.log`、`verified-durable-bot.log`、`verified-test-all.log`、`decisions.tsv`。该目录为生成证据，不随源码提交；以上命令可重新执行。独立复核使用 gpt-6-astra，初次方案的发现、撤回与最终修正均保留在决定记录中。

## 后续范围

完成并确认 P2-00 后，按原规划进入 M1：独立 Bot 持久消息和真实发送、代码工具白名单、受守卫的 Work 控制与多 Work 消歧。M2 的独立后台 root、统一结果消费和完整恢复，及 M3 的持久列表水位、移除事件与联合验收继续保持原范围，不能由本轮前置检查替代。
