## 输出 — 三档对照 + 双栏对照（默认全产）

> ⚠️ **强约束**：standard / full 模式下 **`07-bilingual.html` 必须生成**——它是双栏对照的默认主交付物（用户最常打开的就是 HTML，因为有公式渲染 + 视图切换 + 段落复制）。
> 跳过 07 = 输出残缺 = 视为生成失败。常见误区：模型只产 Markdown 就停手；本 Skill 显式禁止此行为。
> 若运行环境不支持写 HTML（极少见），必须在 `06-self-check.md` 顶部红字标注"HTML 未生成，原因 = X"，**不允许静默跳过**。

每次精翻调用都生成 7 个文件（默认放在 `translation-output/{timestamp}-{paper-id}/`）：

| 文件 | 用途 | 必出模式 |
|---|---|---|
| `01-step1-literal.md` | Step 1 直译初稿 | quick / standard / full |
| `02-step2-academic.md` | Step 2 学术规范版 | standard / full |
| `03-step3-polished.md` | Step 3 信达雅终稿 | full |
| `04-bilingual.md` | 双栏对照（左原文 / 右终稿）| standard / full |
| `05-bilingual.tex` | LaTeX 双栏（投稿用） | full |
| `06-self-check.md` | 自检报告（术语命中率 / 公式保留率 / 表格保留率 / Provenance 完整性 / **HTML 生成状态**） | quick / standard / full |
| `07-bilingual.html` | 双栏 HTML（浏览器即开 + MathJax + 视图切换 + 复制 + **表格原样渲染**）| **standard / full（必出）** |

**生成顺序**：先 01→02→03 三档对照 → 再衍生 04（双栏 MD）→ 05（双栏 LaTeX）→ **07（双栏 HTML，必出）** → 最后 06（自检报告，含 07 是否生成的状态）。
**收尾断言**：所有应出文件未出齐时，模型必须显式向用户报错「输出不完整：缺少 X」并给出补救方案，**不允许沉默交付**。

模板见 [assets/templates/](../assets/templates/)。HTML 渲染契约详见 [modules/bilingual-export.md](../modules/bilingual-export.md#文件-07--双栏-html浏览器打开即用)。

---
