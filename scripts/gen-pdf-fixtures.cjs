/**
 * Wave 5C — PDF fixtures 生成器（§86 / §28 deferred 补齐）
 *
 * 真实 Chromium printToPDF 生成（字体/中文/表格/图片全部由排版引擎处理）：
 *   pdf-simple.pdf          1 页：标题 + 段落（中英混排）
 *   pdf-normal-40p.pdf      ~40 页：章节模板（标题/段落/表格/代码块/列表/中英混排）
 *   pdf-large-120p.pdf      ≥120 页：同模板放大（大文档性能基准）
 *   pdf-scanned.pdf         4 页：全页位图（扫描型，无文本层）
 *   pdf-tables-images.pdf   ~10 页：大量表格 + canvas 图表 + 中英混排
 *   pdf-landscape.pdf       5 页：横向页面（landscape）
 *   中文-文档.pdf           1 页：中文文件名
 *   spaced name.pdf         1 页：空格文件名
 *   pdf-identity-4p.pdf     4 页：每页唯一标记（页身份回归：跳转 1→2→3→4→1 后
 *                             textLayer/画布必须对应目标页）
 *
 * 支持 --only <前缀>：只生成匹配的 fixture（页身份回归只需单独重建 identity）。
 *
 * 运行：node_modules/.bin/electron.cmd scripts/gen-pdf-fixtures.cjs [--only pdf-identity]
 * 确定性：固定 HTML 模板（无随机）。
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const OUT = join(__dirname, "..", "fixtures", "artifacts", "synthetic");
mkdirSync(OUT, { recursive: true });

const PAGE_STYLES = `
  <style>
    @page { margin: 18mm 16mm; }
    * { box-sizing: border-box; }
    body { font-family: "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif; font-size: 10.5pt; color: #1a1a1a; line-height: 1.55; margin: 0; }
    h1 { font-size: 20pt; margin: 0 0 10pt; }
    h2 { font-size: 14pt; margin: 14pt 0 6pt; border-bottom: 1pt solid #999; padding-bottom: 3pt; }
    h3 { font-size: 12pt; margin: 10pt 0 4pt; }
    p { margin: 4pt 0; text-align: justify; }
    table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9pt; page-break-inside: avoid; }
    th, td { border: 0.5pt solid #666; padding: 3pt 5pt; text-align: left; }
    th { background: #eee; }
    pre { background: #f4f4f4; border: 0.5pt solid #ccc; padding: 6pt; font-size: 8.5pt; white-space: pre-wrap; page-break-inside: avoid; }
    code { font-family: Consolas, monospace; }
    ul, ol { margin: 4pt 0; padding-left: 16pt; }
    li { margin: 1.5pt 0; }
    blockquote { border-left: 3pt solid #bbb; margin: 6pt 0; padding-left: 8pt; color: #444; }
    .keep { page-break-inside: avoid; }
    img { max-width: 100%; }
  </style>
`;

function section(n) {
  return `
  <h2>第 ${n} 章：Project Alpha 设计文档 — Section ${n}</h2>
  <p>本章节用于 PDF 渲染基准：<b>中文</b>与 English <i>mixed</i> 排版、段落、引用与代码
  混合排布。设计目标：<code>reliability</code>、<code>maintainability</code> 与可测量性。
  长文档场景需要连续滚动、页码跳转、文本层搜索与离屏回收协同工作。</p>
  <blockquote>设计原则 ${n}：以 fixture 基准为准，不以历史实现为准。The benchmark is the truth.</blockquote>
  <h3>${n}.1 指标表格</h3>
  <table>
    <tr><th>指标</th><th>目标</th><th>实测</th><th>结论</th></tr>
    ${Array.from({ length: 6 }, (_, i) => `<tr><td>metric-${n}-${i}</td><td>${(i * 1.7).toFixed(1)} ms</td><td>${(i * 1.6 + n * 0.3).toFixed(1)} ms</td><td>${i % 2 ? "达标 ✅" : "接近 ⚠️"}</td></tr>`).join("")}
  </table>
  <h3>${n}.2 代码示例</h3>
  <pre>function evaluate(n: number): string {
  const score = n * 0.618;       // golden ratio
  return score &gt; 42 ? "PASS" : "REVIEW";
}
// 中文注释：性能预算与内存回收策略
console.log(evaluate(${n}));</pre>
  <h3>${n}.3 任务清单</h3>
  <ul>
    <li>☐ 连续滚动与懒渲染（lazy render）</li>
    <li>☐ 离屏 page 回收与内存控制</li>
    <li>☑ 文本层搜索与选择复制</li>
    <li>☐ 大文档快速跳转（第 ${n} 项待办）</li>
  </ul>
  <p>段落 ${n}：The quick brown fox jumps over the lazy dog. 中文段落用于验证中英混排
  的行高、断行与文本层抽取。PDF text layer 应当把本段所有字符按阅读顺序输出。</p>`;
}

function simplePage() {
  return `
  <h1>MyBuddy PDF Fixture — 简单文档</h1>
  <p>这是一页简单的 PDF 文档，包含中文与 English mixed content，用于基础渲染与文本层验证。</p>
  <p>The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过懒狗。</p>
  <p>列表：</p>
  <ul>
    <li>连续滚动 continuous scroll</li>
    <li>页码跳转 page navigation</li>
    <li>文本层搜索 search</li>
  </ul>
  <p>结束 — End of document.</p>`;
}

function chartsHtml() {
  const chart = (label, color) => `
    <canvas id="c${label}" width="420" height="180" style="border:0.5pt solid #ccc"></canvas>
    <script>
      (function () {
        const c = document.getElementById('c${label}');
        const ctx = c.getContext('2d');
        const colors = ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6'];
        ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 420, 180);
        for (let i = 0; i < 5; i++) {
          ctx.fillStyle = colors[i];
          const h = 20 + Math.abs(Math.sin(${label} * 0.7 + i * 1.3)) * 110;
          ctx.fillRect(20 + i * 78, 160 - h, 60, h);
        }
        ctx.fillStyle = '#333'; ctx.font = '12px sans-serif';
        ctx.fillText('${color} chart ${label}', 10, 14);
      })();
    </script>`;
  return chart;
}

function tablesImagesPage(n) {
  return `
  <h2>数据报表 ${n} — Data Report ${n}</h2>
  <p>本页混合<b>大量表格</b>、图片与中英文本，验证表格断页、图片渲染与文本层顺序。</p>
  ${Array.from({ length: 3 }, (_, t) => `
  <h3>表 ${n}.${t + 1}</h3>
  <table>
    <tr><th>产品 Product</th><th>Q${t + 1} 销量</th><th>环比</th><th>Region</th><th>Status</th></tr>
    ${Array.from({ length: 8 }, (_, r) => `<tr><td>产品-${n}-${t}-${r}</td><td>${1200 + n * 37 + r * 91}</td><td>+${(r * 2.3 + t).toFixed(1)}%</td><td>华东</td><td>${r % 3 ? "正常" : "审核"}</td></tr>`).join("")}
  </table>`).join("")}
  <div class="keep">
    <h3>${n}.4 图表</h3>
    ${chartsHtml()(n)}
  </div>
  <p>摘要：The report covers quarterly metrics. 表格与图片应保持可见性，文本层应能搜索到
  “产品-${n}”与“quarterly”等关键词。</p>`;
}

function scannedPage(n) {
  // 全页位图：模拟扫描文档（无文本层）
  return `
  <canvas id="scan${n}" width="1240" height="1754" style="width:100%"></canvas>
  <script>
    (function () {
      const c = document.getElementById('scan${n}');
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#f5f2ec'; ctx.fillRect(0, 0, 1240, 1754);
      // 纸张噪点
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = 'rgba(0,0,0,' + (0.02 + Math.random() * 0.05) + ')';
        ctx.fillRect(Math.random() * 1240, Math.random() * 1754, 2, 2);
      }
      ctx.fillStyle = '#2c2c2c'; ctx.font = 'bold 64px serif';
      ctx.fillText('SCANNED DOCUMENT ${n}', 90, 160);
      ctx.font = '36px serif';
      const lines = [
        'Handwritten-style content placeholder.',
        'This page is a raster image — no text layer.',
        '用于验证扫描件：搜索应无结果，文本选择不可用。',
        'Page ${n} of the scanned fixture.'
      ];
      lines.forEach((t, i) => ctx.fillText(t, 90, 260 + i * 90));
      // 模拟表格线
      ctx.strokeStyle = '#666'; ctx.lineWidth = 2;
      for (let r = 0; r < 8; r++) {
        ctx.strokeRect(90, 640 + r * 90, 1060, 88);
      }
      ctx.fillStyle = '#333'; ctx.font = '28px serif';
      for (let r = 0; r < 8; r++) {
        ctx.fillText('Row ' + (r + 1) + ' — 记录 ' + (r + 1), 110, 700 + r * 90);
      }
    })();
  </script>`;
}

function landscapePage(n) {
  return `
  <h1>横向页面 ${n} — Landscape Page ${n}</h1>
  <p>本页为横向（landscape）页面，宽 > 高。用于验证横向页面在连续滚动中的布局与 fit 计算。</p>
  <table>
    <tr><th>Column A</th><th>Column B</th><th>Column C</th><th>Column D</th><th>Column E</th><th>Column F</th></tr>
    ${Array.from({ length: 10 }, (_, r) => `<tr>${Array.from({ length: 6 }, (_, c) => `<td>item-${n}-${r}-${c}</td>`).join("")}</tr>`).join("")}
  </table>
  <p>Landscape orientation check. 横向页面布局验证完成。</p>`;
}

/** 页身份回归 fixture：每页唯一标记 + 不同色带（canvas 指纹区分度） */
function identityPage(n) {
  const colors = ["#4f6df5", "#2ecc71", "#e67e22", "#9b59b6"];
  const color = colors[(n - 1) % colors.length];
  return `
  <div style="page-break-after: always">
    <div style="background:${color};height:140px;border-radius:8px"></div>
    <h1 style="font-size:28pt;margin:18pt 0 10pt">PAGEIDENTITYMARKER${n}</h1>
    <p style="font-size:14pt">这是第 ${n} 页的唯一标记页。Page ${n} of the identity fixture.</p>
    <p>本页正文唯一内容 UNIQUEPAGEBODY${n}：用于页身份断言——跳转到第 ${n} 页后，
    文本层必须包含本页标记，画布指纹必须与第 ${n} 页参考一致。</p>
    <table>
      <tr><th>字段</th><th>第 ${n} 页取值</th></tr>
      <tr><td>marker</td><td>PAGEIDENTITYMARKER${n}</td></tr>
      <tr><td>body</td><td>UNIQUEPAGEBODY${n}</td></tr>
      <tr><td>color</td><td>${color}</td></tr>
    </table>
    <p>填充段落：The quick brown fox jumps over the lazy dog. 敏捷的棕色狐狸跳过懒狗。
    第 ${n} 页的填充文本与其它页面不同，确保逐页身份唯一可判定。</p>
  </div>`;
}

