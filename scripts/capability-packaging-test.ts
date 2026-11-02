/**
 * Capability packaging boundary regression.
 *
 * Product executable capabilities must live under src/main/capabilities and be
 * compiled into Main. The repository-level extensions directory is reserved
 * for declarative MCP bundles only; it is not a Pi executable extension surface.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listBundledMcpExtensions } from "../src/main/mcp/BundledMcpExtensions";

const repo = process.cwd();
let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log("  ✓ " + label);
  } else {
    failed += 1;
    console.error("  ✗ " + label);
  }
}

const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8")) as {
  build?: { files?: string[] };
};
const files = pkg.build?.files ?? [];

console.log("== capability source ownership ==");
assert(
  existsSync(join(repo, "src", "main", "capabilities", "web-access", "index.ts")),
  "WebAccess source is product-owned under src/main/capabilities",
);
assert(
  existsSync(join(repo, "src", "main", "capabilities", "subagent", "index.ts")),
  "Subagent source is product-owned under src/main/capabilities",
);
assert(
  !existsSync(join(repo, "extensions", "web-access")),
  "legacy extensions/web-access source is absent",
);
assert(
  !existsSync(join(repo, "extensions", "subagent")),
  "legacy extensions/subagent source is absent",
);

console.log("== executable disk-extension surface is absent ==");
assert(
  !existsSync(join(repo, "src", "main", "agent", "user-extension-loader.ts")),
  "legacy user-extension-loader is deleted",
);
assert(
  !existsSync(join(repo, "src", "main", "extensions", "sync-bundled-extensions.ts")),
  "legacy bundled extension sync is deleted",
);
const agentSource = readFileSync(join(repo, "src", "main", "agent", "AgentService.ts"), "utf-8");
assert(
  agentSource.includes("noExtensions: true"),
  "Pi automatic disk extension discovery remains disabled",
);

console.log("== electron-builder extension packaging is MCP-only ==");
assert(
  files.includes("extensions/mcp/**/*"),
  "build.files explicitly includes extensions/mcp only",
);
assert(
  !files.includes("extensions/**/*"),
  "generic executable extensions glob is absent",
);
const serena = listBundledMcpExtensions().find((bundle) => bundle.id === "serena");
assert(
  Boolean(serena && Object.keys(serena.servers).length),
  "declarative Serena MCP bundle is discoverable with server configuration",
);

console.log("\nresult: passed=" + passed + " failed=" + failed);
if (failed > 0) process.exit(1);
