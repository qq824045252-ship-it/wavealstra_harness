# DeepSeek Harness 能否借鉴 MyBuddy 的记忆功能？

> 评估对象：`wavealstra_harness`（MyBuddy）Memory Kernel ↔ DeepSeek Harness（DSH）desktop runtime `0.2.0-rc.2`
> 评估日期：2026-10-01 · 结论：**能借鉴，且部分已经在复用；但"借鉴"的正确形态不是移植代码，而是分三层落地**

---

## 0. 一句话结论

DSH **没有任何第一方长期记忆实现**——没有记忆领域包、没有类型化记忆记录、没有跨会话召回、没有语义检索、没有生命周期与来源追踪。DSH 官方把第三方记忆**显式外包给 MCP**（`dsh-mcp-client` README 指向一份 "Third-party memory MCP guide"）。

因此答案是分层的：

| 层次 | 判断 |
|---|---|
| **概念/设计** | 高度值得借鉴，MyBuddy 的 33 条可移植设计思想中，绝大多数 DSH 完全没有对应物 |
| **接入形态** | **不需要改 DSH 代码**。`dsh-mcp-client` + Streamable HTTP 就是官方留好的口子 |
| **数据/代码** | **不可移植**。MyBuddy 的记忆真源是 Electron + SQLite(`app.db`) + Pi 扩展，与 DSH 的 cordis 插件 + session log 事件溯源模型是两套世界观 |
| **已经发生的复用** | MyBuddy 的 Procedure→Skill 产物**已经被 DSH 发现**（见 §3.1），格式天然兼容 |

---

## 1. 证据基础

本轮为取证做了以下工作，全部只读、可复现：

- 从 `app.asar` 解析并提取 **43 个 DSH 包**到 `artifacts/dsh-inspect/pkg/`（2.9 MB），以各包 README 为权威规格、`lib/index.js` 为编译期佐证。
- 读取 DSH 真实用户态：`~/.dsh/` 的 profiles、patch、storages、sessions、market 缓存。
- 读取 MyBuddy 记忆子系统源码与文档，并**解压 DSH 自己的会话日志**（`session.v4.jsonl.zstd`，484 个 zstd 帧，2.8 MB 文本）做交叉验证。
- 实测 DSH 技能门禁行为（见 §3.1）。

---

## 2. 两边各自是什么

### 2.1 MyBuddy：一个完整的记忆内核

四层结构，**只有 L1 是唯一真源**，L2/L3 是显式可丢弃的派生投影：

```text
L0  memory_turns        原始对话证据（素材，不是认知）
L1  memory_records      ★ 唯一持久认知真源（9 种 kind + scopes/evidence/relations/revisions）
L2  memory_scenarios    派生场景视图（需人工批准）
L3  memory_core_profiles 派生高层画像（需人工批准）
```

关键机制（均有 `path:line` 证据，详见附录）：

- **9 种记忆类型**：`identity / preference / fact / decision / constraint / risk / open_question / progress / procedure`
- **4 级作用域链 + 距离**：`task(0) → project(1) → workspace(2) → 祖先 workspace(3+) → global(10)`，单一解析点 `resolveScopeChain`
- **owned vs promoted 绑定**：扩大可见范围只加绑定、**不复制正文**，一处修改处处生效
- **追加式 revision 日志**：每次变更写一条带序号的 revision，无变化则提前返回不写
- **证据链**：`UNIQUE(memory, kind, ref_id)` + 反向索引，可回答"哪些长期记忆引用了这一轮对话"
- **混合召回**：FTS5 trigram(bm25) + BGE-M3 向量(1024 维, 阈值 0.50)，用 **RRF(K=60)** 融合，再加可解释的元数据加权
- **竞态防御是一等公民**：scope stamp 在每个 await 后复验、缓存 DTO 不算授权、迟到 embedding 不得复活已删除记录
- **Procedure→Skill 学习**：纯确定性（无 LLM），内容哈希派生 ID，源变化自动失效
- **外部边界**：`127.0.0.1:3351` 的 HTTP + MCP Streamable HTTP，委托授权 + 双重写门禁

### 2.2 DSH：有完整的上下文栈，没有记忆领域

