# Bot 跨入口身份、学习与交付实施记录

范围：#29、#30、#31，与已存在的 #32 个人协作实现集成。用户已授权扩展或重写接口；保持单一 Work、Durable、Skill 和投递事实来源。

## 阶段

- [x] Ground：核对 issue、入口、协作、记忆、Skill、成果与投递链。
- [x] Sketch：比较两种完整接口设计，固定身份、来源、执行绑定和投递契约。
- [x] Agree：用户已授权自主执行，无额外设计审批。
- [x] Implement：身份与跨入口控制、Bot 私有技能、渠道成果投递、常驻生命周期。
- [x] Verify：完成可用环境内的分层检查；全量 headless 497/0、类型检查通过，真实钉钉/Discord 和整机离线边界保持未测。
- [x] Scrap：删除旧 Gateway Durable 受理接口和重复来源表；纯决策契约、证据读取与模型运行时分离。

## 不变量

1. 用户、发起 Bot、执行 Bot、原始接收会话各自有独立含义。
2. 原始来源与收件路线不因桌面改向或执行交接而改变。
3. 当前执行归属读取 Work 与有效执行绑定，携带 ownerEpoch、intentRevision 和输入版本。
4. 个人方法属于实际执行 Bot；Work 局部事实不自动提升；私人、群聊和团队范围分离。
5. 成果投递绑定不可变版本，继续使用现有 Work 通知账本；未知回执不盲目重发。
6. 外部宿主复用同一执行与恢复内核，不形成数据库双主或第二调度器。

## 验证边界

组合故事：QQ 找 A → A 委派 B → B 返回部分成果 → 桌面改向 → B 完成 → 原 QQ 收进度和结果摘要并明确文件发送限制 → 纠正方法 → B 在新 Work 使用修订版。真实文件收件另用支持通用附件的钉钉或 Discord 验证，不能把 QQ 摘要回执算作文件收件。

专项需要覆盖无关并行 Work、过期修订、跨 Bot/用户、个人/团队、forget、路由失效、部分投递、未知回执和重启恢复。实际渠道账号及真正外部宿主证据单列，不能用模拟或本机重开补跑替代。

决策日志：`out/diagnostics/bot-cross-channel/decisions.tsv`。各次命令、退出码和未测项随实施追加。

## 设计选择

选择 A：把现有 BotConversationService 变为传输无关受理链，网关复用真实消息、回执、协作与自动记忆，并删除独立 Gateway Durable 受理路径。没有新增第二个 canonical receipt 权威表。

对比 B 的独立可信入口权威，A 的调用迁移与长期维护范围更小。交叉评审评分依次为身份一致性、接口深度、跨会话边界、迁移验证、模块集成，每项五分，A 为 4/5/4/4/4，B 为 4/3/5/3/4。吸收 B 的当前执行版本守卫、原始收件目标单一权威、遗忘与技能撤销的冷启动验证。

用户已确认 VIVION 即当前电脑并保持常开。客户端退出后继续运行，整机离线时暂停，恢复后接续；不按异机云端持续执行宣称验收。

## 当前验收记录

隔离的开发实例使用单独 HOME、USERPROFILE、userData 和开发输出目录，QQ 由用户扫码连接并绑定验收协调 A。用户已确认从 QQ 发消息并收到回复。重载后已读回 QQ connected=true、绑定账号数量为一、宿主 online/isAuthority=true。钉钉和 Discord 尚未连接真实账号。

本文所称隔离目录为 `out/diagnostics/bot-cross-channel/interactive/2026-11-12T05-48-39-177Z/`，其中保存实际请求、回执、只读检查和带时间戳的状态快照。

完整 `pnpm dev` 常驻试验已验证原客户端进程退出、独立 resident 进程接管，以及重新打开界面后仍由同一 resident 进程持有宿主权威。整机睡眠、关机和断网恢复尚未实测。常驻无界面模式不能据此宣称依赖嵌入式界面的所有工具都可用。

