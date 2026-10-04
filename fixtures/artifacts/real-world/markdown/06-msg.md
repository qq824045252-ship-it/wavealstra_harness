<!-- __SANITIZED__ 来源: C:\Users\user\.mybuddy\sessions\--C--Users-user-Desktop-mybuddy--\2026-08-07T04-01-40-451Z_019fda62-4263-7b25-a5e0-a438598f36ac.jsonl | block:  | 长度: 6392 -->
# 场景模式 · MCP / 技能隔离（查阅备忘）

> 最后核对：2026-08-07 · 分支相关实现已在本仓库落地  
> 用途：下次查「三大类怎么区分、MCP/技能怎么只在某模式用、文件在哪、怎么测」

---

## 1. 一句话

| 层 | 是什么 |
|----|--------|
| **场景模式** `welcomeMode` | `working` 日常办公 / `coding` 代码开发 / `design` 设计创意 |
| **本质** | 同一 pi Agent runtime 上的 **ModeProfile 装配包**（文案 + 技能面 + MCP 面） |
| **不** | 不拆三套 Agent / 三套工作区 / 三套记忆 |

任务创建时绑定 `welcomeMode`（D1：有消息后锁定；换场景 → 新建或「复制为…」任务）。

---

## 2. 磁盘路径（用户可直接改）

```text
~/.mybuddy/
  mcp.json                          # mybuddy 全局已装 MCP
  modes/
    working|coding|design/
      README.md
      goal.md                       # 目标
      workflow.md                   # 工作流程
      delivery.md                   # 交付要求
      forbid.md                     # 禁止事项
      criteria.md                   # 验收标准
      policy.json                   # 技能 / MCP / 工具 / 场景芯片策略
```

- 应用启动或打开「设置 → 场景模式」时会 **物化** 缺失的 `.md`（已有文件不覆盖）。
- 设置 UI 可 **打开文件 / 打开文件夹**；外部编辑器改 `.md` / `policy.json` 后，**仅新任务生效**。
- 出厂种子在代码：`src/main/agent/mode-defaults.ts`（`MODE_SEEDS`）。

Windows 示例：`C:\Users\<你>\.mybuddy\modes\working\goal.md`

---

## 3. policy.json 里两套名单

### 3.1 MCP：`mcpPolicy`（会话硬隔离）

```json
"mcpPolicy": {
  "mode": "hard",
  "allow": [],
  "deny": ["serena", "codegraph"]
}
```

| 字段 | 含义 |
|------|------|
| `mode: "hard"` | 本会话 **不加载** 被拒的 MCP（不进 `createMcpAdapter` config） |
| `mode: "soft"` | 仍加载，只记 hidden（调试用，默认别当隔离） |
| `deny` | **黑名单**；命中 server 名则剔除（子串/精确，大小写不敏感） |
| `allow` | **白名单**；**非空**时仅保留命中项；**空数组 = 不启用白名单** |

额外：MCP 条目上的 `modes: ["coding"]` 也会限制场景（与 policy 叠加）。

**装配时机**（`AgentService.createSession`）：

```text
loadMcpConfig()
  → filterMcpConfigForMode(full, welcomeMode, mcpPolicy)
  → createMcpAdapter({ config: filtered })
```

Hub / 无头 MCP 会话 **不过滤**（全量，方便测连接）。

关键代码：

| 文件 | 作用 |
|------|------|
| `src/main/mcp/McpModeFilter.ts` | 过滤逻辑 |
| `src/main/mcp/McpRuntimeService.ts` | `getInlineExtensions({ welcomeMode, mcpPolicy })` |
| `src/main/agent/mode-defaults.ts` | 出厂 deny/allow |
| `src/main/agent/ModeProfileStore.ts` | 读写 `policy.json`、物化文案 |

### 3.2 技能：`skillPolicy`（目录过滤）

```json
"skillPolicy": {
  "prefer": [],
  "demote": [],
  "hide": [],
  "allow": []
}
```

| 字段 | 含义 |
|------|------|
| `hide` | **限制/黑名单**，从本模式技能目录隐藏 |
| `allow` | **白名单**；非空仅保留匹配项；空 = 不启用 |
| `prefer` / `demote` | 软排序（靠前/靠后），不隐藏 |

匹配：技能 **id** 优先精确，兼容名称/描述子串。  
开关：应用设置 `skillModeFilterEnabled`（设置页「技能过滤」）。

关键代码：`src/main/agent/SkillPolicy.ts`、`PromptAssembly.ts`。

---

## 4. 设置 UI

**设置 → 场景模式**

| 导航 | 内容 |
|------|------|
| 文案 | 五块 Markdown（可打开对应 `.md`） |
| **技能限制** | 从**已安装技能列表勾选**（不可手输）：限制 / 白名单 / 排序 |
| **MCP 限制** | 从**MCP 列表勾选**（不可手输）：限制 / 白名单 + hard/soft |
| 策略 JSON | 完整 `policy.json` 高级编辑 |

白名单与限制互斥（勾进一边会从另一边去掉）。

---

## 5. 捆绑扩展（Serena / CodeGraph）

仓库内（非 `~/.mybuddy/extensions` 运行时目录）：

```text
extensions/mcp/
  README.md
  serena/          # extension-meta.json + mcp.json + repo→vendor/serena
  codegraph/       # 同上 → vendor/codegraph
vendor/
  serena/          # git clone（gitignore）
  codegraph/
```

