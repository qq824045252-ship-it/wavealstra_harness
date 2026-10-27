# MyBuddy × OpenDesign 集成（Design Mode「AI 设计引擎 · OpenDesign」）

> ⚠️ **已退役**：OpenDesign 受管 provider / preset 已从产品下线，本文仅作历史实现记录。
> 文中 `MyBuddyTools/...` 路径与"把官方目录放进 MyBuddyTools"的安装方式**不再适用**：
> 本产品不内置第三方软件，OpenDesign 若需使用请自行按官方方式安装（PATH 上的 `od` 或官方桌面版）。

> 状态：**已实现**（v3.6 开发线，worktree `pi/task_1d0343df2c3a`）。
> 依据：`docs/opendesign-integration-plan.md`（调研 + 实施方案 v1）；本机实证：Open Design 桌面版
> **0.16.1**（CLI 自报 0.18.2，prebundled），daemon 常驻 `127.0.0.1:7456`。
> 术语：OD = Open Design（open-design.ai / nexu-io/open-design，Apache-2.0）；`od` = OD CLI。

---

## 1. 架构与原则

```
┌─ MyBuddy ─────────────────────────────────────────────────┐
│  Design Mode → preset「AI 设计引擎 · OpenDesign」         │
│    ├─ OpenDesignRuntime（探测/拉起/状态/端口回退）         │
│    ├─ 本地 stdio MCP：od mcp --daemon-url http://127.0.0.1:<port>  │
│    │    （条目写入 ~/.mybuddy/mcp.json，modes:["design"]） │
│    └─ Pi（唯一主 Agent）用 MCP 工具驱动 OD 设计引擎        │
└──────────────┬───────────────────────────────────────────┘
               │ HTTP（仅本机 127.0.0.1）
┌──────────────▼───────────────────────────────────────────┐
│  OpenDesign daemon（headless，端口 7456+）                 │
│  项目/文件读写、技能/设计系统资源、可选 start_run 委托     │
└───────────────────────────────────────────────────────────┘
```

- **Pi 仍是唯一主 Agent**：OD 是被调用的 Design Engine。不启用 OD 官方 pi adapter 方向
  （那是「OD spawn pi」，主从颠倒）。
- **本地 stdio MCP，完全不经过 pi-chatgpt-bridge**：条目只存在于 `~/.mybuddy/mcp.json`，
  与 bridge 无任何共享路径。
- **不套娃 OD Electron/Web UI**：headless daemon 模式；`open()` 不擅自打开外部页面
  （`--serve-web` 未启用时 headless 无 Web UI）。
- **不破坏 Penpot/Blender/FreeCAD 边界**：`opendesign` 是独立 preset（mcpPolicy 硬白名单只放行
  `opendesign`）；`general` preset 的排除清单 `DESIGN_PROVIDER_MCP_IDS` 已含 `opendesign`。

## 2. 安装与 CLI 探测链

OpenDesign CLI 解析顺序（`OpenDesignRuntime.resolveCli`，静态链优先、无进程探测）：

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `MYBUDDY_OPENDESIGN_CLI` 环境变量 | 显式指向 cli.js / od.mjs / daemon-cli.mjs / od.cmd / od.exe |
| 2 | 设置项 cliPath（`ProfessionalToolRuntimeOptions.opendesignCliPath`） | 代码注入的显式路径 |
| 3 | ~~`MyBuddyTools/open-design*/dist/cli.js`、`bin/od.mjs`~~ | 已删除：便携目录探测随"不内置第三方软件"下线 |
| 4 | 打包桌面应用 `%LOCALAPPDATA%\Programs\<app>\resources` | 见下方布局差异 |
| 5 | PATH 兜底 `where/which od` | 逐候选身份校验（见 2.2） |

### 2.1 打包应用布局差异（本机实证）

| 版本 | CLI 位置 | 入口声明 |
|---|---|---|
| 0.16.x（本机安装） | `<resources>/app/prebundled/daemon/daemon-cli.mjs` | `<resources>/open-design-config.json` 的 `daemonCliEntryRelative` |
| main@0.18.2 源码布局 | `<resources>/open-design/bin/od.mjs` → `../dist/cli.js` | 无（静态候选兜底） |

探测实现同时支持：**先读 `open-design-config.json` 的 `daemonCliEntryRelative`（权威入口）**，
缺失/指向不存在文件时回落静态候选 `app/prebundled/daemon/daemon-cli.mjs` →
`open-design/bin/od.mjs` → `open-design/dist/cli.js`。

