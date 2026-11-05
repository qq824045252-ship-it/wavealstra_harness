# pstack 本地适配执行计划

## 验收边界

仅实现 MyBuddy 本地工作流，不提供 Cursor 云端执行。复用现有 CronService、TerminalHost 和原生模型选择。保留已有未提交变更及用户任务。所有写入在 main，禁止创建分支或 worktree。Windows 实机验证与 Linux 未验证部分分开列示。

## 工作清单

- [x] Read the Principles section of the poteto-mode skill.
- [x] Phase A: Frame
- [x] Phase B: Design the workflow
- [x] Phase C: Run the loop
- [x] 校验并补齐技能硬名单与角色选择，回归测试后进入下一单元。
- [x] 复用 CronService 添加任务归属、当前任务继续、真实间隔、不重入、取消及截止规则，并测试重启行为。
- [x] 复用 TerminalHost 提供任务自有终端工具与真实屏幕，验证 ConPTY 输入、读屏、resize、Ctrl-C 和清理。
- [x] 修正已安装 pstack 的 Harness/playbook 指令，保留原字节备份。
- [x] Phase D: Keep the audit trail
- [x] Phase E: Verify and hand back
- [x] thermos 按严重度审查、typecheck、相关回归、完整 headless 门禁。独立代理审查失败保持可见。
- [x] 补丁版本、main 定向提交及推送、Windows 实际包验收与快捷方式回读。0.1.99 的实现 d732e27 与验收记录 001521f 已推送 origin/main，远端差距为 0/0。实包和两个快捷方式通过回读，当前开发实例未重启。

## 吞吐检查

- Blocking first steps. 已保存入口 diff，main 已快进到 origin/main，原修改全部恢复。先确认已有步骤 1/2，不重复实现。
- Independent workstreams. 调度和终端的只读追踪可并行，capability 注册与 AgentService 接线由父单写者完成。
- Shared mutable state. package.json、共享 DTO、AgentService、主进程组装以及发布串行。禁止代理提交或改无关文件。
- Smallest safe decomposition. 按策略/模型、调度、终端、安装指令与发行包拆分，分别以行为测试收尾。

## 架构检查

- Ground. 追踪存储、调度、任务 admission、能力注册及终端所有权。
- Sketch. 比较服务内扩展与工具外置定时器。后者会产生第二个调度所有者，不采用。
- Agree. 用户已授权执行评估，所有可逆源码修改直接推进。
- Implement. 数据以显式任务目标和归属建模，工具不接受任意其他任务 ID。
- Scrap. 若新增结构重复现有服务职责，删除重复结构。

## 环境事实

入口已有名单与 subagent 角色改动，不能将其视为已验收。两名 fast 只读代理均在 300 秒内无结果而超时，日志显示配置中的部分模型不在目录中。其结果不是验证证据。后续使用有明确回执的模型，否则由父执行并标为独立评审阻塞。
