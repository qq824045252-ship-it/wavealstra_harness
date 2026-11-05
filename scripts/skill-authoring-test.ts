import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import JSZip from "jszip";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-skill-authoring-"));
const previousUserProfile = process.env.USERPROFILE;
const previousHome = process.env.HOME;
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;

async function main(): Promise<void> {
  const { SkillAuthoringService } = await import("../src/main/skills/SkillAuthoringService");
  const { SkillsService } = await import("../src/main/skills/SkillsService");
  const { ExpertService } = await import("../src/main/experts/ExpertService");
  const service = new SkillAuthoringService();
  const skills = new SkillsService();
  const experts = new ExpertService();

  const created = service.createSkillPackage({
    name: "模拟前端审查",
    description: "审查模拟前端的 ADC、参考源、电源与滤波设计",
    instructions: "1. 读取设计资料。\n2. 检查信号链。\n3. 输出风险、依据与建议。",
    triggerExamples: ["帮我 review 这个 ADC 模拟前端", "检查这个参考源设计", "分析 ADC 前端噪声预算"],
    nonTriggerExamples: ["帮我写周报", "总结会议纪要", "设计一个登录页面"],
  });
  assert.match(created.id, /^skill-[a-f0-9]{8}$/);
  assert.equal(created.validation.valid, true);
  assert.equal(created.validation.evalCount, 6);
  assert.equal(service.readSkillVersion(created.path), "1.0.0");
  assert.equal(service.readSkillEvalCases(created.path).length, 6);
  const createdMd = readFileSync(join(created.path, "SKILL.md"), "utf-8");
  assert.doesNotMatch(createdMd, /分析 ADC 前端噪声预算/, "held-out eval must not be copied into SKILL.md");
  assert.doesNotMatch(createdMd, /设计一个登录页面/, "held-out boundary eval must not be copied into SKILL.md");

  const reportsRoot = join(sandbox, ".mybuddy", "authoring-state", "reports", created.id);
  assert.equal(existsSync(reportsRoot), false);
  assert.equal(service.readLatestEvalResult(created.id), null);
  assert.equal(existsSync(reportsRoot), false, "readLatestEvalResult must be side-effect free");

  service.persistEvalResult({
    skillId: created.id,
    skillName: created.id,
    skillVersion: "1.0.0",
    evaluator: "model-judge-v1",
    note: "test",
    total: 2,
    passed: 2,
    failed: 0,
    unknown: 0,
    cases: [
      { prompt: "帮我 review 这个 ADC 模拟前端", expected: "trigger", actual: "trigger", pass: true, reason: "match" },
      { prompt: "帮我写周报", expected: "no-trigger", actual: "no-trigger", pass: true, reason: "outside" },
    ],
    evaluatedAt: Date.now(),
  });
  assert.equal(service.readLatestEvalResult(created.id)?.passed, 2);

  const customReference = join(created.path, "references", "adc-rules.md");
  writeFileSync(customReference, "# ADC Rules\n", "utf-8");
  const skillMd = join(created.path, "SKILL.md");
  const raw = readFileSync(skillMd, "utf-8");
  writeFileSync(skillMd, raw.replace("version: 1.0.0", "version: 1.0.0\nlicense: MIT\nmetadata:\n  owner: lab\n  tags:\n    - adc\n    - precision"), "utf-8");

  const snapshot = service.snapshotSkillPackage(created.id, created.path, "before-improve");
  assert.equal(snapshot.version, "1.0.0");
  assert.equal(service.listSkillRevisions(created.id).length, 1);

  const improved = service.improveSkillPackage(created.id, created.path, {
    name: "模拟前端审查",
    description: "审查模拟前端信号链并明确触发边界",
    instructions: "1. 确认输入资料。\n2. 检查 ADC、参考源、电源、滤波。\n3. 输出证据化结论。",
    triggerExamples: ["检查这个 ADC 前端噪声设计"],
    nonTriggerExamples: ["总结会议纪要"],
  });
  assert.equal(improved.validation.valid, true);
  assert.equal(service.readSkillVersion(improved.path), "1.0.1");
  assert.equal(existsSync(join(improved.path, "references", "adc-rules.md")), true, "resources must survive improvement");
  const improvedMd = readFileSync(join(improved.path, "SKILL.md"), "utf-8");
  assert.match(improvedMd, /license: MIT/);
  assert.match(improvedMd, /metadata:\n  owner: lab\n  tags:\n    - adc\n    - precision/, "nested frontmatter must remain byte-structured");
  assert.match(improvedMd, /Positive examples:\n- 检查这个 ADC 前端噪声设计/);
  assert.doesNotMatch(improvedMd, /\\n- 检查这个 ADC/);
  assert.ok(service.listSkillResources(improved.path).some((item) => item.path === "references/adc-rules.md"));

  const installed = skills.installAuthoredPackage(created.path, created.id, false, false);
  assert.equal(installed.enabled, false);
  assert.throws(() => skills.installAuthoredPackage(created.path, created.id, false, false), /已存在/);
  const replaced = skills.installAuthoredPackage(improved.path, created.id, true, true);
  assert.equal(replaced.enabled, true);
  const installedMd = readFileSync(replaced.filePath!, "utf-8");
  assert.match(installedMd, /version: 1.0.1/);
  assert.match(installedMd, /metadata:\n  owner: lab\n  tags:\n    - adc\n    - precision/, "atomic install must preserve nested frontmatter");
  assert.doesNotMatch(installedMd, /disable-model-invocation:/, "enabled authored package must remove only the disable flag");
  assert.equal(existsSync(join(replaced.filePath!, "..", "references", "adc-rules.md")), true);

  // Crash recovery is deterministic across process restarts. Before the final rename, backup wins.
  const installedDir = join(replaced.filePath!, "..");
  const skillsRoot = join(installedDir, "..");
  const interruptedBackup = join(skillsRoot, `.${created.id}.authoring-recovery.bak`);
  const interruptedStage = join(skillsRoot, `.${created.id}.authoring-recovery.tmp`);
  renameSync(installedDir, interruptedBackup);
  cpSync(interruptedBackup, interruptedStage, { recursive: true });
  writeFileSync(join(interruptedStage, ".mybuddy-swap-ready"), "ready\n", "utf-8");
  writeFileSync(join(interruptedStage, "SKILL.md"), readFileSync(join(interruptedStage, "SKILL.md"), "utf-8").replace("version: 1.0.1", "version: 9.9.9"), "utf-8");
  skills.listInstalled();
  assert.equal(existsSync(installedDir), true, "restart recovery restores last-known-good package before final rename");
  assert.equal(existsSync(interruptedBackup), false);
  assert.equal(existsSync(interruptedStage), false);
  assert.match(readFileSync(join(installedDir, "SKILL.md"), "utf-8"), /version: 1\.0\.1/);

  // After the final rename, destination wins and stale backup/commit marker are cleanup debt only.
  cpSync(installedDir, interruptedBackup, { recursive: true });
  writeFileSync(join(installedDir, ".mybuddy-swap-ready"), "ready\n", "utf-8");
  skills.listInstalled();
  assert.equal(existsSync(interruptedBackup), false, "restart recovery finalizes a committed destination");
  assert.equal(existsSync(join(installedDir, ".mybuddy-swap-ready")), false, "restart recovery removes commit marker");

  // Improve drafts use optimistic concurrency against the exact SKILL.md bytes.
  const baseHash = service.skillContentHash(replaced.filePath!);
  service.assertSkillContentHash(replaced.filePath!, baseHash);
  const beforeConcurrentEdit = readFileSync(replaced.filePath!, "utf-8");
  writeFileSync(replaced.filePath!, `${beforeConcurrentEdit}\n<!-- concurrent edit -->\n`, "utf-8");
  assert.throws(() => service.assertSkillContentHash(replaced.filePath!, baseHash), /发生变化|拒绝覆盖/);
  writeFileSync(replaced.filePath!, beforeConcurrentEdit, "utf-8");

  // Expert Builder copies capability content, not global installation state. A globally disabled Skill
  // must become active inside the Expert, while the source stays disabled and local install metadata is stripped.
  const disabledAgain = skills.setEnabled(replaced.id, false);
  const sourceDir = join(disabledAgain.filePath!, "..");
  assert.match(readFileSync(disabledAgain.filePath!, "utf-8"), /disable-model-invocation: true/);
  writeFileSync(join(sourceDir, "_skillhub_meta.json"), JSON.stringify({ source: "test", sourcePath: "C:/secret/path" }), "utf-8");
  const expert = service.createExpertPackage({
    name: "模拟硬件专家",
    description: "专门审查模拟硬件设计",
    instructions: "优先使用绑定的 Private Skills。",
    skillIds: [replaced.id],
  }, [sourceDir]);
  const expertSkillDir = join(expert.path, "skills", replaced.id);
  const expertSkillMd = readFileSync(join(expertSkillDir, "SKILL.md"), "utf-8");
  assert.doesNotMatch(expertSkillMd, /disable-model-invocation:/, "Expert Private Skill must be independently active");
  assert.equal(existsSync(join(expertSkillDir, "_user_meta.json")), false, "Private Skill must not include local user install metadata");
  assert.equal(existsSync(join(expertSkillDir, "_skillhub_meta.json")), false, "Private Skill must not include local market metadata");
  assert.match(readFileSync(disabledAgain.filePath!, "utf-8"), /disable-model-invocation: true/, "source Global Skill must remain disabled");
  const runtimeSelection = skills.resolveRuntimeSkills(sandbox, [join(expert.path, "skills")]);
  const runtimeSkill = runtimeSelection.dtos.find((item) => item.id === replaced.id);
  assert.ok(runtimeSkill, "active Expert Private Skill must remain runtime-eligible when same Global Skill is disabled");
  assert.ok(runtimeSkill!.filePath?.includes(join(expert.path, "skills")), "disabled Global Skill must not shadow active Expert Private Skill");
  const globalEnabledAgain = skills.setEnabled(disabledAgain.id, true);
  const enabledSelection = skills.resolveRuntimeSkills(sandbox, [join(expert.path, "skills")]);
  const enabledWinner = enabledSelection.dtos.find((item) => item.id === replaced.id);
  assert.equal(enabledWinner?.filePath, globalEnabledAgain.filePath, "enabled Global Skill must keep existing first-wins priority over same-named Private Skill");

  // Acceptance: authored Expert installs and exports as a portable package without local install traces.
  const installedExpert = experts.installByPath(expert.path);
  assert.equal(installedExpert.skills?.includes(replaced.id), true, "authored Expert install must retain Private Skill");
  const exportPath = await experts.exportZip(installedExpert.id);
  const zip = await JSZip.loadAsync(readFileSync(exportPath));
  const zipEntries = Object.keys(zip.files);
  const privateSkillMdEntry = zipEntries.find((name) => name.startsWith(`skills/${replaced.id}/`) && name.toLowerCase().endsWith("skill.md"));
  assert.ok(privateSkillMdEntry, "exported authored Expert must contain Private SKILL.md");
  assert.equal(zipEntries.some((name) => /_user_meta\.json$|_skillhub_meta\.json$/i.test(name)), false, "exported authored Expert must not leak local Skill metadata");
  const exportedPrivateMd = await zip.file(privateSkillMdEntry!)!.async("string");
  assert.doesNotMatch(exportedPrivateMd, /disable-model-invocation:/, "exported Private Skill must stay independently active");

  const agentServiceSource = readFileSync(join(process.cwd(), "src/main/agent/AgentService.ts"), "utf8");
  const authoring = agentServiceSource.slice(agentServiceSource.indexOf("private async runAuthoringGenerator("), agentServiceSource.indexOf("private skillAtlasSnapshot("));
  assert(authoring.includes('kind: "authoring"') && authoring.includes("instructions: systemPrompt"), "authoring persists its isolated instructions and identity");
  const auxiliary = agentServiceSource.slice(agentServiceSource.indexOf("private async openAuxiliaryRuntime("), agentServiceSource.indexOf("private runAuxiliaryText("));
  assert(auxiliary.includes('const readOnly = binding.kind === "btw"') && auxiliary.includes('const allowed = new Set(readOnly ?') && auxiliary.includes('] : [])'), "authoring has an empty tool allowlist");
  assert(auxiliary.includes("toolAllowed: permit") && auxiliary.includes("if (!permit(call.name))"), "authoring blocks tools at both discovery and execution");
  assert(!agentServiceSource.includes("new DefaultResourceLoader("), "authoring cannot discover disk extensions or context files");

  console.log("[skill-authoring-test] authoring assertions passed");
}

main().finally(() => {
  if (previousUserProfile == null) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  if (previousHome == null) delete process.env.HOME; else process.env.HOME = previousHome;
  rmSync(sandbox, { recursive: true, force: true });
});
