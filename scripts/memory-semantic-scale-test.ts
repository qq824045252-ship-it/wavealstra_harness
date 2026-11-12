import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as pause } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationMemory } from "../src/main/agent/work/BotConversationMemory";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { SemanticRuntime } from "../src/main/retrieval/SemanticRuntime";
import { SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../src/main/retrieval/SemanticModelManager";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { memorySearchWhere } from "../src/main/memory/MemorySearchScope";

// Budgets apply to this fixed fixture, not an arbitrary production profile.
const BUDGET = { queryMs: 1500, eventLoopDelayMs: 50, rssGrowthBytes: 256 * 1024 * 1024 };
const root = mkdtempSync(join(tmpdir(), "memory-vector-scale-"));
const db = new AppDatabase(join(root, "app.db"));
const originalEmbed = SemanticRuntime.prototype.embed;
const samples: Array<{ path: string; durationMs: number; eventLoopDelayMs: number; rssBytes: number; returned: number }> = [];
const loop = monitorEventLoopDelay({ resolution: 5 });
try {
  new BotRegistry(db.connection).registerBot({ userId: LOCAL_USER_ID, botId: "scale-owner", displayName: "scale" });
  const messages = new BotConversationRepository(db.connection);
  const receipt = messages.accept(LOCAL_USER_ID, { botId: "scale-owner", requestId: "seed", text: "isolated scope fixture" });
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
  const bridge = (memory: MemoryService) => new BotConversationMemory({ db, userId: LOCAL_USER_ID, memory,
    pipeline: new MemoryPipelineManager(db), enabled: () => true, extract: async () => {}, changed: () => {} });
  const routes = [{ path: "lexical", adapter: bridge(lexical), query: "QZVXNEEDLE" }, { path: "semantic", adapter: bridge(semantic), query: "ZZYXYX" }];
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
      samples.push({ path: route.path, durationMs, eventLoopDelayMs: Math.max(loop.max / 1e6, firstTickMs), rssBytes: process.memoryUsage().rss, returned: hits.length });
    }
  }
  assert.equal(embeddings, 6, "all five semantic requests plus warmup actually embedded and searched");
  const failures = samples.filter(sample => sample.durationMs > BUDGET.queryMs || sample.eventLoopDelayMs > BUDGET.eventLoopDelayMs);
  const rssGrowth = Math.max(0, process.resourceUsage().maxRSS * 1024 - baselineRss);
  const report = { fixture: counts, dimension: SEMANTIC_DIMENSION, embeddingComputation: "controlled; 10000 real stored vectors", budget: BUDGET,
    samples, vectorPlan, baselineRss, rssGrowth, failedSamples: failures.length, rssPassed: rssGrowth <= BUDGET.rssGrowthBytes };
  writeFileSync("out/tests/memory-semantic-scale.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  assert.equal(failures.length, 0, "10K long-text multi-scope foreground recall must meet latency and event-loop budgets");
  assert(rssGrowth <= BUDGET.rssGrowthBytes, "10K query RSS growth must stay inside its stated budget");
} finally {
  loop.disable(); SemanticRuntime.prototype.embed = originalEmbed; db.close(); rmSync(root, { recursive: true, force: true });
}
