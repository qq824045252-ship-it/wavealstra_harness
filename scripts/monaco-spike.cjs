/**
 * Wave 1G — Monaco Spike（V3.5 §53）
 *
 * 决策问题：MyBuddy 什么时候值得从"代码预览"升级成"真正编辑器"？
 *
 * 独立最小 harness：真实 BrowserWindow 加载本地页面，动态 import
 * monaco-editor ESM（lazy load），实测：
 *   - cold import 耗时（ESM 加载）
 *   - editor.create 首实例耗时
 *   - 本地 ESM worker 加载（CSP worker-src 策略下）
 *   - 大文件 100KB / 1MB / 5MB（createModel + 渲染）
 *   - 多实例（5 个 editor）
 *   - dispose 后 renderer 内存回收（webContents.getProcessMemoryInfo）
 *   - bundle 增量（esbuild 最小打包 editor.api）
 *
 * 运行：
 *   node_modules/.bin/electron.cmd scripts/monaco-spike.cjs [--show] [--csp-off]
 * 退出码：完成 0；页面错误 1；超时 1（120s 保护）。
 */
const { app, BrowserWindow, protocol, net } = require("electron");
const { join, normalize } = require("node:path");
const { build } = require("esbuild");

// 自定义协议 spike://local/* → 项目根目录（模拟生产 renderer 资源协议）
protocol.registerSchemesAsPrivileged([
  { scheme: "spike", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const args = process.argv.slice(2);
const show = args.includes("--show");
const cspOff = args.includes("--csp-off");
const TIMEOUT_MS = 120_000;

const results = [];
const errors = [];

function collect(line) {
  const m = String(line).match(/^SPIKE\|(.*)$/);
  if (m) results.push(JSON.parse(m[1]));
}

app.whenReady().then(async () => {
  const root = join(__dirname, "..");
  protocol.handle("spike", async (request) => {
    const url = new URL(request.url);
    const rel = normalize(decodeURIComponent(url.pathname.replace(/^\//, "")));
    const file = join(root, rel);
    if (!file.startsWith(root)) return new Response("forbidden", { status: 403 });
    if (file.endsWith(".css")) {
      // monaco ESM 含 import './x.css'：bundler 语义 = 空 JS 模块（样式注入由 vite 处理）
      return new Response("export default '';", { headers: { "content-type": "text/javascript" } });
    }
    const resp = await net.fetch(require("node:url").pathToFileURL(file).toString());
    // Electron net.fetch 对 file:// 的 mime 推断在部分平台失效；JS/JSON 显式修复
    const mime = file.endsWith(".js") || file.endsWith(".mjs") ? "text/javascript"
      : file.endsWith(".json") ? "application/json"
      : file.endsWith(".html") ? "text/html"
      : file.endsWith(".wasm") ? "application/wasm"
      : null;
    if (mime) {
      return new Response(resp.body, {
        status: resp.status,
        headers: { "content-type": mime },
      });
    }
    return resp;
  });
  // 管道场景（bash 管道消费 stdout）下 electron 写日志可能 EPIPE，忽略即可
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});

  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    show,
    webPreferences: { sandbox: false, contextIsolation: false, nodeIntegration: false },
  });

  win.webContents.on("did-fail-load", (e, code, desc, url) => {
    console.log("[did-fail-load]", code, desc, String(url).slice(0, 80));
  });

  win.webContents.on("console-message", (event) => {
    const line = String(event.message ?? "");
    if (line.includes("SPIKE|")) collect(line);
    if (line.includes("ERROR|") || line.includes("CSP") || line.includes("Refused") || line.includes("Failed to load module")) {
      errors.push(line.slice(0, 300));
    }
  });

  const timer = setTimeout(() => {
    console.log("SPIKE FATAL: timeout");
    if (errors.length) {
      console.log("收集到的页面错误:");
      for (const e of errors) console.log("  " + e);
    }
    app.exit(1);
  }, TIMEOUT_MS);

  try {
    await win.loadURL("spike://local/scripts/monaco-spike-page.html" + (cspOff ? "?csp=off" : ""));

    // 等待页面完成（页面 console 输出 SPIKE|done）
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline && !results.some((r) => r.kind === "done")) {
      await new Promise((r) => setTimeout(r, 250));
    }

    const metrics = app.getAppMetrics();
    const renderer = metrics.find((m) => m.type === "Renderer");
    const rmem = renderer?.memory;
    console.log(`  renderer workingSet: ${rmem ? (rmem.workingSetSize / 1024).toFixed(1) : "n/a"} MB (peak ${rmem ? (rmem.peakWorkingSetSize / 1024).toFixed(1) : "n/a"} MB)`);

    console.log("\n========== 1G Monaco Spike 结果 ==========");
    for (const r of results) {
      if (r.kind === "done") continue;
      console.log(`  ${r.name.padEnd(34)} ${r.value}`);
    }
    console.log(`  renderer workingSet: ${rmem ? (rmem.workingSetSize / 1024).toFixed(1) : "n/a"} MB (peak ${rmem ? (rmem.peakWorkingSetSize / 1024).toFixed(1) : "n/a"} MB)`);
    if (errors.length) {
      console.log("\n  CSP/页面错误:");
      for (const e of errors) console.log(`    ${e}`);
    }

    // bundle 增量
    try {
      const tmp = join(require("node:os").tmpdir(), `monaco-bundle-${Date.now()}`);
      const entry = join(__dirname, "..", "node_modules", "monaco-editor", "esm", "vs", "editor", "editor.api.js");
      const r = await build({
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        write: false,
        logLevel: "silent",
        loader: { ".css": "empty", ".ttf": "empty", ".woff": "empty", ".woff2": "empty" },
      });
      const bytes = r.outputFiles[0].contents.length;
      console.log(`\n  bundle(editor.api 全量): ${(bytes / 1024 / 1024).toFixed(2)} MB`);
    } catch (e) {
      const detail = e?.errors?.[0]?.text ?? e?.message ?? String(e);
      console.log(`  bundle 检查失败: ${String(detail).slice(0, 200)}`);
    }

    clearTimeout(timer);
    console.log("\nSPIKE DONE exit=0");
    app.exit(0);
  } catch (err) {
    console.error("SPIKE FAIL:", err);
    app.exit(1);
  }
});
