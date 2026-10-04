// 查 MyBuddy 运行时 MCP 状态（awaitPromise 版）
import WebSocket from "ws";
import http from "node:http";

const targets = await new Promise((resolve, reject) => {
  http.get("http://127.0.0.1:9223/json/list", (res) => {
    let d = "";
    res.on("data", (c) => (d += c));
    res.on("end", () => resolve(JSON.parse(d)));
  }).on("error", reject);
});
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
await new Promise((r) => ws.on("open", r));
async function evalJs(expr) {
  const mid = ++id;
  const p = new Promise((res) => pending.set(mid, res));
  ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  const msg = await Promise.race([p, new Promise((r2) => setTimeout(() => r2("TIMEOUT"), 6000))]);
  if (msg === "TIMEOUT") return "TIMEOUT";
  if (msg.result?.exceptionDetails) return "EXC " + (msg.result.exceptionDetails.exception?.description ?? msg.result.exceptionDetails.text);
  return msg.result?.result?.value ?? "?";
}

console.log("=== 1. MCP 状态快照 ===");
console.log(await evalJs(`window.api.mcp.status().then(s => JSON.stringify({ total: s?.servers?.length ?? -1, servers: (s?.servers || []).map(x => x.name + ':' + x.status) })).catch(e => 'ERR ' + e.message)`));

console.log("\n=== 2. listServers ===");
console.log(await evalJs(`window.api.mcp.listServers().then(x => JSON.stringify((x || []).map(s => s.name))).catch(e => 'ERR ' + e.message)`));
process.exit(0);
