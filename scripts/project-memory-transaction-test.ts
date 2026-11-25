import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { projectMemoryContext, readMemoryContextBaselines } from "../src/main/agent/MemoryContextProjection";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryForgetWatermarks } from "../src/main/memory/MemoryForgetWatermarks";
import { tokenSimilarity } from "../src/main/memory/MemoryRecallRanking";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";

async function checkSearch(db: AppDatabase, projects: ProjectService, memory: MemoryService): Promise<void> {
  db.connection.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('search-a','Search A',1,1),('search-b','Search B',1,1)");
  const scope = { scopeType: "project" as const, scopeId: "search-a" };
  const withdrawn = memory.create({ ...scope, kind: "fact", title: "ObsoleteMarker", content: "ObsoleteMarker is peacock" });
  const similar = memory.create({ ...scope, kind: "fact", title: "校𠀀泵检修", content: "现场更新后再确认。" });
  const matching = memory.create({ ...scope, kind: "fact", title: "校𠀀泵检查", content: "确认流量。",
    evidence: [{ evidenceKind: "task", refId: "fixture", excerpt: "用户：ObsoleteMarker is peacock" }] });
  const otherProject = memory.create({ ...scope, scopeId: "search-b", kind: "fact", title: "校𠀀泵检查", importance: 3 });
  await projects.deleteMemoryAsync({ projectId: "search-a", id: withdrawn.id });

  const query = "校𠀀泵检查";
  const expected = projects.searchMemory("search-a", query);
  assert.ok(expected.some(item => item.id === matching.id));
  assert.ok(expected.some(item => item.id === similar.id));
  const runtime = db.runtimeAuditReader;
  let usedRustCandidates = false;
  const rustScores = new Set<string>();
  const discover = runtime?.memoryLexical.bind(runtime);
  const score = runtime?.memoryLexicalScores.bind(runtime);
  if (runtime && discover && score) {
    runtime.memoryLexical = async input => {
      const result = await discover(input);
      assert(result, "Rust must return lexical candidates");
      usedRustCandidates = true;
      assert(!result.lexical.some(candidate => candidate.id === otherProject.id));
      return result;
    };
    runtime.memoryLexicalScores = async input => {
      const scores = await score(input);
      assert(scores?.length, "Rust must return text scores");
      for (const { id, similarity } of scores) {
        const record = memory.get(id)!;
        assert.equal(similarity, Math.max(tokenSimilarity(query, record.title) * 1.15, tokenSimilarity(query, record.content)));
        rustScores.add(id);
      }
      return scores;
    };
  }
  try {
    assert.deepEqual(await projects.searchMemoryAsync("search-a", query), expected);
    assert.deepEqual((await projects.searchMemoryAsync("search-a", query, 1)).map(item => item.id), [expected[0]!.id]);
    if (runtime) {
      assert.ok(usedRustCandidates);
      assert.ok(rustScores.has(matching.id) && rustScores.has(similar.id));
    }
  } finally {
    if (runtime && discover && score) {
      runtime.memoryLexical = discover;
      runtime.memoryLexicalScores = score;
    }
  }
  const hits = await memory.searchLexical({ projectId: "search-a", scopeTypes: ["project"], includeInherited: false, query });
  assert.deepEqual(hits.find(hit => hit.memory.id === matching.id)?.memory.evidence, []);
  assert.equal(memory.get(matching.id)?.evidence[0]?.excerpt, "用户：ObsoleteMarker is peacock");

  if (runtime && score) {
    const moved = memory.create({ ...scope, kind: "fact", title: "TransferScopeMarker", content: "TransferScopeMarker documented" });
    memory.promote(moved.id, "project", "search-b");
    let detached = false;
    runtime.memoryLexicalScores = async input => {
      const scores = await score(input);
      assert(scores?.some(result => result.id === moved.id));
      await projects.deleteMemoryAsync({ projectId: "search-a", id: moved.id });
      detached = true;
      return scores;
    };
    try {
      const results = await projects.searchMemoryAsync("search-a", "TransferScopeMarker");
      assert.ok(detached && !results.some(item => item.id === moved.id));
    } finally { runtime.memoryLexicalScores = score; }
    assert.ok((await projects.searchMemoryAsync("search-b", "TransferScopeMarker")).some(item => item.id === moved.id));

    const input = { projectId: "search-a", scopeTypes: ["project" as const], includeInherited: false,
      query: "Unrelated test question", trackRecall: false };
    const expectedBaseline = projectMemoryContext(memory, input, []);
    assert.ok(expectedBaseline.items.some(item => item.id === matching.id));
    const baselines = await readMemoryContextBaselines(memory, input);
    assert(baselines, "Rust must return the baselines for automatic recall");
    const emptyQuery = { ...input, query: undefined };
    const expectedWithoutQuery = memory.search(emptyQuery).map(hit => hit.memory.id);
    const searchOnHost = memory.search.bind(memory);
    memory.search = () => { throw new Error("Unexpected host baseline scan"); };
    try {
      const nativeBaseline = projectMemoryContext(memory, input, [], [], baselines);
      assert.equal(nativeBaseline.text, expectedBaseline.text);
      assert.deepEqual(nativeBaseline.sourceRevisions, expectedBaseline.sourceRevisions);
      assert.deepEqual((await memory.searchLexical(emptyQuery)).map(hit => hit.memory.id), expectedWithoutQuery);
    } finally { memory.search = searchOnHost; }
    await projects.updateMemoryAsync({ projectId: "search-a", id: matching.id, content: "按新校准值复核流量。" });
    const changed = projectMemoryContext(memory, input, [], [], baselines);
    assert.ok(changed.text.includes("按新校准值复核流量。"));
    assert.ok(!changed.text.includes("确认流量。"));
  }
}

