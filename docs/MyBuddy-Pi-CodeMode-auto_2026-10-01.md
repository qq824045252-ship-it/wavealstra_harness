# MyBuddy · Pi Code Mode 按场景自动启用验收

记录时间（UTC）：2026-10-01T10:14:14.120Z

## 功能结果

代码开发 coding 自动启用 Pi 原生 Code Mode，使用 mode=on，保留原生直接工具调用；models=false 保持不变。日常办公 working 和设计创意 design 不注册 Code Mode，但始终保留 Pi 原生 tool_search。普通办公、设计仍可发现并直接调用 MCP 工具。

欢迎页和聊天顶部显示 Pi Code Mode 状态。代码场景尚未建立原生会话时显示“待启用”；绑定后读取 session.getActiveToolNames()，真实激活才显示“已启用”。办公和设计显示“未启用”。标识为只读状态，不启动工具、不调用模型、不增加 MyBuddy 执行控制层。

## 修复的缺陷与处理

| 问题 | 处理 |
|---|---|
| 缺失场景在发送、恢复、远程请求、显示等位置回退为 coding | 统一 DEFAULT_WELCOME_MODE=working；入口使用 resolveWelcomeMode；明确保存的 coding/design 不改写 |
| 单纯注册 createCodemodeExtension(mode=on) 不保证实际激活 | 通过已有工具装配边界调用 Pi 原生 setActiveToolsByName；配置重载后仍保持激活，无 MCP 或 MCP 禁用也可使用 |
| 关闭 Code Mode 后 codemode-only MCP 会失去入口 | 会话级配置投影将 codemode exposure 映射为 deferred，关闭 autoEnableCodemode；保留 direct/hidden，不修改用户 mcp.json |
| 新建任务继承代码场景 | 新任务重置为默认 working 和通用办公 preset；明确选择代码/设计后仍正常使用 |
| 界面可能把管理会话状态当作当前任务状态 | 查询和订阅均按真实 taskId 过滤，丢弃其他任务与 mcp-headless 快照 |
| 初始快照迟到覆盖新会话事件、卸载后写入 | 订阅先于读取；事件版本和卸载标记防竞态；会话释放后取消“已启用”标识 |
| preload 类型声明未体现后端已经支持的 taskId | 修正 status(taskId?) 类型契约，实际读取当前任务 |
| 未结束的 Pi 会话被重新标记为新场景 | 仅空闲会话才允许更新绑定场景；不在流式执行中改工具环境 |

设置只决定工具是否提供给当前场景，不判断任务复杂度，不干预 Pi 内部选择直接调用还是脚本编排，也不在结束后追加继续消息。原有审批、只读、目录隔离、模型范围和记忆撤销保护保留。

## 验证

40 个回归套件通过，测试前后源码指纹一致。包含 18 个新功能契约断言、9 个真实已安装 Pi SDK/真实 stdio MCP 场景、8 个生产界面观察器竞态用例。SDK 场景中的 provider 为受控本地实现，与下面的真实模型任务明确区分。

Pi 0.99.2 的 122 个核心 JavaScript 文件与经过完整性校验的官方 npm 发布物逐字节相同；本任务未升级或修改 Pi 核心。

桌面、远程前端类型检查、构建和免安装打包通过。没有把前端编译通过等同于 Android APK 安装或手机真机验收。

### 实际新包中的真实模型任务

| 任务 | 实际保存场景 | 原生 Code Mode 状态 | 结果 |
|---|---|---|---|
| office-default-mcp | working | 未启用 | 通过 |
| coding-mcp | coding | 已启用 | 通过 |
| design-mcp | design | 未启用 | 通过 |
| coding-without-mcp | coding | 已启用 | 通过 |
| office-after-coding | working | 未启用 | 通过 |

每项使用本次随机 nonce/数字，真实工具读取后计算、保存并由测试程序核对文件内容。界面输入、场景按钮、IPC、流式事件、原生工具、数据库场景与会话状态相互核对。五项是不同的真实任务，不通过修改 badge 文案伪造状态。

另有两项真实模型后端请求验证：新任务未传 welcomeMode 时为 working；已有 coding 任务未传字段时保持已保存的 coding。两项都检查实际模型回复和会话文件。

真实模型：commandcode/deepseek/deepseek-v4.1-flash。渲染器未捕获异常 0；退役隐藏控制消息 0。测试配置/凭据均在隔离目录，已清理；没有修改真实用户的邮件、记忆或业务数据。

### 失败记录

首轮实际新包验收发现：临时 defaultTools 覆盖被原生配置重载清除，导致无 MCP 的代码任务未启用 Code Mode；新建任务继承上一代码场景。两处均修复生产代码，并新增配置重载/禁用 MCP 和真实新任务场景回归，重新构建新包。首次实际失败报告保留在 desktop-live-initial/results.json。

初次回归的架构断言将 attachExtensions 的参数文本写死，新增只读状态绑定参数后被触发；更新该契约，保留生命周期所有权断言，重新跑完整套件。原生测试最初误从 context.tools 取声明，已改用 Pi 0.99.2 的 getCurrentTools(messages)，未修改生产执行逻辑来迁就测试。初始报告保留在 regression-initial-results.json、native-before-diagnostics.json 和对应日志中。

## 交付

免安装程序：

    C:\Users\servi\Documents\GitHub\wavealstra_harness\release-pi-codemode-auto-20261001095904811\win-unpacked\MyBuddy.exe

app.asar SHA-256：`36d0e3f14db0494fe9c4effd6245bc3e234f98b34ba842128d3a10256e9692ef`

构建输入指纹：`dbea4baafff42ce928fe544908e471742d621db4e14c71650b9f7c5d7c4ba2a6`

回归源码指纹：`5f8c25932096a3bd3d2845aba2d3f70a84f562476188bfb5b03f7c31afc26809`

交付状态：deployed。已验证新程序运行。

## 可复核记录

artifacts/pi-codemode-auto 下：contract-results.json、native-results.json、ui-observer-results.json、regression-results.json、upstream-core-integrity.json、build-latest.json 指向的 build.json、desktop-live/results.json 及截图、closeout-summary.json。

## 范围

本次是按明确场景设置原生能力和显示真实状态；没有提供“自动/始终/关闭”三态高级开关，没有启用模型分类器，也没有给 Android 前端新增 badge 或安装 APK。既有用户模式提示词、技能和已保存任务场景继续保留。

## Git 记录

本轮代码提交：`8ba96b4dbfdaf9c44e5a5f226f835724cc2a8274`（`feat(codemode): enable native Pi code mode by scene with live status`）。未推送远端。已有的任务元数据同步改动和 mode-preset 测试修改保留，未混入本提交。打包验收基于当时完整工作区，以上构建输入指纹可用于核对。
