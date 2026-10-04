# fixtures/artifacts — Render Fixture Gallery（V3.5 §27-32）

## Wave 1 进度（V3.5 Phase 0 全部达标，2026-08-08）

| Gate | 状态 | 交付 |
|---|---|---|
| 1A Fixtures | ✅ synthetic ×23（含 office 3 件）+ real-world ×18（sanitize 后）+ 抽取器 |
| 1B WCV CDP Spike | ✅ 14/14 | `pnpm spike:wcv-cdp [--scale 1.5]`，1.0/1.5 双档 |
| 1C Transition Spike | ✅ 双档 | `pnpm spike:transition [--scale 1.5]` |
| 1D Characterization | ✅ 10/10 | `pnpm test:artifact-char` |
| 1E Golden Harness | ✅ 已封板 | 9 fixtures × DPR 1.0/1.25/1.5/2.0 = 36 张（人工审查通过，§50） |
| 1F Shiki / 1G Monaco / 1H Office | ✅ 已完成 | `pnpm spike:shiki|monaco|office` + 决策文档 docs/spike-1{f,g,h}-*-decision.md |

### 1C 结论（V3.5 §41 选视觉质量更好的方案）

- **CSS 离散动画（展开/收起/flyout）→ 方案 A**（transition 期间隐藏）：零错位，
  成本仅过渡时长的不可见（400ms/次）；setBounds 仅 1 次
- **drag resize / maximize → 方案 B**（连续跟随）：A 无 transition 事件不可用；
  B 实测滞后 ≈ 1 帧位移（8ms 采样 7px，1.5x 下 6.7px），可接受
- **混合策略 = 默认 A + drag/resize 期间切 B**（V3.5 允许）
- A 必须带 failsafe timeout：实测窗口 resize 无 transitionend；
  且遮挡/隐藏窗口下 transition 冻结、transitionend 不触发（backgroundThrottling）
- 最终 bounds 精度：A/B 双方案 0.0–0.3px ✅

## 目录结构

```
fixtures/artifacts/
  synthetic/    人工构造样本（渲染质量基线，可重复）
  real-world/   从 ~/.mybuddy/sessions 抽取的真实样本（sanitize 后）
  _candidates/  抽取器输出（未 sanitize，禁止直接引用）
fixtures/golden/ 截图 baseline（人工确认后生效，§50）
```

## Synthetic 清单（1A 全量，2026-08-08）

