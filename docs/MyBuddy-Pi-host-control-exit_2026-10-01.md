# MyBuddy · Pi 宿主执行控制退出验收

> 后续：2026-10-02 已进一步移除本记录保留的四核心工具覆盖、强制验证、隔离钩子和自动备份，见 [四核心原生化记录](MyBuddy-Pi-native-core-tools_2026-10-02.md)。本文件保留当时的迁移边界和历史验收证据。

记录时间（UTC）：2026-10-01T06:27:28.707Z

## 结论与边界

删除 MyBuddy 用外围计划状态阻止 Pi 工具执行、用独立验收汇总判定任务完成、后台结果与超时自动唤醒主模型的路径。没有以次数上限、风险评分、自动监督器或另一套防循环算法替代它们。

保留用户授权、只读模式、任务目录隔离、真实文件读回验证、用户显式选择的模型范围、请求取消、Memory 范围/撤销保护、界面和审计。用户编辑的模式提示词、技能和长期记忆仍然能影响模型；“退出宿主执行控制”不等于清除用户配置或让工具越权。

## 全库审查范围

扫描 src、app、fronts、shared 下 719 个源码文件（199786 行），建立 21 个原生事件钩子、86 个相关方法调用位置的清单，再人工审查实际执行相关调用链。它不是对每行代码都进行形式化证明的声明。磁盘 Pi Extension discovery 仍为 noExtensions=true；产品能力只通过编译内置的 extensionFactories 加载。

### 实际删除与改接

| 链路 | 处理 |
|---|---|
| AgentService → SessionExtensionAssembler → MCP tool_call | 删除 preflightSideEffectGate 类型、回调、装配和 block 分支；approved、completed、blocked 等计划记录状态不再决定 MCP 能否执行 |
| 可选计划工具 | 删除先 start 才能更新步骤/验证、执行中不许改计划、终态不许更新记录等人为流程前置条件 |
| 独立完成判定 | 删除 ExecutionAttemptRepository.gateReasons、requiredForCompletion 和计划服务的审计汇总注入；保留真实工具错误与审计事实 |
| 网页搜索后台抓取 | 删除 pendingFetches/startBackgroundFetch 及后台完成后 triggerTurn；请求正文时在原生工具调用内 await，并传播 AbortSignal |
| 策展器超时与状态命令 | 超时不代表用户同意；/curator 与 /google-account 只通知 UI，不调用模型 |
| 用户明确提交搜索选择 | 保留唯一的主动提交入口，由实际 onSubmit 调用；结束/取消后不得迟到提交 |
| 显式用户审批 | native 与 MCP 子工具统一检查真实待批准授权；模型改计划状态不能替用户授予许可 |

旧 ExecutionRouter / ExecutionIntentAnalyzer 仍不存在。主循环、工具后的模型请求、原生重试、队列消费和结束事件不由本次新增脚本接管；新增脚本均为开发期测试、审计或打包，不进入生产执行链。

## 验证结果

- 最终 57 个回归套件全部通过，覆盖执行生命周期、重新生成、会话树、权限、真实读回、Memory、压缩、模型流与远程访问；前后源码指纹一致。
- 31 项控制边界用例通过；修复前失败报告保留在 contract-before.json。
- 16 项真实已安装 Pi AgentSession/工具钩子及生产搜索函数集成用例通过。局部 provider 是受控测试实现，不混称真实付费模型。
- 10 项真实配置模型、实际新打包桌面、输入框/IPC/流式 UI/原生 MCP/文件读回任务全部通过。
- 122 个已安装 Pi 0.99.2 核心 JavaScript 文件与校验完整性的官方 npm 发布物逐字节一致；不声称所有外围 provider/host/打包适配补丁均已移除。
- 打包产物再次检查 6 个退役符号均不存在，不以源码检索代替二进制检查。

### 新包真实模型任务

| 任务 | 结果 |
|---|---|
| approved-plan-does-not-gate-mcp | 通过 |
| completed-plan-does-not-gate-mcp | 通过 |
| repository-inventory | 通过 |
| unseen-input-transform | 通过 |
| real-shell-failure-and-repair | 通过 |
| native-subagent | 通过 |
| natural-directory-listing | 通过 |
| missing-file-stops-with-honest-blocker | 通过 |
| native-tool-timeout-no-forced-retry | 通过 |
| native-nonzero-tool-error | 通过 |

真实会话中的退役隐藏控制消息为 0；渲染器未捕获异常为 0；隔离测试使用的临时配置与凭据已清理。测试不修改用户真实记忆、邮件、云端文件或业务数据库。

## 验收中更正的旧测试

Pi 0.99.2 的 user-only 分支会持久化，旧“未落盘”断言已按实际原生契约修正；事件映射测试改为保持同一上下文直至 agent_settled；技能治理 fixture 改为显式刷新候选并遵守原生已接受请求的 preflight 回调语义。原生取消 fixture 在已取消的 provider 边界禁止有效请求，而不是用忽略 AbortSignal 的假 provider 宣称仍在运行。没有通过恢复旧宿主控制使旧断言通过。

## 产物与交付状态

免安装执行文件：

    C:\Users\servi\Documents\GitHub\wavealstra_harness\release-pi-host-exit-20261001061441265\win-unpacked\MyBuddy.exe

app.asar SHA-256：`85b6fe322d0f328b46032d89434db505fa2859c18cb1b96230998a68526c3a38`

构建输入指纹：`d311dbfe9408e8eb87fa21ed48da739657c5b863d9df1b174457e33bb22c6122`

全库审查指纹：`a808f9123b3c7fe377613ce51dfa53a99ddb7df9afe63bfc37e07af6cc55ddff`

交付状态：packaged-only。本记录不声称已关闭或替换用户正在运行的实例。

## 可复核记录

首次真实桌面验收中，9 项通过，1 项把未执行的参数校验失败计入写入次数；后续改用工具可见工作区之外的服务端写入审计，重跑全部 10 项。首次失败记录保留在 desktop-live-initial/results.json，没有改写成通过。

全部位于 artifacts/pi-host-exit：source-boundary-audit.json、contract-before.json、contract-results.json、native-integration-results.json、regression-initial-results.json、regression-results.json、upstream-core-integrity.json、build-latest.json 指向的 build.json、desktop-live/results.json 与 closeout-summary.json。

## 不夸大的结论

本次确认所审查的 MyBuddy 执行控制与自动唤醒路径已经退出，并在所列边界和真实任务上验证。模型仍可能自行重复工具、工具仍可能超时、用户提示词仍可能要求继续验证；这些不能被包装为“任何任务永不重复”的保证。出现新问题应依原生事件与工具结果定位，不重新加入隐藏强制续跑。

## Git 交付

代码与回归工具提交：`e104857c7b201ccda61bfc859ed16e0e1bdaa911`（`fix(runtime): remove host execution gates and hidden continuation`）。未执行远端推送。另一个任务的界面修改和临时工作副本未混入此提交。
