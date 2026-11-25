/** Skill / connector installation smoke test. All fixtures and writes stay in a temporary profile. */
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import Database from "better-sqlite3";
import JSZip from "jszip";
import type { RuntimeAuditReader as CatalogReader } from "../src/main/platform/runtime-audit";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-skill-connector-"));
const originalCwd = process.cwd();
const previousProfile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
let native: CatalogReader | undefined;
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
function unchangedAfterReplace(file: string, name: string): () => void {
  if (!native) return () => {};
  const snapshot = join(sandbox, name);
  const original = readFileSync(file);
  linkSync(file, snapshot);
  return () => assert.deepEqual(readFileSync(snapshot), original, "saving must replace the file without modifying the old inode");
}
const skillMarkdown = (name: string): string => `---\nname: ${name}\ndescription: Isolated fixture for installation smoke checks.\n---\n\n# ${name}\n\nOnly inspect fixture data.\n`;

async function main(): Promise<void> {
  assert.equal(resolve(homedir()), resolve(sandbox), "HOME must be isolated before importing services");
  if (process.argv.includes("--native")) {
    const { RuntimeAuditReader, locateRuntimeAudit } = await import("../src/main/platform/runtime-audit");
    const executable = locateRuntimeAudit(originalCwd);
    assert(executable && existsSync(executable), "Rust worker executable is required in native mode");
    const dbPath = join(sandbox, "plugin-catalog.db");
    const db = new Database(dbPath);
    db.pragma("user_version = 1");
    db.close();
    native = new RuntimeAuditReader(executable, dbPath);
  }
  const plugins = join(sandbox, ".mybuddy", "plugins");
  const skillSource = join(plugins, "expert-market", "skills", "fixture-market-skill", "SKILL.md");
  put(skillSource, skillMarkdown("fixture-market-skill").replaceAll("\n", "\r\n"));
  const duplicateSource = join(sandbox, "mybuddyskills-main", "skills", "duplicate-fixture", "SKILL.md");
  put(duplicateSource, "---\nname: fixture-market-skill\ndescription: Later development copy\n---\n");
  put(join(plugins, "expert-market", "skills", "hidden-fixture", "SKILL.md"), skillMarkdown("hidden-fixture"));
  put(join(plugins, "market-hidden-skills.json"), '["HIDDEN-FIXTURE"]');
  const connectorSource = join(plugins, "connector-market", "connectors", "fixture-connector");
  put(join(connectorSource, "connector-meta.json"), JSON.stringify({ name: "Fixture connector", description: "Local isolated connector", type: "cli", version: "1.0.0" }));
  put(join(sandbox, "mybuddyskills-main", "connectors", "Fixture-Connector", "connector-meta.json"), '{"name":"Later development copy"}');
  put(join(plugins, "connector-market", "connectors", "hidden-connector", "connector-meta.json"), '{"name":"Hidden connector"}');
  put(join(plugins, "market-hidden-connectors.json"), '["HIDDEN-CONNECTOR"]');
  put(join(connectorSource, "cli.json"), JSON.stringify({ runtime: { type: "node" }, auth: { command: "must-not-run" }, init: {win32:"windows-only-init"}, versionCheck:{command:{win32:"windows-only-version"}} }));
  put(join(connectorSource, "skills", "fixture-connector-skill", "SKILL.md"), skillMarkdown("fixture-connector-skill"));

  // Dynamic imports are intentional: modules must not capture the real profile before isolation.
  const { SkillsService } = await import("../src/main/skills/SkillsService");
  const { ConnectorService, initializeConnectorStorage, recoverConnectorInstallations } = await import("../src/main/connectors/ConnectorService");
  const { getSkillsDir, getConnectorsDir } = await import("../src/main/paths");
  assertInSandbox(getSkillsDir()); assertInSandbox(getConnectorsDir());
  const skills = new SkillsService();
  assert.equal(skills.listInstalled().length, 0, "fixture must start with an empty installed skill list");
  const market = await skills.readMarket(native);
  const marketSkill = market.find((item) => item.id === "fixture-market-skill");
  assert.ok(marketSkill, "local fixture must be discoverable in the skill market");
  assert.deepEqual([marketSkill.name, marketSkill.description, marketSkill.sourcePath], [
    "fixture-market-skill", "Isolated fixture for installation smoke checks.", dirname(skillSource),
  ]);
  assert.equal(market.some(item => item.id === "hidden-fixture"), false);
  const installed = skills.installFromMarket(marketSkill.id);
  assert.ok(installed.filePath); assertInSandbox(installed.filePath!);
  assert.equal(readFileSync(installed.filePath!, "utf8"), readFileSync(skillSource, "utf8"));
  const again = skills.installFromMarket(marketSkill.id);
  assert.equal(again.filePath, installed.filePath);
  assert.equal(skills.listInstalled().length, 1, "reinstall must not duplicate skills");
  const skillFile = installed.filePath!;
  put(skillFile, readFileSync(skillFile, "utf8").replace("description: Isolated fixture for installation smoke checks.\r\n",
    "description: Isolated fixture for installation smoke checks.\r\npython-dependencies:\r\n  - example>=1.0\r\n  - helper==2.0\r\n"));
  const skillSnapshot = unchangedAfterReplace(skillFile, "skill-before-toggle.md");
  assert.equal((await skills.writeEnabled(marketSkill.id, false, {}, native)).enabled, false);
  assert.deepEqual(skills.listInstalled().map(skill => [skill.id, skill.enabled]), [["fixture-market-skill", false]]);
  assert.match(readFileSync(skillFile, "utf8"), /python-dependencies:\n  - example>=1\.0\n  - helper==2\.0\ndisable-model-invocation: true/);
  skillSnapshot();
  await skills.writeEnabled(marketSkill.id, true, {}, native);
  assert.deepEqual(skills.listInstalled().map(skill => [skill.id, skill.enabled]), [["fixture-market-skill", true]]);
  assert.match(readFileSync(skillFile, "utf8"), /python-dependencies:\n  - example>=1\.0\n  - helper==2\.0/);
  put(join(plugins, "skills", "legacy-fixture", "SKILL.md"), skillMarkdown("legacy-fixture"));
  const refreshedMarket = await skills.readMarket(native);
  assert.deepEqual(refreshedMarket.filter(item => ["fixture-market-skill", "legacy-fixture"].includes(item.id))
    .map(item => [item.id, item.author, item.sourcePath]), [
      ["legacy-fixture", "MyBuddy", join(plugins, "skills", "legacy-fixture")],
      ["fixture-market-skill", "MyBuddy 官方", dirname(skillSource)],
    ]);
  console.log("PASS isolated local skill discovery, install and reinstall");

  const connectors = new ConnectorService();
  const before = await connectors.readCatalog(native);
  assert.deepEqual(before.map(item => [item.id, item.name, item.sourcePath]), [["fixture-connector", "Fixture connector", connectorSource]]);
  assert.equal(before[0].installed, false);
  assert.deepEqual(await connectors.installInBackground("fixture-connector", native), ["fixture-connector-skill"]);
  const after = (await connectors.readCatalog(native)).find((item) => item.id === "fixture-connector")!;
  assert.equal(after.installed, true); assert.equal(after.enabled, true);
  const privateSkill = join(getConnectorsDir(), "fixture-connector", "skills", "fixture-connector-skill", "SKILL.md");
  assertInSandbox(privateSkill);
  assert.equal(readFileSync(privateSkill, "utf8"), skillMarkdown("fixture-connector-skill"));
  assert.equal(existsSync(join(getSkillsDir(), "fixture-connector-skill")), false, "connector private skills must not pollute global skills");
  put(join(connectorSource, "skills", "fixture-connector-skill", "references", "detail.md"), "Reinstalled reference.");
  assert.deepEqual(await connectors.installInBackground("FIXTURE-CONNECTOR", native), ["fixture-connector-skill"]);
  assert.equal(readFileSync(join(dirname(privateSkill), "references", "detail.md"), "utf8"), "Reinstalled reference.");
  assert.equal(skills.listInstalled().length, 2);
  await assert.rejects(() => connectors.installInBackground("fixture-missing", native), /未找到连接器/);

  if (native) {
    const live = join(getConnectorsDir(), "fixture-connector");
    const recoveryRoot = join(dirname(getConnectorsDir()), ".mybuddy-connector-installs");
    const pending = join(recoveryRoot, "fixture-connector");
    put(join(pending, "next", "meta.json"), '{"name":"Incomplete install","enabled":false}');
    mkdirSync(join(pending, "previous"), { recursive: true });
    renameSync(live, join(pending, "previous", "fixture-connector"));
    await recoverConnectorInstallations(native);
    assert.deepEqual(connectors.getPrivateSkillDirs(["fixture-connector"]), [join(live, "skills")]);
    assert.equal(readFileSync(join(dirname(privateSkill), "references", "detail.md"), "utf8"), "Reinstalled reference.");
    assert.deepEqual((await connectors.readCatalog(native)).map(item => [item.id, item.installed, item.enabled]), [
      ["fixture-connector", true, true],
    ]);
    put(join(pending, "previous", "fixture-connector", "meta.json"), '{"name":"Superseded install","enabled":false}');
    await recoverConnectorInstallations(native);
    assert.equal(connectors.isActive("fixture-connector"), true);
    assert.equal(existsSync(recoveryRoot), false);
  }
  const { connectorRuntimeContext } = await import("../src/main/connectors/ConnectorRuntimeContext");
  assert.equal(connectorRuntimeContext([], connectors.list(), "foreground"), "");
  const facts = connectorRuntimeContext([after.id.toUpperCase(), after.id], connectors.list(), "foreground");
  assert.match(facts, /registered_not_runtime_verified/);
  assert.match(facts, /required_not_verified/);
  assert.match(facts, /not a general connector CLI executor/);
  assert.equal((facts.match(/"id":/g) ?? []).length, 1);
  assert.doesNotMatch(facts, /must-not-run|windows-only-init/);
  assert.match(connectorRuntimeContext(["absent"], connectors.list(), "execution"), /not_installed/);
  const connectorMeta = join(getConnectorsDir(), after.id, "meta.json");
  const registration = JSON.parse(readFileSync(connectorMeta, "utf8"));
  registration.customMetadata = { label: "保留设置", values: [1, 42] };
  put(connectorMeta, JSON.stringify(registration));
  const connectorSnapshot = unchangedAfterReplace(connectorMeta, "connector-before-toggle.json");
  await connectors.writeEnabled(after.id.toUpperCase(), false, native);
  connectorSnapshot();
  assert.deepEqual(JSON.parse(readFileSync(connectorMeta, "utf8")), { ...registration, enabled: false });
  assert.deepEqual((await connectors.readCatalog(native)).map(item => [item.name, item.enabled, item.installedSkillNames]), [
    ["Fixture connector", false, ["fixture-connector-skill"]],
  ]);
  assert.match(connectorRuntimeContext([after.id], connectors.list(), "execution"), /"skills":"disabled"/);
  assert.deepEqual(connectors.getPrivateSkillDirs([after.id]), []);
  await connectors.writeEnabled(after.id, true, native);
  assert.deepEqual(connectors.getPrivateSkillDirs([after.id]), [join(getConnectorsDir(), after.id, "skills")]);
  await connectors.writeEnabled(after.id, false, native);
  assert.match(connectorRuntimeContext([after.id], connectors.list(), "execution"), /read-only version\/status/);
  const { connectorPlatformKey } = await import("../src/main/platform/apps");
  assert.equal(after.initCommand, connectorPlatformKey() === "win32" ? "windows-only-init" : undefined);
  assert.equal(after.versionCheckCommand, connectorPlatformKey() === "win32" ? "windows-only-version" : undefined);
  console.log("PASS connector state honesty, no implicit command execution, disabled/missing/dedup, platform-correct commands");
  console.log("PASS isolated connector install, private skills, reinstall and missing-id error");

  for (const [name, scopeId] of [["private-first", "my-bot-one"], ["private-second", "my-bot-two"], ["private-other", "other-bot"]]) {
    put(join(plugins, "skills", name, "SKILL.md"), skillMarkdown(name));
    put(join(plugins, "skills", name, "_skillhub_meta.json"), JSON.stringify({
      source: "memory-learned", id: name, scopeType: "bot", scopeId,
    }));
  }
  put(join(plugins, "skills", "broken-fixture", "SKILL.md"), skillMarkdown("broken-fixture"));
  put(join(plugins, "skills", "broken-fixture", "_skillhub_meta.json"), "{");
  assert.deepEqual(skills.listInstalledForBots(["my-bot-two", "my-bot-one"]).map(item => item.id), [
    "fixture-market-skill", "legacy-fixture", "private-second", "private-first",
  ]);

  const expert = (name: string, description: string, expertType = "agent") => JSON.stringify({
    name, displayName: { zh: name }, displayDescription: { zh: description }, expertType,
  });
  const expertRoot = join(plugins, "expert-market", "experts");
  put(join(expertRoot, "catalog-expert", ".codebuddy-plugin", "plugin.json"), expert("夹具专家", "可见专家包"));
  put(join(expertRoot, "catalog-team", ".codebuddy-plugin", "plugin.json"), expert("旧团队", "不可见", "team"));
  put(join(expertRoot, "catalog-hidden", ".codebuddy-plugin", "plugin.json"), expert("隐藏专家", "不可见"));
  put(join(plugins, "market-hidden-experts.json"), '["CATALOG-HIDDEN"]');
  const installedExpert = (id: string, name: string, installedAt: number) => JSON.stringify({
    id, name, installedAt, source: "local", enabled: id !== "old-expert", promptFile: "prompt.md",
  });
  put(join(plugins, "experts", "old-expert", "expert.json"), installedExpert("old-expert", "旧模板", 30));
  put(join(plugins, "experts", "new-expert", "expert.json"), installedExpert("new-expert", "新模板", 40));
  put(join(plugins, "experts", ".stage-expert", "expert.json"), installedExpert("stage-expert", "暂存模板", 50));
  put(join(plugins, "experts", "legacy-team", "expert.json"), '{"id":"legacy-team","kind":"team"}');
  const { ExpertService } = await import("../src/main/experts/ExpertService");
  const experts = new ExpertService();
  assert.deepEqual((await experts.readInstalled(native)).map(item => [item.id, item.name, item.enabled]), [
    ["new-expert", "新模板", true], ["old-expert", "旧模板", false],
  ]);
  assert.deepEqual((await experts.readMarket(native)).filter(item => item.id.startsWith("catalog-") || item.id === "new-expert")
    .map(item => [item.id, item.name, item.description]), [
      ["catalog-expert", "夹具专家", "可见专家包"], ["new-expert", "新模板", undefined],
    ]);
  const newExpert = join(plugins, "experts", "new-expert");
  put(join(newExpert, "prompt.md"), "---\r\nname: 新模板\r\n---\r\n\r\n核验专家资料。\r\n");
  put(join(newExpert, "skills", "owned-a", "SKILL.md"), skillMarkdown("fixture-market-skill"));
  put(join(newExpert, "skills", "owned-b", "skill.md"), skillMarkdown("unique-private"));
  put(join(newExpert, "备注-😀.txt"), "sort surrogate pair before private-use filename");
  put(join(newExpert, "备注-\uE000.txt"), "sort private-use filename after surrogate pair");
  put(join(plugins, "experts", "old-expert", "skills", "SKILL.md"), skillMarkdown("disabled-expert-skill"));
  const expertMeta = join(newExpert, "expert.json");
  const expertRegistration = JSON.parse(readFileSync(expertMeta, "utf8"));
  expertRegistration.extra = { note: "保留元数据", defaults: ["一", "二"] };
  put(expertMeta, JSON.stringify(expertRegistration));
  const expertSnapshot = unchangedAfterReplace(expertMeta, "expert-before-toggle.json");
  assert.equal((await experts.writeEnabled("new-expert", false, native)).enabled, false);
  assert.deepEqual(JSON.parse(readFileSync(expertMeta, "utf8")), { ...expertRegistration, enabled: false });
  expertSnapshot();
  assert.deepEqual(await experts.readExpertPrivateSkills("new-expert", native), []);
  assert.equal((await experts.writeEnabled("new-expert", true, native)).enabled, true);
  assert.deepEqual((await experts.readExpertPrivateSkills("new-expert", native)).map(skill => skill.id), ["owned-a", "owned-b"]);

  const hostDetail = experts.getDetail("new-expert");
  const detailOnHost = experts.getDetail.bind(experts);
  const privateSkillsOnHost = experts.listExpertPrivateSkills.bind(experts);
  if (native) {
    experts.getDetail = () => { throw new Error("Expert detail unexpectedly used its Node fallback"); };
    experts.listExpertPrivateSkills = () => { throw new Error("Expert private skills unexpectedly used their Node fallback"); };
  }
  let revision: string;
  try {
    const detail = await experts.readDetail("new-expert", native);
    assert.equal(detail.instructions, "核验专家资料。");
    assert.equal(detail.revision, hostDetail.revision);
    assert.deepEqual(detail.skills, ["owned-a", "owned-b"]);
    revision = detail.revision;
    assert.deepEqual(await experts.readExpertPrivateSkills("new-expert", native), [
      { id: "owned-a", name: "fixture-market-skill", description: "Isolated fixture for installation smoke checks.", shadowed: true },
      { id: "owned-b", name: "unique-private", description: "Isolated fixture for installation smoke checks.", shadowed: false },
    ]);
    assert.deepEqual(await experts.readExpertPrivateSkills("old-expert", native), []);
  } finally {
    experts.getDetail = detailOnHost;
    experts.listExpertPrivateSkills = privateSkillsOnHost;
  }
  const saved = experts.update({
    id: "new-expert", name: "新模板", description: "更新后的描述", instructions: "使用更新后的资料。", expectedRevision: revision,
    mcpIds: [], connectorIds: [],
  });
  assert.equal((await experts.readDetail("new-expert", native)).instructions, "使用更新后的资料。");
  assert.notEqual(saved.revision, revision);
  if (native) {
    const root = getConnectorsDir();
    const file = join("replaced-directory", "meta.json");
    const config = join(root, file);
    const target = { kind: "connector" as const, root, file };
    const original = '{"name":"Fresh registration","enabled":true}';
    put(config, original);
    const before = await native.readPluginConfig(target);
    assert.ok(before?.status === "observed");
    renameSync(dirname(config), join(root, "moved-old-directory"));
    put(config, original);
    await native.replacePluginConfig(target, before.version, '{"enabled":false}');
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { name: "Fresh registration", enabled: true });
    const newer = await native.readPluginConfig(target);
    assert.ok(newer?.status === "observed");
    put(config, '{"name":"Edited separately","enabled":true}');
    await native.replacePluginConfig(target, newer.version, '{"enabled":false}');
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")), { name: "Edited separately", enabled: true });
  }
  const recoveredMeta = join(getConnectorsDir(), "missing-meta", "meta.json");
  mkdirSync(dirname(recoveredMeta), { recursive: true });
  await connectors.writeEnabled("missing-meta", false, native);
  assert.deepEqual(JSON.parse(readFileSync(recoveredMeta, "utf8")), { enabled: false });
  console.log("PASS plugin toggles preserve YAML dependencies, registration metadata, and private skill visibility");

  const folder = join(sandbox, "Folder-Connector");
  put(join(folder, "connector-meta.json"), '{"name":"Folder import"}');
  put(join(folder, "skills", "SKILL.md"), skillMarkdown("folder-connector"));
  const importedFolder = await connectors.importDirectoryInBackground(folder, native);
  assert.deepEqual([importedFolder.id, importedFolder.installed, importedFolder.installedSkillNames], ["folder-connector", true, ["folder-connector"]]);
  assert.equal(readFileSync(join(getConnectorsDir(), "folder-connector", "skills", "folder-connector", "SKILL.md"), "utf8"),
    skillMarkdown("folder-connector"));
  assert.equal((await connectors.importDirectoryInBackground(importedFolder.sourcePath, native)).id, "folder-connector");
  assert.equal(readFileSync(join(importedFolder.sourcePath, "skills", "SKILL.md"), "utf8"), skillMarkdown("folder-connector"));

  const zip = new JSZip();
  zip.file("zip-fixture/connector-meta.json", '{"name":"ZIP import"}');
  zip.file("zip-fixture/skills/Zip-Skill/SKILL.md", skillMarkdown("zip-skill"));
  zip.file("zip-fixture/skills/Zip-Skill/references/source.bin", Buffer.from([0, 1, 255]));
  zip.file("zip-fixture/skills/Zip-Skill/references/说明.txt", "导入附件");
  const zipPath = join(sandbox, "connector.zip");
  writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
  const importedZip = await connectors.importZip(zipPath, native);
  assert.deepEqual([importedZip.id, importedZip.installedSkillNames], ["zip-fixture", ["zip-skill"]]);
  assert.deepEqual(readFileSync(join(getConnectorsDir(), "zip-fixture", "skills", "zip-skill", "references", "source.bin")), Buffer.from([0, 1, 255]));
  assert.equal(readFileSync(join(getConnectorsDir(), "zip-fixture", "skills", "zip-skill", "references", "说明.txt"), "utf8"), "导入附件");

  if (native) {
    const bad = new JSZip();
    bad.file("zip-fixture/connector-meta.json", '{"name":"Rejected replacement"}');
    bad.file("zip-fixture/../outside.txt", "must not write");
    const badPath = join(sandbox, "bad-replacement.zip");
    writeFileSync(badPath, await bad.generateAsync({ type: "nodebuffer" }));
    await assert.rejects(() => connectors.importZip(badPath, native), /ZIP 含非法路径/);
    assert.equal(readFileSync(join(importedZip.sourcePath, "connector-meta.json"), "utf8"), '{"name":"ZIP import"}');
    assert.equal(existsSync(join(dirname(importedZip.sourcePath), "outside.txt")), false);
    assert.equal(connectors.isActive("zip-fixture"), true);

    const rootZip = new JSZip();
    rootZip.file("connector-meta.json", '{"name":"Root archive"}');
    rootZip.file("skills/SKILL.md", skillMarkdown("root-archive"));
    const rootZipPath = join(sandbox, "Root Archive.ZIP");
    writeFileSync(rootZipPath, await rootZip.generateAsync({ type: "nodebuffer" }));
    const rootImported = await connectors.importZip(rootZipPath, native);
    assert.deepEqual([rootImported.id, rootImported.installedSkillNames], ["root-archive", ["root-archive"]]);

    const marketRoot = dirname(importedZip.sourcePath);
    const pending = join(dirname(marketRoot), ".mybuddy-connector-installs", "zip-fixture");
    put(join(pending, "next", "connector-meta.json"), '{"name":"Incomplete replacement"}');
    mkdirSync(join(pending, "previous"), { recursive: true });
    renameSync(importedZip.sourcePath, join(pending, "previous", "zip-fixture"));
    await recoverConnectorInstallations(native);
    const refreshed = (await connectors.readCatalog(native)).find(item => item.id === "zip-fixture");
    assert.deepEqual([refreshed?.name, refreshed?.installed], ["ZIP import", true]);
  }
  console.log("PASS connector installation, reinstall, package import and private resource bytes");

  await connectors.deleteFromMarketInBackground("Folder import", native);
  assert.equal(existsSync(importedFolder.sourcePath), false);
  assert.equal(existsSync(join(getConnectorsDir(), "folder-connector")), false);
  assert.deepEqual((await connectors.readCatalog(native)).filter(item => ["folder-connector", "zip-fixture"].includes(item.id))
    .map(item => [item.id, item.installed]), [["zip-fixture", true]]);

  const hiddenFile = join(plugins, "market-hidden-connectors.json");
  const hiddenInstall = join(getConnectorsDir(), "restore-hidden");
  put(join(hiddenInstall, "meta.json"), '{"enabled":true}');
  await connectors.deleteFromMarketInBackground("RESTORE-HIDDEN", native);
  assert.equal(existsSync(hiddenInstall), false);
  assert.deepEqual(JSON.parse(readFileSync(hiddenFile, "utf8")), ["hidden-connector", "restore-hidden"]);
  const hiddenSource = join(sandbox, "restore-hidden");
  put(join(hiddenSource, "connector-meta.json"), '{"name":"Restored market package"}');
  put(join(hiddenSource, "skills", "SKILL.md"), skillMarkdown("restore-hidden"));
  const restored = await connectors.importDirectoryInBackground(hiddenSource, native);
  assert.deepEqual([restored.id, restored.installedSkillNames], ["restore-hidden", ["restore-hidden"]]);
  assert.deepEqual(JSON.parse(readFileSync(hiddenFile, "utf8")), ["hidden-connector"]);

  if (native) {
    const marketRoot = dirname(restored.sourcePath);
    const external = join(sandbox, "external-connector");
    put(join(external, "connector-meta.json"), '{"name":"Linked outside the market"}');
    symlinkSync(external, join(marketRoot, "linked-connector"), "junction");
    const linkedRegistration = join(getConnectorsDir(), "linked-connector", "meta.json");
    put(linkedRegistration, '{"enabled":true}');
    await assert.rejects(() => connectors.deleteFromMarketInBackground("linked-connector", native), /无法验证连接器包/);
    assert.equal(readFileSync(join(external, "connector-meta.json"), "utf8"), '{"name":"Linked outside the market"}');
    assert.equal(readFileSync(linkedRegistration, "utf8"), '{"enabled":true}');

    const retired = join(dirname(marketRoot), ".mybuddy-connector-market-retired");
    put(join(retired, "package-123-4", "source", "connector-meta.json"), '{"name":"Removed package"}');
    put(join(retired, "user-folder", "keep.txt"), "preserve unrelated directory");
    await initializeConnectorStorage(native);
    assert.equal(existsSync(join(retired, "package-123-4")), false);
    assert.equal(readFileSync(join(retired, "user-folder", "keep.txt"), "utf8"), "preserve unrelated directory");
    assert.equal(connectors.isActive("restore-hidden"), true);
  }
  console.log("PASS market deletion, offline hidden records, re-import and scoped cleanup");
  console.log("PASS isolated expert catalog, installed state, native market and team filtering");
  console.log("PASS expert detail revision, package save and private-skill visibility");
  console.log(`Fixture retained for diagnosis: ${sandbox}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await native?.close();
  process.chdir(originalCwd);
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
});
