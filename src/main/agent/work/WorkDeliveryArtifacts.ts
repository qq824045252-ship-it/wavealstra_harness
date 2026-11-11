import { z } from "zod";
import type { WorkDeliverableDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkFeedbackDto } from "../../../shared/bot-conversation";
import type { WorkService } from "./WorkService";

type DeliveryFile = NonNullable<NonNullable<WorkFeedbackDto["report"]>["files"]>[number];
const teamSources = z.object({ teamAssignment: z.object({ role: z.literal("owner_summary"),
  previousResults: z.array(z.object({ botId: z.string(), bindingId: z.string().optional(), deliverableId: z.string().optional() })) }) });

/** The owner can deliver only its own results and the exact member results frozen
 * into this execution. Never scan the workspace or adopt another Work's files. */
export function workDeliveryResults(works: WorkService, binding: WorkExecutionBindingDto): WorkDeliverableDto[] {
  const all = works.repo.listDeliverables(binding.workId);
  const selected = new Map<string, WorkDeliverableDto>();
  const visited = new Set<string>();
  const collect = (current: WorkExecutionBindingDto) => {
    if (visited.has(current.bindingId)) return;
    visited.add(current.bindingId);
    const source = works.partialResults.deliverySource(current);
    if (source) collect(source);
    const context = teamSources.safeParse(works.repo.reportContext(current));
    const sources = context.success ? context.data.teamAssignment.previousResults : [];
    for (const result of all) {
      if (result.status === "superseded" || result.status === "rejected"
        || result.workId !== binding.workId || result.intentRevision !== binding.intentRevision
        || result.inputSnapshotId !== binding.inputSnapshotId || result.ownerEpoch !== binding.ownerEpoch) continue;
      if (result.executionId === current.bindingId && result.producerBotId === current.botId) {
        selected.set(result.deliverableId, result); continue;
      }
      if (!sources.some(source => source.deliverableId === result.deliverableId
        && source.bindingId === result.executionId && source.botId === result.producerBotId)) continue;
      const member = works.repo.getBinding(result.executionId);
      if (member && member.workId === binding.workId && member.botId === result.producerBotId
        && member.intentRevision === binding.intentRevision && member.inputSnapshotId === binding.inputSnapshotId
        && member.ownerEpoch === binding.ownerEpoch) selected.set(result.deliverableId, result);
    }
  };
  collect(binding);
  return [...selected.values()];
}

/** Only host-registered, explicitly delivered refs gain open actions. Preserve
 * raw refs without inventing a path. For one exact output path in this proven lineage, deliver its newest
 * referenced registered version; older immutable versions remain in Work detail. */
export function workDeliveryFiles(works: WorkService, results: WorkDeliverableDto[]): DeliveryFile[] {
  if (!results.length) return [];
  const generated = works.generatedArtifacts.list(results[0].workId, true);
  const bindings = new Map(works.repo.listBindings(results[0].workId).map(binding => [binding.bindingId, binding]));
  const referenced = generated.filter(artifact => results.some(result => result.executionId === artifact.bindingId
    && result.artifactRefs.some(ref => ref === artifact.snapshotPath || ref === artifact.path)));
  const files = new Map<string, { file: DeliveryFile; version: number[] }>();
  const later = (a: number[], b: number[]) => a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] > b[2]);
  for (const result of results) for (const ref of result.artifactRefs) {
    const candidates = generated.filter(item => item.bindingId === result.executionId);
    // A raw source path can have several saved versions in this execution. The
    // latest registration is authoritative; a basename match never suffices.
    const artifact = candidates.find(item => item.snapshotPath === ref)
      ?? candidates.filter(item => item.path === ref).sort((a,b) => b.sourceEntryId - a.sourceEntryId || b.registeredAt - a.registeredAt)[0]
      // A continuation can explicitly return a prior immutable snapshot without
      // registering it again, but only if a proven source result delivered it.
      ?? referenced.find(item => item.snapshotPath === ref);
    const binding = bindings.get(artifact?.bindingId ?? result.executionId);
    const key = artifact ? artifact.path : JSON.stringify([result.executionId, ref]);
    const file: DeliveryFile = artifact
      ? { ref: artifact.snapshotPath ?? artifact.path, name: artifact.path.split(/[\\/]/).pop() || artifact.path,
          openPath: artifact.snapshotPath ?? artifact.path }
      : { ref, name: ref.split(/[\\/]/).pop() || ref };
    const version = [artifact?.registeredAt ?? result.createdAt, binding?.admittedAt ?? result.createdAt, artifact?.sourceEntryId ?? 0];
    const previous = files.get(key);
    if (!previous || later(version, previous.version)) files.set(key, { file, version });
  }
  const unique = new Map<string, DeliveryFile>();
  for (const {file} of files.values()) if (!unique.has(file.ref) || file.openPath) unique.set(file.ref, file);
  return [...unique.values()];
}
