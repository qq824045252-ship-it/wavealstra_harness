# 文档导航与状态

核对基线：2026-11-19，代码 `6d2e5dc9`（v0.1.109）。本文区分现行契约、历史决策与验收证据；不把旧文档中的“当前”或“通过”自动延续到新版本。产品入口见 [项目 README](../README.md)，开发操作规则见 [AGENTS](../AGENTS.md)。

## 现行实现与维护入口

| 范围 | 文档 | 边界 |
| --- | --- | --- |
| 开发、测试与发布 | [AGENTS](../AGENTS.md) | 默认验证与明确发布分开；不自动提交、打包、安装或重启 |
| 普通任务与 PStack | [PStack](pstack-mybuddy.md) | 编排、子代理、只读标签与工作树约束 |
| 上下文管理 | [上下文管理](context-management.md) | 模型上下文压缩，不等同聊天列表分页/渲染 |
| 工具恢复 | [工具结果核验](durable-tool-recovery.md) | 未知外部效果不得当作成功或自动重放 |
| Gadget | [开发接口](gadgets.md) | 具名后台动作、JSON、CLI/HTTP 与实例数据，不是固定内置应用目录 |
| 浏览器 | [浏览器标签](browser-tabs.md) | 浏览器宿主、标签与自动化接口 |
| 桌面与 Linux | [Computer Use](computer-use-reliability.md)、[Linux](linux-computer-use.md) | 能力可用、夹具通过与真实发行包桌面验证分别表述 |
| 数据与资料 | [资料归属](material-ownership.md)、[记忆组织](memory-organization.md) | 归属、持久化与读写边界 |
| 状态结构 | [appStore](app-store-refactor.md) | 保留拆分时基线；字段与数量以当前源码为准 |
| 模型与媒体 | [DeepSeek](deepseek-api.md)、[多模态](multimodal-capabilities.md)、[API设置](api-service-settings.md) | 接口覆盖和真实供应商验收分开 |
| 缓存观测 | [请求追踪](cache-request-tracing.md) | 历史实测不可解释为当前成本节省承诺 |
| 许可 | [第三方通知](third-party-notices.md) | 随包许可证与上游来源 |

产品/渠道的具体接入入口见项目 README；独立 Bot 已删除，不再把旧 Bot 说明当成可用功能。

## Rust 后台迁移执行计划

[执行顺序与验收要求](rust-backend-execution-and-acceptance.md) 以 `a46f864` 为代码基线，规定先闭合基础契约，再迁应用写入、调度、渠道与 Gadget，最后抽离 Pi Node 宿主并收薄 Electron Main。包含十步先后依赖、逐步出口门禁、故障与双平台验收；它是后续执行规范，不代表整体迁移已完成。已有基础修复实测见 [2026-11-25 评审](reviews/rust-core-contracts-2026-11-25.md)。

## 发布与数据安全

- 当前数据库 schema 为 36。v0.1.108→v0.1.109 没有提高 schema，但这不是所有历史版本无损升级保证。旧 schema 不匹配时删除数据库及 sidecar 后重建，不自动备份；读取失败不应冒充旧版本。升级前退出应用及托盘后台，私下冷备份完整实际数据目录，不只复制 `app.db`。默认目录为 Windows `%USERPROFILE%\.mybuddy`、Linux `~/.mybuddy`；外部工作区与系统凭据另计。
- Windows 正式目标为 NSIS x64。Linux 默认配置是 dir；AppImage/deb 需显式选择目标，详见 AGENTS。完整源码构建、payload、ARTIFACT、隔离实际包运行分别记录，不以开发测试替代包验收。
- 2026-11-19 GitHub `verify` workflow 为 `disabled_manually`。仓库有 Windows/Linux/GUI job 配置不代表自动执行；使用前重新核对，不擅自启用。
- 当前脚本以 [package.json](../package.json) 为准，`node scripts/test-all.mjs --list` 查看分类。默认套件不是 GUI、联网、数据集或产物全覆盖。实际版本与资产见 [Releases](https://github.com/qq824045252-ship-it/wavealstra_harness/releases)。

## 历史决策，不是当前操作手册

- [独立 Bot 退役边界](bot-retirement.md) 是现行保留/删除说明。其余 `bot-*.md` 是旧设计和阶段记录，保留独有决策，不按其中的写接口或旧测试命令恢复功能。
- [Work预算退役](work-budget-retirement.md) 合并了重复的无预算约定；[审批/权限退役](work-action-approval-loop.md) 保留相关决策。旧证据中的保留数据策略应按日期理解，不能覆盖后续 schema 清理规则。
- [Durable统一过程](durable-unification-work.md) 记录分阶段限制、后续授权与验收；开头的未测试状态不是当前最终状态。
- [Cloudflare调研](cloudflare-tunnel-integration.md) 明确是不实施的候选设计，不据候选路径缺失断言代码损坏。
- [原回复进度设计](inline-task-replies.md) 是退役 Bot 界面记录，不是当前 UI 验收清单。
- `issue26-*-20261112.md`、带日期的验收文档与阶段计划按各自 SHA/日期解释，不扩大为当前全量证明。

## 证据与维护规则

[reviews/](reviews/) 保留审查、原始日志及截图；[acceptance/](acceptance/) 和 [verification/](verification/) 保留验收场景。它们的旧命令/缺失旧路径可能是当时事实，应标注历史状态，不能一律删除，也不能沿用为今天可复跑命令。

更新文档时先核对引用的源码、脚本和版本。删除重复页面前保留独有决策及证据，更新入链；不删除原始验收资产。只改文档不意味着已重新运行文中测试，也不授权修改运行时、提交或发布。
