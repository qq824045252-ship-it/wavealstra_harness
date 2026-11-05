# pstack 的 MyBuddy 原生适配评估

结论：排除 Cursor 云端执行后，所列工作流可以在 MyBuddy 本地适配。现状仍有真实缺口，但不能把它们都归为 Cursor 专属能力。建议复用现有调度、终端、子代理和技能创作服务，修正技能指令与产品行为之间的差异，再补模型可调用的入口。单纯安装三个技能无法完成验收。

本评估依据当前工作区源码、本机已安装技能、角色配置，以及 Cursor 官方仓库的技能原文。工作区已有其他任务的未提交变更，因此结论对应当前工作区，不代表已发布安装包。本轮只生成评估文档，没有修改产品源码、已安装技能或用户配置。

| 项目 | 已核对的能力 | 建议 |
|---|---|---|
| `/loop` | `CronService` 已支持 at、every、cron，保存配置、记录 run、启动时重建启用任务的定时器；当前模型没有调度工具 | 复用此服务暴露任务范围内的创建、查询、暂停、取消入口；另补继续当前任务的执行模式 |
| Cursor cloud agent | 本地子代理和 Git worktree 不提供远程常驻执行环境 | 明确排除云端能力，保留本地任务的对应流程 |
| `deslop` | 官方原文是纯文本代码清理规则，没有 Cursor API 依赖 | 复用已有代码原则，提供轻量的提交前 diff 检查步骤；不需要开发专用工具 |
| `control-ui` | `ui_exec`、`computer_exec`、浏览器工具和 `runtime_probe` 覆盖常见操作及运行时证据 | 在验证流程中明确工具路由、操作后断言和证据保存；高级 CPU、heap、network 分析按现有测试或调试接口处理 |
| `control-cli` | 普通 CLI 可用 bash；`TerminalHost` 已提供 PTY、input、resize、tail、close | 为交互式 CLI/TUI 增加模型可调用的持久终端入口，复用现有平台实现 |
| `create-skill` | 已注册 `skill_authoring_assess` 和 `skill_authoring_create` | 直接映射现有入口，保留评估及默认停用语义；不宣称覆盖所有技能维护操作 |
| GitHub 写操作 | 本会话 GitHub MCP 为只读 | 已获授权的写操作走 gh；安装技能不改变 MCP 权限 |

`deslop` 清理代码，`unslop` 清理文字，二者不等价。官方 `deslop` 的重点是多余注释、不必要的内部防御、不合理的 any、深嵌套和风格偏离，并要求保持行为。把这一小段流程直接塞进全仓严苛审计会增加成本。更合适的做法是让 poteto-mode 的提交前步骤复用这些规则，只检查本次变更。

官方 control 技能要求先复用项目现有验证设施，并没有要求 Cursor 专用服务。保留它们的观察、执行、断言、清理流程即可。control-cli 的 tmux 和 Python pty 是示例，不应在 Windows 上照搬为必需依赖。

当前最先需要修正的是技能与真实接口之间的冲突。

1. 本机 `poteto-mode/SKILL.md:106` 仍称 MyBuddy 的 subagent 没有 model 参数，所有角色均为 inherit-parent。实际工具已支持逐任务 model、reasoning、isolation，本机角色表也包含 fast、strong、diverse。旧指令会让模型主动放弃已有能力。
2. 本机角色表把 parent 解释为省略 model，poteto-mode 也有同类指令。当前 `resolveSubagentSelection` 在省略 model 时依次使用角色模型、子代理默认模型、全局默认模型。继承父模型必须显式传 `model: "inherit-parent"` 或 `"auto"`。
3. `matchesSkillPolicyNeedles` 对 id、name、command、description 拼接文本执行 includes。allow 和 hide 也复用该逻辑。这会把关键词推荐扩展成名单匹配，不能仅视为目录观感问题。本轮直接调用函数，复现了 bro 命中 ego-browser，以及 architect 命中带 architecture 描述的 archify。本轮未重新统计“7 条”的完整名单。
4. 产品角色目录中只有 planner、reviewer、scout、worker、trace-water-expert，未发现 poteto-agent。现有发现器已支持产品和用户角色目录，通常只需要安装角色定义，不需要增加一种子代理引擎。但该角色不能因此获得父会话的技能策略、MCP 或 UI 工具，交接仍须遵循现有 context contract。

