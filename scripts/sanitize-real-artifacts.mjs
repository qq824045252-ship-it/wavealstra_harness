/**
 * Wave 1A — Real-world Fixture Sanitize（V3.5 §31）
 *
 * 把 _candidates/ 下带 __SANITIZE_REQUIRED__ 标记的候选转成正式 fixtures：
 *   - 内容匿名化：个人路径（C:\Users\servi 等）→ 通用占位
 *   - 文件名清理：去掉路径前缀（_Users_servi_Desktop_...）与双扩展名
 *   - 标记更新：__SANITIZE_REQUIRED__ → __SANITIZED__
 *
 * 保留结构与渲染行为；只替换标识性文本。
 * 运行：node scripts/sanitize-real-artifacts.mjs
 */
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CAND = join(import.meta.dirname, "..", "fixtures", "artifacts", "real-world", "_candidates");
const OUT = join(import.meta.dirname, "..", "fixtures", "artifacts", "real-world");

// canvas 类已剔除：历史候选均为代码检索文本（含 <canvas> 字符串的聊天内容），非渲染产物（2026-08-08 核实）
const KINDS = ["html", "markdown", "write"];

/** 内容匿名化规则（只替换标识性文本，不动渲染结构） */
function sanitizeContent(text) {
  let out = text;
  const before = {};

  const rules = [
    // Windows 用户路径（正反斜杠两种写法）
    [/C:[\\/]Users[\\/]servi/gi, "C:\\Users\\user"],
    // 绝对路径里的 mybuddy 目录
    [/(?:Desktop[\\/])?mybuddy/gi, "mybuddy"],
    // 其他常见个人路径形态
    [/(?:[A-Za-z]:)?[\\/]Users[\\/]servi/gi, "C:\\Users\\user"],
  ];

  for (const [re, rep] of rules) {
    const hits = out.match(re);
    if (hits) before[String(re)] = hits.length;
    out = out.replace(re, rep);
  }
  return { out, stats: before };
}

/** 文件名清理：_Users_servi_Desktop_run-plan_index.html.html → run-plan-index.html */
function cleanName(raw, kind) {
  let name = raw;
  // 去掉路径前缀（_Users_servi_Desktop_ / C__Users_servi_Desktop_ / vi_Desktop_ 等）
  name = name.replace(/^(?:C__Users_servi_Desktop__|_Users_servi_Desktop__|_Desktop_mybuddy_|_Desktop__|vi_Desktop_mybuddy_out__|servi_\.mybuddy_skills_|_Desktop_mybuddy_V3\.4_)/, "");
  // 去掉双扩展名（.html.html / .md.md）
  name = name.replace(/\.(html|md|svg|json)\.\1$/i, ".$1");
  // 兜底：如果还有明显路径痕迹，保留中段
  if (/[\\/_]{2,}|^_/.test(name)) {
    name = name.replace(/^_+/, "").replace(/_+/g, "-");
  }
  return name || `sample-${kind}`;
}

let total = 0;
for (const kind of KINDS) {
  const dir = join(CAND, kind);
  let files;
  try { files = readdirSync(dir); } catch { continue; }
  for (const file of files) {
    if (!file.endsWith(".html") && !file.endsWith(".md") && !file.endsWith(".svg")) continue;
    const raw = readFileSync(join(dir, file), "utf-8");
    const { out, stats } = sanitizeContent(raw);
    const newName = cleanName(file, kind);
    const outDir = join(OUT, kind);
    mkdirSync(outDir, { recursive: true });
    const body = out.replace(/__SANITIZE_REQUIRED__/g, "__SANITIZED__");
    writeFileSync(join(outDir, newName), body, "utf-8");
    total++;
    const statStr = Object.entries(stats).map(([k, v]) => `${v}×`).join(" ");
    console.log(`  ${kind}/${newName}  (${Math.round(body.length / 1024)} KB${statStr ? `, 替换 ${statStr}` : ""})`);
  }
}
console.log(`\n===== sanitize 完成: ${total} 个正式 fixture =====`);
console.log(`输出: ${OUT}`);
