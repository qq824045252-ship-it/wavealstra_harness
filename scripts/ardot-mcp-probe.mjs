// 验证本地 Ardot MCP：握手 + 工具列表（SSE 解析）
const res = await fetch("http://127.0.0.1:50501/api/v1/mcp", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
});
const text = await res.text();
console.log("HTTP", res.status);
// SSE: 每个消息 "data: {...}"，取最后一条 data 并解析
const parts = text.split("\ndata: ");
const last = parts[parts.length - 1].trim();
try {
  const msg = JSON.parse(last);
  const tools = msg.result?.tools ?? [];
  console.log("工具数量:", tools.length);
  for (const t of tools) console.log(" -", t.name);
} catch (e) {
  console.log("解析失败:", e.message);
  console.log(text.slice(0, 600));
}
