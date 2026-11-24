/** Manual parity check with an installed BGE-M3 model and the development Rust worker. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { setMaterialRetrievalScope } from "../src/main/library/MaterialRetrievalSettings";
import { MemoryService } from "../src/main/memory/MemoryService";
import { locateRuntimeAudit, locateSemanticInferenceLibrary, type RuntimeEmbeddingSource } from "../src/main/platform/runtime-audit";
import { SemanticModelManager, SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../src/main/retrieval/SemanticModelManager";
import { SemanticRuntime } from "../src/main/retrieval/SemanticRuntime";

async function main(): Promise<void> {
  const executable = locateRuntimeAudit(process.cwd());
  const libraryPath = locateSemanticInferenceLibrary();
  assert(executable && libraryPath, "the resident worker and the ONNX Runtime library must be available");
  const manager = new SemanticModelManager(process.argv[2]);
  const fixtures = [
    "",
    "常驻向量检索 temperature compensation",
    "ＡＢ　café cafe\u0301 \u{20000} 🧭 \uD800",
    "词表与语义检索 mixed vocabulary; ".repeat(180),
  ];
  const dir = mkdtempSync(join(tmpdir(), "mybuddy-native-inference-"));
  const db = new AppDatabase(join(dir, "app.db"), { runtimeAuditExecutable: executable });
  const reader = db.runtimeAuditReader!;
  const host = new SemanticRuntime(manager);
  const native = new SemanticRuntime(manager, reader);
  try {
    const modelStatus = await manager.getStatusAsync(reader);
    assert.equal(modelStatus.status, "ready", modelStatus.error ?? "BGE-M3 must be installed");
    assert.match(modelStatus.revision ?? "", /^[a-f0-9]{64}$/);
    const requiredFiles = ["model.onnx", "bge-m3-int8.onnx.data", "tokenizer.json"];
    const fixture = join(dir, "model-assets");
    mkdirSync(fixture);
    const files = requiredFiles.map(name => {
      const content = Buffer.from(`scope fixture for ${name}`);
      writeFileSync(join(fixture, name), content);
      return { name, sha256: createHash("sha256").update(content).digest("hex"), size: content.length };
    });
    writeFileSync(join(fixture, "manifest.json"), JSON.stringify({
      modelId: SEMANTIC_MODEL_ID, modelVersion: SEMANTIC_MODEL_VERSION, dimension: SEMANTIC_DIMENSION, files,
    }));
    const probe = {
      roots: [fixture], fallbackRoot: fixture, modelId: SEMANTIC_MODEL_ID,
      modelVersion: SEMANTIC_MODEL_VERSION, dimension: SEMANTIC_DIMENSION, requiredFiles,
    };
    assert.equal((await reader.probeSemanticModel(probe))?.status, "ready");
    const payload = join(fixture, requiredFiles[1]!);
    writeFileSync(payload, Buffer.alloc(files[1]!.size, 0x78));
    const date = new Date(Date.now() - 10_000);
    utimesSync(payload, date, date);
    assert.deepEqual(await reader.probeSemanticModel(probe), {
      status: "corrupt", error: "SHA-256 校验失败：bge-m3-int8.onnx.data", modelsRoot: fixture, revision: null,
    }, "a same-size change must invalidate the worker's verified-file cache");
    assert.equal((await new SemanticModelManager(fixture).getStatusAsync()).status, "corrupt");
    const missing = join(dir, "missing-model");
    assert.equal((await reader.probeSemanticModel({ ...probe, roots: [missing], fallbackRoot: missing }))?.status, "not_installed");
    const fallback = await reader.probeSemanticModel({ ...probe, roots: [fixture, modelStatus.modelsRoot] });
    assert.equal(fallback?.status, "ready");
    assert.equal(fallback?.modelsRoot, modelStatus.modelsRoot);
    console.log("PASS Rust model manifest verification, tamper detection and directory fallback");

    const execute = reader.semanticInference.bind(reader);
    let computed = 0;
    reader.semanticInference = async (model, text) => {
      assert.equal(model.libraryPath, libraryPath);
      const result = await execute(model, text);
      assert(result, "the Rust inference path must succeed");
      if (text !== undefined) {
        assert.equal(result.vector?.length, SEMANTIC_DIMENSION);
        computed++;
      }
      return result;
    };
    for (const text of fixtures) {
      const [actual, expected, snapshots] = await Promise.all([
        native.embed(text), host.embed(text), reader.snapshots("embedding-isolation-fixture", 1),
      ]);
      assert(snapshots, "the database lane still accepts queries while Rust embeds");
      assert.equal(expected.length, SEMANTIC_DIMENSION);
      assert.equal(actual.length, expected.length);
      const maxError = Math.max(...actual.map((value, index) => Math.abs(value - expected[index]!)));
      assert(maxError < 1e-5, `semantic vectors must remain compatible, max error: ${maxError}`);
    }
    assert.equal(computed, fixtures.length);
    console.log(`PASS BGE-M3 Rust/Node parity across ${computed} inputs and concurrent database requests`);

    const model = {
      libraryPath, modelPath: manager.getModelPath(), tokenizerPath: manager.getTokenizerPath(),
      dimension: SEMANTIC_DIMENSION, revision: modelStatus.revision ?? undefined,
    };
    const stage = async (source: RuntimeEmbeddingSource): Promise<string> => {
      const result = await reader.stageEmbedding(model, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, source);
      assert.equal(result?.status, "staged");
      if (result?.status !== "staged") throw new Error("Rust did not retain a staged vector");
      return result.token;
    };
    const memory = new MemoryService(db, { semantic: false });
    const makeMemory = (title: string) => memory.create({
      kind: "fact", title, content: "温度与量程的校准记录", scopeType: "global",
    });
    const record = makeMemory("仍有效的原文");
    const withdrawn = makeMemory("马上遗忘的原文");
    const ready = await stage({ kind: "memory", id: record.id, hash: record.contentHash });
    const stale = await stage({ kind: "memory", id: withdrawn.id, hash: withdrawn.contentHash });
    memory.forget(withdrawn.id);

    const parent = db.createSpace({ name: "Ancestor" });
    const child = db.createSpace({ name: "Child", parentId: parent.id });
    const library = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const space = library.createSpace({ name: "Indexed documents", workspaceId: child.id });
    const item = library.createItem({ title: "Calibration", kind: "markdown", spaceId: space.id });
    library.writeContent({ id: item.id, content: "资料库的传感器检定与标定" });
    const chunk = db.connection.prepare("SELECT id,hash FROM library_chunks WHERE item_id=?").get(item.id) as { id: string; hash: string };
    const librarySource = { kind: "library" as const, ...chunk };
    const disabled = await stage(librarySource);
    setMaterialRetrievalScope(db, { kind: "space", id: parent.id }, "keyword");
    db.connection.pragma("query_only = ON");
    try {
      assert.deepEqual(await reader.publishEmbeddings([ready, stale, disabled]),
        { indexed: 1, current: 0, skipped: 2 }, "the Rust writer checks withdrawals and inherited retrieval settings inside its transaction");
      assert.deepEqual(db.connection.prepare("SELECT memory_id AS id,length(embedding) AS bytes FROM memory_embeddings").all(),
        [{ id: record.id, bytes: SEMANTIC_DIMENSION * 4 }]);
      assert.deepEqual(db.connection.prepare("SELECT chunk_id FROM library_chunk_embeddings").all(), []);
    } finally {
      db.connection.pragma("query_only = OFF");
    }

    setMaterialRetrievalScope(db, { kind: "space", id: parent.id }, "hybrid");
    const next = makeMemory("事务回滚验收");
    const nextMemory = await stage({ kind: "memory", id: next.id, hash: next.contentHash });
    const nextChunk = await stage(librarySource);
    db.connection.exec(`CREATE TRIGGER reject_embedding_fixture BEFORE INSERT ON library_chunk_embeddings
      BEGIN SELECT RAISE(ABORT, 'fixture rejects embeddings'); END`);
    try {
      assert.equal(await reader.publishEmbeddings([nextMemory, nextChunk]), undefined);
      assert.equal(db.connection.prepare("SELECT 1 FROM memory_embeddings WHERE memory_id=?").get(next.id), undefined);
    } finally {
      db.connection.exec("DROP TRIGGER reject_embedding_fixture");
    }
    const enabled = await stage(librarySource);
    db.connection.pragma("query_only = ON");
    try {
      assert.deepEqual(await reader.publishEmbeddings([enabled]), { indexed: 1, current: 0, skipped: 0 });
      const row = db.connection.prepare("SELECT chunk_hash AS hash,length(embedding) AS bytes FROM library_chunk_embeddings WHERE chunk_id=?").get(chunk.id);
      assert.deepEqual(row, { hash: chunk.hash, bytes: SEMANTIC_DIMENSION * 4 });
    } finally {
      db.connection.pragma("query_only = OFF");
    }
    console.log("PASS Rust vector publication, withdrawal, inherited retrieval policy and atomic rollback");

    const indexModel = { modelId: SEMANTIC_MODEL_ID, modelVersion: SEMANTIC_MODEL_VERSION, dimension: SEMANTIC_DIMENSION };
    const first = makeMemory("第一个待回填");
    const second = makeMemory("第二个待回填");
    const mark = db.connection.prepare("UPDATE memory_records SET updated_at=? WHERE id=?");
    mark.run(9000000000000, first.id);
    mark.run(8999999999999, second.id);
    const queueId = "ordered-memory-fixture";
    assert.deepEqual(await reader.embeddingIndex({ kind: "openMemoryQueue", model: indexModel, queueId, limit: 2 }),
      { total: 4, completed: 1 });
    assert.deepEqual(await reader.embeddingIndex({ kind: "memoryPage", queueId, limit: 1 }),
      [{ id: first.id, hash: first.contentHash }]);
    memory.forget(second.id);
    mark.run(8999999999999, next.id);
    assert.deepEqual(await reader.embeddingIndex({ kind: "memoryPage", queueId, limit: 1 }),
      [{ id: second.id, hash: null }], "queue order is frozen but validity is checked at dispatch");
    assert.deepEqual(await reader.embeddingIndex({ kind: "memoryPage", queueId, limit: 1 }), []);
    assert.equal(await reader.embeddingIndex({ kind: "closeMemoryQueue", queueId }), true);

    const newItem = library.createItem({ title: "Unindexed doc", kind: "markdown", spaceId: space.id });
    library.writeContent({ id: newItem.id, content: "未写入向量的原文" });
    const pending = db.connection.prepare("SELECT id,hash FROM library_chunks WHERE item_id=?").get(newItem.id) as {
      id: string; hash: string;
    };
    assert.deepEqual(await reader.embeddingIndex({ kind: "libraryStats", model: indexModel }),
      { total: 2, completed: 1 });
    assert.deepEqual(await reader.embeddingIndex({ kind: "libraryPage", model: indexModel, after: null, limit: 1 }), [pending]);
    assert.deepEqual(await reader.embeddingIndex({ kind: "libraryPage", model: indexModel, after: pending.id, limit: 1 }), []);
    setMaterialRetrievalScope(db, { kind: "space", id: parent.id }, "keyword");
    assert.deepEqual(await reader.embeddingIndex({ kind: "libraryStats", model: indexModel }),
      { total: 0, completed: 0 }, "planner and publisher enforce the same inherited retrieval policy");
    assert.deepEqual(await reader.embeddingIndex({ kind: "libraryPage", model: indexModel, after: null, limit: 1 }), []);
    console.log("PASS Rust index planning, bounded paging, live source checks and inherited settings");
  } finally {
    host.dispose();
    await reader.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
