/**
 * Runtime thinking-level projection.
 *
 * Critical invariant: absence of a level map means "unknown/not declared", not
 * "off/minimal/low/medium/high". Model capability UI must prefer Pi runtime
 * reasoning_options and this helper only consumes explicit transport maps.
 */

export const PI_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_LEVEL_SET = new Set<string>(PI_THINKING_LEVELS);

function keysFromMap(
  map: Record<string, string | null | undefined> | undefined,
): string[] {
  if (!map || typeof map !== "object") return [];
  const explicit = Object.entries(map)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key]) => key.trim())
    .filter(Boolean);

  const standard = PI_THINKING_LEVELS.filter((level) => explicit.includes(level));
  const extra = explicit.filter((level) => !PI_LEVEL_SET.has(level));
  return [...standard, ...extra];
}

/**
 * List explicit runtime transport levels.
 * - reasoning=false: explicit maps are still honored for compatibility.
 * - reasoning=true: no map means no declared adjustable levels.
 * - null means unsupported; missing means unknown and is NOT synthesized.
 */
export function resolveThinkingLevels(model: {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null | undefined>;
  compat?: { reasoningEffortMap?: Record<string, string | null | undefined> };
}): string[] {
  const fromMap = keysFromMap(model.thinkingLevelMap);
  if (fromMap.length > 0) return fromMap;

  const fromEffort = keysFromMap(model.compat?.reasoningEffortMap);
  if (fromEffort.length > 0) return fromEffort;

  return [];
}

/** Clamp only inside the declared set; never synthesize an unsupported level. */
export function clampThinkingLevel(current: string | undefined, levels: string[]): string {
  if (levels.length === 0) return "off";
  if (current && levels.includes(current)) return current;
  const idx = current ? (PI_THINKING_LEVELS as readonly string[]).indexOf(current) : -1;
  if (idx >= 0) {
    for (let i = idx; i < PI_THINKING_LEVELS.length; i++) {
      const candidate = PI_THINKING_LEVELS[i]!;
      if (levels.includes(candidate)) return candidate;
    }
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = PI_THINKING_LEVELS[i]!;
      if (levels.includes(candidate)) return candidate;
    }
  }
  if (!current) return levels.includes("off") ? "off" : (levels[0] ?? "off");
  return levels.find((level) => level !== "off") ?? levels[0] ?? "off";
}

/**
 * Pick a default from the declared set only.
 * This helper is a UI preference resolver, not a capability inference layer.
 */
export function defaultOnThinkingLevel(levels: string[], preferred?: string): string {
  const intensity = levels.filter((level) => level !== "off");
  if (intensity.length === 0) return levels.includes("off") ? "off" : (levels[0] ?? "off");
  if (preferred && preferred !== "off" && levels.includes(preferred)) return preferred;
  if (levels.includes("medium")) return "medium";
  const idx = preferred ? (PI_THINKING_LEVELS as readonly string[]).indexOf(preferred) : -1;
  if (idx >= 0) {
    for (let i = idx; i < PI_THINKING_LEVELS.length; i++) {
      const candidate = PI_THINKING_LEVELS[i]!;
      if (intensity.includes(candidate)) return candidate;
    }
    for (let i = idx - 1; i >= 0; i--) {
      const candidate = PI_THINKING_LEVELS[i]!;
      if (intensity.includes(candidate)) return candidate;
    }
  }
  return intensity[0] ?? "off";
}
