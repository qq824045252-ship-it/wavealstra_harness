# pstack in MyBuddy

## 在代码开发中启用

在「设置 → 模式与提示词 → 代码开发 → 能力面 → pstack 工作流」勾选「启用 pstack 工作流」并保存。初次安装时总开关关闭。开启后，模型根据本轮意图决定是否使用工作流；普通聊天和按需阅读代码可以直接回复。模型选择具体流程后，MyBuddy 按流程检查当前轮的完成凭据。

页面顶部有两个独立开关：

| 开关 | 作用 |
| --- | --- |
| 启用 pstack 工作流 | 控制代码任务是否获得整套原生工作流工具。关闭后保留配置。 |
| 启用 Thermos 深度质量评审 | 单独控制 Thermos 的自动触发、合并前审查门和显式审查入口。关闭它保留 poteto、其他流程与正常验证；重新开启沿用原阈值。 |

**只关 Thermos：保持 pstack 开启，取消勾选 Thermos，然后保存。** Thermos 开关与参数保存后用于新任务。已建立的会话及已启动的工作流继续使用各自启动时取得的审查配置，不会中途停掉正在执行的审查。总开关关闭再开启也不会把已经关闭的 Thermos 自动打开。

### 代码 Tags：最小模式与 HTML

代码开发的出厂目录只保留以下两项；开发任务类型由 poteto 按目标选择。

| Tag | 用途 | 默认流程 |
| --- | --- | --- |
| 最小模式（`minimal`） | 普通代码任务，出厂配置不额外附加专家、权限、技能限制或提示词。 | 跟随 poteto 设置，出厂为自动选择。 |
| HTML（`web-html`） | 网页与 HTML 产物，沿用项目设计，创建实际文件并用当前任务 Space 的浏览器检查页面和交互。 | 跟随 poteto 设置，不固定到 feature。 |

旧的修 Bug、重构、代码审查、方案设计、只读解释标签退役；此前退役的 feature-dev、add-tests 和旧 pstack 标签继续保持退役。历史任务和会话文件保留，运行时将这些旧 ID 解析为当前最小模式，包括用户自己对最小模式的定制；不会继续套用旧标签的只读限制、专家或提示词。已经启动并冻结配置的旧只读工作流仍遵守原范围。自定义标签和已有的同名自定义 HTML 配置保留，未知自定义 ID 延续原来的基础策略回落行为。

在「预设 / Tags」仍可为某个标签设置明确的默认流程；未指定时跟随 poteto。`pstack_workflow status` 返回启用的流程和 poteto 指引，`start(playbook=auto)` 或 `start(skill=poteto-mode)` 返回路由建议所需的指引与清单，且明确标记 `started: false`。模型按本轮目标选出具体流程后再次调用 `start`，这时才建立工作流和工作区基线。查看路由不会替换在途流程，也不要求用户手动分类任务。

poteto 本身也可在「技能与原则 → 任务路由」关闭。关闭后不再应用其默认剧本或 GitHub 绑定要求；仍可明确选择其他启用的流程。独立选择 Thermos 时可以交付有位置和证据的缺陷报告，不要求为了完成审查而修复源码；实现流程与调查答稿的审查门仍须通过。

设置页提供 60 项技能：35 个上游方法、24 条原则和 MyBuddy 的 Thermos 审查；另有 22 个上游剧本、1 个 MyBuddy 原生编排剧本、17 组角色和 8 项 Thermos 评审准则。每个条目展示其阶段、关联角色和可配置参数。模型页显示候选模型、排除项、推理能力、并发和超时。「全局子代理设置」的变更也影响其他使用子代理的任务。独立角色人数、预算、隔离和评审阈值保存在代码开发配置里。

## 2026-11-25：对齐 pstack 0.15.48

