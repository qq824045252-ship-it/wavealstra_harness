/**
 * McpModeFilter 单测：A 黑名单 / B 白名单 / entry.modes
 */
import { filterMcpConfigForMode } from "../src/main/mcp/McpModeFilter";
import type { McpConfig } from "../src/main/mcp/McpConfigService";

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

const full: McpConfig = {
  mcpServers: {
    serena: {
      command: "serena",
      args: ["start-mcp-server"],
      modes: ["coding"],
    },
    codegraph: {
      command: "codegraph",
      args: ["serve", "--mcp"],
      modes: ["coding"],
    },
    weather: {
      command: "npx",
      args: ["weather-mcp"],
    },
    off: {
      command: "x",
      disabled: true,
    },
  },
};

console.log("1. working hard deny A");
{
  const r = filterMcpConfigForMode(full, "working", {
    mode: "hard",
    allow: [],
    deny: ["serena", "codegraph"],
  });
  assert(!r.config.mcpServers.serena, "working 无 serena");
  assert(!r.config.mcpServers.codegraph, "working 无 codegraph");
  assert(!!r.config.mcpServers.weather, "working 仍有 weather");
  assert(!r.config.mcpServers.off, "disabled 剔除");
  assert(r.hidden.includes("serena") && r.hidden.includes("codegraph"), "hidden 含 coding 工具");
  assert(
    r.capabilities.find((item) => item.id === "serena")?.enabled === false,
    "真实 MCP filter 同时产出 disabled capability decision",
  );
}

console.log("2. coding 全量（entry.modes 放行）");
{
  const r = filterMcpConfigForMode(full, "coding", {
    mode: "hard",
    allow: [],
    deny: [],
  });
  assert(!!r.config.mcpServers.serena, "coding 有 serena");
  assert(!!r.config.mcpServers.codegraph, "coding 有 codegraph");
  assert(!!r.config.mcpServers.weather, "coding 有 weather");
}

console.log("3. design entry.modes  alone");
{
  const r = filterMcpConfigForMode(full, "bot", {
    mode: "hard",
    allow: [],
    deny: [],
  });
  assert(!r.config.mcpServers.serena, "design 因 modes 无 serena");
  assert(!!r.config.mcpServers.weather, "design 仍有通用 weather");
}

console.log("4. B 白名单");
{
  const r = filterMcpConfigForMode(full, "working", {
    mode: "hard",
    allow: ["weather"],
    deny: [],
  });
  assert(!!r.config.mcpServers.weather, "allow 命中 weather");
  assert(!r.config.mcpServers.serena, "白名单外 serena 剔除");
  assert(!r.config.mcpServers.codegraph, "白名单外 codegraph 剔除");
}

console.log("5. soft 不剔除");
{
  const r = filterMcpConfigForMode(full, "working", {
    mode: "soft",
    allow: [],
    deny: ["serena"],
  });
  assert(!!r.config.mcpServers.serena, "soft 仍加载 serena");
  assert(r.hidden.includes("serena"), "soft 仍记录 hidden");
  assert(
    r.capabilities.find((item) => item.id === "serena")?.enabled === true &&
      r.capabilities.find((item) => item.id === "serena")?.reason?.endsWith("_soft"),
    "soft MCP trace 解释限制但与真实执行一致保持 enabled",
  );
}

console.log("6. Penpot 旧模式声明迁入日常办公");
for (const modes of [["design"], ["bot"], "design", "bot", ["coding", "design"]]) {
  const config = { mcpServers: { penpot: { url: "http://localhost:9001", modes } } };
  const allowed = filterMcpConfigForMode(config, "working", { mode: "hard", allow: ["penpot"], deny: [] });
  assert(allowed.enabled.includes("penpot"), `旧声明 ${JSON.stringify(modes)} 在办公可用`);
  const denied = filterMcpConfigForMode(config, "working", { mode: "hard", allow: [], deny: ["penpot"] });
  assert(!denied.enabled.includes("penpot"), "迁移不绕过办公显式禁用");
  const disabled = filterMcpConfigForMode({ mcpServers: { penpot: { ...config.mcpServers.penpot, disabled: true } } }, "working");
  assert(!disabled.enabled.includes("penpot"), "迁移不绕过 MCP 全局停用");
}

console.log(`\n[mcp-mode-filter-test] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
