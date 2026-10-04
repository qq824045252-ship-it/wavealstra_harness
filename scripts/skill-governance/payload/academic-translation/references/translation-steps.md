## 核心方法 — 三步翻译法

> 设计思路：把翻译流水线拆为「直译 → 反思 → 雅化」三步，每一步都有独立的目标和检查点，是学术翻译领域的成熟范式。

三步法的关键洞察是**把"忠实"和"流畅"解耦**——人脑同时追求两者会让 LLM 在某一句"为了流畅丢了精度"。先逐句忠实直译（Step 1），再以全文视角校学术规范和术语一致性（Step 2），最后才追求文笔（Step 3）。中间产物全部保留，便于 diff 和回退。

### Step 1 — 直译（保术语·逐句对应）

> 📖 **加载触发器**：进入 Step 1 前，**MANDATORY** 读取与目标会议匹配的术语库一份（按用户输入推断或 P2 选择）：
> - ML 顶会 → [refs/glossary/ml-venues.md](../refs/glossary/ml-venues.md)
> - NLP 顶会 → [refs/glossary/nlp-venues.md](../refs/glossary/nlp-venues.md)
> - CV 顶会 → [refs/glossary/cv-venues.md](../refs/glossary/cv-venues.md)
> - IR/Web/Data → [refs/glossary/ir-data-venues.md](../refs/glossary/ir-data-venues.md)
>
> 用户未指定会议时默认加载 `ml-venues.md`（最通用）。同时检测 LaTeX 标记 → 触发 `📖 MANDATORY: refs/formula-preservation.md`。

**目标**：忠实传达原意，保留所有专业术语、公式、引用，**不追求流畅**。

**强制规则及理由**：
1. 公式（`$...$` / `\\begin{equation}` / `\\[...\\]`）原样保留——它们是 LaTeX 编译产物，翻译会破坏排版且没有"译法"
2. `\\cite{}` / `\\ref{}` / `\\eqref{}` / `\\autoref{}` 原样保留——这些是引用键，翻译后会让交叉引用全部断裂
3. 专业术语优先用 [refs/glossary/](../refs/glossary/) 中的标准译法；术语库未覆盖时保留原文 + 在括号附译法（例 "embedding（嵌入）"），方便读者反向查阅
4. 数字 / 单位 / 化学式 / 算法名原样保留——这些是数据事实，翻译只会引入错误
5. 段落结构（句子边界）保持 1:1 对应——便于 Step 2 反思阶段做对齐
6. **表格保留 = 结构原样 + 表头/数据不翻译 + 仅 caption 翻译**——这是高频踩坑点，独立成条说明：
   - Markdown 管道符表格 `| col1 | col2 |` / `|---|---|` 的**分隔符行、列对齐、表格行数列数**全部原样保留
   - 表头（header row）、数据单元格中的**数字 / 公式 / 模型名 / 数据集名 / 缩写**一律不翻译（与 §核心原则 3 的"不变量"一致）
   - 表格上方/下方的 `Table N: ...` caption 或紧邻段落属于自然语言，**只翻译 caption**
   - 输入是 PDF 时，`paragraph_kind == "table"` 的 segment **整段绕过翻译模型**，仅 `paragraph_kind == "caption"` 走三步流程
   - 输入是 LaTeX 时，`\begin{table}...\end{table}` 块整段被 `<TABLE_n>` 占位符替换（见 [refs/formula-preservation.md](../refs/formula-preservation.md)）
   - 输入是 Markdown 时，对管道符表格识别为"表格 segment"，整体替换为 `<MDTABLE_n>` 占位符，仅 caption 走翻译；输出阶段还原
   - **底线检查**：Step 1 输出后扫描原文表格行数 ≥ 1 的情况，若译文表格行数 ≠ 原文 → 阻断该段，重跑或标记 `manual_review`

**输出格式**：每段译文带 Provenance 标注：

```yaml
- segment_id: §3.2-p1
  source_page: 7
  source_section: "3.2 Method"
  source_excerpt: "We propose a novel..."
  step1_literal: "我们提出一种新颖的..."
  preserved:
    formulas: ["$\\mathbf{x}_t = f(\\mathbf{x}_{t-1})$"]
    citations: ["\\cite{vaswani2017attention}"]
    terms_kept_en: ["embedding", "MLP"]
```

### Step 2 — 反思（学术规范 + Chinglish 校正 + 术语一致性）