| DSH 已有 | 说明 |
|---|---|
| `dsh-agent-instructions` | `AGENTS.md`/`CLAUDE.md` 链，按 `.git` 定根、broad→specific、65536 字节预算、touch 驱动刷新 |
| `dsh-system-prompt` | 分节注册表 + `system-prompt/assemble` waterfall；**3100→5000 是空闲 order 段** |
| `dsh-compaction` | 8 段式摘要 + `compaction/*` 日志锁括号；**摘要不可跨会话复用** |
| `dsh-session-persistence` | 追加式 `.jsonl.zstd`，flush 即持久化屏障 |
| `dsh-session-query-sqlite` | FTS5 跨会话全文检索——**但 base 里默认 `openAt: never` 等于关闭** |
| `dsh-storage-domain` | zod 校验的 KV 域，写盘在 `~/.dsh/storages`；**模型不可见** |
| `dsh-mcp-client` | stdio + streamable-http，工具名 `mcp__<server>__<tool>`，支持自定义 auth header |
| `dsh-skill-filesystem` | 扫描 `~/.agents/skills`（rank 500）等 5 个根 |

**DSH 明确没有**（枚举 `dsh-package.json` 全部 287 个依赖 / 279 个 `@deepseek-ai/dsh-*` 包确认，`memory|recall|knowledge|vector|embed|rag|journal|notebook|diary` **只命中 3 个 `storage*` 包**，无任何记忆包）：

1. 类型化持久记忆记录 2. 跨会话召回 3. 语义/向量检索 4. 生命周期/过期/衰减
5. 来源与置信度 6. 沉淀回写 7. 面向模型的 remember/recall 工具 8. 跨会话记忆命名空间
9. 去重/冲突消解 10. 重要性/新近度/访问计数排序 11. 模型可见的持久存储 12. 第一方记忆实现

两条**硬约束**决定了 DSH 侧的实现形态：

- 禁止追加自定义 `type` 的 session 事件（重开会被拒），插件数据必须走 `ctx.storageDomain`
- session log 是唯一真源，插件记忆只能是**派生缓存**

---

## 3. 借鉴判定：分五类

### 3.1 A 类 · 已经在发生的复用（实证）

**MyBuddy 的 Procedure→Skill 产物，DSH 已经在消费。**

证据链：

1. MyBuddy 把学到的 procedure 写成 `~/.mybuddy/skills/<slug>/SKILL.md` + `_skillhub_meta.json`。
2. `~/.agents/skills/` 下有 **35 个 junction**指回 `~/.mybuddy/skills/`，其中**包含两个 `learned-*`**。
3. DSH 的 `dsh-skill-filesystem` 在 rank 500 扫描 `<agentsHome>/skills` —— 即 `~/.agents/skills`。
4. MyBuddy 生成的 frontmatter（`name` kebab-case + `description` + `disable-model-invocation`）**正好是 DSH 认得的格式**。

实测门禁行为（决定性证据）：

```text
skill("learned-procedure-13cd6be")
→ Error: skill "learned-procedure-13cd6be" is not available for model invocation
```

这条报错**只可能由"发现到了但被门禁拦下"产生**——若未发现，DSH 的报错文案是"unknown / no longer available"。因此：

- ✅ **已被发现**：目录链路与格式天然兼容，零适配成本
- ❌ **不在模型目录**：因为 `disable-model-invocation: true`（`dsh-skill-filesystem/lib/index.js:856` 把 `modelInvocable` 置为 `false`）
- ✅ **用户仍可调用**：`/learned-procedure-13cd6be` 走 `/name` 手势路径

> **诚实更正**：我在本轮取证中途曾一度断言"两个 learned skill 已出现在我自己的技能目录里"。**该断言是错的**——我核对了会话日志 seq=12 的持久目录消息，39 个技能中**不含**任何 `learned-*`。上面的结论是修正后的版本，依据是实测报错文案 + 日志原文，而非目录印象。

**这条复用的意义**：MyBuddy 的"记忆沉淀为技能"这条链路，**已经跨产品落地到 DSH**，只是被 MyBuddy 自己标成了"仅用户可调用"。这为后续深化提供了现成的、已验证的通道。

### 3.2 B 类 · 零改码即可接入（官方留好的口子）

MyBuddy Memory Gateway 是**每工作区一个、Bearer 鉴权的 Streamable HTTP MCP 端点**：

