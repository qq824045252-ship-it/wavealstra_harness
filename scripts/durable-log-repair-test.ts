/**
 * Durable JSONL 修复 + 单写者租约的回归测试。
 *
 * 真实事故形态（已从用户 ~/.mybuddy/durable 的两个目录取证）：
 * 第二个 MyBuddy 实例与第一个实例同时恢复同一个 Bot 会话，两个写入者各自从自己的
 * commit seq 继续提交，于是 main.jsonl 出现重复 seq；JsonlStorage.recover() 要求严格递增，
 * 整个目录从此打不开 → Bot 会话在界面上永远是空白。
 *
 * 本测试构造同样的交错日志，断言：
 *  1. 修复前 openNodeJsonlStorage 抛 JsonlCorruptionError；
 *  2. repairDurableJsonlLog 保留全部有效提交、丢弃重复提交，并整份备份原文件；
 *  3. 修复后存储可以打开，且已提交的条目仍然可读，重复修复是 no-op；
 *  4. 另一个进程持有租约时拒绝打开；持有者退出后可接管（不会被死锁挡死）。
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { commitWrites } from "@earendil-works/pi-durable/testing";
import type { ConversationId, DocumentId } from "@earendil-works/pi-durable";
import { repairDurableJsonlLog } from "../src/main/agent/durable/DurableLogRepair";
import { claimDurableStorageLease, DurableStorageOwnedError } from "../src/main/agent/durable/DurableStorageLease";
import { openDurableStorage, isJsonlCorruption } from "../src/main/agent/durable/DurableStorage";

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-repair-"));
console.log("Isolated test directory:", root);
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 用真实库写一段合法日志，然后模拟第二个写入者交错追加重复 seq 的提交。 */
async function buildCorruptedLog(directory: string): Promise<{ mainLines: number; duplicates: number[] }> {
  const storage = await openNodeJsonlStorage(directory, ctx, { fsync: false });
  const conversationId = 1 as ConversationId, documentId = 2 as DocumentId;
  await commitWrites(storage, [
    { type: "conversation", value: { id: conversationId } },
    { type: "document.create", record: { id: documentId, kind: "fixture.doc", scope: { kind: "conversation", conversationId }, history: "latest", fork: "initial" }, content: { kind: "base", version: 1, value: { turn: {} } } },
  ], ctx);
  await commitWrites(storage, [{ type: "document.change", id: documentId, content: { version: 1, kind: "delta", ops: [["s", ["turn", "first"], 1]] } }], ctx);
  await storage.close(ctx);

  const mainPath = join(directory, "main.jsonl");
  const lines = readFileSync(mainPath, "utf8").split("\n").filter(Boolean);
  const lastSeq = JSON.parse(lines[lines.length - 1]).seq as number;
  // 第二个写入者从相同的起点继续提交：seq 复用 → 严格递增被破坏（与真实事故同型）。
  const duplicates = [lastSeq - 1, lastSeq];
  appendFileSync(mainPath, duplicates.map(seq => `${JSON.stringify({ format: 1, type: "commit", seq, writes: [{ type: "document.change", id: 2, ordinal: 0 }] })}\n`).join(""));
  return { mainLines: lines.length + duplicates.length, duplicates };
}

// 1. 先证明这个日志确实打不开（复现事故）
const corrupt = join(root, "corrupt");
mkdirSync(corrupt, { recursive: true });
const built = await buildCorruptedLog(corrupt);
let failure: unknown;
try {
  await openNodeJsonlStorage(corrupt, ctx, { fsync: false });
} catch (error) {
  failure = error;
}
assert(failure !== undefined, "corrupted log must not open");
assert(isJsonlCorruption(failure), `expected JsonlCorruptionError, got ${String(failure)}`);
console.log("reproduced:", (failure as Error).message);

