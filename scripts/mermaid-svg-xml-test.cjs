const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { app, BrowserWindow } = require("electron");

const repo = resolve(__dirname, "..");
const bundle = join(repo, "out", "tests", "mermaid-image.js");
const root = mkdtempSync(join(tmpdir(), "mermaid-image-"));
const probe = `
window.__result = { state: "running" };
(async () => {
  const cases = {
    br: ["flowchart TD", "  A[alpha<br/>beta] --> B[gamma]", "  B --> C[done]"].join("\\n"),
    plain: ["flowchart TD", "  A[alpha] --> B[beta]"].join("\\n")
  };
  const load = url => new Promise(done => {
    const image = new Image();
    image.onload = () => done({ ok: true, width: image.naturalWidth });
    image.onerror = () => done({ ok: false, width: 0 });
    image.src = url;
  });
  const out = {};
  for (const [name, source] of Object.entries(cases)) {
    const raw = await MermaidProbe.renderRaw(source);
    const url = await MermaidProbe.renderMermaidImage(source);
    out[name] = {
      rawXml: MermaidProbe.isValidXml(raw), bareBr: /<br\\s*>/i.test(raw),
      rawImage: await load("data:image/svg+xml," + encodeURIComponent(raw)),
      productUrl: url.startsWith("data:image/svg+xml,"),
      productImage: await load(url)
    };
  }
  out.attribute = {
    closed: MermaidProbe.closeVoidElements('<p><br title="1 > 0"><img alt="a > b"></p>'),
    already: MermaidProbe.closeVoidElements('<p><br/><col span="1"></p>'),
    unrelated: MermaidProbe.closeVoidElements('<p><brs><image href="x"/></p>')
  };
  window.__result = { state: "done", out };
})().catch(error => { window.__result = { state: "error", error: String(error && error.stack || error) }; });
`;
writeFileSync(join(root, "probe.js"), probe);
writeFileSync(join(root, "index.html"), `<!doctype html><meta charset="utf-8"><div id="host"></div>
<script src="file:///${bundle.replace(/\\/g, "/")}"></script>
<script src="./probe.js"></script>`);

app.commandLine.appendSwitch("no-sandbox");
app.on("window-all-closed", () => {});
const guard = setTimeout(() => { console.error("mermaid image test timed out"); app.exit(1); }, 60_000);

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { webSecurity: false, contextIsolation: false, nodeIntegration: false } });
  try {
    await win.loadFile(join(root, "index.html"));
    let result;
    for (let tick = 0; tick < 120; tick++) {
      result = JSON.parse(await win.webContents.executeJavaScript("JSON.stringify(window.__result || null)"));
      if (result && result.state !== "running") break;
      await new Promise(done => setTimeout(done, 500));
    }
    assert.equal(result.state, "done", result.error);
    assert.equal(result.out.br.bareBr, true, "fixture must reproduce an unclosed <br>");
    assert.equal(result.out.br.rawXml, false, "the raw SVG must be malformed XML");
    assert.equal(result.out.br.rawImage.ok, false, "the raw SVG must fail to decode as an image");
    assert.equal(result.out.br.productUrl, true, "renderMermaidImage must return a data URL");
    assert.equal(result.out.br.productImage.ok, true, "the shipped render must decode as an image");
    assert.ok(result.out.br.productImage.width > 0, "the shipped render needs a real width");
    assert.equal(result.out.plain.productImage.ok, true, "graphs without void elements must keep working");
    assert.equal(result.out.attribute.closed, '<p><br title="1 > 0"/><img alt="a > b"/></p>', "quoted attributes must survive");
    assert.equal(result.out.attribute.already, '<p><br/><col span="1"/></p>', "self-closed tags stay idempotent");
    assert.equal(result.out.attribute.unrelated, '<p><brs><image href="x"/></p>', "non-void tags must not be touched");
    console.log("mermaid image: ok");
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
