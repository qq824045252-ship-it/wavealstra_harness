import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionObservation, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
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
  readonly runningRecovery = new Set<string>();
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
    const assignment = this.assignment.get(binding.bindingId);
    const botId: string = assignment?.botId ?? binding.botId;
    const recovery = binding.operationId.startsWith("team-recovery:");
    if (recovery && this.runningRecovery.has(binding.taskId)) return { status: "running" } as WorkExecutionObservation;
    if (this.failAlways.has(botId)) return { status: "failed", summary: "same empty failure", hasWriteConflicts: false, artifactRefs: [] } as WorkExecutionObservation;
    if (!recovery && this.unknown.has(botId)) return { status: "unknown", summary: "effect is unknown", hasWriteConflicts: false, artifactRefs: [] } as unknown as WorkExecutionObservation;
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

  // Unknown external effects are verified read-only; no write is replayed, and the
  // next independent member is not blocked by the unknown result.
  {
    const f = fixture();
    try {
      const created = f.create("unknown-effect", [{ botId: "recovery-a" }, { botId: "recovery-d" }], true);
      assert(created.ok && created.work && created.team, JSON.stringify(created));
      const workId = created.work!.workId;
      const [, d] = created.team!.executions;
      f.host.unknown.add("recovery-a");
      await wait(() => f.bindings(workId).some(binding => binding.taskId === d!.taskId && binding.status === "completed"),
        "independent member survives unknown effect", () => f.flush(4));
      const aBindings = f.bindings(workId).filter(binding => binding.taskId === created.team!.executions[0]!.taskId);
      assert.equal(aBindings[0]!.status, "unknown", "the original unknown fact is not rewritten as success");
      const recovery = aBindings.find(binding => binding.operationId.startsWith("team-recovery:"));
      assert(recovery, "read-only verification continuation");
      assert.deepEqual(recovery!.delegatedScope, ["workspace:read"]);
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
  console.log("PASS team recovery: same identity continuation, single write, dependency advancement, independent members, read-only unknown effects, stop cancellation, no-progress stop and restart dedup");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
