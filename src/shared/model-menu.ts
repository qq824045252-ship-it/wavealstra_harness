import { reasoningEffortValues, type ModelMetadataDto, type ModelReasoningPreferenceDto } from "./model-metadata";
/** Max means highest declared native effort, never an invented context or token limit. */
export function maxReasoningPreference(metadata?: ModelMetadataDto): ModelReasoningPreferenceDto | undefined {
  const levels = reasoningEffortValues(metadata?.reasoningOptions ?? []);
  const effort = ["xhigh", "high", "medium", "low", "minimal"].find(level => levels.includes(level));
  return effort ? { effort } : undefined;
}
