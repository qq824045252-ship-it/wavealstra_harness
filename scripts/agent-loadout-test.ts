import { diagnoseSkillReadiness, diagnoseSessionModel } from "../src/main/agent/SessionDiagnostics";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadoutTextSimilarity, resolveAgentLoadout, resolveEffectiveLoadoutSelection } from "../src/main/agent/AgentLoadoutResolver";

const root = mkdtempSync(join(tmpdir(), "mybuddy-agent-loadout-"));
process.env.MYBUDDY_HOME = root;
process.env.USERPROFILE = root;
process.env.HOME = root;

try {
  // AppDatabase/path modules must load only after MYBUDDY_HOME is isolated.
  const { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } = await import("../src/main/db/AppDatabase");
  const { AgentLoadoutObservationService, AGENT_LOADOUT_MAX_AGE_MS, AGENT_LOADOUT_MAX_RECORDS_PER_TASK } = await import("../src/main/agent/AgentLoadoutObservationService");
  const { MemoryService } = await import("../src/main/memory/MemoryService");

  const db = new AppDatabase();
  assert.equal(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
  db.upsertSpace({ id: "space-loadout", name: "Loadout", archived: false });
  db.upsertTask({ id: "task-loadout", title: "Review GitHub bridge code", spaceId: "space-loadout", status: "completed", updatedAt: Date.now() });

  assert(loadoutTextSimilarity("review github code", "GitHub code review") > 0.2, "deterministic relevance should match code review wording");

  const loadout = resolveAgentLoadout({
    taskId: "task-loadout",
    query: "review github bridge code",
    mode: "coding",
    workspaceId: "space-loadout",
    tagId: "code-review",
    candidates: [
      {
        kind: "expert", id: "review-expert", label: "Review Expert", description: "code review",
        allowed: false, blockReason: "project_policy_denied", projectRecommended: true,
      },
      {
        kind: "skill", id: "learned-review-good", label: "learned-review-good", description: "review github bridge code",
        allowed: true, actual: true, sourceMemoryIds: ["mem-procedure"],
        effectiveness: { invocations: 8, completionRate: 0.95, helpfulFeedback: 5, needsRevisionFeedback: 0, incorrectFeedback: 0 },
      },
      {
        kind: "skill", id: "learned-review-bad", label: "learned-review-bad", description: "review github bridge code",
        allowed: true,
        effectiveness: { invocations: 8, completionRate: 0.45, helpfulFeedback: 0, needsRevisionFeedback: 2, incorrectFeedback: 3 },
      },
      {
        kind: "connector", id: "github", label: "GitHub", description: "github connector",
        allowed: true, projectRecommended: true,
      },
      {
        kind: "mcp", id: "pi", label: "pi", description: "coding runtime",
        allowed: false, blockReason: "tag_policy_denied", tagRecommended: true,
      },
    ],
    modelSuggestion: "openai/gpt-5.6-sol",
    permissionSuggestion: "readonly",
    memoryContext: {
      items: [{
        id: "mem-procedure", kind: "procedure", title: "Bridge review", content: "review bridge changes", scopeType: "workspace", scopeId: "space-loadout",
        importance: 2, confidence: 0.9, score: 0.9, reasons: ["query"],
      }],
      scenarioIds: ["scenario-review"], profileIds: ["profile-workspace"],
    },
  });

  const byId = new Map(loadout.capabilities.map((item) => [item.id, item]));
  assert.equal(byId.get("review-expert")?.recommended, true, "Project recommendation should survive as recommendation");
  assert.equal(byId.get("review-expert")?.blocked, true, "Policy denial must remain a hard block");
  assert.equal(byId.get("pi")?.blocked, true, "Required/recommended MCP cannot bypass policy");
  assert.equal(byId.get("learned-review-good")?.actual, true);
  assert((byId.get("learned-review-good")?.score ?? 0) > (byId.get("learned-review-bad")?.score ?? 0), "good effectiveness should outrank corrected/failed skill");
  assert(loadout.context.memoryIds.includes("mem-procedure"));
  assert.equal(loadout.modelSuggestion, "openai/gpt-5.6-sol");
  assert.equal(loadout.permissionSuggestion, "readonly");

  const fixture = { ...loadout, capabilities: [
    ["recommended", false, false], ["denied", true, true], ["missing-cli", true, false],
    ["untried", true, false], ["verified", true, false],
  ].map(([id, actual, blocked]) => ({
    kind: "skill" as const, id: String(id), label: String(id), score: 1,
    recommended: true, actual: Boolean(actual), blocked: Boolean(blocked), evidence: [],
  })) };
  const readiness = diagnoseSkillReadiness({
    recommendation: fixture, installedIds: ["denied", "missing-cli", "untried", "verified"],
    whitelistIds: ["missing-cli", "untried", "verified"], readIds: ["verified"],
    evidence: {
      "missing-cli": { dependency: { state: "failed", reason: "officecli executable missing", checkedAt: 1 }, trial: { state: "unknown" } },
      verified: { dependency: { state: "passed", reason: "target environment --version", checkedAt: 2 }, trial: { state: "passed", at: 3, evidence: "fixture execution result" } },
    },
  });
  assert.equal(readiness[0].installed, false);
  assert.equal(readiness[1].policyAllowed, false);
  assert.equal(readiness[1].whitelisted, false);
  assert.equal(readiness[2].dependency.state, "failed");
  assert.equal(readiness[3].trial.state, "unknown");
  assert.equal(readiness[4].trial.at, 3);
  assert.equal(readiness[4].readThisTurn, true);
  for (const source of ["explicit", "mode_suggestion", "global_default", "restored_or_sdk"]) {
    const diagnostic = diagnoseSessionModel({ requested: "p/model", actual: { provider: "p", id: "model" }, source, reasoning: "high" });
    assert.equal(diagnostic.actualId, "p/model");
    assert.equal(diagnostic.source, source);
  }
  assert(diagnoseSessionModel({ source: "restored_or_sdk", reasoning: "off" }).fallbackReason);
  assert(diagnoseSessionModel({ requested: "invalid", actual: { provider: "p", id: "restored" }, source: "task", reasoning: "off" }).fallbackReason);

  const effective = resolveEffectiveLoadoutSelection(loadout, {
    requiredMcpIds: ["pi"],
  });
  assert.equal(effective.basis, "effective_selection");
  assert(effective.effectiveSelection, "effective selection should be materialized");
  assert(effective.effectiveSelection!.skillIds.includes("learned-review-good"), "relevant current skill should be selected");
  assert(!effective.effectiveSelection!.skillIds.includes("learned-review-bad"), "lower-ranked current skill may be narrowed");
  assert.equal(effective.effectiveSelection!.connectorIds.includes("github"), false, "not-current connector must never be auto-added");
  assert.equal(effective.effectiveSelection!.mcpIds.includes("pi"), false, "blocked MCP must never be auto-enabled even when required");
  assert(effective.capabilities.find((item) => item.id === "review-expert")?.selected === false, "blocked expert stays unselected");

  const chineseExplicit = resolveEffectiveLoadoutSelection(resolveAgentLoadout({
    taskId: "task-loadout", query: "请用 officecli 帮我核对表格数字", mode: "working",
    candidates: [
      { kind: "skill", id: "officecli", label: "officecli", description: "Office documents", allowed: true, actual: true },
      { kind: "skill", id: "low-relevance", label: "unrelated astronomy", allowed: true, actual: true },
      { kind: "skill", id: "blocked", label: "officecli", allowed: false, actual: true },
      { kind: "skill", id: "not-current", label: "officecli", allowed: true, actual: false },
    ],
  }), { explicitSkillId: "low-relevance" });
  assert(chineseExplicit.effectiveSelection?.skillIds.includes("low-relevance"), "explicit low-relevance skill survives narrowing for Chinese request");
  assert(!chineseExplicit.effectiveSelection?.skillIds.includes("blocked"), "blocked skill cannot be selected");
  assert(!chineseExplicit.effectiveSelection?.skillIds.includes("not-current"), "actual=false cannot be selected");

  const fallbackSelection = resolveEffectiveLoadoutSelection(resolveAgentLoadout({
    taskId: "task-loadout", query: "continue", mode: "coding",
    candidates: [
      { kind: "skill", id: "s1", label: "S1", allowed: true, actual: true },
      { kind: "skill", id: "s2", label: "S2", allowed: true, actual: true },
    ],
  }));
  assert.deepEqual(fallbackSelection.effectiveSelection?.skillIds, ["s1", "s2"], "low-signal continuation keeps current allowed set");

  const explicitOverflow = resolveAgentLoadout({
    taskId: "task-loadout", query: "unrelated", mode: "coding",
    candidates: ["a", "b", "c", "d"].map((id) => ({
      kind: "expert" as const, id: `expert-${id}`, label: `Expert ${id}`, allowed: true, projectRecommended: true,
    })),
  });
  assert.equal(
    explicitOverflow.capabilities.filter((item) => item.kind === "expert" && item.recommended).length,
    4,
    "explicit Mode/Project/Tag recommendations must not be truncated by inferred Top-K quota",
  );

  const observations = new AgentLoadoutObservationService(db);
  const obs = observations.recordAcceptedTurn({
    taskId: "task-loadout", userMessageId: "u1", assistantMessageId: "a1", recommendation: loadout,
  });
  assert(obs.matchedActual.some((item) => item.id === "learned-review-good"), "recommended + actual should be recorded as matchedActual, not user acceptance");
  assert(obs.notSelected.some((item) => item.id === "github"), "recommended but not actual should be not-selected, not human-rejected");
  assert(obs.blocked.some((item) => item.id === "review-expert"), "blocked recommendation should stay separate from rejected");
  assert.equal("queryExcerpt" in obs, false, "observational telemetry does not persist a raw Prompt excerpt");
  assert(obs.recommended.some((item) => item.id === "learned-review-good" && item.evidence.length > 0), "historical recommendation preserves evidence");
  assert.deepEqual(obs.context.scenarioIds, ["scenario-review"], "historical observation preserves scenario grounding");
  assert.deepEqual(obs.context.profileIds, ["profile-workspace"], "historical observation preserves profile grounding");
  assert(obs.context.memoryIds.includes("mem-procedure"), "historical observation preserves Memory grounding");
  const loadoutColumns = db.connection.prepare("PRAGMA table_info(agent_loadout_observations)").all() as Array<{ name: string }>;
  assert.equal(loadoutColumns.some((column) => column.name === "query_excerpt"), false, "current schema removes raw query_excerpt storage");
  assert.equal(loadoutColumns.some((column) => column.name === "context_json"), true, "current schema stores bounded recommendation context");
  const memories = new MemoryService(db, { semantic: false });
  const previewMemory = memories.create({
    kind: "procedure", title: "Loadout preview memory", content: "review github bridge code with a stable checklist",
    scopeType: "workspace", scopeId: "space-loadout", explicit: true, sourceType: "manual",
  });
  const beforeRecall = memories.get(previewMemory.id)?.recallCount ?? -1;
  memories.resolveContext({ taskId: "task-loadout", workspaceId: "space-loadout", query: "review github bridge", trackRecall: false });
  assert.equal(memories.get(previewMemory.id)?.recallCount, beforeRecall, "read-only Loadout preview must not mutate Memory recall counters");

  observations.markSkillUsed("task-loadout", "a1", "learned-review-good");
  observations.markSkillUsed("task-loadout", "a1", "learned-review-good");
  observations.markOutcome("task-loadout", "a1", "completed");
  const finished = observations.getByTurn("task-loadout", "a1")!;
  assert.deepEqual(finished.usedSkillIds, ["learned-review-good"], "actual Skill use must be idempotent");
  assert.equal(finished.outcome, "completed");
  const retryAt = Date.now() + 10;
  const retried = observations.recordAcceptedTurn({
    taskId: "task-loadout", userMessageId: "u1-retry", assistantMessageId: "a1", recommendation: loadout, at: retryAt,
  });
  assert.equal(retried.outcome, "pending", "reused assistant id starts a fresh observation lifecycle");
  assert.deepEqual(retried.usedSkillIds, [], "reused assistant id must not inherit prior actually-used Skills");
  assert.equal(retried.completedAt, undefined, "reused assistant id clears prior completion timestamp");
  assert.equal(retried.userMessageId, "u1-retry", "reused assistant id refreshes user-message lineage");
  assert.equal(retried.createdAt, retryAt, "reused assistant id refreshes lifecycle start time");

  observations.clear("task-loadout");
  const retentionNow = Date.now() + 10_000;
  observations.recordAcceptedTurn({
    taskId: "task-loadout", userMessageId: "u-old", assistantMessageId: "a-old", recommendation: loadout,
    at: retentionNow - AGENT_LOADOUT_MAX_AGE_MS - 1,
  });
  observations.recordAcceptedTurn({
    taskId: "task-loadout", userMessageId: "u-new", assistantMessageId: "a-new", recommendation: loadout, at: retentionNow,
  });
  assert.equal(observations.getByTurn("task-loadout", "a-old"), undefined, "90-day retention prunes stale Loadout observations");
  observations.clear("task-loadout");
  for (let index = 0; index < AGENT_LOADOUT_MAX_RECORDS_PER_TASK + 7; index += 1) {
    observations.recordAcceptedTurn({
      taskId: "task-loadout", userMessageId: `u-ret-${index}`, assistantMessageId: `a-ret-${index}`, recommendation: loadout, at: retentionNow + index,
    });
  }
  assert.equal(observations.list("task-loadout", 999).length, AGENT_LOADOUT_MAX_RECORDS_PER_TASK, "per-task Loadout retention is count-bounded");
  const clearedObservations = observations.clear("task-loadout");
  assert.equal(clearedObservations, AGENT_LOADOUT_MAX_RECORDS_PER_TASK, "Loadout telemetry can be explicitly cleared");
  observations.recordAcceptedTurn({ taskId: "task-loadout", userMessageId: "u-fk", assistantMessageId: "a-fk", recommendation: loadout });

  const serviceSource = readFileSync(join(process.cwd(), "src/main/agent/AgentLoadoutObservationService.ts"), "utf-8");
  for (const forbidden of ["installLearnedSkill", "setSkillEnabled", "setEnabled(", "MemoryService", "memoryService."]) {
    assert.equal(serviceSource.includes(forbidden), false, `observation service must not mutate runtime/memory: ${forbidden}`);
  }

  // FK lifecycle: even a direct SQL task delete must remove observational telemetry.
  db.connection.prepare("DELETE FROM tasks WHERE id=?").run("task-loadout");
  assert.equal(observations.list("task-loadout", 10).length, 0, "task FK cascade removes loadout telemetry");

  // Development contract: incompatible DB versions are discarded, not migrated.
  db.upsertTask({ id: "task-migrate", title: "discard me", status: "completed", updatedAt: Date.now() });
  db.connection.pragma("user_version = 24");
  db.close();
  const migrated = new AppDatabase();
  assert.equal(migrated.schemaVersion, 27);
  assert.equal(migrated.getTask("task-migrate"), undefined, "v24 data is intentionally discarded");
  const table = migrated.connection.prepare("SELECT 1 ok FROM sqlite_master WHERE type='table' AND name='agent_loadout_observations'").get() as { ok: number } | undefined;
  assert.equal(table?.ok, 1, "destructive reset materializes current Loadout schema");
  migrated.close();

  console.log("agent-loadout-test: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
