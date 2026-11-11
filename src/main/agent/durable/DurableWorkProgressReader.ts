import type { EntryRecord, SubmissionRecord, Tx, LiveState } from "@earendil-works/pi-durable";
import type { GeneratedArtifact, WorkSubitemResult } from "../../../shared/bot-work-phase3";
import type { WorkExecutionObservation } from "../work/WorkExecutionAdapter";
import { durableRegisteredArtifact } from "./DurableArtifactRegistration";
import { readDurableWorkExecution, readNativeSubitems } from "./DurableWorkExecutionProjection";

type State = { after?: number; ended?: boolean; liveVersions: Map<string, string>; pending?: {
  after?: number; ended: boolean; items: WorkSubitemResult[]; artifacts: GeneratedArtifact[];
  observation?: WorkExecutionObservation; liveVersions: Map<string, string>;
} };
const PAGE_SIZE = 200, ITEM_LIMIT = 40;
const terminal = new Set(["completed", "failed", "rejected", "blocked", "stopped"]);

/** An expendable read cursor, not another execution record. Progress is advanced
 * ONLY after the Work inbox has durably accepted the returned observation.
 * Restart/eviction replays immutable entries into the existing idempotent inbox.
 * A poll reads one page and emits at most 40 child results, including after a cold
 * restart. The final accounting still reads the complete bounded input once. */
export class DurableWorkProgressReader {
  private readonly states = new Map<string, State>();
  private key(record: SubmissionRecord, workspace?: string, store?: string): string {
    return JSON.stringify([store, workspace, record.conversationId, record.id, record.type === "input" ? record.entry : null]);
  }
  clear(): void { this.states.clear(); }

  async read(tx: Pick<Tx, "scanEntries">, record: SubmissionRecord, workspace?: string, store?: string, live?: LiveState): Promise<WorkExecutionObservation> {
    const key = this.key(record, workspace, store);
    if (record.type !== "input" || !["queued", "placed"].includes(record.status)) {
      this.states.delete(key);
      return readDurableWorkExecution(tx, record, workspace, store);
    }
    let state = this.states.get(key);
    if (!state) {
      // Memory stays bounded by active readers, not conversation length. Evicting
      // only costs a replay; it never removes persisted milestones.
      if (this.states.size >= 128) this.states.delete(this.states.keys().next().value!);
      state = { liveVersions: new Map() }; this.states.set(key, state);
    }
    if (state.pending?.observation) return state.pending.observation;
    if (!state.pending) {
      const items = new Map<string, WorkSubitemResult>(), artifacts: GeneratedArtifact[] = [];
      let after = state.after, ended = state.ended ?? false;
      if (!ended && record.entry !== undefined) {
        const page = await tx.scanEntries({ conversationId: record.conversationId,
          minEntryId: (after === undefined ? record.entry : after + 1) as EntryRecord["id"], order: "ascending" }, PAGE_SIZE);
        for (const entry of page.items) {
          if (entry.id !== record.entry && entry.model?.some(message => message.role === "user")) { ended = true; break; }
          after = entry.id;
          const file = durableRegisteredArtifact(entry, record.id, workspace, store);
          if (file) artifacts.push({ path: file.path, digest: file.digest, sizeBytes: file.sizeBytes,
            registeredAt: file.registeredAt, sourceEntryId: entry.id, ...(file.snapshotPath ? { snapshotPath: file.snapshotPath } : {}) });
          // Tool result details already persist both the plan and results. Reading
          // them directly avoids reconstructing every previous chat/tool row.
          for (const message of entry.model ?? []) if (message.role === "toolResult" && message.details !== undefined) {
            const detail = JSON.stringify(message.details);
            if (!detail.includes('"plan"') && !detail.includes('"results"')) continue;
            for (const item of readNativeSubitems(message.toolCallId, detail)) {
              if (terminal.has(item.outcome)) items.set(item.itemId, item);
            }
          }
        }
      }
      // api.details() commits completed child evidence to LiveDoc before the
      // parent tool result exists. Scope it to this exact placed submission.
      const liveVersions = new Map<string, string>();
      if (!ended && record.status === "placed" && live?.run?.inputs.includes(record.id)) {
        for (const slot of live.tools ?? []) if (slot.details !== undefined) {
          for (const item of readNativeSubitems(slot.callId, JSON.stringify(slot.details))) {
            // A tier-limited child may still be retried by this same parent tool.
            // Only completed children are stable before the tool settles; final
            // failures arrive through its durable toolResult, never frozen early.
            if (item.outcome !== "completed") continue;
            const version = JSON.stringify(item);
            if (state.liveVersions.get(item.itemId) === version) continue;
            liveVersions.set(item.itemId, version); items.set(item.itemId, item);
          }
        }
      }
      state.pending = { after, ended, items: [...items.values()], artifacts, liveVersions };
    }
    const pending = state.pending;
    pending.observation = { status: "running",
      ...(pending.items.length ? { subitems: pending.items.slice(0, ITEM_LIMIT) } : {}),
      ...(pending.artifacts.length ? { generatedArtifacts: pending.artifacts } : {}) };
    return pending.observation;
  }

  /** The exact returned object is acknowledged, so a stale consumer cannot skip
   * newer evidence. Failed ingestion leaves the same batch available for retry. */
  acknowledge(record: SubmissionRecord, observation: WorkExecutionObservation, workspace?: string, store?: string): void {
    const state = this.states.get(this.key(record, workspace, store));
    const pending = state?.pending;
    if (!state || !pending || pending.observation !== observation) return;
    for (const item of pending.items.splice(0, ITEM_LIMIT)) {
      const version = pending.liveVersions.get(item.itemId);
      if (version) state.liveVersions.set(item.itemId, version);
    }
    pending.artifacts = []; pending.observation = undefined;
    if (!pending.items.length) { state.after = pending.after; state.ended = pending.ended; state.pending = undefined; }
  }
}
