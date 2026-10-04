import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getPluginStorage, migratePluginStorage, pluginStoragePaths, rebasePluginReferences } from "../src/main/plugins/PluginStorage";
import { McpConfigService } from "../src/main/mcp/McpConfigService";

const work = mkdtempSync(join(tmpdir(), "mybuddy-plugin-storage-"));
const write = (path: string, text: string): void => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const json = (path: string): any => JSON.parse(readFileSync(path, "utf8"));
let passed = 0;
function check(name: string, run: () => void): void { run(); passed++; console.log("PASS " + name); }
try {
  const base = join(work, "home", ".mybuddy");
  const dest = pluginStoragePaths(base);
  const skillText = "---\nname: migrated\ndescription: Migrated skill\n---\nRun ~/.mybuddy/skills/migrated/run.py\n";
  write(join(base, "skills", "migrated", "SKILL.md"), skillText);
  write(join(base, "skills", "overlap", "SKILL.md"), "legacy-content");
  write(join(dest.skills, "overlap", "SKILL.md"), "new-content");
  write(join(base, "experts", "specialist", "expert.json"), '{"id":"specialist"}');
  write(join(base, "connectors", "service", "meta.json"), '{"id":"service"}');
  write(join(base, "agents", "reviewer.md"), "reviewer");
  write(join(base, "prompts", "workflow.md"), "workflow");
  write(join(base, "extensions", "legacy", "entry.ts"), "legacy-extension");
  write(join(dest.root, "native-package", "index.ts"), "native-pi-plugin");
  write(join(base, "mcp-native-auth.encrypted.json"), "opaque-encrypted-token");
  write(join(base, "mcp-native-refresh-locks", "lock.json"), "lock");
  const cliSkills = join(work, "home", ".agents", "skills");
  mkdirSync(cliSkills, { recursive: true });
  symlinkSync(join(base, "skills", "migrated"), join(cliSkills, "migrated"), process.platform === "win32" ? "junction" : "dir");
  write(join(base, "mcp.json"), '{// user comment\n"custom":"keep", "settings":{"a":1}, "mcpServers":{"old":{"command":"node","args":[]},"shared":{"url":"https://old.invalid/mcp"}},}');
  write(dest.mcpConfig, JSON.stringify({ settings: { b: 2 }, mcpServers: { current: { url: "https://current.invalid/mcp" }, shared: { url: "https://new.invalid/mcp" } } }));
  const migrated = migratePluginStorage(base);
  check("all installed resource roots and opaque MCP credentials move intact", () => {
    for (const dir of ["skills", "experts", "connectors", "agents", "prompts", "extensions"]) assert(!existsSync(join(base, dir)), dir);
    assert.equal(readFileSync(join(dest.mcp, "mcp-native-auth.encrypted.json"), "utf8"), "opaque-encrypted-token");
    assert.equal(readFileSync(join(dest.root, "native-package", "index.ts"), "utf8"), "native-pi-plugin");
    assert(!existsSync(join(base, "mcp.json")));
  });
  check("collisions keep new content and retain both config originals", () => {
    assert.equal(readFileSync(join(dest.skills, "overlap", "SKILL.md"), "utf8"), "new-content");
    assert.equal(readFileSync(join(migrated.backupPath!, "conflicts", "skills", "overlap", "SKILL.md"), "utf8"), "legacy-content");
    assert(existsSync(join(migrated.backupPath!, "destination", "mcp.json")));
    const config = json(dest.mcpConfig);
    assert.deepEqual(Object.keys(config.mcpServers).sort(), ["current", "old", "shared"]);
    assert.equal(config.mcpServers.shared.url, "https://new.invalid/mcp");
    assert.equal(config.custom, "keep"); assert.deepEqual(config.settings, { a: 1, b: 2 });
  });
  check("installed instruction references rebase with byte-for-byte originals retained", () => {
    assert(readFileSync(join(dest.skills, "migrated", "SKILL.md"), "utf8").includes("~/.mybuddy/plugins/skills/migrated/run.py"));
    assert.equal(readFileSync(join(migrated.backupPath!, "references", "skills", "migrated", "SKILL.md"), "utf8"), skillText);
    const entry = JSON.stringify({ cwd: "C:\\Users\\user\\.mybuddy\\skills\\helper" });
    assert.equal(JSON.parse(rebasePluginReferences(entry)).cwd, "C:\\Users\\user\\.mybuddy\\plugins\\skills\\helper");
    assert.equal(rebasePluginReferences("~/.mybuddy/plugins/skills/helper"), "~/.mybuddy/plugins/skills/helper");
  });
  check("migration is idempotent", () => {
    const marker = readFileSync(join(dest.root, ".storage-v1.json"), "utf8");
    assert.deepEqual(migratePluginStorage(base), migrated);
    assert.equal(readFileSync(join(dest.root, ".storage-v1.json"), "utf8"), marker);
  });
  check("existing CLI skill links follow the migrated skill", () => {
    assert.equal(realpathSync(join(cliSkills, "migrated")), realpathSync(join(dest.skills, "migrated")));
    assert.equal(json(join(migrated.backupPath!, "cli-links.json")).length, 1);
  });
  check("a failed move preserves unprocessed config and can be retried", () => {
    const blocked = join(work, "blocked");
    write(join(blocked, "plugins", "mcp"), "blocking-file");
    write(join(blocked, "mcp.json"), '{"mcpServers":{}}');
    assert.throws(() => getPluginStorage(blocked));
    assert.equal(readFileSync(join(blocked, "mcp.json"), "utf8"), '{"mcpServers":{}}');
    rmSync(join(blocked, "plugins", "mcp"));
    assert.equal(getPluginStorage(blocked).mcpConfig, join(blocked, "plugins", "mcp", "mcp.json"));
  });
  check("a live migration owner blocks concurrent writers without changing data", () => {
    const concurrent = join(work, "concurrent");
    write(join(concurrent, "skills", "x", "SKILL.md"), "original");
    const lock = join(concurrent, "plugins", ".storage-migration.lock");
    write(lock, JSON.stringify({ pid: process.pid, token: "another-owner" }));
    assert.throws(() => migratePluginStorage(concurrent), /另一个进程/);
    assert.equal(readFileSync(join(concurrent, "skills", "x", "SKILL.md"), "utf8"), "original");
    assert.equal(json(lock).token, "another-owner");
    rmSync(lock);
    migratePluginStorage(concurrent);
    assert(!existsSync(lock));
  });
  check("linked directories are not traversed or rewritten", () => {
    const linked = join(work, "linked"), outside = join(work, "outside");
    write(join(outside, "SKILL.md"), skillText);
    mkdirSync(join(linked, "skills"), { recursive: true });
    symlinkSync(outside, join(linked, "skills", "external"), process.platform === "win32" ? "junction" : "dir");
    migratePluginStorage(linked);
    assert.equal(readFileSync(join(outside, "SKILL.md"), "utf8"), skillText);
  });

  const service = new McpConfigService({ homeDir: join(work, "home"), appGlobalPath: dest.mcpConfig });
  const entry = { command: "node", args: ["args,}", "file.mjs"], exposure: "deferred", timeout: 15, enabled: true, env: { KEY: "${KEY}" }, toolExposure: { echo: "direct" }, modes: ["coding"] };
  check("new native server saves without dropping unrelated config or advanced fields", () => {
    assert.equal(service.saveServerConfig({ name: "local-tools", entryText: JSON.stringify(entry), expectedEntryText: null }).ok, true);
    assert.deepEqual(json(dest.mcpConfig).mcpServers["local-tools"], entry);
    assert.equal(json(dest.mcpConfig).custom, "keep");
    assert.equal(service.listServers().find(server => server.name === "local-tools")?.exposure, "deferred");
  });
  check("editing one server preserves others and rejects stale writes", () => {
    const before = service.readServerConfig("local-tools");
    assert(service.saveServerConfig({ name: before.name, entryText: JSON.stringify({ ...entry, timeout: 30 }), expectedEntryText: before.entryText }).ok);
    assert(!service.saveServerConfig({ name: before.name, entryText: JSON.stringify({ ...entry, timeout: 40 }), expectedEntryText: before.entryText }).ok);
    assert.equal(json(dest.mcpConfig).mcpServers["local-tools"].timeout, 30);
    assert(json(dest.mcpConfig).mcpServers.current);
  });
  check("invalid Pi transport and normalized name collisions fail before writing", () => {
    const before = readFileSync(dest.mcpConfig, "utf8");
    for (const [name, entry] of [["legacy", { type: "sse", url: "https://invalid/mcp" }], ["local_tools", { command: "node" }], ["invalid", { command: "node", env: { KEY: 1 } }]] as const) {
      assert.equal(service.saveServerConfig({ name, entryText: JSON.stringify(entry), expectedEntryText: null }).ok, false);
      assert.equal(readFileSync(dest.mcpConfig, "utf8"), before);
    }
  });
  check("malformed existing config is never replaced by an editor save", () => {
    const badPath = join(work, "bad.json"); write(badPath, '{"mcpServers":');
    const bad = new McpConfigService({ homeDir: work, appGlobalPath: badPath });
    assert.equal(bad.saveServerConfig({ name: "x", entryText: '{"command":"node"}', expectedEntryText: null }).ok, false);
    assert.equal(readFileSync(badPath, "utf8"), '{"mcpServers":');
  });
  console.log(`${passed} plugin storage/config checks passed`);
} finally {
  assert(resolve(work).startsWith(resolve(tmpdir())));
  rmSync(work, { recursive: true, force: true });
}
