/**
 * 1A — markdown-long fixture 生成器（V3.5 §28）
 *
 * 生成长文档渲染基准样本（§84 long-document performance）：
 *   markdown-long.md  ~80 KB（40 章 × 表格/代码块/列表/公式/引用/脚注，≈2.8k 行）
 *
 * 用途：Markdown 渲染器长文档性能基线（首帧/滚动/高亮），Golden 可裁剪抽样。
 *
 * 运行：node scripts/gen-markdown-long.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "fixtures", "artifacts", "synthetic");
mkdirSync(OUT, { recursive: true });

const SECTIONS = 40;
const ROWS = 8;

function codeBlock(n) {
  return [
    "```ts",
    `// ${n}：类型化事件总线示例（每章同构，语法多样性模板）`,
    `type EventMap = Record<string, unknown[]>;`,
    `interface Emitter<E extends EventMap> {`,
    `  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void;`,
    `  emit<K extends keyof E>(event: K, ...args: E[K]): void;`,
    `  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void;`,
    `}`,
    `class Bus<E extends EventMap> implements Emitter<E> {`,
    `  private handlers = new Map<keyof E, Set<(...args: never[]) => void>>();`,
    `  on<K extends keyof E>(event: K, fn: (...args: E[K]) => void): () => void {`,
    `    const set = this.handlers.get(event) ?? new Set();`,
    `    set.add(fn as (...args: never[]) => void);`,
    `    this.handlers.set(event, set);`,
    `    return () => set.delete(fn as (...args: never[]) => void);`,
    `  }`,
    `  emit<K extends keyof E>(event: K, ...args: E[K]): void {`,
    `    this.handlers.get(event)?.forEach((fn) => (fn as (...a: E[K]) => void)(...args));`,
    `  }`,
    `  once<K extends keyof E>(event: K, fn: (...args: E[K]) => void): void {`,
    `    const off = this.on(event, (...args) => { off(); fn(...args); });`,
    `  }`,
    `}`,
    "```",
  ].join("\n");
}

function table(n) {
  const rows = [];
  rows.push("| 指标 | 目标 | 实测 | 结论 |");
  rows.push("|---|---|---|---|");
  for (let i = 0; i < ROWS; i++) {
    rows.push(`| item-${n}-${i} | ${(i * 7.3).toFixed(1)} ms | ${(i * 6.9 + n).toFixed(1)} ms | ${i % 2 ? "达标 ✅" : "接近 ⚠️"} |`);
  }
  return rows.join("\n");
}

const parts = [];
parts.push(`# 长文档性能基准样本（fixture）

> 由 \`scripts/gen-markdown-long.mjs\` 生成，共 ${SECTIONS} 章。
> 用途：V3.5 §84 long-document performance —— 首帧渲染、滚动、语法高亮、表格布局。

## 目录

${Array.from({ length: SECTIONS }, (_, i) => `- [第 ${i + 1} 章：章节 ${i + 1}](#第-${i + 1}-章章节-${i + 1})`).join("\n")}

## 文档结构说明

本样本刻意混排 **GFM 全要素**：ATX/Setext 标题、无序/有序/任务列表、表格、
fenced code、行内代码、引用、数学块、脚注、链接与图片引用，保证渲染器全路径覆盖。

**关键词密度**：markdown / 渲染 / 性能 / 基准 / 表格 / 代码块 / 引用 / 脚注 / 锚点 / 数学。
`);

for (let i = 1; i <= SECTIONS; i++) {
  const ch = [
    "",
    `## 第 ${i} 章：章节 ${i}`,
    "",
    `本章节用于撑起文档长度与结构复杂度。真实语义段落：长文档渲染的**分块策略**、
    **虚拟滚动**与**增量高亮**是三个正交问题——分块决定首帧可见范围，虚拟滚动决定
    滚动帧率，增量高亮决定编辑响应。fixture 的目标是让三者都有可测量的压力面。`,
    "",
    `### ${i}.1 列表与任务清单`,
    "",
    "- 分块渲染：按标题切块，懒渲染视口外章节",
    "- 语法高亮：仅高亮视口内代码块",
    "- 表格：固定表头 + 行虚拟化",
    `- [x] 任务一（第 ${i} 章已完成项）`,
    `- [ ] 任务二（第 ${i} 章待办项）`,
    `- [ ] 任务三（第 ${i} 章待办项）`,
    "",
    `### ${i}.2 表格（${ROWS} 行）`,
    "",
    table(i),
    "",
    `### ${i}.3 代码块`,
    "",
    codeBlock(i),
    "",
    `### ${i}.4 引用与公式`,
    "",
    `> 设计原则 ${i}：*“以 fixture 基准为准，不以历史实现为准。”* —— V3.5`,
    "",
    `行内公式 $E = mc^2$ 与块级公式：`,
    "",
    "$$",
    `\\int_{0}^{\\infty} f(x)\\,dx = \\lim_{n \\to \\infty} \\sum_{k=1}^{n} f(x_k)\\,\\Delta x`,
    "$$",
    "",
    `### ${i}.5 脚注与链接`,
    "",
    `本段引用脚注[^note-${i}]，并链接到[第 1 章](#第-1-章章节-1)形成锚点往返。`,
    "",
    `[^note-${i}]: 第 ${i} 章脚注：长文档渲染需要锚点、目录与滚动位置恢复三者联动。`,
    "",
  ];
  parts.push(ch.join("\n"));
}

parts.push("", "---", "", "> 结束。fixture 生成确定性：同版本生成器输出逐字节一致。", "");

const out = join(OUT, "markdown-long.md");
writeFileSync(out, parts.join("\n"), "utf-8");
console.log(`wrote ${out} (${(parts.join("\n").length / 1024).toFixed(0)} KB)`);
