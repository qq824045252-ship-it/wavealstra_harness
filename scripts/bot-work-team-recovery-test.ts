import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionObservation, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { collectOwnerSummaryFacts } from "../src/main/agent/work/WorkOwnerSummaryFacts";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkDto } from "../src/shared/bot-work";
import type { WorkTeamControlResult, WorkTeamDto } from "../src/shared/bot-work-team";

const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: { ...DESKTOP_USER_GRANTS, allowRedelegation: true } };
const wait = async (predicate: () => boolean, description: string, action: () => Promise<void>): Promise<void> => {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await action();
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`timeout: ${description}`);
};

class FakeHost implements WorkExecutionPort {
  readonly receipts = new Map<string, AgentSubmissionReceipt>();
  readonly submissions: Array<{ taskId: string; operationId: string; botId: string; input: any }> = [];
  readonly assignment = new Map<string, any>();
  readonly failOnce = new Set<string>();
  readonly failAlways = new Set<string>();
  readonly unknown = new Set<string>();
  readonly unreadable = new Set<string>();
  onUnknownEffect?: (taskId: string) => void;
  readonly runningRecovery = new Set<string>();
  readonly observations = new Map<string, (attempt: number) => WorkExecutionObservation>();
  writes = 0;
  sequence = 0;
  constructor(private readonly workspace: string, private readonly artifact: string) {}
  async prepare(taskId: string) { return { taskId, durableStoreKey: `store:${taskId}`, conversationId: "recovery", workspaceBinding: this.workspace }; }
  async find(binding: { bindingId: string }) { return this.receipts.get(binding.bindingId); }
  async submit(binding: { bindingId: string; taskId: string; operationId: string }, text: string): Promise<AgentSubmissionReceipt> {
    const input = JSON.parse(text);
    this.submissions.push({ taskId: binding.taskId, operationId: binding.operationId, botId: input.teamAssignment.botId, input });
    this.assignment.set(binding.bindingId, input.teamAssignment);
    const recovery = binding.operationId.startsWith("team-recovery:");
    if (input.teamAssignment.botId.endsWith("-a") && !recovery) { writeFileSync(this.artifact, "written-once"); this.writes++; }
    const receipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: ++this.sequence, status: "done" as const };
    this.receipts.set(binding.bindingId, receipt);
    return receipt;
  }
  async inspect(binding: { bindingId: string; taskId: string; operationId: string; botId: string }): Promise<WorkExecutionObservation> {
    if (this.unreadable.has(binding.taskId)) throw new Error("native checkpoint temporarily unavailable");
    const assignment = this.assignment.get(binding.bindingId);
    const botId: string = assignment?.botId ?? binding.botId;
    const recovery = binding.operationId.startsWith("team-recovery:");
    if (recovery && this.runningRecovery.has(binding.taskId)) return { status: "running" } as WorkExecutionObservation;
    const custom = this.observations.get(botId);
    if (custom) return custom(this.submissions.filter(item => item.taskId === binding.taskId)
      .findIndex(item => item.operationId === binding.operationId) + 1);
    if (this.failAlways.has(botId)) return { status: "failed", summary: "same empty failure", hasWriteConflicts: false, artifactRefs: [] } as WorkExecutionObservation;
    if (!recovery && this.unknown.has(botId)) {
      this.onUnknownEffect?.(binding.taskId);
      return { status: "failed", summary: "native task finished after uncertain tool effect", hasWriteConflicts: false, artifactRefs: [this.artifact] };
    }
    if (!recovery && this.failOnce.has(botId)) {
      this.failOnce.delete(botId);
      return { status: "failed", summary: "failed after writing the file", hasWriteConflicts: false, artifactRefs: [this.artifact] } as WorkExecutionObservation;
    }
    return { status: "completed", summary: `${botId} completed`, hasWriteConflicts: false, artifactRefs: [] } as WorkExecutionObservation;
  }
  async stop(): Promise<void> {}
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "team-recovery-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const artifact = join(workspace, "a.txt");
  const dbPath = join(root, "recovery.db");
  let db = new AppDatabase(dbPath);
  let bots = new BotRegistry(db.connection);
  for (const id of ["owner", "a", "b", "c", "d"]) bots.registerBot({ botId: `recovery-${id}`, userId: LOCAL_USER_ID,
    displayName: id, authorization: DESKTOP_USER_GRANTS });
  let works = new WorkService(db.connection, { bots });
  const host = new FakeHost(workspace, artifact);
  const errors: unknown[] = [];
  let adapter = new WorkExecutionAdapter(works, host, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
  let queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "fixture/root");
  const flush = async (times = 12) => { for (let index = 0; index < times; index++) { await queue.flush(); await adapter.flush(); } };
  const create = (name: string, members: Array<{ botId: string; dependsOnBotIds?: string[] }>, parallel = false): WorkTeamControlResult => {
    const request = { operationId: `team:${name}`, title: name, goalDescription: "持续完成分工并保留真实成果",
      workspacePath: workspace, ownerBotId: "recovery-owner", ownerResponsibility: "只读汇总成员结果",
      members: members.map(member => ({ ...member, responsibility: `职责 ${member.botId}`, delegatedScope: ["workspace:read", "workspace:write"] as Array<"workspace:read" | "workspace:write"> })),
      criteria: ["保留真实成果"], executionPolicy: parallel ? "parallel" as const : "sequential" as const, maxConcurrency: 3 };
    return works.teams.handle(actor, { kind: "create", request });
  };
  const team = (workId: string): WorkTeamDto => works.teams.get(workId)!;
  const bindings = (workId: string) => works.repo.listBindings(workId);
  const close = async () => { await queue.close(); await adapter.close(); db.close(); rmSync(root, { recursive: true, force: true }); };
  return { root, workspace, artifact, dbPath, host, errors, get db() { return db; }, get bots() { return bots; }, get works() { return works; },
    get adapter() { return adapter; }, get queue() { return queue; },
    flush, create, team, bindings, close,
    reopen: () => {
      db.close();
      db = new AppDatabase(dbPath);
      bots = new BotRegistry(db.connection);
      works = new WorkService(db.connection, { bots });
      adapter = new WorkExecutionAdapter(works, host, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
      queue = new WorkDispatchQueue(db, works, adapter, () => true, () => "fixture/root");
    },
  };
}

