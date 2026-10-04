// 综合诊断：iframe 状态 + token 注入验证 + 请求头 + 渲染内容
import WebSocket from "ws";
import http from "node:http";
import { writeFileSync } from "node:fs";

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}
const targets = await getJson("http://127.0.0.1:9223/json/list");
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

const ardotReqs = [];
const failed = [];
const consoleLogs = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === "Network.requestWillBeSent") {
    const r = msg.params.request;
    if (r.url.includes("ardot.tencent.com")) {
      const auth = r.headers?.Authorization || r.headers?.authorization || "(无 Authorization)";
      ardotReqs.push(`${r.method} ${r.url.slice(0, 90)} | auth=${String(auth).slice(0, 40)}`);
    }
  }
  if (msg.method === "Network.responseReceived" && msg.params.response.status >= 400) {
    failed.push(`${msg.params.response.status} ${msg.params.response.url.slice(0, 110)}`);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    const t = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 180);
    consoleLogs.push(t);
  }
});
await send("Runtime.enable");
await send("Network.enable");
await send("Page.enable");

async function send(method, params = {}) {
  const mid = ++id;
  const p = new Promise((res) => pending.set(mid, res));
  ws.send(JSON.stringify({ id: mid, method, params }));
  const msg = await Promise.race([p, new Promise((r2) => setTimeout(() => r2("TIMEOUT"), 4000))]);
  return msg === "TIMEOUT" ? undefined : msg.result;
}
async function evalJs(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
  return r?.result?.value ?? r?.exceptionDetails?.text ?? "(undefined)";
}

console.log("=== 1. 主页面概览 ===");
console.log(await evalJs(`JSON.stringify({
  iframes: [...document.querySelectorAll('iframe')].map(f => (f.getAttribute('src')||'').slice(0,90)),
  browserView: !!document.querySelector('.browser-view'),
  panelModeHint: !!document.querySelector('.browser-iframe'),
  bodyText: document.body.innerText.slice(0, 100)
})`));

console.log("\n=== 2. frame tree ===");
const { frameTree } = await send("Page.getFrameTree") ?? {};
(function walk(node, d = 0) {
  if (!node) return;
  console.log(`${" ".repeat(d)}${(node.frame.url || "").slice(0, 110)}`);
  for (const c of node.childFrames ?? []) walk(c, d + 1);
})(frameTree);

// 找 ardot frame
let ardotFrame = null;
(function find(node) {
  if (!node) return;
  if (!ardotFrame && (node.frame.url || "").includes("ardot.tencent.com")) ardotFrame = node.frame;
  for (const c of node.childFrames ?? []) find(c);
})(frameTree);

if (ardotFrame) {
  console.log("\n=== 3. ardot frame 内容 ===");
  const world = await send("Page.createIsolatedWorld", { frameId: ardotFrame.id, worldName: "probe" });
  const r = await send("Runtime.evaluate", {
    expression: `JSON.stringify({ url: location.href, title: document.title, body: (document.body ? document.body.innerText.slice(0, 250) : '(no body)'), canvas: document.querySelectorAll('canvas').length, root: document.getElementById('root') ? document.getElementById('root').childElementCount : -1 })`,
    contextId: world.executionContextId, returnByValue: true,
  });
  console.log(r?.result?.value ?? r?.exceptionDetails?.text ?? "?");
} else {
  console.log("\n=== 3. 无 ardot frame ===");
}

// 触发一次画布请求看链路
console.log("\n=== 4. 触发 requestArdotCanvas ===");
const rr = await evalJs(`window.api.mcp.requestArdotCanvas().then(x => JSON.stringify(x)).catch(e => 'ERR ' + e.message)`);
console.log("result:", rr);
await new Promise((r2) => setTimeout(r2, 3000));

console.log("\n=== 5. 触发后 ardot 请求（验证 Authorization 注入）===");
for (const r of ardotReqs.slice(0, 12)) console.log(r);
console.log("\n=== 6. 4xx/5xx ===");
console.log(failed.slice(0, 10).join("\n") || "(无)");
console.log("\n=== 7. console error ===");
console.log(consoleLogs.slice(0, 8).join("\n") || "(无)");

const shot = await send("Page.captureScreenshot", { format: "png" });
if (shot?.data) {
  writeFileSync("C:/Users/servi/Desktop/mybuddy/ardot-final-probe.png", Buffer.from(shot.data, "base64"));
  console.log("\n截图: ardot-final-probe.png");
}
process.exit(0);
