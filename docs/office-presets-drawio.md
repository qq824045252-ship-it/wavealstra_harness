# 办公模式 Preset/Tag 重构 + Draw.io AI 接入

> 状态：已实现（working 全面 preset 化 + drawio-ai 受管 provider 全流程）
> 依据：`docs/场景模式-MCP与技能隔离.md` 的三模式架构；next-ai-draw-io 仓库实证（mcp-server 0.2.3）
> 术语：preset = tag = 场景标签（ModePresetDto）；drawio-ai = Draw.io AI MCP server 名（`@next-ai-drawio/mcp-server`）

---

## 1. 架构：working 与 design 完全同构

```
working（日常办公）
  ├─ 3 个 legacy 工作流 preset（inventory-summary / weekly-report / meeting-notes）
  │    promptAddon-only，id 保留兼容老任务 mode_preset_id
  └─ 5 个完整办公 preset（general-office / documents / spreadsheets / presentations / drawio-ai）
       promptAddon + skillPolicy + mcpPolicy + providerMcpIds（与 design presets 同构）
```

**MCP 路由原则（与 design 一致）**：base working 不 deny 办公 provider（deny 并集语义下 preset 无法翻案）；
非对应 preset 各自 `deny OFFICE_PROVIDER_MCP_IDS`（集中常量，初始 `["drawio-ai"]`），
drawio-ai 用 `mcpPolicy.allow: ["drawio-ai"]` 硬白名单收窄；MCP 条目写 `modes:["working"]` 不泄漏到 coding/design。

| preset | Prompt 路由 | Skill 路由 | MCP 路由 | provider |
|---|---|---|---|---|
| general-office（默认） | 通用办公交付规范（摘要/报告/纪要） | prefer 办公类；不额外收窄 | deny drawio-ai | 无 |
| documents | officecli word/academic-paper 子路由 | allow `["officecli"]` | deny drawio-ai | 无 |
| spreadsheets | officecli excel/data-dashboard 子路由 | allow `["officecli"]` | deny drawio-ai | 无 |
| presentations | officecli pptx/pitch-deck 子路由 | allow `["officecli"]` | deny drawio-ai | 无 |
| drawio-ai | drawio MCP 工具链路由（start_session→export_diagram）+ 布局规范 | 不额外收窄（继承 base；`mybuddyskills-main/skills/drawio` 可安装技能） | **hard allow `["drawio-ai"]`** | `["drawio-ai"]` |

## 2. 关键改动文件

| 文件 | 改动 |
|---|---|
| `src/shared/mode-profile.ts` | 新增 `OFFICE_PROVIDER_MCP_IDS`；`MODE_DEFAULT_PRESET_IDS.working = "general-office"`；`MODE_SEED_PRESET_IDS.working` 8 个 |
| `src/main/agent/mode-defaults.ts` | `WORKING_MODE_PRESETS` 重写为 8 个（legacy 3 + 完整 5） |
| `src/main/agent/ModeProfileStore.ts` | **升级语义**：磁盘已有 presets 数组时，只增不改并入出厂缺失 seed preset（用户同名项不被覆盖；删除过的 seed 不复活） |
| `src/shared/professional-tools.ts` | `MANAGED_TOOL_PROVIDER_IDS`（design 5 + drawio-ai）、`isManagedToolProvider`、Draw.io 常量（端口/身份标记/npm 包）、`DrawioMcpPayload`；DTO providerId 放宽为 ManagedToolProviderId |
| `src/main/professional-tools/ProfessionalToolRuntime.ts` | `DrawioRuntime`（探测/预检/画布打开/payload）+ `customPrepare` 钩子 + 注册进 service |
| `src/main/mcp/McpConfigService.ts` | `ensureDrawioServer`（对齐 ensureOpenDesignServer：幂等/过期重写/尊重停用/modes:["working"]） |
| `src/main/agent/AgentService.ts` | createSession provider gate 改用 `isManagedToolProvider`（design + 办公统一） |
| `src/main/index.ts` | `openInApp` op（应用内扩展栏浏览器）+ Draw.io 启动自愈 |
| `src/renderer/src/lib/modePresetBar.ts` | `providerDisplayName` 支持 drawio-ai |
| `src/renderer/src/components/chat/InputAddMenu.tsx` | **+ 菜单改为 base⊕preset effective policy**（复用 shared 纯函数，design/working 一并修正） |
| `mybuddyskills-main/skills/drawio/SKILL.md` | 正式 Draw.io 技能（modes:["working"]；需 base allow 含 drawio 或安装后加入白名单） |

