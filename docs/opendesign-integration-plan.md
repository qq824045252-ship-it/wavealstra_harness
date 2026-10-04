# MyBuddy Design Mode × OpenDesign 接入调研与实施方案（调研版 v1）

> 状态：**已实现**（2026-08 开发线）。实施记录见 `docs/opendesign-integration.md`；
> 本文件为历史调研与方案，仅 P0 评审项有更新：
> ①打包 CLI 布局以本机 0.16.1 实证为准（`app/prebundled/daemon/daemon-cli.mjs` + `open-design-config.json`
> 的 `daemonCliEntryRelative`，非 0.18.2 的 `bin/od.mjs`）；②MCP 工具数随版本浮动（0.16.x=18，0.18.2=21，
> 差异为 brief/vela 4 个本就不采用的工具）；③产物回接 A 路径已落地（任务工作区→现有 Artifact 链路），
> B 路径（registerExternalProject）未做，保持计划中可选。
> 依据：MyBuddy 源码（本仓库 `src/`）+ nexu-io/open-design 官方仓库 main@0.18.2（`docs/agent-adapters.md`、`apps/daemon/src/…`，Apache-2.0）。
> 术语：OD = Open Design；`od` = OD CLI（`apps/daemon/bin/od.mjs` → `dist/cli.js`）。

---

## 0. 结论先行

1. MyBuddy 的 Design Mode 已有完整的「顶层模式 + 专业 preset + MCP 硬隔离 + 专业工具 Runtime + Artifact 预览」五层骨架；OpenDesign 可以**以第 6 个专业 provider 的身份平级接入**，不新增任何架构概念。
2. 官方 `od` CLI 提供：headless daemon（`od daemon start --headless`）、stdio MCP 服务器（`od mcp`，21 个工具、读写只限于 OD 项目内）、`od mcp install <agent>` 一键注册（pi 走 manual 打印分支，不写配置——MyBuddy 用自己的 McpConfigService 写 `~/.mybuddy/mcp.json` 即可）。
3. **推荐接入形态**：Design Mode 新增 preset「AI 设计引擎 · OpenDesign」（id `opendesign`）；MyBuddy 以本地 stdio MCP 注入 `od mcp --daemon-url http://127.0.0.1:<port>`（写入 `~/.mybuddy/mcp.json`，`modes:["design"]`，与 pi-chatgpt-bridge 完全无关）；新增 `OpenDesignRuntime`（仿 Blender/FreeCAD Runtime）负责探测/拉起/状态；Pi 始终是唯一主 Agent，OD 是被调用的 Design Engine；产物经现有 Artifact 链路注册并由现有 ArtifactPreviewHost 预览。
4. **不采用**：OD 的 pi adapter 方向（`od` spawn `pi`，与本项目主从关系相反）；OD Electron/Web UI 套娃嵌入；`collect_brief/confirm_brief`（MyBuddy 有完整对话 UI）；OD 媒体生成/插件/自动化（超出 Design Mode 范围）。

---

## 1. MyBuddy Design Mode 现状（已验证事实）

### 1.1 顶层模式模型与持久化

| 事实 | 证据 |
|---|---|
| 顶层模式 `WelcomeMode = "working" \| "coding" \| "design"` | `src/shared/mode-profile.ts:3` |
| 模式资料 `ModeProfileDto` = 5 个文案块（goal/workflow/delivery/forbid/criteria）+ `ModePolicyDto`（skillPolicy / toolPolicy / mcpPolicy / scenes / presets） | `src/shared/mode-profile.ts:25-141` |
| 模式磁盘落点 `~/.mybuddy/modes/<id>/{goal.md,…,policy.json}`，`getProfile` 每次与出厂 seed 比对得出 `source: "seed"\|"user"` | `src/main/agent/ModeProfileStore.ts:240-340`（`ensureMaterialized` / `getProfile`） |
| 出厂 seed（design 的 goal/workflow/delivery/forbid/criteria + policy） | `src/main/agent/mode-defaults.ts:255-340`（`MODE_SEEDS.design`）；design policy：skill 偏好 design/ui/prototype、tool soft 偏好 read/write/edit、`mcpPolicy: {mode:"hard", deny:["serena","codegraph"]}` |
| Design 出厂 5 个专业 preset：`ai-ui`(ardot-local) / `web-prototype`(penpot) / `3d-blender`(blender) / `mechanical-cad`(freecad) / `general`(无 provider) | `src/main/agent/mode-defaults.ts:95-157`（`DESIGN_MODE_PRESETS`） |
| 集中式设计 provider 清单 `DESIGN_PROVIDER_MCP_IDS = ["ardot-local","penpot","canva","blender","freecad"]`（general preset 排除用 + UI 可用性判断） | `src/shared/mode-profile.ts:99` |
| 出厂默认 preset：`MODE_DEFAULT_PRESET_IDS.design = "ai-ui"` | `src/shared/mode-profile.ts:104` |
| preset 与 base 的收窄合成（deny 并集 / allow 交集 / 任一侧 hard 即 hard / promptAddon） | `src/shared/mode-profile.ts:135-240`（`resolveEffectiveModePolicy` / `composeMcpPolicy` / `composeSkillPolicy`） |