```text
httpBaseUrl = http://127.0.0.1:3351/v1/memory
mcpUrl      = http://127.0.0.1:3351/mcp
mode        = read-write
tools       = memory_search / get / history / context / stats / create / update / promote / forget
```

这**正是 `dsh-mcp-client` 接受的结构**。配置形态（写入 profile 的 `cordis.patch.yml`）：

```yaml
- id: mcp-mybuddy-memory
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: mybuddy
    transport: streamable-http
    url: http://127.0.0.1:3351/mcp
    headers:
      # 注意：不能用 ${process.env.MYBUDDY_MEMORY_TOKEN}——名字含 TOKEN 的
      # 环境变量会被 dsh-mcp-client 清洗掉。必须直接内联 token 字面量。
      Authorization: 'Bearer <粘贴 runtime/memory-share 里对应工作区的 token>'
    toolCallTimeoutMs: 30000
    failOnStartupError: false
```

接入后模型直接得到 `mcp__mybuddy__memory_search` 等工具。

**三个必须注意的坑（已实测）**：

1. **Gateway 依赖 MyBuddy 主程序存活**——本项测试期间，Gateway 先返回 200，随后 MyBuddy 被关闭，`3351` 立即变为 `ECONNREFUSED`。即**Gateway 不是独立守护进程**，随 MyBuddy 起落。DSH 侧应设 `failOnStartupError: false` 并容忍断连。
2. **token 不能走环境变量**——`dsh-mcp-client` 会清洗掉名字匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的环境变量。必须把 token 字面量写进配置（或用一个不含上述关键词的变量名）。
3. **desktop profile 的包操作归 Electron 管**——`dsh plugin --profile desktop` 会被拒绝（"managed exclusively by the Electron application"），需通过 Web 插件页 / `plugin_manager` 工具，或手工编辑 `~/.dsh/profiles/desktop/cordis.patch.yml` 后重启。

#### 读还是写？——**默认两者都有，但按授权分层**

实测在线 Gateway（`initialize` + `tools/list`）返回 **9 个工具**：

| 工具 | 注解 | 归属 |
|---|---|---|
| `memory_search` / `memory_get` / `memory_history` / `memory_context` | `readOnly` | 读，始终暴露 |
| `memory_stats` | `readOnly` | 读，**仅 owner** |
| `memory_create` / `memory_update` | 非破坏 | 写，**仅当 `writeEnabled`** |
| `memory_promote` | `idempotent` | 写，仅当 `writeEnabled` |
| `memory_forget` | **`DESTRUCTIVE`** | 硬删除，仅当 `writeEnabled` |

决定权在两个独立谓词（`MemoryGatewayServer.ts:210,244,253`；`MemoryGatewayService.ts:127-137`）：

```text
memoryEnabled  -> false 时 MCP 连 tools 能力都不声明（只剩空 server）
writeEnabled   = 外部写总闸 AND (owner OR grant.mode === "read-write")
isOwnerAccess  -> 决定是否暴露 memory_stats
```

因此"只能读还是能写"取决于**三层叠加**：

| 层 | 开关 | 当前位置 |
|---|---|---|
| 产品总闸 | `memoryEnabled` | `true` |
| 外部写总闸 | `memoryGatewayWriteEnabled` | `true` |
| 每 grant 模式 | `grant.mode` | 27 个 grant **全部** `read-write` |

**结论：在你当前机器上，接入后是「读 + 写」全都可用**，包括 `memory_forget` 这种硬删除。这有一个直接的安全含义，见 §5。

> **一处方法论更正**：我最初用"空 title 触发 400"来证明写通道可达，这是**错的**——Zod 校验在 `MemoryGatewayServer.handleHttpApi` 的 `schema.parse()` 里**先于** `gateway.create()` 执行，所以 400 完全不能说明门禁状态。改用正确判据后：`requireWrite()` 在 `create()` 第 291 行、`update()` 第 326 行，**先于** `requireVisible()`（第 329 行）。因此对**不存在的 id** 发 `update`，若返回 `404 not_found` 而非 `403 write_disabled`，即证明已穿过写门禁。实测 owner token 返回 `403 forbidden_scope`（来自更靠后的 `resolveCreateScope`），确认门禁放行。