建议把硬名单与语义推荐分开：allow、hide 使用稳定技能 ID 或明确声明的别名，prefer、demote 才使用关键词。已有关键词名单需要显式转换或保留可区分的关键词类型，不能直接全局替换 matcher 后让既有配置改变含义。

模型策略也应由产品解析，而非依赖模型记住运行外部脚本。当前 `pstack-models-resolve.mjs` 没有接入原生 selection。接入时需解决以下契约问题：

- 将工作流角色映射到原生可用模型集合，最终仍由现有 selection 验证；显式指定不可用模型时继续报错。
- fast 和 strong 目前依据名称、上下文长度及输出上限评分。这是启发式排序，不能证明延迟或质量。产品配置宜提供明确的候选模型列表与优先级。
- diverse 目前优先按 provider 去重，provider 不足时会补同 provider 模型，数量不足时也可能返回更少结果。不同 provider 不保证底层模型不同，同一网关也可能代理多个不同模型。验收应核对实际模型身份与所需数量。
- 角色表的 budget 当前主要作为输出元数据，不能据此声称已传入 reasoning。推理设置须经过现有模型元数据和传输能力校验。
- `pi --list-models` 是模型目录证据，不是逐个模型完成在线调用的证据。

`/loop` 的主要工程量在执行语义。当前 `CronService.execute` 每次生成新的 cron taskId，不会自动继续原对话。直接暴露 upsert 只能提供定时自动化，尚不等于“每五分钟继续检查这个 PR”。建议同一调度服务支持明确区分的新任务与当前任务目标，并在 Automation 页面显示来源任务、下一次执行、执行记录和停用入口。

调度入口的最小验收应覆盖：创建后按期触发、当前任务上下文与 cwd 正确、同一任务忙碌时不重入、取消后不再启动、达到截止时间或次数后停止、重启后的恢复策略可见。当前调度依赖应用进程，退出或休眠期间不执行。不能把它描述为云端常驻任务。

还需在复用 CronService 时验证两处源码风险。`everyToCron` 把持续时间转换成日历 cron，不能表达所有任意间隔，例如 90s 的分支生成秒字段 */1。定时回调调用 `void this.execute(job)`，没有把执行 Promise 返回给 croner，不能仅凭 protect:true 认定任务执行期间不会重入。这两点是源码发现，本轮未跑真实定时重入场景。

交互终端适配应复用 `TerminalHost` 的 open、input、resize、tail、close，但为模型分配独立 terminalId，避免接管用户正在使用的终端。输出尾部不等于 TUI 当前屏幕，若要对光标移动和重绘后的布局做断言，还需终端屏幕状态读取能力。输入、Ctrl-C、尺寸变化、退出与任务清理需要在真实 Windows ConPTY 和 Linux PTY 上分别验收。

推荐实施顺序如下。

| 顺序 | 修改范围 | 完成标准 |
|---|---|---|
| 1 | poteto-mode Harness 段、角色表说明、相关 playbook、产品角色定义、名单匹配规则 | 不再出现无 model 参数和省略即继承的指令；poteto-agent 可发现；硬名单不再被短词误命中；本仓库 main-only 规则优先于技能默认 worktree 流程 |
| 2 | 现有模型配置及 `subagent/selection.ts` 附近的角色解析 | 调用方无需运行独立脚本；模型来源、推理设置与实际 worker 使用值可回读；多模型要求不能悄悄退化为同模型 |
| 3 | CronService、能力注册及 Automation 展示 | 通过定时触发、当前任务继续、取消、不重入、截止及重启策略测试；不用长时间 bash sleep 承担持久调度 |
| 4 | TerminalHost 的模型工具入口及验证流程 | 真实 TUI 可输入、等待提示、读屏、调整尺寸、发送 Ctrl-C，并只清理本任务持有的会话 |

