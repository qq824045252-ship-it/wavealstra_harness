---
name: 欢迎三模式（核心）执行计划
overview: ModeProfile 场景装配 + 专家集成；三模式文案/策略必须「文件可编辑、UI 可改、装配可检视」——可编辑性与可调试性为一级交付，与功能能力同等重要。单 runtime pi，不拆 agentDir。
status: refreshed-after-code-sync · editability-first · ready-to-execute
updated: 2026-08-06
baseline_commit: 86b28f6
---

# 欢迎三模式 · 执行计划（代码同步修订版）

> 研究依据：`learn-mybuddy`、官方 `mybuddy-bench`、本仓库实码。  
> 关联文档：`plan-expert-page.md`（专家中心 **已实施**）、`STATUS.md`、`plan.md`。  
> **验收后路线 / backlog 优先级**：见 **`plan-welcome-modes-next.md`**（四项增强不是固定下一刀）。  
> **用户硬要求（D5）**：日常办公 / 代码开发 / 设计创意 三块内容 **可编辑性要求极高**；这是最难调试的点，必须当产品核心能力做，不能把文案写死在 TS 常量里事后靠改代码发版。

---

## 代码同步纪要（2026-08-06 · 读码后）

相对初版计划，仓库已发生**重大进展**——主要在**专家中心**，**不是**欢迎三模式本身。

| 模块 | 初版计划假设 | **当前实码** | 对三模式计划的影响 |
|------|----------------|--------------|-------------------|
| 专家服务 | Phase 5 从零做 Expert | `ExpertService` 完整：市场/安装/启停/zip+目录导入/导出、`getRolePrompt`、内置 3 专家 + 1 专家团 | **Phase 5 绿野建设取消** → 改为「与 welcomeMode 集成」 |
| 专家注入 | 设想 append 段 | `createSession` 在 WELCOME 后推 `## 专家角色`；`switchExpert` 改 `appendSystemPromptSource` + `session.reload()` | 证明 system 段可热替换；**welcomeMode 仍按 D1 锁定，不热切** |
| 专家团 | 远期 | `prompt` 遇 `team:` 走团长拆解 JSON → 成员并行只读会话 → 整合 | 与三模式正交；working 场景可默认推荐复盘团等 |
| 专家 UX | Hub 空态 | HubPage 专家页、ChatInput 召唤弹层、ChatView 专家 chip、TaskItem emoji 徽章 | **模式徽章/锁定 UX 可复用同一交互语言** |
| 专家测试 | 无 | `pnpm test:expert`（`scripts/expert-test.ts`） | 三模式应同样补 `test:mode` |
| DB | tasks.welcome_mode | + `expert_id`、`archived` | welcome_mode 列已在，锁定只需产品逻辑 |
| 欢迎三模式 | 待做 | **仍只有** `WELCOME_APPEND` 三行 | **本切片主战场未动** |
| Skill 按模式 | 待做 | Skills 装/启停有，**无 modes 过滤** | Phase 2 仍全量 |
| PromptAssembly | 待做 | `createSession` 手写 `appendParts` | Phase 1 仍全量 |
| D1 锁定 | 已决策 | `setWelcomeMode` **仍可改活跃任务**（含已有消息） | Phase 1 必须改 store/UI |
| 复制为新任务 | 已决策 | 仅有 `newTask` / `summonExpert`（新会话+专家） | 缺「换 welcomeMode 复制」入口 |
| HomeHero chip | 待做 | `heroScenes: []` 空 | Phase 4 |
| 模型 hint | 待做 | 无 per-mode suggestedModel | Phase 4 |
| 工具按模式 | 待做 | 仅 `permissionMode` 收窄 tools | Phase 3 |
| Gateway/Cron | — | Cron 默认 `welcomeMode: "working"` | 保持；与 D1 一致锁定 |

### 当前 system prompt 真实拼装顺序（`AgentService.createSession`）

```text
1. ## 人设          (soul)
2. WELCOME_APPEND   (working|coding|design · 各一行)
3. ## 专家角色 / 专家团角色   (optional expertId)
4. ## Windows Shell (win32)
5. ## 长期记忆…     (开关与 digest)
```

`switchExpert` **只替换**以 `## 专家角色` / `## 专家团角色` 开头的段，**不碰** WELCOME 行。

### 关键源码锚点

| 路径 | 作用 |
|------|------|
| `src/main/agent/AgentService.ts` L63–67, L1175–1216 | `WELCOME_APPEND` + appendParts |
| `src/main/agent/AgentService.ts` L515–549 | `switchExpert` / `applyExpertToSession` |
| `src/main/experts/ExpertService.ts` | 专家全生命周期 |
| `src/renderer/src/store/appStore.ts` `setWelcomeMode` / `summonExpert` / `switchExpert` | 前端状态 |
| `src/renderer/src/components/chat/ChatView.tsx` HomeHero | 三 pill（无锁定） |
| `src/renderer/src/mock/data.ts` | `heroCategories` 有、`heroScenes` 空 |
| `plan-expert-page.md` | 专家切片已结案说明 |

---

## 已锁定决策（不变）