// 2. 修复：保留有效提交、备份原文件
const before = readFileSync(join(corrupt, "main.jsonl"), "utf8");
const report = repairDurableJsonlLog(corrupt);
assert(report !== undefined, "repair must report work");
assert.equal(report!.droppedMainCommits, built.duplicates.length);
assert.equal(report!.keptMainCommits, built.mainLines - built.duplicates.length);
assert(existsSync(report!.backupDirectory), "backup directory must exist");
assert.equal(readFileSync(join(report!.backupDirectory, "main.jsonl"), "utf8"), before, "backup must be a byte-identical copy");
console.log("repair:", JSON.stringify({ ...report!, directory: "<dir>", backupDirectory: "<backup>" }));

// 3. 修复后可打开，且历史条目仍在
const storage = await openNodeJsonlStorage(corrupt, ctx, { fsync: false });
const conversations = await storage.scanConversations({}, 10, undefined, ctx);
assert.equal(conversations.items.length, 1);
const document = await storage.findDocument({ kind: "fixture.doc", scope: { kind: "conversation", conversationId: conversations.items[0].id } }, "current", ctx);
assert(document, "the committed document address survives repair");
assert.deepEqual((await storage.document(document.id, "current", ctx))?.value, { turn: { first: 1 } }, "repair preserves the base and its committed delta");
const sequences = readFileSync(join(corrupt, "main.jsonl"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line).seq);
assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "commit seq must be strictly increasing after repair");
assert(repairDurableJsonlLog(corrupt) === undefined, "second repair must be a no-op");
await storage.close(ctx);
console.log("repaired log opens; commits:", sequences.length);

// 4. Production migration fails closed on conflicting commits; repair helpers remain explicit diagnostics.
// Dropping duplicate seq may discard different committed content or receipts, so it cannot safely resume tasks.
const autoHealed = join(root, "migration-corruption-refused");
mkdirSync(autoHealed, { recursive: true });
await buildCorruptedLog(autoHealed);
const originalBytes = new Map(readdirSync(autoHealed).filter(name => name.endsWith(".jsonl"))
  .map(name => [name, readFileSync(join(autoHealed, name))]));
await assert.rejects(openDurableStorage(autoHealed, ctx), error => isJsonlCorruption(error));
for (const [name, bytes] of originalBytes) assert.deepEqual(readFileSync(join(autoHealed, name)), bytes);
assert(!existsSync(join(autoHealed, ".mybuddy-storage.json")), "corrupt migration must stay unpublished");
assert(!existsSync(join(autoHealed, ".mybuddy-owner.json")), "failed opener must release its lease");
console.log("production migration refuses ambiguous corruption and preserves all originals");

// 5. 租约：另一个活进程持有 → 拒绝；进程退出 → 接管
const leased = join(root, "leased");
mkdirSync(leased, { recursive: true });
const owner = await openDurableStorage(leased, ctx);
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
await wait(600);
writeFileSync(join(leased, ".mybuddy-owner.json"), JSON.stringify({ format: 1, pid: child.pid, token: "foreign-writer", startedAt: Date.now(), updatedAt: Date.now() }));
await owner.storage.close(ctx);
owner.lease.release();
let owned: unknown;
try {
  claimDurableStorageLease(leased);
} catch (error) {
  owned = error;
}
assert(owned instanceof DurableStorageOwnedError, `expected DurableStorageOwnedError, got ${String(owned)}`);
console.log("concurrent owner refused:", (owned as Error).message);
child.kill();
await new Promise<void>(resolve => child.once("exit", () => resolve()));
await wait(400);
const takenOver = claimDurableStorageLease(leased);
assert.equal(takenOver.owner.pid, process.pid);
takenOver.release();
console.log("stale lease taken over after owner exit");

// 6. 心跳与备份清理
const heartbeatDir = join(root, "heartbeat");
mkdirSync(heartbeatDir, { recursive: true });
const lease = claimDurableStorageLease(heartbeatDir);
lease.heartbeat();
lease.release();
rmSync(join(root, "unused"), { recursive: true, force: true });

console.log("\ndurable log repair + lease test: all assertions passed");
console.log("files under test root:", readdirSync(root).join(", "));
