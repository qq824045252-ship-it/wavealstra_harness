# 复检报告（第三版 · 沙箱解除后重审）

**这份报告修正了我前两版的错误结论。用户判断正确：前两版"感觉都是错的"，主要错因是第一次审查在受限沙箱内进行。**

---

## 0. 我错在哪里（必须先说清楚）

| 版本 | 我的结论 | 真相 |
|---|---|---|
| v1 | "78/236 测试失败，2 个真实红灯" | **错**。沙箱导致约 40 个假失败 |
| v1 | `library-domain`、`consult-selection`、`work-graph-bridge`、`svg-preview-resize` 是"疑似真实缺陷" | **全错**。沙箱解除后这 4 个**全部通过** |
| v2 | "根因是测试未隔离真实用户数据" | **部分错**。多数测试用 `mkdtempSync` 正确隔离；13 个失败在隔离后依旧复现 |
| v1/v2 | "无 CI 是主要问题" | **方向对但归因错**。真问题是**测试与被测代码的契约漂移**，且大批失败其实是**测试自身过时** |

**根本教训**：我第一轮把沙箱 EPERM 当成了产品缺陷的证据。正确做法是先验证"当前环境能否复现该失败的前提条件"，再下结论。

---

## 1. 干净环境下的真实基线（已实测）

沙箱解除后（已实测 `~/.mybuddy` 可写），全量跑 259 个 `test:*`：

```
耗时 26.9 分钟    PASS=221    FAIL=38
```

对比沙箱内：`PASS=158 FAIL=78` → **沙箱污染了约 40 个结果**。

---

## 2. 38 个失败的真实归类（逐个实测，非推测）

### A 类：测试断言了**过时的常量/契约**（约 20 个，占多数）

这是最主要的类别，且**不是产品缺陷**——产品是对的，测试没跟上。

| 测试 | 断言内容 | 代码实际 |
|---|---|---|
| `test:pi100-features` | `'1.0.0'` | 已升级 **1.0.4** |
| `test:work-graph` | `schemaVersion=17` | `AppDatabase.ts:58` = **27** |
| `test:workspace-chunk-r2` | `schemaVersion=17` | 同上（同一陈旧常量，共 2 处） |
| `test:chat-markdown` | 源码须含 `isSvgFenceLanguage(extracted.language)` | `Markdown.tsx:157` 已是 `isSvgFenceLanguage(extracted.language, extracted.code)`，**功能正常** |
| `test:architecture` | 切换专家须 `releaseIfIdle()` 释放会话 | `3261a43` 改为延迟重建，**是更好的设计** |
| `test:workspace-tree` | v12→v13 迁移零损 | 迁移路径**已被刻意废弃**（见 C 类），测试没删 |

量化佐证：`"1.0.0"` 在测试中出现 **37 次**，`"design"` 12 次。

**关键**：`test:chat-markdown` 是 116 通过 / 1 失败，唯一失败项是**字符串级源码匹配**——代码把参数从 1 个改成 2 个（更正确），测试就红了。功能本身没问题。

### B 类：测试的**自建 fixture 不合法**（约 5 个）

| 测试 | 现象 | 判定 |
|---|---|---|
| `test:project-agent` | `TypeError: Invalid value used as weak map key` | **测试 fixture 缺陷**。生产代码 `ModelInvocationAdmission.ts:207` 依赖 `session.sessionManager`，而它在 Pi 上游类型中是**必填**字段（`sessionManager: SessionManager`）；测试造了缺少该字段的假 session |
| `test:library-workspace-context` | `context.memoryDigest is not a function` | **已核实 `memoryDigest` 在 `src/` 中零命中** → 测试驱动了一个不存在的 API |
| `test:runtime-skill-loader` | `未找到连接器: demo-connector` | fixture 未安装依赖 |

### C 类：**测试驱动了已被废弃的旧路径**（约 8 个）

**`test:workspace-tree`（315 通过 / 6 失败）已查明真因，且我上一版的归因是错的。**

