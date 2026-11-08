// Live check: ~/.mybuddy/mcp.json + modes/*/policy.json against filterMcpConfigForMode
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { filterMcpConfigForMode } from "../src/main/mcp/McpModeFilter";
import type { McpConfig, McpServerEntry } from "../src/main/mcp/McpConfigService";
import type { ModeMcpPolicy, WelcomeMode } from "../src/shared/mode-profile";
import { WELCOME_MODES, emptyModePolicy } from "../src/shared/mode-profile";
import { MODE_SEEDS } from "../src/main/agent/mode-defaults";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadMcp(): McpConfig {
  const path = join(homedir(), ".mybuddy", "mcp.json");
  if (!existsSync(path)) {
    console.log("无 ~/.mybuddy/mcp.json");
    return { mcpServers: {} };
  }
  const raw = readJson(path) as { mcpServers?: Record<string, McpServerEntry> };
  return { mcpServers: raw.mcpServers ?? {} };
}

function loadMcpPolicy(mode: WelcomeMode): ModeMcpPolicy {
  const path = join(homedir(), ".mybuddy", "modes", mode, "policy.json");
  if (!existsSync(path)) {
    console.log(`[${mode}] 无 policy.json，用出厂种子`);
    return MODE_SEEDS[mode].policy.mcpPolicy;
  }
  const raw = readJson(path) as { mcpPolicy?: ModeMcpPolicy };
  const p = raw.mcpPolicy;
  if (!p) return emptyModePolicy().mcpPolicy;
  return {
    mode: p.mode === "soft" ? "soft" : "hard",
    allow: Array.isArray(p.allow) ? p.allow.map(String) : [],
    deny: Array.isArray(p.deny) ? p.deny.map(String) : [],
  };
}

const mcp = loadMcp();
const names = Object.keys(mcp.mcpServers);
console.log("=== 本机已装 MCP（~/.mybuddy/mcp.json）===");
if (!names.length) {
  console.log("  （空）");
} else {
  for (const n of names) {
    const e = mcp.mcpServers[n]!;
    const flag = e.disabled ? " [disabled]" : "";
    const modes = e.modes ? ` modes=${JSON.stringify(e.modes)}` : "";
    console.log(`  - ${n}${flag}${modes}`);
  }
}

console.log("\n=== 三模式过滤结果（= 新任务 createSession 将注入的 MCP）===\n");

let issues = 0;

for (const mode of WELCOME_MODES) {
  const policy = loadMcpPolicy(mode);
  const r = filterMcpConfigForMode(mcp, mode, policy);
  console.log(`【${mode}】mcpPolicy: ${JSON.stringify(policy)}`);
  console.log(`  启用: [${r.enabled.join(", ") || "（无）"}]`);
  console.log(`  隐藏: [${r.hidden.join(", ") || "（无）"}]`);
  for (const [n, reason] of Object.entries(r.reasons)) {
    console.log(`    · ${n}: ${reason}`);
  }

  // 基本一致性检查
  for (const n of r.enabled) {
    if (r.config.mcpServers[n]?.disabled) {
      console.error(`  ✗ 启用列表含 disabled: ${n}`);
      issues += 1;
    }
  }
  if (policy.mode === "hard" && policy.deny.length) {
    for (const d of policy.deny) {
      const hit = Object.keys(mcp.mcpServers).filter(
        (n) => n.toLowerCase() === d.toLowerCase() || n.toLowerCase().includes(d.toLowerCase()),
      );
      for (const h of hit) {
        if (mcp.mcpServers[h]?.disabled) continue;
        if (r.config.mcpServers[h]) {
          console.error(`  ✗ deny「${d}」未剔除 ${h}`);
          issues += 1;
        }
      }
    }
  }
  if (policy.mode === "hard" && policy.allow.length > 0) {
    for (const n of r.enabled) {
      const ok = policy.allow.some(
        (a) => n.toLowerCase() === a.toLowerCase() || n.toLowerCase().includes(a.toLowerCase()),
      );
      if (!ok) {
        console.error(`  ✗ allow 白名单外仍启用: ${n}`);
        issues += 1;
      }
    }
  }
  console.log("");
}

// 针对用户当前配置的专项断言
console.log("=== 专项断言（相对你当前 policy）===\n");
{
  const w = filterMcpConfigForMode(mcp, "working", loadMcpPolicy("working"));
  const c = filterMcpConfigForMode(mcp, "coding", loadMcpPolicy("coding"));
  const d = filterMcpConfigForMode(mcp, "general", loadMcpPolicy("general"));

  // working deny 含 esp-*
  if (mcp.mcpServers["esp-component-registry"] && !mcp.mcpServers["esp-component-registry"].disabled) {
    if (w.config.mcpServers["esp-component-registry"]) {
      console.error("✗ working 应隐藏 esp-component-registry");
      issues += 1;
    } else console.log("✓ working 隐藏 esp-component-registry");
  }
  if (mcp.mcpServers["espressif-documentation"] && !mcp.mcpServers["espressif-documentation"].disabled) {
    if (w.config.mcpServers["espressif-documentation"]) {
      console.error("✗ working 应隐藏 espressif-documentation");
      issues += 1;
    } else console.log("✓ working 隐藏 espressif-documentation");
  }

  // coding allow 仅 serena/codegraph — 若未装则 coding 启用为空
  const codingAllow = loadMcpPolicy("coding").allow;
  if (codingAllow.length) {
    for (const n of c.enabled) {
      const ok = codingAllow.some((a) => n.toLowerCase().includes(a.toLowerCase()));
      if (!ok) {
        console.error(`✗ coding 白名单外: ${n}`);
        issues += 1;
      }
    }
    console.log(
      c.enabled.length === 0
        ? "⚠ coding 启用列表为空：白名单是 serena/codegraph，但 mcp.json 里没有这两项"
        : `✓ coding 启用均在白名单内: [${c.enabled.join(", ")}]`,
    );
  }

  // design allow 含 esp
  if (mcp.mcpServers["esp-component-registry"] && !mcp.mcpServers["esp-component-registry"].disabled) {
    if (d.config.mcpServers["esp-component-registry"]) {
      console.log("✓ design 启用 esp-component-registry（在白名单）");
    } else {
      console.error("✗ design 应启用 esp-component-registry");
      issues += 1;
    }
  }

  // canva disabled 任何模式都不应启用
  if (mcp.mcpServers.canva?.disabled) {
    const any = [w, c, d].some((r) => r.config.mcpServers.canva);
    if (any) {
      console.error("✗ canva disabled 仍被启用");
      issues += 1;
    } else console.log("✓ canva 全局 disabled，三模式均不启用");
  }
}

console.log(issues === 0 ? "\n[live-check] 全部通过" : `\n[live-check] ${issues} 个问题`);
process.exit(issues === 0 ? 0 : 1);
