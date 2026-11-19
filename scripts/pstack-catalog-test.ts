import assert from "node:assert/strict";
import {
  normalizePstackSettings, pstackDecisionLogPath, pstackExcludedModels, PSTACK_PLAYBOOKS, PSTACK_ROLES, PSTACK_ROLE_COUNT_MAX,
  PSTACK_SKILLS, resolvePstackRole, THERMOS_CRITERIA, validatePstackPlan, validatePstackSettings,
} from "../src/shared/pstack";
import { MAX_PARALLEL_TASKS } from "../src/shared/subagent-execution-policy";

const expectedSkills = `architect arena automate-me benchmark-checklist blast-radius bro correct create-verification-skill figure-it-out how interrogate maintain-verification-skill make-bot-ui no-comments poteto-help poteto-mode
principle-attack-the-premise principle-boundary-discipline principle-build-the-lever principle-encode-lessons-in-structure principle-exhaust-the-design-space principle-experience-first principle-explain-the-number principle-fix-root-causes principle-foundational-thinking principle-guard-the-context-window principle-laziness-protocol principle-make-operations-idempotent principle-migrate-callers-then-delete-legacy-apis principle-minimize-reader-load principle-model-the-domain principle-never-block-on-the-human principle-outcome-oriented-execution principle-prove-it-works principle-redesign-from-first-principles principle-separate-before-serializing-shared-state principle-sequence-verifiable-units principle-subtract-before-you-add principle-test-behavior-not-implementation principle-type-system-discipline
recall reflect setup-pstack show-me-your-work swarm tdd teach technical-writing typescript-best-practices unslop why thermo-nuclear-code-quality-review`.split(/\s+/);
const expectedBooks = "authoring-a-skill autonomous-run autopilot-full autopilot-stack babysit bug-fix eval feature hillclimb investigation multi-phase-plan opening-a-pr orchestrate pause-safely perf-issue prototype refactoring runtime-forensics session-pickup shipping trace-forensics visual-parity worktree-cleanup".split(" ");
const expectedRoles = "feature bug-fix perf-issue hillclimb judgment hardest how-explorer how-explainer why-investigators why-synthesizer reflect-tooling reflect-judgment arena-runners arena-cross-judge swarm-workers architect-runners interrogate-reviewers".split(" ");
const defaults = normalizePstackSettings();
assert.deepEqual(Object.keys(defaults.skills).sort(), expectedSkills.sort());
assert.deepEqual(Object.keys(defaults.playbooks).sort(), expectedBooks.sort());
assert.deepEqual(Object.keys(defaults.roles).sort(), expectedRoles.sort());
assert.equal(PSTACK_ROLE_COUNT_MAX, MAX_PARALLEL_TASKS);
assert.equal(PSTACK_SKILLS.length, expectedSkills.length);
assert.equal(PSTACK_PLAYBOOKS.length, expectedBooks.length);
assert.equal(PSTACK_ROLES.length, expectedRoles.length);
assert.equal(THERMOS_CRITERIA.length, 8);
assert.deepEqual(validatePstackSettings(defaults), []);
assert.deepEqual(normalizePstackSettings(JSON.parse(JSON.stringify(defaults))), defaults);

