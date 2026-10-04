import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import {
  recordSkillAuthoringFailureRecovery,
  settleSkillAuthoringRecovery,
  skillAuthoringRecoveryTarget,
} from "../src/main/agent/SkillAuthoringFailureRecovery";
import { SkillAuthoringPartialStateError, skillAuthoringIdFromName } from "../src/main/skills/SkillAuthoringService";

const db = new Database(":memory:");
db.exec("CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES ('task');");
const failures = new ExecutionFailureRepository(db);
const ctx = { taskId: "task", executionId: "exec", assistantMessageId: "msg" };
const bridge = { resolveContext: () => ctx, failures };

try {
  assert.equal(skillAuthoringIdFromName("Origin Analysis"), "origin-analysis");
  assert.match(skillAuthoringIdFromName("中文技能"), /^skill-[a-f0-9]{8}$/);

  const intent = "Create a reusable secret workflow for instrument calibration";
  const target = skillAuthoringRecoveryTarget(intent);
  assert.match(target, /^skill-authoring:[a-f0-9]{64}$/);
  assert(!target.includes("instrument calibration"), "raw authoring intent must not be persisted in recovery identity");

  const plain = new Error("model assessment failed before package creation");
  assert.equal(recordSkillAuthoringFailureRecovery(bridge, intent, plain), false);
  assert.equal(failures.list("task").length, 0, "pre-side-effect authoring failures must not create partial-state recovery");

  const validationError = new SkillAuthoringPartialStateError(
    "validation", "origin-analysis", "C:/fixture/authoring/origin-analysis", "generated package failed validation",
  );
  assert(recordSkillAuthoringFailureRecovery(bridge, intent, validationError));
  const validationFailure = failures.list("task").find((item) => item.causeCode === "skill-authoring-validation-failed")!;
  assert.equal(validationFailure.phase, "verify");
  assert.equal(validationFailure.sideEffects, "known");
  assert.equal(validationFailure.target, target);
  assert.match(validationFailure.message, /package remains available/i);

  settleSkillAuthoringRecovery(bridge, intent, { created: false, assessment: { decision: "reuse" } });
  assert.equal(failures.list("task").find((item) => item.id === validationFailure.id)?.resolvedAt, undefined,
    "a no-create Gatekeeper outcome does not prove the generated partial package was repaired");

  settleSkillAuthoringRecovery(bridge, intent, { created: true, result: { skill: { id: "origin-analysis" } } });
  assert(failures.list("task").find((item) => item.id === validationFailure.id)?.resolvedAt,
    "successful creation of the same intent resolves its prior partial-state failure");

  const installIntent = "Create a deterministic report exporter";
  const installError = new SkillAuthoringPartialStateError(
    "install", "report-exporter", "C:/fixture/authoring/report-exporter", "generated package could not be installed",
  );
  assert(recordSkillAuthoringFailureRecovery(bridge, installIntent, installError));
  const installFailure = failures.list("task").find((item) => item.causeCode === "skill-authoring-install-failed")!;
  assert.equal(installFailure.phase, "execute");
  assert.equal(installFailure.sideEffects, "known");
  assert.equal(installFailure.target, skillAuthoringRecoveryTarget(installIntent));

  const agent = await readFile("src/main/agent/AgentService.ts", "utf8");
  const methodStart = agent.indexOf("authorSkill(input: SkillAuthoringCreateRequest)");
  const methodEnd = agent.indexOf("validateSkillPackage", methodStart);
  const method = agent.slice(methodStart, methodEnd);
  const preflight = method.indexOf("const expectedId = skillAuthoringIdFromName(input.name)");
  const existing = method.indexOf("const existing = this.skillsService.listInstalled().find");
  const packageCreate = method.indexOf("this.skillAuthoringService.createSkillPackage(input)");
  assert(preflight >= 0 && existing > preflight && packageCreate > existing,
    "installed-skill conflict preflight must occur before creating the Authoring package");
  assert(method.includes('new SkillAuthoringPartialStateError(\n        "validation"'));
  assert(method.includes('new SkillAuthoringPartialStateError(\n        "install"'));

  const builtin = await readFile("src/main/capabilities/builtin-capability-extension.ts", "utf8");
  const assembler = await readFile("src/main/agent/SessionExtensionAssembler.ts", "utf8");
  assert(builtin.includes("recordSkillAuthoringFailureRecovery(bridge.skillAuthoringRecovery, p.intent, error)"));
  assert(builtin.includes("settleSkillAuthoringRecovery(bridge.skillAuthoringRecovery, p.intent, result)"));
  assert(assembler.includes("skillAuthoringRecovery: { resolveContext: input.resolveConversationContext, failures: this.deps.executionFailures }"));

  console.log("skill authoring recovery: PASS (preflight-before-write, typed partial state, hashed intent identity, conservative settlement, main-session wiring)");
} finally { db.close(); }