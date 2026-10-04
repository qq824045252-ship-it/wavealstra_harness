/**
 * Wave 5A — Markdown + Code Quality 单元/契约测试（node 直跑）
 *
 * 覆盖（5A Gate 的机器可测部分）：
 *   - markdownDoc：分块（fence 安全/无标题兜底/空文档）、slug 锚点、链接/图片策略
 *   - codeHighlight：语言别名映射、降级阈值、行 HTML 构建（双主题变体）
 *   - 真实 Shiki（JS engine）：fixture tokenize、双主题颜色、未知语言降级
 *   - fixture 统计：markdown-long ≥80KB / code-large ≥10k 行 / 超长行 / 真实 md fixture
 *
 * 运行：pnpm test:wave5a（esbuild bundle → node）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 测试经 esbuild bundle 到 out/tests/，__dirname 不可用；pnpm scripts 保证 cwd = 项目根
const ROOT = process.cwd();
import {
  classifyImageSrc,
  isAnchorHref,
  isBareOpenDesignDaemonUrl,
  isExternalHref,
  isLocalHttpHref,
  isOpenDesignPreviewFileUrl,
  isRemoteHttpHref,
  slugifyHeading,
  splitMarkdownSections,
  uniqueSlug,
} from "../src/renderer/src/lib/markdownDoc";
import {
  degradationPolicy,
  languageBadge,
  normalizeLanguage,
  plainLineToHtml,
  tokenLineToHtml,
  tokenizeCode,
} from "../src/renderer/src/lib/codeHighlight";

const FIX = join(ROOT, "fixtures", "artifacts", "synthetic");
const REAL_MD = join(ROOT, "fixtures", "artifacts", "real-world", "markdown");

const results: Array<[string, boolean, string]> = [];
function check(name: string, pass: boolean, detail = ""): void {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---------- markdownDoc：分块 ----------

function mdSplit() {
  const doc = [
    "# 标题一",
    "内容 A",
    "## 子标题 1-1",
    "内容 B",
    "### 子标题 1-1-1",
    "内容 C",
    "# 标题二",
    "内容 D",
  ].join("\n");
  const sections = splitMarkdownSections(doc);
  check("md-split: 4 个 section（每个标题一个）", sections.length === 4, `got ${sections.length}`);
  check(
    "md-split: 首个 section heading 为 h1",
    sections[0]?.heading?.level === 1 && sections[0]?.heading?.slug === "标题一",
    JSON.stringify(sections[0]?.heading),
  );
  check("md-split: section 内容不含标题行", sections[1]?.content === "内容 B", sections[1]?.content);
  check(
    "md-split: 最后一个 section 内容完整",
    sections[3]?.content === "内容 D" && sections[3]?.heading?.level === 1,
  );
  check(
    "md-split: index 连续",
    sections.every((s, i) => s.index === i),
  );

  // fence 内的 # 不切分
  const fenced = [
    "## 章节",
    "```ts",
    "# 这是代码里的注释标题",
    "## 也是代码",
    "```",
    "正文",
    "## 下一章",
  ].join("\n");
  const fs = splitMarkdownSections(fenced);
  check(
    "md-split: fence 内 # 不切分",
    fs.length === 2 && fs[0]?.content.includes("```") && fs[0]?.content.includes("# 这是代码里的注释标题"),
    `sections=${fs.length}`,
  );

  // 无标题文档：600 行兜底切块
  const noHeading = Array.from({ length: 1400 }, (_, i) => `line ${i}`).join("\n");
  const nh = splitMarkdownSections(noHeading);
  check(
    "md-split: 无标题文档兜底切块（>1 块且每块 ≤600 行）",
    nh.length >= 2 && nh.every((s) => s.heading === null) && nh.every((s) => s.estLines <= 600),
    `sections=${nh.length}`,
  );

  // 空文档
  check("md-split: 空文档 → 0 section", splitMarkdownSections("").length === 0);
  check("md-split: 纯空白 → 0 section", splitMarkdownSections("  \n\n  ").length === 0);
}

// ---------- markdownDoc：slug ----------

function mdSlug() {
  check("slug: 中文保留", slugifyHeading("第 1 章：章节 1") === "第-1-章章节-1", slugifyHeading("第 1 章：章节 1"));
  check("slug: 小写+空格", slugifyHeading("Hello World") === "hello-world");
  check("slug: 去标点", slugifyHeading("A/B: C!") === "ab-c", slugifyHeading("A/B: C!"));
  check("slug: 连续连字符合并", slugifyHeading("a--b  c") === "a-b-c");
  const seen = new Map<string, number>();
  check("slug: 去重 -1/-2", uniqueSlug("x", seen) === "x" && uniqueSlug("x", seen) === "x-1" && uniqueSlug("x", seen) === "x-2");
}

// ---------- markdownDoc：链接/图片策略 ----------

function mdPolicy() {
  check("img: data URI 渲染", classifyImageSrc("data:image/png;base64,AAAA") === "render");
  check("img: blob 渲染", classifyImageSrc("blob:https://a/b") === "render");
  check("img: https 渲染（CSP 决定是否显示）", classifyImageSrc("https://example.com/a.png") === "render");
  check("img: 相对路径占位", classifyImageSrc("./assets/diagram.png") === "placeholder");
  check("img: 无协议占位", classifyImageSrc("images/foo.jpg") === "placeholder");
  check("link: # 锚点", isAnchorHref("#foo") === true && isAnchorHref("https://x") === false);
  check("link: 外链", isExternalHref("https://example.com") === true && isExternalHref("#a") === false);
  check(
    "link: 本机 loopback",
    isLocalHttpHref("http://localhost:6002") === true &&
      isLocalHttpHref("http://127.0.0.1:6002/a") === true &&
      isLocalHttpHref("https://example.com") === false &&
      isLocalHttpHref("#a") === false,
  );
  check(
    "link: 外网 = 非 loopback http(s)",
    isRemoteHttpHref("https://example.com") === true &&
      isRemoteHttpHref("http://127.0.0.1:6002") === false &&
      isRemoteHttpHref("#a") === false,
  );
  check(
    "link: OD daemon 裸根（headless 无 Web UI）",
    isBareOpenDesignDaemonUrl("http://127.0.0.1:7456/") === true &&
      isBareOpenDesignDaemonUrl("http://127.0.0.1:7456") === true &&
      isBareOpenDesignDaemonUrl("http://127.0.0.1:7457/") === true &&
      isBareOpenDesignDaemonUrl("http://127.0.0.1:7456/api/projects/x/raw/a.html") === false &&
      isBareOpenDesignDaemonUrl("http://localhost:6002/") === false &&
      isBareOpenDesignDaemonUrl("https://example.com/") === false,
  );
  check(
    "link: OD raw/powered 预览文件 URL",
    isOpenDesignPreviewFileUrl(
      "http://127.0.0.1:7456/api/projects/project-a9a4/raw/blackboard_welcome.html",
    ) === true &&
      isOpenDesignPreviewFileUrl(
        "http://127.0.0.1:7456/api/projects/project-a9a4/powered/a.html",
      ) === true &&
      isOpenDesignPreviewFileUrl("http://127.0.0.1:7456/") === false &&
      isOpenDesignPreviewFileUrl("http://127.0.0.1:6002/api/projects/x/raw/a.html") === false,
  );
}

// ---------- codeHighlight：语言映射 / 降级 / HTML ----------

function codeLang() {
  check("lang: ts 别名", normalizeLanguage("ts") === "typescript");
  check("lang: jsx → javascript", normalizeLanguage("jsx") === "javascript");
  check("lang: sh/bash/shell → shellscript", normalizeLanguage("sh") === "shellscript" && normalizeLanguage("bash") === "shellscript" && normalizeLanguage("shell") === "shellscript");
  check("lang: md/gfm → markdown", normalizeLanguage("md") === "markdown");
  check("lang: python3 → python", normalizeLanguage("python3") === "python");
  check("lang: 未知 → null", normalizeLanguage("cobol") === null);
  check("lang: 空 → null", normalizeLanguage(undefined) === null && normalizeLanguage("") === null);
  check("lang: xml → html（用 html grammar 高亮）", normalizeLanguage("xml") === "html");
  check("badge: shellscript → shell", languageBadge("sh") === "shell");
  check("badge: 未知 → text", languageBadge("cobol") === "text");
  check("badge: xml 仍显示 xml", languageBadge("xml") === "xml");
}

function codePolicy() {
  const small = degradationPolicy(100, 10_000);
  check("degrade: 小文件全开", !small.plainText && !small.chunkedSwap && !small.editDisabled && small.reason === null);
  const chunked = degradationPolicy(3_000, 100_000);
  check("degrade: 3k 行分块换入", chunked.chunkedSwap && !chunked.plainText);
  const plain = degradationPolicy(35_000, 100_000);
  check("degrade: 35k 行纯文本", plain.plainText && plain.reason !== null);
  const big = degradationPolicy(5_000, 2 * 1024 * 1024);
  check("degrade: 2MB 禁编辑", big.editDisabled && !big.plainText);
  const huge = degradationPolicy(5_000, 4 * 1024 * 1024);
  check("degrade: 4MB 纯文本（含禁编辑）", huge.plainText && huge.editDisabled);
}

function codeHtml() {
  const line = [
    { content: "const", light: { color: "#D73A49", fontStyle: 0 }, dark: { color: "#F97583", fontStyle: 0 } },
    { content: " ", light: { color: "#24292E", fontStyle: 0 }, dark: { color: "#E1E4E8", fontStyle: 0 } },
    { content: "x", light: { color: "#005CC5", fontStyle: 1 }, dark: { color: "#79B8FF", fontStyle: 1 } },
  ];
  const light = tokenLineToHtml(line, "light");
  check("html: 主题色 light", light.includes('color:#D73A49') && !light.includes("#F97583"), light.slice(0, 80));
  const dark = tokenLineToHtml(line, "dark");
  check("html: 主题色 dark", dark.includes('color:#F97583') && !dark.includes("#D73A49"), dark.slice(0, 80));
  check("html: italic fontStyle", light.includes("italic"), light);
  check("html: 空行 → 空串", tokenLineToHtml([], "light") === "");
  check("html: 空白 token 跳过", tokenLineToHtml([{ content: " ", light: { color: "", fontStyle: 0 }, dark: { color: "", fontStyle: 0 } }], "light") === "");
  const esc = tokenLineToHtml([{ content: "<div>&", light: { color: "", fontStyle: 0 }, dark: { color: "", fontStyle: 0 } }], "light");
  check("html: 转义 <>&", esc.includes("&lt;div&gt;&amp;"), esc);
  check("html: 纯文本行转义", plainLineToHtml("<a>") === "&lt;a&gt;");
}

// ---------- 真实 Shiki（JS engine，与生产同代码路径） ----------

async function realShiki() {
  const src = readFileSync(join(FIX, "code-ts.ts"), "utf-8");
  const result = await tokenizeCode(src, "typescript");
  check("shiki: ts fixture tokenize 成功", result.lang === "typescript" && !result.failed && result.lines.length > 50, `lines=${result.lines.length}`);
  // 双主题变体：至少一个 token 两主题颜色不同
  let dualDiff = 0;
  for (const line of result.lines) {
    for (const token of line) {
      if (token.light.color && token.dark.color && token.light.color !== token.dark.color) dualDiff += 1;
    }
  }
  check("shiki: 双主题变体颜色差异存在", dualDiff > 0, `diff=${dualDiff}`);

  const py = await tokenizeCode(readFileSync(join(FIX, "code-python.py"), "utf-8"), "python");
  check("shiki: python fixture", py.lang === "python" && py.lines.length > 100, `lines=${py.lines.length}`);

  const json = await tokenizeCode(readFileSync(join(FIX, "code-json.json"), "utf-8"), "json");
  check("shiki: json fixture 8k 行", json.lines.length > 7000, `lines=${json.lines.length}`);

  const xml = await tokenizeCode('<?xml version="1.0"?><root><item/></root>', "xml");
  check("shiki: xml 走 html grammar 且有行", xml.lang === "html" && !xml.failed && xml.lines.length >= 1, `lang=${xml.lang} lines=${xml.lines.length}`);

  const shell = await tokenizeCode(readFileSync(join(FIX, "code-shell.sh"), "utf-8"), "shell");
  check("shiki: shell fixture", shell.lang === "shellscript" && shell.lines.length > 200, `lines=${shell.lines.length}`);

  const js = await tokenizeCode(readFileSync(join(FIX, "code-js.js"), "utf-8"), "javascript");
  check("shiki: js fixture", js.lang === "javascript" && js.lines.length > 400, `lines=${js.lines.length}`);

  const md = await tokenizeCode(readFileSync(join(FIX, "markdown-features.md"), "utf-8"), "markdown");
  check("shiki: markdown fixture", md.lang === "markdown" && md.lines.length > 50, `lines=${md.lines.length}`);

  const unknown = await tokenizeCode("some code", "cobol");
  check("shiki: 未知语言 → 纯文本降级", unknown.lang === null && unknown.lines.length === 0);

  // 大文件（10.9k 行）tokenize 完整
  const large = await tokenizeCode(readFileSync(join(FIX, "code-large.ts"), "utf-8"), "typescript");
  check("shiki: 10.9k 行完整 tokenize", large.lines.length >= 10_000, `lines=${large.lines.length}`);
}

// ---------- fixture 统计 ----------

function fixtureStats() {
  const mdLong = readFileSync(join(FIX, "markdown-long.md"), "utf-8");
  check("fixture: markdown-long ≥80KB", mdLong.length >= 80 * 1024, `${(mdLong.length / 1024).toFixed(0)}KB`);

  const codeLarge = readFileSync(join(FIX, "code-large.ts"), "utf-8");
  const largeLines = codeLarge.split("\n").length;
  check("fixture: code-large ≥10k 行", largeLines >= 10_000, `${largeLines} 行`);

  const longline = readFileSync(join(FIX, "code-longline.ts"), "utf-8");
  const maxWidth = longline.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
  check("fixture: 超长行 ≥400 字符", maxWidth >= 400, `${maxWidth} 字符`);

  const features = readFileSync(join(FIX, "markdown-features.md"), "utf-8");
  check("fixture: features 含表格/任务列表/脚注", features.includes("| --- |") && features.includes("- [x]") && features.includes("[^fn-1]"));

  const js = readFileSync(join(FIX, "code-js.js"), "utf-8");
  check("fixture: code-js.js 存在", js.length > 10_000);
  const shell = readFileSync(join(FIX, "code-shell.sh"), "utf-8");
  check("fixture: code-shell.sh 存在", shell.length > 5_000);

  // 真实 markdown fixtures（8 个 sanitize 后样本）
  let realCount = 0;
  let realTotal = 0;
  for (const name of ["01-msg.md", "02-msg.md", "03-msg.md", "04-msg.md", "05-msg.md", "06-msg.md", "07-msg.md", "08-msg.md"]) {
    try {
      const content = readFileSync(join(REAL_MD, name), "utf-8");
      if (content.trim().length > 0) {
        realCount += 1;
        realTotal += content.length;
        // 每个真实 fixture 都能被分块（含无标题兜底）
        const sections = splitMarkdownSections(content);
        check(`fixture: 真实 md ${name} 可分块`, sections.length >= 1, `sections=${sections.length}`);
      }
    } catch {
      /* missing */
    }
  }
  check("fixture: 真实 md 样本 8/8", realCount === 8, `${realCount}/8, ${(realTotal / 1024).toFixed(0)}KB`);
}

// ---------- 入口 ----------

async function main() {
  console.log("== Wave 5A unit/contract（node） ==");
  mdSplit();
  mdSlug();
  mdPolicy();
  codeLang();
  codePolicy();
  codeHtml();
  await realShiki();
  fixtureStats();

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n结果: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    console.log(`失败 ${failed.length} 项:`);
    for (const [name, , detail] of failed) console.log(`  FAIL ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

void main();