| 扩展 | MCP 名 | 默认 `modes` |
|------|--------|----------------|
| oraios/serena | `serena` | `["coding"]` |
| colbymchenry/codegraph | `codegraph` | `["coding"]` |

安装到 mybuddy：写入 `~/.mybuddy/mcp.json`（Hub 候选 `bundled:*`，或 `mcp:installBundled` / `installBundledCodingMcp()`）。

系统依赖（本机 CLI）：

```text
# Serena
uv tool install -p 3.13 serena-agent
serena init
# MCP 启动：serena start-mcp-server --project-from-cwd

# CodeGraph
# install.ps1 或 npm i -g @colbymchenry/codegraph
codegraph init          # 每个代码仓
# MCP 启动：codegraph serve --mcp
```

若 Electron 起不来子进程：把 `command` 改成 **绝对路径**。

---

## 6. 推荐策略模型（产品约定）

| 模式 | 典型 mcpPolicy |
|------|----------------|
| **working** | `hard` + `deny: [serena, codegraph, …]`，allow 空 |
| **coding** | `hard` + `allow: [serena, codegraph]`（或 allow 空=全量已装） |
| **design** | 按需要 allow 设计向 MCP；coding-only 条目靠 `modes`/`deny` 挡 |

出厂种子（可被用户 `policy.json` 覆盖）：working/design deny serena+codegraph；coding 不 deny。

---

## 7. 本机实测记录（示例，2026-08-07）

某次用户机 `mcp.json` 含：serena、codegraph、esp-*、node_repl、yuanlitu_easyeda、canva(disabled)。

| 模式 | 过滤结果（摘要） |
|------|------------------|
| working | 全部相关项隐藏；启用为空 |
| coding | 启用 **serena, codegraph**（白名单） |
| design | 依当时 allow；canva disabled 则可能为空 |

**已验证**：过滤函数 + 真实 `mcp.json`/`policy.json` 一致。  
**未默认验证**：真会话里 Serena 工具调用成功（依赖 CLI PATH / 绝对路径）。

---

## 8. 怎么自测

### 8.1 单元 + 种子策略

```bash
pnpm test:mcp-mode
# 含：mcp-mode-filter-test + mcp-mode-e2e-check
```

### 8.2 对本机配置 live 检查（不启 GUI）

```bash
pnpm exec esbuild scripts/mcp-mode-live-check.ts --bundle --platform=node --format=cjs --outfile=out/tests/mcp-mode-live-check.cjs
node out/tests/mcp-mode-live-check.cjs
```

输出：本机已装 MCP 列表 + 三模式 **启用/隐藏/原因**。

### 8.3 场景文案物化

```bash
pnpm exec esbuild scripts/materialize-modes.ts --bundle --platform=node --format=cjs --outfile=out/tests/materialize-modes.cjs
node out/tests/materialize-modes.cjs
```

### 8.4 应用内

1. 设置 → 场景模式 → MCP 限制：看勾选与 hard  
2. **预览装配**：看 MCP 隐藏提示  
3. 新建 **办公** 任务 vs **代码开发** 任务，对比 MCP 工具  
4. 主进程日志：`[McpRuntime] mode=working MCP enabled=[…] hidden=[…]`

---

## 9. 相关脚本与入口

| 脚本/入口 | 说明 |
|-----------|------|
| `scripts/mcp-mode-filter-test.ts` | 过滤函数单测 |
| `scripts/mcp-mode-e2e-check.ts` | 出厂种子 × 模拟 MCP |
| `scripts/mcp-mode-live-check.ts` | **本机** mcp.json + policy |
| `scripts/materialize-modes.ts` | 强制写出 modes 下 md |
| `scripts/mode-profile-test.ts` | ModeProfile / 技能过滤 |
| `pnpm test:mode` / `pnpm test:mcp-mode` | package.json |

---

## 10. 常见坑

| 现象 | 原因 / 处理 |
|------|-------------|
| 目录里「只有 json」 | 旧状态未物化 md；重启应用或跑 `materialize-modes` |
| coding 启用为空 | allow 写了 serena/codegraph 但 **没装进 mcp.json** |
| 过滤对了但工具连不上 | `command` 不在 Electron PATH → 用绝对路径 |
| 改了 policy 没感觉 | **仅新任务**；旧 session 不重装 MCP |
| Hub 能连、办公任务没有 | 正常：对话按 welcomeMode 过滤，Hub 无头全量 |
| design 全空 | allow 只有 disabled 的服务，或 allow 过窄 |

---

## 11. 和「只换提示词」的差别

| 能力 | 状态 |
|------|------|
| 厚场景文案（五块） | ✓ 可编辑文件 |
| 技能目录 prefer/hide/allow | ✓ |
| MCP 按模式 hard 加载 | ✓ |
| 任务模式图标 / 锁定 / 复制换场景 | ✓ |
| 拆三套 Agent | ✗ 不做 |
| 按模式自动换模型 | policy 可写 `suggestedModelId`，新建未强制套用 |

---

## 12. 变更时优先改哪里

1. **默认谁能用 MCP** → `mode-defaults.ts` 的 `mcpPolicy` 或用户 `modes/*/policy.json`  
2. **过滤算法** → `McpModeFilter.ts` / `SkillPolicy.ts`  
3. **设置 UI** → `src/renderer/src/components/settings/ModesTab.tsx`  
4. **捆绑安装包** → `extensions/mcp/*`  
5. **自测** → `scripts/mcp-mode-live-check.ts`

---

*文档随实现演进；以仓库代码与 `~/.mybuddy` 实文件为准。*