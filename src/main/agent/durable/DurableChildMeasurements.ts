import type { Context } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Cursor, EntryRecord, Harness, Storage, TaskId } from "@earendil-works/pi-durable";
import type { SubagentUsage } from "../../../shared/subagent-model-config";
import type { ConversationUsageReceipt } from "../../../shared/task-diagnostics";
import { DurableSubagentIdentity } from "./DurableSubagentIdentity";

export function addChildResponse(usage: SubagentUsage, message: AssistantMessage): void {
  usage.input += message.usage.input;
  usage.output += message.usage.output;
  usage.cacheRead += message.usage.cacheRead;
  usage.cacheWrite += message.usage.cacheWrite;
  usage.cost += message.usage.cost.total;
  usage.contextTokens = message.usage.totalTokens;
  usage.turns++;
}

/** Recover compact display data for receipts written without it. Read only the nested
 * tool owned by this exact foreground call and the children it actually created. */
export async function recoverChildMeasurements(entry: EntryRecord, storage: Storage, harness: Harness, ctx: Context,
  observed?: (id: string) => ConversationUsageReceipt): Promise<EntryRecord> {
  const message = entry.model?.find(m => m.role === "toolResult" && m.toolName === "pstack_delegate");
  if (message?.role !== "toolResult" || !entry.byTaskId) return entry;
  const details = message.details as { participants?: Array<{ subagentId: string; usage?: SubagentUsage }> } | undefined;
  let receipt;
  try { receipt = JSON.parse(message.content.filter(p => p.type === "text").map(p => p.text).join("")); } catch { return entry; }
  if (!receipt || !Number.isSafeInteger(receipt.toolTaskId)) return entry;
  const ids = new Set<string>(Array.isArray(receipt.children) ? receipt.children.filter((id: unknown) => typeof id === "string") : []);
  for (const failure of Array.isArray(receipt.failures) ? receipt.failures : []) if (typeof failure?.child === "string") ids.add(failure.child);
  const participants = new Map((details?.participants ?? []).map(p => [p.subagentId, p]));
  if (![...ids].some(id => !participants.get(id)?.usage)) return entry;
  const nested = await storage.task(receipt.toolTaskId, ctx);
  const call = nested?.input;
  if (nested?.owner !== entry.byTaskId || nested.conversationId !== entry.conversationId || nested.kind !== "pi.tool"
    || !call || typeof call !== "object" || Array.isArray(call) || call.kind !== "nested" || call.parentCallId !== message.toolCallId
    || !call.call || typeof call.call !== "object" || Array.isArray(call.call) || call.call.name !== "subagent") return entry;
  const children = await storage.scanConversations({ ownerTaskId: nested.id }, 250, undefined, ctx);
  for (const child of children.items) {
    const identity = (await harness.snapshot(DurableSubagentIdentity, child.id, ctx))?.value;
    if (!identity || identity.parentConversationId !== entry.conversationId || !ids.has(identity.item.id) || participants.get(identity.item.id)?.usage) continue;
    const usage: SubagentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
    let cursor: Cursor | undefined, lastGeneration: TaskId | undefined;
    do {
      const page = await storage.scanEntries({ conversationId: child.id, order: "ascending" }, 128, cursor, ctx);
      for (const record of page.items) for (const m of record.model ?? []) if (m.role === "assistant" && record.byTaskId) {
        addChildResponse(usage, m);
        lastGeneration = record.byTaskId;
      }
      cursor = page.next;
    } while (cursor);
    const reported = observed?.(String(child.id));
    if (reported?.requests && reported.requests === usage.turns) usage.reported = reported;
    const end = lastGeneration && (await storage.task(lastGeneration, ctx))?.endedAt;
    const failure = Array.isArray(receipt.failures) && receipt.failures.find((f: { child?: string }) => f?.child === identity.item.id);
    const recovered = { subagentId: identity.item.id, nativeConversationId: child.id, displayName: identity.item.displayName,
      agent: identity.item.agentName, workspace: { cwd: identity.workspace.cwd }, resolvedModel: identity.item.selection.model,
      status: failure ? failure.status : "completed", exitCode: failure ? 1 : 0, ...participants.get(identity.item.id), usage,
      ...(end !== undefined && end >= identity.startedAt && { durationMs: end - identity.startedAt }) };
    participants.set(identity.item.id, recovered);
  }
  if (!participants.size) return entry;
  const measured = copyJson({ ...details, participants: [...participants.values()] }, { omitUndefinedProperties: true });
  return { ...entry, model: entry.model!.map(m => m === message ? { ...m, details: measured } : m) };
}
