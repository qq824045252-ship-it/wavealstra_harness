# MyBuddy Skill 治理与 Git Bash 收敛实施计划

> 目的：把当前 MyBuddy Skill 体系按 Yao Meta Skill 的核心方法做一次治理，同时清理历史上“`bash = PowerShell`”留下的运行方式债务。
>
> 本文是**执行规格**，给 Codex / 外部 coding agent 使用。不要把它当作讨论稿。
>
> 当前基线：`C:\Users\servi\.mybuddy\skills`
>
> 重要前提：MyBuddy 当前 Agent Shell 已明确为 **Git Bash**。普通 `bash` / `terminal` 使用 Git Bash；PowerShell 仅通过显式 PowerShell 执行后端使用。不要再假设 “MyBuddy bash = PowerShell”。

---

# 0. 总原则

本轮只做两件事：

1. **Skill 治理**：按照 Yao Meta Skill 的核心检查思路整改当前 Skill：
   - Intent
   - Trigger
   - Boundary
   - Workflow
   - Output Contract
   - Context Budget
   - references / scripts / templates 资源分层
   - Trigger Eval
   - near-neighbor / Skill Atlas 冲突
2. **Shell 收敛**：默认运行方式统一到 Git Bash；仅真正依赖 Windows COM / .NET / PowerShell 专用机制的能力继续保留 PowerShell。

不要做：

- 不新增第二套 Skill Runtime。
- 不引入完整 Yao SkillOS / Review Studio / Evidence Ledger 等重型系统。
- 不为了“统一格式”重写已经稳定工作的业务逻辑。
- 不批量改 Skill 名称 / id。
- 不自动删除用户 Skill。
- 不把所有 Skill 强行改成同一个模板长度。
- 不把 PowerShell 一刀切删除。
- **禁止重写 `origin-analysis` 的 COM / Named Pipe broker，仅为了换 Git Bash。**

---

# 1. Yao Meta Skill 治理标准

## 1.1 每个正式 Skill 至少应满足

### Intent

一句话说明这个 Skill 负责什么**重复能力**。

### Trigger

必须能回答：什么请求应该触发？

最好具备 4–6 个真实正例，不能只靠关键词列表。

### Boundary

必须能回答：什么相似请求**不应该**触发？

Boundary 特别用于防止 near-neighbor Skill 路由冲突。

### Workflow

明确可重复执行的步骤，而不是一次性答案或工具手册。

### Output Contract

明确：

- 交付什么；
- 什么信息必须保留；
- 成功判据；
- 什么情况下停止 / 降级 / 澄清。

### Context Budget

`SKILL.md` 是 Runtime Entry Point，不应成为完整手册。

本轮采用：

- `< 8,000 chars`：理想；
- `8,000–12,000 chars`：需要检查是否可以下沉；
- `> 12,000 chars`：原则上必须瘦身，除非能证明这些内容每次触发都必须注入。

下沉规则：

- 稳定知识 / 长文档 → `references/`
- 确定性逻辑 → `scripts/`
- 可复用输出骨架 → `templates/`
- Trigger / Boundary 回归 → `evals/trigger.json`

### Eval

每个正式 Skill 应补 Trigger Eval：

- 4–6 个 positive；
- 4–6 个 negative；
- 至少包含一个最容易混淆的 near-neighbor case。

已有 `evals/trigger.json` 的 Skill 不要无理由破坏格式。

---

# 2. 当前审计基线

当前：

- 26 个 Skill 目录；
- 25 个存在 `SKILL.md`；
- 1 个 `ardot-design-generator` 目录缺失 `SKILL.md`；
- 只有 3 个 Skill 当前具有 Trigger Eval：
  - `matlab-r2025b`
  - `origin-analysis`
  - `root-cause-debugging`

当前 Trigger Eval 覆盖率约 **12%**。

本轮目标：除明确判定为 placeholder / orphan 的目录外，正式启用 Skill 全部具备最小 Trigger Eval。

