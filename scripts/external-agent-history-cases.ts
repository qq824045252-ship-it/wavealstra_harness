import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentService } from "../src/main/agent/AgentService";
import { DuckDbStorage, resolveStoreId } from "../src/main/agent/durable/DuckDbStorage";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { PASSIVE_READONLY_MODELS } from "../src/main/agent/durable/DurableReadOnlyHistory";
import { DurableTaskProjection } from "../src/main/agent/durable/DurableTaskProjection";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { ExternalAgentRuntime } from "../src/main/external-agent/ExternalAgentRuntime";

export async function verifyExternalAgentHistory(
  db: AppDatabase,
  agent: Pick<AgentService, "loadTaskHistory">,
  root: string,
): Promise<void> {
  const reader = db.runtimeAuditReader!;
  const taskId = "core-acp-mixed-history";
  const otherTaskId = "core-acp-unrelated-history";
  const cwd = join(root, "acp-history-workspace");
  const directory = join(root, "acp-history-store");
  mkdirSync(cwd);
  mkdirSync(directory);
  const at = Date.now();
  await db.writeTaskRecord({ id: taskId, title: "Mixed history", updatedAt: at, cwd });
  await db.writeTaskRecord({ id: otherTaskId, title: "Unrelated history", updatedAt: at, cwd });
  await new DurableTaskProjection(db.fixtureConnection, reader).bindBot(taskId, directory, cwd);
  const store = await DuckDbStorage.openWriter(reader, await resolveStoreId(reader, directory));
  try {
    const runtime = await DurableBotRuntime.open({
      directory, cwd, models: PASSIVE_READONLY_MODELS, storage: store, toolMode: "native", instructions: () => "", onSnapshot: () => {},
    });
    try {
      await runtime.conversation.commit(tx => tx.appendEntry(runtime.conversation.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "Original ordinary Pi question", timestamp: at - 1 }],
      }), BACKGROUND_CONTEXT);
    } finally {
      await runtime.close();
    }
  } finally {
    await store.close(BACKGROUND_CONTEXT);
  }

  const acp = new ExternalAgentRuntime(db, () => cwd);
  try {
    await acp.flush();
    const read = () => Promise.all([agent.loadTaskHistory(taskId, undefined, "current"), acp.readHistory(taskId)]);
    const [nativeOnly, noAcpRuns] = await read();
    assert.deepEqual(nativeOnly.messages.map(row => row.text), ["Original ordinary Pi question"]);
    assert.deepEqual(noAcpRuns, { messages: [], runs: [] });

    const insertRun = (id: string, owner: string) => reader.batch2Write<{ ok: boolean }>({
      kind: "externalAgentInsertRun", id, taskId: owner, agentId: "devin", agentName: "Devin", status: "completed", cwd,
      userMessageId: `acp-question-${id}`, assistantMessageId: `acp-answer-${id}`, startedAt: at,
      prompt: "Private model input", displayText: "Displayed ACP question", attachmentsJson: JSON.stringify([{ name: "example.txt" }]),
      continuedFromRunId: null, continuationMode: "new",
    });
    const runIds = Array.from({ length: 65 }, (_, index) => `run-${String(index).padStart(2, "0")}`);
    for (const id of [...runIds].reverse()) assert.deepEqual(await insertRun(id, taskId), { ok: true });
    assert.deepEqual(await insertRun("unrelated-run", otherTaskId), { ok: true });
    assert.deepEqual(await reader.batch2Write({
      kind: "externalAgentAppendText", id: runIds[0], column: "final_text", delta: "Committed ACP reply", outputCursor: 1,
    }), { ok: true });
    assert.deepEqual(await reader.batch2Write({
      kind: "externalAgentWriteTools", id: runIds[0], outputCursor: 2,
      toolsJson: JSON.stringify([
        { id: "done", tool: "read", summary: "Read file", output: "file body", status: "success" },
        { id: "pending", tool: "read", summary: "Pending permission", status: "pending_approval" },
      ]),
    }), { ok: true });

    const firstPage = await reader.externalAgentHistoryPage(taskId);
    assert(firstPage?.nextCursor, "the seeded ACP runs must cross a Core page boundary");
    const [ordinary, external] = await read();
    assert.deepEqual(ordinary.messages, nativeOnly.messages);
    assert.deepEqual(external.runs.map(run => run.runId), runIds, "stable run identity across a Core history page boundary");
    assert.equal(external.messages.length, 2 * runIds.length);
    assert.equal(external.messages[0]?.id, `acp-question-${runIds[0]}`);
    assert.equal(external.messages[0]?.text, "Displayed ACP question");
    assert.deepEqual(external.messages[0]?.attachments, [{ name: "example.txt" }]);
    const reply = external.messages[1]!;
    assert.equal(reply.id, `acp-answer-${runIds[0]}`);
    assert.equal(reply.text, "Committed ACP reply");
    assert.equal(reply.externalAgent?.runId, runIds[0]);
    assert.deepEqual(reply.tools?.map(tool => [tool.id, tool.output]), [["done", "file body"]]);
    assert.deepEqual((await acp.readHistory(otherTaskId)).runs.map(run => run.runId), ["unrelated-run"]);
    console.log("PASS ordinary Pi history and actual ACP rows read together from Core with ordered pagination and unchanged message IDs");
  } finally {
    acp.dispose();
    await acp.flush();
  }
}
