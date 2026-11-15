# Bot 模式核对记录与验收补强

## 基准和范围

本次重新读取并基于 `main` 的 `b2fdcf083cb0338046248bbc30752b4b218ba4aa` 实施，保留 #57 的来源读取、通知投递与共享调度隔离改动，也保留原回复内的任务阶段与原输入框。

改动解决四件事：

1. **架构规则实际覆盖共享包。** `architecture-graph-test.ts` 原有规则认识 `shared/src`，扫描入口却没有包含它。现在把共享包纳入扫描，并以真实临时源码夹具验证合法导入、非法反向导入、运行期环、类型环、缺失引用和语法错误。没有修改基线或放宽阈值。
2. **结果报告保留核对依据。** 从结果协调器已核对的冻结上下文生成有大小上限的可选快照，与 Work、执行、需求版本、输入快照和负责人代次绑定，随原结果消息保存。结果 UI 中增加默认折叠的“核对记录”，列出已登记的检查项、文件读取情况、证据引用与未检查范围。
3. **并发和回放具有可重现测试。** 新测试直接组合生产消息合并、任务分组和阶段展示函数，以固定随机种子和排列覆盖分页、重复回流、乱序、旧结果、重试、跟踪任务、不同 Bot/团队/会话及独立流式版本。
4. **提供真实开发态桌面验收入口。** 新驱动启动隔离的 `pnpm dev`，设计上通过真实 Electron 控件、preload、IPC 和 SQLite 检查并行任务原回复归属、阶段选择、草稿、焦点、滚动、结果、渲染器重载、主进程重启及新会话隔离。默认只有模型 HTTP 边界使用可控夹具；完整说明见[开发态验收地图](../verification/bot-task-replies.md)。

## 核对记录的含义

快照只展示该次结果核对时保存的事实，不重新打开文件，不新增模型回合、用户要求、审批或执行决策。缺失的旧记录不会被补成“已核对”。

- “已登记核对”要求当前需求版本的满足记录及证据引用；助理建议的检查项单独标明。
- “已读取保存版本”只证明冻结记录中的文本读取和 SHA-256 一致性，不证明内容已达到任务目标。
- 截断、读取失败、摘要变化、空文本、遗漏项和真实环境要求都保留可见说明。
- 旧输入、改计划或失效执行的记录继续可读，但展示为历史记录。
- 每次实际发起核对时，持久化与发送给核对模型相同的时间和恢复标记；复用已保存决策进行投递重试时保留原快照，不刷新时间或重新核对。
- 传输 schema 校验身份，不允许把核对快照挂到阶段进度；不匹配的可选快照被丢弃，原有结果交付仍可进行。
- 文件正文不复制进快照；引用作为文本展示，不执行其中的内容。

## 实际验证

验证环境：Linux，Node `24.22.1`、可用 pnpm `11.25.0`。仓库声明的 pnpm 为 `12.14.0`；本轮使用可用版本完成 frozen-lockfile 安装，未修改依赖、lockfile 或包管理器声明。

| 命令或检查 | 本轮结果 |
| --- | --- |
| `pnpm -s typecheck` | 通过；renderer、main 与 scripts 检查无新增错误，scripts 错误数为 0 |
| `pnpm -s test:architecture-graph` | 7 个共享包夹具和 5/5 项门禁通过；1379 个源文件、5198 条依赖边、0 条未解析内部路径 |
| 架构检查器负向验证 | 在临时构建中恢复漏扫 `shared/src`，夹具以非零状态失败；正式源码不变 |
| `pnpm -s test:bot-work-verification` | 9 组通过，包含真实 completion application / feedback delivery 路径和 React DOM |
| `pnpm -s test:bot-task-reply-sequence` | 240 条可回放轨迹、1548 个中间状态观察通过；额外单种子 `0x51a9c027` 回放通过 |
| `pnpm -s test:bot-task-reply-ui` | 8 组 React DOM 检查通过 |
| `pnpm -s test:bot-task-reply-presentation` | 27 组行为检查通过 |
| `pnpm -s test:bot-task-reply-harness` | 10 组真实 loopback HTTP/WebSocket、模型夹具、CDP 失败处理与隔离检查通过；没有启动 Electron |
| `pnpm -s test:bot-work-phase5-review` | 21 组通过 |
| `pnpm -s test:bot-work-phase5-review-ui` | 19 组通过 |
| `pnpm -s test:bot-work-automatic-completion` | 通过，覆盖自动结果交付、回放、用户补充与未知效果处理 |
| `pnpm -s test:work-result-lifecycle` | 通过，包括截止时间、关闭失败注入、保留清理与所有权等检查；失败注入的日志不是测试失败 |
| `pnpm -s test:work-completion-recovery` | 通过，新增同一证据指纹下的历史恢复/核对时间一致性及缓存决策投递重试检查；原业务执行只有一次 |
| `pnpm -s test:bot-scheduling-gaps` | 通过，含当前 #57 调度与持久来源行为 |
| `pnpm -s test:bot-incoming-timeline` | 通过 |
| `pnpm -s test:bot-workspace` | 通过 |
| `pnpm -s test:all:audit` | 分类检查通过：headless 589、GUI 98、NETWORK 51、DATASET 4、ARTIFACT 3、pending 0；这不是执行全部用例的结果 |
| `git diff --check` 与新增 CJS 语法检查 | 通过 |

## 未完成的桌面验证

实际执行了 `pnpm -s test:bot-task-reply:dev`。当前执行器没有 `DISPLAY` / `WAYLAND_DISPLAY`，并禁止创建 AF_UNIX socket，无法启动可用显示服务。命令按设计以状态码 1 失败，并保存 `status: "failed"` 的诊断报告，`runs` 为空；没有 GUI PASS 或截图。

本轮预检报告的相对路径为 `out/diagnostics/bot-task-replies/2026-11-15T14-27-30-929Z-106017d9f4/report.json`。运行产物不提交到仓库，后续每次运行会生成独立目录。

因此，新增驱动的协议与失败行为已验证，完整 Electron 场景仍需在具备桌面条件的设备执行。React DOM、纯函数序列及 HTTP/CDP 自检不能替代该项。真实模型模式、操作系统原生输入、跨设备行为与发行包也没有在本轮验证。

具备桌面环境后，可直接运行：

```sh
pnpm -s test:bot-task-reply:dev
```

默认夹具不会读取现有用户配置或模型凭据。若显式选择 live 模型模式，按验收地图配置相应环境变量；不能把 fixture 的通过记录当作真实模型推理验收。
