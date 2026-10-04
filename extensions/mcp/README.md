# MyBuddy 捆绑 MCP 扩展

本目录为 **出厂扩展包**（声明 + 上游源码 junction），不是 pi 的 `~/.mybuddy/extensions` 运行时目录。

| 扩展 | MCP 名 | 默认 modes | 上游 |
|------|--------|------------|------|
| `serena/` | serena | coding | oraios/serena |
| `codegraph/` | codegraph | coding | colbymchenry/codegraph |

- `extension-meta.json`：展示与 modes 元数据  
- `mcp.json`：写入 `~/.mybuddy/mcp.json` 的服务器定义（含 `modes`）  
- `repo/`：指向 `vendor/*` 的目录联接，便于读源码  

会话级隔离见主进程 `McpModeFilter` + 各模式 `mcpPolicy`（A 黑名单 / B 白名单）。