---

# 3. Skill 治理逐项执行表

| Skill | 当前等级 | 本轮动作 | 优先级 |
|---|---|---|---|
| `matlab-r2025b` | 良好 | 保持结构；只做 Shell 迁移与回归 | P0 |
| `origin-analysis` | 良好但偏重 | 保留架构；继续把 quoting / 自动化细节下沉 references；不得重写 broker | P1 |
| `root-cause-debugging` | 良好 | 保留；重点解决与 `dimagent-debug` 的 near-neighbor 边界 | P0 |
| `code-view` | 基本良好 | 补 eval；PowerShell 文件系统命令改 Git Bash | P0 |
| `epro2kicad` | 基本良好 | 补 eval；PowerShell 示例改 Git Bash | P1 |
| `fastcopy-copy` | 基本良好 | 补 eval；移除“必须 PowerShell”旧规则；迁移 wrapper | P0 |
| `dim-feature-add` | 基本良好 | 补 Output Contract + eval | P1 |
| `shared-memory` | 基本良好 | 补 Output Contract + eval | P1 |
| `ansys-simulation` | 基本良好但偏重 | 精简 SKILL.md；补 Output Contract + eval | P1 |
| `kicad-design` | 基本良好但偏重 | 精简入口；补 eval | P1 |
| `archify` | 基本良好但偏重 | 精简入口；补 eval | P2 |
| `academic-translation` | 内容完整但过重 | 将长规则/术语/示例下沉 references；补 eval | P1 |
| `loop-agent` | 基本良好 | 补 Output Contract + eval | P2 |
| `meeting-transcribe` | 需小改 | 补 Boundary + eval；Shell 改 Git Bash | P1 |
| `npu-ocr` | 需小改 | 补 Boundary + eval；Shell 改 Git Bash | P1 |
| `projectlibre-gen` | 需小改 | 补 Boundary + eval；Shell 改 Git Bash | P2 |
| `wechat-public` | 需小改 | 补 Boundary + eval；错误的 `powershell` code fence 改 `text` | P1 |
| `weekly-report-fill` | 需小改 | 补 Boundary + Output Contract + eval | P2 |
| `easyeda-agent` | 需整改 | SKILL.md 瘦身；大量细节已有 refs，应继续下沉；补 eval；普通 CLI 改 Git Bash | P0 |
| `dimagent-debug` | 需整改 | 与 `root-cause-debugging` 做明确分工和负例；补 eval | P0 |
| `cheaper-inference-image` | 需整改 | 从命令说明书提升成标准 Skill；补 Boundary / Workflow / eval；Shell 改 Git Bash | P1 |
| `gemini-agent-platform` | 需整改 | 补 Boundary / eval；解决与 image_generate / cheaper-inference-image 的路由冲突；迁移 PowerShell wrapper | P0 |
| `officecli` | 明显过重 | 将完整 CLI 手册下沉 references；SKILL.md 只保留策略、路由、关键坑；补 eval；与 PPT Skill 划边界 | P0 |
| `open-kimi-ppt` | 明显需整改 | 缩窄 Trigger；和 officecli 明确分工；长格式规范下沉 reference；补 eval | P0 |
| `weekly-summary` | 不合格 placeholder | 补齐正式 Skill 结构，或如果已被别的周报能力完全覆盖则标记为候选移除；本轮不要直接删除 | P1 |
| `ardot-design-generator` | orphan | 先查来源 / 安装记录 / 是否被引用；如果应是正式 Skill 则恢复 `SKILL.md`，否则列入 orphan 清理报告；不要直接删除 | P1 |

---

# 4. Near-neighbor / Skill Atlas 冲突必须处理

## 4.1 `dimagent-debug` vs `root-cause-debugging`

当前两个 Skill 都在做 evidence-first debugging。

目标不是简单删一个，而是先明确定位：

建议方向：

- `dimagent-debug`
  - 更偏**第一次可复现调试**；
  - UI / runtime / harness / control experiment；
  - 适合一般 bug 定位。
