/** Opt-in, evidence-backed scene recommendations. Never overrides an explicit task model. */
export interface TaskModelRecommendation {
  modelId: string;
  evidencePath: string;
}
export type TaskModelRecommendations = Partial<Record<"coding" | "working", TaskModelRecommendation>>;

export function evaluatedTaskModel(config: TaskModelRecommendations | undefined, mode: string | undefined): string | undefined {
  const entry = config?.[mode as keyof TaskModelRecommendations];
  return entry?.evidencePath.trim() ? entry.modelId : undefined;
}
