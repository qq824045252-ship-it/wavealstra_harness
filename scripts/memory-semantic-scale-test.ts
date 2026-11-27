import { seedHistoricalBotTurn } from "./fixtures/historical-bot";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { SemanticRuntime } from "../src/main/retrieval/SemanticRuntime";
import { SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../src/main/retrieval/SemanticModelManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { memorySearchWhere } from "../src/main/memory/MemorySearchScope";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { DOTS_TASK_ID } from "../src/shared/dots";

// Budgets apply to this fixed fixture, not an arbitrary production profile.
const BUDGET = { queryMs: 1500, eventLoopDelayMs: 50, rssGrowthBytes: 256 * 1024 * 1024 };
const root = mkdtempSync(join(tmpdir(), "memory-vector-scale-"));
const useNative = process.argv.includes("--native");
const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert(runtimeAuditExecutable);
const db = new AppDatabase(join(root, "app.db"), { runtimeAuditExecutable });
const originalEmbed = SemanticRuntime.prototype.embed;
const samples: Array<{ path: string; durationMs: number; eventLoopDelayMs: number; firstTickMs: number; histogramMaxMs: number; rssBytes: number; returned: number }> = [];
const loop = monitorEventLoopDelay({ resolution: 5 });
try {
  new BotRegistry(db.connection).registerBot({ userId: LOCAL_USER_ID, botId: "scale-owner", displayName: "scale" });
  const receipt = seedHistoricalBotTurn(db.connection, LOCAL_USER_ID, { botId: "scale-owner", requestId: "seed", text: "isolated scope fixture" });
  const space = db.createSpace({ name: "unrelated scope" });
  const lexical = new MemoryService(db, { semantic: false });
  const longText = "unrelated technical reference; stable fixture data and vocabulary without the unique target. ".repeat(100).slice(0, 8192);
  const target = lexical.create({ scopeType: "bot", scopeId: "scale-owner", kind: "fact", title: "QZVXNEEDLE", content: "Calibration constant 17.25", sourceType: "user" });
  const queryVector = new Float32Array(SEMANTIC_DIMENSION); queryVector[0] = 1;
  const fillerVector = new Float32Array(SEMANTIC_DIMENSION); fillerVector[0] = 0.25; fillerVector[1] = Math.sqrt(1 - 0.25 ** 2);
  db.connection.transaction(() => {
    const insert = db.connection.prepare(`INSERT INTO memory_records SELECT ?,kind,?,?,'active',3,confidence,explicit,source_type,
      source_id,source_task_id,valid_from,valid_until,?,created_at,updated_at+1,last_recalled_at,recall_count,metadata_json FROM memory_records WHERE id=?`);
    const bind = db.connection.prepare("INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,binding,created_at) VALUES (?,?,?,?,?,?)");
    const embedding = db.connection.prepare(`INSERT INTO memory_embeddings(memory_id,model_id,model_version,content_hash,dimension,embedding,created_at) VALUES (?,?,?,?,?,?,?)`);
    for (let i = 0; i < 10000; i++) {
      const id = i === 0 ? target.id : `a-scale-${String(i).padStart(5, "0")}`;
      const hash = i === 0 ? target.contentHash : `scale-hash-${i}`;
      if (i > 0) {
        insert.run(id, `Reference ${i}`, longText, hash, target.id);
        bind.run(`bot-${i}`, id, "bot", "scale-owner", "owned", Date.now());
      }
      bind.run(`conversation-${i}`, id, "conversation", receipt.conversationId, "promoted", Date.now());
      bind.run(`workspace-${i}`, id, "workspace", space.id, "promoted", Date.now());
      embedding.run(id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, hash, SEMANTIC_DIMENSION,
        Buffer.from((i === 0 ? queryVector : fillerVector).buffer), Date.now());
    }
  })();
  const counts = db.connection.prepare(`SELECT (SELECT count(*) FROM memory_records) records,(SELECT count(*) FROM memory_embeddings) vectors,
    (SELECT count(*) FROM memory_scopes) bindings,(SELECT max(length(content)) FROM memory_records) maxTextChars`).get();
  assert.deepEqual(counts, { records: 10000, vectors: 10000, bindings: 30000, maxTextChars: 8192 });
  assert.equal((db.connection.prepare("SELECT count(*) n FROM memory_embeddings WHERE memory_id<?").get(target.id) as { n: number }).n, 9999,
    "the semantic-only target is last in the actual vector cursor, requiring all 10K vectors to be visited");
  let embeddings = 0;
  SemanticRuntime.prototype.embed = async () => { embeddings++; return queryVector; };
  const semantic = new MemoryService(db);
  const where = memorySearchWhere({ scopes: semantic.resolveScopeChain({ botId: "scale-owner", conversationId: receipt.conversationId,
    scopeTypes: ["global", "conversation", "bot"], includeInherited: true }) });
  const vectorPlan = db.connection.prepare(`EXPLAIN QUERY PLAN SELECT e.memory_id,e.embedding,e.dimension,e.content_hash,m.content_hash AS current_hash
    FROM memory_embeddings e CROSS JOIN memory_records m ON m.id=e.memory_id WHERE e.model_id=? AND e.model_version=? AND ${where.sql}
    AND e.memory_id>? ORDER BY e.memory_id LIMIT 128`).all(SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, ...where.args, "");
  const bridge = (memory: MemoryService) => ({ search: (botId: string, query: string, conversationId: string) =>
    memory.searchHybrid({ botId, conversationId, scopeTypes: ["global", "conversation", "bot"], includeInherited: true, query, statuses: ["active"], limit: 20 }) });
  const routes = [{ path: "lexical", adapter: bridge(lexical), query: "QZVXNEEDLE" }, { path: "semantic", adapter: bridge(semantic), query: "ZZYXYX" }];
  const reader = db.runtimeAuditReader;
  let rustLexicalRuns = 0;
  if (reader) {
    const candidates = reader.memoryLexical.bind(reader);
    reader.memoryLexical = async request => {
      const result = await candidates(request);
      assert(result, "Rust must return candidates without the host scanner");
      if (request.compact === "qzvxneedle") {
        assert.deepEqual(result.fts, [target.id]);
        assert.equal(result.lexical.length, 10000);
        assert.deepEqual(result.lexical.filter(hit => hit.exact).map(hit => hit.id), [target.id]);
        rustLexicalRuns++;
      }
      return result;
    };
    const search = reader.semantic.bind(reader);
    reader.semantic = async request => {
      const result = await search(request);
      assert.deepEqual(result, [{ id: target.id, hash: target.contentHash, score: 1 }], "Rust scans all 10K vectors and returns the eligible target");
      return result;
    };
  }
  for (const route of routes) assert((await route.adapter.search("scale-owner", route.query, receipt.conversationId)).some(hit => hit.memory.id === target.id));
  const baselineRss = process.memoryUsage().rss;
  loop.enable();
  for (let i = 0; i < 5; i++) {
    for (const route of routes) {
      await pause(10); loop.reset();
      const begin = performance.now();
      const firstTick = pause(0).then(() => performance.now() - begin);
      const hits = await route.adapter.search("scale-owner", route.query, receipt.conversationId);
      const durationMs = performance.now() - begin;
      const firstTickMs = await firstTick;
      await pause(10);
      assert(hits.length <= 20 && hits.some(hit => hit.memory.id === target.id), "completed timed search must return the old target");
      assert.equal(new Set(hits.map(hit => hit.memory.id)).size, hits.length);
      // Preserve both signals so a failure can distinguish initial timer starvation from later loop stalls.
      samples.push({ path: route.path, durationMs, eventLoopDelayMs: Math.max(loop.max / 1e6, firstTickMs), firstTickMs, histogramMaxMs: loop.max / 1e6, rssBytes: process.memoryUsage().rss, returned: hits.length });
    }
  }
  assert.equal(embeddings, 6, "all five semantic requests plus warmup actually embedded and searched");
  if (reader) assert.equal(rustLexicalRuns, 6, "all five keyword requests plus warmup actually use Rust");
  const failures = samples.filter(sample => sample.durationMs > BUDGET.queryMs || sample.eventLoopDelayMs > BUDGET.eventLoopDelayMs);
  const rssGrowth = Math.max(0, process.resourceUsage().maxRSS * 1024 - baselineRss);
  const report = { fixture: counts, dimension: SEMANTIC_DIMENSION, nativeVectors: useNative,
    embeddingComputation: "controlled; 10000 real stored vectors", budget: BUDGET,
    samples, vectorPlan, baselineRss, rssGrowth, failedSamples: failures.length, rssPassed: rssGrowth <= BUDGET.rssGrowthBytes };
  writeFileSync("out/tests/memory-semantic-scale.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.equal(failures.length, 0, "10K long-text multi-scope foreground recall must meet latency and event-loop budgets");
  assert(rssGrowth <= BUDGET.rssGrowthBytes, "10K query RSS growth must stay inside its stated budget");
  if (reader) {
    const search = reader.semantic.bind(reader);
    reader.semantic = async request => {
      const stale = await search(request);
      db.connection.prepare("UPDATE memory_records SET status='invalid' WHERE id=?").run(target.id);
      return stale;
    };
    assert.deepEqual(await routes[1].adapter.search("scale-owner", routes[1].query, receipt.conversationId), [],
      "a memory retired after Rust ranks it is never returned");
    assert.equal(lexical.repository.get(target.id)?.status, "invalid");

    const privateTaskId = "private-lexical-fixture";
    for (const id of [DOTS_TASK_ID, privateTaskId]) db.upsertTask({ id, title: id, updatedAt: Date.now() });
    const scoped = lexical.create({
      scopeType: "task", scopeId: DOTS_TASK_ID, kind: "fact", sourceType: "user",
      title: "ＡＢ１２：真空－检漏", content: "ΔΟΣ　𠀀字X。编号 0123456789abcdef。失效校验",
    });
    lexical.create({
      scopeType: "task", scopeId: privateTaskId, kind: "fact", sourceType: "user",
      title: "ＡＢ１２：真空检漏", content: "ΔΟΣ　𠀀字X。编号 0123456789abcdef。失效校验",
    });
    const scope = { scopes: [{ scopeType: "task" as const, scopeId: DOTS_TASK_ID }] };
    for (const query of ["AB12 真空检漏", "δος", "𠀀字X", "0123456789abcdef"]) {
      const outcomes = await lexical.repository.searchScopedAsync(query, scope, 10, () => true);
      assert.deepEqual(outcomes.scoped.map(item => item.memory.id), [scoped.id], "only the current task's Unicode match is visible");
      assert.deepEqual(outcomes, lexical.repository.searchScoped(query, scope, 10, () => true));
    }
    const candidates = reader.memoryLexical.bind(reader);
    reader.memoryLexical = async request => {
      const stale = await candidates(request);
      if (request.compact === "失效校验") {
        assert(stale?.lexical.some(hit => hit.id === scoped.id));
        db.connection.prepare("UPDATE memory_records SET status='invalid' WHERE id=?").run(scoped.id);
      }
      return stale;
    };
    assert.deepEqual(await lexical.searchLexical({ taskId: DOTS_TASK_ID, query: "失效校验" }), [],
      "a keyword candidate invalidated after native selection must be removed");
    assert.equal(lexical.repository.get(scoped.id)?.status, "invalid");
    console.log("PASS Rust FTS and lexical candidates preserve Unicode matches, scope and concurrent invalidation");
  }
} finally {
  loop.disable(); SemanticRuntime.prototype.embed = originalEmbed;
  await db.runtimeAuditReader?.close();
  db.close(); rmSync(root, { recursive: true, force: true });
}