- `root-cause-debugging`
  - 更偏**反复修不好、间歇、race、生命周期、性能、缓存、滚动、IPC、already fixed but still broken**；
  - 属于升级路径 / escalation Skill。

必须把这种差异写进双方 Boundary，并在双方 eval 中互相放 negative case。

## 4.2 `officecli` vs `open-kimi-ppt`

当前 `open-kimi-ppt` 的描述近似“所有 PPT 都触发”，与 `officecli` PPT 能力明显冲突。

建议：

### officecli

负责：

- 现有 docx / xlsx / pptx 的读取、检查、精确修改；
- Office 文档 DOM/XML 层编辑；
- 通用 Office 文档操作。

### open-kimi-ppt

负责：

- 从零生成高设计质量 presentation；
- PPTD 项目；
- 用户明确要求 PPTD / Kimi PPT workflow；
- 高视觉设计 / 复制版式 / deck generation。

不要让 `open-kimi-ppt` 继续写“任何 PPT 任务默认都触发”。

双方添加互斥 negative eval。

## 4.3 `gemini-agent-platform` vs `cheaper-inference-image` vs MyBuddy native `image_generate`

建议：

- MyBuddy native `image_generate`：默认通用生图能力；
- `cheaper-inference-image`：用户明确指定 CheaperInference / 特定第三方模型 / 比价测速时；
- `gemini-agent-platform`：用户明确要求 Gemini Enterprise / Vertex AI / Google Agent Platform / Gemini-specific image model 时。

不要再用泛化“生图”关键词让后两者抢 native image tool。

---

# 5. Context Budget 整改优先级

以下 `SKILL.md` 当前明显偏大，应检查并瘦身：

| Skill | 当前约字符数 | 处理 |
|---|---:|---|
| `officecli` | 25.9k | P0，大幅下沉 CLI 手册 |
| `open-kimi-ppt` | 21.7k | P0，下沉格式/DSL/长说明 |
| `academic-translation` | 20.0k | P1，下沉术语/长规则/例子 |
| `easyeda-agent` | 18.8k | P0，已有 22 refs，继续下沉 |
| `archify` | 16.4k | P2，下沉 Viewer/高级能力 |
| `origin-analysis` | 13.5k | P1，只下沉文档，不碰核心 broker |
| `kicad-design` | 12.5k | P1，下沉已验证坑/长能力说明 |
| `ansys-simulation` | 12.2k | P1，下沉 solver 细节 |
| `root-cause-debugging` | 11.9k | P1，可适度压缩，与 dimagent-debug 去重 |
| `dimagent-debug` | 8.9k | P1，near-neighbor 去重后自然下降 |

注意：

**不要为了低于 8k 强行删除运行时真正需要的安全门禁。**

---

# 6. PowerShell → Git Bash 收敛

## 6.1 Shell 总规则

MyBuddy 当前规则：

```text
bash / terminal
    = Git Bash on Windows

PowerShell
    = only explicit PowerShell backend
```

因此 Skill 文档中以下表述都视为过期：

- “MyBuddy bash（PowerShell）”
- “必须切换到 PowerShell 工具”——除非确有技术依赖
- “文件系统 fallback = Get-ChildItem / Get-Content / Select-String”

普通 CLI / Python / Node / Windows exe 调用优先从 Git Bash 执行。

---

# 7. PowerShell 迁移逐项表

