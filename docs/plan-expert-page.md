# 专家页（Expert Center）规划（已实施）

> 状态：**2026-08-06 已全部实施**（P0 服务层 + P1 页面 + P2 召唤 + P3 专家团），typecheck/build 通过，`pnpm test:expert` 42 项断言全过。
> 用户拍板：①做官方 .codebuddy-plugin 格式兼容导入 ②MVP 一次做 P0~P3 ③内置中文办公示例（周报/数据分析/文档润色）④召唤=新建会话（官方模式）+ 会话中途切换专家。
> 实施记录见 STATUS.md「Hub 专家」；本文件保留调研结论与决策依据。

---

## 1. 调研结论（GitHub + 官方）

### 1.1 官方 MyBuddy 的「专家」定义

来自官方文档（mybuddy.cn/docs/.../Expert-Center）：

| 维度 | Skill（技能） | 专家（Agent 型） | 专家团（Team 型） |
|---|---|---|---|
| 本质 | 工具能力：让 AI 能做某事 | AI 顾问：懂某个领域的 AI 角色（人设+方法论+工具链） | 协作团队：自动拆解、并行执行、完整交付 |
| 适用 | 需要某种工具能力 | 明确的单点问题 | 复杂、多角色配合 |
| 定位 | 能力 | 能力 + 经验 | 多位专家 + 协作流程 |

- 专家是「角色切换」机制：以特定领域专家身份执行任务；**专家本身不主动获取系统权限**，配备 Skill/MCP 后才在授权下间接访问文件/外部服务。
- 专家中心 = 市场（按行业分类浏览 + 召唤）；我的专家 = 自建/导入/分享。
- 专家卡片展示：能力介绍、擅长领域、任务示例。
- 使用流：侧边栏「专家」→ 选专家 → 召唤 → 进入对话描述任务。

### 1.2 GitHub 上的专家生态（可兼容导入）

- **YuSec2021/senior-ai-agent** — "MyBuddy Expert 插件"样例，格式为：
  ```
  senior-ai-agent/
  ├── .codebuddy-plugin/plugin.json   # 专家配置：name/tags/prompts
  ├── agents/senior-ai-agent.md       # 角色定义 + Prompt（人设/方法论）
  ├── avatars/expert.png              # 头像
  └── README.md
  ```
  安装路径：`~/.mybuddy/plugins/marketplaces/my-experts/plugins/<name>/`，
  官方导入方式：专家中心 → 我的专家 → 导入专家（zip）。
- **masx200/codebuddy-plugins-official** — CodeBuddy 官方插件市场镜像（含大量 agent 型插件）。
- **tyanxie/t-code-agent-plugins** — CodeBuddy Code 插件集（社区）。

> 结论：官方专家 = **"agent 型插件"**，核心是一个角色 markdown + plugin.json 元信息。
> GitHub 生态已有现成专家包，格式简单，本应用可以做**格式兼容导入**，直接吃生态存量。

### 1.3 官方 App 交互实现（.wb-ref 源码）

- 专家入口在侧边栏（与技能/连接器并列，"专家·技能·连接器"）。
- **召唤入口在对话输入区**：expert-option 子菜单、最近使用专家列表（SummonExpertIcon）。
- 消息带 `expert_id / expertAgentId`，时间线有 expert-fold（专家结果折叠组展示）。
- 无头像时用首字母 + 渐变底色（EXPERT_AVATAR_GRADIENTS，6 组渐变）。

---

## 2. 本项目现状

- `HubPage.tsx` 专家 tab：`mockExperts`（空数组）→ 显示"暂无专家 / 市场安装流尚未接入"。
- `SkillsService.ts`（技能）已有完整模式可复用：BUILTIN_MARKET + listInstalled/listMarket/install/uninstall/启停 + IPC DTO。
- `AgentService.createSession` 用 `appendParts` 拼系统提示（人设/欢迎模式/shell/记忆规则）——**专家人设注入点就在这里**。
- 权限审批链路（permission-extension）、Skill/MCP 挂载均已存在——专家工具链直接复用，无需新权限体系。

---

## 3. 规划（分阶段）

### Phase 0 — 服务层 ExpertService（主进程）

新增 `src/main/experts/ExpertService.ts`，完全对齐 SkillsService 模式：

```
~/.mybuddy/experts/<expertId>/
├── expert.json     # { id, name, emoji, tags, author, version, category, examples[] }
├── prompt.md       # 角色提示词（人设 + 方法论 + 任务示例）
└── avatar.png      # 可选，无则 UI 用首字母+渐变（对齐官方）
```

- `listMarket()`：BUILTIN_EXPERT_MARKET 内置 3–5 个示例专家（如周报撰写/数据分析/文档润色，按行业分类）。
- `listInstalled()` / `install()` / `uninstall()` / `setEnabled()`。
- `importZip(zipPath)`：兼容官方 `.codebuddy-plugin/plugin.json + agents/*.md` 格式（可选增强，直接吃 GitHub 生态）；
  `exportZip()`：我的专家 → 分享包。
- IPC 通道：`expert:listMarket` `expert:listInstalled` `expert:install` `expert:uninstall` `expert:import` `expert:export`，DTO 入 `shared/agent-ipc.ts`。

### Phase 1 — 专家页 UI（渲染层）

- 专家 tab 重构为双分区（对齐官方「专家中心 / 我的专家」）：
  - **专家中心**：市场卡片（emoji 头像 / 名称 / 能力介绍 / 擅长领域 tags / 任务示例）+ 分类筛选 + 搜索；卡片按钮「安装」「召唤」。
  - **我的专家**：已安装列表（启用开关 / 卸载 / 导出），与技能页交互一致。
- store：`experts` / `marketExperts` / `installExpert` / `uninstallExpert` / `setExpertEnabled`（照抄 skills 的 store 写法）。
- 徽章/空态/忙碌态复用现有 CSS（expert-card 已存在）。

### Phase 2 — 召唤机制（运行时生效，核心价值）

- `AgentService.createSession` 增加 `expertId?: string`：`appendParts` 注入
  `## 专家角色\n（prompt.md 全文）`，替换/叠加默认人设。
- 会话上打 expert 标记（任务/会话模型加 `expertId` 列，侧栏/会话标题显示专家徽章）。
- 对话输入区加召唤入口（对齐官方 expert-option 子菜单 + 最近使用）。
- 工具链零改动：专家配的 Skill/MCP 走既有审批；无配技能时专家只处理对话与上传文件（对齐官方边界）。

### Phase 3（远期）— 专家团（Team 型）

- 多会话并行 + 团长拆解 + 结果聚合（本应用已有 CronService/多任务/artifact 基础，但复杂度高，先不做）。

---

## 4. 待用户拍板的问题

1. **格式兼容**：是否做官方 `.codebuddy-plugin` 兼容导入（吃 GitHub 生态存量）？→ 建议做，成本低（一个 zip 解包 + 元信息映射）。
2. **MVP 范围**：Phase 0+1+2 一次做完，还是先 0+1（服务+页面）验证再上召唤？
3. **专家与技能的关系**：页面是否展示"该专家推荐挂载的技能/MCP"（官方卡片有此信息）？
4. **内置市场内容**：示例专家用中文办公场景（周报/数据分析/文档润色）还是对齐官方（法务/财务/运营等）？
5. **召唤是否等于新建会话**：官方是"召唤进入新对话"；是否支持会话中途切换专家（提示词热替换）？