本次对照 [cursor/plugins 的固定提交 9e278fe](https://github.com/cursor/plugins/tree/9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc/pstack)。版本、35 个命令和 22 个剧本的清单写在 [upstream.ts](../src/shared/pstack/upstream.ts)，目录测试逐项检查缺失和重复。`pstack_workflow status` 返回该版本来源。后续上游更新不会无提示改变已冻结的任务配置。

图片中的八个命令均有原生方法入口，并沿用 MyBuddy 已有的会话、权限、模型选择和子代理宿主：

| 命令 | 本次适配 | 完成依据或边界 |
| --- | --- | --- |
| `/reframe` | 新增歧义辨别、8–12 个术语、相邻领域、遗漏项和需求改写。 | terms 阶段提交 `sources: [{term,url}]`，每个来源须有本轮实际成功的 `fetch_content` 回执；批量请求中失败的 URL 不算证据。术语与来源内容是否相符仍由模型核对。 |
| `/sharpen` | 新增专业判断、原始材料、具体方法、外部验证与提示词改写。 | 可以仅凭用户提供的文字完成；不为了完成门槛随意读文件或执行改写后的任务。 |
| `/in-your-own-words` | 新增对目标、本质问题和约束的通俗复述。 | 交付复述即可；不自动增加等待用户确认的环节。 |
| `/poteto-mode` | 对齐上游 22 套剧本，并保留原生持久编排扩展；自动入口返回完整路由指引，由模型选择具体流程。 | 路由本身不创建虚假的已启动流程。选择具体剧本后，阶段、完成条件和真实证据由原生工具保存；原有 `orchestrate` 和角色设置继续保留。 |
| `/arena` | 收紧作者、父模型和裁判的厂商独立性，继续使用隔离作品和盲评。 | 预选和实际回执均检查厂商；没有合格裁判时给出缺口，不把同厂商回退说成独立评审。 |
| `/interrogate` | 改为隔离工作树里的实际破坏性试验，再由主代理重跑候选缺陷。 | 绑定原生命令、身份、退出码、输出、Git 版本和复现文件摘要。静态猜测、未执行、回执错配或版本变化不能成为已证实缺陷。 |
| `/ketchup` | 新增进度回顾、已有画面和完整待决清单。 | `skill(ketchup)` 返回当前工作流快照，`status` 读取进度，均不替换活动任务。独立回顾须先取得状态或实际观察。 |
| `/correct` | 更新为重复错误的结构性修正流程。 | 先定位至少两次重复，再选择类型、架构、lint 或测试约束，要求用历史失败证明本地和 CI 检查；规则文档是补充。 |

`/how` 现由一位只读调查者亲自解释；`/why`、`/reflect` 不再强制创建固定子代理；`/architect` 先读源码、形成方案，仅在确有竞争方案时调用 Arena。既有角色配置继续保留给需要它们的 MyBuddy 工作流。

### 另外四个新增方法

| 方法 | 原生执行与交付 |
| --- | --- |
| `/ketchup-video` | 生成真实的静音字幕 MP4；`pstack_video_inspect` 使用 ffprobe/ffmpeg 核实媒体、各页实际画面与停留时间。逐页原生图片读取与视觉检查另有回执，技术解码不代替可读性判断。完成时核对全部文件摘要，只允许对应媒体产物的工作区变化。 |
| `/create-formal-verification-skill` | 从真实源码选择性质，保存项目本地技能与可运行检查。清单绑定源码摘要、性质、边界、假设、工具版本和同步提交；同一命令须先对真实破坏变体失败，再在恢复后通过。 |
| `/maintain-formal-verification-skill` | 对照同步提交后的实现变化，先跑旧检查，再更新映射并重跑负例和恢复检查。不能用缩小边界、弱化性质或依赖启动失败换取通过。 |
| `/statechart` | `pstack_statechart` 通过原生 shell 运行随应用提供的固定版本官方 TLC 编译器；交付真实报告、原始 TLC 输出，以及实际生成的 Mermaid 图。反例与执行错误分别报告，输入和输出都绑定摘要。 |

视频和形式验证的最后阶段提交工作区内的 JSON 清单路径 `artifact`。清单字段和真实回执 ID 的填写方式由方法指引给出；把一段文字或手绘图写进清单不能替代执行。完成时重新读取产物，之后修改任何已绑定文件都会使旧凭据失效。验证过的媒体或模型产物不会强迫运行不相关的产品测试，其他产品源码改动继续受正常检查门槛约束。

### 执行条件

- Arena 需要用户已配置、已允许且可用的不同厂商模型。厂商识别沿用实际模型身份；不把网关的不同别名当成独立性证明。
- Interrogate 需要允许原生命令、允许 Git 隔离、可创建工作树的干净 Git 提交，以及能运行目标检查的依赖。它可以从最小模式或 HTML 中明确选择，且不依赖 Thermos 开关。旧工作流已冻结的只读权限不会被它提升。脏源码、缺工具或不允许隔离会明确阻塞；不会退回静态审查后声称已完成执行验证。复现可新增文件，但不能修改被审查源码。
- 视频检查需要本机可用的 ffmpeg/ffprobe。Statechart 需要满足官方编译器要求的 Node、Java 和 TLC；编译器随应用打包，Java/TLC 的实际准备仍遵守原生命令权限。缺少依赖就报告具体依赖。
- 所有委派保留真实用户输入、后续纠正和验收条件；盲评的封闭作者/裁判材料继续隔离。外部发布、消息和其他动作仍遵守原有授权边界。

这些条件是功能运行的前提。目录齐全、类型检查和可控模型回归通过，不代表已经在用户当前配置的全部供应商、Windows 安装包和真实项目上完成验收。

本次实际运行、失败对照和未覆盖范围见 [2026-11-25 适配验收](reviews/pstack-0.15.48-adaptation-2026-11-25.md)。

## 宿主能力与适配验收

真实模型对照可通过 `pnpm -s pstack:live-case <剧本 ID> <native|original|control> <现有证据目录>` 运行。每次会话使用独立的 MyBuddy 配置、SQLite 数据库和 Git 样本。默认使用设置页选中的模型，子代理读取本机的角色候选。原版组使用个人安装的 pstack 预设和对应剧本；内置组调用编入软件的工具。每组保留原版文件摘要、实际输入、工具调用、子代理回执和完成状态。设置 `PSTACK_LIVE_MODEL` 可选用本机已经配置的候选模型。

运行结束后，`node scripts/pstack-live-observe.mjs <证据目录> --save` 汇总阶段、真实模型、触发原因及审查回执，`node scripts/pstack-live-artifacts.mjs <证据目录>` 从工作区重新核对交付。外部写入、尚未收到的人工答复、模型服务报错和测试中断分别保留。PR 监视可以使用真实仓库的只读接口。

改动前先检查了原流程实际调用的能力。真实子会话、模型选择、Git 工作树、定时器、终端和 SQLite 恢复均可复用。原设置只控制标签是否出现，宿主没有记录其阶段、审核独立性或阻止缺证完成。以下为本次原生适配的验证入口。

| 能力 | MyBuddy 执行方式 | 验证入口 |
| --- | --- | --- |
| 配置与任务范围 | 启用后，主会话向模型提供可选的原生流程工具。模型启动或恢复流程时，将当前输入绑定到对应的验收条件。标签继续控制附加指令和策略。 | `test:local-workflow`、`test:mode`、`test:mode-preset` |
| 独立开关、保存和重开 | 无窗口 React 回归实际点击两个开关，验证 Thermos 关闭、总开关往返、序列化重挂载与阈值保留；Electron 夹具另经 IPC 写入隔离模式目录并回读。 | `test:pstack-settings-toggle`、`test:pstack-settings-ui` |
| 分工、执行与中断恢复 | `pstack_workflow` 记录配置快照、当前阶段、阻塞原因和已完成的回执。`pstack_delegate` 把角色配置交给原生子代理。模型池不足时反馈具体原因。 | `test:local-workflow`、`test:pstack-workflow`、`test:durable-subagent` |
| 验证与 Thermos 审查 | 宿主测量任务开始后的变化，保存真实校验命令的退出码、工作区版本和独立审查员的结果。改动会使旧凭据失效。 | `test:pstack-workflow`、`test:local-workflow` |
| 大规模编排和工作树审计 | 任务自己的持久台账管理依赖、派发、结果通知、决策和已验证版本。Git 审计读取真实工作树、脏文件、提交、可选 PR 状态和磁盘占用。 | `test:local-workflow`、`test:pstack-orchestration`、`test:subagent-worktree` |
| 决策日志 | 只追加六列 TSV，绑定配置路径和父操作，按任务审计日志行。宿主验证并发追加、恢复和文件身份。 | `test:pstack-decision-trail` |
| PR 监视 | 监视器按所选范围读取单个 PR、依赖链或冻结队列，执行配置的轮询、超时、失败重试与草稿策略。GitHub 查询使用本机已授权的 `gh`。 | `test:pstack-watch` |
| 新方法与版本覆盖 | 上游清单逐项对应；纯文本方法、真实来源读取、只读回顾以及活动任务状态都有行为回归。 | `test:pstack-catalog`、`test:pstack-workflow` |
| 委派与执行审查 | 用户纠正与验收条件完整传递，裁判保持独立；真实临时 Git 工作树和原生 shell 回执支撑子代理试验及主代理复跑。 | `test:pstack-worker-contract`、`test:pstack-interrogate`、`test:pstack-eval` |
| 高级产物 | 检查视频、形式验证和状态图的实际产物、来源、失败负例、恢复检查和摘要失效。 | `test:pstack-advanced-artifacts`、`test:pstack-statechart` |
| 本机调度与终端 | 调度沿用 CronService，终端沿用任务所属的 PTY。 | `test:cron-scheduling`、`test:task-terminal:live` |

流程的阶段推进、命令执行、角色分配和凭据校验由宿主完成。设计取舍、评审问题的严重程度、写作方式等判断由模型按该阶段启用的准则完成。变更行数和文件规模可直接测量，条件扫描只能提示可能散落的特例，最终结论由审查员给出。工作区若有其他进程同时写入，宿主只能观察同一份文件的变化。

本地代码任务可按需使用 GitHub。在启用的「技能与原则 → 任务路由」中选择要求 GitHub MCP 后，MyBuddy 会在启动具体流程或恢复 pstack 时检查当前场景是否可用。关闭任务路由后不再套用这一要求。GitHub 查询和外部写操作各自使用本机已有的工具、凭据与授权。工作流可随软件运行，无需安装 pstack、Bun 或 Commander。云端代理与关机期间调度取决于外部执行环境。

GitHub 监视通过已登录的 `gh` 读取 PR、检查和队列。Origin 监视使用已登录的 Origin CLI 及其只读接口。GitHub 已在一个合并完成和一个仍开放的 PR 上对照原版。Origin 已用官方 CLI 实测登录边界，并重放官方响应样例。已认证 Origin 项目的状态仍需相应账户核验。

Windows 设置页用真实 Electron 验证了编辑、保存和重开。工作流回归使用可控制的本地模型服务来重复制造失败。真实模型对照另经 MyBuddy 前台、持久子会话及本机实际配置的模型运行。移植代码的来源与许可见 [第三方声明](third-party/pstack-thermos-LICENSE.txt)。

## Frozen Bot / Work design

[BOT-WORK-1.0](bot-work-design.md) and its [acceptance contract](bot-work-acceptance.md) define the frozen target architecture for persistent bot identities, independent work ownership, foreground/background hosts, and collaboration. They describe target behavior pending implementation and validation. The capability mappings below describe the current execution foundation and do not imply that the frozen product design is already implemented.

## Subagent model and reasoning selection

The `subagent` tool accepts `model`, `reasoning`, and `isolation` for a single task and for each entry in `tasks` or `chain`. In array modes, the top-level fields provide defaults. An item's explicit fields override those defaults. An item's `reasoning` replaces the whole top-level object, without a deep merge.

```typescript
{
	agent: "worker",
	task: "Inspect the selected module and report findings.",
	model: "inherit-parent",
	reasoning: { effort: "high" },
	isolation: "shared"
}
```

```typescript
{
	isolation: "auto",
	reasoning: { effort: "high" },
	tasks: [
		{ agent: "worker", task: "Implement the parser.", model: "provider/model-a" },
		{ agent: "worker", task: "Implement the formatter.", model: "provider/model-b",
			reasoning: { effort: "low" } }
	]
}
```

The provider/model names above are placeholders. An explicit `model` requires a qualified `provider/model` reference that is available in the native Pi model scope. Unknown or unavailable explicit choices fail before worker launch. The tool does not replace an explicit choice with a different model.

`model: "inherit-parent"` and `model: "auto"` select the current parent model. They fail if the parent model is missing or unavailable. They inherit the model only, not the parent's reasoning preference. Multiple workers on that same model do not constitute a multi-model review.

Without a `model` argument, selection uses the role's model, then the saved subagent default, then the global default. Unavailable configured defaults fall through with diagnostics. Selection fails if none is usable. Omitting `model` is not inheritance.

### Display names

`displayName` is an optional display-only name for a single task, or per entry in `tasks` / `chain`. It accepts any language and appears in the task's subagent list and panel. The ASCII `subagentId` remains the only identity: steering, file names, worker arguments, and duplicate detection all keep using it, so names may repeat. Input is normalized (trimmed, control and format characters removed, 32 code points max).

When omitted, the product assigns a name automatically: a random unused entry from the 151 Gen-1 species in Simplified Chinese (for example 皮卡丘), avoiding display names already held by active subagents in the same task. A batch may only be unique up to those 151 names; larger concurrent batches repeat names, and that is harmless because identity never depends on the display name. An explicit `displayName` always overrides the automatic pick.

```typescript
{
	agent: "scout",
	subagentId: "pikachu",
	displayName: "皮卡丘",
	task: "Read the target module and report findings."
}
```

### Model roles

`~/.mybuddy/subagent.json` may declare `roles`, a map from a role name to an ordered candidate list. Passing that role name as `model` lets the product pick the first candidate that exists in the native model scope.

```json
{
  "roles": {
    "fast": ["provider/light-model"],
    "strong": ["provider/strong-model-a", "provider/strong-model-b"],
    "diverse": ["provider/model-a", "provider/model-b", "provider/model-c"]
  }
}
```

A role resolves only through its declared candidates. When none is available the call fails with the candidate list. It does not fall back to a default model, and the product never scores or guesses a model from names, context length, or output limits. The result reports `resolvedModel`, `modelRole`, `roleCandidates`, `resolvedThinking`, `modelSource`, and the worker's `actualModel`, so the caller can confirm what the worker ran.

An unconfigured name is treated as an explicit `provider/model` reference and fails its format or availability check. `roles.diverse` is reserved for fan-out: with `model: "diverse"` on `tasks` or `chain`, each task receives a different available candidate. If the number of distinct available candidates is smaller than the task count, the tool refuses to run instead of repeating one model across a panel. A single-task call with `model: "diverse"` fails for the same reason. A diverse panel requires at least two tasks and cannot mix diverse selection with explicit models. Provider and routing prefixes are ignored when comparing terminal model names. This rejects aliases with the same model name; it cannot verify an opaque gateway\'s upstream implementation.

The native `reasoning` object has optional `enabled`, `effort`, and `budgetTokens` fields. An explicit preference must be supported by the selected model and represented losslessly by the current Pi worker transport. Supported effort values map to CLI thinking levels. Unsupported values, conflicting fields, and empty preferences fail. `budgetTokens` and toggle-only `{ enabled: true }` fail because this transport cannot represent them losslessly. They do not silently select another effort or the model default.

When `reasoning` is omitted, a saved subagent reasoning transport can apply if it is valid and bound to the selected model. Otherwise the worker uses the model default. Omission does not copy the parent's effort.

The schema lives in [shared.ts](../src/main/capabilities/subagent/shared.ts) and is wired into the Durable tools in [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts). Selection, role resolution, and diverse assignment live in [selection.ts](../src/main/capabilities/subagent/selection.ts). Native preference validation lives in [subagent-model-config.ts](../src/shared/subagent-model-config.ts).

## Subagent execution settings

Open **Settings → Models → Subagent execution limits**. These controls save to `~/.mybuddy/subagent.json` and apply to subsequent runs without restarting the app. A running app built before these controls were introduced needs a normal restart into the updated build.

- **Limit subagent models** intersects the checked list with enabled models in the app and workspace. An unset `allowedModels` permits every model in that scope; `[]` blocks all subagents. The limit applies to explicit choices, parent inheritance, role defaults, role candidates, and diverse panels. Workers recheck it before requests. The default-model dropdown alone is not a model restriction.
- **Role candidates** edits the ordered `roles` lists. A provider error ends the run; it does not try a different candidate. `diverse` requires enough distinct allowed models for the panel.
- **Total run limit in seconds** stores `timeoutMs`. The default is 600 seconds, and valid settings range from 1 to 3600 seconds. The limit starts when the ready worker receives its task and includes model calls and tool execution. It is not an idle timeout and does not reset on progress.
- **Fixed at this value** is the default `timeoutPolicy`. It ignores per-call `timeout_ms`. **Callers may override each run** stores `allow-override` and permits that parameter to replace the configured duration. Each result reports `timeoutMs` and `timeoutSource`.

Settings saves submit only changed fields, reject stale revisions, and atomically replace the file. Invalid configuration fails explicitly instead of removing restrictions. A runtime worker crash returns a bounded, redacted stderr tail with its exit code. API errors, cancellations, and timeouts remain distinct results.

The shared contract is [subagent-execution-policy.ts](../src/shared/subagent-execution-policy.ts). [subagent-settings-test.ts](../scripts/subagent-settings-test.ts) checks selection and duration policy. [validate-subagent-settings-package.cjs](../scripts/validate-subagent-settings-package.cjs) drives the actual packaged settings page, saves and reloads controls, rejects stale writes, and verifies real worker requests against a local provider.

## Subagent workspace isolation

`isolation` accepts these values.

- `auto` is the default. It isolates only a dispatch that can run more than one concurrent writer: a `tasks` dispatch whose items have write-capable tools and that resolves to more than one runnable item with `maxConcurrency` above one. Every other dispatch uses the supplied working directory. That covers a single task, a `chain`, a read-only toolset, a `tasks` array with one item, one runnable item after the others were rejected, and `maxConcurrency=1`.
- `worktree` requests a separate Git worktree even for a single task or chain step, only when the task toolset and repository policy permit it. Read-only coding tags or repository rules can reject explicit isolation; `auto` keeps the shared directory in those cases.
- `shared` explicitly uses the supplied working directory. Parallel workers can then change the same files.

The isolation decision is made once, while the dispatch is planned, and each child then runs exactly that decision. It counts only items that resolved to a usable role, model, and toolset, so a rejected item neither forces nor prevents a worktree for its peers. A dispatch that an earlier release started replays under that release's isolation rule, so a resumed child keeps the workspace it already prepared. The result states the decision: an isolated task reports `Retained worktree:`, and a task in the supplied directory reports `Workspace: shared (<cwd>); <reason>`. The reason is also available in the tool details as `isolationNote`. It explains the resolution instead of announcing a degraded run:

- A single task: `isolation:auto does not isolate a single task; writes land in the original directory`.
- A `chain`: `isolation:auto does not isolate chain steps; each step writes to the original directory`.
- A read-only toolset: `isolation:auto keeps the supplied directory because the toolset is read-only`.
- A `tasks` dispatch that runs one child, because the array has one item or the other items were rejected: `isolation:auto does not isolate a dispatch that runs one child; writes land in the original directory`.
- An effective concurrency of one: `isolation:auto needs more than one concurrent writer; maxConcurrency=1 keeps the supplied directory`.
- An explicit `shared`: `isolation:"shared" was selected; writes land in the original directory, not an isolated copy`.

When the caller passes `isolation:"auto"` explicitly and that dispatch does not isolate, the line ends with `isolation:"auto" has no isolation effect here; pass isolation:"worktree" to force a separate worktree.` Use `worktree` when a separate working tree is required and permitted by the task toolset and repository policy; `auto` does not create one for those dispatches.

Worktree creation requires a Git repository with a committed `HEAD` and a clean working tree, including untracked files. The tool does not commit, stash, or snapshot dirty input. This precondition is checked before any child starts. In a `tasks` or `chain` dispatch, an item that cannot be isolated is rejected before start without creating a child: the other `tasks` items still run, and a `chain` stops at that step. A single-task call fails as a whole. A task started from a repository subdirectory keeps that relative directory inside its worktree.

Worktrees use separate branches based on the source commit. Their files and branches remain after completion, failure, or cancellation. The tool does not automatically merge or delete them. Result text and details contain workspace information and the receipt path. A receipt records the source repository, base commit, branch, worktree paths, and provisioning state. A failed provisioning attempt reports retained paths when allocation has occurred. A `ready` receipt describes workspace provisioning, not task completion.

`subagent_list` lists active workers. `subagent_steer` guides active work without changing the selected model. Completed worktree artifacts remain accessible through their receipts rather than through the active-worker list.

Workspace creation and receipts live in [worktree.ts](../src/main/capabilities/subagent/worktree.ts). Dispatch, execution, and results run as durable child conversations in [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts). The trusted Pi entry is [worker-launcher.mjs](../src/main/capabilities/subagent/worker-launcher.mjs).

## Subagent concurrency, write conflicts, and timeouts

These limits belong to the whole subagent runtime and are not per-call options. The result reports how every item ended.

- **Concurrency.** The product accepts up to 200 tasks per dispatch and runs up to 100 workers at once. These are product defaults, not provider quotas. A dispatch uses a rolling pool: up to `maxConcurrency` children run at once, a finished child frees its slot immediately so the next waiting item starts without waiting for the rest of a batch, and the `Concurrency:` line reports how many items are waiting for a slot. Set `maxConcurrency` in `~/.mybuddy/subagent.json` to run fewer workers at once; the setting can only lower the product default and cannot raise it.
- **Provider concurrency quota.** The upstream provider may enforce a lower membership concurrency quota, for example 10 for a given plan. The product does not know that quota, so requests above it fail with HTTP 400 `tier_limit_exceeded` / `membership concurrency limit exceeded`, not with 429. Set `maxConcurrency` below the provider quota to avoid the rejection. After the pool has drained, each affected item is retried once, serially, under a new request id and inside the original deadline; the retry is not guaranteed to succeed across a provider quota window. A recovered item is reported with its final outcome, the header adds `<n> recovered after provider concurrency limit`, and its diagnostics include `retried after provider concurrency rejection (attempt 2)`.
- **Result reporting.** A `tasks` dispatch reports `Parallel: <clean>/<total> succeeded (...)` and, when at least one item actually runs, a second line `Concurrency: <workers> worker(s), <queued> queued (maxConcurrency <max>)`; an all-rejected batch has no pool to describe and omits that line. `total` is every item in that dispatch, including rejected ones. `succeeded` counts clean completions only. The parenthesized segments appear only when they apply, joined with `; `: `<n> blocked by write conflict: parallel subagents must write different files`, `<n> rejected before start`, `<n> recovered after provider concurrency limit`. The `Concurrency:` line writes `no queue` when no item is waiting, so a raised cap is distinguishable from queued work. Each item then has its own block headed `### [<agent>] completed|failed|blocked|rejected (id: <id>)`, where a failure appends its stop reason, for example `failed (error)`; a `chain` uses `Step <n>: [<agent>] <status> (id: <id>)`. A single-task result and a `chain` have no `Parallel:` or `Concurrency:` line. Tool details carry `mode`, `agentScope`, `projectAgentsDir`, `concurrency: { workers, queued, maxConcurrency }`, and one result per item. `isError` is true when any item is not a clean completion.
- **Per-item rejection.** Item-scoped configuration errors reject that item only: an unknown agent, a `cwd` outside the task workspace, an unavailable or settings-blocked model, and a failed isolation preflight. No child conversation is created for it. Its block reports the reason, and the details record `status: "error"`, `exitCode: 1`, and `rejected: true`. The valid items still run and report their own results. A single-task call fails as a whole instead, and in a `chain` a rejected step stops the remaining steps, with the result naming the step that stopped.
- **Write conflicts.** Concurrent writes to the same file are not supported and there is no compare-and-swap: `write` carries only `{ path, content }`. A parallel dispatch with more than one worker therefore guards `write` and `edit` per dispatch: the first worker to write a path owns it for the rest of that dispatch, and any other worker writing the same path is blocked with an explicit conflict error that names the path, both worker ids, and the fix. The blocked write is not performed, so no content is silently lost. The affected item is reported as `blocked` rather than `completed` and does not count in `succeeded`: the header says `<n> blocked by write conflict: ...`, its diagnostics keep the `write conflict blocked: <path> already written by <id> (<tool>)` line, and the details keep its durable status `completed` plus a `writeConflicts` array with one entry per blocked write. `isError` is true. A single task and `chain` steps are not guarded, because a later step may legitimately rewrite an earlier step's file. Writes that go through `bash` or `powershell` bypass the guard, and parallel workers that each got their own worktree write different paths, so they never conflict. The guard is [write-conflict.ts](../src/main/capabilities/subagent/write-conflict.ts); dispatch-time ownership is registered in [DurableSubagents.ts](../src/main/agent/durable/DurableSubagents.ts) and enforced from the tool hook in [AgentService.ts](../src/main/agent/AgentService.ts).
- **Isolation.** `auto` isolates only a dispatch that can run more than one concurrent writer: a parallel `tasks` dispatch with write-capable tools and an effective concurrency above one. A single task, a `chain`, a read-only toolset, a one-item `tasks` array, a dispatch that ends up with one runnable item, and `maxConcurrency=1` use the supplied working directory, and their result says why. `worktree` requests a separate worktree for an eligible task; read-only coding tags or repository rules that forbid worktrees reject this explicit request, while `auto` keeps the shared directory. Isolation prerequisites are checked before any child starts: a non-Git directory or a dirty tree, including untracked files, fails explicitly and never degrades silently to the shared directory. Under `auto` that check applies only to the dispatches auto isolates. Choose `shared` deliberately when the working directory is not a clean Git repository. The evidence lines are listed under Subagent workspace isolation above.
- **Timeouts.** With the default `timeoutPolicy: "fixed"`, a per-call `timeout_ms` is ignored and not rejected; the configured duration applies. Diagnostics still identify the request and the effective value: `timeout_ms=<n> ignored: fixed policy (<m>s settings)`, plus `timeoutMs` and `timeoutSource: "settings"`, with the evidence line `Run time limit: <m>s (settings)`. That call does not test a `timeout_ms` override; to test one, switch the policy: open **Settings → Models → Subagent execution limits** and change **Fixed at this value** to **Callers may override each run**, then pass a valid `timeout_ms` (1 to 3600 seconds) to a slow task. The run then reports `timeoutSource: "invocation"` and `Run time limit: <n>s (invocation)`; a run that exceeds the limit ends with `status: "timedout"`, `exitCode: 1`, and `isError: true`. The deadline is set when the child conversation is created, so steering does not extend it.

## Skill policy needles

Mode, project, and tag skill policies separate hard lists from ranking lists.

- `hide` and `allow` match skill identity only. A needle matches when it equals the skill `id`, `name`, or `command`, case-insensitive after trimming. A short list word cannot become a substring rule, so `allow: ["bro"]` no longer admits `ego-browser` through its description.
- `prefer` and `demote` keep the historical ranking semantics: identity first, then a case-insensitive substring over `id`, `name`, `command`, and `description`.
- Any needle may opt into substring matching with the `keyword:` prefix. `keyword:arch` matches `archify`; a bare `arch` does not. Stored policies that relied on the old implicit substring behavior in `hide` or `allow` must be rewritten as `keyword:<needle>`; nothing converts them silently.

The main-process decision and the renderer `+` menu read the same functions. Hard lists use `matchesSkillIdentityNeedles`, ranking uses `matchesSkillPolicyNeedles`, both in [runtime-policy.ts](../src/shared/runtime-policy.ts). The UI filter is [mode-access-filter.ts](../src/shared/mode-access-filter.ts); the catalog text and skill filtering are in [SkillPolicy.ts](../src/main/agent/SkillPolicy.ts).

## Other pstack capability mappings

These tools are registered conditionally. Their presence depends on the configured capability and service availability.

- `skill_authoring_assess(intent, model_id?)` assesses whether to create, reuse, improve, or avoid a skill. It does not write files. `skill_authoring_create(intent, force_create?, model_id?)` runs the creation gate again and installs a new skill disabled by default. `force_create` requires an explicit user request to bypass the gate.
- `ui_exec` observes and operates MyBuddy's own interface, embedded browser, and Artifact pages through Electron input events. `browser_exec` operates MyBuddy's browser through enumerated actions, including `evaluate`, `listen`, and `fetch`. `evaluate` runs against an isolated DOM copy, not arbitrary JavaScript in the live page; supported writes to an observed ordinary text field are applied through native `fill`. Event subscriptions and same-origin reads use their defined contracts. `ui_exec` does not expose arbitrary page JavaScript.
- `runtime_probe` reads bounded runtime evidence, including console events, exceptions, navigation failures, renderer exits, focus, and document state. It does not modify product state.
- `execute_code` runs one-shot code in the task directory when code execution is enabled and native execution has not replaced this tool. It supports JavaScript, managed Python, shell, and PowerShell on supported platforms. JavaScript uses Node ESM. Python script mode accepts scripts in task or skill directories and uses the managed runtime.

The registration conditions, schemas, and descriptions are in [builtin-capability-extension.ts](../src/main/capabilities/builtin-capability-extension.ts).

`automation_exec` provides local task-owned scheduling with create, list, runs, pause, resume, and cancel. It reuses CronService and SQLite run history. Targets distinguish continuing the current task from creating a new task. The current task keeps its model, permissions, workspace, and conversation. New tasks follow the normal task-workspace resolver. Intervals such as `90s` are elapsed durations, not converted calendar expressions. Busy targets skip a tick without queueing. Quotas and deadlines stop future runs. Restart policy either resumes future ticks without catch-up or pauses the job. Cancellation stops future starts, not a turn already in progress.

`terminal_exec` provides open, list, read, input, resize, and close for model-owned PTYs. Generated terminal IDs and session IDs bind every operation to its source task. Reads return the ANSI-parsed screen, cursor, size, and exit state. A bounded literal wait reports matched, timeout, or exited. Each task can own four active terminals. Stopping the task cleans its model terminals without closing user terminals. The terminal capability flag and permission policy apply.

The tools appear only when the application has registered their services. An older running process does not gain them through a skill edit. Scheduling requires the local application to remain running. There is no execution while the application is closed or the machine is asleep. Neither local scheduling nor a worktree provides Cursor cloud execution. Do not substitute a long shell sleep for persistent scheduling.

A GitHub MCP configured as read-only remains read-only. A skill cannot grant it write access. GitHub writes through `gh` require an available CLI, suitable authentication, and authorization for the requested write. This reference does not assert that `gh` is installed or authenticated.

## Relevant test scripts

These scripts define the corresponding checks. This reference does not report an execution result.

- [subagent-selection-test.ts](../scripts/subagent-selection-test.ts) covers explicit model rejection, parent selection, configured fallback, and native reasoning constraints.
- [subagent-worktree-test.ts](../scripts/subagent-worktree-test.ts) covers workspace isolation and retained provisioning receipts.
- [durable-subagent-test.ts](../scripts/durable-subagent-test.ts) runs Durable child conversations against a local fixture provider. It covers child identity, model, display name, bound cwd, restart reattachment, and completed-effect reuse; the `Parallel:` and `Concurrency:` header lines with per-item status; the rolling pool; dispatch-time isolation preflight, one rejected item among valid ones, and a lone surviving item staying in the supplied directory; blocked-write counting; a provider quota rejection recovered by one deferred retry; the ignored `timeout_ms` diagnostic and an `allow-override` run that ends `timedout`; and `chain` steps, including a rejected step that stops the chain after the steps before it keep their results.
- [subagent-write-conflict-test.ts](../scripts/subagent-write-conflict-test.ts) covers the write guard directly: path claims, cross-child `write` and `edit` conflicts, repeated writes by the same child, different paths and working directories, and the hook entry that production installs.
- [subagent-model-ui-test.ts](../scripts/subagent-model-ui-test.ts) covers saved native preferences and CLI transport limits.
- [cron-scheduling-test.ts](../scripts/cron-scheduling-test.ts) covers real SQLite, timers, cancellation races, quotas, deadlines, restart policy, and task scope with a fixture agent.
- [local-workflow-integration-test.ts](../scripts/local-workflow-integration-test.ts) executes a real timed AgentService and Pi session against a local HTTP fixture provider. It verifies tool registration, permissions, persisted output, and the authoritative task directory.
- [task-terminal-live-test.ts](../scripts/task-terminal-live-test.ts) drives a real TUI and checks screen rendering, input, resize, Ctrl-C, exit, active child cleanup, and preservation of a separate user terminal. Windows and Linux require separate executions.
- [validate-local-workflow-package.cjs](../scripts/validate-local-workflow-package.cjs) starts the actual packaged app with an isolated profile. Its local provider calls the real terminal and scheduling tools, then verifies scheduled continuation and the Automation page.

The script commands are declared in [package.json](../package.json).
