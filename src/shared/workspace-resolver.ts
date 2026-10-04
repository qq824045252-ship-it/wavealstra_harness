/**
 * Workspace Resolver Foundation — Phase 3 Deterministic Task→Space Resolver
 *
 * Goals (non-visual, non-LLM):
 * - Deterministic / testable pure functions, separated from UI
 * - Reuse existing SpaceDto/TaskDto, workspace-tree selectors, effectiveArchived semantics,
 *   moveTaskInWorkspaceTree contract, and current context hierarchy rules. No forked logic.
 * - Advisory by default: never silently reparent; actual attach must go through
 *   existing moveTaskInWorkspaceTree / bindTaskSpace + DB guards.
 * - Preserve hierarchy rule: sibling isolated, child inherits ancestors, child does not
 *   automatically promote upward; no cross-sibling injection.
 *
 * Exposes:
 * - resolveTaskSpace(input): ResolveResult  (primary advisory API)
 * - listCandidateSpaces(input): candidate ordering helper
 * - getSpaceAncestorsDeterministic(...)
 * - isSpaceValid(...)
 * - toAttachRequest(...) — builds a move request for caller to execute via store/DB
 *
 * All ordering is stable deterministic: sortOrder ASC → createdAt ASC → id ASC
 * (same as AppDatabase.getSpaceChildren / renumberSpaces). No hidden heuristics.
 */

import type { SpaceDto, TaskDto } from "./agent-ipc";
import { buildSpaceEffectiveMap } from "./workspace-tree";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ResolverReason =
  | "explicit" // task.spaceId explicitly bound and valid
  | "active-home" // homeSpaceId / active context valid
  | "draft" // draftSpaceId valid
  | "ancestor" // ancestor of the primary (inherits)
  | "fallback" // no strong context, but fallback available (e.g. null unbound)
  | "none"; // no candidate / no recommendation

export type ResolverConfidence = "high" | "medium" | "low" | "none";

export interface ResolverCandidate {
  /** null = standalone / unbound (the "Tasks" group) */
  spaceId: string | null;
  reason: ResolverReason;
  confidence: ResolverConfidence;
  /** 0 = primary, 1 = direct parent, 2 = grandparent, ... */
  depth: number;
  /** Stable tie-break fields for ordering (copied from SpaceDto) */
  sortOrder?: number;
  createdAt?: number;
  /** Human-readable trace for debugging / tests */
  trace?: string;
}

export interface ResolverInput {
  spaces: SpaceDto[];
  /** Existing tasks (optional, for looking up taskSpaceId when only taskId given) */
  tasks?: TaskDto[];
  /** Explicit binding of the task being resolved. undefined = not provided (new task). null = explicit unbound. */
  taskSpaceId?: string | null;
  /** Existing task id (for traceability; does not affect deterministic core unless tasks lookup needed) */
  taskId?: string;
  /** Active task id for implicit context gate. draft/home only allowed for new task (no taskId) or taskId===activeTaskId. */
  activeTaskId?: string | null;
  /** Current home/active space (renderer homeSpaceId / activeTask's space). Null = no active context. */
  homeSpaceId?: string | null;
  /** Draft creation context (new-task draft space). Takes precedence over home if valid. */
  draftSpaceId?: string | null;
  /** If true, include archived/effectiveArchived spaces in candidates. Default false. */
  includeArchived?: boolean;
}

