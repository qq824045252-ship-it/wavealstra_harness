/**
 * Wave 1A — Real-world Artifact Fixture 抽取（V3.5 §29-31）
 *
 * 从 ~/.mybuddy/sessions 目录（pi v3 格式 jsonl）扫描历史会话，抽取：
 *   canvas  — 声明式 data-* canvas 样本（<canvas><data>…</data></canvas>，PREVIEW_BOOT_SCRIPT 相关）
 *   html    — 完整 HTML 文档（<html / <!doctype html 开头）
 *   svg     — SVG 文档
 *   markdown— 复杂 Markdown（表格/代码围栏/数学）
 *   write   — toolCall write/edit 写入的 .html/.svg/.md 文件内容
 *
 * 安全规则（§31）：
 *   - 默认 --dry-run：只列候选清单，不写文件
 *   - --emit 才落盘到 fixtures/artifacts/real-world/_candidates/<kind>/
 *   - 候选一律带 __SANITIZE_REQUIRED__ 标记：个人路径/凭证/隐私必须人工清理后
 *     才能正式进入 fixtures/artifacts/real-world/（保留结构与渲染行为）
 *
 * 运行：node scripts/extract-real-artifacts.mjs [--emit] [--max <n>]
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SESSIONS_DIR = join(homedir(), ".mybuddy", "sessions");
const OUT_DIR = join(import.meta.dirname, "..", "fixtures", "artifacts", "real-world", "_candidates");
const emit = process.argv.includes("--emit");
const maxArg = process.argv.indexOf("--max");
const MAX_PER_KIND = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : 8;

const MIN_LEN = 300; // 太短的片段没价值
const MAX_LEN = 60_000; // 截断超长样本

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function candidates() {
  const found = { canvas: [], html: [], svg: [], markdown: [], write: [] };
  const files = walk(SESSIONS_DIR);
  for (const file of files) {
    const lines = readFileSync(file, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const msg = evt?.message;
      const blocks = Array.isArray(msg?.content) ? msg.content : [];
      for (const b of blocks) {
        if (b?.type === "text" && typeof b.text === "string") {
          const t = b.text.trim();
          if (t.length < MIN_LEN || t.length > MAX_LEN * 4) continue;
          // 声明式 canvas：<canvas> + <data> 或 data-canvas 属性
          if (/<canvas[\s>][^>]*>/i.test(t) && (/<data[\s>]/i.test(t) || /data-canvas=/i.test(t))) {
            found.canvas.push({ src: file, block: b.id ?? "", len: t.length, text: t });
          } else if (/^<!doctype\s+html/i.test(t) || /^<html[\s>]/i.test(t)) {
            found.html.push({ src: file, block: b.id ?? "", len: t.length, text: t });
          } else if (/^<svg[\s>]/i.test(t)) {
            found.svg.push({ src: file, block: b.id ?? "", len: t.length, text: t });
          } else if (/^#{1,6}\s+/.test(t) && (t.includes("```") || t.includes("|"))) {
            found.markdown.push({ src: file, block: b.id ?? "", len: t.length, text: t });
          }
        } else if (b?.type === "toolCall" && (b.name === "write" || b.name === "edit")) {
          let args = b.arguments;
          if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
          const path = String(args?.path ?? "").toLowerCase();
          const content = String(args?.content ?? "");
          if (content.length < MIN_LEN) continue;
          if (path.endsWith(".html") || path.endsWith(".htm")) found.write.push({ src: file, block: b.id ?? "", len: content.length, path: args?.path, text: content, hint: "html" });
          else if (path.endsWith(".svg")) found.write.push({ src: file, block: b.id ?? "", len: content.length, path: args?.path, text: content, hint: "svg" });
          else if (path.endsWith(".md")) found.write.push({ src: file, block: b.id ?? "", len: content.length, path: args?.path, text: content, hint: "markdown" });
        }
      }
    }
  }
  return found;
}

const safeName = (s) => String(s).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-40);

const kinds = ["canvas", "html", "svg", "markdown", "write"];

const found = candidates();
let total = 0;
const manifest = [];
for (const kind of kinds) {
  const list = found[kind].slice(0, MAX_PER_KIND);
  console.log(`\n=== ${kind}: 共 ${found[kind].length} 个候选，取前 ${list.length} 个 ===`);
  list.forEach((c, i) => {
    total++;
    const desc = (c.path ? safeName(c.path) : `${c.block || "msg"}`).slice(0, 50) || "sample";
    const name = `${String(i + 1).padStart(2, "0")}-${desc}.${c.hint === "svg" ? "svg" : c.hint === "html" ? "html" : c.hint === "markdown" ? "md" : kind === "html" ? "html" : kind === "svg" ? "svg" : kind === "markdown" ? "md" : "canvas.html"}`;
    console.log(`  [${i + 1}] ${name}  ${c.len} 字节  来源 ${c.src.split("\\").pop()}`);
    manifest.push({ kind, file: name, bytes: c.len, source: c.src, blockId: c.block, path: c.path ?? null });
    if (emit) {
      const dir = join(OUT_DIR, kind);
      mkdirSync(dir, { recursive: true });
      const body = c.text.slice(0, MAX_LEN);
      writeFileSync(
        join(dir, name),
        `<!-- __SANITIZE_REQUIRED__ 来源: ${c.src} | block: ${c.block} | 长度: ${c.len} -->
<!-- 入正式 fixtures/artifacts/real-world/ 前必须清理个人路径/凭证/隐私（V3.5 §31） -->\n${body}`,
        "utf-8",
      );
    }
  });
}

console.log(`\n===== 候选总数: ${total} =====`);
if (emit) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "manifest.jsonl"), manifest.map((m) => JSON.stringify(m)).join("\n"), "utf-8");
  console.log(`已落盘: ${OUT_DIR}`);
} else {
  console.log("dry-run：未写文件。确认后加 --emit 落盘，再人工 sanitize（§31）。");
}
if (!existsSync(SESSIONS_DIR)) console.log(`警告: 会话目录不存在 ${SESSIONS_DIR}`);
