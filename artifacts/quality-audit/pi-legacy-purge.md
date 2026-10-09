# 删除旧 Pi 版本兼容（2026-10-09）

依据用户指示：**只支持当前 Pi 版本（1.0.4）；旧版本不兼容的直接删除，不留测试、不强行兼容。**

![Pi 版本支持边界与旧版本兼容清理](../diagrams/pi-version-support.svg)

---

## 删了什么

### 9 个旧版本 test 条目（package.json）

| 条目 | 版本 | 说明 |
|---|---|---|
| `test:pi099-migration` | 0.99.x | **原本就在失败**（夹具 MCP 被新版 Pi 判为 `not enabled in this session`） |
| `test:pi099-closeout` | 0.99.x | **原本就在失败**（直接串联上一条） |
| `test:pi099-manager` | 0.99.x | 0.99.x 管理器生命周期 |
| `test:pi099-desktop` | 0.99.x | 0.99.x 桌面验收 |
| `test:pi099-portable-worker` | 0.99.x | 0.99.x 便携 worker |
| `test:pi099-worker-invocation` | 0.99.x | 0.99.x worker 调用 |
| `test:pi0992-memory-race` | 0.99.2 | 0.99.2 记忆竞态 |
| `test:pi0992-mcp-config` | 0.99.2 | 0.99.2 MCP 配置兼容 |
| `test:pi0992-memory-capsule` | 0.99.2 | 0.99.2 记忆胶囊 |

### 49 个脚本文件

- `scripts/pi099-*`（含迁移集成、验收、冻结分发、桌面 live、OAuth、原生 MCP smoke 等）——**全部**
- `scripts/pi0992-*`（含 upgrade / closeout / 各类 fix-*.py / 便携构建等）——**全部**
- `scripts/build-pi0992-portable.cjs`（只服务 0.99.2 的分发构建）
- `scripts/pi-native-desktop-live.cjs`（**无人引用**的孤儿，且依赖 `pi099-workflow-server.mjs`）

### 6 个脚本里的悬挂引用（清理，不是删除脚本）

删除上述 test 后，这些脚本会引用到不存在的条目而报 `Unknown test ...`：

| 脚本 | 处理 |
|---|---|
| `build-pi-codemode-auto-portable.cjs` | 移除调用 `test:pi0992-mcp-config` 的步骤 |
| `build-pi-host-exit-portable.cjs` | 同上 |
| `build-pi-minimal-mode-portable.cjs` | 同上 |
| `pi-codemode-auto-regression.cjs` | 从测试清单移除 3 个已删条目 |
| `pi-host-exit-regression.cjs` | 从测试清单移除 3 个已删条目 |
| `test-all.mjs` | 移除针对已删用例的排除规则 |

> 做法说明：这 6 个脚本本身是**当前功能**的构建/回归工具（只是清单里混了旧版本条目），所以**修引用**而不是删脚本。
> 删除前已做引用分析：只有「仅被 pi099/pi0992 自己引用」的文件才删。

---

## 保留了什么，为什么

### 1. `PiAzureProviderMigration.ts` —— **保留**（这是当前版本自己的升级路径，不是旧版本包袱）

- 它做的是把 **1.0.4 之前**的 `azure-openai-responses` 配置迁移到 1.0.4 的 `azure`（备份后缀 `.pre-pi104-azure.bak`）。
- **生产代码在 `AgentService.ts:1138` 真的调用它**（`migratePiAzureProvider(getMyBuddyDir(), this.db.connection)`）——不是死代码。
- 删掉的后果：从旧版本升上来的用户**会丢掉 Azure 模型配置**。
- 它由 `test:pi104-model-compat` 覆盖，**当前是通过的**。

**判断**：这是"升级到当前版本"的必要兼容，不是"为旧版本保留包袱"。若你确认要连它也删（即不保证从 <1.0.4 升级的用户配置），告诉我，我一并删掉 `PiAzureProviderMigration.ts` + `test:pi104-model-compat`。

### 2. `pi099-electron-stub.ts` —— **改名保留** → `scripts/pi-electron-stub.ts`

它被 **3 个现行用例**当 `--alias:electron=` 使用：`test:pi100-features`、`test:pi-native-core-tools`、`test:pi104-features`。
直接删会连带弄坏它们，所以只去掉名字里的 `pi099`，引用同步更新。

### 3. `pi100-* / pi104-*`（5 个条目）—— **保留**

