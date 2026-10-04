---
name: npu-ocr
description: |
  本机 NPU 加速 OCR 识别技能:识别图片/截图/图片型 PDF/扫描件/DOCX/XLSX/PPTX
  中的文字,输出 txt/Markdown/JSON 等多种产物。通过 OCR_NPU_CLI.exe 执行
  (C:\Users\servi\Documents\GitHub\OCR_NPU\dist\OCR_NPU_CLI\OCR_NPU_CLI.exe, 本机
  实测验证,NPU 推理,单张截图约 5-9 秒)。适用于微信聊天截图、扫描 PDF、
  拍照文档、含文字的图片等。触发词:OCR、文字识别、识别图片、图片转文字、
  提取图片文字、扫描件识别、截图识别、图片型 PDF 转文字、识图。
---

# npu-ocr — NPU 加速图片/PDF 文字识别

## 什么时候用

- 用户给出**图片文件**(png/jpg 等)要求识别文字 —— 微信截图、拍照、扫描件;
- **图片型 PDF**(无文字层)、DOCX/XLSX/PPTX 中的内容提取;
- 需要批量识别一个目录下的多张图片;
- 用户要求"识别一下/提取文字/图片转文字"且目标文件是图片类。

> 有文字层的原生 PDF 优先用 `--prefer_text_layer` 开关(默认即有文本层则用文本层)。

## 工具路径

```text
CLI = C:\Users\servi\Documents\GitHub\OCR_NPU\dist\OCR_NPU_CLI\OCR_NPU_CLI.exe
默认输出 = 当前工作目录下 pdf_ocr_results\  (可用 --output_dir 指定)
```

## 推荐调用方式(Git Bash 直接执行)

```bash
# 1) 识别单张图片 / 单个文件(PDF/DOCX/XLSX/PPTX 均可)
"C:/Users/servi/Documents/GitHub/OCR_NPU/dist/OCR_NPU_CLI/OCR_NPU_CLI.exe" \
  --input_path "C:/path/截图.png" --output_dir "D:/out/ocr"

# 2) 识别一个目录下的所有图片
"C:/Users/servi/Documents/GitHub/OCR_NPU/dist/OCR_NPU_CLI/OCR_NPU_CLI.exe" \
  --image_dir "C:/path/截图目录" --output_dir "D:/out/ocr"

# 3) 机器可读:--json 把结构化结果打到 stdout(AI 友好,含坐标/阅读顺序)
"C:/Users/servi/Documents/GitHub/OCR_NPU/dist/OCR_NPU_CLI/OCR_NPU_CLI.exe" \
  --input_path "C:/path/截图.png" --json

# 4) 图片型 PDF 常用组合:按页提取 + 输出齐全
"C:/Users/servi/Documents/GitHub/OCR_NPU/dist/OCR_NPU_CLI/OCR_NPU_CLI.exe" \
  --input_path "C:/path/扫描件.pdf" --output_dir "D:/out/ocr" \
  --dpi 300 --start_page 1 --end_page 20
```

