# MyBuddy (`wavealstra_harness`)

MyBuddy (`wavealstra_harness`) 是一个基于 Electron + React + TypeScript 构建的开源桌面级 AI Agent 工作台，底层驱动内核采用 Pi coding-agent 1.3.0。

不同于传统的扁平聊天窗口，MyBuddy 将工作流组织为「项目（Project）→ 树形空间（Blueprint / Workspace）→ 任务（Task）」的多层级结构，通过情景模式（Scenario Mode）在会话初始化阶段硬性收紧 Skill 与 MCP 权限边界，并通过统一的 Memory Gateway 让桌面端会话与外部 CLI Agent 共享同一套多层记忆（L1/L2/L3），同时保持对 WorkBuddy / CodeBuddy 插件目录规范的兼容。

## Bot / Work 设计基线

2026-11-06 冻结 **BOT-WORK-1.0**：长期 bot 与对话、任务运行分离，独立事项承载目标与责任，后台复用 Durable。以下文件定义目标行为与完整交付条件；冻结不表示相关功能已经实现或通过验收。

- [Bot / Work 架构冻结设计](docs/bot-work-design.md)：对象、权威状态、前后台宿主、主动跟进、专家与团队协作，以及最新源码复核结论。
- [Bot / Work 冻结验收规范](docs/bot-work-acceptance.md)：行为场景、故障恢复边界、端到端故事与验收证据要求。

## 为什么开源

这个项目最初的目标是探索一套 WorkBuddy 的开源替代方案：沿用「工作区 + 插件生态 + 桌面 Agent」的核心理念，但在工程上按照更严格的项目制层级、权限围栏（Harness）与记忆协同边界来演进。

随着官方 WorkBuddy 生态的快速成熟，靠个人精力继续独立维护一个大而全的商业级桌面客户端已不现实。因此我将可公开的核心代码完整开源——这不是对标宣战，而是把经过实战打磨的半成品与架构设计交出来，欢迎感兴趣的开发者一起拆解、复用或参与改进。

### 1. 树形工作空间与正交项目制（Project & Blueprint Tree）

在 MyBuddy 中，AI 协作不是零散的对话列表，而是结构化的工程空间：

- **无限嵌套的空间树**（`src/main/blueprint/`）：Workspace 支持通过 `parentKey` 与 `children` 构建任意深度的树状目录。每个空间节点可独立挂载任务（Task）、本地文件作用域、知识库绑定（Library）以及交互式微件（Gadget）。
- **正交的 Project 域管理**（`src/main/project/`）：在执行工作区之上提供顶层 Project 抽象，统一管理参考材料、项目事件流与向量/语义检索（`src/main/retrieval/`），做到「项目知识沉淀」与「具体任务执行工作区」正交解耦。
- **有向无环任务编排**（`src/main/workgraph/`）：内置 Workgraph 引擎，支持复杂多步任务的依赖追踪、门禁校验（`src/shared/execution-verification.ts`）与失败恢复策略（`src/shared/execution-recovery.ts`）。

### 2. 情景模式与硬性权限收紧（Scenario Mode & Access Filter）

为了防止 Agent 工具爆炸导致的上下文污染与越权调用，系统在 `src/shared/mode-profile.ts` 与 `src/shared/mode-access-filter.ts` 中实现了会话级的能力过滤机制：

| 情景模式 | 标识 (`mode`) | 适用场景 | 策略重点 |
| --- | --- | --- | --- |
| 日常办公 | `working` | 默认模式，适用于文档处理、日常问答与综合检索 | 启用通用办公技能与基础知识库检索 |
| 代码开发 | `coding` | 软件工程、代码重构、终端调试与仓库分析 | 聚焦 Pi Code Mode、终端 PTY 与开发类 MCP |
| 自动化 / Bot | `bot` | 无人值守定时任务（Cron）、网关触发与后台流水线 | 严格收紧交互式弹窗权限，仅放行白名单受控工具 |

- **前置硬隔离**：每个情景模式（及自定义标签预设）均可绑定独立的 `skillPolicy` 与 `mcpPolicy`，支持白名单（`allow`）、黑名单（`hide` / `deny`），其中 MCP 策略支持 `hard` 级别——在会话创建时直接跳过 Adapter 注入，而非仅仅依赖 System Prompt 事后提醒。

### 3. 多层记忆内核与跨端协同（Multi-Tiered Memory Kernel）

记忆系统（`src/main/memory/`、`src/shared/memory-kernel.ts`、`src/shared/memory-gateway.ts`）彻底摒弃了各工具各自维护一份静态 `MEMORY.md` 的碎片化做法：