它们名字里带版本号，但验的是**当前仍存在的功能**（1.0 线特性、模型准入、上下文边界），不是跨版本迁移。
删掉会真正丢失当前版本的覆盖，因此不属"旧版本兼容清理"的范围。

### 4. 那些 `Legacy*` 文件 —— **保留**

`LegacyExecutionControlHistory.ts`、`LegacyMemoryHistoryHygiene.ts`、`LegacyMemorySummaryRecovery.ts`
处理的是 **MyBuddy 自己的历史会话/记忆格式**（`mybuddy.legacy-memory-tail-v1` 等），与 **Pi 版本无关**。
删掉会破坏现有用户的会话与记忆恢复。

---

## 验证

```
pnpm -s typecheck            → exit 0
pnpm -s test:all             → 240 通过 / 1 已知失败 / 0 新增回归 → exit 0
```

- default 套件用例数：**249 → 241**（删掉 9 个旧版本条目，`--list` 复核）
- 已知失败：**3 → 1**，仅剩 `test:project-agent`（产品语义待定，与本轮无关）
- 悬挂引用复核：`test:pi099*` 在 `package.json` / `scripts/**` 中**已无残留**

---

## 第二批：历史 artifacts 与一次性升级工具链（同日追加）

用户追加要求清理旧版本 artifacts，已执行。

### 删除的历史验收产物（564 个受控文件）

| 目录 | 内容 | 受控文件 |
|---|---|---|
| `artifacts/pi0992-memory/` | 0.99.2 记忆验收产物 | 251 |
| `artifacts/pi100-upgrade/` | 1.0.0 升级产物（含**重复的上游 pi-coding-agent 包树**、桌面截图、检查结果） | 295 |
| `artifacts/pi104-upgrade/` | 1.0.4 升级产物（含打包审计、快捷方式备份 `.lnk`） | 18 |

**安全性验证**：现行 `pi100-*` / `pi104-*` 测试会往这些目录写结果文件，但它们写之前都会
`mkdirSync(..., { recursive: true })`——所以删掉目录**不影响**测试。已实测这 5 个用例全部通过：

```
pi100-features / pi100-model-admission / pi100-context-boundary / pi104-features / pi104-model-compat  → 全部 exit 0
```

并在 `.gitignore` 里加了这 3 个目录，避免测试输出（如 `features-results.json`）被重新纳入版本库
（已复核：测试重建的文件不会出现在 `git status`）。

### 一并删除的一次性升级工具链（12 个脚本）

它们只服务已完成的 1.0.0 升级，**无人引用**（package.json 与其它脚本都不引用），
其中几个会**直接改写源码**或用已删路径，留着有误用风险：

`pi100-adapt-host.cjs`、`pi100-complete-assets.cjs`、`pi100-complete-model-admission.cjs`、
`pi100-desktop-live.cjs`、`pi100-inspect-upstream.cjs`、`pi100-integrity-audit.cjs`、
`pi100-package.cjs`、`pi100-promote-shortcut.ps1`、`pi100-rebase-host-patch.cjs`、
`pi100-run-checks.cjs`、`pi100-upgrade.cjs`、`pi100-write-acceptance.cjs`

> 例：`pi100-complete-model-admission.cjs` 会去编辑 `src/main/agent/ModelInvocationAdmission.ts`；
> `pi100-rebase-host-patch.cjs` 读取被删掉的 `artifacts/pi100-upgrade/upstream/...`。

保留的是 5 个**在 package.json 里注册、当前仍在跑的**用例：`pi100-context-mode-boundary-test.ts`、
`pi100-features-test.ts`、`pi100-model-admission-test.ts`、`pi104-features-test.ts`、`pi104-model-compat-test.ts`。

### 验证

```
pnpm -s typecheck   → exit 0
pnpm -s test:all    → 240 通过 / 1 已知失败 / 0 新增回归 → exit 0
```

---

## 仍未处理（供你决定）

1. **`test:project-agent`**：执行审计快照 `resolvedCapabilities` 未保留被项目策略拒绝的 Expert。
   根因已查明（见 `diagrams/project-agent-audit-gap.svg`）：执行路径在 `AgentService.ts:3756`
   先用任务专家绑定覆盖了 `expertId`，被拒的专家因此从未进入策略解析，也就不会被记录。
   两种自洽的修法见该图，需你选一个。
2. **CRLF 与 `.gitattributes`（`eol=lf`）不一致**：105+ 个文件在磁盘上是 CRLF。建议单独一次提交专门处理。