| fixture | 用途 | 生成器 |
|---|---|---|
| `markdown-rich.md` | GFM 表格/代码/数学/任务列表（§84 Markdown 基线） | 手写 |
| `markdown-long.md` | **长文档性能**（40 章 / ≈2.8k 行 / 80 KB，§84 long-document） | `scripts/gen-markdown-long.mjs` |
| `markdown-features.md` | **Wave 5A：GFM 全要素静态样本**（表格/任务列表/嵌套列表/引用/锚点/脚注/链接/图片策略/代码块） | 手写 |
| `code-ts.ts` / `code-python.py` / `code-json.json` / `code-medium.ts` / `code-large.ts` | Shiki/Monaco spike 输入（§52/53） | `scripts/gen-code-fixtures.mjs` |
| `code-js.js` / `code-shell.sh` | **Wave 5A：JS/Shell 语言 fixture**（5A Gate 语言矩阵） | `scripts/gen-code-fixtures.mjs` |
| `code-longline.ts` | **Wave 5A：超长行 fixture**（每行 ~485 字符，横向滚动基准） | `scripts/gen-code-fixtures.mjs` |
| `image-basic.png/jpg/webp` | **Wave 5B：三格式常规图**（1024×768，渐变+图形） | `scripts/gen-image-fixtures.cjs`（Electron canvas） |
| `image-transparent.png` / `透明-图片.png` / `spaced name.png` | **Wave 5B：透明 RGBA PNG**（半透明图形 + 中文/空格文件名，棋盘格验证） | `scripts/gen-image-fixtures.cjs` |
| `image-exif-rotated.jpg` | **Wave 5B：EXIF Orientation=6 旋转 JPEG**（原始 600×400 横图 → 浏览器竖显 400×600，纯 JS 注入 APP1） | `scripts/gen-image-fixtures.cjs` |
| `image-wide.png` / `image-tall.png` | **Wave 5B：超宽 4096×512 / 超高 512×4096** | `scripts/gen-image-fixtures.cjs` |
| `image-4k.png` / `image-8k.png` | **Wave 5B：4K / 8K 大图**（纯色带图案，PNG 压缩友好；8K≈852KB） | `scripts/gen-image-fixtures.cjs` |
| `image-small.png` | **Wave 5B：2×2 像素图**（上采样验证） | `scripts/gen-image-fixtures.cjs` |
| `pdf-simple.pdf` | **Wave 5C：1 页简单文档**（中英混排） | `scripts/gen-pdf-fixtures.cjs`（Chromium printToPDF） |
| `pdf-normal-40p.pdf` | **Wave 5C：32 页普通文档**（章节/表格/代码/列表/中英） | `scripts/gen-pdf-fixtures.cjs` |
| `pdf-large-120p.pdf` | **Wave 5C：112 页大文档**（性能/回收基准） | `scripts/gen-pdf-fixtures.cjs` |
| `pdf-scanned.pdf` | **Wave 5C：4 页扫描件**（全页位图，无文本层） | `scripts/gen-pdf-fixtures.cjs` |
| `pdf-tables-images.pdf` | **Wave 5C：14 页表格+图表+中英** | `scripts/gen-pdf-fixtures.cjs` |
| `pdf-landscape.pdf` | **Wave 5C：5 页横向页面**（landscape） | `scripts/gen-pdf-fixtures.cjs` |
| `中文-文档.pdf` / `spaced name.pdf` | **Wave 5C：中文/空格文件名** | `scripts/gen-pdf-fixtures.cjs` |
| `office/docx-simple.docx` / `中文-文档.docx` / `spaced name.docx` | **Wave 5D-1：单页 DOCX**（中英/列表/文件名变体） | `scripts/gen-office-fixtures.mjs`（docx 包） |
| `office/docx-long-24p.docx` | **Wave 5D-1：25 页长文档**（24 个分页符 + 表格） | `scripts/gen-office-fixtures.mjs` |
| `office/docx-mixed.docx` | **Wave 5D-1：中英文混排**（3 页） | `scripts/gen-office-fixtures.mjs` |
| `office/docx-table.docx` | **Wave 5D-1：复杂表格**（合并单元格 + 40+ 行） | `scripts/gen-office-fixtures.mjs` |
| `office/docx-images.docx` | **Wave 5D-1：8 图 8 页**（docx-preview 仅按显式分页符分页） | `scripts/gen-office-fixtures.mjs` |
| `office/docx-header-footer.docx` | **Wave 5D-1：页眉页脚** | `scripts/gen-office-fixtures.mjs` |
| `office/docx-breaks.docx` | **Wave 5D-1：8 个显式分页符** | `scripts/gen-office-fixtures.mjs` |
| `office/xlsx-simple.xlsx` | **Wave 5D-2：单 sheet 40 行 × 5 列**（样式注入） | `scripts/gen-office-fixtures.mjs`（SheetJS + jszip 后处理） |
| `office/xlsx-multi.xlsx` | **Wave 5D-2：3 sheets**（销售数据/汇总/说明） | `scripts/gen-office-fixtures.mjs` |
| `office/xlsx-frozen.xlsx` | **Wave 5D-2：冻结 2 行 + 1 列**（100 行 × 20 列） | `scripts/gen-office-fixtures.mjs`（pane 注入） |
| `office/xlsx-merged.xlsx` | **Wave 5D-2：5 个 merge**（含跨视口大块 30:0-40:5 / 50:20-55:29） | `scripts/gen-office-fixtures.mjs` |
| `office/xlsx-formats.xlsx` | **Wave 5D-2：数字/日期/百分比/货币格式 + 粗体/红字/灰底/边框/居中** | `scripts/gen-office-fixtures.mjs`（styles.xml 合并注入） |
| `office/xlsx-formula.xlsx` | **Wave 5D-2：公式 + 已保存结果**（<v> 缓存补丁，不重算） | `scripts/gen-office-fixtures.mjs` |
| `office/xlsx-1k50.xlsx` | **Wave 5D-2：1000 行 × 50 列**（列窗口基准） | `scripts/gen-office-fixtures.mjs` |
| `office/xlsx-10k30.xlsx` | **Wave 5D-2：10000 行 × 30 列 + 冻结首行首列**（行窗口/性能基准） | `scripts/gen-office-fixtures.mjs` |
| `office/中文-表格.xlsx` / `spaced name.xlsx` | **Wave 5D-2：中文/空格文件名** | `scripts/gen-office-fixtures.mjs` |
| `office/pptx-simple.pptx` / `中文-演示.pptx` / `spaced name.pptx` | **Wave 5D-3：16:9 标题页 + 要点页（5 slides）** | `scripts/gen-office-fixtures.mjs`（pptxgenjs） |
| `office/pptx-media.pptx` | **Wave 5D-3：图文混排**（图片 + 说明文本） | `scripts/gen-office-fixtures.mjs` |
| `office/pptx-zorder.pptx` | **Wave 5D-3：重叠 shape + z-order**（矩形→圆→三角） | `scripts/gen-office-fixtures.mjs` |
| `office/pptx-gradient.pptx` | **Wave 5D-3：渐变 + 半透明 + 旋转**（gradFill 注入） | `scripts/gen-office-fixtures.mjs` |
| `office/pptx-table.pptx` | **Wave 5D-3：表格**（表头填充色） | `scripts/gen-office-fixtures.mjs` |
| `office/pptx-43.pptx` | **Wave 5D-3：4:3 版式**（960×720） | `scripts/gen-office-fixtures.mjs` |
| `office/pptx-long-24p.pptx` | **Wave 5D-3：24 slides**（大 deck lazy 基准） | `scripts/gen-office-fixtures.mjs` |
| `html-basic/index.html` | 基础 HTML + 内联 JS + 表单 | 手写 |
| `html-js/index.html` + `app.js` + `style.css` | **JS 应用页**：外部相对脚本、DOM 操作、事件委托、定时器（§28） | 手写 |
| `html-relative-assets/index.html` + `style.css` + `logo.svg` | **相对资源解析 + root boundary（§17）** | 手写 |
| `html-canvas/index.html` | **data-* 声明式 canvas（§30/§32 决策样本，格式与 DetailCard PREVIEW_BOOT_SCRIPT 兼容，内联同源渲染器）** | 手写 |
| `html-high-dpi-canvas/index.html` | **High-DPI canvas（§28/§51）**：DPR 感知 vs 非感知并排对比，Golden 核验 Canvas 清晰度 | 手写 |
| `svg-basic.svg` | **基础 SVG**：形状/路径/文本/变换（§28/§35） | 手写 |
| `svg-complex.svg` | 渐变/滤镜/阴影/路径（§35 SVG 验证） | 手写 |
| `svg-animation.svg` | SMIL 动画（渲染行为基线） | 手写 |
| `svg-filter.svg` | **SVG 滤镜**：高斯模糊/投影/去饱和/辉光/位移混合（§28） | 手写 |
| `office/docx-rich.docx` / `xlsx-rich.xlsx` / `pptx-rich.pptx` | Wave 1H Office 引擎 benchmark 输入（§54-56） | `scripts/gen-office-fixtures.mjs` |

