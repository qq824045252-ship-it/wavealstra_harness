# pstack / MyBuddy 当前进度核查

核查依据：当前工作区、Git 状态、本机已安装技能、源码与 5 项本轮测试。核查未修改产品源码或技能配置。

## 结论

本地工作流的基础设施已实现且已提交至本地 main（d732e27），但已安装技能与模型解析仍存在相互矛盾的旧指令，尚不能视作 pstack 端到端适配完成。Git 状态显示本地 main 比 origin/main 超前 1 个提交；未执行 fetch，不能据此判断远端最新状态。已跟踪文件 artifacts/pi-minimal-mode/contract-results.json 在核查期间显示有修改，归属未知；另有未跟踪文件，未改动或清理。

## 进度

| 项目 | 现状和证据 |
|---|---|
| 定时调度 | src/main/capabilities/local-workflow-extension.ts 已注册 automation_exec，支持任务内调度及继续当前任务；应用关闭或休眠不执行。test:cron-scheduling 和 test:local-workflow 本轮通过，后者采用本地 fixture 模型。 |
| 交互终端 | 同文件已有 terminal_exec，任务独占、读当前屏幕、输入和调整尺寸。Windows 上 test:task-terminal:live 本轮通过真实 ConPTY TUI 检查；Linux 未验证。 |
| 名单误匹配 | src/shared/runtime-policy.ts 已区分硬名单身份匹配与关键词排序；本轮 test:runtime-skill-loader 81 项通过，包括 bro 与 architect 误匹配回归。 |
| 子代理模型 | 原生支持显式父模型、配置角色和 diverse；本轮 test:subagent-selection 通过。配置角色候选是具体模型，尚不是用户要求的实时动态规则解析。 |
| poteto-agent | 本机 ~/.mybuddy/plugins/agents/poteto-agent.md 存在；本轮只核对文件，未做角色调用验收。 |
| 技能正文 | ~/.mybuddy/plugins/skills/poteto-mode/SKILL.md 已修正显式继承语义，但仍含固定旧默认模型；how、why、interrogate、swarm、reflect、arena 仍有省略 model 即继承或同族回退指令；setup-pstack 仍有旧模型表指令。swarm 与 orchestrate 尚含 cloud 指令，应在 MyBuddy 下明确本地映射。 |
| 模型规则冲突 | ~/.agents/pstack-models.md 已写为原生配置候选；~/.agents/pstack-models-resolve.mjs 仍按名称启发式解析，且两者与用户已确定的实时规则方向不一致。不同 provider 不保证底层模型不同，验收需同时明确 provider 与模型身份约束。 |
| deslop / control-* | 本轮没有完整核验三个技能端到端运行；不能由通用工具存在推定已经适配完成。 |

## 本轮测试

- pnpm -s test:subagent-selection：通过。
- pnpm -s test:cron-scheduling：通过；覆盖真实 SQLite、计时器、90 秒间隔、忙碌、取消、配额、截止和重启等夹具。
- pnpm -s test:local-workflow：通过；真实 AgentService/Pi 会话、计时器与本地 HTTP fixture 模型，不是在线提供商验证。
- pnpm -s test:task-terminal:live：通过；Windows 真实 ConPTY 输入、读屏、resize、Ctrl-C、退出和终端归属清理。
- pnpm -s test:runtime-skill-loader：81 通过，0 失败。

首次误输 test:task-terminal-live 返回命令不存在，随后按 package.json 使用 test:task-terminal:live 成功。

## 尚未验证

运行中的 MyBuddy 是否加载最新源码、在线多模型实际调用、真实 PR 周期巡检、Linux PTY、三个 Cursor 技能完整映射、全面 typecheck 和完整门禁均未在本轮验收。计划文件 .audit/pstack-native-plan.md 的未勾选项为历史记录，与当前源码不完全同步。
