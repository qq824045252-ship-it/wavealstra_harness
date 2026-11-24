import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { decodeRuntimeSnapshotPage, RuntimeContextSnapshotRepository } from "../src/main/agent/RuntimeContextSnapshotRepository";
import { collectRuntimeMaterialEvidence as collect } from "../src/main/agent/RuntimeMaterialEvidence";
import { SessionEventCoordinator } from "../src/main/agent/SessionEventCoordinator";
import { createProjectKnowledgeExtension } from "../src/main/project/project-knowledge-extension";
import { locateRuntimeAudit, RuntimeAuditReader } from "../src/main/platform/runtime-audit";

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
  const executable = process.argv.includes("--native") ? locateRuntimeAudit(process.cwd()) : undefined;
  if (process.argv.includes("--native")) assert(executable);
  let reader = executable ? new RuntimeAuditReader(executable, dbPath) : undefined;
  let db = new AppDatabase(dbPath);
  try {
    db.upsertTask({ id: "task", title: "Material evidence", updatedAt: 1 });
    let repository = new RuntimeContextSnapshotRepository(db.connection, reader);
    const ctx = { taskId: "task", executionId: "execution", assistantMessageId: "assistant" };
    const instructions = "x".repeat(599) + "🦀" + "末".repeat(3600);
    const input = { ...ctx, userMessageId: "user", status: "running" as const, startedAt: Date.now(),
      mode: "coding" as const, assemblyHash: "hash", resolvedInstructions: [{ id: "instructions", title: "提示词", source: "seed" as const,
        chars: instructions.length, content: instructions }], resolvedCapabilities: [], warnings: [], workingDirectory: root };
    if (reader) db.connection.pragma("query_only=ON");
    repository.capture(input);
    repository.capture({ ...input, warnings: ["duplicate"] });
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
      searchAsync: () => ({ scope: "project", hits: [{ itemId: "doc", title: "Specification", kind: "pdf", snippet: "excerpt", readable: true }] }),
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
    await repository.flush();
    assert.deepEqual(entry.skillReads, { assistantMessageId: "assistant", ids: ["fixture-skill"] },
      "successful real SDK read records skill reading separately from tool/trial success");
    assert.deepEqual(observedReads, ["fixture-skill"]);
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1);
    repository.appendMaterials(ctx, evidence);
    await repository.flush();
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1, "Repeated event is deduplicated");
    subscriber({ type: "tool_execution_start", ...event, toolCallId: "late" });
    entry.executionId = "next"; entry.assistantMessageId = "next-assistant";
    subscriber({ type: "tool_execution_end", ...event, toolCallId: "late" });
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1, "Late result is not attributed after execution switch");
    assert.equal(entry.skillReads.assistantMessageId, "assistant", "late skill reads cannot be attributed to next turn");
    repository.appendMaterials({ ...ctx, assistantMessageId: "wrong" }, search);
    await repository.flush();
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 1);
    repository.appendMaterials(ctx, search);
    await repository.flush();
    const stored = repository.list("task")[0];
    assert.deepEqual(stored.warnings, [], "replayed admissions keep the first saved snapshot");
    assert.equal(stored.resolvedInstructions[0].content.charCodeAt(599), 0xd83e);
    if (reader) {
      const native = await reader.snapshots("task", 1);
      assert(native);
      assert.deepEqual(decodeRuntimeSnapshotPage(native), [stored], "Rust preserves excerpts and material evidence on the wire");
      await reader.close();
    }
    db.close();
    db = new AppDatabase(dbPath);
    reader = executable ? new RuntimeAuditReader(executable, dbPath) : undefined;
    repository = new RuntimeContextSnapshotRepository(db.connection, reader);
    if (reader) db.connection.pragma("query_only=ON");
    assert.deepEqual(repository.list("task")[0].materialUsage, stored.materialUsage, "Evidence survives reopen");
    repository.appendMaterials(ctx, Array.from({ length: 110 }, (_, index) => ({ ...evidence[0], toolCallId: `bulk-${index}` })));
    await repository.flush();
    assert.equal(repository.list("task")[0].materialUsage?.items.length, 100);
    assert.equal(repository.list("task")[0].materialUsage?.omitted, 12);
    repository.bindAssistantMessage({ ...ctx, assistantMessageId: "committed-assistant" });
    repository.finishByAssistantMessage(ctx.taskId, "committed-assistant", "completed");
    repository.appendMaterials({ ...ctx, assistantMessageId: "committed-assistant" }, [{ ...evidence[0], toolCallId: "after-finish" }]);
    await repository.flush();
    assert.equal(repository.list("task")[0].assistantMessageId, "committed-assistant");
    assert.equal(repository.list("task")[0].status, "completed");
    assert.equal(repository.list("task")[0].materialUsage?.omitted, 12, "Terminal records cannot accept late evidence");
    if (reader) db.connection.pragma("query_only=OFF");
    db.connection.prepare("UPDATE task_runtime_context_snapshots SET material_usage_json = '{broken'").run();
    assert.equal(repository.list("task")[0].materialUsage, undefined, "Corrupt audit payload must not break the inspector");
    if (reader) {
      const send = reader.mutateSnapshot.bind(reader);
      reader.mutateSnapshot = async (...args) => {
        const result = await send(...args);
        if (args[2].kind !== "clear") return result;
        assert.equal(result, 1, "Rust removed the snapshot before the acknowledgement was lost");
        return undefined;
      };
      try {
        const clear = repository.clearSaved(ctx.taskId);
        repository.capture({ ...input, executionId: "next" });
        repository.abortRunningForTask(ctx.taskId);
        assert.equal(await clear, 1, "the committed delete count survives a lost acknowledgement");
        await repository.flush();
        assert.deepEqual(repository.list(ctx.taskId).map(snapshot => [snapshot.executionId, snapshot.status]), [["next", "aborted"]]);
        assert.equal(await repository.clearSaved(ctx.taskId), 1);
      } finally { reader.mutateSnapshot = send; }
      db.upsertTask({ id: "removed", title: "deleted before audit write", updatedAt: 1 });
      repository.capture({ ...input, taskId: "removed", executionId: "removed-execution" });
      db.deleteTask("removed");
      repository.record({ ...input, executionId: "expired" });
      db.connection.prepare("UPDATE task_runtime_context_snapshots SET created_at=0 WHERE execution_id='expired'").run();
      for (let index = 0; index <= 50; index += 1) {
        repository.capture({ ...input, executionId: `retention-${index}` });
      }
      await repository.flush();
      const retained = repository.list(ctx.taskId, 200);
      assert.equal(retained.length, 50);
      assert.equal(retained[0].executionId, "retention-50");
      assert.equal(retained.at(-1)?.executionId, "retention-1");
      assert.deepEqual(repository.list("removed"), []);
      db.connection.prepare("UPDATE task_runtime_context_snapshots SET storage_bytes=? WHERE execution_id=?")
        .run(3 * 1024 * 1024, retained[0].executionId);
      repository.appendMaterials({ ...ctx, executionId: retained[0].executionId }, evidence);
      await repository.flush();
      assert.deepEqual(repository.list(ctx.taskId, 200).map(snapshot => snapshot.executionId), ["retention-50"]);
      assert.equal(await repository.clearSaved(ctx.taskId), 1);
      assert.equal(db.connection.prepare("SELECT COUNT(*) FROM runtime_audit_payloads").pluck().get(), 0);
      const fallback = new RuntimeContextSnapshotRepository(db.connection, new RuntimeAuditReader(undefined, dbPath));
      fallback.capture(input);
      fallback.appendMaterials(ctx, evidence);
      fallback.finish(ctx.executionId, "completed");
      await fallback.flush();
      const finished = fallback.list(ctx.taskId)[0];
      assert.equal(finished.status, "completed");
      assert.deepEqual(finished.materialUsage?.items, evidence);
    }
    console.log("runtime materials: PASS (real SDK read, knowledge adapter, lifecycle identity, dedup, reopen, bounds, corrupt record)");
  } finally { await reader?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
