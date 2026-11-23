# OpenAI Dots / Codex 前台委派体验调研，与 MyBuddy Dots 对比

> **资料截止日期：2026-11-23。** 官方资料取自 developers.openai.com / learn.chatgpt.com / help.openai.com / openai.com，页面抓取时间均为 2026-11-23；有官方发布日期的条目单独标注。MyBuddy 现状取自同一工作树（commit `7c3dff8`，2026-11-23）。产品更新很快，本文不把"文档没写"当成"产品没有"。

## 0. 一页结论

1. **OpenAI 确实有 Dots，但它不是 Codex 的功能名。** Dots 是 2026-09-29 DevDay 发布的常驻云端代理，官方文档挂在 Codex 文档站下，但它与 Chat、ChatGPT Work、Codex 是并列的四种体验，并能向 Codex / Work 派任务。MyBuddy 的 Dots 与它同名同构（常驻 + 派任务 + 回传），命名应为借鉴。
2. **两者最大的结构性差距不在"派活"，而在"活在哪儿"和"改完怎么合"。** Codex 侧的执行面是云端独立工作区（关机也继续）+ 本机可连的 Codex 任务；交付后接 review pane / diff / 提交 / PR / `@codex review`。MyBuddy 只能在本机常驻执行，交付即结束，没有变更审阅与合入环节。
3. **MyBuddy 有明显更强的一项：回传的幂等与断点恢复。** 交付标识 + 事件表 + 重启按回执补齐，保证"一件事只交付一次"；失败后的自动补救还要求先在原生账本里排除副作用。这一点 Codex 公开资料没有等价承诺。
4. **权限模型是第二梯队差距。** Codex 是"沙箱 × 审批"两轴，外加 Dots 的动作级四档规则（直接做 / 说了才做 / 先问 / 交给你）；MyBuddy 目前是能力组开关 + 逐操作开关 + 空间白名单，粒度更粗。
5. **不建议照抄的部分：** Codex 的云端执行会把数据搬出本机；MyBuddy 的本地数据主权是有意取舍，不应作为"落后项"处理。

## 1. 对象确认：Dots 是什么，入口在哪