for (const entry of [...PSTACK_SKILLS, ...PSTACK_PLAYBOOKS]) {
  const ids = entry.parameters.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate parameter in ${entry.id}`);
  const stages = entry.stages ?? [];
  assert.equal(new Set(stages.map(s => s.id)).size, stages.length, `duplicate stage in ${entry.id}`);
  for (const stage of stages) {
    assert.ok(stage.instructions && stage.label);
    assert.ok(!stage.roleId || expectedRoles.includes(stage.roleId), stage.roleId);
    for (const skill of stage.skillIds) assert.ok(expectedSkills.includes(skill), skill);
  }
}

const configured = normalizePstackSettings({
  skills: { "setup-pstack": { parameters: { budget: "medium", excludeModels: "demo/a， demo/b\n demo/a" } } },
  playbooks: { feature: { enabled: false }, babysit: { parameters: { intervalSeconds: 42 } } },
  roles: { "architect-runners": { isolation: "worktree" }, "interrogate-reviewers": { model: "fixture/one", effort: "off" } },
  thermos: { changedLines: 17, criteria: { "file-growth": false }, reviewerRole: "judgment" },
});
assert.equal(resolvePstackRole(configured, "architect-runners").effort, "high");
assert.equal(resolvePstackRole(configured, "interrogate-reviewers").effort, "off");
assert.equal(resolvePstackRole(configured, "architect-runners").isolation, "worktree");
assert.deepEqual([...pstackExcludedModels(configured)], ["demo/a", "demo/b"]);
assert.equal(configured.playbooks.feature.enabled, false);
assert.equal(configured.playbooks.babysit.parameters.intervalSeconds, 42);
assert.equal(configured.thermos.criteria["file-growth"], false);
assert.equal(configured.thermos.changedLines, 17);
assert.equal(configured.thermos.reviewerRole, "judgment");
assert.deepEqual(validatePstackSettings(configured), []);
assert.notDeepEqual(configured, defaults);
assert.deepEqual(defaults, normalizePstackSettings());
assert.throws(() => resolvePstackRole(defaults, "constructor"));

const corrupt = JSON.parse('{"skills":{"__proto__":{"enabled":true},"tdd":{"enabled":"yes"},"setup-pstack":{"parameters":{"budget":"fake"}}},"roles":{"architect-runners":{"model":"diverse","count":1,"effort":"unknown"}},"thermos":{"specialCases":-1,"reviewerRole":"feature"},"playbooks":{"eval":{"parameters":{"rubricCount":2}}}}');
const errors = validatePstackSettings(corrupt).join("\n");
for (const field of ["skills.__proto__", "skills.tdd.enabled", "parameters.budget", "roles.architect-runners.count", "roles.architect-runners.effort", "thermos.specialCases", "thermos.reviewerRole", "parameters.rubricCount"]) {
  assert.ok(errors.includes(field), field);
}
assert.deepEqual(normalizePstackSettings(corrupt), defaults);
for (const value of [null, [], "on", 1]) assert.ok(validatePstackSettings(value).length);
assert.equal(pstackDecisionLogPath(".audit\\history.tsv"), ".audit/history.tsv");
for (const file of [".tsv", "C:escaped.tsv", "/tmp/trail.tsv", "one/../out.tsv", "one/.git/out.tsv", "NUL.tsv", "notes.md", "one\\\\x.tsv"]) {
  const cfg = { skills: { "show-me-your-work": { parameters: { logPath: file } } } };
  assert.throws(() => pstackDecisionLogPath(file), Error, file);
  assert.ok(validatePstackSettings(cfg).some(reason => reason.includes(".logPath")), file);
  assert.equal(normalizePstackSettings(cfg).skills["show-me-your-work"].parameters.logPath, "decisions.tsv");
}

const plan = [
  "# 接入导入器", "## How to read this", "每个复选框完成后勾选并附证据。", "## Program checklist",
  "### Arm the program", "核对用户授权。", "### Spawn owners", "分配导入器负责人。",
  "### PR mechanics", "确认分支和基线。", "### Verdict and merge", "记录实际版本与验证回执。",
  "### Boot recipe", "在隔离工作区启动测试环境。", "## 实现导入器", "**Depends on.** None",
  "**Files.**", "- [ ] 修改 importer.ts。", "**Build.**", "- [ ] 接入解析函数。", "**You see.**", "- [ ] 文件导入成功。",
  "**Verify, unit.**", "- [ ] 使用正确或损坏的文件两次测试。", "**Verify, live.** 当前 head，模型：demo/a",
  "- [ ] Lane 1. 导入健康文件。保存 `valid.png`。通过条件：看见导入结果。",
  "- [ ] Lane 2. 导入损坏文件。保存 `invalid.png`。通过条件：看见具体错误。",
  "**Verify, perf.**", "- [ ] Metric. 总耗时", "- [ ] Probe. 运行导入基准", "- [ ] Baseline. 本机采样", "- [ ] Rule. 时间不超过既有预算",
  "**Review gate.** None.", "**Merge.**", "- [ ] 核对授权和当前 head。", "## Close the program", "- [ ] 核实全部产物。",
  "## Appendix A. Prototype evidence", "导入器的基线输出已记录。", "## Appendix B. Alternatives rejected", "拒绝重复保存中间副本。",
  "## Appendix C. Risks", "记录损坏文件的恢复路径。", "## Appendix D. Links and reading list", "见 importer.ts。",
].join("\n");
const planSettings = normalizePstackSettings({ playbooks: { "multi-phase-plan": { parameters: { liveLanes: 2 } } } });
assert.deepEqual(validatePstackPlan(plan, planSettings), []);
assert.ok(validatePstackPlan(plan, defaults).some(reason => reason.includes("1 到 10")));
assert.ok(validatePstackPlan(plan.replace("Lane 2.", "Lane 1."), planSettings).some(reason => reason.includes("重复")));
assert.ok(validatePstackPlan(plan.replace("保存 `valid.png`。", ""), planSettings).some(reason => reason.includes("证据位置")));
assert.ok(validatePstackPlan(plan.replace("**Files.**", "**Wrong.**"), planSettings).length);
assert.ok(validatePstackPlan(plan.replace("**Review gate.** None.", "**Review gate.** 用户确认"), planSettings).some(reason => reason.includes("视频")));
assert.ok(validatePstackPlan("~~~md\n" + plan + "\n~~~", planSettings).length);
console.log("PASS native pstack catalog: 52 skills, 23 playbooks, 17 native roles, 8 Thermos criteria, configuration and validation");
