// 抓主窗口：画布占位 rect + 全窗口截图（含 WebContentsView 叠加）
import WebSocket from "ws";
import http from "node:http";
import { writeFileSync } from "node:fs";

const targets = await new Promise((resolve, reject) => {
  http.get("http://127.0.0.1:9223/json/list", (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve(JSON.parse(d)));
  }).on("error", reject);
});
const page = targets.find((t) => t.type === "page");
if (!page) { console.log("no page"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((r) => ws.on("open", r));
async function send(method, params = {}) {
  const mid = ++id;
  const p = new Promise((res) => pending.set(mid, res));
  ws.send(JSON.stringify({ id: mid, method, params }));
  const msg = await Promise.race([p, new Promise((r2) => setTimeout(() => r2("TIMEOUT"), 5000))]);
  return msg === "TIMEOUT" ? undefined : msg.result;
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r?.result?.value ?? r?.exceptionDetails?.text ?? "?";
}
await send("Runtime.enable");
await send("Page.enable");

console.log("=== 主窗口状态 ===");
console.log(await evalJs(`JSON.stringify({
  panelOpen: !!document.querySelector('.artifact-panel, .extension-body'),
  wcvHost: !!document.querySelector('.browser-wcv-host'),
  wcvHostRect: (() => { const el = document.querySelector('.browser-wcv-host'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
  iframes: [...document.querySelectorAll('iframe')].map(f => (f.getAttribute('src')||'').slice(0, 60)),
  windowSize: window.innerWidth + 'x' + window.innerHeight,
  bodyText: document.body.innerText.slice(0, 60)
})`));

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  writeFileSync("C:/Users/servi/Desktop/mybuddy/main-window-probe.png", Buffer.from(shot.data, "base64"));
  console.log("主窗口截图: main-window-probe.png");
}
process.exit(0);