| # | 议题 | 决策 |
|---|------|------|
| **D1** | 任务内切换 **welcomeMode** | **策略 A**：任务绑定后锁定；换场景 → **新建 / 复制为新任务**（不重建旧 session） |
| **D2** | 交付范围 | **全功能**（模板+技能+工具+UX+与专家集成+本地 smoke）+ **D5 可编辑/可检视** |
| **D3**（新增·读码后） | 与专家关系 | **专家中心已是细粒度人格层**；welcomeMode 是**粗粒度场景层**。不重做 ExpertService。装配优先级见 §3 |
| **D4**（新增） | 专家可热切、模式不热切 | 专家：`switchExpert` 已支持会话内切换；模式：D1 锁定。两套 UX 刻意不同 |
| **D5**（新增·用户硬要求） | **三模式高可编辑 + 可调试** | 三块 profile **必须**以用户可改文件为主存储；内置仅作出厂默认；提供编辑器 + 装配检视 + 预览/对比/回滚。见 **§3.3** |
| **D6**（新增·用户硬要求） | **任务必带模式标志** | 一旦归属 working/coding/design，**所有任务列表项**（顶层独立任务 **与** 空间下嵌套任务）必须显示可区分的 **小图标**；聊天头等任务语境同步。见 **§3.4** |

### D1 细则（对照现状缺口）

```text
欢迎页 pill 可选 mode          ✅ 已有
发首条消息时 task.welcomeMode  ✅ prompt 已带；需保证首写库且之后只读
任务内改 mode                  ❌ 现状可改 → 应禁止（只读展示）
复制为新任务（换 mode）        ❌ 无 → Phase 1/4 做
专家召唤新会话                 ✅ summonExpert（继承当前 welcomeMode）
```

---

## 0. 一句话结论（修订）

| 问题 | 结论 |
|------|------|
| 三模式本质 | 同一 pi runtime 上的 **ModeProfile 装配包**（模板+能力面+完成标准） |
| 专家已做什么 | 会话级 **细人格**（可热切、可团、可导入生态包） |
| 三模式还缺什么 | 厚模板、技能/工具面、D1 UX、验收；**外加「可编辑/可检视」整条链路** |
| 交付口径 | D2 全功能；D1 锁定；**D5 可编辑可调试为一级**；不拆 agentDir |

---

## 1. 研究纪要（压缩保留）

### 1.1 learn-mybuddy → 本仓库映射

| 章节 | 机制 | 本仓库现状 | 三模式落点 |
|------|------|------------|------------|
| s15 Prompt Assembly | 多段运行时拼装 | 手写 appendParts | Phase 1 `PromptAssembly` |
| s16 Skills | 目录懒加载 | SkillsService 有，无 mode 过滤 | Phase 2 |
| s18 Experts | 会话人格包 | **已完整** ExpertService | Phase 5 仅集成 |
| s03 Deferred tools | 工具可见性 | 仅 readonly 收窄 | Phase 3 |
| s04 Permission | ALLOW/ASK/DENY | permission-extension 已有 | 保持正交 |
| s08 Model routing | lite/default/craft | 用户自选 model | Phase 4 suggestedModel **hint only** |
| s20 Delivery | present_files | ArtifactPanel 有 | 模板写清交付标准 |

### 1.2 mybuddy-bench → 模式完成标准

| Track | → Mode | 成功定义（写入 profile.delivery） |
|-------|--------|----------------------------------|
| Office | working | 混合格式精确产物、证据链、可对账 |
| Code | coding | 最小 diff + 测试/验证命令 |
| Web | design | 可预览结构/页面/层级与状态 |
| Security | 不上 pill | coding + 严权限 / skill |

---

## 2. 正交轴与装配优先级（修订）

| 轴 | 取值 | 任务内可否变 | 现状 |
|----|------|--------------|------|
| **welcomeMode** | working / coding / design | **否（D1）** | 三行 append，可误改 |
| **permissionMode** | default / readonly / auto | 是 | 已接线 |
| **expertId** | 专家 / team:… / 空 | **是（热切）** | 已接线 |
| **skill 集** | 已安装 + enabled | 启停 | 无 mode 过滤 |
| **modelId** | 用户选 | 是 | 无 mode hint |

### 装配优先级（createSession / 重装时）

```text
base 人设 (soul)
  → welcomeMode blocks     （场景：目标/流程/交付/禁令/验收 + soft tool）
  → expert specialization  （若有；细人格，覆盖语气与方法论，不删场景验收段）
  → skill catalog          （经 SkillPolicy 按 welcomeMode 过滤后的目录）
  → platform / memory
  → permission 说明（简短）
```

规则：

1. **expert 不删除 welcome 的 delivery/禁令段**——只追加/强化角色。  
2. **skill prefer**：`ModeProfile.skillPolicy ∪ Expert 元数据 tags`（专家暂无 preferred_skills 字段则仅 mode）。  
3. **tool hard deny**：仅 ModeProfile；readonly 权限仍全局最高。  
4. **团任务** `team:*`：welcomeMode 仍注入（场景约束），团长/成员 prompt 另算。

---

## 3. 目标架构（贴合现码）

```text
HomeHero.welcomeMode ──(仅草稿/新任务可改)──► task.welcomeMode [锁定]
ChatInput 专家召唤 ──► task.expertId [可热切]
        │
        ▼
 ModeProfileStore.get(welcomeMode)   ← seed ⊕ ~/.mybuddy/modes/**
        │
        ▼
 PromptAssembly.build(...)  ──► AssemblyTrace（可 IPC 预览/落日志）
        │
        ▼
 DefaultResourceLoader.appendSystemPrompt
        │
        ├─ createSession（首轮）
        └─ applyExpertToSession（仅专家段热替换，已有）

 设置「场景模式编辑器」──save──► ~/.mybuddy/modes/** ──► 下次 get() 生效
 任务「查看装配」──preview──► 同一 build()（禁止第二套拼接逻辑）
```

### 3.1 ModeProfile 契约（实现时新建 · 文件为源）

