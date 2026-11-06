import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotWorkContextService } from "../src/main/agent/work/BotWorkContextService";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { MemoryService, type MemoryExtractionInput } from "../src/main/memory/MemoryService";
import { createMemoryExtension } from "../src/main/memory/memory-extension";
import { projectMemoryContext } from "../src/main/agent/MemoryContextProjection";
import { ExpertService } from "../src/main/experts/ExpertService";
import { TaskExpertBindingService } from "../src/main/experts/TaskExpertBindingService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS };
const workResult = (result: WorkControlResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-work-memory-review-"));
  const db = new AppDatabase(join(root, "app.db"));
  const bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  bots.registerBot({ botId: "other-bot", userId: LOCAL_USER_ID, displayName: "Other" });
  for (const id of ["shared-project", "unrelated-project"]) {
    db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at,archived,resource_budget_chars) VALUES (?,?,?,?,0,128000)")
      .run(id, id, Date.now(), Date.now());
  }
  const work = new WorkService(db.connection, { bots });
  const current = workResult(work.createWork(actor, { operationId: "create", title: "Review", ownerBotId: DEFAULT_BOT_ID,
    inputSnapshotId: "input-review", projectId: "shared-project", authorization: { allowedScopes: ["workspace:read", "workspace:write"] } }));
  // The durable Work binding, not mutable UI task metadata, owns execution context.
  db.upsertTask({ id: "worker", title: "worker", welcomeMode: "bot", projectId: "unrelated-project", updatedAt: Date.now() });
  workResult(work.dispatchExecution(actor, { operationId: "dispatch", workId: current.workId, botId: DEFAULT_BOT_ID,
    taskId: "worker", durableStoreKey: "worker-store", conversationId: "worker-execution", workspaceBinding: root }));
  db.upsertTask({ id: "foreground", title: "foreground", welcomeMode: "bot", projectId: "shared-project", updatedAt: Date.now() });
  new BotWorkContextService(db.connection, bots, work).bind(LOCAL_USER_ID, "desktop", "foreground", DEFAULT_BOT_ID);
  db.upsertTask({ id: "ordinary", title: "ordinary", projectId: "shared-project", updatedAt: Date.now() });
  const memory = new MemoryService(db, { semantic: false });
  const own = memory.create({ kind: "preference", title: "own bot private", content: "private evidence", scopeType: "bot", scopeId: DEFAULT_BOT_ID, sourceType: "user" });
  const other = memory.create({ kind: "preference", title: "other bot private", content: "other private evidence", scopeType: "bot", scopeId: "other-bot", sourceType: "user" });
  const global = memory.create({ kind: "preference", title: "personal global", content: "personal preference", scopeType: "global", sourceType: "user" });
  const shared = memory.create({ kind: "fact", title: "project specification", content: "confirmed project evidence", scopeType: "project", scopeId: "shared-project", sourceType: "user" });
  return { root, db, bots, work, memory, own, other, global, shared, close: () => { db.close(); rmSync(root, { recursive: true, force: true }); } };
}
type Fixture = ReturnType<typeof fixture>;
type Tool = { name: string; execute: (id: string, params: never) => Promise<{ isError?: boolean; details?: unknown }> };
async function toolsFor(memory: MemoryService, taskId: string) {
  const tools = new Map<string, Tool>();
  await createMemoryExtension({ taskId, service: memory })({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  return (name: string, params: object) => tools.get(name)!.execute("review", params as never);
}
async function extract(f: Fixture, operationHint: string, title: string, content: string) {
  const userText = `记住这项修订：${content}`;
  return f.memory.extractAndStore({ taskId: "worker", userText, assistantText: "", isEnabled: () => true,
    model: { maxTokens: 4096 } as MemoryExtractionInput["model"],
    modelRuntime: { completeSimple: async () => ({ content: [{ type: "text", text: JSON.stringify({ candidates: [{
      kind: "fact", title, content, replaces: title, scopeType: "project", operationHint,
      explicit: true, confidence: 1, importance: 1, userEvidence: userText,
    }] }) }], stopReason: "stop" }) } as unknown as MemoryExtractionInput["modelRuntime"],
  });
}

const cases: Array<[string, (f: Fixture) => Promise<void> | void]> = [
  ["worker reads authorized facts but cannot update or rebind them", async f => {
    const tool = await toolsFor(f.memory, "worker");
    for (const record of [f.own, f.shared]) {
      assert(!((await tool("memory_get", { id: record.id })).isError), "authorized fact remains readable");
      const history = f.memory.history(record.id);
      assert.equal((await tool("memory_update", { id: record.id, content: "unconfirmed worker guess" })).isError, true,
        `worker must not rewrite ${record.scopes[0].scopeType} evidence`);
      assert.equal(f.memory.get(record.id)?.content, record.content);
      assert.deepEqual(f.memory.history(record.id), history, "denied updates create no revisions");
      assert.equal((await tool("memory_promote", { id: record.id, targetScopeType: "task", targetScopeId: "worker" })).isError, true,
        "a readable shared atom must not be rebound as a worker-owned atom");
      assert.deepEqual(f.memory.get(record.id)?.scopes, record.scopes);
    }
    for (const record of [f.other, f.global]) assert.equal((await tool("memory_get", { id: record.id })).isError, true);
    assert.equal((await tool("memory_create", { kind: "preference", title: "worker global guess", scopeType: "global" })).isError, true);
    assert(!((await tool("memory_create", { kind: "fact", title: "worker checkpoint", content: "pending validation" })).isError));
    const local = f.memory.search({ taskId: "worker", query: "worker checkpoint" }).find(hit => hit.memory.title === "worker checkpoint")!.memory;
    assert.deepEqual(local.scopes.map(({ scopeType, scopeId }) => ({ scopeType, scopeId })), [{ scopeType: "task", scopeId: "worker" }]);
    assert(!((await tool("memory_update", { id: local.id, content: "revised local hypothesis" })).isError));
    f.memory.promote(local.id, "project", "shared-project");
    assert.equal((await tool("memory_update", { id: local.id, content: "overwrite confirmed fact via retained task scope" })).isError, true);
    assert.equal(f.memory.get(local.id)?.content, "revised local hypothesis");
  }],
  ["foreground may edit its own private memory while project evidence stays protected", async f => {
    const tool = await toolsFor(f.memory, "foreground");
    assert(!((await tool("memory_update", { id: f.own.id, content: "confirmed own preference" })).isError));
    assert.equal((await tool("memory_update", { id: f.shared.id, content: "frontend guess" })).isError, true);
    f.memory.promote(f.own.id, "project", "shared-project");
    assert.equal((await tool("memory_update", { id: f.own.id, content: "mutate promoted private atom" })).isError, true);
    const ordinary = await toolsFor(f.memory, "ordinary");
    assert(!((await ordinary("memory_update", { id: f.global.id, content: "ordinary task preference" })).isError),
      "ordinary task Global behavior is preserved");
  }],
  ["automatic candidate reconciliation cannot mutate a previously promoted worker atom", async f => {
    for (const operation of ["update", "supersede", "resolve", "forget", "create"]) {
      const local = f.memory.create({ kind: "fact", title: `promoted ${operation} atom`, content: `confirmed ${operation} content`,
        scopeType: "task", scopeId: "worker", sourceType: "user" });
      f.memory.promote(local.id, "project", "shared-project");
      const before = f.memory.get(local.id);
      const history = f.memory.history(local.id);
      const result = await extract(f, operation, local.title, operation === "create" ? local.content : `unconfirmed ${operation} change`);
      assert.equal(result.reviewCount, 1, `${operation} of a shared atom requires explicit review`);
      assert.equal(result.committedCount, 0);
      assert.deepEqual(f.memory.get(local.id), before, "shared content/status/evidence remain unchanged");
      assert.deepEqual(f.memory.history(local.id), history);
    }
    const result = await extract(f, "create", "new worker-local finding", "a new unconfirmed checkpoint");
    assert.equal(result.committedCount, 1, "new extraction remains in the execution scope");
    const local = f.memory.search({ taskId: "worker", query: "new worker-local finding" }).find(hit => hit.memory.title === "new worker-local finding")!.memory;
    assert(local.scopes.every(scope => scope.scopeType === "task" && scope.scopeId === "worker"));
  }],
  ["Work prompt loads approved derived evidence using the authoritative project", f => {
    const scope = { scopeType: "project" as const, scopeId: "shared-project" };
    const repo = f.memory.cognition.projections;
    repo.proposeScenarios(scope, [{ title: "approved shared scenario", summary: "shared scenario interpretation", sourceMemoryIds: [f.shared.id] }]);
    for (const proposal of repo.listProposals()) assert(repo.approveProposal(proposal.id));
    const scenarios = f.memory.listScenarios().filter(item => item.scopeId === scope.scopeId && item.status === "active");
    assert.equal(scenarios.length, 1);
    repo.proposeProfile(scope, { title: "approved shared profile", content: "authoritative work project profile", sourceScenarioIds: scenarios.map(item => item.id) });
    for (const proposal of repo.listProposals()) assert(repo.approveProposal(proposal.id));
    const prompt = projectMemoryContext(f.memory, { taskId: "worker", projectId: "unrelated-project", botId: "other-bot", trackRecall: false, limit: 30 });
    assert.match(prompt.text, /authoritative work project profile/);
    assert.equal(prompt.profileIds?.length, 1);
    assert.match(prompt.text, /own bot private/);
    assert.doesNotMatch(prompt.text, /other bot private|personal global/);
  }],
  ["initial Bot expert profile retains its complete skill package snapshot", f => {
    const directory = join(f.root, "initial-skill");
    mkdirSync(join(directory, "references"), { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), "---\nname: initial-skill\ndescription: fixture\n---\nRead references/rule.txt\n");
    writeFileSync(join(directory, "references", "rule.txt"), "frozen initial rule");
    const configuration = { revision: "initial-r1", name: "Initial expert", instructions: "initial prompt", skillIds: ["initial-skill"], mcpIds: ["mcp-a"], connectorIds: ["connector-a"] };
    const skillPackages = [{ id: "initial-skill", directory, origin: "private" as const }];
    f.bots.registerBot({ botId: "initial-bot", userId: LOCAL_USER_ID, displayName: "Initial", expertProfile: {
      expertId: "initial-expert", revision: "initial-r1", allowedSkillIds: ["initial-skill"], allowedMcpIds: ["mcp-a"], allowedConnectorIds: ["connector-a"], configuration, skillPackages,
    } });
    const snapshot = f.bots.activeSnapshot("initial-bot")!;
    assert.deepEqual(snapshot.configuration, configuration);
    assert.deepEqual(snapshot.skillPackages, skillPackages, "initial active version must not replace packages with an empty default");
    f.db.upsertTask({ id: "initial-task", title: "Initial", updatedAt: Date.now() });
    const taskExperts = new TaskExpertBindingService(f.db, new ExpertService(), { rootDir: join(f.root, "task-experts") });
    taskExperts.installFrozen("initial-task", snapshot.configuration!, snapshot.skillPackages!);
    const owned = taskExperts.activeSkillDirectories("initial-task")[0];
    writeFileSync(join(directory, "references", "rule.txt"), "changed source rule");
    assert.equal(readFileSync(join(owned, "references", "rule.txt"), "utf8"), "frozen initial rule");
  }],
];

async function main() {
  let failed = 0;
  for (const [name, run] of cases) {
    const f = fixture();
    try { await run(f); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}`, error); }
    finally { f.close(); }
  }
  assert.equal(failed, 0, `${failed} Bot Work memory regression(s)`);
  console.log("bot work review memory: passed (real SQLite, registered tools, candidate reconciliation, approved prompt projection, complete expert packages)");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
