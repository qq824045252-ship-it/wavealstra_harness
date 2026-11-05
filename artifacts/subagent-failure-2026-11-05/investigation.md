# 子智能体真实任务失败调查

任务 `local-1793861807897-0`，标题“测试子智能体功能”。只读查询真实 app.db 定位会话，读取对应 Pi JSONL；未修改任务或重跑原任务中的写操作。

## 实际故障

会话文件末尾为 `2026-11-05T06-56-48-591Z_01a1aa7e-f1ce-74b1-be4d-26184c96fcd5.jsonl`。

| 子智能体 | 会话行 | 已执行轮数 | 终止原因 |
| --- | --- | ---: | --- |
| scout-2bk9e5 | 335 | 66 | 子代理模型配置已变化，请重新发起任务 |
| scout-6a8v6j | 337 | 64 | 503，database_unavailable，resolve Billing Scope |
| worker-ephxcq | 345 | 51 | 子代理模型配置已变化，请重新发起任务 |

同批另外三个实例完成。更早第 16 行有两次启动前拒绝：普通任务目录不属于 Git 仓库，而自动隔离要求 Git worktree。第 18 行显式指定 `isolation: shared` 后两者成功。该限制按现有隔离契约保留。

## 已有修复与本次修复

`d2ad724` 已将 worker 配置比较改为键序无关，并在真实差异时报告字段名；失败工具结果也已保留先前输出。本次真实 worker 回归证明：仅调换嵌套 compat 属性顺序可以继续，改变 contextWindow 则在下一次 HTTP 请求前失败并报告字段名。

历史两次配置错误没有记录差异字段，不能仅凭通用文案确定当时究竟是哪一项发生变化。现场 models.json 备份与当前文件的 thinkingLevelMap 属性顺序确实不同，但这不足以还原两次失败时的全部配置。

旧发行包为 0.1.104，worker 不含 changedFields；本次调查开始时源码和 out/ 中已含该修复。这说明源代码修复尚未完成发行包交付。

本次新增修复针对供应商数据库故障：Pi 1.5.0 的 `isRetryableAssistantError` 先匹配不可重试列表，其中裸词 `billing` 把 `resolve Billing Scope` 误当成额度耗尽，覆盖了后面的 503 可重试判断。真实错误原文为：

```text
503: {"code":"database_unavailable","message":"Open Design: [code=database_unavailable] resolve Billing Scope: status 503: database_unavailable","param":null,"type":"api_error"}
```

修改现有 pi-ai pnpm patch：额度、预算、订阅限制仍优先拒绝；只有明确的 500/502/503/504 JSON 响应且 code 为 database_unavailable，才允许越过泛化 billing 拒绝。未知 billing 错误、401 和真正 insufficient_quota 继续拒绝。重试次数、退避、取消及恢复历史均由 Pi 原有生命周期负责。

实际桌面验收进一步暴露 Responses 的错误格式不同，原生格式为 `fixture API error (503): {...}`。修复同时识别 Chat 的 `503: {...}` 和 Responses 的带服务商前缀格式。随后把两条协议的完整恢复、耗尽、额度、配置及取消场景都纳入默认 headless 回归。

## 验证

新增 `test:subagent-failure-recovery` 使用临时配置和本地 HTTP 服务，启动真实 Pi worker。关闭 provider 层重试以明确验证 agent 层分类及恢复。

修改前：错误分类、恢复、耗尽三个用例失败；恢复用例读完文件后立刻 failed，请求总数只有 2。

修改后：13 项通过，包括分类矩阵及 Chat/Responses 各 6 个真实进程场景。恢复用例总请求数 3；持续故障总请求数 4，对应首次工具调用、首次故障及 2 次重试；额度错误总请求数 2；配置键顺序变化总请求数 2；真实配置变化总请求数 1；取消总请求数 2。每个场景工具只执行一次，输出和文件保留，终态 worker/active 注册表清理。

- `pnpm -s typecheck`：通过，无新增错误；scripts 历史基线错误仍单独报告。
- `pnpm -s test:all`：297 通过，0 失败，0 已知失败，0 新增回归。
- `pnpm -s remote:build` 与 `pnpm -s build`：通过。
- 本地详细日志：`out/diagnostics/subagent-failure-recovery/`。

## 发行包验收与交付

0.1.107 位于 `release/0.1.107/win-unpacked`。

- payload 门禁通过：598 个 unpacked 条目无缺失，真实 worker 启动并报告 Pi 1.5.0。
- 从安装包加载 worker，Chat/Responses 的 13 项回归全部通过。
- 实际 MyBuddy.exe 使用临时 HOME/userData 启动；设置 UI、IPC、配置落盘、固定/覆盖时限、允许列表及冲突检测全部通过。主任务通过 subagent 工具调用真实打包子进程，收到 Responses 503 后重试，第二次请求成功返回 CHILD_OK。没有使用真实用户凭据。
- 桌面验收脚本按现有独立“子代理设置”页、中文控件、候选模型选择器更新；输出字段分开断言，避免把排版顺序当行为。截图在实际绘制后取得并检查，见 `out/tests/subagent-settings-package/settings.png`。
- 另外进行了独立的真实模型只读验收：打包 worker 使用已配置的 Magpie DeepSeek V4.1 Flash，读取专用临时文件，2 轮完成，read 执行 1 次，返回指定标记，终态清理正常。没有重跑原任务中的修改操作。该验收使用隔离的临时配置副本并在结束后删除。
- Desktop 和 Start Menu 快捷方式均指向此包，回读 target/cwd/icon/application identity 通过，身份为 `com.mybuddy.app`。未中断原有应用实例。
- 新包 MyBuddy.exe SHA256：`6b18f7e517d5294de5c021d3fdc26944fab5487d53a3739905b0c1e028f3ec2e`。
- 新包 app.asar SHA256：`120e9f1b12624c3da1ac70f6945421defaf85e9041819ad39e122129854acd59`。
- 旧 0.1.104 生成目录已确认无进程和快捷方式引用；删除操作被自动审批以 `blocked by policy` 拒绝，未提供更具体原因，因此保留该目录。既有未跟踪图表和临时目录保留。

恢复范围：本次处理的是仍存活的 worker 遇到暂时性模型请求错误后，使用当前历史进行有限重试。未增加进程崩溃、强杀或应用退出后的自动重启与断点续做能力；重试耗尽仍返回失败及已有输出。

供应商的真实数据库故障不能由本地代码修复。上述验证重放了相同错误，验证客户端的恢复行为，不代表供应商可用性保证。
