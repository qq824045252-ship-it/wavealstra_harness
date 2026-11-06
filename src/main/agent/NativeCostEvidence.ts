import type { ReportedTokenUsage } from "../../shared/task-diagnostics";

export type NativeCostSource = "provider-reported" | "pi-native" | "sdk-default";

/** Pi owns pricing. These observations only distinguish an amount from an SDK initializer. */
export function nativeCostEvidence(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | null | undefined,
  reported?: ReportedTokenUsage, providerCost?: number | null) {
  const total = usage?.cost?.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { total: null, source: null, complete: false };
  const source: NativeCostSource = providerCost === total ? "provider-reported"
    : total > 0 || [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].some(value => typeof value === "number" && value > 0)
      || (reported?.input != null && reported.output != null) ? "pi-native" : "sdk-default";
  return { total, source, complete: source !== "sdk-default" };
}