| Skill | 当前情况 | Git Bash 迁移判断 | 执行动作 |
|---|---|---|---|
| `fastcopy-copy` | 强制 `.ps1`，并声称 Bash 会被安全策略拦截 | **必须迁移** | 新建 Bash/Node wrapper；删除旧安全策略描述；保留 `.ps1` 一段兼容期可选，但 Skill 默认 Git Bash |
| `gemini-agent-platform` | 核心 `gemini_ap.ps1` | **必须迁移** | 推荐改成 `tools/gemini_ap.mjs` 或 Python，不建议写复杂 shell JSON；SKILL.md 默认 Git Bash 调 Node/Python |
| `matlab-r2025b` | `matlab-run.ps1` | **必须迁移** | 改成 Node wrapper 或简单 Bash wrapper；直接调用 MATLAB exe `-batch`；避免 PowerShell quoting |
| `code-view` | 文件系统 fallback 全是 PowerShell | **必须迁移文档** | 用 `find` / `grep` / `head` / `wc` / `sort` 等 Git Bash 命令 |
| `cheaper-inference-image` | 只是示例用 PS | **直接迁移** | 使用 Git Bash 路径变量 + `uv run` |
| `epro2kicad` | PowerShell 调 exe | **直接迁移** | Git Bash 直接调用 KiCad Python / kicad-cli，路径统一 quote |
| `meeting-transcribe` | PS 示例 | **直接迁移** | `cd` + `uv run`；最新文件用 `ls -t` / Python |
| `npu-ocr` | PS 调 Windows exe | **直接迁移** | Git Bash 直接调用 exe；注意 Windows 路径 quote |
| `projectlibre-gen` | PS 示例 | **直接迁移** | `uv run ...` 改 Git Bash |
| `easyeda-agent` | 普通 CLI + daemon ps1 | **部分迁移** | 普通 easyeda 命令全部 Git Bash；daemon 后台启动可暂时保留 PowerShell launcher，或以后换 Node/process_start |
| `wechat-public` | tool-call 被标成 powershell fence | **不是 PowerShell 依赖** | code fence 改 `text` / `plaintext` |
| `officecli` | 只有 Windows install 用 `install.ps1` | **无需迁移 Runtime** | 安装说明可保留；Runtime 继续 Bash |
| `loop-agent` | 仅示例提及 verify-stack.ps1 | **无需优先迁移** | 保留 Windows 示例即可 |
| `origin-analysis` | PowerShell + COM + Named Pipe + Windows ACL | **禁止本轮迁移** | 保留 PowerShell；只优化 Skill 文档与调用边界 |

---

# 8. `origin-analysis` 特别保护条款

这是本轮最重要的禁止项。

当前 `origin-analysis` 不是“因为历史习惯用了 PowerShell”，而是实际依赖：

- `Origin.ApplicationCOMSI`
- Windows COM
- `.NET System.IO.Pipes.NamedPipeServerStream`
- `PipeSecurity`
- `WindowsIdentity`
- hidden broker process

因此：

```text
DO NOT:
PowerShell broker -> Bash rewrite
```

Git Bash 自身解决不了 COM / .NET broker。

如果未来真要去 PowerShell，应作为独立架构项目：

```text
PowerShell broker
    -> Python pywin32 / Node native Windows bridge
```

这不属于本轮。

本轮只允许：

- `SKILL.md` 瘦身；
- quoting 文档下沉到 `references/origin-automation.md`；
- Agent 调用说明明确：普通 shell 默认 Git Bash，但此 Skill 通过显式 PowerShell backend 调自己的 `.ps1`；
- Trigger / Boundary eval 保持和补强。

---

# 9. FastCopy Git Bash 特别注意

FastCopy `fcp.exe` 参数中大量使用 `/cmd=...`、`/to=...`。

Git Bash / MSYS2 可能自动把 `/xxx` 解释成路径并做参数转换。

迁移时必须实测。

推荐两种方案，优先方案 A。

## A. Node wrapper（推荐）

```text
Git Bash
  -> node scripts/fcopy.mjs
  -> child_process.spawn(fcp.exe, args, { shell: false })
```

这样完全避开 MSYS 参数转换。

## B. 直接 Bash

必须验证：

```bash
MSYS2_ARG_CONV_EXCL='*' "/c/Users/servi/Documents/FastCopy/App/FastCopy64/fcp.exe" \
  '/cmd=force_copy' \
  'C:\source' \
  '/to=D:\target'
```

