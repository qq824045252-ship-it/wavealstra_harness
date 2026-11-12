# Bot 交互调度验收报告（issue #27）

> 历史记录：最新缺项与修复见 [二次核对报告](bot-scheduling-27-followup-2026-11-12.md)。本报告的部分“通过”仅为夹具/服务级；旧实现的 LiveDoc 成果路径、有界扫描、B-6 范围与续办上限已在复核中发现不足，不代表 Issue 全部验收。

| 项目 | 值 |
| --- | --- |
| 关联 issue | [#27 个人助理统一响应调度](https://github.com/qq824045252-ship-it/wavealstra_harness/issues/27)（P0） |
| 规格 | [Bot 交互调度规格](../bot-interaction-scheduling.md)（BOT-SCHED-1.0） |
| PDF 审查基线 | `77d0d59a39a1e225288b46c722c18ba34636a19a` |
| 施工起点 | `76b7ddd5`（rebase 到当时的 `origin/main`；分支内另有 `11576a70` 作为 rebase 前基线） |
| 日期 | 2026-11-11，Asia/Shanghai |
| 结论口径 | 通过 / 未通过 / **未测**；未测不等于通过 |

本报告只记录本次实际执行过的检查。没有运行真实 Electron、真实模型或真实外部渠道；S1～S3 完整故事没有作为端到端脚本跑通，只覆盖了其中的宿主事实与投影链（逐项见 §4）。

## 1. 本次交付

### 1.1 §4 P0：运行中里程碑 → 前台回流

| 改动 | 落点 |
| --- | --- |
| 运行中（queued/placed）根输入现在返回**有界**已核实子项：只取终态 outcome（completed/failed/rejected/blocked/stopped），稳定 itemId 去重，最多 40 项，先按 plan/results 预筛选 detail 再解析 | `src/main/agent/durable/DurableWorkExecutionProjection.ts` |
| 新增只读里程碑投影：`ready[]`（稳定 milestoneId、来源 binding、task/summary、artifactRefs、仅宿主登记的不可变版本才带 `openPath`/`immutable`、deliverableId）、`covered[]`、`openGaps[]`、`nextStep`、`digest`、`requiresUserInput` | `src/main/agent/work/WorkMilestones.ts` |
| 投影接入 `WorkProjectionDto.phase3.milestones`，由 `works.getProjection()` 提供，即 `work_query_status` detail 与主动回报读同一份事实 | `WorkProjectionBuilder.ts`、`WorkService.ts`、`src/shared/bot-work-phase3.ts`、`src/shared/bot-work.ts` |
| 运行中部分成果合并成一条 `milestone:<bindingId>` 进展消息（按 digest 去重，重放/重启不重发），正文明确“部分成果不代表整体目标已完成”；最终结果仍由原结果通道交付 | `src/main/agent/work/WorkConversationFeedback.ts` |

未新增表、第二套真源或第二套执行内核；里程碑全部来自既有 `work_subitem_results`、deliverables、gaps、已登记产物。

### 1.2 §5.1 可靠性（PDF B-2）

| 缺陷 | 处理 |
| --- | --- |
| R1 固定 2 次续做、任意 unknown 截断、宿主改决定后正文仍承诺继续 | 续做改为按**真实耐久进展**判断（产物快照 ID + 当前版本已完成子项指纹，抽出 `WorkContinuationProgress.ts` 与恢复通道共用同一 basis），保留硬上限 4；unknown 只约束产生它的执行及其续做血统；宿主把 continue 改判 deliver 时按句剥离“接下来/继续补齐”等未来承诺（剥离后为空时使用确定的宿主正文），notice、outcome、nextStep 一起变 |
| R2 新修订被旧失联执行拖住 | 结算阻塞扫描忽略 `invalidatedAt` 的旧绑定；旧绑定的未核实外部效果仍以“旧修订执行有工具效果尚未核实，未重放原动作”出现在结算说明中，不隐瞒、不重放 |
| 续做输入 | 续做 instructions 增加“未核实的未知外部效果不得重放；只推进与其无依赖的独立步骤…” |

### 1.3 §5/§6 插话与未来安排

| 改动 | 落点 |
| --- | --- |
| `select()` 目标解析抽成纯函数：显式 workId > 引用消息 > 选中卡片 > 用户原文里唯一≥4 字的未结束事项标题 > 唯一未结束事项；歧义仍拒绝（仅“改向/停止”这条路径扩展，不改变权限与版本守卫） | `BotWorkTargetSelection.ts`、`BotForegroundTools.ts` |
| watch 无变化快路径：宿主已证明 `unchanged` + `silent` + 完成态 + active + `changes_only` + 无到期/终止/待办补查/待用户输入，且偏好与观察策略版本与上一轮已审阅行一致时，直接持久化 `state=silent`、`reason=host_proven_unchanged`，**结果模型调用 0、用户投递 0** | `WorkWatchSupervision.ts` |
| 新增只读 `schedule_overview`：合并 Cron 提醒、一次性/持续事项、事件订阅（来源、目标、下次唤醒、版本游标），逐项给出时间或触发条件、真实动作、状态、结果去向，并显式标注 `hostMustBeRunning`；提醒与事项不互相冒充 | `BotScheduleOverview.ts`、`BotForegroundTools.ts`（`BOT_FOREGROUND_TOOLS`） |
| 持续目标语义：ongoing 仍用 `mode=watch` 保持持续委托，但不再强制周期 cron——`startImmediately` + `watchRule.nextWakeAt` 表示“现在先执行、之后按真实时间等待”，无任何未来动作仍拒绝 | `BotForegroundTools.ts` `validateWatchIntent` |
| 前台提示词同步：新增“现在能答的/还要继续的/之后该回来的”契约、里程碑先交付不等于完成、插话语义、`schedule_overview` 用法；修正旧文案“持续目标不得落 once 或只有一次检查” | `BotConversationService.ts` |

### 1.4 测试与文档

| 类型 | 内容 |
| --- | --- |
| 新增测试 | `scripts/bot-scheduling-continuation-test.ts`、`scripts/bot-work-milestones-test.ts`、`scripts/work-watch-unchanged-test.ts`、`scripts/bot-scheduling-routing-test.ts`（已注册到 `package.json` 的 `test:bot-scheduling-continuation` / `test:bot-work-milestones` / `test:work-watch-unchanged` / `test:bot-scheduling-routing`，默认 headless 套件自动纳入） |
| 因新语义更新的既有测试 | `scripts/work-watch-supervision-test.ts`（无变化轮原来断言会调用 review，现按 #27 断言 0 次 + 静默行）、`scripts/bot-watch-intake-test.ts`（“ongoing 只有一次唤醒”从非法改为合法，并断言真实后续安排）、`scripts/bot-work-team-access-test.ts`（ongoing 错误文案与用例）、4 个 dev 测试的前台工具白名单加入 `schedule_overview` |
| 文档 | `docs/bot-interaction-scheduling.md`、本报告 |

## 2. 实际执行的检查

工作树：`C:\Users\servi\Documents\GitHub\wavealstra_harness`（Windows，Node 24.19.0，pnpm 12.14.0）。

- `pnpm -s typecheck` → **exit 0**（web + node + scripts 0 新增错误）
- 新增 4 个测试 → **全部 exit 0**
- 受影响既有套件逐个执行 → **33 个套件全部 exit 0**：

`bot-work-automatic-completion`、`bot-work-review-execution`（19 项）、`bot-work-projection-retention`、`work-conversation-feedback`、`work-watch-supervision`、`bot-watch-intake`、`bot-watch-expiry`、`bot-watch-scheduler`、`bot-watch-creation`、`bot-reminders`、`bot-work-team-access`、`bot-work-foreground-contract`、`bot-work-phase3-partial-settlement`、`bot-work-summary-query`、`bot-work-team-recovery`、`bot-work-team-service`、`bot-work-team-watch`、`bot-work-phase3-collaboration`、`work-effect-retirement`、`bot-work-phase2-recovery`、`bot-work-read-lifecycle`、`bot-work-query-scale`（12076 事项/399MB，首屏 110ms）、`bot-work-phase5-review`、`bot-work-phase5-e2e-story`、`bot-work-phase5-delivery-dedup`、`bot-work-phase5-owner-summary`、`bot-work-team-native`、`bot-foreground-metrics`、`bot-execution-diagnostics`、以及新增的 4 个调度测试。

另外为确认归属，单独复跑了 3 个本机既有红套件（`bot-work-automatic-recovery`、`bot-report-images`、`bot-work-phase2:dev`），结论见 §2.1。

### 2.0 全量 headless 门禁（`pnpm -s test:all`）

`8.5 min · 通过 459 · 失败 15 · 已知失败 0 · 新增回归 15`（门禁本身 exit 1）。合并 `origin/main` 后重跑；15 个失败逐一到干净基线 worktree 复跑，**全部同样失败**，即本机既有环境/夹具问题，不是本次改动引入：

`bot-attachments`、`bot-delegation-fidelity`、`bot-report-images`、`bot-work-automatic-recovery`、`cloudflared-cli-detect`、`durable-artifact-registration`（`escape.html` 符号链接逃逸用例）、`durable-task-projection`、`gadget-blueprint`、`gadget-runtime-lifecycle`、`gateway-media`、`google-workspace-faults`、`pinned-public-proxy`、`session-history-recovery`、`slack-media`、`test-bundle-pool`（测试自身写临时目录被拒）。

其中 14 个在 `11576a70`（rebase 前）worktree 复现，`session-history-recovery` 在 `76b7ddd5`（rebase 后干净基线）worktree 复现——它由上游历史查询改动引入，与本次改动无关。`linux-session` 在首次门禁失败、合并后门禁通过，属环境抖动。基线 worktree 的对照控制组（`test:bot-work-automatic-completion`）正常通过，说明对照有效。本次未修改 `scripts/test-baseline.json`。

### 2.1 既有红：在 HEAD 上同样失败，与本改动无关

用 `git worktree add --detach <tmp> <commit>` 在**未包含本次改动**的干净提交上复跑（`11576a70` 为 rebase 前基线，`76b7ddd5` 为 rebase 后基线），结果相同：

| 套件 | 现象 | 判定 |
| --- | --- | --- |
| `test:bot-work-automatic-recovery` | `AssertionError: every recovery retains ancestral artifact path`；夹具对 `JSON.stringify` 结果用未转义 Windows 路径做 `includes` | HEAD 上复现，既有夹具问题 |
| `test:bot-report-images` | `3 !== 4` 个来源别名；`encodeURI` 后的绝对路径在 `BotReportImageService` 被判为未知 scheme（分行符 `%5C` 先于 `decodeURIComponent`） | HEAD 上复现，既有缺陷 |
| `test:bot-work-phase2:dev` | exit 1（Electron/CDP dev 前台，本机无运行中的 dev 实例） | HEAD 上复现，环境依赖 |

本次未修改 `scripts/test-baseline.json`，也没有把这三个失败写成“通过”。

## 3. 必过项逐条状态

### 3.1 调度主链（PDF A-1～A-9）

| 验收项 | 状态 | 证据/说明 |
| --- | --- | --- |
| 11 类默认场景按表处理，直接回答/短工具不建 Work | **部分** | 契约与场景表已冻结进规格并同步前台提示词；宿主侧未新增分类器。未用真实模型逐类对照 |
| 混合请求：先答有证据部分，余下 Work/提醒真实受理并关联原请求 | **未测** | 依赖真实模型行为；宿主的原请求关联与去重逻辑由既有套件回归 |
| A/B 子项：A 有真实成果、B 仍运行时 A 可先看到、可打开，最终保留 A | **通过** | `bot-work-milestones`：运行中终态子项→部分交付物→里程碑 `ready` 带 `openPath`；`work_query_status` detail 读同一投影 |
| 问进度即刻从已保存状态/里程碑回答，无需等 B | **通过**（投影级） | 同一投影 + 只读工具；未做真实对话时延测量 |
| 改向/停止在有其他 Work 并行时找到正确对象 | **通过**（解析级） | `bot-scheduling-routing`：唯一标题解析、两项歧义拒绝、显式 ID/卡片优先；未做真实模型措辞对照 |
| 纯提醒创建/修改/到期/恢复无回归；到期模型调用 0、新 Work 0 | **通过**（回归） | `bot-reminders`、`bot-watch-*` 绿；到期不调模型是既有实现，本次未加计数断言 |
| 定时实际执行真的运行；条件触发只对正确来源版本运行；无实时事件时明确轮询 | **部分** | 既有 watch/调度套件绿；`schedule_overview` 暴露已注册来源与“无推送则轮询”的边界；未接真实外部事件源 |
| 持续目标有可行动步骤就推进，不用“每小时检查”替代 | **部分** | ongoing 允许 `startImmediately`+`nextWakeAt`（执行→等待）；续做按真实进展（R1）。未做长期运行验证 |
| 已确认无变化跳过结果模型；来源失败不能静默报无变化 | **通过** | `work-watch-unchanged`：unchanged→review 0 次、silent 行、0 投递；changed/unverified/偏好变更/暂停/到期/待办补查/待用户输入仍走 review |
| 三个 A-7 故事跑通 | **未测** | 未运行真实 Electron+模型；故事只作为契约写入规格 |
| 对话/团队/Work/渠道/归属版本隔离；重复里程碑不重发；重启后可读 | **通过**（服务级） | `bot-work-milestones` 重放 0 次、关闭重开 DB 后 0 次；既有 team/watch 套件绿 |
| 紧凑分页与长对话性能回归 | **通过** | `bot-work-query-scale`：12076 事项，首屏 110.3ms；`bot-work-projection-retention` 绿 |

### 3.2 B-2 相关可靠性

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 第 3 次补缺仍有真实新进展时不因固定两次历史放弃 | **通过** | `bot-scheduling-continuation` 第 1 行 |
| 无关 unknown 存在时，不重放写入，独立只读缺项仍推进 | **通过** | 同上第 3 行；续做输入含“不得重放”约束 |
| 宿主决定最终不继续时正文不再保留“接下来继续” | **通过** | 同上第 2 行：正文剥离承诺 + 宿主 notice + `partial/deliver` |
| r2 有成果、r1 已失效且旧运行 unknown：不隐瞒旧风险，r2 不被拖死 | **通过** | 同上第 4 行：结算生成、结论 ended_unsuccessfully、说明含旧 unknown |
| 仅文件名/空占位不当作真正交付 | **部分** | 里程碑与结算不再把未登记路径当可用成果；完成复核仍只看 summary/引用，**成品正文核验属 B-6，未在本 Issue 修复** |
| 同一来源不重复建单；已处理不重复催；新回归关联旧事项 | **部分** | 既有去重/交付套件绿；来源稳定身份映射未新增实现 |

### 3.3 关联缺口（本 Issue 未解决，不得宣称已实现）

| 缺口 | 状态 |
| --- | --- |
| B-3 长会话 300/301 召回断点、完整 Git SHA/技术词误过滤、hybrid 入口不一致 | **未改**，需独立 Issue |
| B-4 桌面→网关→桌面同一 Bot 的偏好与 scope 一致性 | **未改**；本次只覆盖同一 Work 的定位/改向 |
| B-6 完成复核读取成品正文、QQ/Discord/钉钉文件交付、常驻宿主 | **未改**，需独立 Issue |
| B-7 无 project 的个人 Work 跨 Work Skill 复用与修订效果 | **未改**，需独立 Issue |
| 真实 Electron/模型/任务链整链路验收 | **未跑**（本机无真实模型与桌面链路夹具） |

## 4. 已知限制与残余风险

- 续做上限是常量 4；进展判定只在登记过续做记录的 Work 上生效，旧数据按上限回退。
- “承诺改判”用确定性句式剥离；不含提示词（接下来/继续/稍后等）的表述仍可能残留未来承诺措辞。
- 没有 `bindingId` 的 unknown admission 被视为无关，不阻塞续做。
- 团队通道 `WorkTeamService.continueMissing` 仍按自身规则拒绝任意 unknown/in-flight（本次未改，套件绿）。
- 进展指纹在完成事务里读产物字节（与既有恢复通道一致），产物多的 Work 每轮有额外 I/O。
- R2 允许在旧失效执行仍 running 时完成结算；旧进程迟到写入不由本次改动拦截，只保留为未知效果说明。
- 运行中轮询把子项送入既有 inbox，会对每个子项产物做一次哈希（≤40 项/轮）。
- `DurableBotService.inspect` 在“终态记录但仍有活跃 harness 任务”的窄窗口会丢弃本轮 subitems，里程碑稍后到达。
- 详情/列表投影新增约 4–5 次有界 SQLite 读取（复用同一批事实源，未观测到 query-scale 回归）。
- `requiresUserInput` 是 Work 级门槛，复制到每条里程碑，不是子项级。
- 标题定位最多扫描 500 个未结束事项，且是字面子串；更多事项或短 ASCII 词可能落到旧的“拒绝/唯一事项”路径。
- `schedule_overview` 列出所有未结束的一次性/持续事项（有界并给截断通知），不只是显式排期的；提醒服务读取失败会进入 notices 而不是整体失败。
- 全量 headless 门禁已运行：459 通过 / 15 失败，15 个失败在干净基线 worktree 上逐一复现（§2.0、§2.1），因此本次改动**未新增门禁失败**；但本机门禁本来就因环境问题不绿，不能宣称“全绿”。

## 5. 后续建议

1. 独立 Issue：B-3 记忆可找回性（检索候选先截断、来源长会话排除、误过滤）。
2. 独立 Issue：B-4 跨入口身份与自动记忆 scope 统一。
3. 独立 Issue：B-6 完成复核读取已登记成果正文/渲染/测试证据 + 渠道文件交付 + 常驻宿主。
4. 独立 Issue：B-7 个人跨 Work 方法复用与修订效果。
5. 真实 Electron + 模型 + 任务链的 S1～S3 验收（含忙时插话、双 Work 改向、运行中成果打开、重启恢复）。
6. 修复本机 3 个既有红（recovery 夹具的 JSON 转义、report-images 的编码路径识别、dev 测试的 Electron 依赖），并据实更新基线。