- **三级记忆架构**：
  - **L1（`MemoryRecord`）**：存储在本地 SQLite（`~/.mybuddy/app.db`）中的可寻址细粒度事实真源。
  - **L2 / L3（紧凑上下文投影）**：面向 LLM 上下文窗口与 MCP 工具描述自动生成的压缩视图，兼顾召回率与 Token 经济性。
- **严格的作用域与晋升机制**：记忆默认按 `Project → Workspace → Task` 树形定界；跨层级或跨工作区写入必须经过显式 `promote`（晋升）操作，防止单一任务的临时上下文污染全局项目记忆。
- **自动化演进管道**：内置对话回合记忆抽取、技能自主学习与修订（Skill Learning / Revision）以及混合语义检索管道。
- **桌面端与外部 CLI 共用真源**：外部 CLI Agent（参见 `src/main/external-agent/`）可通过 `shared-memory` 技能或 `mybuddy-memory` 接口接入同一个 Memory Gateway，实现桌面 GUI 与命令行工具的无缝记忆同步。

### 4. WorkBuddy / CodeBuddy 插件生态兼容

插件与专家系统（`src/main/plugins/`、`src/main/experts/`）尽量对齐主流插件目录规范，降低迁移成本：

- **专家包（Expert Packages）**：支持解析并安装标准 `.codebuddy-plugin/plugin.json` 清单、`agents/*.md` 角色定义及可选 `avatars/` 资源。
- **内置技能与市场管理**（`src/main/skills/`）：支持本地技能发现、生命周期管理与元数据同步，默认内置 `dimagent-debug`、`hello-buddy`、`weekly-summary` 等实用技能。
- **资产与凭据物理隔离**：所有已安装插件与技能资产统一落盘于 `~/.mybuddy/plugins/`；而模型 API Key 与 OAuth 令牌严格隔离在 `~/.mybuddy/auth.json` 及系统级密钥环中，绝不与插件目录混写。

### 5. 全栈桌面能力与外部连接器

- **Pi 内核深度集成**（`src/main/agent/`）：完整支持 Pi 会话流式映射、Code Mode 资产包装、多模型会诊（Multi-Model Consult，`src/shared/multi-model-consult.ts`）及子代理（Sub-agent）模型分流配置。
- **原生桌面工具箱**（`src/main/professional-tools/` 等）：
  - Computer Use：桌面环境感知与自动化控制（Linux 端使用 TypeScript + AT-SPI / Hyprland，控件发现与输入不依赖截图；见 [Linux Computer Use](docs/linux-computer-use.md)）。
  - 本地视觉与语音：本地 PDF/图像 OCR 路径与本地 Whisper 语音转写（`src/main/voice/`）。
  - 内嵌环境：受控浏览器（`src/main/browser/`）、集成终端 PTY（`src/main/terminal/`）、HTML 编辑与办公文档 / Artifact 预览（`src/main/artifact/`）。
- **多通道网关与远程协同**：
  - 消息连接器（`src/main/connectors/`、`src/main/gateway/`、`src/main/cron/`）：Slack Socket Mode、Webhook 与 Cron 调度。
  - 远程配对（`src/main/remote/`）：局域网 / 远程移动端或副屏客户端配对访问。

## 系统边界与已知限制（请勿误读）

在投入使用或二次开发前，请务必了解当前版本的真实工程边界：

1. **云端模型依赖**：本地 OCR 与本地 Whisper 仅负责视觉/语音预处理，不等于整机完全离线运行。若未配置本地推理后端，核心对话与推理仍需配置云端大模型 API Key 或 OAuth 鉴权。
2. **办公文档预览限制**：内置表格预览组件仅做结构与数据渲染，不会动态重算复杂 Excel 公式。
3. **跨平台桌面控制差异**：不同操作系统下的 Computer Use 能力并不完全对等；Linux 原生后端明确支持 Omarchy / Hyprland / Wayland；其他合成器、无可访问树或不可靠控件边界会报告具体能力限制。显式截图是独立观察能力，截图故障不会使语义操作或输入失效。
4. **自动化测试覆盖边界**：仓库中的 `pnpm test:all` 运行的是无头棘轮测试套件（Headless Ratchet Suite，用于锁死回归门禁），测试全绿不代表真实 GUI 交互、真实 Slack 线上连接或真实硬件 OCR 已完成端到端人工验收。
5. **插件生态兼容性**：「兼容 CodeBuddy 插件目录结构」指元数据解析与目录布局对齐，并不代表官方市场中的每一个第三方插件包均已在本项目中逐一回归测试过。

### 环境要求

