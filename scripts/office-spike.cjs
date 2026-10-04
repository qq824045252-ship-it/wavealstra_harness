/**
 * Wave 1H — Office Spike（V3.5 §54-56）
 *
 * 决策问题：DOCX / PPTX / XLSX 各走哪条渲染路线？
 *
 * 实测（真实 BrowserWindow + 自定义协议 + CSP）：
 *   - DOCX: docx-preview（纯 JS 浏览器渲染）cold import + renderAsync 耗时
 *   - XLSX: SheetJS xlsx 解析耗时/行数/内存 + bundle
 *   - PPTX: jszip 解包可行性（slide 提取）
 *   - bundle: 各候选最小打包大小
 *   - LibreOffice 路线: 外部依赖检查（不预装则给出非自包含结论）
 *
 * 运行：
 *   node_modules/.bin/electron.cmd scripts/office-spike.cjs [--show]
 */
const { app, BrowserWindow, protocol, net } = require("electron");
const { join, normalize } = require("node:path");
const { build } = require("esbuild");
const { existsSync } = require("node:fs");

const args = process.argv.slice(2);
const show = args.includes("--show");
const TIMEOUT_MS = 120_000;
const root = join(__dirname, "..");

const results = [];
const errors = [];

protocol.registerSchemesAsPrivileged([
  { scheme: "spike", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

async function prebundle() {
  const outDir = join(root, "out", "spike-office");
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(outDir, { recursive: true });
  const entries = {
    "docx-preview": join(root, "node_modules", "docx-preview", "dist", "docx-preview.mjs"),
    xlsx: join(root, "node_modules", "xlsx", "xlsx.mjs"),
    jszip: join(root, "node_modules", "jszip", "dist", "jszip.min.js"),
  };
  const sizes = {};
  for (const [tag, entry] of Object.entries(entries)) {
    try {
      const r = await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        loader: { ".css": "empty" },
        alias: { jszip: join(root, "node_modules", "jszip", "dist", "jszip.min.js") },
      });
      writeFileSync(join(outDir, `${tag}.mjs`), r.outputFiles[0].contents);
      sizes[tag] = r.outputFiles[0].contents.length;
      console.log(`bundle ${tag}: ${(r.outputFiles[0].contents.length / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      console.log(`bundle ${tag} 失败: ${String(e?.errors?.[0]?.text ?? e?.message).slice(0, 150)}`);
    }
  }
  return sizes;
}

app.whenReady().then(async () => {
  protocol.handle("spike", async (request) => {
    const url = new URL(request.url);
    const rel = normalize(decodeURIComponent(url.pathname.replace(/^\//, "")));
    const file = join(root, rel);
    if (!file.startsWith(root)) return new Response("forbidden", { status: 403 });
    if (file.endsWith(".css")) return new Response("export default '';", { headers: { "content-type": "text/javascript" } });
    const resp = await net.fetch(require("node:url").pathToFileURL(file).toString());
    const mime = file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript"
      : file.endsWith(".json") ? "application/json"
      : file.endsWith(".html") ? "text/html"
      : null;
    if (mime) return new Response(resp.body, { status: resp.status, headers: { "content-type": mime } });
    return resp;
  });
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false },
  });

  win.webContents.on("console-message", (event) => {
    const line = String(event.message ?? "");
    const m = line.match(/^SPIKE\|(.*)$/);
    if (m) results.push(JSON.parse(m[1]));
    if (line.includes("ERROR|") || line.includes("Refused")) errors.push(line.slice(0, 300));
  });

  const timer = setTimeout(() => {
    console.log("SPIKE FATAL: timeout");
    app.exit(1);
  }, TIMEOUT_MS);

  try {
    await prebundle();
    await win.loadURL("spike://local/scripts/office-spike-page.html");

    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && !results.some((r) => r.kind === "done")) {
      await new Promise((r) => setTimeout(r, 250));
    }

    console.log("\n========== 1H Office Spike 结果 ==========");
    for (const r of results) {
      if (r.kind === "done") continue;
      console.log(`  ${r.name.padEnd(38)} ${r.value}`);
    }
    if (errors.length) {
      console.log("\n  页面错误:");
      for (const e of errors) console.log(`    ${e}`);
    }

    // LibreOffice 外部依赖检查
    const lo = ["C:\\Program Files\\LibreOffice\\program\\soffice.exe", "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe"];
    const loFound = lo.some((p) => existsSync(p));
    console.log(`\n  LibreOffice 本机安装: ${loFound ? "是" : "否（路线需外部二进制，非自包含）"}`);

    clearTimeout(timer);
    console.log("\nSPIKE DONE exit=0");
    app.exit(0);
  } catch (err) {
    console.error("SPIKE FAIL:", err);
    app.exit(1);
  }
});
