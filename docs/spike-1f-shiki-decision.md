# 1F — Shiki Spike 决策文档（V3.5 §52）

> 日期：2026-08-08 · Shiki 4.4.2 · 决策状态：**冻结**
> **Wave 5A 落地：2026-08-08**（`src/renderer/src/lib/codeHighlight.ts`：shiki/core + JS engine + 9 语言子集 + github-light/dark 双主题；CodeView 静态查看默认 Shiki；10.9k 行 641ms 成本走首帧纯文本 + 后台分块换入）
> Spike 脚本：`scripts/shiki-spike.mjs` · 原始数据：`out/spike-shiki.json`
> Fixtures：`fixtures/artifacts/synthetic/code-{ts,medium,large,python,json}`（生成器 `scripts/gen-code-fixtures.mjs`）

## 决策

```
静态代码 Artifact 默认：Shiki + JavaScript RegExp engine
```

**理由（数据驱动）：**

1. **Fidelity 无差异**：TS / Python / JSON 三种真实样本，JS engine 与 Oniguruma 的
   token 序列**差异 0.000%**（token 数完全一致）。MyBuddy 的静态代码高亮不需要 Oniguruma
   的 grammar 保真度优势。
2. **启动更快**：createHighlighter 初始化 A=18.9ms vs B=32.9ms（A 快 42%）。
3. **内存更低**：峰值 RSS A=424.5 MB vs B=469.5 MB（A 少 ~10%）。
4. **无 WASM/CSP/asar 复杂度**：JS engine 纯 JS；Oniguruma 需要 wasm 加载
   （CSP 需 `wasm-unsafe-eval` 或 blob 策略面 + asar 内 wasm 路径解析）。
5. **warm 性能差异在交互尺度下不可感知**：B 在大文件（10.9k 行）快 17%
   （530ms vs 641ms），但 500ms+ 级别本身已超过可感知阈值，两者都需
   worker/分片策略处理大文件，engine 选择不改变这个结论。

**Oniguruma 的保留条件**：仅当未来出现 JS engine 无法正确高亮的 grammar
（如复杂嵌套语言）时再启用，且必须走 `shiki/core` 按需加载。

## Benchmark 数据（github-dark，6 langs 预载）

| 指标 | A: JS RegExp | B: Oniguruma WASM |
|---|---|---|
| createHighlighter init | **18.9ms** | 32.9ms |
| 小 TS 56 行 warm | 16.1ms | **3.9ms** |
| 中 TS 1.6k 行 warm | 93.6ms | **81.5ms** |
| JSON 8k 行 warm | 111.1ms | 111.7ms |
| 大 TS 10.9k 行 warm | 641.1ms | **530.3ms** |
| 峰值 RSS | **424.5 MB** | 469.5 MB |
| fidelity（TS/Py/JSON） | **0.000% 差异** | 基准 |
| 最小 bundle（全量 langs） | 10126 KB | 10016 KB |

## 附带发现（影响后续实现，不影响本决策）

1. **bundle 主导因素 = bundled languages，不是 engine**（两种都 ~10MB）。
   生产实现必须用 `shiki/core`（createHighlighterCore）+ 按需 grammar，
   MyBuddy 实际语言子集（ts/js/json/py/shell/md）可压到 1–2MB 级。
2. **大文件输出规模**：10.9k 行 TS → 2.3MB HTML / 68k tokens。CodeView 需要
   虚拟滚动或分块渲染，不能整段 innerHTML。
3. **大文件 warm ≈ first**（641 vs 627ms）：v4 对超大文件无显著缓存增益，
   进一步支持"大文件必须 worker/分片"的结论。
4. 首次 highlight 含 grammar 编译（小文件 first 458ms vs warm 16ms）；
   生产应在预载阶段预热常用 grammar。

## 淘汰方案

- **Oniguruma WASM 作为默认**：淘汰。理由见上（启动/内存/CSP/asar 成本，
  fidelity 无收益）。保留为 fallback 开关。
- **highlight.js 现状**：不属于本 spike 范围；后续 Wave 5 按 §84 决定
  Shiki 替换时机（fixture benchmark 通过后）。

## 后续动作

- [x] 生产集成时：`shiki/core` + 按需 grammar + 预载预热 + 大文件 worker/分片
      （Wave 5A：codeHighlight.ts 已落地，`prewarmHighlighter` 模块级预热；
      大文件策略 = 首帧纯文本 + 后台 tokenize + 分块 reveal，见 degradationPolicy）
- [x] Golden 截图纳入 code fixtures（Wave 5A：`fixtures/golden/wave5a/*` 8 场景 × DPR 1.0/1.25/1.5/2.0）
