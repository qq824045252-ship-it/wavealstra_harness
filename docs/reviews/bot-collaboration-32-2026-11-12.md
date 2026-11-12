# Issue 32：个人 Bot 沟通与任务委派

本记录对应 [issue #32](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/32)。首轮实现与验收基于 `main` 的 `d83532da7149e9d67fa7c1e68502864020fa488e`。后续接收方修复与主线集成见末节。本文不代表 #27 的全部验收完成。

实现、专项回归、六类真实模型任务及补充端到端验收已完成。主轮在后续界面导航步骤失败，修复后单独补验通过，原失败报告保留。完整无头门禁仍有失败，见下文对照记录。

## 持久事实与执行归属

| 职责 | 实现 |
| --- | --- |
| 协作身份、双方消息、真实回执、分页与来源删除后的记录 | `BotCollaborationRepository`，独立的 `bot_collaborations`、requests、messages、events、previews 表 |
| 个人沟通和委派入口 | `BotCollaborationService` 的 `bot_collaborate`，动作包括 ask、delegate、query、follow_up、amend、pause、resume、cancel |
| 原有咨询入口 | `bot_ask` 转入同一个协作服务；接收方继续使用现有只读 `BotPeerCallService` |
| 后台执行、调度、恢复、版本与成果 | 现有 Work、WorkDispatchQueue、WorkExecutionAdapter、Durable、WorkCompletionCoordinator |
| 来源会话与结果回流 | `BotConversationRepository.appendWorkDelivery` 与 `WorkConversationFeedback` |
| 主对话入口和双方记录 | `BotCallThread`、`BotCollaborationView`、`BotWorkspacePage` |

一条协作可以先咨询，再委派一个 Work。独立目标使用独立协作，同一对 Bot 可以有多条协作。Work 的唯一 owner 是目标 Bot，目标的模型、工作区和配置在受理时冻结。发起 Bot 不成为 participant，其个人 Work 列表和计数不增加。真正的团队事项沿用原有路径，历史临时团队不迁移。

新协作由宿主验证的来源请求和操作身份确定。后续控制同时验证用户、来源 Bot、来源会话、协作、目标 owner 和本回合实际读取的完整版本守卫。模型不能提供 actor 或通过任意 workId 获得权限。原始用户要求、附件及双方往来参考与受理一同保存；Bot 的回复和计划不会变成用户授权。

消息正文是持久逻辑消息。流式预览与状态事件独立存储，不计入消息数。双方历史按不可变序号分页，游标绑定用户、Bot、协作和筛选。

## 状态与时间

发送、送达、接单、实际执行开始、执行结束、回传与返回分别记录宿主事实。接收方可以在 `submit()` 返回前开始生成，因此首次 provider 执行观察会先记录已经被事实证明的送达和受理，再记录开始；迟到的提交回执不覆盖原时间。

通信“已返回”与 Work 是否完成分别展示。阶段成果返回后，Work 可以继续运行。当前执行的开始与结束时间只读取当前要求版本、输入快照和 owner 代次的绑定。新要求还没有绑定时，不能借用上一轮时间。总耗时使用真实关闭与最后实际返回时间；未采集的端点显示“未记录”，不从 `updatedAt` 猜测。

来源归档后仍回到原会话。来源删除后不回退到目标 Bot、默认 Bot 或当前会话；成果保留在双方协作记录，来源返回时间保持未记录，并展示待核对。记录到协作与投递到来源是两个独立事实。

## 已验证的专项行为

| 验证 | 已发生的结果 |
| --- | --- |
| `test:bot-collaboration-repository` | 真实 SQLite 的身份、双向隔离、分页、消息计数、回执幂等、Work 归属和删除来源后的持久记录通过 |
| `test:bot-collaboration` | 原文附件、先问后做、两个目标、唯一受理、完整版本守卫、控制重放、事务回滚、数据库重新打开、归档与删除来源后的精确结果路由通过 |
| 回传故障注入 | 真实 SQLite trigger 使反馈 INSERT 失败。源消息事务回滚，失败事件保留，没有虚假返回时间。解除故障后仅投递一次，不重跑执行 |
| 重复中断 | 不同未完成往来产生独立待核对回执；重复恢复同一中断不新增回执 |
| 文件事件委派 | 使用真实 `fs.watch`。受理保存内容基线，暂停后修订基线和游标，继续不把旧变化当新事件，实际后续写入进入原 Work |
| 来源摘要刷新 | 真实 Work 关闭后，来源消息版本推进，实际消息 reducer 接受关闭状态；已完成且不在最新消息页的来源摘要也有刷新路径 |
| `test:work-execution-tools` | 先复现后台 Work 暴露交互式目标生命周期工具，再验证晚安装执行绑定后隐藏这些工具。普通 Task 的目标工具保持可用 |
| `test:bot-peer-calls` | 真实接收方身份、隐私范围、并发隔离、回执、取消、恢复，以及 provider 早于 submit 返回的顺序竞态通过 |
| `test:bot-collaboration-ui` | 真实隔离 Electron 的键盘打开和返回、来源 DOM、草稿、附件、滚动和焦点保留；112 条消息分页、预览不计数、迟到跨目标响应隔离、同请求重试、390px 布局、暂停帧时打开已关闭事项和当前执行时间卡通过 |
| 类型与结构 | `pnpm -s typecheck`、IPC inventory、测试分类审计通过。共享反馈 schema 已独立到 `bot-work-feedback.ts`，运行期导入环专项通过 |

相关既有控制、设置、删除、成果、原文保真、改向、执行度量、历史分页和 Durable 工具策略均已跑专项。完整命令与逐项退出码记录在本机 `out/diagnostics/issue32/focused-results.json`。脚本后续新增的恢复、文件事件和来源刷新断言另有专项日志。

## 完整无头门禁与原版本对照

首轮 `pnpm -s test:all` 实际运行 485 项，469 通过、16 失败，退出码 1。它不是通过的门禁。

在独立目录用未修改的 HEAD 源码、同一 Node 与依赖复跑全部 16 个失败项。原版本 architecture-graph 通过，其他 15 项复现失败。因此导入环属于本次引入的问题，现已修复。对照归档 SHA256 为 `f77b5f2fc480281c37b98b30d5f1ebcc95365dfe9128d3885dd17d8d2d732205`。逐项记录位于 `out/diagnostics/issue32/head-baseline-results.json`。

附件、自动恢复与图片的 Windows 路径断言已修正为实际解析和文件回读，保留原覆盖并增加准确映射检查。没有修改 `scripts/test-baseline.json` 放行失败。

当前版本第二轮全量复验实际为 **472 通过、13 失败，退出码 1**，见[完整日志](evidence/issue32/test-all-current.log)。其中 12 项与上述原版本失败一致。额外的 `google-workspace-faults` 在子进程成功启动断言出现一次 `1 !== 0`；其测试设置 80ms 子进程超时。当前版本独立重跑和未修改 HEAD 独立重跑均通过。该次失败仍保留在原始全量日志，未归类为已经证明的本次产品回归，也没有被改写成全量通过。

原有失败包括 Windows 提醒快照标志支持、符号链接权限、平台专用夹具和现有 watch 监督断言。部分原版本用例在操作系统准备或清理阶段失败，因此后续断言是否执行也不能声称已验证。[原版本逐项对照](evidence/issue32/head-baseline-summary.md)、[原始退出码与日志哈希](evidence/issue32/head-baseline-results.json)和[归档完整性](evidence/issue32/head-baseline-integrity.json)均保留。

## 真实 Electron 与模型执行记录

所有模型任务都使用独立 HOME、Chromium profile 和单独的 `pnpm dev --outDir`。原用户 Electron 主进程保持运行，未停止用户任务。无产品 build、打包或安装操作。

真实模型为本机公开目录可用的 `auto/deepseek-v4.1-flash` 与 `qwen-token-plan/qwen3.8-flash`。接收方使用独立工作区和配置标识，实际产物按字节回读。CDP 驱动证明真实 Electron 的页面与 preload 链路，不冒充原生 OS 键鼠验收或发行包验收。

已保留的诊断轮次如下。

| 轮次 | 实际结论 |
| --- | --- |
| 初始两轮 | 新工具的顶层 union schema 导致真实 provider HTTP 400，工具尚未执行。相同载荷仅去掉该工具或改为对象 schema 后 HTTP 200。已修复 wire schema，并新增内部严格动作解析回归 |
| `02-52-04-603Z` | 算术咨询通过。CSV 实际生成、回读、登记正确的目标文件，但普通 Task 的目标确认工具使后台 Work 等待隐藏交互；后续模型任务未执行。动态工具归属修复后重测 |
| `03-00-46-036Z` | 五类核心任务通过，CSV Work 正常关闭。额外跟进步骤的关闭选择器存在驱动语法错误；HTML 目标仍在实际执行时超过驱动等待时间，改向和归档已发生，但最终返回未验证。没有把超时后的断言计为通过 |
| `03-18-48` 与 `03-21-22-452Z` 附近轮次 | 来源指纹或后续全量门禁要求发生变化，诊断中止；保留已发生的咨询、CSV 和跟进结果，不作为最终冻结版本完整通过 |

最终主轮 `2026-11-12T03-34-43-613Z` 的六类任务与一次同关系追问均通过。开始与结束源码指纹相同，`sourceDeltaFiles=[]`。该轮在后续文件打开步骤超时，原始 `report.json` 保留 `status=failed`。

| 类型 | 真实结果 | 实际 provider 请求数 |
| --- | --- | --- |
| 算术咨询 | 目标真实回复，不建 Work | 5 |
| 附件 CSV 分析、先问后做 | 同关系受理一个目标 Work；实际 `stock-result.json` 的两行结果为 51、115，总计 166 | 12 |
| 同关系追问 | 保留同一协作、Work 与已发生的交流上下文 | 4 |
| 第二目标翻译 | 独立协作、不建 Work、不串入第一目标 | 5 |
| 文件代码审查 | 读取实际 `average.js`，输出 `average-review.md`，原文件未改 | 20 |
| 第二目标结构化提取 | 实际 `incident-result.json` 包含随机工单标识、P2 与 17 位受影响用户 | 16 |
| 离线课堂 HTML | 读取素材，执行期间接受修订要求，原 Work 修订到第 2 版；实际 HTML 含修订标识，最终交付回归档来源 | 46 |

主轮结束的个人事项计数为来源 0、目标 A 3、目标 B 1，未创建团队。来源与目标的真实协作记录、消息计数和重新加载均已核对。

主轮源码 digest 为 `92f811bea552be3207bfcdf79c2adcee093c469fbff08f9eabbd438a857c1a06`。实际 dev 主进程 bundle SHA256 为 `b5e0fd0a8a2dbe294b53319c57b8ce1b404bd2a8b1812e3da5d932f96c73f61f`，preload 为 `32f7ded3d3122302c7b4e1dcddf11df7ee1478eb2cccdb4624f7dccbd3d971d2`。主轮期间没有源码变化，运行目录保留完整清单、原始请求和截图。

主轮有以下验证界限：

- HTML 的真实 provider 已在修订前启动，但修订前没有登记完成的大纲，不能据此声称已验证真模型的已完成步骤复用。该行为由 `test:work-revision-handoff` 专项覆盖。
- 主轮 `partialFacts=0`。文件已生成或登记，不等于已经向来源发送阶段成果。阶段回传另行补验。
- 归档后 UI 显示空新对话，该时刻的新会话 ID 仍为空。原归档会话有持久最终回传，但主轮没有建立第二个持久会话的误投对照。
- 超时发生在协作详情点击“查看事项”之后，官方文件打开回执尚未发生。不能将磁盘文件回读写成打开验收通过。

主轮的合成输入、实际往来、回执、状态、产物哈希、源码及原始报告哈希见[模型主轮摘要](evidence/issue32/live-core.json)。运行期间的并发无头负载另有记录；实际时间不外推为性能 SLA。

## 最终界面修复与补充端到端验收

“查看事项”原实现先关闭协作，再通过 `requestAnimationFrame` 打开事项。真实 Electron 的确定性回归暂停帧回调后，观察到协作已关闭、详情不存在、`getWorkCalls=[]`。现在同一次点击就切换到事项，并保留返回位置，迟到的帧回调不会抢回焦点。该回归先失败后通过。自然遮挡场景的操作系统原因没有被证明，不能将主轮超时直接归因于窗口遮挡。

时间卡也已修正。改向后，本次开始与结束均读取当前 Work 执行绑定，和本次执行耗时一致。当前端点缺失时显示“未记录”，即使早期关系回执有时间也不借用。首次接单到首次执行的耗时单独标为“首次排队”。[最终 Electron 结果](evidence/issue32/navigation-ui-final-result.json)、[类型检查](evidence/issue32/navigation-typecheck.log)与[暂停帧失败证据](evidence/issue32/navigation-held-frame-before.json)均保留。

补充运行复用相同隔离数据，重新启动独立 `pnpm dev`，其 `report.json` 为 `passed`，转发记录共 36 次真实 provider 请求。补充运行使用与主轮相同的主进程和 preload bundle 哈希。它包含最新 renderer 的实际验证，源码变化记录单独保留，没有将两轮写成同一份冻结快照。最终源码 digest 为 `8a606d95a8b3ec208b72f6b7fbc6bbfe9d13cd760b8c434c3e351ca86f0bb9ea`，结束后文件哈希复核无变化。相对主轮仅两份 renderer 文件与两份 UI 测试文件发生变化，见[源码与原生并行调用核对](evidence/issue32/source-and-native-proof.json)。

| 补充行为 | 实际结果 |
| --- | --- |
| 新来源持久化 | 新会话 `bot-conversation-a2bdbdc5-cfa2-42e4-b3b8-0c70634669f2` 已通过真实发送持久化 |
| 原生 A/B 并行任务 | 新建一个目标 A 个人 Work；A 写入并登记文件，B 真实轮询由夹具控制的 gate，未自行创建 gate |
| 阶段回传 | 时间 `1794456505477`，原来源已存 `report.milestone=true` 的消息，双方记录也存 `kind=progress`。此时 Work 为 `active`，原生 B 子任务为 `running`，B 文件仍为 WAITING，gate 不存在 |
| 前台响应 | B 等待时，来源前台真实回答 `31+6=37`，未创建或修改事项 |
| 两个持久会话的路由 | 阶段回传后归档来源，另建持久会话 `bot-conversation-ea241b21-ae62-4959-b944-9c31f434f91f`。gate 在上述断言后才释放，最终回传仍进入原归档来源，新会话没有收到误投 |
| 最终执行 | B 实际写入 FINAL，原 Work 以 `succeeded` 关闭。补充只增加一个 Work，全部模型任务合计五个 Work，来源个人事项仍为零 |
| 事项导航 | 最新 renderer 从目标协作详情进入准确的原 HTML Work 详情，实际 `selectedWorkId` 一致，已观察新时间卡标签 |
| 文件打开 | 对官方“打开保存版本”按钮做命中校验并实际点击，原始 `workspace:openFolder` handler 调用完成。保存版本 SHA256 为 `504acb65d9ea08337f59d0abfd44c39afc2901947c473cc34e67bf01ab4cbc1b`，其离线 DOM、标题与修订标识通过校验；系统进程 `ego.exe` 的实际命令行携带相同保存路径 |

保存版本是产物库中不可变的版本，其哈希与工作区最后一份 `lesson.html` 的哈希分别记录。没有将两份字节不同的文件当作同一版本。原始报告的窗口标题查询未找到浏览器，后续只读进程核对补充了实际 OS 打开身份，见[系统打开回执](evidence/issue32/opener-os-correlation.json)。没有操作用户浏览器或执行原生系统浏览器的视觉验收。

补充证据见[端到端摘要](evidence/issue32/live-supplement.json)、[阶段成果仍在执行](evidence/issue32/real-partial-active.png)、[实际事项与文件入口](evidence/issue32/official-open-completed.png)及[最新时间卡](evidence/issue32/latest-renderer-timecard.png)。原用户 Electron 主进程 `35720` 始终未被停止。

未运行发行包验收、Linux 桌面验收或完整 GUI 套件。额外启动的既有 `test:bot-work-conversation-desktop` 没有完成阶段输出，已停止其自建测试进程，未将该用例记为通过。最新消息渲染专项通过。未验证项和该用例退出情况见[界面验证记录](evidence/issue32/navigation-fix.md)。

## 复验命令

```powershell
pnpm -s typecheck
pnpm -s test:bot-collaboration-repository
pnpm -s test:bot-collaboration
pnpm -s test:work-execution-tools
pnpm -s test:bot-peer-calls
pnpm -s test:bot-collaboration-ui
pnpm -s test:bot-collaboration:live
node scripts/ipc-channel-inventory.mjs
node scripts/test-all.mjs --audit
pnpm -s test:all
```

真实模型入口会在发送任务前解析测试驱动表达式并校验 bootstrap 语法。源代码指纹变化、模型失败、运行失败和未执行断言都必须保留实际状态。