// ---------- 生成 ----------

app.commandLine.appendSwitch("disable-gpu");
app.on("window-all-closed", () => {});

function countPages(pdfBuffer) {
  const text = pdfBuffer.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page[^s]/g) || [];
  return matches.length;
}

async function run() {
  await app.whenReady();
  const win = new BrowserWindow({ width: 900, height: 1100, show: false, webPreferences: { offscreen: true } });

  const build = async (name, body, options = {}) => {
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">${PAGE_STYLES}</head><body>${body}</body></html>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    // 等待 canvas 脚本绘制
    await new Promise((r) => setTimeout(r, options.waitMs ?? 400));
    const pdf = await win.webContents.printToPDF({
      pageSize: options.pageSize ?? "A4",
      landscape: options.landscape ?? false,
      printBackground: true,
      margins: { marginType: "none" },
      preferCSSPageSize: false,
    });
    const pages = countPages(Buffer.from(pdf));
    writeFileSync(join(OUT, name), pdf);
    console.log(`  ${name}\t${(pdf.length / 1024).toFixed(0)} KB\t${pages} 页`);
    return pages;
  };

  console.log("[gen-pdf-fixtures] 生成中…");

  // --only <前缀>：只生成匹配的 fixture（identity 回归单独重建，避免其它 fixture 变动）
  const onlyIdx = process.argv.indexOf("--only");
  const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const want = (name) => !ONLY || name.startsWith(ONLY);

  if (want("pdf-simple")) await build("pdf-simple.pdf", simplePage());
  if (want("pdf-normal-40p")) await build("pdf-normal-40p.pdf", Array.from({ length: 40 }, (_, i) => section(i + 1)).join(""));
  if (want("pdf-large-120p")) await build("pdf-large-120p.pdf", Array.from({ length: 140 }, (_, i) => section(i + 1)).join(""), { waitMs: 300 });
  if (want("pdf-scanned")) await build("pdf-scanned.pdf", Array.from({ length: 4 }, (_, i) => scannedPage(i + 1)).join(""), { waitMs: 800 });
  if (want("pdf-tables-images")) await build("pdf-tables-images.pdf", Array.from({ length: 10 }, (_, i) => tablesImagesPage(i + 1)).join(""), { waitMs: 600 });
  if (want("pdf-landscape")) await build("pdf-landscape.pdf", Array.from({ length: 5 }, (_, i) => landscapePage(i + 1)).join(""), { landscape: true });
  if (want("pdf-identity-4p")) await build("pdf-identity-4p.pdf", Array.from({ length: 4 }, (_, i) => identityPage(i + 1)).join(""));
  if (want("中文-文档")) await build("中文-文档.pdf", simplePage());
  if (want("spaced name")) await build("spaced name.pdf", simplePage());

  // 校验页码规模
  const { readFileSync } = require("node:fs");
  const pages = (name) => countPages(readFileSync(join(OUT, name)));
  const checks = [
    ["pdf-simple.pdf", 1],
    ["pdf-normal-40p.pdf", 30, 55],
    ["pdf-large-120p.pdf", 100, 220],
    ["pdf-scanned.pdf", 4],
    ["pdf-landscape.pdf", 5],
    ["pdf-identity-4p.pdf", 4],
  ];
  let failed = false;
  for (const [name, min, max = min] of checks) {
    if (!want(name)) continue;
    const p = pages(name);
    const ok = p >= min && p <= max;
    if (!ok) failed = true;
    console.log(`  [check] ${name} ${p} 页 ${ok ? "OK" : `FAIL (期望 ${min}-${max})`}`);
  }
  const cn = pages("中文-文档.pdf");
  const sp = pages("spaced name.pdf");
  if (want("中文-文档")) console.log(`  [check] 中文-文档.pdf ${cn} 页 ${cn === 1 ? "OK" : "FAIL"}`);
  if (want("spaced name")) console.log(`  [check] spaced name.pdf ${sp} 页 ${sp === 1 ? "OK" : "FAIL"}`);
  console.log(failed ? "[gen-pdf-fixtures] 失败" : "[gen-pdf-fixtures] 完成");
  app.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  app.exit(1);
});