try {
  // A writes once, fails, and continues under the same identity; B then validates;
  // the owner summarizes only after real results exist.
  {
    const f = fixture();
    try {
      const created = f.create("sequential-recovery", [{ botId: "recovery-a" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team, JSON.stringify(created));
      const workId = created.work!.workId;
      const [a, b] = created.team!.executions;
      f.host.failOnce.add("recovery-a");
      await wait(() => f.bindings(workId).some(binding => binding.taskId === a!.taskId && binding.status === "failed"),
        "first member failure", () => f.flush(3));
      await wait(() => f.team(workId).state === "awaiting_review", "team completes after recovery", () => f.flush(4));
      const recovered = f.bindings(workId).filter(binding => binding.taskId === a!.taskId);
      assert.equal(recovered.length, 2, "one durable continuation");
      assert.equal(recovered[1]!.botId, recovered[0]!.botId, "same member identity");
      assert.equal(recovered[1]!.operationId.startsWith("team-recovery:"), true);
      assert.equal(f.host.writes, 1, "the file is written once, not replayed by recovery");
      assert.equal(readFileSync(f.artifact, "utf8"), "written-once");
      assert.equal(f.team(workId).executions[0]!.status, "recovered");
      const bSubmission = f.host.submissions.find(item => item.taskId === b!.taskId);
      assert(bSubmission, "dependent member ran after recovery");
      assert.equal(bSubmission!.input.teamAssignment.previousResults[0].executionStatus, "completed");
      assert.equal(f.team(workId).executions[1]!.status, "completed");
      assert.equal(f.errors.length, 0);
    } finally { await f.close(); }
  }

  // An independent member continues while the failed member's recovery is still
  // running; the dependent member waits for the recovered result.
  {
    const f = fixture();
    try {
      const created = f.create("independent-recovery", [
        { botId: "recovery-a" }, { botId: "recovery-d" }, { botId: "recovery-b", dependsOnBotIds: ["recovery-a"] },
      ], true);
      assert(created.ok && created.work && created.team, JSON.stringify(created));
      const workId = created.work!.workId;
      const [, d, b] = created.team!.executions;
      f.host.failOnce.add("recovery-a");
      f.host.runningRecovery.add(created.team!.executions[0]!.taskId);
      await wait(() => f.bindings(workId).some(binding => binding.taskId === d!.taskId && binding.status === "completed"),
        "independent member continues during recovery", () => f.flush(3));
      assert.equal(f.host.submissions.some(item => item.taskId === b!.taskId), false, "dependent member still waits");
      assert(f.team(workId).executions[0]!.status === "recovering");
      f.host.runningRecovery.delete(created.team!.executions[0]!.taskId);
      await wait(() => f.team(workId).state === "awaiting_review", "dependent member starts after recovery", () => f.flush(4));
      const bSubmission = f.host.submissions.find(item => item.taskId === b!.taskId);
      assert(bSubmission, "dependent member ran");
      assert.equal(bSubmission!.input.teamAssignment.previousResults[0].executionStatus, "completed");
    } finally { await f.close(); }
  }

  // Unknown effects retain their facts without narrowing authorized recovery; no write is replayed, and the
  // next independent member is not blocked by the unknown result.
  {
    const f = fixture();
    try {
      const created = f.create("unknown-effect", [{ botId: "recovery-a" }, { botId: "recovery-d" }], true);
      assert(created.ok && created.work && created.team, JSON.stringify(created));
      const workId = created.work!.workId;
      const [, d] = created.team!.executions;
      f.host.unknown.add("recovery-a");
      f.host.onUnknownEffect = taskId => {
        assert.equal(f.works.admitTaskAction(taskId, { operationId: "uncertain-tool", actionKind: "workspace:write" }), undefined);
        f.works.settleTaskAction(taskId, "uncertain-tool", "unknown");
      };
      await wait(() => f.bindings(workId).some(binding => binding.taskId === d!.taskId && binding.status === "completed"),
        "independent member survives unknown effect", () => f.flush(4));
      const aBindings = f.bindings(workId).filter(binding => binding.taskId === created.team!.executions[0]!.taskId);
      assert.equal(aBindings[0]!.status, "failed", "the original terminal failure is not rewritten as success");
      assert(f.works.repo.listAdmissions(workId).some(admission => admission.operationId === "uncertain-tool" && admission.state === "unknown"), "unknown tool outcome remains factual");
      const recovery = aBindings.find(binding => binding.operationId.startsWith("team-recovery:"));
      assert(recovery, "independent recovery continuation");
      assert.deepEqual(recovery!.delegatedScope, ["workspace:read", "workspace:write"], "recovery retains the member's authorized scope");
      assert.equal(f.host.writes, 1, "unknown effect does not repeat the write");
    } finally { await f.close(); }
  }

  // A user stop cancels a pending continuation before it creates any new binding.
  {
    const f = fixture();
    try {
      const created = f.create("stop-during-recovery", [{ botId: "recovery-a" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work!.workId;
      const a = created.team!.executions[0]!;
      f.host.failOnce.add("recovery-a");
      f.host.runningRecovery.add(a.taskId);
      await wait(() => (f.db.connection.prepare("SELECT COUNT(*) AS n FROM work_team_recovery_attempts WHERE work_id=? AND state IN ('pending','claimed','dispatched')").get(workId) as { n: number }).n === 1,
        "pending recovery", () => f.flush(2));
      const before = f.bindings(workId).length;
      f.works.cancelWork(actor, { operationId: "stop-team", workId });
      await f.flush(5);
      assert.equal(f.bindings(workId).length, before, "stopped team does not dispatch a recovery");
      const attempts = f.db.connection.prepare("SELECT state,outcome FROM work_team_recovery_attempts WHERE work_id=? ORDER BY generation DESC LIMIT 1").all(workId) as Array<{ state: string; outcome: string }>;
      assert.equal(attempts[0]?.state, "stopped");
      assert.equal(attempts[0]?.outcome, "superseded");
    } finally { await f.close(); }
  }

  // A repeated empty failure is not progress: the loop stops and keeps the original
  // task identity/result instead of spinning forever.
  {
    const f = fixture();
    try {
      const created = f.create("no-progress", [{ botId: "recovery-a" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work!.workId;
      f.host.failAlways.add("recovery-a");
      await f.flush(12);
      const aBindings = f.bindings(workId).filter(binding => binding.taskId === created.team!.executions[0]!.taskId);
      assert.equal(aBindings.length, 2, "only one bounded continuation is attempted");
      assert.equal(f.team(workId).state, "blocked");
      assert.match(f.team(workId).executions[0]!.error!, /没有新进展|恢复已停止/);
      assert.equal(f.host.submissions.some(item => item.taskId === created.team!.executions[1]!.taskId), false, "dependent member is not started on a failed prerequisite");
    } finally { await f.close(); }
  }

  // Rephrasing an error/result or inventing missing artifact names is not
  // progress. Re-observing an existing file with identical bytes is not either.
  for (const artifacts of ["missing", "unchanged", "recreated"] as const) {
    const f = fixture();
    try {
      writeFileSync(f.artifact, "retained bytes");
      f.host.observations.set("recovery-c", attempt => {
        if (artifacts === "recreated") {
          writeFileSync(`${f.artifact}.new`, "retained bytes"); renameSync(`${f.artifact}.new`, f.artifact);
        }
        return { status: "failed", summary: `Another explanation ${attempt}`, failureReason: `Provider error ${attempt}`,
          artifactRefs: artifacts === "missing" ? [join(f.workspace, `missing-${attempt}`), f.workspace] : [f.artifact],
          hasWriteConflicts: false };
      });
      const created = f.create(`wording-${artifacts}`, [{ botId: "recovery-c" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      if (artifacts === "unchanged") {
        const taskId = created.team.executions[0]!.taskId;
        f.host.runningRecovery.add(taskId);
        await wait(() => f.bindings(workId).filter(binding => binding.taskId === taskId).length === 2,
          "durable byte baseline before restart", () => f.flush(2));
        await f.queue.close(); await f.adapter.close(); f.reopen();
        f.host.runningRecovery.delete(taskId);
      }
      await f.flush(16);
      assert.equal(f.bindings(workId).filter(binding => binding.taskId === created.team!.executions[0]!.taskId).length, 2,
        "wording, missing paths, directories and unchanged bytes cannot buy another retry");
      assert.equal(f.team(workId).executions[0]!.recoveryOutcome, "no_progress");
      assert.equal(f.host.submissions.some(item => item.botId === "recovery-b"), false);
    } finally { await f.close(); }
  }

  // The same path and report can carry new verified bytes. Let the existing
  // bounded recovery finish instead of stopping on identical wording.
  {
    const f = fixture();
    try {
      f.host.observations.set("recovery-c", attempt => {
        writeFileSync(f.artifact, `completed stage ${attempt}`);
        return { status: attempt < 4 ? "failed" : "completed", summary: "same report", failureReason: "same error",
          artifactRefs: [f.artifact], hasWriteConflicts: false };
      });
      const created = f.create("real-byte-progress", [{ botId: "recovery-c" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      await wait(() => f.team(workId).state === "awaiting_review", "verified bytes allow remaining recovery", () => f.flush(4));
      assert.equal(f.bindings(workId).filter(binding => binding.taskId === created.team!.executions[0]!.taskId).length, 4);
      assert.equal(readFileSync(f.artifact, "utf8"), "completed stage 4");
      assert.equal(f.team(workId).executions[0]!.status, "recovered");
    } finally { await f.close(); }
  }

  // Retain completed native subitems without mistaking one partial deliverable
  // for the whole assignment. Rewording the same completed child is not progress.
  for (const advancing of [false, true]) {
    const f = fixture();
    try {
      f.host.observations.set("recovery-c", attempt => ({
        status: advancing && attempt === 4 ? "completed" : "failed", summary: `report ${attempt}`,
        failureReason: `failure ${attempt}`, artifactRefs: [], hasWriteConflicts: false,
        subitems: [{ itemId: advancing ? `stage-${attempt}` : "stage-1", childId: advancing ? `child-${attempt}` : "child-1",
          task: `reworded completed task ${attempt}`, required: true, dependencies: [], criterionIds: [],
          nativeStatus: "completed", outcome: "completed", artifactRefs: [], writeConflicts: [], summary: `partial ${attempt}` },
        ...(advancing && attempt === 4 ? [] : [{ itemId: "remaining", task: "unfinished step", required: true,
          dependencies: [], criterionIds: [], nativeStatus: "failed", outcome: "failed" as const,
          artifactRefs: [], writeConflicts: [], summary: "still missing" }])] }));
      const created = f.create(`native-steps-${advancing}`, [{ botId: "recovery-c" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      await f.flush(20);
      assert.equal(f.bindings(workId).filter(binding => binding.taskId === created.team!.executions[0]!.taskId).length, advancing ? 4 : 2);
      assert.equal(f.team(workId).state, advancing ? "awaiting_review" : "blocked");
      assert.equal(f.host.submissions.some(item => item.botId === "recovery-b"), advancing,
        "partial success cannot release a dependent member while this member is failing");
      assert(f.works.repo.listDeliverables(workId).some(item => item.deliverableId.startsWith("partial:")), "retain partial outputs");
    } finally { await f.close(); }
  }

  // Progress belongs to the failed member, not another parallel member.
  {
    const f = fixture();
    try {
      writeFileSync(f.artifact, "original member output");
      f.host.observations.set("recovery-c", attempt => ({ status: "failed", summary: "same empty failure",
        artifactRefs: attempt === 1 ? [f.artifact] : [], hasWriteConflicts: false }));
      f.host.observations.set("recovery-d", () => {
        writeFileSync(f.artifact, "independent output");
        return { status: "completed", summary: "independent success", artifactRefs: [f.artifact], hasWriteConflicts: false };
      });
      const created = f.create("member-scoped-progress", [{ botId: "recovery-c" }, { botId: "recovery-d" }], true);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId, taskId = created.team.executions[0]!.taskId;
      f.host.runningRecovery.add(taskId);
      await wait(() => f.host.submissions.some(item => item.botId === "recovery-d"), "parallel member completes", () => f.flush(3));
      f.host.runningRecovery.delete(taskId);
      await f.flush(12);
      assert.equal(f.bindings(workId).filter(binding => binding.taskId === taskId).length, 2,
        "an independent artifact must not reset this member's stagnation budget");
      assert.equal(f.team(workId).executions[0]!.recoveryOutcome, "no_progress");
    } finally { await f.close(); }
  }

  // A terminal failed prerequisite prevents dependent business work, not the
  // owner's read-only final accounting. Preserve older partial outputs too.
  {
    const f = fixture();
    try {
      f.host.observations.set("recovery-c", attempt => ({ status: "failed", summary: `failure ${attempt}`,
        failureReason: `provider unavailable ${attempt}`, artifactRefs: [], hasWriteConflicts: false,
        subitems: attempt === 1 ? [{ itemId: "retained-step", childId: "retained-child", task: "verified partial finding",
          required: true, dependencies: [], criterionIds: [], nativeStatus: "completed", outcome: "completed",
          artifactRefs: [f.artifact], writeConflicts: [], summary: "RETAINED_PARTIAL_FINDING" },
          { itemId: "remaining-step", task: "unfinished responsibility", required: true, dependencies: [], criterionIds: [],
            nativeStatus: "failed", outcome: "failed", artifactRefs: [], writeConflicts: [], summary: "unfinished" }] : [] }));
      const created = f.create("failed-chain-summary", [{ botId: "recovery-a" }, { botId: "recovery-c" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      await wait(() => f.team(workId).executions.at(-1)?.status === "completed", "owner summarizes exhausted chain", () => f.flush(4));
      const summary = f.host.submissions.find(item => item.botId === "recovery-owner")!.input.teamAssignment;
      assert(summary.previousResults.some((item: any) => item.botId === "recovery-a" && item.executionStatus === "completed"));
      assert(summary.previousResults.some((item: any) => item.botId === "recovery-c" && item.summary.includes("RETAINED_PARTIAL_FINDING")
        && item.artifactRefs.includes(f.artifact)), "retain useful output from the original failed attempt");
      assert(summary.previousResults.some((item: any) => item.botId === "recovery-c" && item.failureReason?.includes("provider unavailable 2")),
        "summary carries the latest failure separately from partial result content");
      const unstarted = summary.previousResults.find((item: any) => item.botId === "recovery-b");
      assert.equal(unstarted.executionStatus, "not_started");
      assert.equal(unstarted.bindingId, undefined, "do not invent a native receipt for an unstarted member");
      assert.match(unstarted.summary, /未启动/);
      assert.equal(f.host.submissions.filter(item => item.botId === "recovery-a").length, 1, "successful member is not replayed");
      assert.equal(f.host.submissions.filter(item => item.botId === "recovery-b").length, 0, "dependent business work stays unstarted");
      assert.equal(f.team(workId).executions[2]!.status, "blocked", "unstartable member no longer appears queued forever");
      assert.equal(f.team(workId).state, "blocked", "a completed summary is not team success");
      assert.equal(f.works.getWork(workId)!.acceptedDeliverableIds.length, 0);
      const facts = collectOwnerSummaryFacts(f.works, f.works.getWork(workId)!, Date.now());
      assert(!facts.payload.waitingForBotIds.includes("recovery-b"), "host summary does not wait for an impossible execution");
      assert(facts.payload.items.some(item => item.botId === "recovery-b" && item.kind === "blocked" && item.text.includes("未启动")));
      const before = f.host.submissions.length;
      await f.queue.close(); await f.adapter.close(); f.reopen(); await f.flush(8);
      assert.equal(f.host.submissions.length, before, "restart does not duplicate the final summary or successful effects");
      assert.equal(f.host.writes, 1);
    } finally { await f.close(); }
  }

  // Parallel transitive dependents remain unstarted, while independent work
  // finishes. Unknown native liveness or an in-flight tool still fences summary.
  for (const unsettled of ["native", "tool"] as const) {
    const f = fixture();
    try {
      let independentRunning = true;
      f.host.failAlways.add("recovery-c");
      f.host.observations.set("recovery-d", () => independentRunning ? { status: "running" }
        : { status: "completed", summary: "independent result", artifactRefs: [], hasWriteConflicts: false });
      const created = f.create(`transitive-summary-${unsettled}`, [
        { botId: "recovery-c" }, { botId: "recovery-b", dependsOnBotIds: ["recovery-c"] },
        { botId: "recovery-a", dependsOnBotIds: ["recovery-b"] }, { botId: "recovery-d" },
      ], true);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      await wait(() => f.team(workId).executions[0]!.recoveryOutcome === "no_progress", "recovery is exhausted", () => f.flush(3));
      assert(f.team(workId).executions.slice(1, 3).every(item => item.status === "blocked" && item.notStartedReason));
      assert.equal(f.host.submissions.some(item => item.botId === "recovery-owner"), false, "summary waits for independent live work");
      const source = f.works.repo.bindingForTask(created.team.executions[0]!.taskId)!;
      if (unsettled === "native") {
        f.works.repo.updateBinding({ ...source, status: "unknown" }); f.host.unreadable.add(source.taskId);
      } else f.works.repo.insertAdmission({ admissionId: `late:${workId}`, workId, bindingId: source.bindingId,
        operationId: "still-running-tool", actionKind: "workspace:write", state: "admitted",
        intentRevision: source.intentRevision, ownerEpoch: source.ownerEpoch, admittedAt: Date.now() });
      independentRunning = false;
      await f.flush(4);
      assert(f.team(workId).executions.slice(1, 3).every(item => !item.notStartedReason), "uncertain execution is not a terminal dependency outcome");
      assert.equal(f.host.submissions.some(item => item.botId === "recovery-owner"), false, "summary cannot bypass native/tool settlement");
      if (unsettled === "native") { f.host.unreadable.delete(source.taskId); f.works.repo.updateBinding(source); }
      else f.works.repo.updateAdmissionState(`late:${workId}`, "unknown", Date.now());
      await wait(() => f.team(workId).executions.at(-1)?.status === "completed", "summary after all real execution settled", () => f.flush(4));
      assert.equal(f.host.submissions.some(item => ["recovery-a", "recovery-b"].includes(item.botId)), false);
      const results = f.host.submissions.find(item => item.botId === "recovery-owner")!.input.teamAssignment.previousResults;
      assert.equal(results.filter((item: any) => item.executionStatus === "not_started").length, 2);
      assert(results.some((item: any) => item.botId === "recovery-d" && item.executionStatus === "completed"));
    } finally { await f.close(); }
  }

  // A dependency can be unstartable because C stopped while another stopped
  // predecessor A still has an admitted tool. The owner must wait for A directly.
  {
    const f = fixture();
    try {
      let independentRunning = true;
      f.host.failAlways.add("recovery-a"); f.host.failAlways.add("recovery-c");
      f.host.observations.set("recovery-d", () => independentRunning ? { status: "running" }
        : { status: "completed", summary: "independent result", artifactRefs: [], hasWriteConflicts: false });
      const created = f.create("multi-prerequisite-live-tool", [{ botId: "recovery-a" }, { botId: "recovery-c" },
        { botId: "recovery-b", dependsOnBotIds: ["recovery-a", "recovery-c"] }, { botId: "recovery-d" }], true);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      await wait(() => f.team(workId).executions.slice(0, 2).every(item => item.recoveryOutcome === "no_progress"),
        "both prerequisites exhausted", () => f.flush(3));
      const source = f.works.repo.bindingForTask(created.team.executions[0]!.taskId)!;
      f.works.repo.insertAdmission({ admissionId: `multi:${workId}`, workId, bindingId: source.bindingId,
        operationId: "late-admitted-tool", actionKind: "workspace:write", state: "admitted",
        intentRevision: source.intentRevision, ownerEpoch: source.ownerEpoch, admittedAt: Date.now() });
      assert(f.team(workId).executions[2]!.notStartedReason, "the other terminal predecessor still prevents dependent execution");
      independentRunning = false; await f.flush(5);
      assert.equal(f.host.submissions.some(item => item.botId === "recovery-owner"), false,
        "owner waits for every predecessor's effects, regardless of the chosen dependency reason");
      f.works.repo.updateAdmissionState(`multi:${workId}`, "unknown", Date.now());
      await wait(() => f.team(workId).executions.at(-1)?.status === "completed", "summary after late tool settles", () => f.flush(4));
    } finally { await f.close(); }
  }

  // Pre-upgrade pending/claimed continuations cannot race an unknown native
  // source, or a terminal source with a still-admitted tool invocation.
  for (const persistedState of ["pending", "claimed"] as const) {
    const f = fixture();
    try {
      const created = f.create(`legacy-${persistedState}`, [{ botId: "recovery-a" }, { botId: "recovery-d" }], true);
      assert(created.ok && created.work && created.team);
      const workId = created.work.workId;
      f.host.failOnce.add("recovery-a");
      await f.works.teams.dispatchPending(f.db, f.adapter, () => "fixture");
      await f.adapter.flush();
      const source = f.bindings(workId)[0];
      assert.equal(source.status, "failed");
      const ownBindings = () => f.bindings(workId).filter(binding => binding.taskId === source.taskId);
      // Persist the same legacy recovery row production previously created.
      const service = f.works.teams as any;
      service.ensureRecovery(f.works.getWork(workId), service.rows(workId)[0], source);
      const recovery = f.db.connection.prepare("SELECT * FROM work_team_recovery_attempts WHERE work_id=?").get(workId) as any;
      assert(recovery);
      f.db.connection.prepare("UPDATE work_team_recovery_attempts SET state=? WHERE recovery_id=?").run(persistedState, recovery.recovery_id);
      f.works.repo.updateBinding({ ...source, status: "unknown" });
      f.host.unreadable.add(source.taskId);
      const scopes = ["workspace:read", "workspace:write"];
      f.works.repo.updateBinding({ ...source, status: "invalidated", attemptId: source.attemptId ?? "already-attempted" });
      assert(f.works.teams.dispatchError(workId, source.taskId, source.botId, scopes, recovery.operation_id), "attempted invalidation does not prove the native execution ended");
      f.works.repo.updateBinding({ ...source, status: "unknown" });
      assert.equal(f.works.teams.allowsRecoveryBinding(workId, source.taskId, recovery.operation_id, { ...source, status: "unknown" }), false);
      assert(f.works.teams.dispatchError(workId, source.taskId, source.botId, scopes, recovery.operation_id));
      await f.works.teams.dispatchPending(f.db, f.adapter, () => "fixture");
      await f.adapter.flush();
      assert.equal(ownBindings().length, 1, "persisted claim cannot dispatch while source liveness is unknown");
      assert(f.host.submissions.some(item => item.botId === "recovery-d"), "blocked old claim must not starve an independent member");
      assert.equal((f.db.connection.prepare("SELECT state FROM work_team_recovery_attempts WHERE recovery_id=?").get(recovery.recovery_id) as any).state, persistedState);
      f.host.unreadable.delete(source.taskId);
      f.works.repo.updateBinding(source);
      f.works.repo.insertAdmission({ admissionId: `live:${workId}`, workId, bindingId: source.bindingId,
        operationId: "live-tool", actionKind: "workspace:write", state: "admitted",
        intentRevision: source.intentRevision, ownerEpoch: source.ownerEpoch, admittedAt: Date.now() });
      assert(f.works.teams.dispatchError(workId, source.taskId, source.botId, scopes, recovery.operation_id));
      await f.works.teams.dispatchPending(f.db, f.adapter, () => "fixture");
      assert.equal(ownBindings().length, 1, "source admission remains an in-flight guard");
      f.works.repo.updateAdmissionState(`live:${workId}`, "unknown", Date.now());
      assert.equal(f.works.teams.dispatchError(workId, source.taskId, source.botId, scopes, recovery.operation_id), undefined);
      f.host.runningRecovery.add(source.taskId);
      await f.works.teams.dispatchPending(f.db, f.adapter, () => "fixture");
      await f.adapter.flush();
      assert.equal(ownBindings().length, 2, "terminal source with uncertain effect permits independent continuation");
      const own = f.bindings(workId).find(binding => binding.operationId === recovery.operation_id)!;
      f.db.connection.prepare("UPDATE work_team_recovery_attempts SET state='claimed' WHERE recovery_id=?").run(recovery.recovery_id);
      assert.equal(f.works.teams.allowsRecoveryBinding(workId, source.taskId, recovery.operation_id, own), true);
      await f.works.teams.dispatchPending(f.db, f.adapter, () => "fixture");
      assert.equal(ownBindings().length, 2, "lost response adopts the exact existing recovery without a duplicate");
    } finally { await f.close(); }
  }

  // Restart after the failure and duplicate delivery both claim the same durable
  // continuation, producing exactly one recovery binding and one final team result.
  {
    const f = fixture();
    try {
      const created = f.create("restart-dedup", [{ botId: "recovery-a" }, { botId: "recovery-b" }]);
      assert(created.ok && created.work && created.team);
      const workId = created.work!.workId;
      const a = created.team!.executions[0]!;
      f.host.failOnce.add("recovery-a");
      f.host.runningRecovery.add(a.taskId);
      await wait(() => (f.db.connection.prepare("SELECT COUNT(*) AS n FROM work_team_recovery_attempts WHERE work_id=?").get(workId) as { n: number }).n === 1,
        "durable recovery before restart", () => f.flush(2));
      f.reopen();
      await f.flush(4);
      f.host.runningRecovery.delete(a.taskId);
      await f.flush(6);
      await wait(() => f.team(workId).state === "awaiting_review", "team finishes after restart", () => f.flush(4));
      const aBindings = f.bindings(workId).filter(binding => binding.taskId === a.taskId);
      assert.equal(aBindings.filter(binding => binding.operationId.startsWith("team-recovery:")).length, 1);
      assert.equal(aBindings.length, 2);
      assert.equal(f.host.writes, 1);
      const attempts = f.db.connection.prepare("SELECT COUNT(*) AS n FROM work_team_recovery_attempts WHERE work_id=?").get(workId) as { n: number };
      assert.equal(attempts.n, 1, "duplicate delivery/restart does not create another recovery generation");
    } finally { await f.close(); }
  }
  console.log("PASS team recovery: same identity continuation, single write, dependency advancement, independent members, nonblocking unknown effects, stop cancellation, verified byte/native-item progress, wording-independent stagnation, partial-result dependency barrier, exhausted-chain summaries and restart dedup");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