### 1.2 模式切换（renderer 状态）

- `appStore.setWelcomeMode / setModePreset`：任务已有 messages 或 sessionFile 即**锁定**（只更新全局 selection，影响下次新建）；空任务可切；跨模式切换用目标模式默认 preset。`src/renderer/src/store/appStore.ts:653-712`
- `duplicateTaskWithMode`（D1：用新模式复制为新任务）`appStore.ts:742-760`。
- preset bar 纯逻辑 `buildPresetBarChips`：locked 或 `providerMcpIds` 对应 MCP 未配置/未启用 → chip disabled + 说明 title（**不静默 fallback**）。`src/renderer/src/lib/modePresetBar.ts:29-58`；provider 显示名映射 `providerDisplayName` 同文件 63-74。
- 任务落库字段 `welcomeMode` + `modePresetId`（`AgentService.upsertTask`，`src/main/agent/AgentService.ts:1996-2014`）。

### 1.3 prompt / runtime / tool 注入（新会话唯一入口 `createSession`）

`src/main/agent/AgentService.ts:1684-2026`，顺序：

1. `modeProfiles.getProfile(welcomeMode)` → `resolveModePreset(profile.policy, modePresetId)` → `resolveEffectiveModePolicy` → `withEffectiveModePolicy`（1684-1710）。
2. **专业 provider 强制 gate**：`preset.providerMcpIds.filter(isProfessionalToolProvider)` → 先 `previewMcpFilter` 证明 effective policy 真放行该 MCP → `professionalToolRuntime.prepareForProvider(providerId)` 启动/等待 Ready，失败即抛错阻断会话；Penpot 额外 `open()` 内置浏览器（1715-1760）。
3. `assemblePrompt`（`src/main/agent/PromptAssembly.ts:47-211`）：唯一 system 拼装点（createSession 与 assemblePreview 共用）。mode 段 + expert + **modePreset 段**（`## 场景预设：<label>\n<promptAddon>`，source "runtime"）+ skillCatalog + shell 注记 + 记忆 + 权限 → `appendParts` → `DefaultResourceLoader.appendSystemPrompt`。
4. MCP 注入：`mcpRuntime.getInlineExtensions({welcomeMode, mcpPolicy})` → `filterMcpConfigForMode(full, mode, policy)` 后 `pi-mcp-adapter.createMcpAdapter({config: filtered.config})(pi)`。`src/main/mcp/McpRuntimeService.ts:88-114`；过滤四级：全局 disabled → `entry.modes` 不含当前模式 → `policy.deny` → `policy.allow`（白名单，空 = 不启用）。`src/main/mcp/McpModeFilter.ts:60-120`
5. 工具集：`resolveSessionTools(permissionMode, toolPolicy)`（readonly → 只读四工具；hard deny 生效）。`src/main/agent/PromptAssembly.ts:213-230`
6. 会话扩展链：TaskFileAccessPolicy → bash 隔离 → MCP inline 扩展 → MCP side-effect 门禁 → permission → backup。`AgentService.ts:1800-1890`
7. 会话仅首条消息时才 materialize（renderer `sendMessage`，store 注释 `appStore.ts:106`）。

### 1.4 专业工具 Runtime（外部设计工具如何注册/启动/暴露）

`src/main/professional-tools/ProfessionalToolRuntime.ts`：

- `ProfessionalToolRuntimeService`（330-400）：`ardot-local / penpot / blender / freecad` 四个 runtime；`prepareForProvider` = status → 缺 missing 报错 → 未 ready 则 start → connectMcp（校验 providerEnabled，即该 MCP 已配置且启用）。
- toolsRoot 解析：`MYBUDDY_TOOLS_DIR` env > `<cwd>/MyBuddyTools` > exe 旁（101-107）。用户机实况：`C:\Users\servi\Desktop\mybuddy\MyBuddyTools\{Ardot,blender-5.2.0-windows-x64,FreeCAD_1.1.3-…,penpot,mcp}`。
- 各 runtime 探测/启动方式：
  - Penpot：`docker compose -f <root>/penpot/compose.yaml up -d`，`httpReady http://localhost:9001`（`PENPOT_ORIGIN`，`src/shared/professional-tools.ts:17`）。
  - Blender：`discoverPortableExecutable` 找 `blender.exe` → spawn `--online-mode`（官方 Lab MCP 扩展自带 Auto Start）→ `tcpReady 127.0.0.1:9876`。
  - FreeCAD：spawn `FreeCAD.exe` → `tcpReady 127.0.0.1:9875`（neka-nat/freecad-mcp addon `auto_start_rpc=true`）。
  - Ardot：spawn `Ardot.exe` → ready `127.0.0.1:50501`（HTTP MCP endpoint）。
- 生命周期：`stopOwned()` 只杀本 Runtime spawn 的 child（app quit 钩子 `src/main/index.ts:937`）；Penpot Docker 不随 app 停。

