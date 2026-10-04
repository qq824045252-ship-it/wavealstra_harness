/**
 * MCP 黑白名单：用出厂 mode policy + 模拟 mcpServers 做端到端过滤核对
 *（不启 pi session / 不真连 MCP，验证「种子策略 → filter → 会话 config」）
 */
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";
import { filterMcpConfigForMode } from "../src/main/mcp/McpModeFilter";
import type { McpConfig } from "../src/main/mcp/McpConfigService";
import { WELCOME_MODES } from "../src/shared/mode-profile";

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

/** 模拟用户已装 serena + codegraph + 通用 MCP */
const installed: McpConfig = {
  mcpServers: {
    serena: {
      command: "serena",
      args: ["start-mcp-server", "--project-from-cwd"],
      modes: ["coding"],
    },
    codegraph: {
      command: "codegraph",
      args: ["serve", "--mcp"],
      modes: ["coding"],
    },
    "filesystem": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
    },
  },
};

console.log("=== 出厂种子 mcpPolicy × 已装 MCP ===\n");

for (const mode of WELCOME_MODES) {
  const policy = MODE_SEEDS[mode].policy.mcpPolicy;
  const r = filterMcpConfigForMode(installed, mode, policy);
  console.log(`\n[${mode}] policy=`, JSON.stringify(policy));
  console.log(`  enabled: [${r.enabled.join(", ")}]`);
  console.log(`  hidden:  [${r.hidden.join(", ")}]`);
  for (const [name, reason] of Object.entries(r.reasons)) {
    console.log(`    - ${name}: ${reason}`);
  }

  if (mode === "working" || mode === "design") {
    assert(!r.config.mcpServers.serena, `${mode}: serena 被硬禁`);
    assert(!r.config.mcpServers.codegraph, `${mode}: codegraph 被硬禁`);
    assert(!!r.config.mcpServers.filesystem, `${mode}: 通用 filesystem 仍可用`);
  }
  if (mode === "coding") {
    assert(!!r.config.mcpServers.serena, "coding: serena 可用");
    assert(!!r.config.mcpServers.codegraph, "coding: codegraph 可用");
    assert(!!r.config.mcpServers.filesystem, "coding: filesystem 可用");
  }
}

console.log("\n=== 用户白名单 B（working 只允许 filesystem）===\n");
{
  const r = filterMcpConfigForMode(installed, "working", {
    mode: "hard",
    allow: ["filesystem"],
    deny: [],
  });
  assert(Object.keys(r.config.mcpServers).length === 1, "白名单仅 1 项");
  assert(!!r.config.mcpServers.filesystem, "仅 filesystem");
  assert(!r.config.mcpServers.serena, "serena 不在白名单");
}

console.log("\n=== deny 优先于 modes 放行？deny 仍杀 ===\n");
{
  // coding 下 entry.modes 允许 serena，但 policy deny 仍应剔除
  const r = filterMcpConfigForMode(installed, "coding", {
    mode: "hard",
    allow: [],
    deny: ["serena"],
  });
  assert(!r.config.mcpServers.serena, "coding + deny serena → 无 serena");
  assert(!!r.config.mcpServers.codegraph, "codegraph 仍在");
}

console.log("\n=== allow 与 deny 同时：deny 先命中 ===\n");
{
  const r = filterMcpConfigForMode(installed, "coding", {
    mode: "hard",
    allow: ["serena", "codegraph"],
    deny: ["serena"],
  });
  assert(!r.config.mcpServers.serena, "deny 优先去掉 serena");
  assert(!!r.config.mcpServers.codegraph, "codegraph 在 allow 且未 deny");
  assert(!r.config.mcpServers.filesystem, "filesystem 不在 allow");
}

console.log("\n=== soft：deny 仍进 config ===\n");
{
  const r = filterMcpConfigForMode(installed, "working", {
    mode: "soft",
    allow: [],
    deny: ["serena", "codegraph"],
  });
  assert(!!r.config.mcpServers.serena, "soft 保留 serena in config");
  assert(r.hidden.includes("serena"), "soft 记 hidden");
}

console.log(`\n[mcp-mode-e2e-check] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