> ⚠️ 输出默认写到**当前工作目录**的 `pdf_ocr_results\`,为避免产物散落,
> 一律加 `--output_dir` 指定目标文件夹。路径含空格必须加引号。

## 关键参数

| 参数 | 作用 | 备注 |
|---|---|---|
| `--input_path` | 单文件入口 | PDF/图片/DOCX/XLSX/PPTX |
| `--image_dir` | 目录批量识别 | 目录内所有图片 |
| `--pdf_path` | `--input_path` 旧别名 | 不推荐 |
| `--json` | 结构化 JSON 打 stdout | AI 友好,含阅读顺序 |
| `--dpi` | PDF 渲染精度 | 默认 300,小字可 300+ |
| `--start_page` / `--end_page` | 页范围(1 起) | 大 PDF 分页处理 |
| `--output_dir` | 输出目录 | 默认 `pdf_ocr_results\`(相对 cwd) |
| `--save_vis` / `--save_pages` / `--save_layout_vis` | 可视化图/页面图/版面图 | 排查定位用 |
| `--save_txt` / `--save_json` / `--save_markdown` | 产物开关 | 默认开 txt/json/md |
| `--save_middle_json` / `--save_content_list` | 中间结果/阅读顺序 JSON | 默认开 |
| `--save_qa_report` / `--save_eval_report` | QA 报告/评估指标 | 默认开 |
| `--resume_cache` | 按页缓存断点续跑 | 大 PDF 中断恢复 |
| `--prefer_text_layer` | 优先原生文本层 | 文本型 PDF |
| `--det_npu_base_size` | NPU 检测基准尺寸 | 默认 1280(实测自动 shape 1280x896) |
| `--rec_npu_wide_width` | 宽行切分拼接宽度 | 长截图/宽行表格用 320 效果佳 |
| `--remove_headers_footers` | 去重复页眉页脚 | 扫描件多页 |

## 产物说明(每个输入生成一组)

```text
{name}_ocr.txt            纯文本(阅读顺序)
{name}_ocr.md             Markdown(带标题结构)
{name}_ocr.json           完整识别结果(文本框+坐标+置信度)
{name}_middle.json        中间结果(排版/版面)
{name}_content_list.json  阅读顺序内容列表
{name}_qa_report.json     QA 报告(大文档)
{name}_eval_report.json   提取指标评估
page_001_ocr.jpg          识别可视化(边框+文字,调试用)
```

## 强制验证(每次执行后必做)

1. **看尾部输出**:`Done! Processed N pages.` 确认页数 = 输入文件数/页数。
2. **确认产物存在**:`ls -l "$output_dir"` 核对 txt/json 已生成且非空。
3. **读一遍正文抽查**:打开 `_ocr.txt` 前 30 行,确认语言/内容对得上(数字、单位、专有名词)。
4. **绝不**仅凭"看起来输出正常"宣称成功,以上述证据为准。

## 已知坑(微信截图等长图识别,2026-08-11 实测)

1. **时间戳与正文分离**:微信导出长图的时间戳大量堆积在文本末尾,与消息脱节;
   需要逐条对齐时用 `_ocr.md` 或 `_content_list.json`(含阅读顺序/坐标)。
2. **表头噪声**:`ChatHistororNo`/`Chatistoordino` 等是 "Chat History" 的误识别,忽略即可。
3. **引用气泡混排**:`A:xxx B:yyy` 的引用回复会与正文挤在一行,需人工拆分。
4. **数字可能吞小数点**:如 `zlc 0.4--0.2` 实为 0.04-0.02 量级;涉及参数/数值对账时
   必须回看原图核对,不要直接采信。
5. **同一截图多跑结果可能不一致**:如 `2VLO`/`2ULO` 两版不同;以坐标 JSON 或原图为准。
6. **输出截断**:工具输出较长时会被截断,用 `head -n 60`(看头部/进度)
   和 `tail -n 60`(看正文尾部/统计)分两次查看,别误判为只识别了部分。
7. **耗时参考**:NPU 单张 5-9 秒;多图按张数线性叠加,给足 timeout(300s+)。

## 验证过的行为(2026-08-11 实测)

- 单目录 2 张微信长截图批量识别:2× `Done! Processed 1 pages`,共约 14s ✅
- 自动使用 NPU shape 1280x896(无需手动指定)✅
- 默认产出 7 类文件(txt/md/json/middle/content_list/qa/eval)✅
- 中英文混排(中文聊天+英文单位 m/s、pa)识别正常 ✅
- 长图时间戳堆积、引用混排、表头噪声如上述"已知坑" ✅

## Boundary / Output Contract

语音转写走 meeting-transcribe，已有可直接读取文本不强制 OCR；图片理解/生图不等于文字识别。交付正文与坐标/阅读顺序产物，报告页数、低置信度数字和抽查结果。

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