### 1.5 MCP 配置层（外部 MCP 如何进入 Pi）

- `McpConfigService`（`src/main/mcp/McpConfigService.ts`）：配置优先级 shared-global `~/.config/mcp/mcp.json` → agents-global → pi-global `~/.mybuddy/mcp.json`（**本服务管理目标**）→ 兼容 imports；`installServers / removeServers / setServerEnabled` 已有（450-530），IPC `McpIpc.install/remove`（`src/shared/agent-ipc.ts`）。
- `McpServerEntry` 支持 `command/args/env/cwd/url/disabled/modes/directTools`（`McpConfigService.ts:50-72`）。
- 用户机 `~/.mybuddy/mcp.json` 现有设计条目（实证）：`penpot` = URL `http://localhost:9001/mcp/stream?userToken=…` + `modes:["design"]`；`blender` = `uv run --project <root>/mcp/blender_mcp/mcp blender-mcp` + env `BLENDER_PATH/BLENDER_MCP_HOST/PORT`；`freecad` = `uvx freecad-mcp`；`ardot-local` = URL。
- 出厂捆绑扩展仅 `extensions/mcp/{serena,codegraph}`（`BundledMcpExtensions.ts`；`McpIpc.installBundled`）。

### 1.6 Artifact / Preview / Capture Mode（设计模式直接相关部分）

- Artifact 域：`ArtifactKind = markdown|code|html|svg|image|pdf|office`；`ArtifactSource = workspace-file | managed-content`（`src/shared/artifact-types.ts:8-33`）。**Artifact 是任务内（taskId 必填）的**。
- 唯一创建通道：AgentService `emitArtifactFile`（`src/main/agent/AgentService.ts:2064-2150`）——`assertPathInsideTask(taskRoot, filePath)` 边界断言 → `previewWorkspaceFile` → `artifactService.register({workspaceFile:{entryFile,rootDir},…})`。回合末 `emitChangedArtifacts` 增量刷新。
- 预览链路：`ArtifactPreviewHost`（WebContentsView、sandbox、`mybuddy-artifact://` 协议、新窗口/外链一律系统浏览器）→ `WebArtifactRuntime`（`resolveWithinRoot(root, subPath)` 防越界）→ `NativeSurfaceCoordinator`（显示决策唯一入口）。
- 浏览器承载：`BrowserHost`（`persist:extension-browser` partition，`http(s)` 站内导航，Penpot SPA 用）`src/main/browser/BrowserHost.ts`；renderer 侧 `BrowserView.tsx`（空态文案「从『网页原型 · Penpot』打开浏览器」）。
- **Capture Mode 与顶层 Design Mode 的边界（实证）**：Capture Mode 是**预览/浏览器表面上的元素抓取工具**，不是顶层模式——`CaptureModeController`（artifact WCV）+ `BrowserHost.enterCapture`（browser）共享 `CdpElementInspector`；产出 `SelectionDescriptor` → `SelectionStore`（唯一 truth，`src/main/index.ts:740-860`）→ `PromptContextService.collectForChat` 把选中元素上下文注入聊天。`BROWSER_CAPTURE_ARTIFACT_ID = "extension-browser"`（`BrowserHost.ts:21`）。它与 welcomeMode 正交：任何模式下都能对 HTML 产物/浏览器抓取，只是设计模式最常用。**OD 接入不触碰此边界**（OD 项目 HTML 进 PreviewHost 后天然可被抓取）。

---

## 2. OpenDesign 官方仓库（已验证事实，main@0.18.2）

> 依据：`github.com/nexu-io/open-design`，Apache-2.0（LICENSE），源码路径均相对仓库根。npm 上**未发布**（`@open-design/daemon` 404）。

### 2.1 架构定位

- 「开源 Claude Design 替代」：本地优先桌面应用（macOS/Windows，`apps/desktop` = Electron 41）+ daemon（`apps/daemon`）+ 200 个左右 SKILL 技能（`skills/`）+ 品牌设计系统（`design-systems/`，含 `_schema/`）。
- **Adapter 架构是核心决策**（`docs/agent-adapters.md`）：OD 把整个 agent loop（模型调用/工具/上下文/权限/恢复）委托给用户已装的代码 agent CLI；每个 CLI 是一个纯数据 `RuntimeAgentDef`（`apps/daemon/src/runtimes/defs/<cli>.ts`），通用引擎负责探测/启动/流式解析。当前 ~25 个适配器，`streamFormat: "pi-rpc"` 的是 pi。

### 2.2 Pi adapter（官方对 pi 的支持，供理解、不采用其方向）