> 📖 **加载触发器**（中→英 翻译方向时 MANDATORY；英→中 时 📖 按需）：
> - **MANDATORY**: [refs/chinglish-patterns.md](../refs/chinglish-patterns.md)（中→英反思阶段唯一权威）
> - **MANDATORY**: [refs/section-conventions.md](../refs/section-conventions.md)（学术规范替换）
> - 按需: [refs/anti-ai-patterns.md](../refs/anti-ai-patterns.md)（精翻模式才必读）

**目标**：检查直译产生的不自然表达，应用学术规范，确保术语一致。

**4 个反思维度**（每段都要逐项检查）：

| 维度 | 规则来源 | 典型问题 → 修正 |
|---|---|---|
| **学术规范** | [refs/section-conventions.md](../refs/section-conventions.md) | "我们做了实验显示..." → "实验结果表明..." |
| **Chinglish 校正**（中→英时） | [refs/chinglish-patterns.md](../refs/chinglish-patterns.md) | "in recent years" 滥用 → "recently" / 删除 |
| **去 AI 味** | [refs/anti-ai-patterns.md](../refs/anti-ai-patterns.md) | "在本文中，我们..." 滥用 → 视语境精简 |
| **术语一致性** | [refs/glossary/](../refs/glossary/) + 用户术语库 | 同一术语在 §1 译"嵌入"、§3 译"嵌入向量" → 全文统一 |

**两条硬约束的理由**：
- 术语一致性扫描必须**全文级**而非段内——读者跨章节查同一概念时，译法不一致会被直接误判为两个东西
- 任何修改保留 Step 1 → Step 2 的 diff 可见——用户回看时能准确知道反思阶段做了什么、是否有改过头

详见 [modules/three-step-translation.md](../modules/three-step-translation.md) 的反思阶段算法。

### Step 3 — 雅化（信达雅 + 顶会风格）

> 📖 **加载触发器**（精翻模式 2c MANDATORY，标准模式 2b 不进 Step 3 不加载）：
> - **MANDATORY**: [refs/word-choice-table.md](../refs/word-choice-table.md)（顶会动词替换表）
> - **MANDATORY**: [refs/anti-ai-patterns.md](../refs/anti-ai-patterns.md)（去 AI 味规则，雅化阶段最易引入 AI 腔）
> - 按需: 与目标会议匹配的 `refs/glossary/{venue}.md`（已在 Step 1 加载，复用即可）

**目标**：在 Step 2 已规范的基础上，提升流畅度、紧凑度、可读性，达到投稿级。

**3 个雅化维度**：

| 维度 | 规则来源 | 例 |
|---|---|---|
| **信达雅** | 译文要"信"（忠实）、"达"（通顺）、"雅"（优美） | "本研究展示了..." → "本研究表明..." |
| **顶会风格**（CS 顶会偏好） | [refs/word-choice-table.md](../refs/word-choice-table.md) | "utilize" → "use", "demonstrate" → "show", "a plethora of" → "many" |
| **段落级流动** | [refs/section-conventions.md](../refs/section-conventions.md) | 加逻辑连接词（however / thus / nonetheless），消除"句子的水滴" |

**目标会议适配**（用户指定时）：

| 会议域 | 风格特点 | 引用此 Glossary |
|---|---|---|
| ML（NeurIPS/ICLR/ICML/AAAI/IJCAI） | 简洁、公式重、数学化语言 | `glossary/ml-venues.md` |
| NLP（ACL/EMNLP/NAACL） | 语言学精度、相关工作详尽 | `glossary/nlp-venues.md` |
| CV（CVPR/ICCV/ECCV） | 视觉术语精确、benchmark 表达规范 | `glossary/cv-venues.md` |
| IR/Web/Data（SIGIR/WWW/KDD/CIKM） | 问题动机、实用 impact 强 | `glossary/ir-data-venues.md` |

**Step 3 收尾自检**（理由：雅化阶段最容易"改过头改丢内容"，这五项是底线）：
- ✅ Provenance 仍可追溯到 Step 1 的源段落
- ✅ 公式、`\\cite{}`、`\\ref{}` 一字未改
- ✅ 数字 / 实验结果 / 数据集名 一字未改
- ✅ 用户自定义术语库的强制术语 100% 命中
- ✅ **表格行数 / 列数 / 数据单元格内容**与原文严格一致；只允许 caption 被翻译
- ✅ **`07-bilingual.html` 必须存在**且 `scripts/preserve_latex.py --verify --html` 通过——HTML 是双栏对照的默认主交付物，缺失 = 输出失败

---
