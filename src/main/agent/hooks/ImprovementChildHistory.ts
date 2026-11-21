import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId, ConversationRecord, Cursor, EntryId, Storage, TaskId } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { ChildHistoryEvidence, ImprovementChild } from "../../../shared/native-improvement";
import { storedSteerReceipt } from "../durable/DurableSteerReceipts";
import { DurableSubagentIdentity } from "../durable/DurableSubagentIdentity";
import { fingerprint, messageText } from "./ImprovementDecisions";

const outcome = z.enum(["completed", "failed", "cancelled", "timedout", "blocked"]);
const childDoc = z.object({
  value: z.object({
    taskId: z.string(), parentConversationId: z.number(), parentSubmissionIds: z.array(z.number()).optional(),
    startedAt: z.number(), item: z.object({ id: z.string(), agentName: z.string(), task: z.string(), role: z.record(z.string(),z.unknown()).optional(), selection: z.object({model: z.string()}) }),
  }),
  completion: z.object({submissionId: z.number(), status: outcome, durationMs: z.number(),
    stopRequest: z.enum(["child-panel","task-stop","model-scope-change","deadline"]).optional()}).optional(),
});
function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

async function resultOfDispatch(storage: Storage, parent: ConversationId, ownerTask: TaskId, id: string, child: ConversationId) {
  let task = await storage.task(ownerTask, ctx);
  let parentCallId: string | undefined;
  const nestedInput = fields(task?.input);
  while (task?.conversationId === parent && task.kind === "pi.tool") {
    const input = fields(task.input);
    const callId = input.kind === "nested" ? fields(input.call).id : input.callId;
    if (typeof callId === "string") parentCallId ??= callId;
    const result = task.state.status === "terminal" && fields(task.state.outcome.result);
    if (result && typeof result.entryId === "number") {
      const entry = (await storage.entry(result.entryId as EntryId,ctx))?.entry;
      if (entry?.conversationId !== parent || entry.byTaskId !== task.id) break;
      for (const m of entry.model ?? []) {
        if (m.role !== "toolResult" || m.toolCallId !== callId) continue;
        const details = fields(m.details);
        const rows = details.results ?? details.participants;
        const match = Array.isArray(rows) && rows.map(fields).find(r => r.subagentId === id && (r.nativeConversationId === undefined || r.nativeConversationId === child));
        if (match) return { parentCallId, parentReturnEntry: entry.id, status: match.status === "completed" && Array.isArray(match.writeConflicts) && match.writeConflicts.length
          ? "blocked" as const : outcome.safeParse(match.status).data,
          returnDiagnostic: typeof match.errorMessage === "string" ? match.errorMessage.slice(0,1000) :
            Array.isArray(match.writeConflicts) ? match.writeConflicts.filter(x => typeof x === "string").join("\n").slice(0,1000) : undefined,
          durationMs: typeof match.durationMs === "number" ? match.durationMs : undefined };
        if (m.toolName === "pstack_delegate" && nestedInput.kind === "nested" && nestedInput.parent === task.id
          && fields(nestedInput.call).name === "subagent" && nestedInput.parentCallId === callId) {
          let receipt: Record<string,unknown>;
          try { receipt = fields(JSON.parse(messageText(m.content))); } catch { continue; }
          if (receipt.toolTaskId !== ownerTask) continue;
          const failures = receipt.failures;
          const failed = Array.isArray(failures) && failures.map(fields).find(f => f.child === id);
          const status = failed ? outcome.safeParse(failed.status).data :
            !m.isError && Array.isArray(receipt.children) && receipt.children.includes(id) ? "completed" as const : undefined;
          if (status) return {parentCallId,parentReturnEntry:entry.id,status,
            returnDiagnostic: failed && typeof failed.error === "string" ? failed.error.slice(0,1000) : undefined};
        }
      }
    }
    task = task.owner ? await storage.task(task.owner,ctx) : undefined;
  }
  return { parentCallId };
}