```ts
// src/shared/mode-profile.ts
export type WelcomeMode = "working" | "coding" | "design";
export type ModeBlockId = "goal" | "workflow" | "delivery" | "forbid" | "criteria";

export interface ModeProfile {
  id: WelcomeMode;
  labelZh: string;
  version?: string;
  benchTracks: Array<"office" | "code" | "web">;
  /** 有序块；content 来自 seed/user 文件合并，勿在 TS 写死长文 */
  promptBlocks: Array<{ id: ModeBlockId; content: string; source: "seed" | "user" }>;
  skillPolicy: { prefer: string[]; demote: string[]; hide: string[] };
  toolPolicy: {
    mode: "soft" | "hard";
    prefer: string[];
    demote: string[];
    deny?: string[];
  };
  delivery: { successCriteria: string[]; expectedArtifacts: string[] }; // 可从 criteria.md 解析或 policy 冗余
  suggestedModelId?: string;
  suggestedPermissionMode?: "default" | "readonly" | "auto";
  recommendedExpertIds?: string[];
  /** HomeHero 场景 chip，用户可在编辑器改 */
  scenes: Array<{ label: string; prompt: string }>;
}
```

**加载器**：`ModeProfileStore`（对齐 `ExpertService` / `SkillsService` 风格）  
`get(id)` / `saveBlock` / `savePolicy` / `reset` / `diffSeed` / 首次启动可选把 seed 说明写进 README 于 `~/.mybuddy/modes/README.md`。

内置专家推荐映射（产品默认，可改）：

| Mode | recommendedExpertIds（已有 builtin） |
|------|--------------------------------------|
| working | weekly-report, data-analysis, doc-polish, team:review-team |
| coding | （暂无代码专家 builtin → 空或后续加） |
| design | doc-polish（文案）；（后续可加 UI 专家包） |

### 3.2 三模式内容规格（交付门禁，须写满）

**working · 日常办公 ← Office**

- 目标：可打开的办公产物（md/docx/xlsx/报告）  
- 流程：盘点输入 → 证据 → 可追溯计算 → 标准格式 → 交付路径  
- 禁令：无证据不编数；不整库乱改代码  
- skill prefer：周报、文档、excel、report、summary…  
- tool soft：read/write 优先；bash 用于转换时说明  

**coding · 代码开发 ← Code**

- 目标：可验证变更（测试/命令复现）  
- 流程：定位 → 最小 diff → 验证 → 说明变更面  
- 禁令：无必要不重写；不提交密钥  
- skill prefer：review、test、git、refactor…  
- tool：全工具，靠 permissionMode  

**design · 设计创意 ← Web visual**

- 目标：可预览结构（HTML/MD 线框/层级）  
- 流程：用户场景 → IA → 文案/视觉层级 → 预览交付  
- 禁令：无确认不批量删；少动无关后端  
- tool：soft demote 任意 bash；profile 可 hard 收窄  

---

### 3.3 D5 · 三模式高可编辑性与可调试性（一级需求）

> 用户判断：这是**非常难调试**的点，对可编辑性要求特别高。  
> 因此 **「改得动、看得见、对得上、回得去」** 与「三模式行为正确」同级，写入 DoD。

#### 3.3.1 为什么难调（问题建模）

| 难点 | 表现 | 若无可观测性会怎样 |
|------|------|-------------------|
| **黑盒 system** | 最终进模型的是多段拼接，用户/开发者看不到全文 | 只能靠「感觉模型变傻/变啰嗦」猜 |
| **多层叠加** | 人设 + mode + 专家 + 技能目录 + shell + 记忆 + 权限 | 改 mode 无效时可能是专家盖住或 skill 过滤错了 |
| **D1 锁定** | 任务内不能换 mode 做 A/B | 同一会话无法对比；必须新任务，更需要 **预览装配** |
| **策略非文案** | skill prefer/hide、tool hard 不在对话里出现 | 行为变了却「模板看着没问题」 |
| **效果延迟** | 模板改完只影响**新 session** | 用户以为「保存了没生效」 |
| **与专家交互** | 专家热切只换专家段 | 调试时分不清是 mode 还是 expert 的锅 |
| **写死在代码** | 当前 `WELCOME_APPEND` 在 `AgentService.ts` | 每次调优要改代码、重建、发版——**不可接受** |

#### 3.3.2 设计原则（硬约束）

1. **文案与策略不进业务逻辑硬编码**  
   - 出厂默认：仓库内 `resources/modes/` 或 `src/main/agent/mode-profiles/defaults/`（随应用分发，只读种子）  
   - **用户可写层**：`~/.mybuddy/modes/<working|coding|design>/`（覆盖种子）  
   - 运行时：`loadModeProfile(id) = merge(seed, userOverride)`，缺文件则纯 seed  

2. **块级可编辑，不是一整坨 string**  
   - 每个模式拆成独立文件/字段，改一块不影响另一块：  
     `goal.md` / `workflow.md` / `delivery.md` / `forbid.md` / `criteria.md`  
     + `policy.json`（skillPolicy / toolPolicy / suggestedModel / recommendedExperts / scenes[]）  
   - 编辑器按 Tab 编辑各块；保存只写对应文件  

3. **所见即所注：装配必须可检视**  
   - 任意任务（或预览上下文）可打开 **「场景装配检视」**：  
     - 分段列表（id、字符数、来源：seed|user|soul|expert|skill|…）  
     - 最终拼接全文（只读，可复制）  
     - skill 目录：prefer/demote/hide 命中原因  
     - tool 策略摘要  
   - 开发与高级用户同一套 IPC，设置里开关「显示装配调试」  