- `apps/daemon/src/runtimes/defs/pi.ts`：探测 `pi --version`（Windows 超时放宽到 15s）；模型 `pi --list-models`（TSV）；调用 `pi --mode rpc [--model] [--thinking off|…|xhigh] [--append-system-prompt <dir>…]`，prompt 走 stdin JSON-RPC。
- `apps/daemon/src/agent-protocol/pi-rpc/session.ts`：`prompt` 命令（可选 base64 `images`，≤10 张 / ≤20MB，realpath 防 symlink 逃逸）；`new_session {parentSession}` 续会话（跟踪 `.pi/sessions/*.jsonl` 变化）；`extension_ui_request` 自动应答（confirm→true、select→首项、fire-and-forget 吞掉）；`agent_end` 后关 stdin + `PI_GRACEFUL_SHUTDOWN_MS`(默认 5s) SIGTERM。
- `docs/agent-adapters.md §5.10` 明确：OD 的 pi 集成是**OD 主控、pi 执行**的单轮跑批语义（`/api/chat` single-shot）。

### 2.3 CLI（`od`）与 daemon

- 入口 `apps/daemon/bin/od.mjs` → `dist/cli.js`；根 package.json `bin: {od}`，`packageManager: pnpm@10.33.2`，`engines.node: "~24"`。
- 子命令全集（`cli.ts:372-402`）：`artifacts media mcp amr collab research plugin ui marketplace share brand(s) project workspace automation memory run files templates conversation chat deploy daemon atoms skill(s) design-systems resource craft diagnostics export status version doctor config library figma`。
- daemon：默认 `127.0.0.1:7456`（`OD_PORT` 可覆盖，`daemon-startup.ts:49`）；`od daemon start [--headless] [--serve-web] [--port <n>]`、`od daemon status [--json]`、`od daemon stop`、`od daemon db status|verify|vacuum`。
- 数据目录：默认 `<projectRoot>/.od`，`OD_DATA_DIR` 覆盖（`app-config.ts:163-165`）；项目在 `PROJECTS_DIR`（`<data>/.od/projects/`），支持外部 baseDir 项目（`projects.ts:86-129`）。
- `od run start --project <id> --message … [--agent claude|codex|opencode|…] [--model] [--follow]`：**OD spawn 自己的 inner agent 执行生成**；`od run watch <runId>` ND-JSON 流；`od run info/list/cancel/continue`。
- `od export <file> --project <id> --format html|pdf|image|pptx …`（CLI 无模型渲染导出；pdf 走截图渲染管线保 CJK）。
- `od mcp install <agent>`（`mcp-agent-install.ts`）：三策略——`cli`（claude/codex 用自家 `mcp add`）、`json`（cursor/copilot/opencode/… 深合并 JSON 配置）、**`manual`（pi / hermes / vibe：只打印 snippet，不写配置，理由 "config path/schema is not authoritatively documented"）**。pi 的 manual 给 `configPath: ~/.pi/agent/mcp.json` + `mcpServers` snippet——**MyBuddy 的 `~/.mybuddy/mcp.json` 正是 pi-global 层，官方没覆盖，我们自管**。
- MCP 安装 payload（`mcp-install-info.ts:55-115`）：`command = process.execPath`（打包 app 时 = Electron + `ELECTRON_RUN_AS_NODE=1`），`args = [<cliPath>, "mcp", "--daemon-url", "http://127.0.0.1:<port>"]`，`env = {OD_DATA_DIR, …}`；sidecar 模式（桌面 app）省略 `--daemon-url`，靠 `OD_SIDECAR_IPC_PATH` 每次发现。

### 2.4 stdio MCP 服务器（`od mcp`）——接入核心

- `apps/daemon/src/mcp.ts`：`@modelcontextprotocol/sdk` 的 `StdioServerTransport`；**无状态、不碰文件系统**，每个工具 = `fetch()` daemon HTTP；`MCP_STDIO_IDLE_EXIT_MS = 30min` 空闲退出；daemon 不可达时读类工具自动重试（`SAFE_MCP_DAEMON_RETRY_CALLS`），**写类工具不重放**（防重复提交，`createMcpDaemonTarget.call`）。
- `od mcp` 无 `--daemon-url` 时经 `mcp-bootstrap.ts ensureMcpDaemonUrl`：flag → `OD_DAEMON_URL` → `OD_SIDECAR_IPC_PATH` → `http://127.0.0.1:7456`；**packaged 安装时若 daemon 未跑会自动以 `--headless` 拉起**（`--headless` 校验在 `OD_MCP_BOOTSTRAP_COMMAND/ARGS`）。
- 工具清单（21 个，`mcp.ts` 实证）：
  - 项目/文件读：`list_projects` `get_project` `get_active_context` `list_files` `get_file` `get_artifact`(entry+引用同级打包) `search_files`
  - 项目/文件写（**只限 OD 项目内**，path 经项目根解析+嵌套支持）：`create_project` `create_artifact`(需 artifactManifest 语义，拒绝已存在) `write_file`(可覆盖，迭代用) `delete_file` `delete_project`(需 confirm:true)
  - 生成委托：`list_skills` `list_plugins` `start_run`(返回 runId，`requestId` 幂等，`resume:true` 续跑) `get_run`(状态 queued|running|succeeded|failed|canceled + previewUrl/agentMessage) `cancel_run` `list_agents`(只列本机可用的 inner agent)
  - brief/认证：`collect_brief` `confirm_brief` `get_vela_login_status` `start_vela_login`（OD Cloud 计费账户）