## Real-world 抽取

```bash
pnpm extract:fixtures            # dry-run 列候选清单（默认）
pnpm extract:fixtures -- --emit  # 落盘到 _candidates/ + manifest.jsonl
```

实测产量：canvas ×6、html ×2、markdown ×43、write ×22（svg ×0——历史会话无独立 svg 文件）。

**§31 sanitize 红线**：`_candidates/` 内容含个人路径/可能敏感文本，正式进入
`real-world/` 前必须人工清理（替换路径、去凭证、保结构保渲染行为）。

**Real-world 正式样本（1A 第二批，2026-08-08）**：

```bash
pnpm extract:fixtures -- --emit  # 落盘 _candidates/
pnpm sanitize:fixtures           # 匿名化 → fixtures/artifacts/real-world/<kind>/
```

| kind | 数量 | 说明 |
|---|---|---|
| html | 2 | 完整 HTML 文档（含相对资源、复杂布局） |
| markdown | 8 | 真实聊天产物（表格/代码围栏/长文） |
| write | 8 | 真实 write 产物（run-plan、fitness-plan、ocean-poster、跑步规划画布等） |
| canvas | 0 | ×6 候选均为代码检索文本（含 `<canvas>` 字符串的聊天内容），非渲染产物，剔除 |
| svg | 0 | 历史会话无独立 svg 文件（synthetic 覆盖） |