我上一版说它"隔离不足、污染真实库"——**错**。实测 `workspace-tree-test.ts:85` 用 `mkdtempSync` 完整隔离，全文**零 `homedir` 引用**。真实原因：

- 该测试 section 1 手工构造一个 **v12 旧库**，再让 `AppDatabase` 走 v12→v13 迁移。
- 但 `AppDatabase.ts:222-240` 的 `resetIncompatibleDatabaseFile`：**只要 `user_version !== 27`（`CURRENT_DATABASE_SCHEMA_VERSION`），就在打开前删除该库文件**（含 `-wal`/`-shm`）。
- 于是测试的 v12 fixture 被直接删掉，6 条迁移断言全部失败。**其余 section 2-24 全部通过。**

**这不是产品缺陷，是"被刻意废弃的迁移路径"仍有测试在测。** 证据：
- `scripts/db-migration-test.ts:73` 明确断言 `"incompatible schema is discarded instead of migrated"`；
- 同文件 `:76` 断言 `"no compatibility backup contract remains"`；
- `docs/MyBuddy-对话分支详细实施规划.md` 已书面确认："文件数据库 `PRAGMA user_version` 只要不等于 `CURRENT_DATABASE_SCHEMA_VERSION`，打开前会被删除并重建。直接把版本从 27 提升到 28 会清掉现有 `app.db`。"

**修正我上一版的判断**：我一度把"无备份即删库 + 无 `NODE_ENV` 守卫"当成生产风险。核对后应更正：这是**有意的开发期契约**（0.1.x 预发布），且被专门测试锁定为期望行为。**唯一成立的提醒**是：该行为没有 `NODE_ENV`/`isPackaged` 守卫（已核实：`AppDatabase.ts` 全文无 `NODE_ENV` 命中），一旦进入正式分发阶段需重新评估——但**当前不算缺陷**。

其余同类项：`test:blender-skill`（依赖宿主存在 `mybuddyskills-main/skills` 目录）、`test:py099-migration`、`test:workspace-files-ui`、`test:chat-selection`、`test:skill-root-guard`（依赖已删除/未安装的文件）。
- `test:blender-skill`：`✗ marketplace 根含仓库 mybuddyskills-main/skills` → 依赖宿主机上是否存在某个仓库目录。
- `test:py099-migration`、`test:workspace-files-ui`、`test:chat-selection`、`test:skill-root-guard`：依赖已删除/未安装的文件与目录。

### D 类：**需要 GUI / CDP / GPU**，本环境无法满足（约 6 个）

`test:durable-bot-desktop`（`Error: CDP timeout Page.captureScreenshot`）、`test:magpie-desktop`、`test:pi099-desktop`、`test:computer-automation-windows`、`test:python-runtime-electron`（其 esbuild + Python 环境准备阶段实际是**成功**的）、`test:multi-model-consult:live`。**这类不是缺陷，需要真实桌面会话**。

> `test:python-runtime-live` 实际跑通了完整流程：`ready 已就绪：Python 3.12 · wheel==0.45.1（Python 3.12.14）`。

---

## 3. 修正后的结构性发现

1. **`test:architecture` 的崩溃会吞掉后续断言**。它在未捕获异常处直接终止进程（`未找到已安装专家: e1`），后面所有 section 都不执行。即便修好契约，也建议包一层让单个 section 失败不中断全局。
2. **源码文本断言占 30%**：257 个测试文件中 **76 个**用 `readFileSync + .includes()` 断言"源码里必须出现某字符串"。这类测试在**正确重构时必然误报**——`chat-markdown` 就是活例。建议改为断言**行为/产物**（渲染结果、返回值），或对纯结构约束收窄到"符号存在"级别。
3. **分层依然干净、依然无机械保护**（此前结论未变）：renderer→main 导入 0/261；但**无 ESLint / dependency-cruiser / madge**，靠惯例。
4. **`artifact-gate` 的两条失败性质不同**（此前已验证）：
   - R4：`captureSurface` 漏加白名单 → **真缺陷**，加入后 PASS（`ArtifactPreviewHost.ts:32` 的 getter，与白名单中 `webContentsView` 同类）。
   - R15：`MemorySkillRevisionService.markStale` 与 SelectionStore 的 stale **只是同名**，语义无关（前者是 DB 状态流转）→ **门禁误报**。
   - 两者都修后 **32/32 PASS**（我在真实文件上验证后已还原，`git status` 确认与 HEAD 一致）。

