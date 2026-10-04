### 6.1 反模式 Bad → Good 示例（最容易出错的 4 类）

> 文字描述容易让模型"知道但做不到"——下面 4 条配对示例是真实踩坑后总结出来的，看一眼差异就能记住边界。

**❌ Bad — 翻译 `\cite{}`**：
```
原文：following \cite{vaswani2017attention}, we adopt the Transformer architecture.
输出：参照 Vaswani 等（2017）提出的方法，我们采用了 Transformer 架构。
问题：\cite{} 引用键被拆解为「Vaswani 等（2017）」，原 LaTeX 文档此处的交叉引用全部断裂，编译后 PDF 的引用列表会缺失这一条。
```

**✅ Good — 保留 `\cite{}` 原样 + 自然语序整合**：
```
原文：following \cite{vaswani2017attention}, we adopt the Transformer architecture.
输出：参照 \cite{vaswani2017attention}，我们采用了 Transformer 架构。
关键：引用键作为不可见占位符整体保留，BibTeX 编译后自然显示为正确的引用形式。
```

---

**❌ Bad — 解释公式语义**：
```
原文：The loss is $\mathcal{L} = -\sum_{t=1}^T \log p(y_t|y_{<t}, x; \theta)$.
输出：损失函数 $\mathcal{L} = -\sum_{t=1}^T \log p(y_t|y_{<t}, x; \theta)$（即对所有时间步 t=1 到 T，对条件概率取对数后求和再取负）。
问题：括号内的语义解释属于"模型自作主张的注释"，原文没有，会污染 source-of-truth；并且数学符号读者本就懂，注释是冗余。
```

**✅ Good — 公式零修饰**：
```
原文：The loss is $\mathcal{L} = -\sum_{t=1}^T \log p(y_t|y_{<t}, x; \theta)$.
输出：损失函数为 $\mathcal{L} = -\sum_{t=1}^T \log p(y_t|y_{<t}, x; \theta)$。
关键：公式只搬运不解释，需要解释时让原文作者在另起的"释义段"里写。
```

---

**❌ Bad — 中→英翻译保留 Chinglish 重复**：
```
原文：近年来，大语言模型展示了显著的能力。然而，近年来其计算成本依然高昂。
输出：In recent years, large language models have demonstrated remarkable capabilities. However, in recent years their computational cost remains high.
问题：原文两次「近年来」是中文写作的允许重复，但英文学术写作中 "in recent years" 重复出现是典型 Chinglish 标志，会被审稿人扣分。
```

**✅ Good — Step 2 反思阶段消除重复**：
```
原文：近年来，大语言模型展示了显著的能力。然而，近年来其计算成本依然高昂。
输出：Recently, large language models have shown remarkable capabilities. However, their computational cost remains high.
关键：保留首句的「Recently」（用 recently 替代啰嗦的 in recent years），第二句省略时间状语让转折更紧凑——这是 refs/chinglish-patterns.md 中明确列出的高频修正项。
```

---

**❌ Bad — 直接翻译商务邮件（超范围）**：
```
用户输入："帮我翻译这封邮件给客户：尊敬的张总，您好！感谢您百忙之中..."
错误处理：直接走 Preflight P2 三选项 → Step 1 直译 → 输出英文邮件
问题：本 Skill 的"信达雅 + 顶会风格"会强行套用学术语气（如把"百忙之中"翻成 "in your busy schedule of important matters"），破坏商务邮件的礼貌客套，反而不如 DeepL 自然。
```

**✅ Good — 范围检测先行**：
```
用户输入："帮我翻译这封邮件给客户：尊敬的张总..."
正确处理：识别"邮件"+"尊敬的"为「不在范围内」表格第 1 行的命中信号 → 立即拒绝并展示：
  「这属于通用商务文本，建议用 DeepL 或沉浸式翻译。
   原因：本 Skill 的顶会风格规则会破坏商务礼貌语气，反而不如通用机翻自然。」
关键：超范围拒绝不是失败，是设计——拒绝后用户得到正确推荐，比强行翻译更有价值。
```

---