- 读写限制实证：`write_file/create_artifact/delete_file/delete_project` 在 `MUTATING_TOOLS`（mcp.ts:2004-2012）；MCP instructions 明确「不要用 write_file 替代 start_run（丢掉设计质量管线）」；`start_run` 生成 5–30 分钟，要求外层 agent 每 30–60s 轮询并报告 "still working"。
- 资源：`od://design-systems/...` 等 resource 通道（技能/设计系统作为只读参考材料）。

### 2.5 技能 / DESIGN.md

- `skills/` 根目录 ~200 个 SKILL.md（`design-brief` `design-review` `design-md` `web-artifacts-builder` `frontend-design` `imagegen` `brand-extract` 等；frontmatter 带 `od: {mode, category, upstream}`）。
- 运行时：技能目录**真实拷贝**到 `<cwd>/.od-skills/<basename>-<hash>/`（非 symlink，防 agent 编辑污染源），prompt 给相对路径 + 绝对源路径（`agent-adapters.md §4`；`skills.ts`、`cwd-aliases.ts`）。
- DESIGN.md：`skills/design-md`（Google Labs Stitch 策展）+ `apps/daemon/src/brands/design-md.ts`（`brandToDesignMd`：品牌 → YAML frontmatter 的 tokens/fonts/colors）+ `docs/examples/DESIGN.sample.md` + `docs/design-systems.md`。设计系统是「项目级 DESIGN.md = 品牌契约」+ 全局品牌库。

### 2.6 桌面应用与 Windows

- `apps/desktop`（Electron 41）：打包应用内 CLI 位于 `<resources>/open-design/bin/`（`daemon-paths.ts` 的 Windows marker 实证）；sidecar 模式经 `OD_SIDECAR_IPC_PATH` 与 daemon 通信。
- Windows 是官方支持的（README：native desktop app for macOS and Windows；`docs/windows-troubleshooting.md`）。
- 安装途径：① open-design.ai 下载打包应用；② 源码：Node 24 + pnpm 10.33.2 + `pnpm bootstrap`（`scripts/postinstall.mjs`）。**无 npm 包**。

---

## 3. 接入方案（建议设计）

### 3.1 总体形态与原则映射

| 原则 | 落地 |
|---|---|
| Pi 仍是唯一主 Agent | MyBuddy 的 Pi 会话通过 `od mcp` 工具（或 `od` CLI）调用 OD；**不启用 OD 的 pi adapter 方向**（那是 OD spawn pi）。OD 内层 `start_run` 委托的 inner agent 与本方案解耦（可禁用，见 3.5） |
| OD = Design Mode 的 AI Design Engine | 新增 design preset「AI 设计引擎 · OpenDesign」（`opendesign`），与 ardot/penpot/blender/freecad 平级；会话内 Pi 用其 MCP 工具做设计工作 |
| 本地 stdio MCP 不经过 pi-chatgpt-bridge | MCP 条目 `command/args` 直连本机 daemon（`http://127.0.0.1:<port>`），与 bridge 无任何共享路径；入口文件只有 `~/.mybuddy/mcp.json` |
| 不做表面 Skill | 落地 = Runtime（探测/拉起/状态）+ MCP 条目写入 + preset + prompt 段 + 产物回接 Artifact，五件套齐 |
| 不套娃 OD Electron | MyBuddy 只与 `od` CLI/daemon 交互；OD 桌面/Web UI 仅作为 `open()` 的可选外部窗口（复用 BrowserHost 打开其 webBaseUrl） |
| 不破坏 Penpot/Blender/FreeCAD 边界 | `opendesign` 是独立 preset，mcpPolicy allow 只放行 `opendesign`；`general` preset 的排除清单自动覆盖（`DESIGN_PROVIDER_MCP_IDS` 追加） |
| 复用 Artifact/Preview | OD 项目文件经两条路径进入现有 Artifact 域（3.4），PreviewHost 零改动 |

### 3.2 新增/修改模块清单（下一步开发直接可执行）