### 3.3 C 类 · DSH 值得向 MyBuddy 借鉴的设计（价值最高）

这些是 MyBuddy 有、DSH 完全没有、且**与 Electron/SQLite 无关**的思想：

| # | 思想 | 为什么 DSH 需要 | MyBuddy 证据 |
|---|---|---|---|
| 1 | **声明式单一真源分层**：L1 权威，L2/L3 显式可丢弃 | DSH 的 compaction 摘要、projection cache 都是派生的，但没有"哪层是权威"的契约 | `memory-kernel.ts:4-9` |
| 2 | **派生视图需批准 + 版本戳接地** | DSH 的 compaction 摘要自动生成、无审批、不可复用 | `MemoryProjectionRepository.ts:133-161` |
| 3 | **内容派生 ID + 废弃台账** | 内容寻址的重生成是幂等的，但单纯删除会"复活"——必须有独立抑制记录 | `AppDatabase.ts:705-707` |
| 4 | **作用域链带显式距离，最近优先** | DSH 的 `dsh-scope` 是进程内注册隔离，**不持久、不是权限边界** | `MemoryService.ts:989-1016` |
| 5 | **owned vs promoted 绑定，不复制正文** | 避免"一处修改、多处不同步" | `MemoryService.ts:586-602` |
| 6 | **追加式 revision + 无变化不写** | DSH 有 CAS revision（goal），但没有通用记录版本 | `MemoryRepository.ts:526-540` |
| 7 | **证据去重键 + 反向索引** | 让"这条结论从哪来"可查 | `AppDatabase.ts:605-606` |
| 8 | **抽取必须有逐字用户证据** | 防幻觉沉淀；DSH 无此概念 | `MemoryService.ts:881-884` |
| 9 | **复核队列而非静默接受** | 低置信度进 `needs_review`，批准时跑 force 模式 | `MemoryService.ts:913-916` |
| 10 | **每个 await 后复验 scope stamp** | DSH 的插件都是异步的，同样存在授权漂移 | `MemoryService.ts:660-667` |
| 11 | **缓存 DTO 不算授权** | 与 DSH "session log 是唯一真源" 天然契合 | `MemoryService.ts:686-700` |
| 12 | **迟到写入不得复活已删除状态** | 通用异步正确性模式 | `MemorySemanticProvider.ts:52-56` |
| 13 | **每轮冻结胶囊 + 仅撤销可打断** | 内容变更下一轮生效，但**撤销必须拦住进行中的请求** | `EphemeralContextProjection.ts:146-170` |
| 14 | **按来源 ID 集合去重，不按文本相似度** | 可追溯优于启发式 | `MemoryContextProjection.ts:48-49` |
| 15 | **RRF 融合 + 可解释加权** | DSH 只有 FTS5 单一排序 | `MemoryService.ts:703-713` |
| 16 | **字节预算 + 显式截断标志** | DSH 已有 `maxBytes`，但缺"未展示内容不得当作已读"的提示 | `MemoryContextProjection.ts:26-34` |
| 17 | **补充预算耗尽绝不削减工具能力** | 重要安全属性 | `EvidenceBudget.ts:33-35` |
| 18 | **确定性（无 LLM）记忆→技能提升** | 可复现、可审计 | `MemorySkillLearningService.ts:419-434` |
| 19 | **技能候选携带源签名做接地检查** | 源变了自动失效，而非静默发旧指令 | `MemorySkillLearningService.ts:226-231` |
| 20 | **反馈驱动修订，而非结果驱动** | 只有明确负面反馈才触发修订 | `MemorySkillRevisionService.ts:120-123` |
| 21 | **遥测与权威分离** | 效果统计**契约上禁止**改记忆/技能/状态 | `MemorySkillEffectivenessService.ts:72-75` |
| 22 | **外部写双重门禁** | 总闸 AND grant.mode AND 目标 scope 在边界内 | `MemoryGatewayService.ts:127-132` |
| 23 | **多 scope 记录全有或全无** | 防"部分权限编辑跨 scope 传播" | `MemoryGatewayService.ts:478-482` |
| 24 | **"不存在"与"越权"合并为同一响应** | 防存在性探测 | `MemoryGatewayService.ts:515-525` |
| 25 | **委托读取剥离来源 + 历史截断** | 防倒带读取授权前上下文 | `MemoryGatewayService.ts:267-281` |
| 26 | **外部写入者不能冒充内部主体** | 强制 `sourceType=tool` + 前缀 changeReason | `MemoryGatewayService.ts:303-311` |
| 27 | **中断工作按状态降级恢复** | 而非留成卡死；DSH 用 `TOOL_OUTCOME_UNKNOWN`，思路一致 | `AppDatabase.ts:815-823` |
| 28 | **尝试预算 + pending/failed 显式分离** | `attempt_count < 3` | `MemoryTurnRepository.ts:134` |
| 29 | **世代计数器杀死过期异步输出** | 用户删除后 LLM 才返回 ⇒ 丢弃 | `MemoryCognitionService.ts:319-326` |
| 30 | **内容哈希统一失效机制** | embedding/projection/skill 三处同一套 | `MemorySemanticProvider.ts:45-48` |
| 31 | **写边界拒绝敏感内容** | 密钥/令牌/40+ hex 永不入记忆 | `MemoryService.ts:130-136` |

