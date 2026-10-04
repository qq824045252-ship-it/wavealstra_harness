import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  SKILL_AUTHORING_ASSESS_META_PROMPT,
  SKILL_AUTHORING_META_PROMPT,
  parseSkillAuthoringAssessment,
} from "../src/main/skills/SkillAuthoringGenerator";
import { SkillPackageValidator } from "../src/main/skills/SkillAuthoringService";
import { activateResolvedSessionTools } from "../src/main/agent/PromptAssembly";
import { isSideEffectTool } from "../src/shared/pi-event-mapper";
import { MUTATING_BUILTIN_TOOLS, NATIVE_CAPABILITY_TOOL_NAMES } from "../src/shared/native-tools";

const allowed = new Set(["origin-analysis"]);
const create = parseSkillAuthoringAssessment(JSON.stringify({
  decision: "create",
  reason: "reusable workflow",
  warnings: [],
  draft: {
    name: "PCB Review",
    description: "Review PCB repeatedly",
    instructions: "Workflow\n1. Inspect\n2. Report\nOutput Contract\nReturn findings",
    triggerExamples: ["review pcb"],
    nonTriggerExamples: ["explain pcb"],
  },
}), allowed);
assert.equal(create.decision, "create");
assert.equal(create.draft?.name, "PCB Review");

for (const decision of ["reuse", "improve-existing"] as const) {
  const parsed = parseSkillAuthoringAssessment(JSON.stringify({
    decision,
    reason: "near-neighbor",
    targetSkillId: "origin-analysis",
    warnings: [],
  }), allowed);
  assert.equal(parsed.targetSkillId, "origin-analysis");
}

assert.throws(() => parseSkillAuthoringAssessment(JSON.stringify({
  decision: "reuse",
  reason: "fabricated",
  targetSkillId: "not-installed",
  warnings: [],
}), allowed), /有效的现有 Skill id/);
assert.throws(() => parseSkillAuthoringAssessment(JSON.stringify({
  decision: "create",
  reason: "missing draft",
  warnings: [],
}), allowed), /未返回 draft/);

const noSkill = parseSkillAuthoringAssessment(JSON.stringify({
  decision: "no-skill",
  reason: "one-off task",
  warnings: [],
}), allowed);
assert.equal(noSkill.decision, "no-skill");
assert.match(SKILL_AUTHORING_ASSESS_META_PROMPT, /No-Skill Gate/);
assert.match(SKILL_AUTHORING_ASSESS_META_PROMPT, /Near-neighbor/i);
assert.match(SKILL_AUTHORING_ASSESS_META_PROMPT, /Context Budget/);
assert.match(SKILL_AUTHORING_META_PROMPT, /Output Contract/);

assert(NATIVE_CAPABILITY_TOOL_NAMES.includes("skill_authoring_assess"));
assert(NATIVE_CAPABILITY_TOOL_NAMES.includes("skill_authoring_create"));
assert(!(MUTATING_BUILTIN_TOOLS as readonly string[]).includes("skill_authoring_assess"));
assert((MUTATING_BUILTIN_TOOLS as readonly string[]).includes("skill_authoring_create"));
assert.equal(isSideEffectTool("skill_authoring_assess", { intent: "x" }), false);
assert.equal(isSideEffectTool("skill_authoring_create", { intent: "x" }), true);

let activeTools: string[] = [];
const fakeSession = {
  getActiveToolNames: () => [] as string[],
  getAllTools: () => [{ name: "skill_authoring_assess" }, { name: "skill_authoring_create" }],
  setActiveToolsByName: (names: string[]) => { activeTools = names; },
};
activateResolvedSessionTools(fakeSession, {});
assert(activeTools.includes("skill_authoring_assess"));
assert(activeTools.includes("skill_authoring_create"));
activeTools = [];
activateResolvedSessionTools(fakeSession, { excludeTools: ["skill_authoring_create"] });
assert(activeTools.includes("skill_authoring_assess"));
assert(!activeTools.includes("skill_authoring_create"));

const root = mkdtempSync(join(tmpdir(), "mybuddy-meta-skill-"));
try {
  mkdirSync(join(root, "evals"));
  writeFileSync(join(root, "SKILL.md"), `---\nname: oversized\ndescription: test\n---\n\n# Skill\n\n${"x".repeat(8100)}`, "utf8");
  writeFileSync(join(root, "evals", "trigger.json"), JSON.stringify({ cases: [{ prompt: "x", expected: "trigger" }] }), "utf8");
  const validation = new SkillPackageValidator().validate(root);
  assert(validation.warnings.some((warning) => warning.includes("初始上下文偏大")));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("meta-skill-authoring-test: ok");
