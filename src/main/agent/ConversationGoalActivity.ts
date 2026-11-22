import type Database from "better-sqlite3";
import type { GoalActivityAdmission, GoalActivityCost, GoalActivityDto, GoalActivityIdentity, GoalActivityOwner, GoalActivityRun, GoalActivitySkill } from "../../shared/conversation-goal-activity";
import type { ModelRequestDiagnostic, ReportedTokenUsage } from "../../shared/task-diagnostics";

type Identity = GoalActivityIdentity & { taskId: string };
type OwnedRun = Omit<GoalActivityRun, "requestCount" | "retryCount"> & { goalId: string; assistantMessageIds: string[] };

function useId(value: GoalActivityIdentity & { taskId: string }): string {
  return JSON.stringify([value.taskId, value.conversationId, value.generationTaskId]);
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Goal ownership is frozen at native admission. Reads never infer it from clocks,
 * mutable task state, or matching text. Repeated native requests share one generation. */
export class ConversationGoalActivity {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_goal_generations (
      task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation_id INTEGER NOT NULL,
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      metadata TEXT NOT NULL CHECK(json_valid(metadata)),
      outcome TEXT,
      PRIMARY KEY(task_id, conversation_id, generation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_generations_work ON conversation_goal_generations(work_id);
    CREATE TABLE IF NOT EXISTS conversation_goal_auxiliary_scopes (
      execution_scope TEXT PRIMARY KEY, task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation_id INTEGER NOT NULL,
      FOREIGN KEY(task_id, conversation_id, generation_id) REFERENCES conversation_goal_generations(task_id, conversation_id, generation_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS conversation_goal_learned_skills (
      task_id TEXT NOT NULL, conversation_id TEXT NOT NULL, generation_id INTEGER NOT NULL,
      evidence_key TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
      PRIMARY KEY(task_id, conversation_id, generation_id, evidence_key),
      FOREIGN KEY(task_id, conversation_id, generation_id) REFERENCES conversation_goal_generations(task_id, conversation_id, generation_id) ON DELETE CASCADE
    );`);
  }

  admit(taskId: string, admission: GoalActivityAdmission): void {
    const parent = admission.parent && this.generation({ taskId, ...admission.parent });
    const owner = admission.inputs?.[0]?.owner;
    const direct = Boolean(owner && admission.inputs?.every(input =>
      input.owner.goalId === owner.goalId && input.owner.intentRevision === owner.intentRevision));
    const goalId = parent?.goalId ?? (direct ? owner?.goalId : undefined);
    const intentRevision = parent?.intentRevision ?? (direct ? owner?.intentRevision : undefined);
    if (!goalId || intentRevision === undefined) return;
    if (!this.db.prepare("SELECT 1 FROM work_conversations WHERE work_id=? AND conversation_id=?").get(goalId, taskId)) return;
    const metadata = {
      intentRevision,
      parent: parent ? admission.parent : undefined,
      child: parent ? admission.child : undefined,
      assistantMessageIds: direct ? [...new Set(admission.inputs!.map(input => input.assistantMessageId))] : [],
    };
    this.db.prepare(`INSERT OR IGNORE INTO conversation_goal_generations
      (task_id, conversation_id, generation_id, work_id, metadata) VALUES(?,?,?,?,?)`)
      .run(taskId, admission.conversationId, admission.generationTaskId, goalId, JSON.stringify(metadata));
  }

  generation(identity: Identity): OwnedRun | undefined {
    const row = this.db.prepare(`SELECT work_id,metadata,outcome FROM conversation_goal_generations
      WHERE task_id=? AND conversation_id=? AND generation_id=?`).get(identity.taskId, identity.conversationId, identity.generationTaskId) as
      { work_id: string; metadata: string; outcome: GoalActivityRun["status"] | null } | undefined;
    if (!row) return undefined;
    return { ...identity, goalId: row.work_id, ...JSON.parse(row.metadata), status: row.outcome ?? undefined };
  }

  recordAuxiliaryScope(scope: string, parent: Identity): void {
    this.db.prepare(`INSERT OR IGNORE INTO conversation_goal_auxiliary_scopes(execution_scope,task_id,conversation_id,generation_id)
      SELECT ?,task_id,conversation_id,generation_id FROM conversation_goal_generations
      WHERE task_id=? AND conversation_id=? AND generation_id=?`).run(scope, parent.taskId, parent.conversationId, parent.generationTaskId);
  }

  settle(identity: Identity, outcome: Exclude<GoalActivityRun["status"], undefined>, messageId?: string): GoalActivityOwner | undefined {
    const run = this.generation(identity);
    if (!run) return undefined;
    if (messageId && !run.assistantMessageIds.includes(messageId)) run.assistantMessageIds.push(messageId);
    const { intentRevision, parent, child, assistantMessageIds, goalId, returned } = run;
    this.db.prepare(`UPDATE conversation_goal_generations SET outcome=COALESCE(outcome,?), metadata=?
      WHERE task_id=? AND conversation_id=? AND generation_id=?`).run(outcome,
      JSON.stringify({ intentRevision, parent, child, assistantMessageIds, returned }),
      identity.taskId, identity.conversationId, identity.generationTaskId);
    return { goalId, intentRevision };
  }

  ownerForMessage(taskId: string, conversationId: string, messageId: string): GoalActivityOwner | undefined {
    const result = this.db.prepare(`SELECT work_id AS goalId, json_extract(metadata,'$.intentRevision') AS intentRevision
      FROM conversation_goal_generations WHERE task_id=? AND conversation_id=?
      AND EXISTS(SELECT 1 FROM json_each(metadata,'$.assistantMessageIds') WHERE value=?) ORDER BY generation_id DESC LIMIT 1`)
      .get(taskId, conversationId, messageId) as GoalActivityOwner | undefined;
    return result;
  }

  recordTool(identity: Identity, tool: { name: string; callId: string; details: unknown }): void {
    const run = this.generation(identity);
    const details = asObject(tool.details);
    if (!run || !details) return;
    if (tool.name !== "subagent" && tool.name !== "pstack_delegate") return;
    const results = tool.name === "subagent" ? details.results : details.participants;
    if (!Array.isArray(results)) return;
    for (const value of results) {
      const result = asObject(value);
      if (!result || !Number.isSafeInteger(result.nativeConversationId) || typeof result.subagentId !== "string"
        || typeof result.status !== "string") continue;
      const returned = { status: result.status, outcome: typeof result.outcome === "string" ? result.outcome : undefined, toolCallId: tool.callId };
      this.db.prepare(`UPDATE conversation_goal_generations SET metadata=json_set(metadata,'$.returned',json(?))
        WHERE task_id=? AND conversation_id=? AND work_id=?
        AND json_extract(metadata,'$.child.id')=?
        AND json_extract(metadata,'$.parent.conversationId')=?
        AND json_extract(metadata,'$.parent.generationTaskId')=?`)
        .run(JSON.stringify(returned), identity.taskId, String(result.nativeConversationId), run.goalId,
          result.subagentId, identity.conversationId, identity.generationTaskId);
    }
  }

  recordSkill(identity: Identity, key: string, evidence: GoalActivitySkill, pathKey?: string): void {
    if (!this.generation(identity)) return;
    this.db.prepare("INSERT OR IGNORE INTO conversation_goal_learned_skills VALUES (?,?,?,?,?)")
      .run(identity.taskId, identity.conversationId, identity.generationTaskId, key, JSON.stringify({ ...evidence, pathKey }));
  }

  authoredSkillAtPath(pathKey: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_goal_learned_skills
      WHERE json_extract(evidence_json,'$.pathKey')=? LIMIT 1`).get(pathKey));
  }

  recordAuthoredSkillRead(pathKey: string, fingerprint: string, at: number): void {
    this.db.prepare(`UPDATE conversation_goal_learned_skills SET evidence_json=json_set(evidence_json,'$.laterInvokedAt',?)
      WHERE json_extract(evidence_json,'$.pathKey')=? AND json_extract(evidence_json,'$.installedFingerprint')=?
      AND json_extract(evidence_json,'$.createdAt')<=? AND json_extract(evidence_json,'$.laterInvokedAt') IS NULL`)
      .run(at, pathKey, fingerprint, at);
  }


  read(goalId: string, diagnostics: (taskId: string, generations: GoalActivityIdentity[]) => ModelRequestDiagnostic[],
    learned: (taskId: string, assistantMessageId: string) => GoalActivitySkill[],
    auxiliary: (taskId: string) => ModelRequestDiagnostic[] = () => [],
  ): GoalActivityDto {
    const rows = this.db.prepare(`SELECT task_id, conversation_id, generation_id, metadata, outcome
      FROM conversation_goal_generations WHERE work_id=? ORDER BY rowid`).all(goalId) as
      Array<{ task_id: string; conversation_id: string; generation_id: number; metadata: string; outcome: GoalActivityRun["status"] | null }>;
    const owned: OwnedRun[] = rows.map(row => ({ taskId: row.task_id, conversationId: row.conversation_id,
      generationTaskId: row.generation_id, ...JSON.parse(row.metadata), goalId, status: row.outcome ?? undefined }));
    const identified = new Set(owned.map(useId));
    const requests = new Map<string, ModelRequestDiagnostic[]>();
    for (const taskId of new Set(owned.map(run => run.taskId))) {
      for (const req of diagnostics(taskId, owned.filter(run => run.taskId === taskId))) {
        if (req.taskId !== taskId || req.executionScope !== taskId || req.sourceKind === "auxiliary") continue;
        const id = useId({ ...req, taskId });
        if (!identified.has(id)) continue;
        const group = requests.get(id) ?? [];
        group.push(req);
        requests.set(id, group);
      }
    }
    const knownTokens: ReportedTokenUsage = { input: null, output: null, cacheRead: null, cacheWrite: null };
    let knownCostUsd: number | null = null;
    const tokenFieldCoverage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let requestsWithUsage = 0, requestsWithCompleteUsage = 0, requestsWithCost = 0;
    let observedRequests = 0, retryCount = 0, missingGenerationObservations = 0;
    const emptyCost = (): GoalActivityCost => ({ knownCostUsd: null, observedRequests: 0, requestsWithCost: 0,
      providerReportedRequests: 0, estimatedRequests: 0, missingGenerationObservations: 0 });
    const costBySource = { main: emptyCost(), child: emptyCost(), auxiliary: emptyCost() };
    const addRequest = (source: GoalActivityCost, req: ModelRequestDiagnostic): number => {
      observedRequests++;
      source.observedRequests++;
      if (fields.some(field => req.usage[field] !== null)) requestsWithUsage++;
      if (fields.every(field => req.usage[field] !== null)) requestsWithCompleteUsage++;
      for (const field of fields) {
        const measured = req.usage[field];
        if (measured === null) continue;
        knownTokens[field] = (knownTokens[field] ?? 0) + measured;
        tokenFieldCoverage[field]++;
      }
      if (req.knownCostUsd !== null) {
        knownCostUsd = (knownCostUsd ?? 0) + req.knownCostUsd;
        source.knownCostUsd = (source.knownCostUsd ?? 0) + req.knownCostUsd;
        if (req.costComplete) {
          requestsWithCost++;
          source.requestsWithCost++;
          if (req.costSource === "provider-reported") source.providerReportedRequests++;
        }
        if (req.costSource === "pi-native") source.estimatedRequests++;
      }
      return Math.max(0, req.attempts.length - 1);
    };
    const skills = new Map<string, GoalActivitySkill>();
    const authored = this.db.prepare(`SELECT s.evidence_json FROM conversation_goal_learned_skills s
      JOIN conversation_goal_generations g USING(task_id, conversation_id, generation_id) WHERE g.work_id=?`).all(goalId) as
      Array<{ evidence_json: string }>;
    for (const row of authored) {
      const { pathKey: _pathKey, ...item } = JSON.parse(row.evidence_json) as GoalActivitySkill & { pathKey?: string };
      skills.set(JSON.stringify([item.skillId,item.creationToolCallId]), item);
    }
    const runs = owned.map(({ goalId: _goalId, assistantMessageIds, ...run }) => {
      const observed = requests.get(useId(run)) ?? [];
      const sourceCost = run.child ? costBySource.child : costBySource.main;
      if (!observed.length) {
        missingGenerationObservations++;
        sourceCost.missingGenerationObservations++;
      }
      const retries = observed.reduce((sum, req) => sum + addRequest(sourceCost, req), 0);
      retryCount += retries;
      for (const assistantMessageId of assistantMessageIds) {
        for (const item of learned(run.taskId, assistantMessageId)) {
          skills.set(JSON.stringify([item.skillId, assistantMessageId]), { ...item, assistantMessageId });
        }
      }
      return { ...run, requestCount: observed.length, retryCount: retries };
    });
    let unattributedAuxiliaryRequests = 0;
    for (const taskId of new Set(owned.map(run => run.taskId))) {
      const linked = this.db.prepare(`SELECT a.execution_scope, g.work_id FROM conversation_goal_auxiliary_scopes a
        JOIN conversation_goal_generations g USING(task_id, conversation_id, generation_id) WHERE a.task_id=?`).all(taskId) as
        Array<{ execution_scope: string; work_id: string }>;
      const byScope = new Map(linked.map(row => [row.execution_scope, row.work_id]));
      const observedScopes = new Set<string>();
      for (const req of auxiliary(taskId)) {
        if (req.taskId !== taskId || req.sourceKind !== "auxiliary") continue;
        const owner = byScope.get(req.executionScope);
        if (owner === goalId) {
          observedScopes.add(req.executionScope);
          retryCount += addRequest(costBySource.auxiliary, req);
        } else if (owner === undefined) unattributedAuxiliaryRequests++;
      }
      const missing = linked.filter(row => row.work_id === goalId && !observedScopes.has(row.execution_scope)).length;
      costBySource.auxiliary.missingGenerationObservations += missing;
      missingGenerationObservations += missing;
    }
    return { runs, skills: [...skills.values()], knownTokens, knownCostUsd, observedRequests, requestsWithUsage,
      requestsWithCost, costBySource, unattributedAuxiliaryRequests, missingGenerationObservations, retryCount, tokenFieldCoverage, requestsWithCompleteUsage };
  }
}