### 3.4 D 类 · 反过来，MyBuddy 该向 DSH 借鉴

评估是双向的，DSH 这几处比 MyBuddy 更严谨：

| DSH 机制 | 优于 MyBuddy 之处 |
|---|---|
| **事件溯源 + 确定性重放** | DSH 的 session log 是唯一真源，摘要留在日志里，重放必然复现；MyBuddy 的胶囊是请求级补充，不进历史 |
| **compaction 日志锁括号** | `compaction/start → summary → replace → end`，崩溃留下**可检测的孤儿锁**；比"先删后写"更安全 |
| **KV-cache 感知的注入** | DSH 每个包都显式声明 KV cache 影响（append-only vs 前缀失效）；MyBuddy 未系统化考虑 |
| **工具结果配对的边界校验** | `toolPairingBalancedBefore/After` 保证压缩切点不劈开未应答的工具调用 |
| **插件作用域注册 + 生命周期** | `createScope` / `ctx.effect` 让注册与销毁严格同生命周期 |
| **能力证明后再投影图片** | 精确路由能力证明，否则降级为诊断文本 |

### 3.5 E 类 · 不可移植 / 不该移植

| 项 | 原因 |
|---|---|
| MyBuddy 的 SQLite schema 与 17 张记忆表 | DSH 没有 `node:sqlite` 之外的存储契约；且 DSH 明确禁止插件自定义 session 事件类型，必须走 `ctx.storageDomain`（无二级索引、无跨表事务） |
| Pi 扩展机制（`pi.registerTool`） | DSH 是 cordis 插件模型（`apply(ctx, config)` 或 service class） |
| Electron IPC 记忆管理 UI | DSH 是 Web GUI + 插件页 |
| `memoryEnabled` 作为产品总闸 | DSH 没有等价产品开关；应由配置行 `disabled` 或 MCP 未挂载表达 |
| MyBuddy 的 L2/L3 自动生成节奏 | 本来就没有自动节奏（需人工批准），移植意义有限 |
| 直接复用 MyBuddy 的 `app.db` | 跨进程、跨产品写同一 SQLite 文件会破坏 WAL 与单写者假设；**必须走 Gateway** |

---

## 4. 推荐落地路径

### 路径 1（推荐，今天就能做）：MCP 接入，零改码

```text
MyBuddy (启动 + 开 Gateway)
   ↓ 127.0.0.1:3351/mcp  Bearer <workspace token>
dsh-mcp-client (streamable-http)
   ↓
mcp__mybuddy__memory_search / memory_context / memory_create ...
```

- **工作量**：一份 patch 行 + 一个 token
- **收益**：模型立即获得检索/沉淀长期记忆的能力
- **局限**：只有工具式召回，**没有自动注入**——模型得主动调用才会想起来
- **前置**：MyBuddy 必须运行；token 必须内联字面量（不能走环境变量）

**建议同时收紧写权限**：既然接入后默认连 `memory_forget`（硬删除、无撤销）都会暴露给模型，建议按下表择一：

