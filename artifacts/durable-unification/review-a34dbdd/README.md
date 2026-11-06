# a34dbdd 审核后的工作区验收

2026-11-06，Windows，MyBuddy 0.1.107，Pi 1.5.0。本次只验证当前版本新建的任务。

| 检查项 | 行为与证据 |
| --- | --- |
| 分支证据继承 | 使用实际 Durable 父任务生成账本再创建子任务。子任务保留版本、清单和来源，按自己的作用域验证访问。撤销证据、注入损坏账本后，供应商调用次数均未增加。参见[原生执行测试输出](projection.txt)。 |
| 回复锚点 | 服务用例覆盖用户、助手、工具结果和无效 ID。真实 Electron 窗口通过助手回复按钮创建分支，用输入框在子任务收到新答复；从旧页回复创建的分支也收到新答复。参见[桌面测试输出](desktop.txt)。 |
| 手机重试 | `test:remote-access` 用真实本机 HTTP 服务、生产客户端和隔离数据库验证：不可用模型在受理前被拒绝，改选可用模型后收到回执。`test:durable-sync` 另验响应丢失及无明确受理结论的错误：操作 ID 和请求内容均不变。 |
| 费用来源 | `test:task-diagnostics` 用 SDK 默认零、供应商明确报告零费用、原生费用已知但原始用量缺失三种输入检验诊断及账本。`test:usage-stats` 保证费用未知不抹掉已有 token 计数。 |
| 长历史 | 实时展示最多保留最近 **200 条已提交 entry**，另保留活动工具所属记录。旧页独立读取，不广播为实时快照。600 条记录逐页可达；工具结果在页外也能回填到所属消息。真实桌面连续新增 120 轮后，实时快照为 133 条可展示消息。参见[旧页截图](desktop-history.png)。这里验证的是展示缓存，不是整个进程的字节数上限。 |
| 手机界面 | 在隔离的 Electron 渲染器内运行实际手机 App 组件。连续翻 4 页，每页显示 50 条；阅读旧页时收到实时更新，点击返回后显示最新消息。[原始输出](mobile-ui.txt)。 |

桌面和手机端开发构建、类型检查通过（[桌面类型门禁原始输出](typecheck.txt)）。以上供应商调用使用本地夹具，不涉及真实账户。未生成发行包；ADB 未发现已连接的安卓设备，物理手机的浏览器和网络重连尚未验收。

最终 Windows headless 门禁：[298 项通过，0 项失败，0 项基线失败，0 项新增回归](headless.txt)。2 项 Linux 专属用例按平台排除。没有运行整套 GUI、外部联网或安装包验收。

复核命令：`pnpm -s typecheck`、`pnpm -s remote:typecheck`、`pnpm -s build`、`pnpm -s remote:build`、`pnpm -s test:all`、`pnpm -s test:durable-bot-desktop --review`、`pnpm -s test:remote-task-dot-ui-desktop`。
