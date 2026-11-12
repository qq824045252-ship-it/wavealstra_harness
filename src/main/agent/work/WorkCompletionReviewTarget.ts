import type { WorkExecutionBindingDto } from "../../../shared/bot-work";

/** Project only this binding's persisted execution input. Preserve provenance
 * and the full original request; a delegation plan is not new user authority. */
export function completionReviewInput(binding: WorkExecutionBindingDto, source: Record<string, unknown>) {
  if (source.workId !== binding.workId || source.intentRevision !== binding.intentRevision || source.inputSnapshotId !== binding.inputSnapshotId)
    throw Error("Completion review input does not match its execution binding");
  const { teamAssignment: _teamAssignment, instructions: _instructions, ...originalRequest } = source;
  const definition = (value: Record<string, unknown>): Partial<Record<"title" | "description" | "constraints" | "criteria", unknown>> => Object.fromEntries(
    ["title", "description", "constraints", "criteria"].filter(key => value[key] !== undefined).map(key => [key, value[key]]));
  const plan = source.delegationPlan as Record<string, unknown> | undefined;
  return { originalRequest, reviewTarget: {
    kind: "single_work_delegation" as const,
    provenance: "host_persisted_execution_input_not_new_user_authorization" as const,
    workId: binding.workId, bindingId: binding.bindingId, intentRevision: binding.intentRevision,
    inputSnapshotId: binding.inputSnapshotId, ownerEpoch: binding.ownerEpoch,
    definition: definition(source),
    ...(plan ? { delegationPlan: { provenance: "assistant_generated", ...definition(plan) } } : {}),
    delegatedScope: binding.delegatedScope,
  } };
}