改动风险主要是名单语义变化、定时任务的执行目标，以及终端会话归属。实现时按上述范围分别验证。技能与角色文件部署前保留原字节；新工具可独立停用；名单配置转换保留来源映射。已有用户任务和已接受发行包不应被适配过程打断。

本轮验证证据如下。

| 命令或操作 | 结果 | 证明边界 |
|---|---|---|
| `pnpm -s test:subagent-selection` | PASS | 显式模型、父模型选择、配置回退及 reasoning 校验通过；没有重新测试在线多模型调用 |
| `pnpm -s test:terminal` | host 33/33、bridge 20/20、store 9/9、Herdr launcher 7/7 PASS | host 测试使用 fake PTY；不能当作真实终端端到端通过 |
| Node `stripTypeScriptTypes` 后导入实际 runtime-policy.ts，调用 matchesSkillPolicyNeedles | bro→ego-browser 为 true；architect→archify 为 true；poteto-mode 自身匹配为 true | 证明匹配行为；archify 输入使用含 architecture 的最小描述样例，不是完整目录统计 |
| GitHub MCP 读取 Cursor 官方三个 SKILL.md | 成功，来源固定到下述 commit | 证明技能原文与依赖，不证明 MyBuddy 已完成适配 |
| `skill_authoring_assess` | no-skill | 本轮无需新建技能；建议复用现有能力。该评估是辅助意见，不替代源码验证 |

没有执行新的 live 子代理、多模型网络请求、真实定时任务、真实 PTY/TUI、GUI 或发行包验收。未安装 cursor-team-kit，未运行发布流程。现有测试通过不表示完整适配完成。

源码定位：

- [CronService](../src/main/cron/CronService.ts) 的 start、arm、execute、everyToCron。
- [Cron DTO](../src/shared/agent-ipc.ts) 的 CronJobDto。
- [能力注册](../src/main/capabilities/builtin-capability-extension.ts) 的 skill_authoring_assess/create、UI 和 runtime 工具。
- [模型选择](../src/main/capabilities/subagent/selection.ts) 的 resolveSubagentSelection。
- [角色发现](../src/main/capabilities/subagent/agents.ts) 的 discoverAgents。
- [子代理上下文](../src/main/capabilities/subagent/context.ts) 的 buildContextBlock。
- [名单匹配](../src/shared/runtime-policy.ts) 的 matchesSkillPolicyNeedles，以及 [UI 过滤](../src/shared/mode-access-filter.ts)。
- [终端宿主](../src/main/terminal/TerminalHost.ts) 的 open、input、resize、tail、close。
- [仓库已有适配说明](../docs/pstack-mybuddy.md)。
- 本机技能：`C:/Users/servi/.mybuddy/plugins/skills/poteto-mode/SKILL.md`。
- 本机角色配置：`C:/Users/servi/.agents/pstack-models.md`、`C:/Users/servi/.agents/pstack-models-resolve.mjs`。

官方技能来源固定于 `cursor/plugins` commit `bb68f2365eceafa0cb2d253112f675acf5f144cc`：

- [deslop](https://github.com/cursor/plugins/blob/bb68f2365eceafa0cb2d253112f675acf5f144cc/cursor-team-kit/skills/deslop/SKILL.md)
- [control-ui](https://github.com/cursor/plugins/blob/bb68f2365eceafa0cb2d253112f675acf5f144cc/cursor-team-kit/skills/control-ui/SKILL.md)
- [control-cli](https://github.com/cursor/plugins/blob/bb68f2365eceafa0cb2d253112f675acf5f144cc/cursor-team-kit/skills/control-cli/SKILL.md)
