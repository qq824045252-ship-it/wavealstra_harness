import type { ConversationId, TaskId, Tx } from "@earendil-works/pi-durable";
import type { WorkSubitemResult } from "../../../shared/bot-work-phase3";
import { DurableSubagentIdentity, DURABLE_SUBAGENT_TIER_LIMIT_RETRIES } from "./DurableSubagentIdentity";

export type DurableWorkReadTx = Pick<Tx, "scanEntries"> & Partial<Pick<Tx, "scanConversations" | "submissionByRequest" | "doc" | "task">>;
const CHILD_LIMIT = 250;

/** A missing parent result is not evidence that its child never started. Read
 * only conversations owned by that exact tool task, then their existing identity
 * and exact submission receipts. No child transcript scan or execution occurs. */
export async function recoverMissingSubitems(tx: DurableWorkReadTx, parentConversationId: ConversationId,
  toolTaskId: TaskId | undefined, toolCallId: string, items: WorkSubitemResult[]): Promise<WorkSubitemResult[]> {
  const missing = items.filter(item => item.nativeStatus === "not_started" && item.outcome === "not_started");
  if (!missing.length) return items;
  const unresolved = (item: WorkSubitemResult, nativeStatus = "missing_child_result"): WorkSubitemResult => ({ ...item,
    nativeStatus, outcome: "unknown", summary: "父工具未保留此子项的终态结果；不能据此判定未启动或安全重跑。先核对子会话/回执与已发生效果。" });
  if (!toolTaskId || !tx.scanConversations || !tx.submissionByRequest || !tx.doc || !tx.task)
    return items.map(item => missing.includes(item) ? unresolved(item) : item);
  const owner = await tx.task(toolTaskId);
  const input = owner?.input;
  if (!owner || owner.conversationId !== parentConversationId || owner.kind !== "pi.tool" || !input || typeof input !== "object"
    || Array.isArray(input) || input.kind !== "model" || input.callId !== toolCallId)
    return items.map(item => missing.includes(item) ? unresolved(item) : item);
  const children = await tx.scanConversations({ ownerTaskId: toolTaskId }, CHILD_LIMIT);
  const candidates = new Map<string, Array<{ id: ConversationId; childId: string; cwd: string }>>();
  let identitiesComplete = true;
  for (const child of children.items) {
    // Subagent conversations and their identity are created atomically by runChild.
    const identity = (await tx.doc(DurableSubagentIdentity, child.id)).value;
    if (!identity || identity.parentConversationId !== parentConversationId) { identitiesComplete = false; continue; }
    const item = missing.find(item => item.itemId === `${toolCallId}:${identity.item.id}`);
    if (!item) continue;
    candidates.set(item.itemId, [...candidates.get(item.itemId) ?? [],
      { id: child.id, childId: identity.item.id, cwd: identity.workspace.cwd }]);
  }
  const recovered = new Map<string, WorkSubitemResult>();
  for (const item of missing) {
    const matches = candidates.get(item.itemId) ?? [];
    if (!matches.length) {
      // A complete ownership lookup proves no child conversation was created.
      recovered.set(item.itemId, children.next || !identitiesComplete ? unresolved(item, "child_lookup_incomplete") : item);
      continue;
    }
    if (matches.length !== 1) { recovered.set(item.itemId, unresolved(item, "ambiguous_child_identity")); continue; }
    const child = matches[0]!;
    let receipt = await tx.submissionByRequest(child.id, `subagent:${child.childId}`);
    for (let attempt = 1; attempt <= DURABLE_SUBAGENT_TIER_LIMIT_RETRIES; attempt++) {
      const retry = await tx.submissionByRequest(child.id, `subagent:${child.childId}:retry:${attempt}`);
      if (retry) receipt = retry;
    }
    const stopped = receipt?.type === "input" && receipt.status === "unanswered" && receipt.reason === "aborted";
    recovered.set(item.itemId, { ...unresolved(item), childId: child.childId, childConversationId: String(child.id), workspaceBinding: child.cwd,
      nativeStatus: receipt?.type === "input" ? `child_${receipt.status}${receipt.status === "unanswered" ? `:${receipt.reason}` : ""}` : "child_receipt_missing",
      outcome: stopped ? "stopped" : "unknown",
      summary: stopped ? "原子会话回执确认已停止；此前可能已发生部分效果，不等于未启动或允许从头重跑。"
        : "原子会话已创建，但父工具缺少完整子项结算；先核对原回执/实际效果，不能当作未启动而重放。" });
  }
  return items.map(item => recovered.get(item.itemId) ?? item);
}
