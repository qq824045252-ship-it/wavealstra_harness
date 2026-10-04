---
name: open-kimi-ppt
description: "Create new visually designed presentations, recreate slide layouts from references, and author or export PPTD projects with the Kimi PPT workflow. Do not trigger for simple inspection or precise text/format edits of existing PPTX files; use officecli for those."
---

# Definition
open-kimi-ppt is a presentation creation and export skill built around Moonshot AI's PPTD format and browser-side PPTX writer. It defines a YAML-format intermediate DSL (`.pptd`) that abstracts OOXML and keeps each page self-contained.

**The default output is not PPTD-only.** Unless the user explicitly opts out, always produce both:

1. the complete editable PPTD project directory (`.pptd` + `pages/` + `media/` and other referenced dependencies);
2. the matching locally generated `.pptx`, with fade slide transitions applied by default; report actual font embedding status.

Convert existing PPTX only when the user requests the PPTD workflow or visual redesign; conversion is not lossless.

## The pptd format
The .pptd format is a simplified abstraction layer over OOXML that follows basic YAML syntax. This abstraction preserves the core content of OOXML (theme, page layout, element positions and definitions, etc.) while removing complex nesting logic such as Masters; every page is self-contained — what you see is what you get. Read reference/pptd.md for the complete definition of this DSL.

## PPT production workflow

### step0. Check local prerequisites
Default delivery includes PPTX export (and optional `npx open-kimi-ppt-skill serve`), which need a local toolchain. **Before generating**, verify:

1. **Node.js 18+**: run `node --version`. If `node` is missing or the major version is below 18, **stop immediately**, tell the user to install Node.js 18+ from https://nodejs.org (or their OS package manager), and do not continue with PPTX export / `npx` until it is available. Only continue with PPTD-only output when the user explicitly opts out of PPTX.
2. **npm / npx**: run `npm --version`. They ship with Node.js; if missing, treat Node.js as not installed correctly and guide the user to reinstall/fix PATH.
3. **python3**: run `uv run --no-project python --version` (on Windows, `python` may be the correct command). Needed for `export_pptx.py` / `export_images.py`.
4. **Chrome / Chromium / Edge**: needed by `agent-browser` for **image QA** (`export_images.py`) and optional `--browser` PPTX path. Default PPTX export uses local WASM and does **not** require a browser. If image QA later fails with a browser-launch error, ask the user to install a Chromium-based browser.
5. Soft deps are auto-handled by the scripts when missing: **PyYAML**, **agent-browser** (≥0.33.2 via npm, only for browser/image paths), and for image QA **Pillow** + **websocket-client**. **PPTX / image export / manual edit are offline** against the local neo-ppt mirror + patched WASM. Network is only needed if the deck references remote images/fonts.

### step1. Read the context thoroughly
Read **all files uploaded by the user**, the provided URLs, and the pptd format guide `reference/pptd.md` to fully understand the user's requirements.

### Planning and production

Before designing or recreating a deck, read the matching planning, template, imagery and production branch: [reference/production-workflow.md](reference/production-workflow.md).

### step4. PPT validation
1. Validate the generated pptd against the format definition in `reference/pptd.md` (required fields, types, bounds, theme tokens, resource paths, etc.) and repair issues over multiple rounds
2. Visual review with exported page images — **required before PPTX export when the model supports image input (multimodal)**:
   - Run `scripts/export_images.py`. It loads the deck into the **local neo-ppt editor** (same offline mirror as `serve`), chooses 导出 → 图片, downloads the images ZIP, unzips it, and stitches all pages into one overview image. Needs Chromium via `agent-browser`, but **does not** call `www.kimi.com`.

     ```bash
     uv run --no-project python "$HOME/.mybuddy/skills/open-kimi-ppt"/scripts/export_images.py \
       /abs/path/project/deck.pptd \
       --output /abs/path/project/.qa-images
     ```

     The script prints a JSON summary mapping each stitched label (`P1`…`Pn`, 1-based page order) to its `.page` file.
   - Read the stitched overview image (`.qa-images/overview.jpg`) and check every page against this list:
     1. 图片是否清晰、不变形（无拉伸、压缩、模糊）
     2. 文字是否压在关键画面（人脸、产品主体、Logo 等）上
     3. 元素坐标是否超出页面边界
     4. 边界与配色对比是否足够（文字与背景、相邻色块之间）
     5. 排版是否统一（对齐、间距、字号层级、页边距）
     6. 文字是否可能溢出文本框（文本过长、行距过密、字号过大）
     7. 内容是否被上层元素遮挡
   - For any suspicious page, read its full-resolution image (`.qa-images/pages/<n>.jpeg`) to confirm the problem before editing.
   - Fix issues in the corresponding `.page` file, then re-run `scripts/export_images.py --force` and review the new overview; repeat until every page passes.
   - Do not export the PPTX until the visual review passes. `.qa-images/` is an intermediate QA artifact and may be deleted after delivery.
3. When the model cannot read images, fall back to a structural review of the generated pages (bounds, overflow-prone long text, contrast, hierarchy, layout density) over multiple rounds, and state that image-based visual QA was skipped.

### Output and delivery

Before export, read the local exporter commands, transition validation and delivery details: [reference/delivery-workflow.md](reference/delivery-workflow.md).

## Routing Boundary

只有新建视觉演示文稿、参考版式复刻、显式 PPTD/Kimi 工作流才进入本流程。现有 PPTX 的读取、文字/字体/DOM 小改交给 officecli。普通生图使用 MyBuddy native image_generate；不把图片请求自动转换为 PPTD。

## Output Contract

Deliver the complete PPTD project (manifest, pages and referenced media) plus locally generated PPTX unless the user opts out. Render and inspect every page before export when image inspection is available; report any skipped visual QA. Verify ZIP integrity and one root-level fade transition per slide in CT_Slide order. Local WASM export does not guarantee embedded fonts or PowerPoint/WPS/Keynote playback compatibility. Never overwrite unrelated inputs. Missing exporter dependencies are a reported blocker, not a successful PPTX delivery.

Use native image_generate for useful conceptual imagery; copy returned task-local assets into media with stable names and preserve source provenance. Do not claim an image was generated unless it was. Element animations require explicit intent or a clear live-presentation benefit; speaker notes require an explicit request.

Trigger/boundary regression prompts: `evals/trigger.json` (load during evaluation, not ordinary execution).