| 文件 | 改动 |
|---|---|
| `src/shared/mode-profile.ts` | `DESIGN_PROVIDER_MCP_IDS` 追加 `"opendesign"`（general 排除与 UI 判断自动生效） |
| `src/shared/professional-tools.ts` | `PROFESSIONAL_TOOL_PROVIDER_IDS` 追加 `"opendesign"`；新增常量 `OPENDESIGN_DAEMON_ORIGIN = "http://127.0.0.1:7456"`、`OPENDESIGN_DEFAULT_PORT = 7456`、`OPENDESIGN_PROJECTS_SUBDIR = ".od/projects"`（说明性） |
| `src/main/agent/mode-defaults.ts` | `DESIGN_MODE_PRESETS` 追加：`{id:"opendesign", label:"AI 设计引擎 · OpenDesign", providerMcpIds:["opendesign"], mcpPolicy:{mode:"hard", allow:["opendesign"], deny:[]}, skillPolicy:{prefer:["design","ui","DESIGN.md"], allow:[]}, promptAddon:"…使用 OpenDesign 设计引擎：可用 list_projects/get_artifact/write_file/start_run 等 MCP 工具；产出 HTML/MD/SVG/PDF/PPTX 设计产物，保持在设计工作流内；真实网页源码改动属于 Code Mode"}` |
| `src/main/professional-tools/ProfessionalToolRuntime.ts` | 新增 `OpenDesignRuntime extends BaseRuntime`（探测/启动/停止/open，见 3.3）并注册进 `ProfessionalToolRuntimeService`；`stopOwned()` 语义：只杀本 Runtime spawn 的 daemon（用户自启实例不碰） |
| `src/main/mcp/McpConfigService.ts` | 复用 `installServers/removeServers`；新增辅助 `ensureOpenDesignServer(payload)`：若 `mcpServers.opendesign` 缺失/内容过期则写入（含 `modes:["design"]`、`disabled:false`） |
| `src/main/agent/AgentService.ts` | **无必改**：provider gate / `prepareForProvider` 自动覆盖 opendesign（`isProfessionalToolProvider` 生效后）。可选：与 Penpot 类似，会话创建成功后可 `open()` OD web 页面（`if providerId==="opendesign"`） |
| `src/main/artifact/ArtifactService.ts` | 可选新增 `registerExternalProject(input)`：越界允许的 workspace-file 注册通道（供「预览 OD 项目」入口；不走 `AgentService.emitArtifactFile` 的 taskRoot 断言，由 UI 显式触发） |
| `src/renderer/src/lib/modePresetBar.ts` | `providerDisplayName` 加 `opendesign: "OpenDesign MCP"` |
| `src/renderer/src/components/settings/*`（MCP/专业工具卡片） | 状态卡片复用现有 provider 卡片模式；无新增概念 |
| `docs/opendesign-integration.md` | 用户文档（安装指引/会话用法/降级说明） |

### 3.3 OpenDesignRuntime 行为定义（仿 NativePortableRuntime）

- **探测（status）**，按序：
  1. `od daemon status --json`（`od` 在 PATH；`--daemon-url` 覆盖端口）→ 可达且 healthy = `ready`；
  2. TCP `127.0.0.1:<port>` 探测（`defaultTcpReady` 复用）→ `ready`；
  3. CLI 探测：PATH `od` → `MyBuddyTools/open-design/bin/od` / `MyBuddyTools/open-design/dist/cli.js` → 打包 OD 桌面 app 的 `<resources>/open-design/bin/`（`resolveProcessResourcesPath` 同款 marker 逻辑，`daemon-paths.ts` 实证）→ 缺失 = `missing`（detail 给安装指引：open-design.ai 下载或源码 Node24+pnpm bootstrap）。
- **启动（start）**：`spawn(od, ["daemon","start","--headless","--port", String(port)], {env:{...process.env, OD_PORT: String(port), OD_DATA_DIR: <mybuddy-od-data>}})` + `unref()`；`waitReady` 用 `od daemon status --json` 或 TCP。端口冲突时回退：`OD_PORT=0` 不可行（daemon 固定语义）→ 优先探测 7456，被占用时依次尝试 7457-7466。
- **数据目录**：默认 `~/.mybuddy/od-data`（`getMyBuddyDir()/od-data`），显式 `OD_DATA_DIR`，与 MyBuddy 其它数据同区；项目即 `<od-data>/projects/<id>/`。
- **connectMcp**：复用 `BaseRuntime.connectMcp`（校验 MCP 条目已配置且启用）。
- **open()**：`shell.openExternal` OD webBaseUrl（`http://127.0.0.1:<port>`，`--serve-web` 时）或桌面 app 深链；失败不阻断会话。
- **stop/stopOwned**：`od daemon stop --daemon-url …` 只停自己 spawn 的；用户自启实例不动（与 Penpot Docker 同哲学）。

### 3.4 数据流（一次完整设计会话）

```
[设计任务] user 选「AI 设计引擎」preset → 发首条消息
  → AgentService.createSession
      → 专业 provider gate：opendesign ∈ allowedProviders（mcpPolicy allow）
      → OpenDesignRuntime.prepareForProvider：探测 daemon → 未跑则 spawn `od daemon start --headless` → waitReady
      → assemblePrompt：mode 段 + preset promptAddon（+ 可选：若任务目录有 DESIGN.md 则注入摘要段）
      → pi-mcp-adapter 注入 opendesign stdio MCP（filterMcpConfigForMode 白名单只放行它）
[运行中] Pi（主 Agent）用 MCP 工具：
      → create_project(name, designSystem?) 建 OD 项目（或 list_projects 复用）
      → write_file / create_artifact 迭代 HTML/MD/SVG 产物（Pi 自绘）
      → （可选增强）start_run(prompt, requestId) 委托 OD 生成 → get_run 轮询 → 产物落在 OD 项目
      → get_file / get_artifact 读回内容
[回接 MyBuddy] 两条路径：
      A（主）：Pi 把最终产物 write 到任务目录 → 现有 emitArtifactFile 自动注册 → 消息下方 ArtifactChip → ArtifactPreviewHost 预览（HTML 可 Capture Mode 抓取，全链路零改动）
      B（可选）：renderer「打开 OD 项目」→ main 侧 registerExternalProject（workspace-file，rootDir=OD 项目目录）→ PreviewHost 直读 OD 项目文件（零复制；OD 每次写盘自动刷新 via refresh）
[收尾] app quit → stopOwned()；daemon 常驻不随任务结束杀
```

