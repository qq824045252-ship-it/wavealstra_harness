import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createPowerShellToolDefinition } from "@earendil-works/pi-coding-agent";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AppSettingsStore } from "../src/main/AppSettingsStore";
import { createAgentSettingsManager, getAgentBashShellPath, migrateLegacyShellPreferences } from "../src/main/agent-shell-settings";

const root = mkdtempSync(join(tmpdir(), "mybuddy-shell-preferences-"));
const agentDir = join(root, "agent"), cwd = join(root, "workspace");
mkdirSync(agentDir); mkdirSync(cwd);
const file = join(agentDir, "settings.json");
const ps = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
const bash = process.platform === "win32" ? "C:\\Program Files\\Git\\bin\\bash.exe" : "/bin/bash";
const store = new AppSettingsStore();
const results: string[] = [];
async function test(name: string, run: () => void | Promise<void>) { await run(); results.push(name); console.log("PASS " + name); }
const text = (result: any) => result.content.map((part: any) => part.text ?? "").join("\n");

try {
  await test("legacy PowerShell migrates without losing other settings; repeated startup does not write", () => {
    const raw = { shellPath: ps, enabledModels: [], custom: { preserved: true }, shellIsolationLevel: "guarded" };
    writeFileSync(file, JSON.stringify(raw));
    store.migrateShellPreferences(file);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { terminalShellPath: ps, enabledModels: [], custom: { preserved: true }, shellIsolationLevel: "guarded" });
    const before = statSync(file).mtimeMs;
    store.migrateShellPreferences(file);
    assert.equal(statSync(file).mtimeMs, before);
  });
  await test("explicit terminal preference wins; explicit Bash does not select the interactive terminal", () => {
    assert.deepEqual(migrateLegacyShellPreferences({ shellPath: ps, terminalShellPath: "" }).settings, { terminalShellPath: "" });
    assert.deepEqual(migrateLegacyShellPreferences({ shellPath: bash }), { settings: { shellPath: bash }, changed: false });
  });
  await test("native Pi Bash executes the original ls -la after migration", async () => {
    writeFileSync(join(cwd, "shell-regression-marker.txt"), "fixture");
    const tool = createBashToolDefinition(cwd, { shellPath: getAgentBashShellPath(cwd, agentDir) });
    const result = await tool.execute("native-shell", { command: "ls -la", timeout: 10 }, undefined, undefined, undefined as never);
    assert.equal(result.isError, undefined, text(result));
    assert.match(text(result), /shell-regression-marker\.txt/);
  });
  await test("Durable Bash executes ls -la with the same agent configuration", async () => {
    const env = new NodeExecutionEnv({ cwd, shellPath: getAgentBashShellPath(cwd, agentDir) });
    let output = "";
    const result = await env.exec("ls -la", { onOutput: (chunk) => { output += chunk; } }, BACKGROUND_CONTEXT);
    assert(result.ok, JSON.stringify(result));
    assert.equal(result.value.exitCode, 0);
    assert.match(output, /shell-regression-marker\.txt/);
    await env.cleanup(BACKGROUND_CONTEXT);
  });
  await test("custom Bash survives settings reload; project PowerShell override is rejected before spawning", async () => {
    assert(existsSync(bash), "The test requires an installed Bash");
    const settings = createAgentSettingsManager(cwd, agentDir);
    writeFileSync(file, JSON.stringify({ shellPath: bash, terminalShellPath: ps }));
    await settings.reload();
    assert.equal(settings.getShellPath(), bash);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ shellPath: ps }));
    await settings.reload();
    assert.throws(() => settings.getShellPath(), /terminalShellPath/);
    rmSync(join(cwd, ".pi", "settings.json"));
  });
  if (process.platform === "win32") await test("independent native PowerShell tool still executes PowerShell", async () => {
    const result = await createPowerShellToolDefinition(cwd).execute("ps-shell", { command: "Write-Output POWERSHELL_STILL_WORKS", timeout: 10 }, undefined, undefined, undefined as never);
    assert.equal(result.isError, undefined, text(result));
    assert.match(text(result), /POWERSHELL_STILL_WORKS/);
  });
  await test("corrupt settings remain untouched for the existing recovery path", () => {
    writeFileSync(file, "{broken");
    store.migrateShellPreferences(file);
    assert.equal(readFileSync(file, "utf8"), "{broken");
  });
  console.log(`SHELL_PREFERENCES_PASS ${results.length}`);
} finally { rmSync(root, { recursive: true, force: true }); }