| 问题 | 核实结果 | 来源 |
| --- | --- | --- |
| Codex 是否真有 Dots | 有。2026-09-29 DevDay 发布，滚动开放 | [DevDay 2026](https://developers.openai.com/codex/whats-new/devday-2026)（2026-09-29） |
| 它是不是 Codex 的功能 | 不是功能名。文档把它与 Chat、ChatGPT Work、Codex 并列为四种体验，定位是"持续负责一件事"的常驻代理 | [Meet dots](https://developers.openai.com/codex/dots)、[Working with agents](https://developers.openai.com/codex/working-with-agents) |
| 它和 Codex 什么关系 | 可派活给 Codex：新建云线程、在你连接的电脑上建 Work/Codex 任务、继续已有本地 Codex 任务、使用你建好的 Codex 云环境 | [Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory) |
| 入口 | ChatGPT 移动 App、桌面 App、桌面浏览器；Slack DM/频道；语音通话；短信 beta（美国 Pro） | [Meet dots](https://developers.openai.com/codex/dots)、[Whats new 2026-10-28](https://developers.openai.com/codex/whats-new/dots-october-28-2026) |
| 谁能用 | Pro 100/200/500（18+，EEA/英国/瑞士以外）、Business Premium、Enterprise/Edu/Healthcare；2026-11-18 起企业工作区默认开启（可退出） | [Meet dots · Access](https://developers.openai.com/codex/dots) |

MyBuddy 侧的同名对象：`DOTS_TASK_ID = "mybuddy-dots"`，一个本地前台会话（`src/shared/dots.ts`）。设计文档在 W10 里引用了一张 OpenAI 的 Dots 宣传图（URL 含 `introducing-dots-carousel-feedback.png`），说明形态与命名是参照来的（**推断**，仓库未明文声明）。

## 2. Codex / Dots 侧：按维度记录

### 2.1 交办后任务在哪运行

| 形态 | 运行位置 | 关键事实 | 来源 |
| --- | --- | --- | --- |
| Dots 本体 | 云 | "Your dot lives in the cloud and has its own computer and browser"，设备关机也能继续 | [Meet dots](https://developers.openai.com/codex/dots) |
| Dots 派给 Codex | 云或你连的电脑 | 新云线程出现在桌面/网页/移动端；本地 Codex 任务出现在那台电脑；本地任务要求电脑在线且 ChatGPT App 打开 | [Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory) |
| Codex Cloud | OpenAI 托管机器 | 每个任务独立 workspace，"can keep working while your computer is asleep" | [Codex Cloud](https://developers.openai.com/codex/cloud) |
| 本地 Codex | 你的电脑 | CLI/IDE/桌面 App 本地执行，沙箱 + 审批 | [Permissions](https://developers.openai.com/codex/permission-modes) |

补充事实：云任务的 VM 状态默认在最后一次开始/恢复后保留 7 天；新任务开新 workspace，不继承另一个任务未提交的改动（[Using Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud)）。

### 2.2 并发与排队

**已核实的官方事实：**

- Dots "can divide work among background agents that run in parallel and report back to it"；你也可以继续和它说话（[Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory)）。
- 本地长任务建议："Run chats concurrently, but avoid letting two chats change the same files. Use worktrees to give parallel coding chats separate checkouts."（[Long-running work](https://developers.openai.com/codex/long-running-work)）
- Codex App 用独立线程组织 agent，内置 worktree 支持，多个 agent 可在同一仓库并行而不冲突（[Introducing the Codex app](https://openai.com/index/introducing-the-codex-app)，页面含 2026-03-04 Windows 更新说明）。
- CLI 有显式队列：`codex queue --thread <id> --message "..."`，加 `--resume` 可在会话未加载时排队并恢复（[Developer commands](https://developers.openai.com/codex/developer-commands.md)）。
- 用量侧：本地消息与云端对话共享同一份额度，云端单任务通常更费；Plus/Standard Business 给出每 5 小时本地消息区间，Pro 无 5 小时上限（[Pricing](https://developers.openai.com/codex/pricing)）。

**没查到的：** 官方文档没有给出"同时最多 N 个云任务"的固定并发数，也没有说明超出后的排队策略。**推断：** 实际并发由套餐额度与后端容量约束，而不是一个公开的 N。此处不编数字。

### 2.3 进度如何呈现

| 界面 | 呈现什么 | 来源 |
| --- | --- | --- |
| Dots 的 Activity | 打开某个任务可看 progress、files、results、requests for input；等待决定/连接/登录/审批时可直接在该请求上回复 | [Control your dot](https://developers.openai.com/codex/dots/controls) |
| 桌面 App 通知中心 | Activity 视图汇总未读、运行中、等待你回复的会话；可按 Work/Chat/Pinned/Scheduled 过滤 | [Notifications](https://developers.openai.com/codex/notifications.md) |
| 悬浮宠物 | 显示 Running / Needs input / Ready / Blocked | 同上 |
| Goal 模式 | 输入框上方有进度行，可暂停、恢复、编辑、清除目标；运行中仍可追加消息 | [Long-running work](https://developers.openai.com/codex/long-running-work) |
| 云任务详情 | 看改动文件、结果、测试；要改就在同一任务继续 | [Codex Cloud](https://developers.openai.com/codex/cloud) |

特点：**进度是"任务中心"式的**——一个地方汇总所有在跑的事，按"是否需要你"排序；不是把进展逐条刷进某个对话。

### 2.4 失败与重试

**已核实：**

- 云任务失败后可回到原任务继续；"Starting a new task creates a separate workspace and does not recover another task's uncommitted changes"，所以要先把重要工作提交（[Using Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud)）。
- 队列消息可在会话未加载时用 `--resume` 排队并恢复（[Developer commands](https://developers.openai.com/codex/developer-commands.md)）。
- 官方明确提醒："A completed run doesn't by itself confirm that the requested result was achieved or delivered."（[Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory)）
- 停止/暂停分三层：Pause 只停 dot 当前主任务；派出去的任务要到 Activity 里单独停；定时任务要到 Scheduled 里停（[Control your dot](https://developers.openai.com/codex/dots/controls)）。

**未核实：** 官方文档没有描述"失败自动重试几次 / 什么条件下重试"。社区有长任务进程状态丢失、续跑报错的反馈（如 [Codex Cloud 可靠性讨论](https://community.openai.com/t/codex-cloud-web-has-compounding-reliability-observability-and-workflow-problems-that-make-long-running-tasks-difficult-to-trust/1397259)），属于用户报告，不作为官方事实使用。

### 2.5 结果如何回到对话

- Dots 把结果带回它的会话并"turns to you for decisions that need your judgment"；可指定不同类别的更新发到不同渠道（例：例行进 ChatGPT，需要决策的进 Slack）（[Meet dots](https://developers.openai.com/codex/dots)）。
- 云端编码任务产生的是**独立会话**："Cloud threads appear as separate conversations in the desktop, web, and mobile apps, where you can review results and give further instructions."（同上）
- 同一个 dot 在 ChatGPT / Slack / 通话之间不重置记忆，但各渠道的消息记录彼此独立（[Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory)）。
- 通知渠道随端而异：桌面可设"仅后台时提醒 / 总是提醒"，并单独开关权限与提问通知（[Notifications](https://developers.openai.com/codex/notifications.md)）。

### 2.6 审查与合入的衔接

这是 Codex 侧最完整的一段。

| 环节 | 能力 | 来源 |
| --- | --- | --- |
| 变更审阅 | review pane 按 Unstaged / Staged / Commit / Branch / Last turn 切换；支持行内评论；可按整份 diff、单文件、单个 hunk 执行 stage / unstage / revert | [Code review](https://developers.openai.com/codex/code-review) |
| 就地修正 | 行内评论作为评审指令，随后发一条消息说明意图（例："Address the inline comments and keep the scope minimal."） | 同上 |
| 提交与开 PR | 云任务审阅后可 commit 或 open a pull request | [Codex Cloud](https://developers.openai.com/codex/cloud) |
| 自动评审 | 仓库可开 Automatic review；PR 里 `@codex review` 会像同事一样发 review；GitHub 上只标 P0/P1 | [Review GitHub pull requests](https://learn.chatgpt.com/docs/third-party/github) |
| 边界 | 评审规则"don't replace tests, branch protections, or required approvals"；合入仍由人决定 | 同上 |
| 多仓 | 本地项目含多个仓库时，review pane 可统一切换查看各仓 diff | [Code review](https://developers.openai.com/codex/code-review) |

### 2.7 权限与沙箱边界

**两轴模型**（[Permissions](https://developers.openai.com/codex/permission-modes)）：

- **sandbox** 决定能碰哪些文件和网络；**approvals** 决定何时暂停。两者独立，"Changing who reviews a request doesn't expand the sandbox"。
- "Approve for me" 保持 workspace-write 沙箱不变，只把符合条件的审批请求转给自动审查（auto-review）。
- 需要完全放开时可 `--sandbox danger-full-access` 或 `--dangerously-bypass-approvals-and-sandbox`，官方明确提示谨慎（[Agent approvals & security](https://developers.openai.com/codex/agent-approvals-security)）。
- 非交互只读场景可用 `--sandbox read-only --ask-for-approval never`（同上）。

**Dots 层再叠一层动作规则**（[Control your dot](https://developers.openai.com/codex/dots/controls)）：

| 规则档位 | 含义 |
| --- | --- |
| Take action without asking | 直接做 |
| Take action when you say so | 你明确要求才做，否则动手前先问 |
| Ask before taking action | 动手前必须批准 |
| Hand off to you | 交给你自己做 |

其他已核实边界：动作影响账户或对外分享前会过一次自动 review，结果可能是"可执行 / 需批准 / 必须你本人做"；自定义规则不能覆盖内置安全要求，也不能授予 App/电脑访问权；Wallet 支付每次都要生物识别确认。云环境侧用网络白名单、网络密钥代理（占位符替换，仅 HTTPS 443）、Tailscale VPN 控制出网（[Cloud environments](https://developers.openai.com/codex/environments/cloud-environments)）。

### 2.8 明确的限制

| 限制 | 内容 | 来源 |
| --- | --- | --- |
| 地域/套餐 | Pro 版 Dots 不含 EEA、英国、瑞士；Business Premium 需工作区资格 | [Meet dots](https://developers.openai.com/codex/dots) |
| 端 | 移动网页不支持 | 同上 |
| 用量 | 本地与云端共享额度，有 5 小时/周限制；Dots 对话本身不计入，但它派出的 Work/Codex 任务计入 | [Pricing](https://developers.openai.com/codex/pricing)、[Meet dots](https://developers.openai.com/codex/dots) |
| 云任务状态 | VM 状态默认保留 7 天；新任务不继承旧任务未提交改动 | [Using Codex Cloud](https://help.openai.com/en/articles/20001545-using-codex-cloud) |
| 本地电脑 | 本地 Codex/Work 任务要求那台电脑在线且 App 打开 | [Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory) |
| 并行冲突 | 同一批文件不要用两个 chat 同时改，需用 worktree 隔离 | [Long-running work](https://developers.openai.com/codex/long-running-work) |
| 审查不等于通过 | 完成≠达成；评审规则不替代测试、分支保护和必需审批 | [Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory)、[GitHub review](https://learn.chatgpt.com/docs/third-party/github) |
| 渠道隔离 | 跨渠道共享上下文，但消息不互相同步；对外分享仍需授权 | [Tasks and memory](https://developers.openai.com/codex/dots/tasks-and-memory) |

## 3. MyBuddy Dots 现状（按同一组维度）

| 维度 | 现状 | 证据 |
| --- | --- | --- |
| 运行位置 | 只在本机。`docs/mybuddy-dots-single-host.md`：常驻依赖这台电脑，关机/休眠/会话终止期间不执行 | 文档 §"让一台电脑持续处理工作" |
| 交办形态 | `delegate` 在指定空间新建普通任务（`dots-job-<hash>`），或 `steer`/`resume` 接续原任务；每件事一个任务 | `src/main/dots/DotsActions.ts`（delegate 分支） |
| 并发与排队 | 任务内串行：新要求以 `streamingBehavior: "followUp"` 入队，受理回执带 `queued`；不同任务可并行；未设全局并发上限 | `DotsActions.ts`、`src/main/agent/PromptExecutionCoordinator.ts` |
| 状态机 | `pending / running / blocked / completed / failed / superseded` | `src/shared/dots.ts` |
| 进度呈现 | 对话内一行"任务名 + 状态"（已排队/执行中/需要你回复/已完成/失败/已改向）；另有里程碑式进展消息；心跳默认关闭，静默 120 秒才提示"已有一段时间未观察到新的工具活动" | `src/renderer/src/components/chat/DotsResult.tsx`、`src/shared/answer-routing.ts`（`heartbeatMs: null, silenceMs: 120_000`）、`DotsDelegations.ts` |
| 失败与重试 | 失败分类（模型/权限/4xx/瞬时）+ 一次自动补救；补救前用 `safeToRetry` 扫原生账本确认没有副作用；再失败或无法确认安全就带原因提问 | `src/main/dots/DotsFollowup.ts` |
| 结果回传 | 在原 Dots 对话追加独立助手消息，带文件版本与引用；`deliveryKey` + `dots_reply_events` 幂等；重启按回执补齐；切走任务不改变目的地 | `src/main/dots/DotsReplyOutbox.ts`、`docs/mybuddy-dots-plan.md` W08 |
| 续办 | 有剩余步骤或 `remainingQuote` 时自动在同一任务继续，最多 8 步；无实质进展即停 | `DotsFollowup.ts`、`DotsWorkerOutcome.ts` |
| 审查与合入 | 没有 diff 审阅、没有提交/PR/评审回合。设计上明确删去"独立评审回合、评分、采纳或退回、逐文件我已核验" | `docs/mybuddy-dots-plan.md` W05/W06 表 |
| 权限 | 能力组开关（委派/空间/读文件/定时/调度/记忆）+ 逐操作开关 + 允许空间白名单 + 记忆模式 + 跟进模式（自动接续/仅通知/暂停） | `src/shared/dots-settings.ts` |
| 执行沙箱 | 默认 `guarded`（任务工作目录防护）；`os-sandbox` 实验性、默认关闭；`cwd-only` 仅兼容用 | `src/shared/agent-ipc.ts`、`SettingsModal.tsx` |
| 触发 | cron 定时（错过可 coalesce/skip，带截止时间）+ 单文件变化订阅 | `docs/mybuddy-dots-single-host.md`、`DotsActions.ts` |
| 明确限制 | 前台读取上限 24,000 字符 / 4 个来源 / 6 次调用；回答规则最多 50 版；记忆按条数与字节设预算；只能交付到桌面 Dots 对话（渠道投递已移出） | `src/shared/answer-routing.ts`、`src/shared/dots-limits.ts`、`docs/mybuddy-dots-plan.md` |

## 4. 逐维度对比

| 维度 | MyBuddy Dots | OpenAI Dots / Codex | 判定 |
| --- | --- | --- | --- |
| 交付后的审查与合入 | 交付文件/文字即结束，无 diff、无提交、无 PR | review pane（多种 diff 视图、行内评论、stage/revert/commit/push）+ commit/open PR + `@codex review` | **落后** |
| 运行位置与离线 | 本机常驻，关机即停 | 云电脑 7×24；本机任务要求电脑在线 | **落后** |
| 权限粒度 | 组开关 + 操作开关 + 空间白名单 | 沙箱 × 审批两轴 + 动作级四档 + 组织策略 + 云网络白名单 | **落后** |
| 多任务"需要我"视图 | 对话内逐条状态，无聚合 | Activity 汇总运行中/等待你/需审阅，宠物与通知 | **落后** |
| 并行隔离 | 每事一个任务，同空间共用一个目录 | 云任务独立 workspace；本地用 worktree 隔离 | **落后** |
| 失败与重试 | 分类 + 扫账本后自动补救一次，否则提问 | 可回原任务继续；未见自动重试承诺 | **持平** |
| 结果回传 | 独立消息 + 版本化文件 + 幂等 + 重启补齐 | 结果回独立线程/Activity，多渠道通知 | **领先** |
| 触达渠道 | 仅桌面 Dots 对话 | ChatGPT 桌面/移动/网页、Slack、电话、短信 beta | **落后** |
| 事件触发 | 定时 + 文件变化 | Scheduled + Gmail/Slack/GitHub 事件触发 + dot 自主决定何时醒来 | **落后**（幅度较小） |
| 数据位置 | 全部在本机，可冷备份/校验/恢复 | 云端执行，数据出本机 | **领先**（本地主权，属取舍） |

## 5. 差距（按影响排序）

### 5.1 交付物没有"审查 → 合入"的闭环（影响：高）

- **现在：** Dots 返回文件或文字就结束。设计上还刻意删掉了评审回合、评分与采纳/退回，理由是旧 Bot 让用户反复确认。代码类或改稿类交付因此停在"你自己去看"。
- **Codex 怎么做：** 改动落在 review pane 里可逐行评论、按 hunk 暂存或回退，再 commit / open PR；PR 上 `@codex review` 像同事一样评审，只报 P0/P1，且明确不替代测试与分支保护。
- **改了能解决什么：** 让"改一版"从一次对话变成可合入的产物；用户不必离开 Dots 去手工比对；评审意见能直接变成下一轮指令。注意：这与"不要强制人工确认"的产品决定冲突，应做成**可选查看**而不是强制关卡。

### 5.2 交办后离不开这台电脑（影响：高）

- **现在：** 单机常驻，关机、休眠、会话终止就不执行；跨机还要先停宿主再恢复数据。
- **Codex 怎么做：** Dots 有云电脑与浏览器，设备关着也继续；Codex Cloud 每任务独立 workspace，VM 状态保留 7 天，桌面/网页/移动都能接手。
- **改了能解决什么：** "交办完就走"成立；出差、下班、换设备都能收结果。代价是数据出本机，需要单独的安全与合规方案，不能默认开启。

### 5.3 权限只能整组开关，不能按动作分级（影响：中高）

- **现在：** 六组能力 + 逐操作开关 + 空间白名单。要么允许委派，要么不允许；无法表达"发消息要问、读文件可以直接做"。
- **Codex 怎么做：** 沙箱与审批分离；"Approve for me" 只改审批路径不改沙箱；Dots 再加四档动作规则（直接做/说了才做/先问/交给你），且不能覆盖内置安全。
- **改了能解决什么：** 用户敢把更多事交出去，同时把高风险动作（对外发送、删除、付款）单独拦住；也便于向企业解释边界。

### 5.4 多任务时看不到"哪里需要我"（影响：中）

- **现在：** 每条委派在对话里一行状态；进展以消息形式追加。任务一多，对话被进展刷屏，且没有跨空间汇总。
- **Codex 怎么做：** Activity 一个视图汇总运行中/等待回复/需审阅，宠物与系统通知提示 Running / Needs input / Ready / Blocked；Goal 有独立进度行可暂停恢复。
- **改了能解决什么：** 把"刷屏"换成"待办视图"；用户不用翻聊天记录找哪件事卡住了。这与"产物不要堆在对话框上方"的既有偏好一致——聚合视图应独立于消息流。

### 5.5 并行任务没有隔离（影响：中）

- **现在：** 同一空间内多个任务共用一个目录；并行改同一批文件会互相覆盖。
- **Codex 怎么做：** 云任务各自独立 workspace；本地并行 chat 用 worktree 分开 checkout，官方明确提示不要两个 chat 改同一批文件。
- **改了能解决什么：** 多事项并行时结果可预期；冲突在合并时才出现，而不是在执行中被悄悄覆盖。

### 5.6 触达与触发面窄（影响：中低）

- **现在：** 只能在桌面 Dots 对话收结果；触发只有定时与单文件变化。
- **Codex 怎么做：** 同一 dot 可从 ChatGPT 各端、Slack、电话、短信进入；Scheduled 支持 Gmail/Slack/GitHub 事件触发；dot 可自行决定何时醒来继续。
- **改了能解决什么：** 用户不在电脑前也能收到并决策；"等一件事发生"不必轮询。渠道投递此前被产品决定移出，属于范围问题而非纯技术差距。

## 6. 领先项（不要改坏）

1. **回传幂等与断点恢复。** `deliveryKey` + `dots_reply_events` + 重启后按原生回执核对，保证同一件事只交付一次；回传前/写入后两个中断点都有验收记录（`docs/mybuddy-dots-plan.md` W08 与断点测试）。Codex 公开资料没有等价承诺。
2. **失败补救前的副作用判定。** `safeToRetry` 扫原生账本，确认没有产生外部动作才自动补一次，否则停下来问。比"直接重跑"稳。
3. **本地数据主权。** 全部数据在本机，有冷备份、逐文件校验与恢复流程；云端方案做不到这一点。

## 7. 未核实与边界

| 项 | 状态 |
| --- | --- |
| 云任务并发上限与排队策略 | 官方文档未给数字；不编造 |
| Codex/Codex Dots 的失败自动重试策略 | 官方未描述；社区反馈仅作背景 |
| Dots 内部如何切分 background agents | 文档只说"可并行、会回报"，未给调度细节 |
| MyBuddy Dots 的全局并发行为 | 代码里未见全局上限；实际受模型配额与宿主资源约束，属实现推断 |
| OpenAI Dots 与 MyBuddy Dots 的命名关系 | 仓库文档引用 OpenAI 素材，推断为借鉴；无官方声明 |
| Codex 侧"审查后合入"在非代码交付（文档/表格）上的等价物 | 未查到；review pane 以 Git 为中心 |

## 8. 来源清单

| 来源 | 日期 | 用途 |
| --- | --- | --- |
| https://developers.openai.com/codex/dots | 抓取 2026-11-23 | Dots 定位、入口、云电脑、并行、审批、access |
| https://developers.openai.com/codex/dots/tasks-and-memory | 抓取 2026-11-23 | 派工去向、Activity、结果与错误复核、定时/事件 |
| https://developers.openai.com/codex/dots/controls | 抓取 2026-11-23 | 审批四档、Pause/Stop/Scheduled 区别 |
| https://developers.openai.com/codex/whats-new/devday-2026 | 2026-09-29 | Dots 发布 |
| https://developers.openai.com/codex/whats-new | 抓取 2026-11-23（含 2026-11-02~06 更新） | 最新版本动态 |
| https://developers.openai.com/codex/cloud | 抓取 2026-11-23 | 云任务、独立 workspace、审阅与 PR |
| https://help.openai.com/en/articles/20001545-using-codex-cloud | 抓取 2026-11-23 | 7 天 VM、续跑、新任务不继承改动 |
| https://developers.openai.com/codex/environments/cloud-environments | 抓取 2026-11-23 | 网络白名单、密钥代理、VPN |
| https://developers.openai.com/codex/environments/cloud-environments（同页） | 抓取 2026-11-23 | 环境复用与共享边界 |
| https://developers.openai.com/codex/reference/troubleshooting | 抓取 2026-11-23 | review pane 视图、卡住排查 |
| https://developers.openai.com/codex/code-review | 抓取 2026-11-23 | 行内评论、stage/revert、多仓 |
| https://learn.chatgpt.com/docs/third-party/github | 抓取 2026-11-23 | `@codex review`、P0/P1、不替代分支保护 |
| https://developers.openai.com/codex/permission-modes | 抓取 2026-11-23 | 沙箱 × 审批两轴、Approve for me |
| https://developers.openai.com/codex/agent-approvals-security | 抓取 2026-11-23 | danger-full-access、只读 CI 模式 |
| https://developers.openai.com/codex/long-running-work | 抓取 2026-11-23 | 并发建议、worktree、Goal 进度行 |
| https://developers.openai.com/codex/notifications.md | 抓取 2026-11-23 | Activity 过滤、宠物状态、通知设置 |
| https://developers.openai.com/codex/pricing | 抓取 2026-11-23 | 额度共享、5 小时/周限制 |
| https://developers.openai.com/codex/developer-commands.md | 抓取 2026-11-23 | `codex queue` 与 `--resume` |
| https://openai.com/index/introducing-the-codex-app | 页面含 2026-03-04 更新 | 多 agent 并行、worktree、review/comment |
| 仓库 `docs/mybuddy-dots-plan.md` | 2026-11-23 工作树 | Dots 设计约定、W02/W05/W07/W08/W10 |
| 仓库 `docs/mybuddy-dots-single-host.md` | 同上 | 常驻、恢复、备份、离线边界 |
| 仓库 `src/main/dots/*.ts`、`src/shared/dots*.ts`、`src/shared/answer-routing.ts`、`DotsResult.tsx`、`SettingsModal.tsx` | 同上 | 状态机、队列、重试、回传、权限与沙箱现状 |