4. **先预览，再进会话**  
   - `assemblePreview(welcomeMode, { expertId?, permissionMode?, spaceId? })` **不创建 pi session、不调模型**  
   - 编辑器保存后一键「预览装配」；与真实 `createSession` **共用同一 `PromptAssembly.build`**（禁止两套逻辑）  

5. **生效语义写死，避免「改了不灵」幻觉**  

   | 变更 | 何时生效 |
   |------|----------|
   | 改 mode 模板/policy | **仅新任务 / 新 session**（D1：旧任务 system 已固定） |
   | 任务内 switchExpert | 专家段热替换（已有） |
   | 技能启停 / modes 标签 | 新 session；若 skill 段在每轮注入则文档注明 |
   | UI 明确提示 | 保存成功 toast：`已保存，将在新任务中生效` |

6. **可对比、可回滚**  
   - 「与出厂默认对比」diff（按块）  
   - 「恢复此块为出厂」/「恢复整个模式为出厂」  
   - 可选：保存时写 `history/YYYYMMDD-HHMMSS/` 最近 N 份（P1 建议做，至少保留「恢复出厂」）  

7. **校验先于注入**  
   - 保存时：必填块非空、总字符预算告警（如 mode 段合计 > 6k 字 warn）、policy JSON schema、deny 工具名合法  
   - 非法 profile **拒绝保存**或 **拒绝加载并回退 seed + 错误提示**，禁止静默吞错  

#### 3.3.3 磁盘布局（建议）

```text
# 应用内种子（只读，随版本升级可更新；升级不覆盖用户目录）
resources/modes/
  working/
    meta.json          # id, labelZh, version, benchTracks
    goal.md
    workflow.md
    delivery.md
    forbid.md
    criteria.md
    policy.json        # skillPolicy, toolPolicy, suggestedModelId, recommendedExpertIds, scenes[]
  coding/ ...
  design/ ...

# 用户覆盖（高可编辑层）
~/.mybuddy/modes/
  working/             # 同构；存在的文件覆盖种子同名文件
  coding/
  design/
  _edit-history/       # 可选备份
```

`policy.json` 示例字段：

```json
{
  "skillPolicy": { "prefer": ["周报", "summary"], "demote": [], "hide": [] },
  "toolPolicy": { "mode": "soft", "prefer": ["read", "write"], "demote": ["bash"], "deny": [] },
  "suggestedModelId": null,
  "suggestedPermissionMode": "default",
  "recommendedExpertIds": ["weekly-report", "data-analysis"],
  "scenes": [
    { "label": "库存摘要", "prompt": "根据 data/inventory.csv ..." }
  ]
}
```

#### 3.3.4 服务与 IPC（建议）

| API | 作用 |
|-----|------|
| `modes:listProfiles` | 三模式摘要（是否有用户覆盖、字符数、version） |
| `modes:getProfile(id)` | 合并后的完整 profile + 每块 `source: seed\|user` |
| `modes:getBlock(id, blockId)` | 单块原文（编辑器用） |
| `modes:saveBlock(id, blockId, content)` | 写用户目录；校验；记 history |
| `modes:savePolicy(id, policy)` | 写 policy.json |
| `modes:resetBlock` / `modes:resetProfile` | 删用户覆盖 → 回种子 |
| `modes:diffAgainstSeed(id)` | 块级 diff |
| `modes:assemblePreview(input)` | **纯函数装配**，返回 `AssemblyTrace` |
| `modes:openModesDir` | 系统文件管理器打开 `~/.mybuddy/modes`（高级用户） |

`AssemblyTrace`（调试核心结构）：

```ts
interface AssemblyTrace {
  welcomeMode: WelcomeMode;
  segments: Array<{
    id: string;           // soul | mode.goal | mode.workflow | expert | skillCatalog | ...
    title: string;
    source: "seed" | "user" | "runtime" | "expert" | "skill" | "db";
    chars: number;
    content: string;
  }>;
  skillFilter: { prefer: string[]; demote: string[]; hide: string[]; visible: string[] };
  toolPolicy: ModeProfile["toolPolicy"];
  totalChars: number;
  warnings: string[];     // 超长、缺块、expert 覆盖提示等
  effectiveAt: "new_session_only";
}
```

#### 3.3.5 UI：场景模式编辑器 + 装配检视

**入口（建议都做）**

1. 设置 → **智能体 / 场景模式**（三 tab：日常办公 | 代码开发 | 设计创意）  
2. 欢迎页当前 mode 旁「编辑此场景」→ 同上编辑器（草稿态）  
3. 任务头只读 mode 徽章旁「查看本任务装配」→ **检视只读**（用该 task 的 mode+expert+permission 预览）  

**编辑器页结构**

```text
[日常办公 | 代码开发 | 设计创意]
  左侧：块列表 goal / workflow / delivery / forbid / criteria / 策略 / 场景 chip
  右侧：Markdown 或 JSON 编辑器
  顶栏：保存 | 预览装配 | 与出厂对比 | 恢复出厂 | 打开文件夹
  底栏：字符数 / 校验错误 / 「保存后仅对新任务生效」
```

**装配检视（Inspector）**

- 分段 accordion + 总览字符条  
- 「复制全文」给外部 diff / 贴 issue  
- 高亮：user 覆盖块 vs seed  
- 若有 expert：专家段单独颜色，避免和 mode 混淆  

#### 3.3.6 调试工作流（写进产品说明 / STATUS）