### 3.5 OpenDesign 能力采用/不采用清单

**采用（按优先级）**：
1. `od mcp` stdio 服务器全部读写/项目工具（create_project / list_projects / get_artifact / get_file / write_file / create_artifact / delete_file / search_files / list_skills / list_agents）。
2. `od daemon start --headless` + `od daemon status`（MyBuddy 托管 daemon 生命周期）。
3. DESIGN.md / design-systems 作为**提示词资源**：Pi 读取项目 DESIGN.md 或 `od://design-systems/...` 资源作为品牌契约；可让 Pi 执行 `design-md` 技能流程产出 DESIGN.md。
4. OD skills（`list_skills` 发现 + 读 SKILL.md 内容）：**由 Pi 读取并自行执行**（Pi 是主 Agent，不走 OD 的 inner-agent 执行）。
5. `start_run/get_run/cancel_run`（Phase 2 可选）：把重度生成（5–30 分钟、多轮)委托给 OD 引擎时启用——注意这会引入 OD 检测到的 inner agent（可能是本机 claude/codex/…），**默认关闭**，作为设置项；`list_agents` 用于展示。
6. `od export`（Phase 3 可选）：HTML → PDF/PPTX/PNG，落回任务目录注册为 pdf/office artifact。

**不采用（及原因）**：
- OD 的 pi adapter 方向（`od` spawn `pi`）——主从颠倒；与「Pi 唯一主 Agent」冲突。
- OD Electron/Web UI 套娃——重量级、双 Agent UI 冲突；只保留 `open()` 外链。
- `collect_brief/confirm_brief`——面向无 UI outer agent 的交互卡片；MyBuddy 有完整对话 UI，由 Pi 直接向用户澄清。
- `get_active_context`——MyBuddy 有自己的 active task/artifact 语义。
- `get_vela_login_status/start_vela_login`（OD Cloud 计费）——除非用户启用 OD Cloud 模型服务，本地生成不需要。
- `od media`（fal/venice 等图像/视频生成）、plugins、automations、collab、memory——超出 Design Mode 范围，后续作为独立扩展再评估。
- MCP 内 `artifactManifest` 强约束路径（`create_artifact` 拒绝已存在文件）——日常迭代用 `write_file`（官方 instructions 也推荐）。

### 3.6 Windows 安装 / 探测 / 失败降级

- 安装引导（设置卡片内）：① 下载官网 Windows 打包版（推荐，自带 Node runtime，`od` 在 `<resources>/open-design/bin/`）；② 源码（Node 24 + corepack pnpm + `pnpm bootstrap`）。
- 探测链：`od` on PATH（`od --version`）→ `MyBuddyTools/open-design/bin/od.mjs` / `dist/cli.js`（含一级版本子目录，复用 `discoverPortableExecutable`）→ 打包 app 的 `<resources>/open-design/bin/` → 常见安装目录。
- MCP 条目写入（`~/.mybuddy/mcp.json`）：
  ```json
  "opendesign": {
    "command": "<node-or-electron>",
    "args": ["<cli.js>", "mcp", "--daemon-url", "http://127.0.0.1:7456"],
    "env": { "OD_DATA_DIR": "C:\\Users\\<u>\\.mybuddy\\od-data" },
    "modes": ["design"],
    "disabled": false
  }
  ```
  打包 app 场景需 `ELECTRON_RUN_AS_NODE=1`；优先取 OD 自身 `/api/mcp/install-info` 的 payload（`buildMcpInstallPayload` 同款；注意该端点 `isLocalSameOrigin` 校验，实现时用 `Host: 127.0.0.1:<port>` 头验证），失败则本地方案 A：`command=<od 解析路径>`、`args=["mcp","--daemon-url",…]`（`od` 是 node shebang，Windows 上可由 pi-mcp-adapter 经 `cmd`/node 拉起——实现时验证 adapter 的 spawn 语义，必要时换 `command=<node.exe>` 直启）。
- 失败降级（全部已有机制复用）：
  - OD 未安装/daemon 起不来 → `prepareForProvider` 抛错 → 会话创建被阻断并给出 detail（现状行为，`AgentService.ts:1730-1745`）。
  - preset bar：`providerMcpIds` 的 MCP 未配置/停用 → chip disabled + title 提示（`modePresetBar.ts:37-48`，零改动生效）。
  - 用户不想用 OD → 切回 `general` 或其它 preset（并行，不影响 Penpot/Blender/FreeCAD）。
  - daemon 中途退出 → 下一次 MCP 调用 `od mcp` 会报 daemon unreachable；读工具自动重试逻辑在 OD 侧；MyBuddy 侧 Runtime.status 轮询恢复（可选：会话内提示重试）。

### 3.7 测试点

