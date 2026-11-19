import type { Context } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Cursor } from "@earendil-works/pi-durable";
import { DurableSubagentIdentity } from "../durable/DurableSubagentIdentity";
import { WorkflowState, type Api } from "./PstackState";
import { isOwnerArtifactTool } from "./PstackDelivery";

type OwnerProbe = { owner: string; conversation: number; started: number; due: number; state: "awaiting-report" | "overdue" | "reported"; firstEvidence: string | null };
export type OwnerAuditTick = { at: number; owners: OwnerProbe[] };
type Probes = { first: OwnerAuditTick; latest: OwnerAuditTick; count: number };
const OwnerAudits = defineDoc({ kind: "mybuddy.pstack-owner-audits", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { run: number; dispatch: Record<string, Probes> } => ({ run: 0, dispatch: {} }) });

export async function recordedOwnerAudits(api: Api, ctx: Context, runId: number) {
  const row = await api.snapshot(OwnerAudits, api.conversationId, ctx);
  return row?.run === runId ? row.dispatch : {};
}

async function recordProbe(api: Api, ctx: Context, runId: number, tick: OwnerAuditTick) {
  await api.commit(async tx => {
    const active = await tx.doc(WorkflowState, api.conversationId);
    if (active.run?.run !== runId || active.run.phase !== "running") return;
    const row = await tx.doc(OwnerAudits, api.conversationId);
    if (row.run !== runId) { row.run = runId; row.dispatch = {}; }
    const key = String(api.taskId), prior = row.dispatch[key];
    if (!prior) row.dispatch[key] = { first: tick, latest: tick, count: 1 };
    else if (prior.latest.at < tick.at) { prior.latest = tick; prior.count++; }
  }, ctx);
}

async function readOwnerProgress(api: Api, ctx: Context, minutes: number, at: number): Promise<OwnerAuditTick> {
  // Match both native ownership edges: this tool -> the nested subagent tool -> its child conversations.
  // Another pstack dispatch in the same conversation can own an identically named role.
  const owners = await api.commit(async tx => {
    const matching: Array<{ conversation: ConversationId; owner: string; started: number }> = [];
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({ ownerConversationId: api.conversationId }, 100, cursor);
      for (const child of page.items) {
        if (!child.owner || (await tx.task(child.owner.taskId))?.owner !== api.taskId) continue;
        const identity = (await tx.doc(DurableSubagentIdentity, child.id)).value;
        if (identity) matching.push({ conversation: child.id, owner: identity.item.id, started: identity.startedAt });
      }
      cursor = page.next;
    } while (cursor);
    return matching;
  }, ctx);
  const results: OwnerProbe[] = [];
  for (const child of owners) {
    let cursor: Cursor | undefined, evidence: string | null = null;
    do {
      const page = await api.commit(tx => tx.scanEntries({ conversationId: child.conversation, order: "ascending" }, 100, cursor), ctx);
      for (const entry of page.items) {
        const observed = entry.model?.find(message =>
          (message.role === "toolResult" && !message.isError && isOwnerArtifactTool(message.toolName))
          || (message.role === "assistant" && message.stopReason === "stop" && message.content.some(part => part.type === "text" && part.text.trim())));
        if (observed) { evidence = (observed.role === "toolResult" ? observed.toolName : "returned-report") + "@" + entry.id; break; }
      }
      cursor = page.next;
    } while (cursor && !evidence);
    const due = child.started + minutes * 60_000;
    results.push({ ...child, due, firstEvidence: evidence, state: evidence ? "reported" : at >= due ? "overdue" : "awaiting-report" });
  }
  return { at, owners: results };
}

/** Wait for the real dispatch while inspecting in-flight owners at the first-report deadline and configured audit cadence. */
export async function monitorOwnerDispatch<T>(pending: Promise<T>, api: Api, ctx: Context, started: number, firstMinutes: number, auditMinutes: number,
  workflow?: { run: number; active: () => boolean; expectedOwners: number }) {
  const completion = pending.then(result => ({ result }));
  const auditInterval = auditMinutes * 60_000, firstDue = started + firstMinutes * 60_000;
  let nextDue = Math.min(firstDue, started + auditInterval), latest: OwnerAuditTick | null = null;
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), Math.min(2_147_483_647, Math.max(0, nextDue - api.now())));
      timer.unref();
    });
    const completed = await Promise.race([completion, timeout]).finally(() => clearTimeout(timer));
    if (completed) return { ...completed, latest };
    ctx.abortSignal?.throwIfAborted();
    if (workflow && !workflow.active()) return { result: await pending, latest };
    const now = api.now();
    if (now < nextDue) continue;
    try {
      latest = await readOwnerProgress(api, ctx, firstMinutes, now);
      if (workflow) await recordProbe(api, ctx, workflow.run, latest);
      api.output("Autopilot owner audit: " + JSON.stringify(latest) + "\n");
    } catch (error) {
      ctx.abortSignal?.throwIfAborted();
      api.diagnostic({ severity: "warn", message: "Autopilot owner progress could not be read: " + String(error) });
    }
    const nextTick = started + (Math.floor((now - started) / auditInterval) + 1) * auditInterval;
    const deadlines = (latest?.owners ?? []).filter(o => o.state === "awaiting-report" && o.due > now).map(o => o.due);
    if (workflow && (latest?.owners.length ?? 0) < workflow.expectedOwners) deadlines.push(now + firstMinutes * 60_000);
    nextDue = Math.min(nextTick, firstDue > now ? firstDue : Infinity, ...deadlines);
  }
}
