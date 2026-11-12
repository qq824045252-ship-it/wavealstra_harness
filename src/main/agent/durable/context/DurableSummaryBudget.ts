/** Output ceilings come from the resolved model, never the foreground soft trigger. */
export function summaryModelLimits(model: unknown, fallbackWindow: number) {
  const metadata = model as { contextWindow?: number; maxTokens?: number; reasoning?: boolean } | undefined;
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const window = Math.floor(positive(metadata?.contextWindow) ? Math.min(metadata.contextWindow, fallbackWindow) : fallbackWindow);
  // Missing output metadata is explicit conservative fallback, not unlimited capacity.
  const output = Math.floor(positive(metadata?.maxTokens) ? metadata.maxTokens : Math.min(4096, window / 4));
  const safety = Math.max(256, Math.min(1024, Math.ceil(window * 0.01)));
  return { window, output, safety, reasoning: metadata?.reasoning === true };
}

export function summaryOutputBudget(model: unknown, fallbackWindow: number, inputTokens: number) {
  const limits = summaryModelLimits(model, fallbackWindow);
  const ceiling = Math.floor(Math.min(limits.output, limits.window - inputTokens - limits.safety));
  if (ceiling < 128) throw new Error("当前模型窗口不足以生成有效摘要（已计入输入与输出预留）");
  // Proportional summary body plus reasoning room; retries can use the remaining declared output ceiling.
  const desired = Math.ceil(inputTokens / 3) + (limits.reasoning ? 4096 : 512);
  return { initial: Math.min(ceiling, Math.max(512, desired)), ceiling, ...limits };
}

export function nextSummaryOutputBudget(current: number, ceiling: number): number {
  return Math.min(ceiling, current * 2);
}
