import assert from "node:assert/strict";
import { appendFile, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, JsonObject, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { createPstackWorkflow } from "../src/main/agent/pstack/PstackWorkflow";
import { PstackTrailReceipts } from "../src/main/agent/pstack/PstackDecisionTrail";
import { appendTrailBytes, digest, trailTarget } from "../src/main/agent/pstack/PstackDecisionFile";
import { normalizePstackSettings, pstackDecisionLogPath } from "../src/shared/pstack";
import { chooseDecisionReviewers } from "../src/main/agent/pstack/PstackContestModels";
import { prepareFileEffect, readEffectIntent, verifyFileEffect } from "../src/main/agent/durable/DurableEffectRecovery";

const model: Model<"openai-completions"> = { api: "openai-completions", provider: "fixture", id: "local", name: "Local",
  baseUrl: "http://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const root = await mkdtemp(join(tmpdir(), "mybuddy-trail-"));
const cwd = join(root, "workspace"), path = ".audit/notes.tsv";
const settings = normalizePstackSettings({ skills: { "show-me-your-work": { parameters: { logPath: path } } } });
const judgmentPool = ["team/gpt-reviewer", "team/deepseek-reviewer"];
const judgeScope = { available: judgmentPool, pools: {strong:judgmentPool} };
assert.deepEqual(chooseDecisionReviewers(settings, judgeScope, ["source/gpt-author"]), ["team/deepseek-reviewer"]);
assert.throws(() => chooseDecisionReviewers(settings, judgeScope, ["source/gpt-author","source/deepseek-writer"]), /No reviewer was dispatched/);
const expectedHeader = "ts\tphase\tdecision\twhy\tevidence\tresult";
const decide = (decision: string, phase = "test") => ({ action: "decision", decision: {
  phase, decision, why: "line\none\twith\rcontrols", evidence: "spec.txt:1", result: "@formula",
} });

async function openHost(taskId: string) {
  const queue: JsonObject[] = [];
  let call = 0, blockWrites = false;
  const models = { getModel: () => model, getAuth: async () => undefined, streamSimple() {
    const stream = createAssistantMessageEventStream();
    const args = queue.shift();
    const answer: AssistantMessage = { role: "assistant", provider: model.provider, api: model.api, model: model.id,
      stopReason: args ? "toolUse" : "stop", timestamp: Date.now(), content: args ?
        [{ type: "toolCall", name: "pstack_workflow", id: "decision-" + (++call), arguments: args }] : [{ type: "text", text: "Holding." }],
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    queueMicrotask(() => { stream.push({ type: "done", reason: args ? "toolUse" : "stop", message: answer }); stream.end(); });
    return stream;
  } } as unknown as DurableBotOptions["models"];
  const host = createPstackWorkflow({ taskId, cwd, settings: () => settings, active: () => true });
  const instance = await DurableBotRuntime.open({ directory: join(root, taskId), cwd, models, model: { provider: "fixture", modelId: "local" },
    toolMode: "native", instructions: () => "test", tools: host.tools, foregroundHooks: { ...host,
      beforeTool: async (request, api, context) => request.name === "pstack_decision_append" && blockWrites ?
        { block: "workspace is read-only" } : host.beforeTool(request, api, context),
    }, onSnapshot() {} });
  return { instance, deny: (block: boolean) => { blockWrites = block; },
    turn: async (id: string, ...steps: JsonObject[]) => {
      queue.push(...steps, { action: "block", note: "pause fixture" });
      const outcome = await (await instance.submit("code development", id)).wait(ctx);
      await instance.conversation.waitForIdle(ctx);
      assert.equal(queue.length, 0, JSON.stringify(outcome));
    },
    rows: async () => (await instance.harness.snapshot(PstackTrailReceipts, instance.conversation.id, ctx))?.rows ?? [],
    results: async () => {
      const { items } = await instance.harness.commit(tx => tx.scanEntries({ conversationId: instance.conversation.id, order: "ascending" }, 200), ctx);
      return items.flatMap(item => (item.model ?? []).flatMap(m => m.role === "toolResult" ? m.content.flatMap(c => c.type === "text" ? [c.text] : []) : []));
    },
  };
}

try {
  await mkdir(cwd);
  await writeFile(join(cwd, "spec.txt"), "expected behavior\n");
  const bytes = () => readFile(join(cwd, path), "utf8");
  const start = { action: "start", skill: "show-me-your-work" }, resume = { action: "resume" };
  let a = await openHost("A"), b = await openHost("B");
  try {
    await a.turn("A-1", start, decide("=first"), decide("=first"), { action: "decision-audit" });
    const firstRows = await a.rows();
    assert.equal(firstRows.length, 1, JSON.stringify(await a.results()));
    const [heading, first, end] = (await bytes()).split("\n");
    assert.equal(heading, expectedHeader);
    assert.equal(end, "");
    const [stamp, ...cells] = first.split("\t");
    assert.equal(new Date(stamp).toISOString(), stamp);
    assert.deepEqual(cells, ["test", "'=first", "line one with controls", "spec.txt:1", "'@formula"]);
    assert.equal(firstRows[0].row, first);
    assert(firstRows[0].toolTaskId > 0);
    assert((await a.results()).some(r => r.includes('"fingerprint"')));

    await b.turn("B-1", start, decide("second"));
    assert.equal((await b.rows()).length, 2, JSON.stringify(await b.results()));
    await a.instance.close();
    a = await openHost("A");
    await a.turn("A-2", resume, decide("third"));
    const lines = (await bytes()).trimEnd().split("\n");
    assert.equal(lines[1], first);
    assert.deepEqual(lines.slice(1).map(line => line.split("\t")[1]), ["test", "start", "test", "start", "test"]);
    assert(lines[2].includes(stamp) && lines[2].includes("mybuddy:B/") && lines[4].includes("mybuddy:A/"));
    assert.deepEqual((await a.rows()).map(r => r.line), [2, 5, 6], "reopened session kept its own spans");
    await appendFile(join(cwd, path), stamp + "\ttest\tmanual entry\twhy\tspec.txt:1\topen\n");
    await a.turn("A-audit-unrecorded", resume, { action: "decision-audit" });
    const audit = (await a.results()).filter(text => text.includes('"provenance": "unconfirmed"')).at(-1);
    assert(audit?.includes("manual entry") && !audit.includes("\\tsecond\\t"), "audit must surface unsupported rows in owned stretches only");
    await Promise.all([a.turn("A-par", resume, decide("parallel A")), b.turn("B-par", resume, decide("parallel B"))]);
    const parallel = await bytes();
    assert.equal(parallel.split("\tparallel A\t").length, 2);
    assert.equal(parallel.split("\tparallel B\t").length, 2);
    assert.equal(parallel.split(expectedHeader).length, 2);
    b.deny(true);
    await b.turn("B-denied", resume, decide("must not appear"));
    assert.equal(await bytes(), parallel);
    assert((await b.results()).some(result => result.includes("workspace is read-only")));
    await writeFile(join(cwd, path), parallel.replace("'=first", "renamed"));
    await a.turn("A-tamper", resume, { action: "decision-audit" });
    assert((await a.results()).some(result => result.includes("differs at decision log line 2")));
    console.log("PASS native workflow, keyed internal write and readback, TSV escaping, cross-session ownership, concurrency, reopen, denial and audit of tampered rows");
  } finally { await a.instance.close(); await b.instance.close(); }

  const legacy = "\uFEFF" + expectedHeader + "\r\n" + Array.from({ length: 3500 }, (_, i) =>
    `2026-01-01T00:00:00Z\told\t旧决定${i}\t原有原因\ttrace/${i}\topen`).join("\r\n");
  await writeFile(join(cwd, path), legacy);
  const c = await openHost("C");
  try {
    await c.turn("C-1", start, decide("continued large file"));
    assert.deepEqual((await c.rows()).map(r => r.line), [3502, 3503], JSON.stringify(await c.results()));
    assert((await bytes()).startsWith(legacy + "\r\n"), "BOM, original CRLF and unterminated final row must be preserved");
  } finally { await c.instance.close(); }

  const text = expectedHeader + "\n2026-01-01T00:00:00Z\tverify\tchecked\twhy\tspec.txt:1\tok\n";
  const intent = { task: "A", run: 1, path: "replay.tsv", decisionKey: "operation-1", beforeHash: digest(""), beforeBytes: 0, existed: false,
    expectedSha256: digest(text), expectedBytes: Buffer.byteLength(text), append: text, rows: [], line: 2 };
  await appendTrailBytes(cwd, intent, () => {});
  await appendTrailBytes(cwd, intent, () => {});
  assert.equal(await readFile(join(cwd, "replay.tsv"), "utf8"), text, "replaying after fsync must not append again");
  const earlier = expectedHeader + "\n";
  const added = text.slice(earlier.length);
  const later = "2026-01-01T01:00:00Z\tverify\tother decision\twhy\tspec.txt:1\tok\n";
  const appended = { ...intent, path: "shared.tsv", beforeHash: digest(earlier), beforeBytes: Buffer.byteLength(earlier), append: added, existed: true };
  await writeFile(join(cwd, appended.path), earlier);
  const appendCall = { type: "toolCall", name: "pstack_decision_append", id: "append-verify", arguments: {
    path: appended.path, content: appended.append, expectedSha256: appended.expectedSha256, expectedBytes: appended.expectedBytes,
  } } as const;
  const effect = await prepareFileEffect(appendCall, cwd);
  assert(effect?.kind === "file");
  await appendTrailBytes(cwd, appended, () => {});
  assert.equal((await verifyFileEffect(effect)).status, "passed");
  await appendFile(join(cwd, appended.path), later);
  await appendTrailBytes(cwd, appended, () => {});
  assert.equal(await readFile(join(cwd, appended.path), "utf8"), text + later);
  assert.equal((await verifyFileEffect(effect)).status, "passed", "a later row must not invalidate the original append");
  const resumed = readEffectIntent({ kind: "file", path: effect.path, canonicalPath: effect.canonicalPath,
    bytes: appended.expectedBytes, sha256: appended.expectedSha256 }, appendCall);
  assert(resumed.kind === "file");
  assert.equal((await verifyFileEffect(resumed)).status, "passed", "recover the append range from a pending call saved before the upgrade");
  await writeFile(join(cwd, appended.path), text.replace("checked", "changed") + later);
  assert.equal((await verifyFileEffect(effect)).status, "inconclusive", "the bytes at the append offset must match");
  await writeFile(join(cwd, appended.path), earlier + added.slice(0, -1));
  assert.equal((await verifyFileEffect(effect)).status, "inconclusive", "a short append must not be accepted");
  await writeFile(join(cwd, "partial.tsv"), text.slice(0, 21));
  await appendTrailBytes(cwd, { ...intent, path: "partial.tsv" }, () => {});
  assert.equal(await readFile(join(cwd, "partial.tsv"), "utf8"), text, "resume only the missing bytes after a short append");
  const foreign = join(root, "outside");
  await mkdir(foreign);
  await writeFile(join(foreign, "owned.tsv"), "outside");
  await symlink(foreign, join(cwd, "redirect"), "junction");
  await link(join(foreign, "owned.tsv"), join(cwd, "aliased.tsv"));
  for (const p of ["../outside/a.tsv", "C:/data.tsv", ".git/work.tsv", "result.md"]) assert.throws(() => pstackDecisionLogPath(p));
  for (const p of ["redirect/owned.tsv", "aliased.tsv"]) await assert.rejects(trailTarget(cwd, p));
  assert.equal(await readFile(join(foreign, "owned.tsv"), "utf8"), "outside");
  console.log("PASS replay at fsync boundary, relative TSV scope, hardlink and redirected parent protection");
} finally { await rm(root, { force: true, recursive: true }); }
