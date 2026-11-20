import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { configureOfficeCli } from "../src/main/platform/officecli";
import { ensureOfficeCliSkill } from "../src/main/skills/OfficeCliSkill";
import { SkillsService } from "../src/main/skills/SkillsService";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import type { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import type { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const root = mkdtempSync(join(tmpdir(), "officecli-integration-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
try {
  const source = resolve('scripts/skill-governance/payload/officecli');
  const skills = join(root, '.mybuddy/plugins/skills');
  assert.equal(ensureOfficeCliSkill(source, skills), 'created');
  assert(existsSync(join(skills, 'officecli/references/cli-operations.md')));
  assert(existsSync(join(skills, 'officecli/scripts/probe-write.cjs')), 'new skill installs include the bounded diagnostic');
  const service = new SkillsService();
  assert(service.listInstalled(root).some(skill => skill.id === 'officecli'));
  assert(service.resolveRuntimeSkills(root).skills.some(skill => skill.name === 'officecli'));
  assert(!service.resolveRuntimeSkills(root, [], skill => skill.id !== 'officecli').skills.some(skill => skill.name === 'officecli'), 'permission filter must still exclude the bundled skill');
  const installed = join(skills, 'officecli/SKILL.md');
  writeFileSync(installed, readFileSync(installed, 'utf8').replace('name: officecli', 'name: officecli\ndisable-model-invocation: true'));
  assert.equal(ensureOfficeCliSkill(source, skills), 'preserved');
  assert(!service.resolveRuntimeSkills(root).skills.some(skill => skill.name === 'officecli'), 'restart must preserve disabled skills');
  assert.equal(ensureOfficeCliSkill('missing', skills), 'preserved', 'user/Magpie copies must remain intact');
  assert.throws(() => ensureOfficeCliSkill('missing', join(root, 'empty-skills')), /missing/);

  const inherited = { PATH: "system-path" };
  assert.equal(configureOfficeCli({ env: inherited }), undefined);
  assert.deepEqual(inherited, { PATH: "system-path" });
  const explicit = { MYBUDDY_OFFICECLI: process.execPath, PATH: "system-path", OFFICECLI_SKIP_UPDATE: "0" };
  assert.equal(configureOfficeCli({ env: explicit }), process.execPath);
  assert.equal(configureOfficeCli({ env: explicit }), process.execPath);
  assert.deepEqual(explicit.PATH.split(process.platform === "win32" ? ";" : ":"), [dirname(process.execPath), "system-path"]);
  assert.equal(explicit.OFFICECLI_SKIP_UPDATE, "0");
  assert.throws(() => configureOfficeCli({ env: { MYBUDDY_OFFICECLI: "relative/path" } }), /本地可执行文件/);

  // Optional local binary smoke; CI's headless gate never downloads binaries.
  const local = process.env.OFFICECLI_SMOKE_BINARY;
  if (local) {
    const env = { ...process.env, MYBUDDY_OFFICECLI: local };
    configureOfficeCli({ env });
    // A separate task process must find the independently installed executable.
    const version = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:child_process").execFileSync("officecli",["--version"],{encoding:"utf8"}))'], { cwd: root, env, encoding: 'utf8' });
    assert(version.trim(), 'configured OfficeCLI must report a version');
    process.env.MYBUDDY_OFFICECLI = local;
    configureOfficeCli();
    const bash = createBashToolDefinition(root);
    const bashResult = await bash.execute('officecli-native', { command: 'officecli --version && printf "OFFICECLI_SKIP_UPDATE=%s\\n" "$OFFICECLI_SKIP_UPDATE"', timeout: 10 }, undefined, undefined, undefined as never);
    assert(JSON.stringify(bashResult).includes(version.trim()), 'native task Bash must inherit the configured PATH');
    assert(JSON.stringify(bashResult).includes('OFFICECLI_SKIP_UPDATE=1'), 'native task Bash must suppress in-place auto-update');
    let durableOutput = '';
    const durable = await new NodeExecutionEnv({ cwd: root }).exec('officecli --version', { onOutput: text => { durableOutput += text; } }, {} as never);
    assert(durable.ok && durable.value.exitCode === 0 && durableOutput.includes(version.trim()), `Durable/Code Mode execution environment: ${JSON.stringify(durable)} ${durableOutput}`);
    const tools = new Map<string, Parameters<ExtensionAPI['registerTool']>[0]>();
    const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'multiModelConsult'] as const) config[key].enabled = false;
    config.diagnostics = { enabled: false };
    createBuiltinCapabilityExtension({
      taskId: 'officecli-task', taskRoot: root,
      runtime: { config: () => config } as BuiltinCapabilityRuntime,
      browser: { available: false } as BrowserAutomationService,
      artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => 'guarded',
    })({ registerTool: tool => tools.set(tool.name, tool), on: () => undefined } as unknown as ExtensionAPI);
    for (const language of ['shell', ...(process.platform === 'win32' ? ['powershell'] : [])]) {
      const result = await tools.get('execute_code')!.execute('officecli-task', { language, code: 'officecli --version', timeout: 10 } as never, undefined, undefined, undefined as never);
      assert(!result.isError && JSON.stringify(result).includes(version.trim()), `execute_code ${language}: ${JSON.stringify(result)}`);
    }
    for (const ext of ['docx', 'xlsx', 'pptx']) {
      const file = join(root, `smoke.${ext}`);
      execFileSync('officecli', ['create', file], { env, cwd: root });
      assert(existsSync(file));
      execFileSync('officecli', ['validate', file], { env, cwd: root });
    }
    const word = join(root, 'smoke.docx');
    execFileSync('officecli', ['add', word, '/body', '--type', 'paragraph', '--prop', 'text=MyBuddy OfficeCLI integration'], { env, cwd: root });
    assert(execFileSync('officecli', ['view', word, 'text'], { env, cwd: root, encoding: 'utf8' }).includes('MyBuddy OfficeCLI integration'));
    execFileSync('officecli', ['validate', word], { env, cwd: root });
    console.log('External OfficeCLI: task Bash, execute_code, child PATH and DOCX/XLSX/PPTX create/validate passed');
  } else console.log('Set OFFICECLI_SMOKE_BINARY to opt into the external binary smoke');
  console.log('OfficeCLI skill discovery, permission filtering, disable preservation and payload rejection passed');
} finally { rmSync(root, { recursive: true, force: true }); }
