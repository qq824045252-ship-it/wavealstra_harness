import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { configureOfficeCli } from "../src/main/platform/officecli";
import { ensureOfficeCliSkill } from "../src/main/skills/OfficeCliSkill";
import { SkillsService } from "../src/main/skills/SkillsService";
import pin from "../src/shared/officecli-builds.json";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import type { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import type { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const require = createRequire(import.meta.url);
const { verifyOfficeCli } = require(resolve('scripts/verify-officecli.cjs'));
const { receiptName } = require(resolve('scripts/prepare-officecli.cjs'));
const root = mkdtempSync(join(tmpdir(), "officecli-integration-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const repo = process.cwd();
try {
  const source = resolve('scripts/skill-governance/payload/officecli');
  const skills = join(root, '.mybuddy/plugins/skills');
  assert.equal(ensureOfficeCliSkill(source, skills), 'created');
  assert(existsSync(join(skills, 'officecli/references/cli-operations.md')));
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

  // Model both platform layouts without launching another platform's executable.
  for (const platform of ['win32', 'linux'] as const) {
    const build = pin.builds[`${platform}-x64`];
    const resources = join(root, platform, 'resources with spaces');
    mkdirSync(join(resources, 'officecli'), { recursive: true });
    const exe = join(resources, 'officecli', build.binary);
    writeFileSync(exe, 'fixture');
    const env: NodeJS.ProcessEnv = { Path: 'system-path', PATH: 'second-path' };
    assert.equal(configureOfficeCli({ appRoot: root, resourcesPath: resources, packaged: true, platform, arch: 'x64', env }), exe);
    assert.equal(env.MYBUDDY_OFFICECLI, exe);
    assert(env.PATH?.startsWith(dirname(exe) + (platform === 'win32' ? ';' : ':')));
    assert.equal(env.OFFICECLI_NO_AUTO_RESIDENT, '1');
    assert.equal(env.OFFICECLI_SKIP_UPDATE, '1');
    if (platform === 'win32') assert.equal(env.Path, undefined);
    if (platform === process.platform) {
      configureOfficeCli({ appRoot: root, resourcesPath: resources, packaged: true, platform, arch: 'x64', env });
      assert.equal(env.PATH?.split(platform === 'win32' ? ';' : ':').filter(p => p === dirname(exe)).length, 1);
    }
    assert(verifyOfficeCli(resources, platform, 'x64', { vendorRoot: join(root, 'empty-vendor') }).errors.some((e: string) => e.includes('integrity receipt')));
    rmSync(exe);
    assert.throws(() => configureOfficeCli({ appRoot: root, resourcesPath: resources, packaged: true, platform, arch: 'x64', env }), /missing/);
    assert(verifyOfficeCli(resources, platform).errors.some((e: string) => e.includes('missing bundled')));
  }
  assert.equal(configureOfficeCli({ appRoot: root, resourcesPath: root, packaged: true, platform: 'darwin', arch: 'arm64', env: {} }), undefined);

  // Optional local binary smoke; CI's headless gate never downloads binaries.
  const local = join(repo, 'vendor/officecli', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'officecli.exe' : 'officecli');
  const localReceipt = join(dirname(local), receiptName);
  if (existsSync(local) && existsSync(localReceipt)) {
    const resources = join(root, 'accepted/resources');
    mkdirSync(join(resources, 'officecli'), { recursive: true });
    cpSync(local, join(resources, 'officecli', process.platform === 'win32' ? 'officecli.exe' : 'officecli'));
    cpSync(source, join(resources, 'builtin-skills/officecli'), { recursive: true });
    cpSync(resolve('integrations/magpie-agent-mybuddy'), join(resources, 'magpie-agent-mybuddy'), { recursive: true });
    assert.deepEqual(verifyOfficeCli(resources, process.platform).errors, []);
    const env = { ...process.env };
    configureOfficeCli({ appRoot: repo, resourcesPath: resources, packaged: true, env });
    // A separate task process must find the packaged executable through inherited PATH.
    const version = execFileSync(process.execPath, ['-e', 'process.stdout.write(require("node:child_process").execFileSync("officecli",["--version"],{encoding:"utf8"}))'], { cwd: root, env, encoding: 'utf8' });
    assert(version.trim(), 'bundled OfficeCLI must report a version');
    configureOfficeCli({ appRoot: repo, resourcesPath: resources, packaged: true });
    const bash = createBashToolDefinition(root);
    const bashResult = await bash.execute('officecli-native', { command: 'officecli --version && printf "OFFICECLI_SKIP_UPDATE=%s\\n" "$OFFICECLI_SKIP_UPDATE"', timeout: 10 }, undefined, undefined, undefined as never);
    assert(JSON.stringify(bashResult).includes(version.trim()), 'native task Bash must inherit bundled PATH');
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
    console.log('OfficeCLI packaged binary: task Bash, execute_code, child PATH and DOCX/XLSX/PPTX create/validate passed');
  } else console.log(`SKIP OfficeCLI local binary smoke: build-time asset not prepared (${!existsSync(local) ? 'binary missing' : 'integrity receipt missing'}); local binary not accepted; packaged gate still requires verified assets`);
  console.log('OfficeCLI skill discovery, permission filtering, disable preservation and payload rejection passed');
} finally { rmSync(root, { recursive: true, force: true }); }