如果行为不稳定，立即使用 Node wrapper，不要继续堆 Bash escaping。

---

# 10. Gemini wrapper 推荐实现

不要把现有 `gemini_ap.ps1` 原样翻译成 Bash。

它包含：

- JSON 构造；
- REST；
- binary/base64；
- 图片输出；
- MIME；
- resize；
- error handling。

这些用 Bash 做反而更脆。

推荐：

```text
tools/gemini_ap.mjs
```

Node 负责：

- parse argv；
- read env / config.env；
- `fetch()`；
- Buffer base64；
- JSON；
- file output；
- structured errors。

Skill 调用：

```bash
node "$SKILL_DIR/tools/gemini_ap.mjs" --prompt '...' --model '...'
```

不要重新引入 PowerShell 子进程。

---

# 11. MATLAB wrapper 推荐实现

同样不建议复杂 Bash。

推荐：

```text
scripts/matlab-run.mjs
```

Node wrapper 负责：

- 检查 `C:\Program Files\MATLAB\R2025b\bin\matlab.exe`；
- 接收 `--code` 或 `--script`；
- 临时代码写到 UTF-8 `.m`；
- 构造 MATLAB `cd(...); run(...);`；
- `spawn(matlab.exe, ['-batch', batch], { shell:false })`；
- 保留 exit code；
- finally 删除临时文件。

这样比 PowerShell 和 Bash 两层 quoting 都稳。

---

# 12. Eval 文件最低要求

对缺失 eval 的正式 Skill，建立：

```text
evals/trigger.json
```

沿用 MyBuddy 当前 `SkillAuthoringService` 兼容格式。

不要创建另一套 Yao schema。

每个 Skill 至少：

```text
4 positive
4 negative
```

重要 Skill建议：

```text
6 positive
6 negative
```

P0 near-neighbor Skill 必须包含 cross-negative：

- `dimagent-debug` vs `root-cause-debugging`
- `officecli` vs `open-kimi-ppt`
- `gemini-agent-platform` vs `cheaper-inference-image` vs native image generation

---

# 13. `weekly-summary` 处理原则

当前内容只有 placeholder 级别。

先做 No-Skill / Reuse 判断：

- 如果它只是“把本周工作整理成文字”，且没有稳定独立 Workflow / Output Contract，可以判定 `no-skill`；
- 如果与 `weekly-report-fill` 能合并，优先 `improve-existing`；
- 只有确实存在不同输出契约时才补成正式 Skill。

**不要因为目录已经存在就强行保留一个低质量 Skill。**

但是本轮不要自动删除；输出评估报告，由用户决定。

---

# 14. `ardot-design-generator` orphan 处理原则

当前目录没有 `SKILL.md`。

执行：

1. 搜索 MyBuddy DB / skill registry / config 是否仍引用；
2. 查看目录内容；
3. 判断是：
   - 安装残留；
   - Skill 创建失败；
   - 只有 supporting resources；
   - 应由另一个 Skill 管理。
4. 输出结论。

如果完全未引用，也不要未经用户许可删除；列入 cleanup candidate。

---

# 15. 实施顺序

## Phase A — P0 路由与 Shell

1. `dimagent-debug` / `root-cause-debugging`
2. `officecli` / `open-kimi-ppt`
3. `gemini-agent-platform` / `cheaper-inference-image` / native image boundary
4. `fastcopy-copy`
5. `matlab-r2025b`
6. `easyeda-agent`
7. `code-view`

目标：先解决“会不会选错 Skill”和“是否还误用 PowerShell”。

## Phase B — Eval 补齐

按 P0 → P1 → P2 添加 `evals/trigger.json`。

## Phase C — Context slimming

优先：

1. officecli
2. open-kimi-ppt
3. easyeda-agent
4. academic-translation
5. origin-analysis 文档下沉
6. kicad / ansys / archify

## Phase D — placeholder / orphan

- weekly-summary
- ardot-design-generator

只给结论，不自动删除。

---

