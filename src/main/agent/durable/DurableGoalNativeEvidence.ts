import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import { defineDocFamily, GenerationTask, type ConversationId, type Cursor, type Storage, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { GoalActivityIdentity, GoalNativeEvidence } from "../../../shared/conversation-goal-activity";
import { openDurablePassiveStorage } from "./DurableStorage";

type Record = { toolTaskId: number; evidence: GoalNativeEvidence };
type History = { events: Record[] };
const history = defineDocFamily({
  kind: "mybuddy.pstack-goal-evidence", family: true, scope: "session", version: 1,
  checkpointWhen: () => true, initial: (_seed: null): History => ({ events: [] }),
});
const key = (id: GoalActivityIdentity) => JSON.stringify([id.conversationId, id.generationTaskId]);

/** Save the fact in the same native commit as the board transition. The task owner chain
 * ties it to the generation that actually made the transition, including a nested worker failure.
 */
export async function recordGoalNativeEvidence(tx: Tx, api: { taskId: TaskId },
  evidence: GoalNativeEvidence | readonly GoalNativeEvidence[], toolTaskId = Number(api.taskId)): Promise<void> {
  let id: TaskId | undefined = api.taskId;
  while (id !== undefined) {
    const task = await tx.task(id);
    if (!task) return;
    if (task.kind === GenerationTask.definition.name) {
      const doc = await tx.doc(history, key({ conversationId: String(task.conversationId), generationTaskId: id }), null);
      for (const item of Array.isArray(evidence) ? evidence : [evidence]) {
        const row = copyJson({ toolTaskId, evidence: item }, { omitUndefinedProperties: true }) as Record;
        const identity = JSON.stringify(row);
        if (!doc.events.some(event => JSON.stringify(event) === identity)) doc.events.push(row);
      }
      return;
    }
    id = task.owner;
  }
}

/** Read the exact native generation's facts in the caller's existing snapshot when supplied. */
export async function readGoalNativeEvidence(directory: string, runs: readonly GoalActivityIdentity[], snapshot?: Storage) {
  if (!runs.length) return [];
  const storage = snapshot ?? await openDurablePassiveStorage(directory, ctx);
  if (!storage) return [];
  try {
    const scope = { kind: "session" } as const;
    const output: Array<Record & GoalActivityIdentity> = [];
    for (const run of runs) {
      const found = await storage.findDocument({ kind: history.definition.kind, scope, key: key(run) }, "current", ctx);
      if (!found) continue;
      const value = (await storage.document(found.id, "current", ctx))?.value as History | undefined;
      for (const row of value?.events ?? []) output.push({
        conversationId: run.conversationId, generationTaskId: run.generationTaskId, ...row,
      });
    }
    // Older Goal evidence used to keep only path and digest. Recover a saved
    // version only from the original registration of that exact native tool.
    const legacy = output.filter(row => row.evidence.kind === "delivery" && row.evidence.path && row.evidence.digest && !row.evidence.saved);
    if (legacy.length) {
      const { durableArtifactRegistrationSchema, durableRegisteredArtifact, DURABLE_ARTIFACT_ENTRY_KIND } = await import("./DurableArtifactRegistration");
      const roots = new Set<ConversationId>();
      const wanted = new Map<string, typeof legacy>();
      for (const row of legacy) {
        let id = Number(row.conversationId) as ConversationId;
        const seen = new Set<ConversationId>();
        while (!seen.has(id)) {
          seen.add(id);
          const conversation = await storage.conversation(id, ctx);
          if (!conversation) break;
          if (!conversation.owner) { roots.add(id); break; }
          id = conversation.owner.conversationId;
        }
        const version = row.evidence;
        if (version.kind !== "delivery") continue;
        const identity = JSON.stringify([row.toolTaskId, version.path, version.digest]);
        const matches = wanted.get(identity) ?? [];
        matches.push(row);
        wanted.set(identity, matches);
      }
      for (const root of roots) {
        let cursor: Cursor | undefined;
        do {
          const page = await storage.scanEntries({ conversationId: root, order: "ascending" }, 128, cursor, ctx);
          for (const entry of page.items) {
            if (entry.kind !== DURABLE_ARTIFACT_ENTRY_KIND) continue;
            const parsed = durableArtifactRegistrationSchema.safeParse(entry.data);
            if (!parsed.success || parsed.data.toolCallId.includes("#web-bundle:")) continue;
            const data = parsed.data;
            const identity = JSON.stringify([data.toolTaskId, data.path, data.digest]);
            const matches = wanted.get(identity);
            if (!matches || !durableRegisteredArtifact(entry, data.inputIds[0]!, undefined, directory)) continue;
            for (const row of matches) {
              if (row.evidence.kind === "delivery") row.evidence = { ...row.evidence, saved: {
                snapshotPath: data.snapshotPath, manifestPath: data.previewManifestPath, registeredAt: data.registeredAt,
              } };
            }
            wanted.delete(identity);
          }
          cursor = page.next;
        } while (cursor && wanted.size);
      }
    }
    return output;
  } finally { if (!snapshot) await storage.close(ctx); }
}