```text
1. 改 mode 块 → 保存 → 预览装配（看 segment 是否如预期）
2. 新建任务（同 mode）→ 发一句探测 prompt
3. 任务内「查看装配」确认与预览一致
4. 若行为仍怪 → 检视是否 expert 段过长/冲突；临时解除专家再试
5. 若 skill 不对 → 看 skillFilter.visible / hide 原因
6. diff 出厂：确认不是误改 policy
7. 仍不行 → 复制 AssemblyTrace 全文排查（不要靠猜）
```

禁止的调试方式（计划内反对）：

- 只改 `AgentService.ts` 字符串发版调优  
- 装配逻辑写两份（预览一套、session 一套）  
- 无提示地改旧任务期望生效  

#### 3.3.7 与 D1 的关系（重要）

- **编辑模板** ≠ **切换任务 mode**  
- 编辑：改的是 `~/.mybuddy/modes/**`，影响未来 session  
- D1：某个 task 的 welcomeMode 锁定，其 **已创建 session 的 system 不自动重装**  
- 若未来要「应用新模板到当前任务」——**明确不做**（除非用户「复制为新任务」）；避免半热更新状态分裂  

#### 3.3.8 测试要求（可编辑专项）

| 用例 | 断言 |
|------|------|
| seed only | 三模式可 assemble，块非空 |
| user 覆盖 goal.md | getProfile 显示 source=user；assemble 含新文案 |
| reset block | 回到 seed |
| save 非法 policy | 拒绝，磁盘不被破坏 |
| preview === createSession 的 mode 相关段 | 同一 build 函数，字符串一致（专家/记忆可 mock） |
| 超长 warn | warnings 非空但仍可保存（或按策略拒绝——实现时二选一写死） |
| 升级种子 | 用户覆盖文件不被安装程序删除 |

---

### 3.4 D6 · 任务模式标志（全列表必显小图标）

> 用户要求：按场景分类后，**不论单独任务还是空间底下的任务**，都必须带各自标志，区分办公 / 代码 / 设计；**推荐小图标**。

#### 3.4.1 现状缺口

| 位置 | 现状 | 目标 |
|------|------|------|
| `TaskItem`（含 `nested` 空间子任务） | 仅专家 emoji、置顶、状态；**无 welcomeMode** | **必显**模式小图标 |
| 聊天顶栏 | 有专家 chip 等 | **只读**模式图标 + 文案（与 D1 锁定一致） |
| Ctrl+K / 搜索结果任务 | 未统一 | 与侧栏同一图标组件 |
| 我的文件 / 其它按任务分组处 | 视情况 | 有 task 引用处尽量带模式图标 |

#### 3.4.2 图标语义（产品定稿建议）

| welcomeMode | 中文 | 小图标语义（实现时用 Lucide/现有 icons.tsx） | title 提示 |
|-------------|------|-----------------------------------------------|------------|
| `working` | 日常办公 | 文档/公文包类，如 `IconFile` / briefcase | 日常办公 |
| `coding` | 代码开发 | 代码尖括号/终端，如 code / terminal | 代码开发 |
| `design` | 设计创意 | 画板/钢笔/布局，如 pen-tool / layout | 设计创意 |

约束：

- **三态图标必须一眼可辨**（形 + 可选极淡色，勿只靠颜色）  
- 尺寸：**侧栏 12–14px**；聊天头可 14–16px  
- **不用**大 logo、不用整段文字徽章占宽；文字仅 `title`/aria  
- 缺省 `welcomeMode` 的历史任务：显示为 `coding` 图标并 title「代码开发（默认）」——与现网默认一致，**禁止空白**

#### 3.4.3 布局（侧栏 TaskItem）

推荐结构（`nested` 与否 **同一套**）：

```text
[mode-icon]  任务标题……………………  [expert?] [pin?] [status|time]  [⋯]
     ↑
  固定占位 14px，避免有无图标时标题跳动
```

- 模式图标在 **标题左侧**（比 meta 区更易扫视）  
- 专家 emoji 保持在 **meta 右侧**（细人格 ≠ 粗场景，两套标志并存）  
- `className` 建议：`task-mode-icon task-mode-icon--working|coding|design`  
- 深色/浅色主题下对比度达标  

#### 3.4.4 数据与一致性

- 图标只读 `task.welcomeMode`（创建时写入并 D1 锁定）  
- Gateway / Cron / summonExpert 创建的任务 **同样**必须带 `welcomeMode` 与图标  
- 「复制为新任务」换 mode 后，新项图标立即变为目标模式  
- **禁止**仅欢迎页有区分、侧栏看不出来  

#### 3.4.5 共享组件（必须）

```text
src/renderer/src/components/common/WelcomeModeIcon.tsx
  props: { mode?: WelcomeMode; size?: number; className?: string }
  // 统一映射，禁止各处复制 if/else
```

引用点至少：

1. `TaskItem`（独立 + `nested`）  
2. 聊天 `ChatView` 任务头  
3. 搜索弹窗任务行（若有）  
4. 复制为新任务菜单里的 mode 选项（选择器本身也用同图标）  

#### 3.4.6 验收（D6）

- [ ] 侧栏顶层任务：三模式各至少 1 条，图标不同且 title 正确  
- [ ] 某空间下挂 3 个不同 mode 子任务：图标均可见、布局不挤乱  
- [ ] 无 welcomeMode 历史数据：显示默认 coding 图标，无空白洞  
- [ ] 与专家 emoji 同时存在时不互相遮挡  
- [ ] 键盘/读屏：有 `aria-label` 或 `title`  

---

## 4. 差距矩阵（同步后唯一真相源）