# 16. 验证要求

每修改一个 Skill，至少验证：

## Package

- `SKILL.md` frontmatter 正常；
- name 与目录 identity 不被意外改变；
- references/scripts/templates 路径有效；
- 没有误删业务脚本。

## Trigger

- 正例触发合理；
- 负例不触发；
- near-neighbor 不抢路由。

## Runtime

- Git Bash 示例真实可执行；
- Windows 路径 quote 正确；
- 不依赖旧的 “bash=PowerShell” 假设；
- exit code 能传回；
- stdout/stderr 不吞错误。

## PowerShell retained case

`origin-analysis`：

- broker 能启动；
- named pipe 可连接；
- Origin COM owner 持久；
- `status` / `import` / `stats` / `labtalk -ScriptFile` 至少做 smoke test；
- 不产生第二个并行 broker。

---

# 17. 不允许的回归

- 不允许 Skill 为了变短而删除关键 safety rule。
- 不允许把 references 的全部内容重新复制回 SKILL.md。
- 不允许给所有 Skill 添加相同模板化废话。
- 不允许为了 Eval 而把 description 塞满关键词。
- 不允许扩大 Trigger 来提高“命中率”。
- 不允许让两个 near-neighbor Skill 同时把对方的典型用例作为 positive。
- 不允许在 Git Bash wrapper 内大量嵌套 `pwsh -Command`。
- 不允许把 PowerShell quoting 问题变成 Bash quoting 问题。
- 不允许动 `origin-analysis` broker 架构。
- 不允许自动删除 `weekly-summary` / `ardot-design-generator`。

---

# 18. Git 提交要求

按功能类别提交，不要一个大 commit：

建议：

```text
feat(skills): tighten debugging skill boundaries
feat(skills): split Office and presentation routing
feat(skills): tighten image generation routing
refactor(skills): migrate FastCopy runtime off PowerShell
refactor(skills): migrate Gemini Agent Platform wrapper to Node
refactor(skills): migrate MATLAB wrapper to Node
refactor(skills): align Windows CLI skills with Git Bash
refactor(skills): slim oversized skill runtime contexts
test(skills): add trigger boundary eval coverage
chore(skills): report placeholder and orphan skill candidates
```

如果多个文件存在强依赖，可以合并，但必须保证每个 commit 语义完整。

每组 commit 前后检查：

```bash
git diff --check
git status --short
```

不要把无关工作树改动混入。

---

# 19. 最终交付报告格式

Codex 完成后必须返回表格：

| Skill | Yao Gate | Eval | Context | Shell | Near-neighbor | 状态 |
|---|---|---|---|---|---|---|
| xxx | pass/warn | 8 cases | 4.2k | Git Bash | none | done |

另给两张汇总表：

## PowerShell retained

说明为什么仍必须保留。

预期至少：

```text
origin-analysis — Windows COM / .NET Named Pipe / ACL，保留 PowerShell
```

## Cleanup candidates

列：

```text
weekly-summary
ardot-design-generator
```

只给建议，不自动删除。

---

# 20. 完成判据

本计划完成不等于“所有 Skill 长得一样”。完成判据是：

1. 正式 Skill 都有可解释的 Intent / Trigger / Boundary / Workflow / Output Contract；
2. P0/P1 正式 Skill 全部具备 Trigger Eval；
3. near-neighbor 路由冲突有明确互斥测试；
4. 大型 Skill 的 Runtime Entry Point 明显瘦身；
5. 普通本机执行默认 Git Bash；
6. 只有真实 Windows 专用能力继续 PowerShell；
7. `origin-analysis` 保持稳定；
8. 没有为了治理继续制造更多 Skill；
9. 没有引入新的 Shell quoting 地狱；
10. 所有修改经过真实 smoke test，而不是只改 Markdown。

最终原则：

> **Skill 要强，但 Skill 系统必须克制。默认 Git Bash，PowerShell 只留给真正需要 Windows 专用运行时的能力。**