export interface ResolverResult {
  /** Advisory selected space (null = recommend unbound). Null with reason none = no recommendation. */
  resolvedSpaceId: string | null;
  confidence: ResolverConfidence;
  reason: ResolverReason;
  /** Deterministic ordering, primary first then ancestors by proximity. Excludes siblings. */
  candidates: ResolverCandidate[];
  /** Always true: resolver is advisory, never mutates. Caller must use moveTaskInWorkspaceTree. */
  advisory: true;
  /** Whether an explicit binding was present and valid (explicit wins). */
  explicit: boolean;
  /** Diagnostic: effective map used (for tests). */
  _effectiveMapSize?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers (reuse shared effectiveArchived; no fork)
// ---------------------------------------------------------------------------

function isSpaceValid(
  spaceId: string | null | undefined,
  spaces: SpaceDto[],
  effectiveMap: Map<string, boolean>,
  includeArchived: boolean,
  byId: Map<string, SpaceDto>,
): boolean {
  if (spaceId == null) return false; // null = unbound, handled separately
  const s = byId.get(spaceId);
  if (!s) return false;
  if (!includeArchived && (effectiveMap.get(spaceId) ?? false)) return false;
  return true;
}

/**
 * Active context gate — single helper to avoid draft/home fork.
 * draftSpaceId / homeSpaceId are implicit active context, only usable for:
 *  - new task / draft with no concrete taskId (taskId == null/undefined/"")
 *  - the currently active task (taskId === activeTaskId)
 * When taskId exists and activeTaskId mismatches or is missing, leak must be blocked.
 * Explicit taskSpaceId / taskId lookup bypasses this gate.
 */
export function canUseImplicitContext(
  taskId: string | undefined,
  activeTaskId: string | null | undefined,
): boolean {
  if (taskId == null || taskId === "") return true;
  if (activeTaskId == null || activeTaskId === "") return false;
  return taskId === activeTaskId;
}

/** Ancestor chain for a valid space, filtered to exclude effectiveArchived (if !includeArchived). Stable order: direct parent first. Cycle/self-loop safe via originalId seeded seen. */
function getAncestorChain(
  spaceId: string,
  byId: Map<string, SpaceDto>,
  effectiveMap: Map<string, boolean>,
  includeArchived: boolean,
): string[] {
  const out: string[] = [];
  // Seed with originalId to prevent self-loop a→a and 2-cycle A→B→A re-including primary
  const seen = new Set<string>([spaceId]);
  let cursor: string | null = byId.get(spaceId)?.parentId ?? null;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const cur = byId.get(cursor);
    if (!cur) break; // missing parent break
    const eff = effectiveMap.get(cursor) ?? false;
    if (includeArchived || !eff) {
      out.push(cursor);
    }
    // Continue traversal even through archived nodes to reach higher ancestors,
    // but filtered output will have excluded them. If current node is
    // effectiveArchived, its ancestors are also effectiveArchived (since they
    // include the archiving ancestor), so further pushes will also be filtered.
    // We still walk for completeness / determinism.
    cursor = cur.parentId ?? null;
  }
  return out;
}

/** Stable deterministic compare for fallback ordering (sortOrder ASC, createdAt ASC, id ASC) */
function compareSpacesDeterministic(a: SpaceDto, b: SpaceDto): number {
  const ao = a.sortOrder ?? 0;
  const bo = b.sortOrder ?? 0;
  if (ao !== bo) return ao - bo;
  const ac = a.createdAt ?? 0;
  const bc = b.createdAt ?? 0;
  if (ac !== bc) return ac - bc;
  return a.id.localeCompare(b.id);
}