sanitize 规则：个人路径 → `C:\Users\user` 占位、session 目录名匿名化、无凭证/邮箱/手机号残留（扫描验证 0）；
`_candidates/` 已 gitignore（含原始来源路径，仅本地）。

## Golden 截图

```bash
pnpm harness:golden -- --dpr 1.0     # 每 DPR 单独进程（Electron 约束）
pnpm harness:golden -- --dpr 1.5
pnpm harness:golden -- --dpr 2.0     # §51 DPR matrix 1.0/1.25/1.5/2.0
pnpm harness:golden -- --view wcv    # §49 WCV 独立截图模式
```

**已封板（2026-08-08）**：9 fixtures × DPR 1.0/1.25/1.5/2.0 = 36 张，人工审查通过（无白屏/错位/乱码；
html-high-dpi-canvas 感知/非感知清晰度差异符合预期）。`manifest.json` 36 条均 `approved: true`；
复看入口 `fixtures/golden/preview.html`。

### Wave 5A Golden（2026-08-08，§84/§85）

```bash
pnpm golden:wave5a -- --dpr 1.0      # 每 DPR 单独进程；--only <子串> 单场景
pnpm golden:wave5a -- --dpr 2.0
```

**已封板**：`fixtures/golden/wave5a/` 8 场景 × DPR 1.0/1.25/1.5/2.0 = 32 张（人工审查通过）：
md-features / md-rich / md-long（虚拟化长文档）、code-ts-light / code-ts-dark（双主题）、
code-large（10.9k 行虚拟列表）、code-longline（横向滚动）、code-edit（Monaco 编辑态）。
预览页 `fixtures/golden-pages/wave5a-preview.html`（真实生产组件经 `scripts/build-wave5a-preview.mjs`
esbuild 打包，appStore mock 别名，内容走 `w5a-fixture://` 自定义协议）。

注意：html-canvas 柱状图 X 轴周几标签在 876×610 默认视口下被裁剪（截图范围问题，非渲染缺陷；
DPR 放大只增像素密度不增逻辑视口）。

### Wave 5B Golden（2026-08-08，§87）

```bash
pnpm golden:wave5b -- --dpr 1.0      # 每 DPR 单独进程；--only <子串> 单场景
```

**已封板**：`fixtures/golden/wave5b/` 7 场景 × DPR 1.0/1.25/1.5/2.0 = 28 张（人工审查通过）：
img-basic（浅色 fit）、img-dark（深色）、img-transparent（棋盘格）、img-exif（EXIF 旋转竖显）、
img-8k（8K fit）、img-zoom（100% 缩放态）、img-tall（超高 fit-width）。
注意：8K 缩略绘制在隐藏窗口较慢，golden 对 8K 场景加双 rAF + 2.5s 稳定等待。

### Wave 5C Golden（2026-08-08，§86）