安装方式（任选其一，推荐 ①）：
1. **官网下载 Windows 打包版**（自带运行时，自动探测，无需任何配置）；
2. **源码**：Node 24 + corepack pnpm + `pnpm bootstrap`（历史做法曾把 `apps/daemon` 产物放进 `MyBuddyTools/open-design`，该便携目录已废弃）；
3. **PATH**：把 `od`（npm 全局 shim 或源码 bin）加入 PATH，身份校验通过即可。

### 2.2 PATH 假阳性防护

Windows 上 Git Bash 自带 `od.exe`（GNU coreutils 八进制转储）是知名假阳性（本机
`C:\Program Files\Git\usr\bin\od.exe`）。身份校验只认官方 `od daemon status --json` 输出标记：
`daemon-not-running`（daemon 未跑，exit 64）或 `bindHost`（运行时 JSON）——Git od 输出
`od: unknown option -- json`，不命中标记，被拒绝。校验通过的候选按形态 spawn：
node 脚本 → `node <script>`；`od.cmd`/`od.exe` → 直接 spawn（不再把可执行文件当 node 参数）。

## 3. 使用指南

### 3.1 会话

Design Mode 的 preset 栏选择「AI 设计引擎 · OpenDesign」→ 发首条消息：

1. `createSession` 专业 provider gate：`opendesign` 在 effective mcpPolicy 白名单内 → 调
   `OpenDesignRuntime.prepareForProvider`（探测 daemon → 未跑则 `od daemon start --headless --port <n>`
   拉起并等待 Ready → 校验 MCP 条目）；
2. prompt 注入 preset 段（promptAddon：工具用法 / DESIGN.md / 职责边界）；
3. `od mcp` stdio MCP 注入会话（`modes:["design"]`，coding/working 模式自动隐藏）。

### 3.2 MCP 工具（实机 0.16.x = 18 个；0.18.2 = 21 个）

| 类别 | 工具 |
|---|---|
| 项目/读 | `list_projects` `get_project` `get_active_context` `list_files` `get_file` `get_artifact` `search_files` |
| 项目/写（限 OD 项目内） | `create_project` `create_artifact` `write_file` `delete_file` `delete_project` |
| 生成委托 | `list_skills` `list_plugins` `start_run` `get_run` `cancel_run` `list_agents` |
| 0.18.2 独有 | `collect_brief` `confirm_brief` `get_vela_login_status` `start_vela_login`（OD Cloud 计费，本方案不采用） |

写工具（`write_file/create_artifact/delete_file/delete_project`）只作用于 OD 项目内路径；
迭代产出用 `write_file`（`create_artifact` 拒绝已存在文件）。

### 3.3 DESIGN.md 与 skills 引导

- 项目级 **DESIGN.md** 是品牌契约：Pi 可读 OD 项目内 DESIGN.md 或本地文件，作为设计规范参考；
- OD 内置 **200+ skills**（`list_skills` 发现，SKILL.md 内容经 `get_file`/资源读取）——
  **由 Pi 读取并自行执行**（Pi 是主 Agent，不走 OD 内部执行循环）；
- `start_run`（委托 OD 生成，5–30 分钟）默认不主动使用；确需时用 `requestId` 幂等 + 轮询
  `get_run`，且注意它会引入 OD 检测到的本机 inner agent。

### 3.4 产物回接 Artifact/Preview（复用现有链路，零改动）

1. **主路径**：Pi 把最终产物写入**任务工作区** → 现有 `emitArtifactFile` 自动注册 →
   消息下方 ArtifactChip → `ArtifactPreviewHost` 预览（HTML/MD/SVG/PDF/PPTX/Office 全支持）；
   HTML 产物可继续用 **Capture Mode** 抓取元素（Capture 与顶层模式正交，天然可用）。
2. OD 项目文件（`<od-data>/projects/<id>/`）如需预览，复制到任务工作区后走主路径即可。
3. **预览链接规则**（会话层强制注入 `OPENDESIGN_PREVIEW_LINK_RULES`）：
   - **禁止** daemon 裸根（`http://127.0.0.1:7456/`）——headless 无 Web Studio，根路径 `Cannot GET /`；
   - 工具返回的 `previewUrl`（`…/api/projects/<id>/raw/<file.html>`）可渲染，本机链接走扩展栏预览；
   - `studioUrl` 仅在工具明确返回时使用；未返回时禁止编造 Studio 链接；
   - 聊天里若误点裸根，Markdown 会优先打开当前任务的 HTML 产物预览。

