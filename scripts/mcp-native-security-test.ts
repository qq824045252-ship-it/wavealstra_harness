import assert from "node:assert/strict";
import {
  classifyMcpToolCall,
  getDefaultMcpSideEffectRegistry,
  parseMcpToolIdentity,
} from "../src/main/security/McpSideEffectPolicy";

const providers = ["filesystem", "drawio-ai", "freecad"];

assert.deepEqual(
  parseMcpToolIdentity("mcp__filesystem__write_file", providers),
  { providerId: "filesystem", shortToolName: "write_file" },
);
assert.deepEqual(
  parseMcpToolIdentity("mcp__drawio-ai__create_diagram", providers),
  { providerId: "drawio-ai", shortToolName: "create_diagram" },
);
assert.deepEqual(
  parseMcpToolIdentity("mcp__freecad__execute_python", providers),
  { providerId: "freecad", shortToolName: "execute_python" },
);

// Keep the legacy adapter naming contract working until the headless Hub runtime is migrated.
assert.deepEqual(
  parseMcpToolIdentity("mcp__drawio_ai_create_diagram", providers),
  { providerId: "drawio-ai", shortToolName: "create_diagram" },
);

const registry = getDefaultMcpSideEffectRegistry();
const write = classifyMcpToolCall(
  "mcp__filesystem__write_file",
  { path: "C:\\tmp\\x.txt", content: "x" },
  providers,
  registry,
);
assert(write);
assert.equal(write.identity.providerId, "filesystem");
assert.equal(write.identity.shortToolName, "write_file");
assert.equal(write.decision.isLocalWrite, true);
assert.equal(write.sideEffect, true);

const dangerous = classifyMcpToolCall(
  "mcp__freecad__execute_python",
  { code: "print(1)" },
  providers,
  registry,
);
assert(dangerous);
assert.equal(dangerous.identity.providerId, "freecad");
assert.equal(dangerous.identity.shortToolName, "execute_python");
assert.equal(dangerous.dangerous, true);
assert.equal(dangerous.sideEffect, true);

console.log("mcp-native-security-test: PASS");
