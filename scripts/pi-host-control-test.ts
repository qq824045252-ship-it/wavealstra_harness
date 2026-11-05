import assert from "node:assert/strict";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { createMcpSideEffectExtension } from "../src/main/agent/mcp-side-effect-extension";
import { createPermissionExtension } from "../src/main/agent/permission-extension";
import { BUILTIN_TOOL_NAMES } from "../src/main/security/McpSideEffectPolicy";

// Fault injection is confined to in-memory product records. No user profile or external tools.
const results: Array<{ name: string; passed: boolean; error?: string }> = [];
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); console.error(`FAIL ${name}: ${error}`); }
}
const source = (name: string) => readFileSync(name, "utf8");
const context = { taskId: "host-exit-test", executionId: "exec", assistantMessageId: "reply" };

await test("every Pi builtin exits before host context, permission or approval reads", async () => {
  const handlers: Array<(event: any) => any> = [];
  const api: any = { on(name: string, callback: any) { if (name === "tool_call") handlers.push(callback); }, registerTool() {} };
  const forbidden = () => { throw Error("native tool unexpectedly consulted host policy"); };
  createConversationRuntimeExtension({ resolveContext: forbidden } as any)(api);
  createPermissionExtension({ getPermissionMode: forbidden, requestApproval: forbidden })(api);
  for (const toolName of BUILTIN_TOOL_NAMES) for (const handler of handlers)
    assert.equal(await handler({ toolName, toolCallId: "native-" + toolName, input: {} }), undefined, toolName);
});
await test("delete the MCP lifecycle callback, including its assembler and interface", () => {
  for (const file of ["AgentService.ts", "SessionExtensionAssembler.ts", "mcp-side-effect-extension.ts"])
    assert(!/preflightSideEffectGate|lifecycleBlockReason|Plan has not entered executing/.test(source(`src/main/agent/${file}`)), file);
});
await test("delete background search completion wakeups, not just lower their retry count", () => {
  const s = source("src/main/capabilities/web-access/index.ts");
  assert(!/startBackgroundFetch|web-search-content-ready|pendingFetches|sessionActive/.test(s));
  assert(!/Content fetching in background/.test(s));
});
await test("status and configuration commands never enqueue a model turn", () => {
  const s = source("src/main/capabilities/web-access/index.ts");
  const start = s.indexOf('pi.registerCommand("curator"');
  const end = s.indexOf('pi.registerCommand("search"', start);
  assert(start > 0 && end > start);
  assert(!/pi\.sendMessage|triggerTurn|deliverAs/.test(s.slice(start, end)));
});
await test("curator timeout does not masquerade as user submission", () => {
  const s = source("src/main/capabilities/web-access/index.ts");
  const start = s.indexOf('pi.registerCommand("websearch"');
  const tail = s.slice(start);
  const cancel = tail.slice(tail.indexOf("onCancel(reason)"), tail.indexOf("onCancel(reason)") + 1500);
  assert(!/sendFollowUpFromReturn|publishUserSelectedSearch/.test(cancel));
});

async function hookResult(toolName: string, permission: "auto" | "readonly" | "default" = "auto", approved = true) {
  const handlers: Array<(event: any) => any> = [];
  let approvalRequests = 0;
  const api: any = {
    on(name: string, handler: any) { if (name === "tool_call") handlers.push(handler); }, registerTool() {},
    getAllTools: () => [{ name: "fixture_list_records", annotations: { readOnlyHint: true } }],
  };
  createConversationRuntimeExtension({ resolveContext: () => context } as any)(api);
  createMcpSideEffectExtension({ taskId: context.taskId, taskRoot: resolve("out/host-control-fixture"), providerIds: ["fixture"],
    getPermissionMode: () => permission, requestApproval: async () => { approvalRequests++; return approved; },
  })(api);
  let blocked;
  for (const handler of handlers) {
    const result = await handler({ toolCallId: "fixture-call", toolName, input: { id: "fixture-only" } });
    if (result?.block) { blocked = result; break; }
  }
  return { blocked, approvalRequests };
}
await test("MCP mutation remains available with full access", async () => {
  const result = await hookResult("fixture_update_record");
  assert.equal(result.blocked, undefined); assert.equal(result.approvalRequests, 0);
});
await test("readonly permission still blocks an MCP mutation", async () => {
  const result = await hookResult("fixture_update_record", "readonly");
  assert(result.blocked?.block); assert.equal(result.approvalRequests, 0);
});
await test("annotated readonly MCP reads remain available without mutation approval", async () => {
  const result = await hookResult("fixture_list_records", "readonly");
  assert.equal(result.blocked, undefined); assert.equal(result.approvalRequests, 0);
});
await test("refused MCP permission prevents the actual call", async () => {
  const result = await hookResult("fixture_update_record", "default", false);
  assert(result.blocked?.block); assert.equal(result.approvalRequests, 1);
});
await test("explicit MCP permission authorizes the actual call", async () => {
  const result = await hookResult("fixture_update_record", "default", true);
  assert.equal(result.blocked, undefined); assert.equal(result.approvalRequests, 1);
});
mkdirSync("artifacts/pi-host-exit", { recursive: true });
const passed = results.every(r => r.passed);
writeFileSync("artifacts/pi-host-exit/contract-results.json", JSON.stringify({ at: new Date().toISOString(), passed, results }, null, 2));
process.exitCode = passed ? 0 : 1;