function candidatesFromPrimary(
  primaryId: string,
  reason: ResolverReason,
  confidence: ResolverConfidence,
  byId: Map<string, SpaceDto>,
  effectiveMap: Map<string, boolean>,
  includeArchived: boolean,
): ResolverCandidate[] {
  const chain = getAncestorChain(primaryId, byId, effectiveMap, includeArchived);
  const primary = byId.get(primaryId);
  const out: ResolverCandidate[] = [
    {
      spaceId: primaryId,
      reason,
      confidence,
      depth: 0,
      sortOrder: primary?.sortOrder,
      createdAt: primary?.createdAt,
      trace: `${reason}:primary`,
    },
  ];
  for (let i = 0; i < chain.length; i++) {
    const aid = chain[i]!;
    // Defensive: never duplicate primary (seeded seen already prevents, but double-check for determinism)
    if (aid === primaryId) continue;
    const a = byId.get(aid);
    out.push({
      spaceId: aid,
      reason: "ancestor",
      confidence: "medium",
      depth: i + 1,
      sortOrder: a?.sortOrder,
      createdAt: a?.createdAt,
      trace: `ancestor:${i + 1}`,
    });
  }
  // Final dedup guard: ensure no duplicate spaceId in candidates (cycle safety)
  // Keep first occurrence (deterministic)
  const seenCands = new Set<string | null>();
  const deduped: ResolverCandidate[] = [];
  for (const c of out) {
    const key = c.spaceId;
    if (seenCands.has(key)) continue;
    seenCands.add(key);
    deduped.push(c);
  }
  return deduped;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministic task→space resolution.
 *
 * Precedence (stable, explicit):
 *  1. taskSpaceId if provided and valid (including explicit null = standalone) → high/conf explicit
 *  2. draftSpaceId if valid and active gate allows → high/conf draft
 *  3. homeSpaceId if valid and active gate allows → high/conf active-home
 *  4. fallback → none / null (no recommendation). Does NOT invent a space from siblings.
 *
 * Active gate: draft/home are implicit active context, only allowed when
 * taskId is absent (new task) or taskId===activeTaskId. Otherwise blocked to
 * prevent leaking draft/home to non-active tasks. Explicit bindings bypass gate.
 *
 * Excludes archived/effectiveArchived unless includeArchived=true.
 * No sibling leakage: candidates are only primary + its ancestors.
 * Stable tie-breaking: ancestors ordered by depth (proximity); fallback ordering (when needed)
 * uses sortOrder/createdAt/id (same as DB).
 *
 * Advisory only: caller must separately invoke moveTaskInWorkspaceTree if they want to attach.
 */
export function resolveTaskSpace(input: ResolverInput): ResolverResult {
  const {
    spaces,
    tasks,
    taskSpaceId,
    taskId,
    activeTaskId,
    homeSpaceId,
    draftSpaceId,
    includeArchived = false,
  } = input;

  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const byId = new Map(spaces.map((s) => [s.id, s]));

  // If taskSpaceId is undefined and tasks+taskId provided, try to look up explicit from tasks list
  let explicitSpaceId: string | null | undefined = taskSpaceId;
  if (explicitSpaceId === undefined && taskId && tasks) {
    const t = tasks.find((x) => x.id === taskId);
    if (t) {
      // task.spaceId undefined = not set; null = explicit unbound? In TaskDto spaceId can be undefined or null
      // We treat undefined as "not provided" for fallback, but we need to distinguish explicit null vs absent.
      // If t.spaceId === null or string, that's explicit. If undefined, we treat as not provided.
      if (t.spaceId !== undefined) explicitSpaceId = t.spaceId ?? null;
    }
  }

  // Tier 1: explicit wins (including explicit null standalone) — bypasses active gate
  if (explicitSpaceId !== undefined) {
    if (explicitSpaceId === null) {
      // Explicit unbound: task deliberately has no space (standalone group)
      return {
        resolvedSpaceId: null,
        confidence: "high",
        reason: "explicit",
        candidates: [
          {
            spaceId: null,
            reason: "explicit",
            confidence: "high",
            depth: 0,
            trace: "explicit:null",
          },
        ],
        advisory: true,
        explicit: true,
        _effectiveMapSize: effectiveMap.size,
      };
    }
    if (isSpaceValid(explicitSpaceId, spaces, effectiveMap, includeArchived, byId)) {
      const cands = candidatesFromPrimary(explicitSpaceId, "explicit", "high", byId, effectiveMap, includeArchived);
      return {
        resolvedSpaceId: explicitSpaceId,
        confidence: "high",
        reason: "explicit",
        candidates: cands,
        advisory: true,
        explicit: true,
        _effectiveMapSize: effectiveMap.size,
      };
    }
    // Explicit provided but invalid (missing / archived / effectiveArchived) → fall through to next tier
    // Do NOT return archived candidate. Fallback will handle.
    // Intentionally not leaking siblings.
  }

  // Active gate for implicit contexts (draft/home)
  const allowImplicit = canUseImplicitContext(taskId, activeTaskId);

  // Tier 2: draftSpaceId (creation draft) > home — gated
  if (allowImplicit && draftSpaceId != null && isSpaceValid(draftSpaceId, spaces, effectiveMap, includeArchived, byId)) {
    const cands = candidatesFromPrimary(draftSpaceId, "draft", "high", byId, effectiveMap, includeArchived);
    return {
      resolvedSpaceId: draftSpaceId,
      confidence: "high",
      reason: "draft",
      candidates: cands,
      advisory: true,
      explicit: false,
      _effectiveMapSize: effectiveMap.size,
    };
  }

  // Tier 3: homeSpaceId / active context — gated
  if (allowImplicit && homeSpaceId != null && isSpaceValid(homeSpaceId, spaces, effectiveMap, includeArchived, byId)) {
    const cands = candidatesFromPrimary(homeSpaceId, "active-home", "high", byId, effectiveMap, includeArchived);
    return {
      resolvedSpaceId: homeSpaceId,
      confidence: "high",
      reason: "active-home",
      candidates: cands,
      advisory: true,
      explicit: false,
      _effectiveMapSize: effectiveMap.size,
    };
  }

  // Tier 4: fallback / no candidate
  // We intentionally do NOT invent a space from sibling pool. Standalone (null) is the safe fallback.
  // If caller wants to list all valid spaces for manual picker, they should use listCandidateSpaces().
  // For advisory, we return no recommendation (null with none) when no valid context.
  return {
    resolvedSpaceId: null,
    confidence: "none",
    reason: "none",
    candidates: [],
    advisory: true,
    explicit: false,
    _effectiveMapSize: effectiveMap.size,
  };
}

/**
 * List all valid candidate spaces ordered deterministically (stable) for picker/fallback UI.
 * Excludes archived/effectiveArchived by default. Order: sortOrder ASC, createdAt ASC, id ASC
 * (same as AppDatabase renumber ordering). This is the global list; resolver's primary+ancestors
 * ordering takes precedence for advisory, but this helper is useful for displaying alternatives
 * without sibling leakage in advisory flow.
 */
export function listCandidateSpaces(
  spaces: SpaceDto[],
  opts: { includeArchived?: boolean } = {},
): SpaceDto[] {
  const includeArchived = opts.includeArchived ?? false;
  if (includeArchived) {
    return [...spaces].sort(compareSpacesDeterministic);
  }
  const effectiveMap = buildSpaceEffectiveMap(spaces);
  return spaces
    .filter((s) => !(effectiveMap.get(s.id) ?? false))
    .sort(compareSpacesDeterministic);
}

/**
 * Ancestor chain helper exposed for tests / UI (deterministic, with cycle defense).
 * Returns array of ancestor ids from direct parent upward, filtered by effectiveArchived unless includeArchived.
 * Cycle/self-loop safe: originalId seeded, missing-parent break.
 */
export function getSpaceAncestorsDeterministic(
  spaceId: string,
  spaces: SpaceDto[],
  opts: { includeArchived?: boolean } = {},
): string[] {
  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  return getAncestorChain(spaceId, byId, effectiveMap, opts.includeArchived ?? false);
}

/** Validate if a spaceId is a usable resolver candidate (exists + not effectiveArchived unless includeArchived). */
export function isSpaceValidForResolver(
  spaceId: string | null,
  spaces: SpaceDto[],
  opts: { includeArchived?: boolean } = {},
): boolean {
  if (spaceId == null) return false;
  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  return isSpaceValid(spaceId, spaces, effectiveMap, opts.includeArchived ?? false, byId);
}

/**
 * Build an attach request for the advisory result, to be executed via
 * existing moveTaskInWorkspaceTree / bindTaskSpace DB guards.
 * Returns null if resolver has no recommendation (none) or if already at target (no-op).
 * currentSpaceId is required (string|null) — do not rely on undefined guessing.
 * Caller must still handle DB errors (archived guards, cycle, etc.) — resolver is advisory only.
 */
export function toAttachRequest(
  result: ResolverResult,
  taskId: string,
  currentSpaceId: string | null,
): { taskId: string; targetSpaceId: string | null } | null {
  if (result.reason === "none" || result.confidence === "none") return null;
  const target = result.resolvedSpaceId;
  if (currentSpaceId === target) return null;
  return { taskId, targetSpaceId: target };
}

/**
 * Minimal hierarchy policy helper: given a task's resolved space, determine
 * which spaces' context it inherits (ancestors). Child inherits ancestors,
 * ancestors do not automatically inherit child content.
 * This is a pure view of the rule for tests/docs. Cycle-safe via originalId seeded seen.
 */
export function getInheritedContextSpaces(
  resolvedSpaceId: string | null,
  spaces: SpaceDto[],
): string[] {
  if (resolvedSpaceId == null) return [];
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const out: string[] = [resolvedSpaceId];
  const seen = new Set<string>([resolvedSpaceId]);
  let cur: string | null = byId.get(resolvedSpaceId)?.parentId ?? null;
  while (cur) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) break; // missing parent break
    out.push(cur);
    cur = node.parentId ?? null;
  }
  return out;
}

/**
 * Project Shared Context placeholder — intentionally minimal.
 * Resolver foundation requires only this interface; full Project Shared Context/Memory
 * is deferred per spec (do not implement beyond minimal).
 */
export interface WorkspaceResolverProjectContext {
  projectId?: string;
  // future: pinned memory ids, goal, stage, etc. — not implemented in foundation
}