## 3. Draw.io AI（drawio-ai）接入实证

**next-ai-draw-io 官方事实**（`DayuanJiang/next-ai-draw-io`，mcp-server 0.2.3 源码核对）：

- MCP server 自包含：`npx @next-ai-drawio/mcp-server@latest`（stdio；embedded HTTP server）
- HTTP：`127.0.0.1:6002`（`PORT` env 可改；6002-6020 被占自动回退），`GET /` 返回 draw.io embed 画布页
- **身份标记**：页面 `<title>Next AI Draw.io</title>`（MyBuddy 探测据此区分"端口被占"与"确实是 drawio"）
- 工具：`start_session`（建会话 + 开浏览器，返回 `Browser URL` 含 `?mcp=`）/ `create_new_diagram` / `load_diagram`（读盘 .drawio，含压缩格式）/ `edit_diagram`（cell id 增改删，带 fresh gate）/ `get_diagram` / `export_diagram`（.drawio 直写磁盘；.png/.svg 需浏览器画布导出）/ `list_pages` / `add_page` / `rename_page` / `delete_page`
- 生命周期：进程由 MyBuddy 会话内 **MCP adapter 托管**（会话 spawn/kill）；`DrawioRuntime` 不重复拉起

**MyBuddy 侧**：
- `ensureDrawioServer` 启动自愈写入 `~/.mybuddy/mcp.json`（command=解析到的 npx，env.PORT=6002，modes:["working"]，用户 disabled 尊重）
- 会话 gate：drawio-ai 在 effective 白名单 → `DrawioRuntime.customPrepare` 预检（npx 可解析 + MCP 条目启用；不要求 HTTP ready，避免与 adapter 拉起时机死锁）
- 画布打开：`DrawioRuntime.open` → 应用内扩展栏浏览器（`browserHost.open` + `BrowserIpc.openRequest`，App.tsx 常驻监听）；`start_session` 返回的 `?mcp=` URL 也可直接导航
- **Pi 是唯一主 Agent**：web 页只承载 draw.io 画布/历史/下载，无第二套 AI 对话；不套 Electron

**产物闭环**：`export_diagram` 写任务工作区相对路径 → 会话轮次结束时 `emitChangedArtifacts` 自动登记产物 → 现有 artifact 预览（.svg/.png 原生；.drawio 为 XML 文本预览，后续可加 viewer）

## 4. 故障排查

| 现象 | 处理 |
|---|---|
| drawio-ai chip disabled | 未配置 MCP：等启动自愈写入条目，或 MCP 设置里启用 drawio-ai |
| 会话报「drawio-ai MCP 未配置或已停用」 | 检查 `~/.mybuddy/mcp.json` 条目 + working 模式 MCP 策略（base deny 不含 drawio-ai） |
| 端口 6002 被占用 | 服务自动回退 6003+；status detail 提示"端口被非 Draw.io 服务占用" |
| 工具报 "No active session" | 先调 `start_session`（promptAddon 已路由；浏览器打开画布页） |
| export .png/.svg 超时 | 浏览器画布页未开（export 依赖浏览器导出）；打开画布后重试 |
| npx 未找到 | 安装 Node.js；Runtime status=missing 给出指引，不写 MCP 条目 |

## 5. 测试

`pnpm test:mode-preset`（148，含 1.5/1.6 办公 presets + 升级合并 + chips + InputAddMenu 静态 gate）
`pnpm test:mcp`（ensureDrawioServer 幂等/停用尊重/过期更新/modes 隔离）
`pnpm test:professional-tools`（117，含 6.5 Draw.io Runtime 探测/预检/画布打开/payload/端口占用）
`pnpm test:mcp-mode` + `pnpm test:mode` 回归通过；`pnpm typecheck` 全绿
