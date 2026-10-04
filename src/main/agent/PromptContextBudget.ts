import type { AssemblySegmentDto } from "../../shared/mode-profile";

export interface PromptContextBudgetResult {
  segments: AssemblySegmentDto[];
  rawChars: number;
  usedChars: number;
  limitChars: number;
  truncatedSegmentIds: string[];
}

const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
const APPROX_CHARS_PER_TOKEN = 4;
const SYSTEM_CONTEXT_SHARE = 0.08;
const MIN_BUDGET_CHARS = 12_000;
const MAX_BUDGET_CHARS = 48_000;
const TRUNCATION_SUFFIX = "\n\n[Context budget: truncated; retrieve the full source with the relevant tool when needed.]";

interface SegmentBudgetPolicy {
  trimOrder: number;
  minChars: number;
}

const SEGMENT_POLICY: Record<string, SegmentBudgetPolicy> = {
  // Large/raw discovery material is cheapest to reacquire via tools.
  projectResources: { trimOrder: 0, minChars: 240 },
  library: { trimOrder: 1, minChars: 240 },
  projectPinnedRefs: { trimOrder: 2, minChars: 260 },
  shell: { trimOrder: 3, minChars: 260 },
  skillCatalog: { trimOrder: 4, minChars: 520 },

  // Useful task context, but still reconstructable.
  expert: { trimOrder: 5, minChars: 600 },
  projectPlan: { trimOrder: 6, minChars: 650 },
  projectSharedContext: { trimOrder: 7, minChars: 500 },
  project: { trimOrder: 8, minChars: 900 },

  // Explicit user/task choices and safety/runtime constraints are retained longest.
  libraryAttachments: { trimOrder: 9, minChars: 1_000 },
  modePreset: { trimOrder: 10, minChars: 700 },
  mode: { trimOrder: 11, minChars: 1_200 },
  soul: { trimOrder: 12, minChars: 700 },
  memoryRules: { trimOrder: 13, minChars: 520 },
  permission: { trimOrder: 14, minChars: 260 },
  workspace: { trimOrder: 15, minChars: 420 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Budget only the MyBuddy system-assembly capsule. Conversation history, tool
 * schemas and model output reserve are deliberately outside this budget.
 */
export function derivePromptContextCharBudget(contextWindowTokens?: number | null): number {
  const tokens = Number.isFinite(contextWindowTokens) && (contextWindowTokens ?? 0) > 0
    ? Number(contextWindowTokens)
    : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.floor(clamp(tokens * APPROX_CHARS_PER_TOKEN * SYSTEM_CONTEXT_SHARE, MIN_BUDGET_CHARS, MAX_BUDGET_CHARS));
}

function policyFor(segment: AssemblySegmentDto): SegmentBudgetPolicy {
  const explicit = SEGMENT_POLICY[segment.id];
  if (explicit) return explicit;
  if (segment.source === "user") return { trimOrder: 10, minChars: 700 };
  if (segment.source === "runtime") return { trimOrder: 12, minChars: 420 };
  if (segment.source === "project") return { trimOrder: 7, minChars: 500 };
  if (segment.source === "skill") return { trimOrder: 4, minChars: 420 };
  return { trimOrder: 5, minChars: 360 };
}

function clipSegment(segment: AssemblySegmentDto, targetChars: number): AssemblySegmentDto {
  if (segment.content.length <= targetChars) return segment;
  const safeTarget = Math.max(80, targetChars);
  const bodyChars = Math.max(0, safeTarget - TRUNCATION_SUFFIX.length);
  const content = `${segment.content.slice(0, bodyChars).trimEnd()}${TRUNCATION_SUFFIX}`;
  return { ...segment, chars: content.length, content };
}

/**
 * Deterministic priority-based budget. It never drops a segment entirely: when
 * the assembly is oversized, low-cost/retrievable sections are shortened first.
 */
export function applyPromptContextBudget(
  inputSegments: readonly AssemblySegmentDto[],
  requestedLimitChars?: number | null,
): PromptContextBudgetResult {
  const rawChars = inputSegments.reduce((sum, segment) => sum + segment.content.length, 0);
  const limitChars = Math.max(4_000, Math.floor(requestedLimitChars ?? derivePromptContextCharBudget()));
  if (rawChars <= limitChars) {
    return {
      segments: inputSegments.map((segment) => ({ ...segment, chars: segment.content.length })),
      rawChars,
      usedChars: rawChars,
      limitChars,
      truncatedSegmentIds: [],
    };
  }

  const segments = inputSegments.map((segment) => ({ ...segment, chars: segment.content.length }));
  const candidates = segments
    .map((segment, index) => ({ index, policy: policyFor(segment) }))
    .sort((a, b) => a.policy.trimOrder - b.policy.trimOrder || a.index - b.index);

  let usedChars = rawChars;
  const truncated = new Set<string>();
  for (const candidate of candidates) {
    if (usedChars <= limitChars) break;
    const current = segments[candidate.index]!;
    const minimum = Math.min(current.content.length, candidate.policy.minChars);
    const reducible = Math.max(0, current.content.length - minimum);
    if (!reducible) continue;
    const reduction = Math.min(reducible, usedChars - limitChars);
    const next = clipSegment(current, current.content.length - reduction);
    segments[candidate.index] = next;
    usedChars += next.content.length - current.content.length;
    if (next.content !== current.content) truncated.add(current.id);
  }

  // Pathological case: mandatory minima themselves exceed the budget. Continue
  // trimming in the same priority order, but keep a small identifiable capsule
  // for every segment instead of silently deleting policy/safety context.
  if (usedChars > limitChars) {
    for (const candidate of candidates) {
      if (usedChars <= limitChars) break;
      const current = segments[candidate.index]!;
      const floor = Math.min(current.content.length, 120);
      const reducible = Math.max(0, current.content.length - floor);
      if (!reducible) continue;
      const reduction = Math.min(reducible, usedChars - limitChars);
      const next = clipSegment(current, current.content.length - reduction);
      segments[candidate.index] = next;
      usedChars += next.content.length - current.content.length;
      if (next.content !== current.content) truncated.add(current.id);
    }
  }

  usedChars = segments.reduce((sum, segment) => sum + segment.content.length, 0);
  return {
    segments,
    rawChars,
    usedChars,
    limitChars,
    truncatedSegmentIds: [...truncated],
  };
}
