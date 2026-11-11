import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { assertSelectedBotToolExecuted, selectedBotToolEvidence, selectedBotTool, selectedExternalAgentTool } from "../src/main/agent/work/BotSelectedTools";
import type { ExternalAgentRuntime } from "../src/main/external-agent/ExternalAgentRuntime";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

assert.equal(selectedBotTool({ consultRequested: true }), "multi_model_consult");
assert.equal(selectedBotTool({ externalAgentId: "codex" }), "delegate_selected_agent");
assert.equal(selectedBotTool({}), undefined);
assert.throws(() => selectedBotTool({ consultRequested: true, externalAgentId: "codex" }));
assert.throws(() => assertSelectedBotToolExecuted("multi_model_consult", []), /未成功/);
assert.throws(() => assertSelectedBotToolExecuted("delegate_selected_agent", [{ tools: [{ tool: "web_search", status: "success" }] }]), /未成功/);
assert.throws(() => assertSelectedBotToolExecuted("delegate_selected_agent", [{ tools: [{ tool: "delegate_selected_agent", status: "error" }] }]), /未成功/);
assertSelectedBotToolExecuted("delegate_selected_agent", [{ tools: [{ tool: "delegate_selected_agent", status: "success" }] }]);
assertSelectedBotToolExecuted(undefined, []);
// The request boundary and successful call precede the last 200 presentation entries.
// Page boundaries can split assistant calls from their tool results; compaction is not a new request.
type EvidenceEntry = Parameters<ReturnType<typeof selectedBotToolEvidence>["observe"]>[0];
const userEntry = (id: string): EvidenceEntry => ({ kind: "mybuddy.user", data: { mybuddyInput: { botRequestId: id } }, model: [] });
const callEntry = (id: string): EvidenceEntry => ({ kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id, name: "multi_model_consult", arguments: {} }] }] } as unknown as EvidenceEntry);
const resultEntry = (id: string, isError = false): EvidenceEntry => ({ kind: "pi.toolResult", model: [{ role: "toolResult", toolName: "multi_model_consult", toolCallId: id, isError, content: [], timestamp: 0 }] } as unknown as EvidenceEntry);
const filler: EvidenceEntry = { kind: "pi.compaction", model: [], data: {} };
async function checkPages(entries: EvidenceEntry[]) {
  const evidence = selectedBotToolEvidence("current", "multi_model_consult");
  let pages = 0;
  // Model the same ascending persisted entry pagination used by BotConversationService.
  for (let cursor = 0; cursor < entries.length; cursor += 200) {
    const page = await Promise.resolve(entries.slice(cursor, cursor + 200));
    pages++;
    for (const entry of page) evidence.observe(entry);
  }
  evidence.assert();
  return pages;
}
assert.equal(await checkPages([userEntry("previous"), callEntry("old"), resultEntry("old"), userEntry("current"),
  ...Array(195).fill(filler), callEntry("new"), resultEntry("new"), ...Array(450).fill(filler)]), 4);
await assert.rejects(checkPages([userEntry("previous"), callEntry("old"), resultEntry("old"), userEntry("current"), ...Array(650).fill(filler)]), /未成功/);
await assert.rejects(checkPages([userEntry("previous"), callEntry("old"), userEntry("current"), resultEntry("old"), ...Array(650).fill(filler)]), /未成功/);
await assert.rejects(checkPages([userEntry("current"), callEntry("failed"), resultEntry("failed", true), ...Array(650).fill(filler)]), /未成功/);
console.log("PASS selected execution evidence: 651 persisted entries / 4 pages, split call/result, compaction, prior-request and orphan-result exclusion");
const hostRequest = { text: "Analyze these exact figures\n<!-- mybuddy:reference-context -->Reference facts must not be dropped<!-- /mybuddy:reference-context -->", attachments: [{ name: "evidence.csv", path: "/fixture/evidence.csv" }] };
let enabled = true, available = true, launches = 0, cancellations = 0, creations = 0;
let status = "completed";
let run: any;
const runtime = {
  listAgents: () => [{ id: "codex", name: "Codex", enabled, available }],
  history: () => ({ runs: run ? [{ ...run, status }] : [], messages: run ? [{ id: run.assistantMessageId, text: "Actual ACP result" }] : [] }),
  prompt: (input: any) => { launches++; assert.equal(input.agentId, "codex"); assert.equal(input.text, hostRequest.text); assert.equal(input.displayText, "Analyze these exact figures"); assert.deepEqual(input.attachments, hostRequest.attachments); run = { ...input, runId: "run-1", status }; return { runId: run.runId, queued: true }; },
  cancel: async (id: string) => { assert.equal(id, "run-1"); cancellations++; status = "cancelled"; return { ok: true, message: "cancelled" }; },
} as unknown as ExternalAgentRuntime;
const tool = selectedExternalAgentTool({ hostRequest, requestIdentity: "request-1", agentId: "codex", runtime, createTask: () => { creations++; } });
assert.equal(tool.replay, "unsafe");
const api = { conversationId: "conversation-1", taskId: 3, output: () => {} } as unknown as ToolExecutionApi;
const invoke = (signal?: AbortSignal) => tool.execute({ task: "Model paraphrase omitting all figures, reference facts and attachments" }, api, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
const result = await invoke();
assert.match(JSON.stringify(result), /Actual ACP result/);
assert.equal(launches, 1); assert.equal(creations, 1);
await invoke(); assert.equal(launches, 1, "same native identity must reuse actual run");
await tool.execute({ task: "Model paraphrase omitting all figures, reference facts and attachments" }, { ...api, taskId: 4 } as ToolExecutionApi, BACKGROUND_CONTEXT);
assert.equal(launches, 1, "a repeated tool call in the same foreground request reuses its actual ACP run");
enabled = false;
await assert.rejects(invoke(), /停用/);
assert.throws(() => selectedExternalAgentTool({ hostRequest, requestIdentity: "request-1", agentId: "codex", runtime, createTask() {} }), /停用/);
enabled = true; available = false;
assert.throws(() => selectedExternalAgentTool({ hostRequest, requestIdentity: "request-1", agentId: "codex", runtime, createTask() {} }), /不可用/);
available = true;
assert.throws(() => selectedExternalAgentTool({ hostRequest, requestIdentity: "request-1", agentId: "unknown", runtime, createTask() {} }), /不可用/);
const preAborted = new AbortController(); preAborted.abort();
await assert.rejects(invoke(preAborted.signal)); assert.equal(launches, 1);
status = "working";
const abort = new AbortController();
const pending = invoke(abort.signal);
setTimeout(() => abort.abort(), 5);
await assert.rejects(pending);
assert.equal(cancellations, 1); assert.equal(launches, 1);
await assert.rejects(invoke(), /cancelled/); assert.equal(launches, 1);
status = "failed";
await assert.rejects(invoke(), /failed/); assert.equal(launches, 1);
console.log("PASS Bot selected execution: bound ACP choice, real result, no duplicate replay, unavailable/disabled, pre-cancel, active cancellation, failure, consult selection conflict");