| 方案 | 做法 | 适用 |
|---|---|---|
| 只读接入 | 把外部写总闸关掉（`memoryGatewayWriteEnabled = false`），或把 grant 改为 `read` | 只想让 DSH 读已有记忆 |
| 可写但不可删 | 保持总闸开、grant 为 `read-write`，但在 DSH 侧用 `ctx.tools.restrict()` 屏蔽 `mcp__mybuddy__memory_forget` | 允许沉淀、禁止硬删除（**推荐**） |
| 全开 | 保持现状 | 信任模型且接受误删风险 |

> 注意：`memory_forget` 是**硬删除**且**没有撤销**（`MemoryService.forget` → `hardDelete`，级联删除 relations/embeddings）。与 `dsh-compaction` 的"shadowed 但仍可检索"不同，删了就没了。这是接入时最需要显式决策的一项。

### 路径 2（收益最大）：补上"自动召回"的原生插件

MCP 的短板是"要模型主动想起去查"。要做到 MyBuddy 那种**每轮自动注入**，需要一个 DSH 原生插件：

```text
插件 apply(ctx, config)
  ├─ ctx.storageDomain.open(memorySpec)      # 持久记忆（禁止自定义 session 事件）
  ├─ ctx.tools.register()                     # remember / recall 工具
  ├─ ctx.on('agent/pre-step', ...)            # 或 agent.inject() 注入持久来源消息
  └─ ctx.systemPrompt.section({ order: 3200 }) # 3100→5000 空闲段
```

**关键设计约束**（来自 DSH 官方插件规范）：

- ❌ 不要追加自定义 `type` 的 session 事件——会导致会话无法重开
- ❌ 不要用 `system-prompt/assemble` 加文本（官方明确劝阻）
- ✅ 注入应为**带来源的持久 user 消息**（照 `dsh-agent-instructions` 与 `dsh-time-context` 的做法），这样能安然穿越 compaction / resume / fork
- ✅ 记忆只能是**派生缓存**，session log 仍是唯一真源

### 路径 3（长期）：把"已发现但被门禁"变成真正的复用

MyBuddy 的 `learned-*` 技能**已经被 DSH 发现**，只是 `disable-model-invocation: true` 挡住了模型目录。若要打通：

- 让 MyBuddy 对"高置信度 + 已批准"的 procedure 技能**不再**写 `disable-model-invocation: true`，或改为按 kind/scope 分级
- 收益：MyBuddy 学到的流程**自动成为 DSH 的模型可用技能**，无需任何 DSH 改动
- 风险：需要 MyBuddy 侧的质量门禁足够严（目前 `isReady` 三条件已存在，可复用）

---

## 5. 风险与反例

| 风险 | 说明 | 缓解 |
|---|---|---|
| **记忆跨产品污染** | 同一个 Gateway 的 token 按 workspace 授权；DSH 的 cwd 若与 MyBuddy 工作区不匹配，`mybuddy-memory` CLI 会找不到 profile | 用 MCP 的 `taskId`/显式上下文，或按 cwd 匹配确认 |
| **token 泄露** | 明文 token 在 `~/.mybuddy/runtime/memory-share/*.json` | 该文件已有用户级 ACL；DSH 侧勿把 token 写进可提交文件 |
| **DSH 插件不强制 engines.dsh** | 官方明确"loader 不强制 `dsh.manifestVersion` / `engines.dsh`" | 自建插件需自行对齐版本 |
| **原生插件打破"session log 唯一真源"** | 若把记忆当第二真源，resume/fork 会不一致 | 严格把插件记忆当派生缓存 |
| **desktop profile 无法用 CLI 装插件** | `dsh plugin --profile desktop` 被拒 | 走 Web 插件页或手工 patch + 重启 |
| **过度设计** | DSH 是通用 harness，未必需要 MyBuddy 的全套四层 | 建议先落地 L1 + 召回 + 生命周期，L2/L3 视需要 |

**一个诚实的反例**：DSH 官方**有意**不做记忆，把这件事留给 MCP 生态。市场里已有 9 个记忆类插件（`dsh-memory-eternal`、`dsh-mnemon`、`@kenz1117/dsh-engram`、`@openviking/dsh-memory-plugin`、`@furongjun1999/dsh-memory`、`dsh-vault`、`dsh-context`、`billion-context`、`@vectorize-io/hindsight-coding-agents`）。因此"DSH 该不该内置记忆"本身是一个**产品判断**，不是技术空白。借鉴 MyBuddy 的价值在于**语义质量**（证据链、作用域、竞态防御），而非"从无到有"。

