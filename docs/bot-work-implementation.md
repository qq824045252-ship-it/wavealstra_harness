# Bot / Work 实施记录

实施日期：2026-11-06；交付记录更新：2026-11-07。源码基线：`0501a10bdeff3b80996b16ad14af38521d6b0200`。Phase 1 实现与本记录在同一提交中交付，提交号可用 `git log -1 -- docs/bot-work-implementation.md` 查询。本文件记录实现与检查结果，不修改冻结设计，也不表示 BOT-WORK-1.0 已交付。

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

Phase 2 仍需完成规划中的前台独立对话、Work 受理与控制工具、事件消费和业务派发入口。当前适配器可恢复已持久保存的派发绑定，没有用普通 Task 对话替代长期 Bot 身份。

Phase 3 继续完成资源门控、结算、部分成果和交接。Phase 4 完成真实订阅、离线补处理、因果防环与原生用量记账。Phase 5 完成通知渠道、双页面交互、跨端同步，以及全部适用 BW 场景与端到端故事。Phase 2～5 尚未整体验收完成。
