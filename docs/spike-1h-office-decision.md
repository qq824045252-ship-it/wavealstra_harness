# 1H — Office Spike 决策文档（V3.5 §54-56）

> 日期：2026-08-08 · docx-preview 0.4.0 · SheetJS xlsx 0.18.5 · pptxgenjs 4.0.1（仅生成样本）
> Spike：`scripts/office-spike.cjs` + `office-spike-page.html` + `office-spike-app.mjs`
> 样本：`fixtures/artifacts/synthetic/office/`（`gen-office-fixtures.mjs` 可复现）

## 决策

| 类型 | 路线 | 依据 |
|---|---|---|
| **DOCX** | **docx-preview**（纯 JS 浏览器渲染，paged 语义） | 0.27MB bundle、10.6ms import、22ms 渲染 9.7KB 文档、无 wasm/worker、CSP 友好 |
| **XLSX** | **SheetJS 解析 + 自绘表格渲染** | 0.83MB、16.8ms 解析 500 行×8 列（含公式/合并/样式元数据）；社区版无 UI 渲染器 → HTML table 自绘（后续实现细节，不影响选型） |
| **PPTX** | **V1 降级：文本/结构预览，不做 full-fidelity 渲染** | 无成熟浏览器渲染库；LibreOffice 本机未安装（外部二进制 = 非自包含，违背单机原则） |

**PPTX 明确列为已记录 limitation（§56 允许）**：V1 提供 jszip 解包 + slide 文本提取预览
（12ms 解包 121KB）；full-fidelity 渲染（layout/shape/image/chart）列入 Wave 5 质量升级，
届时再评估 LibreOffice 转换或自研 drawing XML 渲染器。

## Benchmark（真实 BrowserWindow + 自定义协议 + CSP）

| 指标 | 结果 |
|---|---|
| docx-preview cold import | 10.6 ms |
| docx renderAsync（9.7KB 富文档：24 段/30 行表/列表） | 22.2 ms |
| xlsx cold import | 21.3 ms |
| xlsx 解析（180KB，2 sheets，500 行含公式） | 16.8 ms |
| pptx 解包（121KB，10 slides） | 12.1 ms |
| bundle：docx-preview | **0.27 MB** |
| bundle：xlsx | **0.83 MB** |
| bundle：jszip | 0.15 MB |
| LibreOffice | 未安装 → 外部路线淘汰 |

## 结论要点

1. **三种类型三种路线，技术上不统一（§88 允许）**：DOCX paged 渲染、XLSX 数据引擎+自绘、
   PPTX 降级预览。Quality First 不要求技术统一。
2. **全部纯 JS，无 wasm/worker**：CSP 只需 `style-src 'unsafe-inline'`（docx-preview 注入样式），
   与现有 WebArtifactRuntime sandbox 模型兼容。
3. **lazy load 成本极低**：三库合计 bundle 1.25MB，cold import <25ms，可全部动态 import，
   不影响首屏。
4. **大文件预期**：xlsx 解析线性（500 行 17ms → 1 万行 ~300ms 量级，可接受）；
   docx 渲染随页数线性，超大文档需分页懒渲染（Wave 5）。

## 淘汰方案

- **LibreOffice → PDF**：本机未安装 + 外部二进制依赖 = 非自包含，违背单机原则。淘汰。
- **ONLYOFFICE**：服务器组件 + 大体积，不适用本地 Electron 单机。淘汰。
- **pptx 社区渲染库**：无成熟维护的浏览器 PPTX 渲染器。暂不选型，Wave 5 再评估。

## 后续动作

- [ ] DOCX：docx-preview 集成进 WebArtifactRuntime（动态 import）
- [ ] XLSX：SheetJS + HTML table 渲染器（合并单元格/数字格式映射）
- [ ] PPTX：V1 文本提取预览 + limitation 文档；Wave 5 重评
- [ ] office 样本纳入 1E golden 封板输入