async function main(): Promise<void> {
  const flag = process.argv.indexOf("--native");
  const executable = flag < 0 ? undefined : locateRuntimeAudit(process.argv[flag + 1] ?? process.cwd());
  if (flag >= 0) assert(executable && existsSync(executable), "Rust worker executable is required");
  const root = mkdtempSync(join(tmpdir(), "mybuddy-project-memory-"));
  const path = join(root, "app.db");
  const db = new AppDatabase(path, { runtimeAuditExecutable: executable });
  const native = db.runtimeAuditReader;
  const memory = new MemoryService(db, { semantic: false });
  const projects = new ProjectService(new ProjectRepository(db.connection, native), memory);
  const watermarks = new MemoryForgetWatermarks(db.connection);
  const scope = { scopeType: "project" as const, scopeId: "p1" };
  const countTargets = () => db.connection.prepare("SELECT count(*) FROM memory_forget_targets").pluck().get();
  try {
    if (native) assert.equal(await native.supportsProjectWrites("memoryEdits"), true);
    db.connection.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','P1',1,1),('p2','P2',1,1)");
    db.upsertTask({ id: "memory-actor", title: "Captured readings", updatedAt: 1, projectId: "p1" });
    const outside = memory.create({ scopeType: "project", scopeId: "p2", kind: "fact", title: "Outside memory", content: "Other project" });
    memory.create({ ...scope, kind: "fact", title: "Invalidated observation", status: "invalid" });
    const item = memory.create({ ...scope, kind: "fact", title: "ReleaseMarker", content: "ReleaseMarker is bronze",
      confidence: 0.731, explicit: true, validFrom: 1.25,
      metadata: { tags: ["initial"], retained: "yes" },
      evidence: [
        { evidenceKind: "external", refId: "e0", excerpt: "用户：EvidenceMarker is ruby" },
        { evidenceKind: "task", refId: "memory-actor", refTitle: "Captured readings" },
      ] });
    const request = { projectId: "p1", id: item.id };
    db.connection.prepare(`INSERT INTO memory_scenarios(id,scope_type,scope_id,title,summary,content_hash,created_at,updated_at)
      VALUES ('p1-view','project','p1','P1 view','derived','x',1,1),('p2-view','project','p2','P2 view','derived','x',1,1)`).run();
    const scenarioState = () => db.connection.prepare("SELECT id,status FROM memory_scenarios ORDER BY id").all();
    const startingClock = projects.get("p1")!.updatedAt;
    const edited = await projects.updateMemoryAsync({ ...request, content: "ReleaseMarker is silver", tags: ["verified"] });
    assert.deepEqual([edited.title, edited.content, edited.tags], ["ReleaseMarker", "ReleaseMarker is silver", ["verified"]]);
    assert.deepEqual(memory.history(item.id).map(revision => [revision.revision, revision.content]), [
      [2, "ReleaseMarker is silver"], [1, "ReleaseMarker is bronze"],
    ]);
    assert.deepEqual(memory.history(item.id).map(revision => [revision.confidence, revision.validFrom]), [[0.731, 1.25], [0.731, 1.25]]);
    assert.equal(memory.get(item.id)?.metadata.retained, "yes");
    const readOnHost = projects.listMemory.bind(projects);
    if (native) projects.listMemory = () => { throw new Error("Native memory list unexpectedly used the host query"); };
    try {
      const visible = await projects.readMemoryList("p1");
      assert.deepEqual(visible, readOnHost("p1"));
      assert.deepEqual(visible.map(row => [row.id, row.tags, row.evidence.map(evidence => [evidence.evidenceKind, evidence.refTitle])]), [
        [item.id, ["verified"], [["task", "Captured readings"]]],
      ]);
      assert.deepEqual((await projects.readMemoryList("p2")).map(row => row.id), [outside.id]);
      await assert.rejects(projects.readMemoryList("missing"), /项目不存在/);
    } finally { projects.listMemory = readOnHost; }
    assert.equal(projects.searchMemory("p1", "silver")[0]?.id, item.id);
    assert.deepEqual(scenarioState(), [{ id: "p1-view", status: "stale" }, { id: "p2-view", status: "active" }]);
    assert.ok(projects.get("p1")!.updatedAt > startingClock);
    const unchangedClock = projects.get("p1")!.updatedAt;
    await projects.updateMemoryAsync({ ...request, content: "ReleaseMarker is silver", tags: ["verified"] });
    assert.equal(memory.history(item.id).length, 2);
    assert.equal(projects.get("p1")?.updatedAt, unchangedClock);

    db.connection.exec(`CREATE TRIGGER fixture_fail_revision BEFORE INSERT ON memory_revisions
      WHEN new.memory_id='${item.id}' BEGIN SELECT RAISE(ABORT,'fixture failed revision'); END`);
    try { await assert.rejects(projects.updateMemoryAsync({ ...request, content: "Revision should roll back" }), /fixture failed revision|项目数据写入失败/); }
    finally { db.connection.exec("DROP TRIGGER fixture_fail_revision"); }
    assert.equal(projects.getMemory("p1", item.id)?.content, "ReleaseMarker is silver");
    assert.equal(memory.history(item.id).length, 2);
    assert.equal(projects.get("p1")?.updatedAt, unchangedClock);

    await Promise.all([
      projects.updateMemoryAsync({ ...request, tags: ["edited together"] }),
      projects.updateMemoryAsync({ ...request, importance: 3 }),
    ]);
    const combined = projects.getMemory("p1", item.id);
    assert.deepEqual([combined?.tags, combined?.importance], [["edited together"], 3]);
    assert.equal(memory.history(item.id).length, 4);

    if (native) {
      const write = native.writeProject.bind(native);
      native.writeProject = (...args) => {
        db.upsertTask({ id: "memory-actor", title: "Captured readings", updatedAt: 2, projectId: "p2" });
        return write(...args);
      };
      try {
        await assert.rejects(projects.updateMemoryAsync({ ...request, title: "Wrong project" },
          { taskId: "memory-actor", projectId: "p1" }), /项目归属已变化/);
        assert.equal(projects.getMemory("p1", item.id)?.title, "ReleaseMarker");
      } finally { native.writeProject = write; }
    }

    db.connection.exec(`CREATE TRIGGER fixture_fail_forget BEFORE DELETE ON memory_records
      WHEN old.id='${item.id}' BEGIN SELECT RAISE(ABORT,'fixture failed forget'); END`);
    try { await assert.rejects(projects.deleteMemoryAsync(request), /fixture failed forget|项目数据写入失败/); }
    finally { db.connection.exec("DROP TRIGGER fixture_fail_forget"); }
    assert.equal(projects.getMemory("p1", item.id)?.importance, 3);
    assert.equal(countTargets(), 0);
    assert.equal(memory.history(item.id).length, 4);

    if (native) {
      const write = native.writeProject.bind(native);
      let retried = false;
      native.writeProject = async (...args) => {
        if (!retried) {
          memory.update({ id: item.id, content: "ReleaseMarker is platinum" });
          const outcome = await write(...args);
          assert.equal(outcome, "stale");
          assert.equal(countTargets(), 0);
          assert.equal(projects.getMemory("p1", item.id)?.content, "ReleaseMarker is platinum");
          retried = true;
          return outcome;
        }
        assert.equal(await write(...args), "changed");
        throw new Error("fixture lost detach receipt");
      };
      try { await projects.deleteMemoryAsync(request); }
      finally { native.writeProject = write; }
      assert.ok(retried);
    } else {
      await projects.deleteMemoryAsync(request);
    }
    assert.equal(memory.get(item.id), undefined);
    assert.deepEqual(memory.history(item.id), []);
    assert.equal(projects.searchMemory("p1", "silver").length, 0);
    for (const text of ["ReleaseMarker is bronze", "ReleaseMarker is silver", "EvidenceMarker is ruby",
      ...(native ? ["ReleaseMarker is platinum"] : [])]) {
      assert.equal(watermarks.sourceFilter([scope])(text, "", 1).userText, "", text);
    }
    const removedClock = projects.get("p1")?.updatedAt;
    await projects.deleteMemoryAsync(request);
    assert.equal(projects.get("p1")?.updatedAt, removedClock);

    const shared = memory.create({ ...scope, kind: "fact", title: "SharedMarker", content: "SharedMarker is teal", metadata: { tags: [] } });
    const sharedRequest = { projectId: "p1", id: shared.id };
    if (native) {
      const write = native.writeProject.bind(native);
      native.writeProject = (...args) => {
        memory.promote(shared.id, "global");
        return write(...args);
      };
      try {
        await assert.rejects(projects.updateMemoryAsync({ ...sharedRequest, title: "Blocked after sharing" }), /已共享到其他作用域/);
      } finally { native.writeProject = write; }
    } else {
      memory.promote(shared.id, "global");
    }
    await assert.rejects(projects.updateMemoryAsync({ ...sharedRequest, title: "Blocked shared edit" }), /已共享到其他作用域/);
    assert.equal(memory.history(shared.id).length, 1);
    await projects.deleteMemoryAsync({ projectId: "p2", id: shared.id });
    assert.ok(projects.getMemory("p1", shared.id));
    await projects.archiveAsync("p1", true);
    await assert.rejects(projects.deleteMemoryAsync(sharedRequest), /项目已归档/);
    await projects.archiveAsync("p1", false);
    await projects.deleteMemoryAsync(sharedRequest);
    assert.equal(projects.getMemory("p1", shared.id), undefined);
    assert.deepEqual(memory.get(shared.id)?.scopes.map(binding => binding.scopeType), ["global"]);
    assert.equal(watermarks.sourceFilter([scope])("SharedMarker is teal", "", 1).userText, "");
    assert.equal(watermarks.sourceFilter([{ scopeType: "global" }])("SharedMarker is teal", "", 1).userText, "SharedMarker is teal");
    await checkSearch(db, projects, memory);
    assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
    console.log(`Project memory edits, deletion and search passed (${native ? "Rust worker" : "host"})`);
  } finally {
    await native?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
