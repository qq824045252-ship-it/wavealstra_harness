# Serena（MyBuddy 扩展）

上游： [oraios/serena](https://github.com/oraios/serena)  
本地源码：`extensions/mcp/serena/repo`（junction → `vendor/serena`）

## 行为

- **MCP 名**：`serena`
- **适用模式**：仅 `coding`（代码开发）
- 办公 / 设计会话 **不会** 向 Agent 暴露此 MCP（`mcpPolicy` hard deny + entry.modes）

## 系统依赖

```bash
uv tool install -p 3.13 serena-agent
serena init
```

## 安装到 MyBuddy

将 `mcp.json` 中的 `serena` 条目写入 `~/.mybuddy/mcp.json`（Hub → MCP 安装，或手动合并）。  
会话加载时由主进程按 `welcomeMode` 过滤，无需手动开关。