- Node.js：`>= 24.0.0`（可参考仓库根目录 `.nvmrc`）
- 包管理器：`pnpm@12.14.0`（已在 `package.json` 的 `packageManager` 字段中声明，建议使用 Corepack 启用）
- 操作系统：需要具备真实图形桌面环境（Windows / macOS / Linux X11 或 Wayland）
- Linux 额外依赖：强烈建议安装并启用系统级 `libsecret`（如 GNOME Keyring 或 KWallet），以避免 Electron `safeStorage` 降级回退到明文级别的 `basic_text` 存储模式。

### 安装与启动

```bash
# 1. 克隆仓库
git clone https://github.com/qq824045252-ship-it/wavealstra_harness.git
cd wavealstra_harness

# 2. 安装依赖
pnpm install

# 3. 启动开发环境（支持主进程与渲染进程热重载）
pnpm dev
```

### 质量门禁与打包命令

```bash
# 运行全量 TypeScript 类型检查（涵盖 Main / Preload / Renderer / Scripts）
pnpm -s typecheck

# 运行无头棘轮测试套件（Memory Gateway、安全策略门禁、远程协议等）
pnpm -s test:all

# 构建产物并打包桌面客户端
pnpm build
pnpm -s pack:linux   # Linux 打包（Windows 环境可使用 pnpm -s pack:win）
```

## 仓库目录结构

```text
wavealstra_harness/
├── src/
│   ├── main/                 # Electron 主进程核心逻辑
│   │   ├── agent/            # Pi coding-agent 内核桥接与会话管理
│   │   ├── blueprint/        # 树形工作空间（Workspace Tree）与节点持久化
│   │   ├── project/          # 顶层 Project 域管理、材料与事件流
│   │   ├── memory/           # L1/L2/L3 多层记忆内核、抽取管道与 Memory Gateway
│   │   ├── mcp/              # MCP Server 生命周期、策略门禁与动态注入
│   │   ├── skills/           # 技能发现、内置技能市场与生命周期管理
│   │   ├── plugins/          # WorkBuddy / CodeBuddy 兼容插件管理器
│   │   ├── experts/          # 专家角色（Expert Persona）解析与绑定
│   │   ├── workgraph/        # 任务 DAG 编排器与执行状态追踪
│   │   ├── connectors/       # 外部消息网关连接器（Slack Socket Mode 等）
│   │   ├── gateway/          # 消息网关实现
│   │   ├── cron/             # 定时任务调度引擎
│   │   ├── professional-tools/ # 原生专业工具入口
│   │   ├── platform/         # 跨平台能力（含 Computer Use）
│   │   ├── voice/            # 本地 Whisper 语音转写服务
│   │   ├── browser/          # 内嵌受控浏览器服务
│   │   ├── terminal/         # 集成终端 PTY 会话管理
│   │   ├── remote/           # 远程配对与外部客户端连接服务
│   │   ├── security/         # 安全审计与相关策略
│   │   └── db/               # SQLite 数据库初始化与迁移（~/.mybuddy/app.db）
│   ├── preload/              # Electron Preload 隔离桥接
│   ├── renderer/             # React 前端界面与状态存储
│   └── shared/               # 跨进程 IPC 契约、数据结构与安全策略定义
├── shared/                   # 工作区级共享类型与契约补充
├── extensions/               # MCP 等扩展载荷
├── integrations/             # 第三方 Agent 桥接器
├── scripts/                  # 类型检查、棘轮测试门禁与打包辅助脚本
├── diagrams/                 # 流程与架构示意 SVG
└── AGENTS.md                 # 仓库开发规范与 AI 协作改仓约定
```

## 本地数据目录（`~/.mybuddy/`）

应用运行时的状态、数据库与凭据统一存储在用户主目录下的 `~/.mybuddy/` 中，与源码仓库完全分离：

| 路径 | 用途说明 |
| --- | --- |
| `~/.mybuddy/app.db` | 核心 SQLite 数据库（存储项目、空间树、会话历史与 L1 记忆记录） |
| `~/.mybuddy/auth.json` | 模型服务商 API Key 与 OAuth 鉴权凭据（独立于插件目录） |
| `~/.mybuddy/plugins/` | 已安装的技能包与 WorkBuddy / CodeBuddy 兼容专家插件资产 |
| `~/.mybuddy/gateway/` | 消息网关（Slack 等）运行状态与持久化队列数据 |
| `~/.mybuddy/logs/` | 主进程、运行时审计与崩溃诊断日志 |

> 贡献与提交注意：请先阅读仓库根目录下的 `AGENTS.md` 了解代码规范与模块边界。本地评测产生的大体积产物（如大批量测试 runs 或 OCR 缓存数据）请勿提交进 Git 仓库。

## 许可证

[MIT](LICENSE) © 2026 WaveAlstra / MyBuddy contributors
