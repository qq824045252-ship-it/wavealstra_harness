import assert from "node:assert/strict";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

const cwd = process.cwd();
const agentDir = getAgentDir();
const settingsManager = SettingsManager.create(cwd, agentDir);
const serverPath = resolve(cwd, "scripts", "pi099-native-mcp-smoke-server.mjs");

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  settingsManager,
  noExtensions: true,
  extensionFactories: [
    createCodemodeExtension({ mode: "on" }),
    createToolSearchExtension(),
    createMcpExtension({
      loadConfig: () => ({
        servers: [{
          name: "smoke",
          config: {
            type: "stdio",
            command: process.execPath,
            args: [serverPath],
            exposure: "codemode",
            enabled: true,
          },
          source: "mybuddy:pi099-smoke",
          scope: "extension",
        }],
        autoEnableCodemode: true,
        errors: [],
      }),
    }),
  ],
});
await loader.reload();

const { session } = await createAgentSession({
  cwd,
  agentDir,
  settingsManager,
  sessionManager: SessionManager.inMemory(),
  resourceLoader: loader,
});

try {
  await session.bindExtensions({});
  const deadline = Date.now() + 10_000;
  let tool;
  while (Date.now() < deadline) {
    tool = session.getToolDefinition("mcp__smoke__echo");
    if (tool) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert(tool, "Pi 0.99 native MCP tool did not register");

  const result = await tool.execute(
    "native-smoke-call",
    { value: "pi-0.99.1-native-mcp-ok" },
    undefined,
    undefined,
    { hasUI: false } as never,
  ) as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown };

  assert.equal(result.content?.[0]?.type, "text");
  assert.equal(result.content?.[0]?.text, "pi-0.99.1-native-mcp-ok");
  assert.deepEqual(result.structuredContent, {
    content: [{ type: "text", text: "pi-0.99.1-native-mcp-ok" }],
    structuredContent: { value: "pi-0.99.1-native-mcp-ok" },
  });
  assert(session.getCallableToolNames().includes("mcp__smoke__echo"));
  assert(!session.getActiveToolNames().includes("mcp__smoke__echo"));
  assert(session.getActiveToolNames().includes("codemode"));
  console.log("pi099-native-mcp-smoke: PASS");
} finally {
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session.dispose();
}