## 4. 职责边界（与其它专业 provider）

| 场景 | 用哪个 preset |
|---|---|
| AI-native UI/Web/Dashboard/演示/视觉设计（OD 引擎） | **AI 设计引擎 · OpenDesign** |
| 网页原型 / Design System 协作 | 网页原型 · Penpot |
| 3D / Mesh / 材质 / 渲染 / 动画 | 3D · Blender |
| 精密机械 CAD | 机械 CAD · FreeCAD |
| 通用设计分析（不加载专用工具） | 通用设计 |
| 真实产品代码实现 | **Code Mode**（不是 Design Mode） |

## 5. 配置层（`~/.mybuddy/mcp.json`）

启动自愈 + daemon 端口回退时由 `McpConfigService.ensureOpenDesignServer` 维护：

```jsonc
"opendesign": {
  "command": "<node-or-electron>",              // 解析后的 Node 兼容 runtime
  "args": ["<cli路径>", "mcp", "--daemon-url", "http://127.0.0.1:7456"],
  "env": { "OD_DATA_DIR": "C:\\Users\\<u>\\.mybuddy\\od-data" },
  "modes": ["design"],
  "disabled": false
}
```

语义（幂等，全部有测试锁定）：
- CLI 未解析（payload null）→ 不写、不动现有条目（用户可能手动配置了 `od` 命令）；
- 条目缺失 → 写入；内容过期（如 daemon 端口回退到 7457）→ 重写 `--daemon-url`，保留 `modes`；
- 用户显式停用（`disabled:true`）→ **尊重，绝不自动恢复**；
- 应用退出时 `stopOwned()` 只杀本 Runtime spawn 的 daemon——用户自启实例不碰。

## 6. 故障排查 / 降级矩阵

| 场景 | 行为 |
|---|---|
| OD 未安装 / CLI 未解析 | status=missing，detail 给出安装指引；preset chip disabled + title 提示；会话创建被阻断（明确报错，不静默 fallback） |
| daemon 未运行但 CLI 存在 | 会话时自动 `daemon start --headless --port 7456`，等待 Ready |
| 7456 被占用 | 依次回退 7457–7466；成功后把 `--daemon-url` 同步进 mcp.json |
| daemon 中途退出 | 下次 MCP 调用报 daemon unreachable（OD 侧读工具自动重试；写工具不重放防重复提交） |
| 不想用 OD | 切回 `general` 或其它 preset（并行，互不影响） |
| Git Bash `od.exe` 在 PATH | 身份校验拒绝（输出无官方标记），不影响探测 |

## 7. 验证记录

| 项目 | 结果 |
|---|---|
| `test:professional-tools`（含 OpenDesign 6a-6i：探测链/身份/生命周期/端口回退/打包布局） | 99 passed |
| `test:mode-preset`（6 个 design preset / opendesign 硬白名单 / general 排除 / chips） | 122 passed |
| `test:mcp`（ensureOpenDesignServer 幂等/过期重写/尊重停用） | 全部通过 |
| `test:mcp-mode`（modes:[design] 过滤 / coding-working 隐藏） | 19 passed |
| `test:mode`（mode-profile 回归） | 29 passed |
| **`test:opendesign-smoke`（本机实机）** | **32 passed**：打包 CLI 探测命中 daemon-cli.mjs → daemon Ready(7456) → payload 形状 → Git od 假阳性拒绝 → 真实 stdio MCP initialize+tools/list（18 工具）→ ensure 写入链路（临时配置，未碰用户 mcp.json） |
| 真实读调用 | `list_projects` → `{"projects":[]}`（端到端 MCP 读路径通） |

## 8. 已知限制

- 0.16.x 打包版 MCP 无 `collect_brief/confirm_brief/vela` 工具（本方案本就不采用）；
- `start_run` 委托会引入 OD 检测到的本机 inner agent——默认关闭，后续作为设置项评估；
- `od export`（HTML→PDF/PPTX）为 Phase 3 可选，未接入；
- `get_active_context` 与 MyBuddy 自有 active task 语义重叠，不采用；
- daemon 数据目录默认 `~/.mybuddy/od-data`（`OD_DATA_DIR` 可覆盖）。