---

## 6. 建议

1. **立即**：走路径 1，用 MCP 把 MyBuddy Gateway 接进 DSH，先跑通工具式召回。这是零风险、可回滚的验证。
2. **然后**：只借鉴 §3.3 中**第 1/2/3/4/5/6/7/10/11/12/13/14/22/23/24** 条——这些是 DSH 真正缺的语义骨架。
3. **暂缓**：L2/L3 派生投影、Procedure→Skill 全套学习闭环。DSH 生态已有插件在做，先看是否需要重复建设。
4. **反向**：把 §3.4 的 DSH 机制（事件溯源、日志锁括号、KV-cache 感知、工具配对边界）反馈回 MyBuddy。

---

## 附录 · 证据索引

**DSH 侧**（提取自 `app.asar`，位于 `artifacts/dsh-inspect/`）

| 结论 | 位置 |
|---|---|
| DSH 版本 0.2.0-rc.2 / 287 个依赖（279 个 `dsh-*`） | `artifacts/dsh-inspect/dsh-package.json` |
| MCP 配置形态、`streamable-http`、auth header、env 清洗 | `artifacts/dsh-inspect/pkg/dsh-mcp-client/README.md:34-53,138,152` |
| `disable-model-invocation` 门禁实现 | `artifacts/dsh-inspect/pkg/dsh-skill-filesystem/lib/index.js:849-859` |
| 技能根与 rank（`~/.agents/skills` = 500） | `artifacts/dsh-inspect/pkg/dsh-skill-filesystem/README.md:46-56` |
| 禁止自定义 session 事件 / 唯一真源约束 | `artifacts/dsh-inspect/pkg/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md:7,21` |
| prompt order 空闲段 3100→5000 | `artifacts/dsh-inspect/pkg/dsh-system-prompt/lib/index.js:10-43` |
| session FTS5 默认关闭 | `artifacts/dsh-inspect/pkg/dsh-base/cordis.patch.yml:149-153` |
| storage 写盘位置 `~/.dsh/storages` | `artifacts/dsh-inspect/pkg/dsh-base/cordis.patch.yml:168-171` |
| compaction 不可跨会话复用 | `artifacts/dsh-inspect/pkg/dsh-compaction-basic/README.md:177` |
| DSH 无记忆领域（12 项缺失） | `artifacts/dsh-inspect/pkg/` 全包枚举 |

**MyBuddy 侧**（仓库根相对路径）

| 结论 | 位置 |
|---|---|
| 四层契约、9 kind、预算常量 | `src/shared/memory-kernel.ts:4-9,11-20,486-489` |
| 作用域链与距离 | `src/main/memory/MemoryService.ts:989-1016` |
| 混合召回 + RRF | `src/main/memory/MemoryService.ts:670-720` |
| scope stamp 竞态防御 | `src/main/memory/MemoryService.ts:660-667,686-700` |
| 召回投影与去重规则 | `src/main/agent/MemoryContextProjection.ts:24,48-49,54,68,92` |
| 外部边界与双重门禁 | `src/main/memory/MemoryGatewayService.ts:127-132,478-482,515-525` |
| Gateway 与 MCP 工具面 | `docs/portable-memory-gateway.md`、`src/main/memory/MemoryGatewayServer.ts:208-288` |
| 17 张记忆表 | `src/main/db/AppDatabase.ts:572-813` |
| Procedure→Skill 确定性提升 | `src/main/memory/MemorySkillLearningService.ts:419-434` |

**实测证据**

| 结论 | 方法 |
|---|---|
| `learned-*` 已被发现但被门禁 | `skill("learned-procedure-13cd6be")` → `not available for model invocation` |
| 持久技能目录不含 learned | 解压 `~/.dsh/sessions/.../session-c7904299.../session.v4.jsonl.zstd`（484 帧），seq=12 消息含 39 个技能、0 个 `learned-*` |
| Gateway 当前未运行 | `127.0.0.1:3351` TCP 连接被拒，`/healthz` ECONNREFUSED |
| 35 个 junction 含 2 个 learned | `~/.agents/skills` 目录枚举 |