| 能力 | 状态 | 剩余工作 |
|------|------|----------|
| WelcomeMode 类型 + DB + prompt 下发 | ✅ | — |
| HomeHero 三 pill + 模式图标 | ✅ | — |
| ModeProfile 种子 ⊕ 用户目录 | ✅ | 种子在 `mode-defaults.ts`（非 resources/ 磁盘，行为等价） |
| 设置页场景模式编辑器 | ✅ | — |
| PromptAssembly + AssemblyTrace 预览 | ✅ | 设置内「预览装配」 |
| D1 锁定 + 复制为新任务 | ✅ | 任务菜单三项复制 |
| SkillPolicy 过滤 | ✅ | 设置开关 skillModeFilterEnabled |
| frontmatter `modes` | ⚠️ | 过滤已支持 modes 字段；装载时尚未全面解析 fm.modes |
| tool soft/hard | ✅ | soft 写入 prompt；hard 经 resolveSessionTools |
| HomeHero 场景 chip | ✅ | policy.scenes |
| 任务模式小图标（D6） | ✅ | TaskItem nested/顶层 |
| 聊天头模式 chip | ✅ | 锁定说明 |
| 模式 suggestedModel 自动应用 | ⚠️ | policy 可编辑；新任务自动选模未绑 |
| 专家推荐排序 | ✅ | InputAddMenu 置顶 recommendedExpertIds |
| mode 单测 | ✅ | `pnpm test:mode` 21 项 |
| fixtures 说明 | ✅ | `fixtures/modes/README.md` |

---

## 5. 分阶段执行（按现状重排）

### Phase 0 — 规格、类型与**种子文件**（必须 · ~1d）

| 任务 | 产出 |
|------|------|
| 0.1 `src/shared/mode-profile.ts` | 类型 + `AssemblyTrace` |
| 0.2 **种子目录** `resources/modes/{working,coding,design}/` | 每模式 5 个 md 块 + `policy.json` + `meta.json`（**禁止**长文只写在 .ts） |
| 0.3 `ModeProfileStore` 骨架 | seed ⊕ user 合并；缺省回退 |
| 0.4 `fixtures/modes/**` + 附录用例 | 每模式 ≥3 instruction |
| 0.5 D3/D4/D5 注释 | 与专家边界 + 可编辑原则 |

**验收**：磁盘上能打开改 md；`get(id)` 不经 UI 也能读到合并结果；块齐全。

---

### Phase 1 — PromptAssembly + D1 锁定（必须 · ~1–2d）

| 任务 | 做法 |
|------|------|
| 1.1 `PromptAssembly.ts` | **唯一**拼接实现；输出 `string[]` + `AssemblyTrace` |
| 1.2 `AgentService.createSession` | 删 `WELCOME_APPEND`；`profile = store.get(mode)`；保留 `## 专家角色` 前缀 |
| 1.3–1.5 | D1 锁定 + `duplicateTaskWithMode`（同前） |
| 1.6 `test:mode` | 三模式差异 + 专家共存 + **user 覆盖 goal 后 assemble 变化** |

**验收**：同 Phase 1 原列表 + 覆盖文件可影响 assemble。

---

### Phase 1b — 可编辑性与装配检视（必须 · D5 · ~2d）

> 与 Phase 1 紧耦合；**可同 PR 或紧随**。没有 1b 不算三模式交付。

| 任务 | 做法 |
|------|------|
| 1b.1 IPC | `modes:*` 全家桶（list/get/saveBlock/savePolicy/reset/diff/assemblePreview/openDir） |
| 1b.2 设置页「场景模式」 | 三 tab 编辑器：块 MD + policy JSON；保存/恢复出厂/对比 |
| 1b.3 装配检视面板 | 分段 + 全文复制 + skillFilter + warnings；任务头入口 + 编辑器内「预览」 |
| 1b.4 生效提示 | 保存 toast 固定文案；检视页注明 `effectiveAt: new_session_only` |
| 1b.5 历史（建议） | 保存前拷贝到 `_edit-history/` 最多 20 份 |
| 1b.6 测试 | save/reset/diff/preview===build；非法 policy 拒绝 |

**验收**：

- [ ] 不改代码、只改 `~/.mybuddy/modes/**` 或设置 UI，新任务行为可改变  
- [ ] 预览与真实 session 的 mode 相关段一致  
- [ ] 一键恢复出厂  
- [ ] 能复制 AssemblyTrace 排查问题  

---

### Phase 2 — Skill 面过滤（必须 · ~1d）

| 任务 | 做法 |
|------|------|
| 2.1 SkillPolicy | prefer/demote/hide 匹配 name+description+fm |
| 2.2 frontmatter `modes: working,coding` | 缺省 = 全模式 |
| 2.3 装配注入「本模式技能目录」 | hide 不出现 |
| 2.4 设置项 | 「技能不按场景过滤」默认关 |
| 2.5 内置技能 | weekly-summary → modes: [working] |

**验收**：同安装集三模式目录段不同；无技能不炸；单测覆盖 hide。

---

### Phase 3 — 工具策略（必须 · ~1d）

| 任务 | 做法 |
|------|------|
| 3.1 soft（默认） | profile 写入 preferred/demote 说明 |
| 3.2 hard | design 可 deny bash（配置化）；coding 不 hard |
| 3.3 优先级 | `readonly` 工具列表 > mode hard deny > permission 审批 |
| 3.4 回归 | coding+auto、design+readonly 脚本或清单 |

**验收**：readonly 任意 mode 不能写；coding 主路径不变。

---

### Phase 4 — UX 全套 + **D6 模式图标**（必须 · ~1–2d）