1. **纯函数单测**（扩展现有 `scripts/mode-preset-test.ts` / `scripts/professional-tools-test.ts`）：
   - opendesign preset 合成：allow 交集（base 空 allow → preset allow 生效；general 排除清单含 opendesign）；promptAddon 注入 appendParts。
   - `filterMcpConfigForMode`：opendesign 条目在 design 模式 enabled、coding/working 模式 hidden（modes 过滤）。
   - `OpenDesignRuntime`（mock ops）：探测链优先级、missing detail、start→waitReady（fake tcp/status）、stopOwned 只杀自有 child、端口回退。
2. **配置层**：`McpConfigService.ensureOpenDesignServer` 幂等（存在不覆盖/过期重写）、`removeServers` 清理。
3. **e2e（真实 OD 可选装）**：design 任务 → `od mcp` list_projects → write_file 建 HTML → `get_artifact` 读回 → Pi write 到任务目录 → artifact 出现 → PreviewHost 打开 → Capture Mode 抓取仍可用。
4. **降级矩阵**：OD 未装（preset disabled + 会话报错文案）；daemon 手动 kill 后 MCP 调用行为；7456 端口被占用的回退。
5. 回归：`pnpm run test:mode / test:mode-preset / test:mcp-mode / test:professional-tools / test:capture-mode` 全绿（新增 provider 不应破坏既有 5 个 preset 语义）。

---

## 4. 下一步实现顺序

| 步骤 | 内容 | 验收 |
|---|---|---|
| P0 | 本方案评审（尤其 3.4 的产物回接 A/B 与 3.6 MCP 条目 command 形态） | 确认后开工 |
| P1 | `mode-profile.ts` + `mode-defaults.ts` + `modePresetBar.ts` 三处声明（provider id / preset / 显示名）+ 纯函数单测 | `test:mode*` 绿 |
| P2 | `McpConfigService.ensureOpenDesignServer` + `McpModeFilter` 测试 | 配置层单测绿 |
| P3 | `OpenDesignRuntime` + 注册进 `ProfessionalToolRuntimeService` + 单测 | `test:professional-tools` 绿 |
| P4 | 本机安装 OD（官网打包版或源码），手工 e2e：design 会话 → MCP 工具 → 产物回接 → 预览 | 端到端演示通过 |
| P5 | 可选：`registerExternalProject`（预览 OD 项目）+ UI 入口 | artifact-open 测试扩展 |
| P6 | 文档 `docs/opendesign-integration.md` + 降级验证矩阵 | 文档与验收齐 |

---

## 5. 证据索引（关键文件/符号）

- MyBuddy：`src/shared/mode-profile.ts`（WelcomeMode/ModePolicyDto/ModePresetDto/DESIGN_PROVIDER_MCP_IDS/resolveEffectiveModePolicy）、`src/main/agent/mode-defaults.ts`（MODE_SEEDS/DESIGN_MODE_PRESETS）、`src/main/agent/ModeProfileStore.ts`（getProfile/ensureMaterialized）、`src/main/agent/PromptAssembly.ts`（assemblePrompt/resolveSessionTools）、`src/main/agent/AgentService.ts:1684`（createSession）/`:1715`（provider gate）/`:2064`（emitArtifactFile）、`src/main/mcp/McpModeFilter.ts`（filterMcpConfigForMode）、`src/main/mcp/McpRuntimeService.ts:88`（getInlineExtensions）、`src/main/mcp/McpConfigService.ts:468`（installServers）、`src/main/professional-tools/ProfessionalToolRuntime.ts`（Runtime 家族/resolveToolsRoot/discoverPortableExecutable）、`src/main/artifact/*`（ArtifactService/ArtifactPreviewHost/WebArtifactRuntime/CaptureModeController）、`src/main/browser/BrowserHost.ts:21`（BROWSER_CAPTURE_ARTIFACT_ID）、`src/renderer/src/lib/modePresetBar.ts`、`src/renderer/src/store/appStore.ts:653`（setWelcomeMode）
- OpenDesign：`docs/agent-adapters.md`（§5.10 pi）、`apps/daemon/src/runtimes/defs/pi.ts`、`apps/daemon/src/agent-protocol/pi-rpc/session.ts`、`apps/daemon/src/cli.ts:372`（SUBCOMMAND_MAP）/`:1893`（runMcp）、`apps/daemon/src/mcp.ts`（21 工具/SAFE_MCP_DAEMON_RETRY_CALLS/MUTATING_TOOLS）、`apps/daemon/src/mcp-install-info.ts:55`（buildMcpInstallPayload）、`apps/daemon/src/mcp-agent-install.ts:315`（pi=manual）、`apps/daemon/src/mcp-bootstrap.ts`（ensureMcpDaemonUrl/headless 拉起）、`apps/daemon/src/app-config.ts:163`（OD_DATA_DIR）、`apps/daemon/src/daemon-paths.ts`（Windows resources marker）、`apps/daemon/src/brands/design-md.ts`、`skills/design-md/SKILL.md`、`apps/desktop/package.json`（Electron 41）
