import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";

for (const backend of process.argv.includes("--sqlite-only") ? ["sqlite", "sqlite-after-close"] : ["jsonl", "sqlite", "sqlite-after-close"]) {
  const root = mkdtempSync(join(tmpdir(), "durable-close-retry-"));
  let runtime: DurableBotRuntime | undefined;
  let connection: DatabaseSync | undefined;
  const nativeDatabaseClose = DatabaseSync.prototype.close;
  try {
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
    let modelCalls = 0;
    models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "close", name: "close", reasoning: false, input: ["text"], contextWindow: 128000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: () => { modelCalls++; throw Error("closing must never run a model"); } });
    const directory = join(root, "native");
    const storage = backend !== "jsonl" ? await openNodeSqliteStorage(join(root, "native.db")) : await openNodeJsonlStorage(directory, ctx);
    runtime = await DurableBotRuntime.open({ directory, cwd: root, storage, models,
      model: { provider: "fixture", modelId: "close" }, toolMode: "native", instructions: () => "close fixture", onSnapshot: () => {} });
    let stopped = 0, attempts = 0, released = 0;
    runtime.harness.subscribeClose(() => { stopped++; });
    const failure = new Error("fixture storage close temporarily unavailable");
    if (backend === "jsonl") {
      const closeMemory = MemoryStorage.prototype.close;
      mock.method(MemoryStorage.prototype, "close", async function(this: MemoryStorage,
        ...args: Parameters<MemoryStorage["close"]>) {
        attempts++;
        if (attempts === 1) throw failure;
        await closeMemory.apply(this, args); released++;
      });
    } else {
      mock.method(DatabaseSync.prototype, "close", function(this: DatabaseSync) {
        connection = this; attempts++;
        if (attempts === 1 && backend !== "sqlite-after-close") throw failure;
        nativeDatabaseClose.call(this); released++;
        if (attempts === 1) throw failure;
      });
    }
    const first = runtime.close(), sameFirst = runtime.close();
    assert.strictEqual(first, sameFirst, "concurrent runtime close shares the actual failure");
    await assert.rejects(first, error => error === failure);
    assert.equal(attempts, 1); assert.equal(released, backend === "sqlite-after-close" ? 1 : 0);
    assert.equal(stopped, 1, "execution admission is sealed before resource release");
    assert.equal((await runtime.harness.closed).kind, "failed");
    await assert.rejects(runtime.harness.commit(async () => undefined, ctx), /closed|SessionFailed/);
    await assert.rejects(runtime.submit("must not run", "after-close"), /closing|closed/);
    if (backend === "jsonl") assert.equal(existsSync(join(directory, ".mybuddy-owner.json")), false, "explicit storage fixture does not claim a product lease");
    else assert.equal(connection?.isOpen, backend !== "sqlite-after-close", "native SQLite handle reflects whether the injected failure preceded or followed actual release");
    const retry = runtime.close(), sameRetry = runtime.close();
    assert.strictEqual(retry, sameRetry);
    const outcome = await Promise.allSettled([retry, sameRetry]);
    assert.equal(attempts, backend === "sqlite-after-close" ? 1 : 2, `${backend}: retry reaches unfinished resource release and never recloses a released native handle`);
    assert.deepEqual(outcome.map(item => item.status), ["fulfilled", "fulfilled"]);
    assert.equal(released, 1, "one real resource release, with no duplicate concurrent close");
    assert.equal(stopped, 1, "resource retry does not restart execution shutdown");
    assert.equal((await runtime.harness.closed).kind, "failed", "resource release does not rewrite the original Session failure");
    await assert.rejects(runtime.harness.commit(async () => undefined, ctx), /closed|SessionFailed/);
    assert.equal(modelCalls, 0);
    if (backend === "jsonl") assert.equal(existsSync(join(directory, ".mybuddy-owner.json")), false, "explicit storage fixture leaves no product lease");
    else assert.equal(connection?.isOpen, false, "native SQLite handle is actually closed");
    await runtime.close(); assert.equal(attempts, backend === "sqlite-after-close" ? 1 : 2, "successful close is idempotent");
    console.log(`PASS #35 real ${backend} Session → Storage → resource close retry, concurrent callers, admission seal and actual release`);
  } finally {
    mock.restoreAll();
    await runtime?.close().catch(() => {});
    // Cleanup after assertions, including the failing-before native-handle fixture.
    if (connection?.isOpen) nativeDatabaseClose.call(connection);
    rmSync(root, { recursive: true, force: true });
  }
}