| 任务 | 做法 |
|------|------|
| 4.0 **WelcomeModeIcon** | 共享组件 + 三模式 SVG/icon 映射；缺省 coding |
| 4.1 HomeHero | 草稿态 pill 可点（pill 内也可带同系小图标）；进入任务后只读 |
| 4.2 场景 chip | 每 mode 的 `policy.scenes`（可编辑）；点选填入 ChatInput |
| 4.3 **TaskItem 必显图标（D6）** | 标题左侧固定位；`nested` 与顶层 **同一实现**；与专家 emoji 并存 |
| 4.4 聊天头 | 模式图标 + 只读名称 +「换模式请新建任务」；「复制为新任务并选模式」菜单带图标 |
| 4.5 搜索/其它任务行 | 与侧栏同一组件 |
| 4.6 suggestedModel | 新任务 hint；设置可关 |
| 4.7 推荐专家 | 轻提示 → summonExpert（不强制） |
| 4.8 样式 | `global.css`：`.task-mode-icon` 与 nested 缩进协调，不挤标题 |

**验收**：

- [ ] D1 可感知；chip 非空  
- [ ] **§3.4.6 全部勾选**（独立任务 + 空间子任务均有模式小图标）  
- [ ] 专家召唤与专家徽章仍可用  

---

### Phase 5 — 与专家集成（必须但 **薄** · ~0.5–1d）

> 专家中心已完工（见 `plan-expert-page.md`）。本阶段 **禁止**重写 ExpertService。

| 任务 | 做法 |
|------|------|
| 5.1 装配单测 | welcome + expert 同时存在时两段都在，专家可被 switch 替换且 welcome 段仍在 |
| 5.2 `recommendedExpertIds` | Hub / 召唤弹层可按当前 welcomeMode 排序置顶推荐 |
| 5.3 文档 | STATUS：专家 = 细人格；welcome = 粗场景；热切策略差异写清 |
| 5.4 （可选增强） | coding 向内置市场补 1 个「代码审查专家」；design 补「UI 结构专家」——**有则更好，不阻塞 DoD** |

**验收**：`test:expert` 全绿；`test:mode` 含 expert 共存用例；推荐排序可见。

---

### Phase 6 — 本地验收（必须 · ~1–2d）

| 任务 | 做法 |
|------|------|
| 6.1 fixtures | `fixtures/modes/{working,coding,design}/` |
| 6.2 `scripts/mode-smoke` | 能静态查的查；需模型的标【手工】 |
| 6.3 DoD 勾选 | 更新 STATUS「欢迎三模式」条目 |
| 6.4 Harbor | **非门禁**；文档一句带过即可 |

**最小 smoke**：

| 模式 | 用例 | 期望 |
|------|------|------|
| working | inventory.csv → 摘要 md | 合计 + 源引用 |
| coding | 修小函数 + test | 退出码 0 |
| design | preview.html | 存在 + landmark |

---

## 6. 实施顺序（约 2.5–3 周，全功能 + 可编辑）

```text
Week 1
  Phase 0   种子文件 + ModeProfileStore + 类型
  Phase 1   PromptAssembly + D1 + test:mode
  Phase 1b  编辑器 IPC + 设置页编辑 + 装配检视（D5）

Week 2
  Phase 2   SkillPolicy（目录进 Trace）
  Phase 3   工具 soft/hard（策略进编辑器 policy）
  Phase 4   UX 徽章/chip/复制新任务（chip 读 scenes）

Week 3
  Phase 5   专家集成（薄）+ 检视中专家段着色
  Phase 6   smoke + STATUS + 调试工作流文档
  回归：test:expert、test:mode、MCP、记忆、审批
```

**关键路径**：  
`0 → 1 → 1b` 决定「能不能调、能不能改」；  
`2 → 3` 决定「能力面是否真分模式」；  
`4` 决定日常感知。  
**砍掉 1b = 计划失败**（即使用户看不懂代码里的模板）。

---

## 7. 明确不做（架构禁区）

| 不做 | 原因 |
|------|------|
| 多 runtime / 拆 agentDir | plan.md 定案 |
| 欢迎页第四 pill「安全」 | 三场景产品定案 |
| 强制覆盖用户 model | 仅 suggestedModel hint |
| 重写 ExpertService / 专家团 | 已交付 |
| welcomeMode 会话内热切 | D1；与专家热切刻意区分 |
| CI 跑满 mybuddy-bench 260 题 | 本地 smoke 代替 |
| 专家应用商店电商流 | 另切片 |

---

## 8. 风险（修订）

| 风险 | 缓解 |
|------|------|
| 抽出 PromptAssembly 破坏 switchExpert | 保持专家段标题前缀约定；test 锁死 |
| 锁定 mode 后用户困惑 | 复制为新任务 + 文案 |
| Skill hide 过猛 | demote 多于 hide；设置可关 |
| 模板过长 | 预算 warn；编辑器显示字符数 |
| 专家与场景冲突 | 检视分色；文档约定 |
| 预览与真实 session 不一致 | 强制同一 build()；Phase 1b 单测 |
| 用户改了以为旧任务会变 | toast + Inspector 标明仅新任务生效 |
| 种子升级覆盖用户修改 | 用户目录永不被安装删除；仅 seed 可更新 |
| 编辑器双源（UI 缓存 vs 磁盘） | 保存后 re-get；打开编辑器始终读盘 |

---

## 9. Definition of Done（全功能 · 含 D5）

