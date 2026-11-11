/** Skill / connector installation smoke test. All fixtures and writes stay in a temporary profile. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-skill-connector-"));
const originalCwd = process.cwd();
const previousProfile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
// Services also discover development markets under cwd. Do not read the real repository market.
process.chdir(sandbox);

function assertInSandbox(path: string): void {
  const rel = relative(resolve(sandbox), resolve(path));
  assert.ok(rel && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel), `path escaped isolated profile: ${path}`);
}
function put(path: string, content: string): void {
  assertInSandbox(path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, "utf8");
}
const skillMarkdown = (name: string): string => `---\nname: ${name}\ndescription: Isolated fixture for installation smoke checks.\n---\n\n# ${name}\n\nOnly inspect fixture data.\n`;

async function main(): Promise<void> {
  assert.equal(resolve(homedir()), resolve(sandbox), "HOME must be isolated before importing services");
  const plugins = join(sandbox, ".mybuddy", "plugins");
  const skillSource = join(plugins, "expert-market", "skills", "fixture-market-skill", "SKILL.md");
  put(skillSource, skillMarkdown("fixture-market-skill"));
  const connectorSource = join(plugins, "connector-market", "connectors", "fixture-connector");
  put(join(connectorSource, "connector-meta.json"), JSON.stringify({ name: "Fixture connector", description: "Local isolated connector", type: "cli", version: "1.0.0" }));
  put(join(connectorSource, "cli.json"), JSON.stringify({ runtime: { type: "node" }, auth: { command: "must-not-run" }, init: {win32:"windows-only-init"}, versionCheck:{command:{win32:"windows-only-version"}} }));
  put(join(connectorSource, "skills", "fixture-connector-skill", "SKILL.md"), skillMarkdown("fixture-connector-skill"));

  // Dynamic imports are intentional: modules must not capture the real profile before isolation.
  const { SkillsService } = await import("../src/main/skills/SkillsService");
  const { ConnectorService } = await import("../src/main/connectors/ConnectorService");
  const { getSkillsDir, getConnectorsDir } = await import("../src/main/paths");
  assertInSandbox(getSkillsDir()); assertInSandbox(getConnectorsDir());
  const skills = new SkillsService();
  assert.equal(skills.listInstalled().length, 0, "fixture must start with an empty installed skill list");
  const marketSkill = skills.listMarket().find((item) => item.id === "fixture-market-skill");
  assert.ok(marketSkill, "local fixture must be discoverable in the skill market");
  const installed = skills.installFromMarket(marketSkill.id);
  assert.ok(installed.filePath); assertInSandbox(installed.filePath!);
  assert.equal(readFileSync(installed.filePath!, "utf8"), readFileSync(skillSource, "utf8"));
  const again = skills.installFromMarket(marketSkill.id);
  assert.equal(again.filePath, installed.filePath);
  assert.equal(skills.listInstalled().length, 1, "reinstall must not duplicate skills");
  console.log("PASS isolated local skill discovery, install and reinstall");

  const connectors = new ConnectorService();
  const before = connectors.list();
  assert.deepEqual(before.map((item) => item.id), ["fixture-connector"]);
  assert.equal(before[0].installed, false);
  assert.deepEqual(connectors.install("fixture-connector"), ["fixture-connector-skill"]);
  const after = connectors.list().find((item) => item.id === "fixture-connector")!;
  assert.equal(after.installed, true); assert.equal(after.enabled, true);
  const privateSkill = join(getConnectorsDir(), "fixture-connector", "skills", "fixture-connector-skill", "SKILL.md");
  assertInSandbox(privateSkill);
  assert.equal(readFileSync(privateSkill, "utf8"), skillMarkdown("fixture-connector-skill"));
  assert.equal(existsSync(join(getSkillsDir(), "fixture-connector-skill")), false, "connector private skills must not pollute global skills");
  assert.deepEqual(connectors.install("fixture-connector"), ["fixture-connector-skill"]);
  assert.equal(skills.listInstalled().length, 1);
  assert.throws(() => connectors.install("fixture-missing"), /未找到连接器/);
  const { connectorRuntimeContext } = await import("../src/main/connectors/ConnectorRuntimeContext");
  assert.equal(connectorRuntimeContext([], connectors.list(), "foreground"), "");
  const facts = connectorRuntimeContext([after.id.toUpperCase(), after.id], connectors.list(), "foreground");
  assert.match(facts, /registered_not_runtime_verified/);
  assert.match(facts, /required_not_verified/);
  assert.match(facts, /not a general connector CLI executor/);
  assert.equal((facts.match(/"id":/g) ?? []).length, 1);
  assert.doesNotMatch(facts, /must-not-run|windows-only-init/);
  assert.match(connectorRuntimeContext(["absent"], connectors.list(), "execution"), /not_installed/);
  connectors.setEnabled(after.id, false);
  assert.match(connectorRuntimeContext([after.id], connectors.list(), "execution"), /"skills":"disabled"/);
  assert.match(connectorRuntimeContext([after.id], connectors.list(), "execution"), /read-only version\/status/);
  const { connectorPlatformKey } = await import("../src/main/platform/apps");
  assert.equal(after.initCommand, connectorPlatformKey() === "win32" ? "windows-only-init" : undefined);
  assert.equal(after.versionCheckCommand, connectorPlatformKey() === "win32" ? "windows-only-version" : undefined);
  console.log("PASS connector state honesty, no implicit command execution, disabled/missing/dedup, platform-correct commands");
  console.log("PASS isolated connector install, private skills, reinstall and missing-id error");
  console.log(`Fixture retained for diagnosis: ${sandbox}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  process.chdir(originalCwd);
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});