真实模型通过实际 AgentService、SQLite、文件系统和 Discord adapter 运行，Discord HTTP/WebSocket 传输由隔离夹具接收。这属于模型与宿主集成验收，不是真实 Discord 平台账号验收。前两次均失败，保留原记录：

- `out/diagnostics/bot-cross-channel/model-live/2026-11-12T06-47-31-934Z`：A 委派 B 并生成登记草稿，宿主把等待用户补充的 partial 结果结为 ended_unsuccessfully，桌面改向无法继续原 Work。
- `out/diagnostics/bot-cross-channel/model-live/2026-11-12T06-50-46-624Z`：真实 final.txt 已生成、核对和登记，自动完成卡却只选人工 accepted 成果，实际外发请求没有附件。方法纠正与第二次技能复用尚未执行。

上述等待与最终附件问题已有专项修复。等待现在使用显式、引用原始用户要求的决策并复用现有用户输入 blocker，不靠解析报告正文猜状态。自动成果卡引用经过当前执行版本和目标审查的精确 proposed 文件版本，保留人工 accepted 事实的独立含义。方法纠正从同一成果卡和执行 lineage 取证，并重新核对快照 hash。

后台冻结技能副本对禁用、遗忘、修订的即时撤销与真实调用记录已经通过实际 AgentService/native read 专项。等待通知向原外部会话投递已选择的部分成果也已通过 SQLite、冻结字节、回执和重复 drain 专项；多轮等待保留同一 Work，旧问题卡及旧重试不复活。完整模型组合试验已通过，先观察部分成果实际外发，再从桌面改向，最终文件回原接收地址，并实际读取修订技能完成第二个个人 Work。模型运行记录见 `out/diagnostics/bot-cross-channel/model-live-acceptance.md`。

QQ 官方接口限制单列：当前通用文件发送不可用，Work 文件仍保存在 MyBuddy；QQ 只在有效原消息回复窗口和剩余额度内发送摘要及明确的文件未发送说明。不得把文字回执写成文件发送成功。Discord 和钉钉文件链已经通过 adapter、SQLite 回执、实际附件字节与 hash 的专项验证，真实账号仍待验。

完整 headless 检查历史保留：首轮 472/19，第二轮 493/3，第三轮 492/4。第二轮三项因文件符号链接 EPERM 中止；后来主机实测可以创建文件链接，原因未知，本任务未修改系统设置。第三轮走到后续断言后发现 Windows 路径 JSON 双转义，以及两个 CJS 测试因 Work 复核意外导入 Pi 运行时而启动失败；均已修复并专项通过。记忆服务的文件规模门限通过提取完整职责模块修复，没有压缩换行或放宽基线。最后一轮 `pnpm -s test:all` 退出 0，497 通过、0 失败、0 已知失败、0 新增回归，记录为 `out/diagnostics/bot-cross-channel/test-all-accepted.log` 及 `test-all-accepted-result.json`。最终 `pnpm -s typecheck` 也退出 0。测试失败基线及架构基线均未放宽。未构建产品、打包、提交或推送。

## 实际 QQ 与记忆证据

真实 QQ 已完成 A 受理、B 负责单一 Work、登记草稿并等待、桌面改向同 Work r2、核验最终文件，以及原 QQ 文字通知。该次旧模型把“B 没有 QQ 发送工具”误判为业务缺口；新实现向执行与审查注入去标识化的宿主回传职责、能力及实际投递状态。原会话回传由宿主负责，向其他收件人的业务发送仍须实际执行并核对回执。

通过正式主窗口 API 对原 Work 做了只读复核。当前结论更正为成功，原 closeOperationId、closedAt、原 partial 审查、旧失败投递与回执保留；没有新建 Work、执行绑定或人工 accepted 成果。原 Work 数为一，B 为负责人，团队数为零；草稿和最终快照 hash 均匹配。相同请求重放返回原结果。更正只发文字，不重发旧文件，避免绕过 unknown 回执的停止重试规则。详见隔离目录中的 `qq-closure-final-verification.json`。