1. **可感知**：三模式行为稳定可区分  
2. **可编辑（D5）**：三模式块与 policy 可在设置 UI 与用户 modes 目录修改，无需改应用源码  
3. **可检视（D5）**：AssemblyTrace 分段+全文+skill/tool；预览与 createSession 一致  
4. **可回滚（D5）**：按块/按模式恢复出厂；可选编辑历史  
5. **可锁定（D1）**：任务内 mode 只读；复制为新任务换 mode  
6. **技能面 / 工具面**：policy 可编辑且生效  
7. **专家共存**：不回退；检视中专家段可辨  
8. **UX**：chip（可编辑 scenes）、锁定说明、模型 hint  
9. **模式标志（D6）**：所有任务（独立 + 空间下）必显可区分小图标；聊天头一致；共享 WelcomeModeIcon  
10. **可回归**：test:mode（含覆盖/reset/preview）+ smoke；test:expert 绿  
11. **文档**：STATUS + 调试工作流（§3.3.6）；本计划 status=done  

---

## 10. 附录

### A. learn 章节映射

| 章节 | 落点 |
|------|------|
| s15 | Phase 1 PromptAssembly |
| s16 | Phase 2 |
| s18 | **已落地** ExpertService；Phase 5 集成 |
| s03/s04 | Phase 3 + 现网 permission |
| s08 | Phase 4 model hint |
| s20 | profile.delivery + ArtifactPanel |

### B. 建议改动文件清单

```text
# 新建 · 数据与装配
resources/modes/{working,coding,design}/{meta.json,goal.md,workflow.md,delivery.md,forbid.md,criteria.md,policy.json}
src/shared/mode-profile.ts              # 类型 + AssemblyTrace
src/main/agent/ModeProfileStore.ts      # seed ⊕ user 加载/保存/reset/diff
src/main/agent/PromptAssembly.ts        # 唯一 build + trace
src/main/agent/SkillPolicy.ts
scripts/mode-prompt-test.ts
scripts/mode-smoke.ts
fixtures/modes/...

# 新建 · 可编辑 UI
src/renderer/.../settings/ModesTab.tsx          # 或 SceneModesEditor
src/renderer/.../chat/AssemblyInspector.tsx     # 装配检视
# preload + agent-ipc 增加 modes:* 

# 修改
src/main/agent/AgentService.ts
src/main/skills/SkillsService.ts
src/main/paths.ts                       # getModesDir()
src/renderer/src/store/appStore.ts
src/renderer/src/components/common/WelcomeModeIcon.tsx  # 新建：三模式小图标
src/renderer/.../ChatView.tsx / ChatInput.tsx / TaskItem.tsx
src/renderer/.../SettingsModal.tsx      # 挂载场景模式页
src/renderer/src/styles/global.css      # .task-mode-icon*
package.json                            # test:mode
STATUS.md
```

### C. 本地验收用例草稿

**working**

1. inventory.csv → 库存摘要 MD（总数+分类）  
2. checklist.txt → 勾选任务表  
3. project-notes → 周报结构（结论优先）  

**coding**

1. 修 calculate.ts 边界 + 测试  
2. sample.py 类型注释  
3. readonly 解释 package.json 脚本  

**design**

1. dashboard-wireframe.html（侧栏+卡片+空态）  
2. README 信息层级整理  
3. landing 文案 MD + 简单 HTML  

### D. 与专家切片的分工（避免重复施工）

| 事项 | 负责切片 |
|------|----------|
| 专家安装/导入/导出/团/召唤/热切 | **已完成**（plan-expert-page） |
| ModeProfile / 锁定 / 技能过滤 / 工具策略 / mode UX | **本计划** |
| **模式文件编辑 + 装配检视（D5）** | **本计划 Phase 0/1/1b** |
| 装配时 expert 段 + welcome 段共存 | 本计划 Phase 1+5 |
| 按 mode 推荐专家排序 | 本计划 Phase 5 |

### E. 可编辑性检查清单（评审/验收用）

- [ ] 三模式长文案是否 **零** 硬编码在 `AgentService.ts`？  
- [ ] 用户能否在 **不重新编译** 的情况下改 goal/workflow/delivery/forbid/criteria？  
- [ ] 能否在 UI 看到 **最终进模型的分段与全文**？  
- [ ] 预览与真实 session 是否 **同一 build**？  
- [ ] 保存后是否明确 **仅新任务生效**？  
- [ ] 能否 **恢复出厂** 并 diff？  
- [ ] 调「模型不听话」时，是否优先打开 Inspector 而不是改代码？  

### F. 模式图标检查清单（D6）

- [ ] 顶层任务是否始终有模式小图标？  
- [ ] **空间下 nested 任务**是否同样有、且不与缩进冲突？  
- [ ] 办公 / 编码 / 设计三图标是否形可辨（不只靠色）？  
- [ ] 与专家 emoji 并存是否清晰？  
- [ ] 历史无 mode 字段是否默认 coding 图标而非空白？  
- [ ] 聊天头 / 搜索是否与侧栏同一 `WelcomeModeIcon`？  

---

## 11. 下一步

| 项 | 状态 |
|----|------|
| D1 策略 A | ✅ |
| D2 全功能 | ✅ |
| D5 高可编辑 + 可调试 | ✅ §3.3 + Phase 1b |
| D6 任务必带模式小图标 | ✅ §3.4 + Phase 4.0/4.3 |
| 代码同步（专家已落地） | ✅ |
| 开工 | **Phase 0 → 1 → 1b** 再 2–6（D6 落在 Phase 4） |

对执行者：主缺口 = **文件化 ModeProfile + PromptAssembly + D5 编辑/检视 + D1 UX + D6 全任务模式图标**。  
**没有装配检视与用户可写 modes 目录，或任务列表缺模式图标，均视为未完成。**
