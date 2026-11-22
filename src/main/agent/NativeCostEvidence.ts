import type { ReportedTokenUsage } from "../../shared/task-diagnostics";

export type NativeCostSource = "provider-reported" | "pi-native" | "sdk-default";

export type NativeCostUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };

/**
 * Provider receipts take precedence over the SDK's catalog-based estimate.
 *
 * `pricingConfigured === false` means the catalog has no usable unit prices for this model (all four
 * prices are 0), so Pi's computed `total: 0` is a placeholder rather than a bill. Unless the provider
 * itself reported a cost, that 0 must stay "unknown" (`total: null`) instead of becoming a fake
 * `$0.000000` in diagnostics. Omitted (`undefined`) callers keep the previous semantics.
 */
export function nativeCostEvidence(usage: NativeCostUsage | null | undefined,
  reported?: ReportedTokenUsage, providerCost?: number | null, pricingConfigured?: boolean) {
  if (providerCost != null && Number.isFinite(providerCost) && providerCost >= 0) {
    return { total: providerCost, source: "provider-reported" as const, complete: true };
  }
  const total = usage?.cost?.total;
  if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return { total: null, source: null, complete: false };
  if (total === 0 && pricingConfigured === false) return { total: null, source: null, complete: false };
  const source: NativeCostSource = total > 0 || [usage?.input, usage?.output, usage?.cacheRead, usage?.cacheWrite].some(value => typeof value === "number" && value > 0)
      || (reported?.input != null && reported.output != null) ? "pi-native" : "sdk-default";
  return { total, source, complete: source !== "sdk-default" };
}