```bash
pnpm golden:wave5c -- --dpr 1.0      # 每 DPR 单独进程；--only <子串> 单场景
```

**已封板**：`fixtures/golden/wave5c/` 7 场景 × DPR 1.0/1.25/1.5/2.0 = 28 张（人工审查通过）：
pdf-simple（1 页）、pdf-normal（32 页 fit-page）、pdf-zoom（100% 缩放态）、pdf-tables（表格+图表）、
pdf-scanned（扫描件）、pdf-landscape（横向页）、pdf-dark（深色主题）。
注意：canvas 必须预置物理尺寸（viewport×dpr）并传 transform，否则退化为 300×150 默认画布；
TextLayer CSS 变量用 `--user-unit`（非 pixel-ratio）保证文本层与画布对齐。

### Wave 5D-1 Golden（2026-08-08，§88 / 1H spike）

```bash
pnpm golden:wave5d1 -- --dpr 1.0      # 每 DPR 单独进程；--only <子串> 单场景
```

**已封板**：`fixtures/golden/wave5d1/` 7 场景 × DPR 1.0/1.25/1.5/2.0 = 28 张（人工审查通过）：
docx-simple（1 页）、docx-long（25 页窗口化）、docx-table（复杂表格）、docx-images（多图多页）、
docx-hf（页眉页脚）、docx-zoom（100% 缩放态）、docx-dark（深色主题）。
注意：docx-preview 仅按显式分页符/文档 section 分页（无自动按高度分页），多页 fixture 必须带分页符。

### Wave 5D-2 Golden（2026-08-08，§88 / 1H spike）

```bash
pnpm golden:wave5d2 -- --dpr 1.0      # 每 DPR 单独进程；--only <子串> 单场景
```

**已封板**：`fixtures/golden/wave5d2/` 7 场景 × DPR 1.0/1.25/1.5/2.0 = 28 张（人工审查通过）：
xlsx-simple / xlsx-multi（3 tab）/ xlsx-frozen（冻结窗格粘顶粘左）/ xlsx-merged（合并块）/
xlsx-formats（日期/百分比/货币 + 样式列）/ xlsx-formula（缓存结果）/ xlsx-10k30（万行）。
注意：sticky 层必须 grid-area 重叠（normal-flow 兄弟会推挤导致冻结失效）；
SheetJS cellStyles:true 的 s 是解析对象，xf 索引需从 sheet XML 提取。

### Wave 5D-3 Golden（2026-08-08，§88 / 1H spike）

```bash
pnpm golden:wave5d3 -- --dpr 1.0      # 每 DPR 单独进程；--only <子串> 单场景
```

**已封板**：`fixtures/golden/wave5d3/` 7 场景 × DPR 1.0/1.25/1.5/2.0 = 28 张（人工审查通过）：
pptx-simple（16:9 标题页 + 缩略图 rail）/ pptx-media（图文混排）/ pptx-zorder（重叠 shape
z-order）/ pptx-gradient（渐变+半透明+旋转）/ pptx-table / pptx-43（4:3）/ pptx-long（24 slides）。

## 缺口（deferred → Wave 5，明确不占 Phase 0 口径）

- [x] ~~`image-*.png`（大图/alpha）~~ ✅ **Wave 5B 2026-08-08 完成**（12 个 fixture，见上表；查看器 §87 落地）
- [x] ~~`pdf-*.pdf`（text/image/multipage）~~ ✅ **Wave 5C 2026-08-08 完成**（8 个 fixture，见上表；viewer §86 落地：text layer/continuous scroll/zoom/search/selection/high-DPI）
- [x] ~~office fixtures~~ ✅ 2026-08-08 完成（Wave 1H 输入）
- [x] ~~real-world 正式样本（sanitize 流程后）~~ ✅ 2026-08-08 完成（18 个）
- [x] ~~`markdown-long.md`~~ ✅ 2026-08-08 完成（gen-markdown-long.mjs）