QQ 首次自然偏好记录为 agent、explicit=0，该次实际工具调用为零，证据为 `qq-preference-auto-proof.json`。桌面首次纠正曾调用显式记忆工具并形成另一条记录，不计作自动纠正证据。随后单独验证无工具纠正：实际调用仍为零，宿主自动把桌面那条既有记录更新为“先列三条依据，再写结论”，保留其 memoryId。零工具和内容更新见 `qq-preference-desktop-auto-revision-proof.json`；revision 2、changedBy=agent 的数据库证据见 `qq-summary-clean-input-proof.json`。`memory-proof-index.json` 并列关联这些证据，没有把 QQ 首次记录与桌面记录当成同一 ID。重启后用户确认收到更正及正确顺序；一次消息误带了格式说明，已保留并另用不含顺序的“请总结今天这个事项的结果”核对。该 QQ 会话仍保留历史，不能据此单独推断回复完全由 L1 记忆造成。

真实提炼还发现单个 Work 的临时约束曾进入 A 的 Bot scope。现依据真实用户消息、回执和 Work 来源收窄，新候选进入 Work 或 conversation；旧自动记录读取时也收窄，保留原记录及证据。稳定偏好和明确授权的长期记忆保留对应范围。实际旧记录只读审计和生产 L0/L1 回归均已保存。

## 技能对照与剩余边界

独立等价对照使用同一 B、相同请求、相同初始数据库快照及新工作目录，仅切换目标修订技能。关闭组产生业务文件但没有 verification.txt；启用组实际读取相应 candidate，并生成 VERIFIED_REUSE 核验文件，A 未参与或转述步骤。启用组出现一次真实 provider 解析失败，产品续执行只回读并登记已有输出，失败与维护调用均计入。一次随机对照说明本次纠正规则得到复用，不证明成本、速度或成功率提升。报告为 `out/diagnostics/bot-cross-channel/method-ab/comparison.md`。

用户目前只能提供 QQ。钉钉与 Discord 仅有真实 adapter、SQLite 账本、实际附件字节及 hash 的隔离验证，真实账号投递仍为未测。QQ 通用文件仍不支持。VIVION 的客户端退出与同宿主恢复 UI 已通过开发模式实机验证；整机睡眠、断网、重启和关机恢复未实测。本次未运行完整 GUI/ARTIFACT 门禁，也未形成发行包验收。

所有实现仍为 main 上未提交的工作区改动，基准 HEAD 为 `2dfb435fec09d073a8d843f3038ba136cedd7d75`，不能当作实现已进入远端的 SHA。并行任务的数据库格式、Pi 补丁及其他功能修改保留，未归入本任务成果。

`out/diagnostics/bot-cross-channel/final-source-manifest.json` 保存当前关键源码 hash、headless 结果和实际运行 bundle hash。实际 QQ 验收之后又做了纯契约、证据读取和记忆策略的模块提取；最终源码另经专项、类型检查和完整 headless 门禁，不把较早的运行 bundle hash 写成最终源码 hash。应用侧模型记录可查 `model-live-runs-summary.json`、`method-ab/comparison.json` 与 `interactive-model-usage-summary.json`。交互代理日志有客户端中止流而缺少 usage 的记录，不能把它们直接当成业务失败，也不把缺失 token 或费用补为零；实际计费未知。

轨迹已由 gpt-6.1-sol 和 gpt-6-astra 对照本会话独立检查。发现旧日志把 VIVION 确认指向提问行，实际用户确认在 transcript 第 292 行，已用追加行更正。早期交叉设计评审使用 gpt-6-astra、gpt-6.1-terra，与主执行模型同属 GPT 系列；当前可用子代理模型不能完成不同模型家族审查，不宣称家族多样性。可重写的 run.json 仅作当前启动索引，状态证明另存带时间戳的观测快照，旧状态以本会话实际工具结果为准。
