## 🚧 异常与边界条件

流程假设环境理想，但翻译实操常遇异常。以下预定义 fallback，保证 skill 不会"一跑就卡住"，也不会静默失败误导用户。

| 场景 | 触发条件 | 处理动作 |
|---|---|---|
| **PDF 文本层为空 / 扫描件** | `scripts/extract_pdf.py --check` 文本字符数 < 200 或图像比 > 80% | 阻断翻译，告知用户「检测到扫描件，OCR 在公式/数字上幻觉率高」，给三选项：[a] 你提供文本层 PDF [b] 你确认接受 OCR 风险（标注 `provenance.ocr_warning=true`）[c] 终止 |
| **PDF 加密 / 受密码保护** | `pdfplumber` / `pypdf` 抛 `PdfReadError` | 询问用户密码并临时解密到内存，不写回原文件；用户拒绝则终止本次任务 |
| **arXiv 下载失败** | `scripts/arxiv_fetch.sh` 非 0 退出 / 网络超时 / 404 | 重试 1 次（指数退避）；仍失败询问 [a] 用户改贴 abs URL [b] 用户上传 PDF 替代 [c] 终止；不要静默切到 PDF 兜底 |
| **`preserve_latex --verify` 失败** | 译文中占位符未还原 / 数字被改写 / 公式被翻译 | 阻断输出。展示具体失败 token 给用户，回退到 Step 2 重跑反思阶段（最多 2 次）；2 次仍失败 → 标注 `output_files += [ERROR.md]`，让用户人工修订 |
| **段落 1:1 对应失败** | Step 1 输出段落数 ≠ 输入段落数（合并/拆分句子） | 该段单独重跑 Step 1，强化 Prompt 中"保持句子边界"约束；连续 2 次失败 → 标记该段 `paragraph_kind="manual_review"`，跳过 Step 2/3 等用户处理 |
| **术语库加载失败** | YAML 解析错误 / 文件不存在 / 内置 + 自定义有冲突 | 不要静默继续。明确提示「术语库加载失败：{原因}」；冲突时展示冲突术语列表让用户选 keep [内置] / [自定义] / [双语并列]；解析错误 → 退化为不带术语库运行并在 `06-self-check.md` 标注 |
| **`translation-output/` 目录已存在同 paper-id 产物** | 同 ISO-time 内重复触发 / 同 paper-id 翻译过 | 不覆盖。在目录后追加 `-r2 / -r3` 后缀新建；同时在新目录 `00-history.md` 写明上次产物路径，便于用户 diff |
| **LLM 上下文超限** | 单段 + glossary + 系统 prompt 超 token 上限 | 自动按句号切分该段为子段，分别翻译后拼接；拼接后重跑 Step 1 自动校验；若切分后仍超限 → 标记该段 `manual_review` 并告知用户 |
| **`config/user-glossary.template.yaml` schema 不符** | 用户上传的术语表缺必需字段 / 字段类型错 | 不要静默丢弃整个文件。逐条校验，合法条目正常加载，非法条目集中报告给用户「以下 N 条术语被忽略：{list}」 |
| **输出体积超 150% 警戒** | 三档对照 + 双栏总字符数 > 原文 1.5× | 多数为正常（学术英文译中文常 1.3-1.5×）；> 2.0× 才告警，提示用户检查是否雅化阶段过度添加了解释 |
| **表格丢失 / 表格被翻译** | 译文中表格行数 < 原文 80% / 表格分隔符行 `\|---\|` 缺失 / 表头被中文替换（数据列名通常应保持原文） | 阻断该段输出。回退到 Step 1 重跑该段时强制走"表格整段占位符化"路径（仅翻译 caption）；连续 2 次失败 → 标 `manual_review`，并在 06-self-check 列出所有受影响表格 |
| **`07-bilingual.html` 未生成** | standard / full 模式下 `output_dir/07-bilingual.html` 不存在 | 视为输出失败。先尝试基于 `04-bilingual.md` + 模板 `assets/templates/bilingual-html.html` 重新渲染一次；仍失败 → 在 `06-self-check.md` 顶部红字标"HTML 生成失败：{原因}"，并提示用户「请明确说『生成 HTML』后我可重试」，**不允许沉默交付** |

**原则**：异常先告知用户、再按规则处理；任何 fallback 路径都要在 `06-self-check.md` 中留痕，便于用户审计。

---
