# MyBuddy · Pi 原生运行链收敛验收

> 后续：本记录的原生性证据主要覆盖 Pi 循环与会话；2026-10-02 已完成四核心工具原生化并增加最终 execute 来源验收，见 [新记录](MyBuddy-Pi-native-core-tools_2026-10-02.md)。

> 后续更正：宿主控制遗漏（2026-10-01）。本记录有关宿主执行控制收敛的结论存在遗漏，后续发现了 MCP 计划状态门禁及网页后台唤醒路径。修复和新包验收见 `MyBuddy-Pi-host-control-exit_2026-10-01.md`。本记录保留为历史，不代替新包证据。

验收记录生成：2026-09-30T23:12:16.068Z。下述结论绑定实际源码指纹和已测试免安装包，不借用旧版结果。

## 结论

删除 MyBuddy 的自动任务分类、复杂度评分、强制计划、结束门禁、隐藏自动续跑、文本伪工具恢复和“新 steer 覆盖旧 steer”逻辑。模型调用循环、工具后的后续运行、重试、队列消费与最终结束由 Pi 0.99.1 决定。MyBuddy 保留界面、产品数据、权限边界和事件投影。

不是“把自动续跑次数调低”，也没有新加防循环算法来代替旧算法。

## 已删除／改接

- 删除 `ExecutionRouter.ts` 与 `ExecutionIntentAnalyzer.ts`。
- 删除 Completion Gate 的 settle/continuation/stall 计数及隐藏 follow-up 注入。旧数据库列保留兼容存储，但不再暴露或驱动执行。
- 删除在 agent_end 等待伪造 request_user_input 文本、再追加继续消息的恢复链。真正的用户输入工具保留并支持原生取消。
- 结束投影改接 Pi 的 agent_settled；agent_end 不再提前宣告整次运行结束，失败工具也不被错误提升为模型连接失败。
- 用户 steer/follow-up 及时交给 Pi；不清空重建 Pi 队列，不以自建“最新引导胜出”覆盖前一条输入。
- 旧会话中的精确类型自建控制消息仅在请求投影时剔除；不改写 Pi 的 append-only JSONL。旧交互的真实用户答案仍保留。
- 明示 Bash 工具的真实 shell 和退出码语义；界面区分工具执行、等待用户、重试、压缩与模型响应，不用“思考中”掩盖工具等待。

## 原生性证据

直接从 npm 公布的固定 0.99.1 发布物取样并验证 tarball integrity，再比较已安装文件。pi-agent-core 的 117 个 JavaScript 文件与 pi-coding-agent 的 5 个会话／状态核心文件，共 **122 个，逐字节一致**。报告：`artifacts/pi-native-control/upstream-core-integrity.json`。

保留的本地补丁仍涉及 provider reasoning 事件别名兼容、MCP 主机接口和 Codemode Worker 打包路径；不将“原生运行链”混同为“所有依赖完全没有本地补丁”。

## 最终包真实模型测试

使用现有 provider 的真实模型，在隔离用户目录、随机测试数据和真实打包桌面中，经输入框、IPC、Pi、MCP／Bash／Worker、流式事件及历史回读完成。

| 测试 | 结果 | 实测耗时 |
|---|---|---:|
| 真实仓库文件清单、统计、写入及回读 | 通过 | 22.6 秒 |
| 本次随机输入解析、计算、写入及回读 | 通过 | 12.3 秒 |
| 真实失败 → 修复输入 → 同一验证器复测 | 通过 | 27.5 秒 |
| 显式调用原生 Pi Worker 并核对真实结果 | 通过 | 19.4 秒 |
| 自然语言列目录，不扩大为递归容量扫描 | 通过 | 8.3 秒 |
| 文件不存在时如实报告并结束 | 通过 | 8.3 秒 |
| 真实命令超时，只执行一次后结束 | 通过 | 11.4 秒 |
| 原生退出码 7 保持工具错误，不强制续跑 | 通过 | 8.3 秒 |

失败恢复用同一个未被修改的验证器核对第一次退出 7、修复后退出 0；超时及非零退出测试核对实际仅执行一次。8 条用户消息对应的会话审计中，退役的隐藏控制消息为 0；渲染器未捕获异常为 0。

报告：`artifacts/pi-native-control/desktop-live/results.json`。每项带实际工具调用、流式计数、结果核验及截图。

## 其它回归

- 核心／外围／安全三组共 17 个套件通过，远程访问额外 1 个套件通过。
- 控制边界 14 项通过；原生 AgentSession 生命周期 6 项通过，覆盖原生重试、工具等待、多个 steer 加 follow-up、取消、普通结束、伪输入文本。
- 原生 Bash/read/edit 的 4 组执行测试通过，包含失败恢复、52 次读取后验证、权限拒绝与实际 shell 退出码语义。
- 架构回归 321 个断言通过。
- 桌面与远程前端 typecheck、构建、免安装打包通过。

记录：`core-regression.json`、`peripheral-regression.json`、`safety-regression.json`、`native-lifecycle-results.json`、`contract-results.json`、`remote-access-results.json`，均位于 `artifacts/pi-native-control/`。旧失败记录保留，修复前控制契约曾有失败，未删除失败证据来冒充一次通过。

## 交付与回退

当前执行文件：

    C:\Users\servi\Documents\GitHub\wavealstra_harness\release-native-pi-20260930161214934\win-unpacked\MyBuddy.exe

桌面原有 MyBuddy 快捷方式已切换；实际主进程 PID 25208 的路径已核对，窗口已独立确认可见。远程 3352 端口由新进程监听，`GET /healthz` 返回 200。

切换前确认无本次进程启动后的运行记录或有效租约。旧实例关闭窗口后留在托盘；一致性备份并通过 SQLite quick_check 后结束空闲旧实例，再启动新实例。未并行启动两份用户数据写入实例。

旧快捷方式备份：

    C:\Users\servi\Documents\GitHub\wavealstra_harness\artifacts\pi-native-control\MyBuddy-shortcut-before.lnk

SQLite 一致性备份（留在本机私有目录，不提交到仓库）：

    C:\Users\servi\.mybuddy\backups\native-pi-cutover-20260930230839336\app.db

旧包保留。未提交或推送 Git。此前存在的安卓 Markdown、表格样式等未提交改动未回滚。

## 验收边界

本次消除了已定位的 MyBuddy 自建运行控制及结束事件错位；不保证任何模型、provider 或工具永不重复、断连、超时。发生此类情况仍应查看原生事件和工具结果，而不是再加隐藏强制续跑。安卓共用的主进程已更新，前端已构建／回归，但本任务没有重新安装手机 APK或做真机界面验收。

## 指纹

源码 SHA-256：`66e9af63ddb49567b9ade82d35235ce0458a3cb94f1efc5de79a8c83baa77a72`

打包 app.asar SHA-256：`b3edf8474b7b12eb6573df09158c86f6a9d86505b96fa699bbcab538e3cf9f8b`

结构化总记录：`artifacts/pi-native-control/closeout-summary.json`。
