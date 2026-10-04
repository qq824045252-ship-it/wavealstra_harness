/**
 * CAD 安全链回归：native cad_* 工具不被误判为 MCP provider；
 * cad_execute / fcstd 导出按项目权限规范标 dangerous；注入 gate 模式隔离。
 */
import {
  parseMcpToolIdentity,
  getDefaultMcpSideEffectRegistry,
  McpSideEffectRegistry,
} from "../src/main/security/McpSideEffectPolicy";
import { isDangerousTool } from "../src/shared/pi-event-mapper";
import {
  MUTATING_BUILTIN_TOOLS,
  MYBUDDY_NATIVE_EXTENSION_TOOL_NAMES,
  NATIVE_CAPABILITY_TOOL_NAMES,
} from "../src/shared/native-tools";
import { shouldInjectCadExtension } from "../src/main/cad/cad-extension";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

console.log("== cad_* 不误判为 MCP provider ==");
for (const name of [
  "cad_open_freecad", "cad_route", "cad_plan", "cad_techdraw",
  "cad_fcstd_readback", "cad_freecad_run",
]) {
  assert(parseMcpToolIdentity(name) === null, `${name} → native（parseMcpToolIdentity null）`);
}
assert(parseMcpToolIdentity("read") === null, "read → builtin");
assert(parseMcpToolIdentity("bash") === null, "bash → builtin");
assert(parseMcpToolIdentity("mcp") === null, "mcp 代理工具本身不按业务 MCP 门禁");

console.log("== MyBuddy 原生能力工具不误判为 MCP provider ==");
for (const name of NATIVE_CAPABILITY_TOOL_NAMES) {
  assert(parseMcpToolIdentity(name) === null, `${name} → native（parseMcpToolIdentity null）`);
}
assert(parseMcpToolIdentity("web_search") === null, "web_search → native（联网搜索不再触发 MCP 审批）");
assert(parseMcpToolIdentity("powershell") === null, "powershell → Pi builtin（不触发 MCP 审批）");
for (const name of MYBUDDY_NATIVE_EXTENSION_TOOL_NAMES) {
  assert(parseMcpToolIdentity(name) === null, `${name} -> MyBuddy native extension`);
}
for (const [toolName, providerId] of [
  ["memory_write_file", "memory"],
  ["project_delete_file", "project"],
  ["library_create_remote", "library"],
  ["conversation_custom_action", "conversation"],
] as const) {
  const identity = parseMcpToolIdentity(toolName);
  assert(identity?.providerId === providerId, `${toolName} remains MCP (prefix must not grant native bypass)`);
}
for (const name of MUTATING_BUILTIN_TOOLS) {
  assert(parseMcpToolIdentity(name) === null, `${name} → native（写类工具避免双重审批）`);
}
{
  const id = parseMcpToolIdentity("mcp__freecad_open_file");
  assert(id?.providerId === "freecad" && id.shortToolName === "open_file", "mcp__freecad_open_file → freecad/open_file");
}
{
  const id = parseMcpToolIdentity("mcp__drawio_ai_search_diagrams");
  assert(id?.providerId === "drawio-ai" && id.shortToolName === "search_diagrams", "mcp__drawio_ai_search_diagrams -> drawio-ai/search_diagrams");
}
{
  const id = parseMcpToolIdentity("mcp__my_server_search_items", ["my-server"]);
  assert(id?.providerId === "my-server" && id.shortToolName === "search_items", "session provider ids disambiguate custom hyphenated MCP servers");
}
{
  const id = parseMcpToolIdentity("serena_doc_query");
  assert(id?.providerId === "serena" && id.shortToolName === "doc_query", "serena_doc_query → serena/doc_query");
}

console.log("== MCP 副作用门禁不拦截 cad_* ==");
{
  // 模拟 McpSideEffectExtension 的判定入口：cad_* 必须被 parseMcpToolIdentity 放行，
  // 从而完全绕过 evaluateToolCall（不会出现 unknown MCP provider 审批）
  const registry = new McpSideEffectRegistry();
  registry.registerPolicy({
    providerId: "freecad",
    localFileAccess: "unknown",
    externalMutation: true,
    supportsRoots: false,
    requiresApproval: true,
  });
  for (const name of ["cad_techdraw", "cad_fcstd_readback", "cad_freecad_run"]) {
    const identity = parseMcpToolIdentity(name);
    assert(identity === null, `${name} 不触发 MCP 审批（identity=null）`);
  }
  const decision = registry.evaluateToolCall({
    providerId: "freecad",
    toolName: "open_file",
    args: { path: "C:/x/y.step" },
  });
  assert(decision.requiresApproval === true, "真实 MCP 工具仍按策略审批（不受 cad_* 影响）");
}

console.log("== dangerous 标注 ==");
assert(isDangerousTool("cad_freecad_run", { script: "print(1)" }) === true, "cad_freecad_run 恒 dangerous（逃生通道）");
assert(isDangerousTool("cad_techdraw", { step_file: "x.step" }) === false, "cad_techdraw 非 dangerous（不误审批）");
assert(isDangerousTool("cad_fcstd_readback", { fcstd_file: "x.fcstd" }) === false, "cad_fcstd_readback 非 dangerous（不误审批）");
assert(isDangerousTool("cad_plan", { goal: "x" }) === false, "cad_plan 非 dangerous（不误审批）");

console.log("== 注入 gate（模式隔离）==");
assert(shouldInjectCadExtension("design", "mechanical-cad") === true, "design + mechanical-cad → 注入");
assert(shouldInjectCadExtension("design", "ai-ui") === false, "design + ai-ui → 不注入");
assert(shouldInjectCadExtension("design", "3d-blender") === false, "design + 3d-blender → 不注入");
assert(shouldInjectCadExtension("design", "general") === false, "design + general → 不注入");
assert(shouldInjectCadExtension("design", null) === false, "design 无 preset → 不注入");
assert(shouldInjectCadExtension("coding", "mechanical-cad") === false, "coding + mechanical-cad → 不注入");
assert(shouldInjectCadExtension("working", "mechanical-cad") === false, "working → 不注入");

console.log("\n结果: passed=%d failed=%d", passed, failed);
if (failed > 0) process.exit(1);
