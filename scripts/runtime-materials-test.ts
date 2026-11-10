import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { RuntimeContextSnapshotRepository } from "../src/main/agent/RuntimeContextSnapshotRepository";
import { collectRuntimeMaterialEvidence as collect } from "../src/main/agent/RuntimeMaterialEvidence";
import { SessionEventCoordinator } from "../src/main/agent/SessionEventCoordinator";
import { createProjectKnowledgeExtension } from "../src/main/project/project-knowledge-extension";

async function main() {
  const web = { toolCallId: "web", toolName: "fetch_content", args: {url:"https://example.com/"}, isError:false,
    result: {content:[{type:"text",text:"Example Domain"}],details:{urls:["https://example.com/"],urlCount:1,successful:1,
      materialKind:"web-content",status:200,mode:"readable",truncated:false,totalChars:14}}};
  assert.equal(collect(web)[0].partial,false);
  assert.equal(collect(web)[0].kind,"web-content");
  for (const patch of [{status:403},{status:206},{status:undefined},{truncated:true},{mode:"answer"},{materialKind:"metadata"},{successful:0},{totalChars:15}])
    assert.equal(collect({...web,result:{...web.result,details:{...web.result.details,...patch}}})[0].partial,true);
  assert.deepEqual(collect({...web,isError:true}),[]);
  assert.deepEqual(collect({...web,toolName:"web_search"}),[]);
  assert.deepEqual(collect({...web,args:{url:"https://wrong.example/"}}),[]);
  assert.equal(collect({...web,args:{...web.args,prompt:"summarize"}})[0].partial,true);

  const root = mkdtempSync(join(tmpdir(), "mybuddy-materials-"));
  const dbPath = join(root, "app.db");
  let db = new AppDatabase(dbPath);
  try {
    db.upsertTask({ id: "task", title: "Material evidence", updatedAt: 1 });
    let repository = new RuntimeContextSnapshotRepository(db.connection);
    const ctx = { taskId: "task", executionId: "execution", assistantMessageId: "assistant" };
    repository.record({ ...ctx, userMessageId: "user", status: "running", startedAt: Date.now(),
      mode: "coding", assemblyHash: "hash", resolvedInstructions: [], resolvedCapabilities: [], warnings: [], workingDirectory: root });
    writeFileSync(join(root, "source.txt"), "first\nsecond\nthird");
    const args = { path: "source.txt", offset: 2, limit: 1 };
    const result = await createReadToolDefinition(root).execute("read-1", args, undefined, undefined, {} as any);
    const event = { toolCallId: "read-1", toolName: "read", args, result, isError: false };
    const evidence = collect(event);
    assert.equal(evidence[0].kind, "file-content");
    assert.equal(evidence[0].offset, 2);
    assert.equal(evidence[0].partial, true);
    assert.equal(evidence[0].outputHash.length, 64);
    assert(!JSON.stringify(evidence).includes("second"), "Read body must not be duplicated into audit storage");
    assert.deepEqual(collect({ ...event, isError: true }), []);
    assert.deepEqual(collect({ ...event, result: { isError: true, content: result.content } }), []);
    assert.deepEqual(collect({ ...event, toolName: "bash" }), []);
    const tools = new Map<string, any>();
    let metadataOnly = false;
    createProjectKnowledgeExtension({ taskId: "task", retrieval: {
      read: async () => ({ item: { id: "doc", title: "Specification", kind: "pdf" }, requiresFileAccess: metadataOnly,
        content: "extracted body", truncated: true, managedPath: "managed.pdf" }),
      search: () => ({ scope: "project", hits: [{ itemId: "doc", title: "Specification", kind: "pdf", snippet: "excerpt", readable: true }] }),
    } as any })({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
    const readKnowledge = async () => collect({ toolName: "project_knowledge_read", toolCallId: "knowledge", args: { id: "doc" },
      result: await tools.get("project_knowledge_read").execute("knowledge", { id: "doc" }), isError: false });
    assert.equal((await readKnowledge())[0].kind, "knowledge-content");
    metadataOnly = true;
    assert.equal((await readKnowledge())[0].kind, "metadata", "Binary metadata is never reported as body read");
    const search = collect({ toolName: "project_knowledge_search", toolCallId: "search", args: {},
      result: await tools.get("project_knowledge_search").execute("search", { query: "spec" }), isError: false });
    assert.equal(search[0].kind, "search-snippet");
    assert.equal(search[0].returnedChars, 7);

    const noop = () => {};
    let subscriber: (event: any) => void = noop;
    const session: any = { subscribe(callback: any) { subscriber = callback; return noop; } };
    const entry: any = { ...ctx, session, pendingAssistantTurns: [], pendingApprovals: new Map(), pendingExternalWrites: new Map(), startedAt: Date.now() };
    const observedReads: string[] = [];
    entry.skillFiles = [{ id: "fixture-skill", path: join(root, "source.txt") }];
    const coordinator = new SessionEventCoordinator({ registry: { get: () => entry }, userTurnCounters: new Map(),
      runtimeSnapshots: repository, pendingActions: { remove: noop }, skillsService: { resolveLearnedSkillRead: () => undefined },
      loadoutObservations: { markSkillUsed: (_task: string, _assistant: string, skill: string) => observedReads.push(skill) },
      emitPatch: noop, emitContextUsage: noop, maybeEmitArtifact: async () => {},
    } as any);
    coordinator.attach("task", root, session);
    subscriber({ type: "tool_execution_start", ...event });
    subscriber({ type: "tool_execution_end", ...event });
    assert.deepEqual(entry.skillReads, { assistantMessageId: "assistant", ids: ["fixture-skill"] },
      "successful real SDK read records skill reading separately from tool/trial success");
    assert.deepEqual(observedReads, ["fixture-skill"]);
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1);
    repository.appendMaterials(ctx, evidence);
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1, "Repeated event is deduplicated");
    subscriber({ type: "tool_execution_start", ...event, toolCallId: "late" });
    entry.executionId = "next"; entry.assistantMessageId = "next-assistant";
    subscriber({ type: "tool_execution_end", ...event, toolCallId: "late" });
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1, "Late result is not attributed after execution switch");
    assert.equal(entry.skillReads.assistantMessageId, "assistant", "late skill reads cannot be attributed to next turn");
    repository.appendMaterials({ ...ctx, assistantMessageId: "wrong" }, search);
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1);
    repository.appendMaterials(ctx, search);
    const stored = repository.list("task")[0];
    db.close(); db = new AppDatabase(dbPath); repository = new RuntimeContextSnapshotRepository(db.connection);
    assert.deepEqual(repository.list("task")[0].materialUsage, stored.materialUsage, "Evidence survives reopen");
    repository.appendMaterials(ctx, Array.from({ length: 110 }, (_, index) => ({ ...evidence[0], toolCallId: `bulk-${index}` })));
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 100);
    assert.equal(repository.list("task")[0].materialUsage?.omitted, 12);
    repository.finish(ctx.executionId, "completed");
    repository.appendMaterials(ctx, [{ ...evidence[0], toolCallId: "after-finish" }]);
    assert.equal(repository.list("task")[0].materialUsage?.omitted, 12, "Terminal records cannot accept late evidence");
    db.connection.prepare("UPDATE task_runtime_context_snapshots SET material_usage_json = '{broken'").run();
    assert.equal(repository.list("task")[0].materialUsage, undefined, "Corrupt audit payload must not break the inspector");
    console.log("runtime materials: PASS (real SDK read, knowledge adapter, lifecycle identity, dedup, reopen, bounds, corrupt record)");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