---

## 4. 建议（按 ROI 重排，已剔除前两版的错误项）

| # | 动作 | 成本 | 理由 |
|---|---|---|---|
| 1 | **建"契约门禁"**：把 schema 版本、Pi 版本、模式名等改为**从代码导出读取**，测试不再硬编码 | 半天 | 一次消除 A 类约 20 个失败。这是**投入产出最高**的一项 |
| 2 | **给 `test:architecture` 的 section 加隔离**，避免一个异常吞掉全部断言 | 1h | 否则修了契约也看不出真实状态 |
| 3 | 修 A 类具体断言（1.0.0→读 package.json；`schemaVersion` 改引 `CURRENT_DATABASE_SCHEMA_VERSION`；SVG 断言改行为） | 2-3h | 立竿见影 |
| 3b | 删除 `workspace-tree` 中已废弃的 v12 迁移 section（或改用当前 schema 断言） | 1h | 该迁移路径已不存在 |
| 4 | 修 B 类 fixture（补 `sessionManager`；移除不存在的 `memoryDigest` 调用） | 2h | 消除假阳性 |
| 5 | 把 D 类（GUI/CDP/GPU）标记为 `:live`，从默认套件排除 | 1h | 让默认套件在无头环境可全绿 |
| 6 | `artifact-gate` R4 加白名单、R15 收窄正则；加 `test:all` | 半天 | 已验证可行 |
| 7 | 逐步把 **76 个**源码文本断言（`readFileSync` + `.includes()`）改为行为断言 | 长期 | 降低重构误报率（`chat-markdown` 已因此误报） |
| 8 | 加依赖分层门禁 | 半天 | 保护现有干净分层 |
| 9 | `git rm --cached artifacts/`（67.1MB / 1217 文件，含 2 份重复上游树 + 7 个 APK） | 1h | 版本库瘦身 |

### 明确**不建议**做的
- **不要**为 `ModelInvocationAdmission.ts:207` 加 undefined 防御——`sessionManager` 是上游必填字段，加防御会掩盖测试 fixture 的错误。应修 fixture。
- **不要**全仓扫荡空 `catch {}`。仅 `LibraryService.ts:1217-1243` 一处值得改（**已核实**：embedding 失效被静默吞掉且不打日志，而同函数 `:1240` 的写入失败**有** `console.warn`；另有 `invalidateEmbeddingsForChangedChunks` 三个参数全部未使用）。

---

## 5. 结论

- **产品代码的质量比我前两版说的好**：干净环境下 221/259 通过，38 个失败中**绝大多数是测试侧问题**（过时常量、非法 fixture、废弃路径、宿主机依赖、需要 GUI），我**没有找到确证的产品功能缺陷**。
- 唯一确证的产品侧问题是 `LibraryService` 的静默 catch（正确性/可观测性），以及 `artifact-gate` 的 R4 白名单过时。
- **"删库重建"不是缺陷**：它是被文档与 `db-migration-test.ts:73/76` 双向锁定的开发期契约。我上一版把它当风险是过度解读；仅提示其缺少 `NODE_ENV` 守卫，供正式分发前复查。
- **真正的债务是测试与代码之间的契约没人维护**：259 个测试脚本没有聚合门禁、没有 CI，导致"过期常量"（`1.0.0` 出现 37 次）、"废弃迁移路径"和"源码字符串断言"（76 个文件）可以长期腐烂而无人察觉。这也解释了为什么仓库自身不知道有 38 个红灯。

**局限声明**：D 类（GUI/CDP/GPU）与 C 类中依赖宿主机的项，我**无法**在当前环境确证其在真实桌面会话下是否通过。建议在正常开发者机器上重跑一次以补齐结论。