/** An ownership edge plus a matching native identity excludes consult sessions and inherited transcripts. */
export async function readImprovementChild(storage: Storage, taskId: string, conversation: ConversationRecord, detail: boolean): Promise<ChildHistoryEvidence | undefined> {
  const owner = conversation.owner;
  if (!owner) return;
  const cid = conversation.id;
  const doc = await storage.findDocument({ kind: DurableSubagentIdentity.definition.kind, scope: { kind: "conversation", conversationId: cid } }, "current", ctx);
  const parsed = childDoc.safeParse(doc && (await storage.document(doc.id,"current",ctx))?.value);
  if (!parsed.success || parsed.data.value.taskId !== taskId || parsed.data.value.parentConversationId !== owner.conversationId) return;
  const { value, completion } = parsed.data;
  const {item} = value;
  const assigned = "subagent:" + item.id;
  const submissions: ChildHistoryEvidence["submissions"] = [];
  const steers: ChildHistoryEvidence["steers"] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanSubmissions({conversationId: cid},128,cursor,ctx);
    for (const row of page.items) {
      if (row.type !== "input") continue;
      if (row.requestId === assigned || row.requestId?.startsWith(assigned + ":retry:")) {
        submissions.push({id: row.id, requestId: row.requestId, status: row.status, entry: row.entry,
          ...(row.status === "done" && {answer: row.answer}), ...(row.status === "unanswered" && {reason: row.reason})});
      } else {
        const receipt = await storedSteerReceipt(storage,row);
        if (receipt) steers.push(receipt);
      }
    }
    cursor = page.next;
  } while (cursor);
  const returned = await resultOfDispatch(storage,owner.conversationId,owner.taskId,item.id,cid);
  const last = submissions.at(-1);
  const completed = completion && completion.submissionId === last?.id ? completion : undefined;
  const tools: ChildHistoryEvidence["tools"] = [];
  do {
    const page = await storage.scanTasks({conversationId: cid,kind:"pi.tool"},128,cursor,ctx);
    for (const t of page.items) {
      const input = fields(t.input), nested = input.kind === "nested";
      const callId = nested ? fields(input.call).id : input.callId;
      let name = nested ? fields(input.call).name : undefined;
      if (detail && !nested && typeof input.assistant === "number") {
        const assistant = (await storage.entry(input.assistant as EntryId,ctx))?.entry;
        if (assistant?.conversationId === cid) for (const m of assistant.model ?? []) {
          if (m.role === "assistant") name = m.content.filter(p => p.type === "toolCall").find(p => p.id === callId)?.name;
          if (name) break;
        }
      }
      const terminal = t.state.status === "terminal" ? t.state.outcome : undefined;
      const resultEntry = fields(terminal?.result).entryId;
      tools.push({task: t.id, nested, status: terminal?.status ?? t.state.status,
        ...(typeof name === "string" && {name}), ...(typeof callId === "string" && {callId}),
        ...(typeof resultEntry === "number" && {resultEntry})});
    }
    cursor = page.next;
  } while (cursor);
  const child: ImprovementChild = { taskId, conversation: cid, parent: owner.conversationId, ownerTask: owner.taskId,
    childId: item.id, role: item.agentName, model: item.selection.model, startedAt: value.startedAt,
    assignments: submissions.length, steers: steers.length, unansweredSteers: steers.filter(s => s.nativeStatus === "unanswered").length,
    tools: tools.length, toolFailures: tools.filter(t => ["failed","faulted","aborted","orphaned"].includes(t.status)).length,
    status: returned.status ?? completed?.status ?? "unknown", durationMs: returned.durationMs ?? completed?.durationMs,
    ...(completed?.stopRequest && {stopRequest: completed.stopRequest}) };
  let answer: ChildHistoryEvidence["answer"];
  const answerId = steers.reduce((latest, s) => Math.max(latest,s.answerEntryId ?? 0),last?.answer ?? 0);
  if (detail && answerId) {
    const e = (await storage.entry(answerId as EntryId,ctx))?.entry;
    const m = e?.conversationId === cid && e.model?.find(m => m.role === "assistant");
    if (m && m.role === "assistant") answer = {entry: answerId, text: messageText(m.content).slice(0,1500)};
  }
  return {child, assignment: item.task.slice(0,1500), roleFingerprint: item.role && fingerprint(item.role), parentSubmissions: value.parentSubmissionIds,
    parentCallId: returned.parentCallId, parentReturnEntry: returned.parentReturnEntry, returnDiagnostic:returned.returnDiagnostic,
    submissions, steers, tools, answer};
}
