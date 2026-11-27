# MyBuddy 文档

开发、验证和发布规则见 [AGENTS.md](../AGENTS.md)。测试入口和分类以 [package.json](../package.json) 及 [测试运行器](../scripts/test-all.mjs) 为准。运行 `node scripts/test-all.mjs --list` 查看分类，运行 `node scripts/test-all.mjs --audit` 检查分类。

## 功能与维护

| 范围 | 文档 |
| --- | --- |
| 代码工作流 | [PStack 与子代理](pstack-mybuddy.md)、[执行钩子](native-hooks.md) |
| 上下文与工具 | [上下文管理](context-management.md)、[工具结果核验](durable-tool-recovery.md)、[缓存诊断](cache-request-tracing.md) |
| 内置工具 | [Gadget](gadgets.md)、[浏览器标签](browser-tabs.md)、[Computer Use](computer-use-reliability.md)、[Linux 桌面操作](linux-computer-use.md) |
| 数据与记忆 | [资料归属](material-ownership.md)、[记忆整理](memory-organization.md) |
| API 与媒体 | [API 服务设置](api-service-settings.md)、[DeepSeek](deepseek-api.md)、[语音与媒体](multimodal-capabilities.md) |
| 渠道 | [钉钉](dingtalk-gateway.md)、[Discord](discord-gateway.md)、[QQ](qq-gateway.md)、[个人微信 iLink](weixin-ilink.md) |
| 许可 | [第三方通知](third-party-notices.md) |

## 验收记录

[DuckDB 迁移实测](reviews/duckdb-acceptance-2026-11-26.md) 和 [其他评审记录](reviews/) 记录各自版本及实测范围。现行门禁见 [AGENTS.md](../AGENTS.md)。
