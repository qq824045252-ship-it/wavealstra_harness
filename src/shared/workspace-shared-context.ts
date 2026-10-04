/**
 * Workspace Shared Context / Memory Foundation — Phase 2 (non-UI, non-LLM)
 *
 * Goals:
 * - Pure, deterministic helpers separated from UI/DB, reusable by main/renderer/shared
 * - Hierarchy policy: sibling isolated, child inherits ancestors, child NOT auto-promote upward,
 *   explicit promote-to-parent only (immediate parent, idempotent)
 * - archived/effectiveArchived excluded from default inheritance; cycle/missing parent defense
 * - Priority: Task > Current Space > Parent > Grandparent > Root
 * - Reuse existing SpaceDto/TaskDto + workspace-tree (buildSpaceEffectiveMap) + workspace-resolver
 *   (getSpaceAncestorsDeterministic) — no forked hierarchy algorithm
 * - Persistence truth is Memory Kernel; these helpers only define deterministic hierarchy/projection behavior.
 *
 * Exports:
 * - Types: WorkspaceSharedContextItem, WorkspaceSharedContextScope, WorkspaceSharedContextBlock
 * - assembleWorkspaceSharedContext(input): deterministic assembly with source/spaceId/depth/scope/priority/order
 * - promoteWorkspaceItemToParent(input): explicit child->immediate parent promotion (idempotent)
 * - helpers: isWorkspaceContextSpaceValid, getWorkspaceAncestorChain, compareWorkspaceItemsDeterministic
 * - adapter: formatWorkspaceSharedContextForPrompt, createInMemoryWorkspaceContextStore
 */

import type { SpaceDto } from "./agent-ipc";
import { buildSpaceEffectiveMap } from "./workspace-tree";
import { getSpaceAncestorsDeterministic } from "./workspace-resolver";

// ---------------------------------------------------------------------------
// Phase 5: Child Manifest / Query-aware / Decay / Budget constants
// ---------------------------------------------------------------------------

/** Formal deterministic budget: target ≈8000, hard max ≈12000 (frozen). */
export const WORKSPACE_CONTEXT_TARGET_CHARS = 8000;
export const WORKSPACE_CONTEXT_HARD_MAX_CHARS = 12000;

/** Per-layer cap (deterministic, task > current > parent > grandparent > root > relevantChild). */
export const WORKSPACE_CONTEXT_PER_LAYER_CAPS: Record<string, number> = {
  task: 2000,
  current: 3000,
  parent: 2000,
  grandparent: 1200,
  root: 1000,
  relevantChild: 1200,
};

/** Ancestor distance decay caps (depth-based, deterministic, no LLM). */
export const WORKSPACE_CONTEXT_DECAY_CAPS = {
  task: 600,
  current: 500,
  parent: 300,
  grandparent: 180,
  deep: 100,
} as const;

export function getWorkspaceDecayCap(depth: number): number {
  if (depth === -1) return WORKSPACE_CONTEXT_DECAY_CAPS.task;
  if (depth === 0) return WORKSPACE_CONTEXT_DECAY_CAPS.current;
  if (depth === 1) return WORKSPACE_CONTEXT_DECAY_CAPS.parent;
  if (depth === 2) return WORKSPACE_CONTEXT_DECAY_CAPS.grandparent;
  return WORKSPACE_CONTEXT_DECAY_CAPS.deep;
}

/** Unicode-safe helpers: avoid cutting surrogate pair / code point */
export function unicodeSlice(str: string, max: number): string {
  const arr = Array.from(str);
  return arr.length > max ? arr.slice(0, max).join("") + "…" : str;
}
export function unicodeLength(str: string): number {
  return Array.from(str).length;
}

/** Lightweight child manifest: direct children only, no full memory leakage. */
export interface WorkspaceChildManifest {
  childSpaceId: string;
  childSpaceName: string;
  itemCount: number;
  preview: string;
  latestUpdatedAt: number;
  freshness: number;
  keywords?: string[];
  sortOrder: number;
  createdAt: number;
}

export interface WorkspaceRelevantChildOptions {
  maxChildren?: number;
  maxCharsPerChild?: number;
  maxTotalChars?: number;
}

export const DEFAULT_RELEVANT_CHILD_OPTIONS: Required<WorkspaceRelevantChildOptions> = {
  maxChildren: 2,
  maxCharsPerChild: 600,
  maxTotalChars: 1200,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkspaceSharedContextScope = "local" | "inherited" | "promoted";

export interface WorkspaceSharedContextItem {
  id: string;
  spaceId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Optional kind for future extension (fact/decision/constraint ... not enforced in foundation) */
  kind?: string;
  /** Manual / automatic / promoted — foundation only uses promoted to label */
  source?: "manual" | "automatic" | "promoted";
  sourceTaskId?: string;
  /** Provenance for promoted items: which child item was promoted */
  promotedFrom?: { spaceId: string; itemId: string };
}

export interface WorkspaceSharedContextBlock {
  /** The underlying item (reference, not cloned) */
  item: WorkspaceSharedContextItem;
  /** Space where item is stored (for inherited, the ancestor id; for local/promoted, current) */
  spaceId: string;
  /** Depth from current: -1 = task, 0 = current space, 1 = parent, 2 = grandparent, ... */
  depth: number;
  scope: WorkspaceSharedContextScope;
  /** Priority: 0 = task (highest), 1 = current, 2 = parent, 3 = grandparent ... lower = higher */
  priority: number;
  /** Global order index (0..n-1) after deterministic assembly */
  order: number;
  /** Top-level source */
  source: "task" | "space";
}

export interface AssembleWorkspaceSharedContextInput {
  spaces: SpaceDto[];
  /** Current space; null = standalone / unbound (only task items) */
  currentSpaceId: string | null;
  /** All space items indexed by spaceId. Accepts Map or plain record for ergonomics. */
  itemsBySpace: Map<string, WorkspaceSharedContextItem[]> | Record<string, WorkspaceSharedContextItem[]>;
  /** Task-level items (highest priority). Task-specific context beyond space hierarchy. */
  taskItems?: WorkspaceSharedContextItem[];
  /** Optional task id for traceability (does not affect deterministic core) */
  taskId?: string;
  /** If true, include archived/effectiveArchived spaces in inheritance. Default false. */
  includeArchived?: boolean;
  /** If true, omit current-space (depth 0) blocks to avoid duplicating spaceMemory in Agent prompt chain. Default false. */
  excludeCurrentSpace?: boolean;
  /** Phase 5: optional query for query-aware child resolution (deterministic lexical). Empty => no child injection. */
  query?: string;
  /** Phase 5: if true, allow relevant child summary injection when query is relevant. Default follows query presence. */
  includeRelevantChildren?: boolean;
  /** Phase 5: relevant child limits (maxChildren, per-child chars, total). */
  relevantChildOptions?: WorkspaceRelevantChildOptions;
  /** Phase 5: deterministic budget override (target/hardMax). Defaults to frozen 8000/12000. */
  budget?: { targetChars?: number; hardMaxChars?: number };
}

export interface AssembleWorkspaceSharedContextResult {
  blocks: WorkspaceSharedContextBlock[];
  /** Deterministic ancestor chain actually used (includes current at 0) */
  ancestorChain: string[];
  /** Diagnostic: effective map size (for tests) */
  effectiveMapSize: number;
  /** Human-readable digest for PromptContextService adapter (empty if no blocks) */
  digest: string;
  /** Phase 5: child manifests (direct children only, lightweight). Empty if current is null/standalone. */
  childManifests?: WorkspaceChildManifest[];
  /** Phase 5: relevant child manifests selected by query (subset of childManifests). Empty if query empty or no relevance. */
  relevantChildManifests?: WorkspaceChildManifest[];
  /** Phase 5: whether budget trimming occurred. */
  budgetTrimmed?: boolean;
}

export interface PromoteWorkspaceItemInput {
  item: WorkspaceSharedContextItem;
  fromSpaceId: string;
  spaces: SpaceDto[];
  /** Current items indexed by spaceId (for duplicate detection) */
  itemsBySpace: Map<string, WorkspaceSharedContextItem[]> | Record<string, WorkspaceSharedContextItem[]>;
  /** Optional: deterministic now (for tests). Default Date.now() */
  now?: number;
  /** If true, allow promote from/to archived spaces. Default false (archived excluded). */
  includeArchived?: boolean;
}

export type PromoteWorkspaceItemResult =
  | { ok: true; targetParentId: string; promotedItem: WorkspaceSharedContextItem; alreadyExisted: boolean; existingItem?: WorkspaceSharedContextItem }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Helpers: deterministic ordering and map access (reuse shared algorithms)
// ---------------------------------------------------------------------------

function toItemsMap(
  m: Map<string, WorkspaceSharedContextItem[]> | Record<string, WorkspaceSharedContextItem[]>,
): Map<string, WorkspaceSharedContextItem[]> {
  if (m instanceof Map) return m;
  const out = new Map<string, WorkspaceSharedContextItem[]>();
  for (const k of Object.keys(m)) out.set(k, (m as Record<string, WorkspaceSharedContextItem[]>)[k] ?? []);
  return out;
}

function getItemsForSpace(
  m: Map<string, WorkspaceSharedContextItem[]>,
  spaceId: string,
): WorkspaceSharedContextItem[] {
  return m.get(spaceId) ?? [];
}

/**
 * Deterministic item ordering within same priority level.
 * Stable: updatedAt DESC (fresh first) → createdAt ASC → id ASC
 * Stable ordering for workspace-scoped memory items (updatedAt DESC with explicit tie-break).
 */
export function compareWorkspaceItemsDeterministic(
  a: WorkspaceSharedContextItem,
  b: WorkspaceSharedContextItem,
): number {
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id.localeCompare(b.id);
}

/** Sorted copy (pure, non-mutating) */
export function sortWorkspaceItemsDeterministic(
  items: WorkspaceSharedContextItem[],
): WorkspaceSharedContextItem[] {
  return [...items].sort(compareWorkspaceItemsDeterministic);
}

/**
 * Validate space id against effectiveArchived map (reuse shared logic).
 * Mirrors workspace-resolver isSpaceValidForResolver but for context assembly.
 */
export function isWorkspaceContextSpaceValid(
  spaceId: string | null,
  spaces: SpaceDto[],
  opts: { includeArchived?: boolean } = {},
): boolean {
  if (spaceId == null) return false;
  const includeArchived = opts.includeArchived ?? false;
  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const s = byId.get(spaceId);
  if (!s) return false;
  if (!includeArchived && (effectiveMap.get(spaceId) ?? false)) return false;
  return true;
}

/**
 * Deterministic ancestor chain for context assembly (reuses workspace-resolver helper).
 * Includes direct filtering of effectiveArchived unless includeArchived.
 * Cycle/missing parent defense via underlying helper (seeded seen set).
 */
export function getWorkspaceAncestorChain(
  spaceId: string,
  spaces: SpaceDto[],
  opts: { includeArchived?: boolean } = {},
): string[] {
  return getSpaceAncestorsDeterministic(spaceId, spaces, { includeArchived: opts.includeArchived ?? false });
}

// ---------------------------------------------------------------------------
// Phase 5: Child Manifest / Query-aware / Decay / Budget helpers (pure)
// ---------------------------------------------------------------------------

function extractKeywords(content: string, max = 5): string[] {
  const words = content
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((w) => w.length >= 2 && w.length <= 20)
    .filter((w, i, arr) => arr.indexOf(w) === i);
  return words.slice(0, max);
}

/** Tokenize query deterministically with Chinese bigram support (no single-char expansion) */
function tokenizeQueryInternal(query: string): string[] {
  const lower = query.toLowerCase();
  const parts = lower.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
  const rawTokens = parts.filter((t) => {
    const isChinese = /[\u4e00-\u9fff]/.test(t);
    return isChinese ? true : t.length >= 2;
  });
  const tokens = new Set<string>();
  for (const tok of rawTokens) {
    tokens.add(tok);
    const isChinese = /[\u4e00-\u9fff]/.test(tok);
    if (isChinese && Array.from(tok).length > 2) {
      const chars = Array.from(tok);
      for (let i = 0; i < chars.length - 1; i++) {
        const bigram = chars[i] + chars[i + 1];
        tokens.add(bigram);
      }
    }
  }
  return Array.from(tokens);
}

/** Build direct-child manifests (lightweight, deterministic, no full memory). */
export function buildChildManifests(
  parentSpaceId: string | null,
  spaces: SpaceDto[],
  itemsBySpace: Map<string, WorkspaceSharedContextItem[]> | Record<string, WorkspaceSharedContextItem[]>,
  opts: { includeArchived?: boolean; previewMaxLen?: number } = {},
): WorkspaceChildManifest[] {
  if (parentSpaceId == null) return [];
  const includeArchived = opts.includeArchived ?? false;
  const previewMaxLen = opts.previewMaxLen ?? 80;
  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const itemsMap = toItemsMap(itemsBySpace);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  // Direct children only
  const children = spaces.filter((s) => s.parentId === parentSpaceId);
  // EffectiveArchived excluded unless includeArchived
  const filtered = children.filter((c) => includeArchived || !(effectiveMap.get(c.id) ?? false));
  // Deterministic order: sortOrder ASC -> createdAt ASC -> id ASC (same as workspace-tree)
  filtered.sort((a, b) => {
    const ao = a.sortOrder ?? 0;
    const bo = b.sortOrder ?? 0;
    if (ao !== bo) return ao - bo;
    const ac = a.createdAt ?? 0;
    const bc = b.createdAt ?? 0;
    if (ac !== bc) return ac - bc;
    return a.id.localeCompare(b.id);
  });
  const manifests: WorkspaceChildManifest[] = [];
  for (const child of filtered) {
    const items = sortWorkspaceItemsDeterministic(getItemsForSpace(itemsMap, child.id));
    const itemCount = items.length;
    const latest = items[0];
    const previewRaw = latest ? latest.content.trim() : "";
    const preview = unicodeLength(previewRaw) > previewMaxLen ? unicodeSlice(previewRaw, previewMaxLen) : previewRaw;
    const keywords = latest ? extractKeywords(latest.content) : [];
    manifests.push({
      childSpaceId: child.id,
      childSpaceName: child.name,
      itemCount,
      preview,
      latestUpdatedAt: latest?.updatedAt ?? child.createdAt ?? 0,
      freshness: latest?.updatedAt ?? child.createdAt ?? 0,
      keywords: keywords.length ? keywords : undefined,
      sortOrder: child.sortOrder ?? 0,
      createdAt: child.createdAt ?? 0,
    });
  }
  return manifests;
}

/** Tokenize query deterministically (lowercase, split non-alphanum, len>=2, dedup, Chinese bigram). */
export function tokenizeQuery(query: string): string[] {
  return tokenizeQueryInternal(query);
}

/** Score manifest against tokens (deterministic lexical, Chinese substring, English word-boundary). */
export function scoreChildManifest(manifest: WorkspaceChildManifest, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const hay = `${manifest.childSpaceName} ${manifest.preview} ${(manifest.keywords ?? []).join(" ")}`.toLowerCase();
  const hayTokens = new Set(hay.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean));
  let score = 0;
  for (const tok of tokens) {
    const isChinese = /[\u4e00-\u9fff]/.test(tok);
    if (isChinese) {
      if (hay.includes(tok)) score += 1;
    } else {
      if (hayTokens.has(tok)) score += 1;
    }
  }
  return score;
}

/** Select relevant child manifests deterministically. Empty query => []. */
export function selectRelevantChildManifests(
  query: string | undefined | null,
  manifests: WorkspaceChildManifest[],
  opts: WorkspaceRelevantChildOptions = {},
): WorkspaceChildManifest[] {
  const q = (query ?? "").trim();
  if (!q) return [];
  const { maxChildren, maxCharsPerChild } = { ...DEFAULT_RELEVANT_CHILD_OPTIONS, ...opts };
  const tokens = tokenizeQuery(q);
  if (tokens.length === 0) return [];
  const scored = manifests
    .map((m) => ({ manifest: m, score: scoreChildManifest(m, tokens) }))
    .filter((x) => x.score > 0);
  if (scored.length === 0) return [];
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.manifest.freshness !== a.manifest.freshness) return b.manifest.freshness - a.manifest.freshness;
    return a.manifest.childSpaceId.localeCompare(b.manifest.childSpaceId);
  });
  // Enforce per-child preview char already limited, but also enforce maxCharsPerChild if preview longer
  const trimmed = scored.slice(0, maxChildren).map((x) => {
    const m = x.manifest;
    if (unicodeLength(m.preview) > maxCharsPerChild) {
      return { ...m, preview: unicodeSlice(m.preview, maxCharsPerChild) };
    }
    return m;
  });
  return trimmed;
}

/** Build relevant child summary string (deterministic, lightweight). */
export function formatRelevantChildSection(
  manifests: WorkspaceChildManifest[],
  itemsBySpace: Map<string, WorkspaceSharedContextItem[]> | Record<string, WorkspaceSharedContextItem[]>,
  opts: { maxCharsPerChild?: number; maxItemsPerChild?: number } = {},
): string | null {
  if (manifests.length === 0) return null;
  const maxCharsPerChild = opts.maxCharsPerChild ?? DEFAULT_RELEVANT_CHILD_OPTIONS.maxCharsPerChild;
  const maxItemsPerChild = opts.maxItemsPerChild ?? 2;
  const itemsMap = toItemsMap(itemsBySpace);
  const lines: string[] = ["## Relevant Child Workspaces (query-aware, deterministic)"];
  lines.push("以下为与当前查询明确相关的直接子空间轻量摘要（direct children only， sibling isolated）");
  for (const m of manifests) {
    const childItems = sortWorkspaceItemsDeterministic(getItemsForSpace(itemsMap, m.childSpaceId)).slice(0, maxItemsPerChild);
    let childLine = `- [child:${m.childSpaceName} id=${m.childSpaceId} items=${m.itemCount} fresh=${m.freshness}] ${m.preview}`;
    if (unicodeLength(childLine) > maxCharsPerChild) childLine = unicodeSlice(childLine, maxCharsPerChild);
    lines.push(childLine);
    for (const it of childItems) {
      const cap = Math.min(120, maxCharsPerChild - 20);
      const prev = unicodeLength(it.content) > cap ? unicodeSlice(it.content, cap) : it.content;
      lines.push(`  · ${prev} (id=${it.id})`);
    }
  }
  return lines.join("\n");
}

/** Apply deterministic budget: per-layer cap + global target/hardMax, priority Task>Current>Parent>…>RelevantChild. */
export function applyWorkspaceContextBudget(
  blocks: WorkspaceSharedContextBlock[],
  opts: { targetChars?: number; hardMaxChars?: number; relevantChildSectionChars?: number } = {},
): { keptBlocks: WorkspaceSharedContextBlock[]; trimmed: boolean } {
  const target = opts.targetChars ?? WORKSPACE_CONTEXT_TARGET_CHARS;
  const hardMax = opts.hardMaxChars ?? WORKSPACE_CONTEXT_HARD_MAX_CHARS;
  // Per-layer caps: group by depth priority
  const caps = WORKSPACE_CONTEXT_PER_LAYER_CAPS;
  // Map depth priority to cap key
  const depthToKey = (depth: number): string => {
    if (depth === -1) return "task";
    if (depth === 0) return "current";
    if (depth === 1) return "parent";
    if (depth === 2) return "grandparent";
    return "root";
  };
  // First, per-layer cap enforcement (deterministic: drop oldest within layer)
  const byDepth = new Map<number, WorkspaceSharedContextBlock[]>();
  for (const b of blocks) {
    const arr = byDepth.get(b.depth) ?? [];
    arr.push(b);
    byDepth.set(b.depth, arr);
  }
  let filtered: WorkspaceSharedContextBlock[] = [];
  let perLayerTrimmed = false;
  for (const [depth, arr] of byDepth) {
    const key = depthToKey(depth);
    const cap = (caps as Record<string, number>)[key] ?? 1000;
    // arr already in deterministic priority order (updatedAt DESC etc). Keep from start until cap.
    // P2-2: use decayed length (actual injectable) not raw content.length
    let kept: WorkspaceSharedContextBlock[] = [];
    let sum = 0;
    for (const b of arr) {
      const decayedLen = Math.min(unicodeLength(b.item.content), getWorkspaceDecayCap(b.depth));
      if (sum + decayedLen > cap && kept.length > 0) {
        perLayerTrimmed = true;
        break;
      }
      sum += decayedLen;
      kept.push(b);
    }
    // If single first item already exceeds cap, keep it (avoid empty layer)
    if (kept.length === 0 && arr.length > 0) kept = [arr[0]!];
    filtered.push(...kept);
  }
  // Re-sort filtered to global priority order (task -1, then depth 0,1,2,...)
  filtered.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.order - b.order;
  });
  // Global target enforcement: drop lowest priority (largest depth/large order) first
  // Keep at least task+current if possible
  let digestLen = estimateBlocksChars(filtered) + (opts.relevantChildSectionChars ?? 0);
  let globalTrimmed = perLayerTrimmed;
  while (filtered.length > 0 && digestLen > target) {
    // Find lowest priority (max priority). If tie, largest depth, then largest order (oldest last).
    let idxToRemove = filtered.length - 1;
    // Ensure we don't drop task (-1) or current (0) if we still have deeper ones to drop
    // Our filtered is sorted priority ascending, so last is lowest priority -> correct to drop.
    // But keep at least 1 block if target still exceeded -> will hard truncate later.
    if (filtered.length <= 2 && digestLen > target) break;
    filtered.splice(idxToRemove, 1);
    digestLen = estimateBlocksChars(filtered) + (opts.relevantChildSectionChars ?? 0);
    globalTrimmed = true;
  }
  // Hard max will be enforced at digest string level (formatDigest truncation)
  return { keptBlocks: filtered, trimmed: globalTrimmed || perLayerTrimmed };
}

function estimateBlocksChars(blocks: WorkspaceSharedContextBlock[]): number {
  // Rough estimate: header 150 + per block decay cap + overhead 50
  let sum = 150;
  for (const b of blocks) {
    sum += getWorkspaceDecayCap(b.depth) + 50;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Assembly: Task > Current > Parent > Grandparent > Root (deterministic)
// ---------------------------------------------------------------------------

function formatDigest(blocks: WorkspaceSharedContextBlock[], opts: { hardMaxChars?: number; relevantChildSection?: string | null } = {}): string {
  if (blocks.length === 0 && !opts.relevantChildSection) return "";
  const lines: string[] = ["## Workspace Shared Context (hierarchical, deterministic)"];
  lines.push("优先级：Task(0) > Current(1) > Parent(2) > Grandparent(3) > Root...；同级内按 updatedAt DESC, id 定序。Decay: depth -1=600, 0=500, 1=300, 2=180, >=3=100 (no LLM).");
  for (const b of blocks) {
    const cap = getWorkspaceDecayCap(b.depth);
    const preview = unicodeLength(b.item.content) > cap ? unicodeSlice(b.item.content, cap) : b.item.content;
    const scopeLabel = b.scope === "promoted" ? "promoted" : b.scope === "inherited" ? "inherited" : "local";
    const src = b.source === "task" ? "task" : "space";
    lines.push(`- [${scopeLabel}/${b.source}:${b.spaceId} depth=${b.depth} prio=${b.priority} order=${b.order}] ${preview} (id=${b.item.id})`);
    if (b.item.promotedFrom) {
      lines.push(`  ↳ promoted from ${b.item.promotedFrom.spaceId}:${b.item.promotedFrom.itemId}`);
    }
  }
  if (opts.relevantChildSection) {
    lines.push(opts.relevantChildSection);
  }
  let digest = lines.join("\n");
  const hardMax = opts.hardMaxChars ?? WORKSPACE_CONTEXT_HARD_MAX_CHARS;
  if (unicodeLength(digest) > hardMax) {
    digest = Array.from(digest).slice(0, hardMax).join("");
  }
  return digest;
}

export function formatDigestWithRelevantChild(
  blocks: WorkspaceSharedContextBlock[],
  relevantChildSection: string | null,
  hardMaxChars?: number,
): string {
  return formatDigest(blocks, { relevantChildSection, hardMaxChars });
}

/**
 * Deterministic context assembly.
 *
 * Priority: task (0) > current space (1) > parent (2) > grandparent (3) > root ...
 * Scope: local (depth 0, non-promoted), promoted (depth 0, promotedFrom/source=promoted),
 *        inherited (depth>0)
 * archived/effectiveArchived excluded unless includeArchived; cycle/missing parent handled
 * deterministically via shared ancestor helper.
 * Sibling isolation: only ancestors in chain, never siblings.
 * Child→parent non-pollution: parent assembly does not include child's items unless explicitly promoted
 * (promoted items are stored in parent, so they appear as local/promoted in parent's view).
 *
 * Dedupe: the same L1 Memory may be bound to multiple scopes after promotion; emit it once at the highest-priority occurrence.
 * Deterministic: same inputs always produce same blocks order (no random, no hidden heuristics).
 * Source/spaceId/depth/scope/priority/order all emitted for PromptContextService adapter.
 */
export function assembleWorkspaceSharedContext(
  input: AssembleWorkspaceSharedContextInput,
): AssembleWorkspaceSharedContextResult {
  const {
    spaces,
    currentSpaceId,
    taskItems = [],
    includeArchived = false,
    excludeCurrentSpace = false,
    query,
    includeRelevantChildren,
    relevantChildOptions,
    budget,
  } = input;

  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const itemsMap = toItemsMap(input.itemsBySpace);

  const blocks: WorkspaceSharedContextBlock[] = [];
  const seenIdentityKeys = new Set<string>();
  let order = 0;

  // --- Task level (priority 0) ---
  const sortedTask = sortWorkspaceItemsDeterministic(taskItems);
  for (const item of sortedTask) {
    const identityKey = getWorkspaceContextIdentityKey(item);
    if (seenIdentityKeys.has(identityKey)) continue;
    seenIdentityKeys.add(identityKey);
    blocks.push({
      item,
      spaceId: currentSpaceId ?? "task",
      depth: -1,
      scope: "local",
      priority: 0,
      order: order++,
      source: "task",
    });
  }

  // --- No space context (standalone) ---
  if (currentSpaceId == null) {
    const hardMaxChars = budget?.hardMaxChars ?? WORKSPACE_CONTEXT_HARD_MAX_CHARS;
    const budgetResult = applyWorkspaceContextBudget(blocks, { targetChars: budget?.targetChars, hardMaxChars });
    return {
      blocks: budgetResult.keptBlocks,
      ancestorChain: [],
      effectiveMapSize: effectiveMap.size,
      digest: formatDigest(budgetResult.keptBlocks, { hardMaxChars }),
      childManifests: [],
      relevantChildManifests: [],
      budgetTrimmed: budgetResult.trimmed,
    };
  }

  // Validate current space (archived/missing => no space inheritance unless includeArchived)
  const currentExists = byId.has(currentSpaceId);
  if (!currentExists) {
    const hardMaxChars = budget?.hardMaxChars ?? WORKSPACE_CONTEXT_HARD_MAX_CHARS;
    const budgetResult = applyWorkspaceContextBudget(blocks, { targetChars: budget?.targetChars, hardMaxChars });
    return {
      blocks: budgetResult.keptBlocks,
      ancestorChain: [],
      effectiveMapSize: effectiveMap.size,
      digest: formatDigest(budgetResult.keptBlocks, { hardMaxChars }),
      childManifests: [],
      relevantChildManifests: [],
      budgetTrimmed: budgetResult.trimmed,
    };
  }
  if (!includeArchived && (effectiveMap.get(currentSpaceId) ?? false)) {
    const hardMaxChars = budget?.hardMaxChars ?? WORKSPACE_CONTEXT_HARD_MAX_CHARS;
    const budgetResult = applyWorkspaceContextBudget(blocks, { targetChars: budget?.targetChars, hardMaxChars });
    return {
      blocks: budgetResult.keptBlocks,
      ancestorChain: [],
      effectiveMapSize: effectiveMap.size,
      digest: formatDigest(budgetResult.keptBlocks, { hardMaxChars }),
      childManifests: [],
      relevantChildManifests: [],
      budgetTrimmed: budgetResult.trimmed,
    };
  }

  // Ancestor chain (current first, then parents), filtered by effectiveArchived unless includeArchived
  const ancestors = getWorkspaceAncestorChain(currentSpaceId, spaces, { includeArchived });
  const chain = [currentSpaceId, ...ancestors];

  for (let depth = 0; depth < chain.length; depth++) {
    const sid = chain[depth]!;
    // Phase 2B consolidation: when Agent prompt already has spaceMemory, skip current-space to avoid duplicate injection
    if (excludeCurrentSpace && depth === 0) continue;
    // Defensive: skip archived nodes even if helper somehow returns them (when includeArchived false)
    if (!includeArchived && (effectiveMap.get(sid) ?? false)) continue;
    // Defensive: skip missing (should not happen after validation, but deterministic guard)
    if (!byId.has(sid)) continue;
    const raw = getItemsForSpace(itemsMap, sid);
    const sorted = sortWorkspaceItemsDeterministic(raw);
    for (const item of sorted) {
      const identityKey = getWorkspaceContextIdentityKey(item);
      if (seenIdentityKeys.has(identityKey)) continue;
      seenIdentityKeys.add(identityKey);
      const isPromoted = item.source === "promoted" || Boolean(item.promotedFrom);
      const scope: WorkspaceSharedContextScope =
        depth === 0 ? (isPromoted ? "promoted" : "local") : "inherited";
      const priority = depth + 1; // task 0, current 1, parent 2...
      blocks.push({
        item,
        spaceId: sid,
        depth,
        scope,
        priority,
        order: order++,
        source: "space",
      });
    }
  }

  // Phase 5: Child Manifest + Query-aware Relevant Child + Budget + Decay
  const targetChars = budget?.targetChars ?? WORKSPACE_CONTEXT_TARGET_CHARS;
  const hardMaxChars = budget?.hardMaxChars ?? WORKSPACE_CONTEXT_HARD_MAX_CHARS;
  // Build direct-child manifests (lightweight, direct children only, sibling isolated)
  const rawChildManifests = buildChildManifests(currentSpaceId, spaces, itemsMap, { includeArchived });
  // Query-aware selection (empty query => none)
  const shouldIncludeChildren = includeRelevantChildren ?? (query !== undefined && query !== null);
  let relevantManifests: WorkspaceChildManifest[] = [];
  let relevantChildSection: string | null = null;
  if (shouldIncludeChildren) {
    const q = (query ?? "").trim();
    if (q) {
      relevantManifests = selectRelevantChildManifests(q, rawChildManifests, relevantChildOptions);
      if (relevantManifests.length > 0) {
        relevantChildSection = formatRelevantChildSection(relevantManifests, itemsMap, {
          maxCharsPerChild: relevantChildOptions?.maxCharsPerChild,
        });
      }
    }
  }
  // Apply deterministic budget: first drop lowest-priority relevant children if over target, then ancestor blocks
  const originalRelevantCount = relevantManifests.length;
  let relevantChildSectionChars = relevantChildSection ? relevantChildSection.length : 0;
  let estimatedTotal = estimateBlocksChars(blocks) + relevantChildSectionChars;
  // Relevant children are lowest priority: drop them first deterministically (least relevant last)
  while (estimatedTotal > targetChars && relevantManifests.length > 0) {
    relevantManifests = relevantManifests.slice(0, -1);
    relevantChildSection = relevantManifests.length > 0 ? formatRelevantChildSection(relevantManifests, itemsMap, { maxCharsPerChild: relevantChildOptions?.maxCharsPerChild }) : null;
    relevantChildSectionChars = relevantChildSection ? relevantChildSection.length : 0;
    estimatedTotal = estimateBlocksChars(blocks) + relevantChildSectionChars;
  }
  // Then apply per-layer + global budget to ancestor blocks
  const budgetResult = applyWorkspaceContextBudget(blocks, {
    targetChars,
    hardMaxChars,
    relevantChildSectionChars,
  });
  const keptBlocks = budgetResult.keptBlocks;
  const budgetTrimmed = budgetResult.trimmed || relevantManifests.length < originalRelevantCount;
  const digest = formatDigest(keptBlocks, {
    hardMaxChars,
    relevantChildSection,
  });

  return {
    blocks: keptBlocks,
    ancestorChain: chain,
    effectiveMapSize: effectiveMap.size,
    digest,
    childManifests: rawChildManifests,
    relevantChildManifests: relevantManifests,
    budgetTrimmed,
  };
}

// ---------------------------------------------------------------------------
// Promotion: explicit child -> immediate parent (idempotent, no cross-level)
// ---------------------------------------------------------------------------

/**
 * Deterministic promoted id: encodes target parent, origin space, and origin item.
 * Global stable, idempotent: second promote yields same id.
 */
export function buildPromotedItemId(
  targetParentId: string,
  fromSpaceId: string,
  originItemId: string,
): string {
  return `ws-promoted:${targetParentId}:${fromSpaceId}:${originItemId}`;
}

/** Canonical L1 identity used to dedupe the same Memory across promoted scopes. */
export function unwrapWorkspacePromotedItemId(itemId: string): string {
  let current = itemId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const match = /^ws-promoted:[^:]+:[^:]+:(.+)$/.exec(current);
    if (!match?.[1]) break;
    current = match[1];
  }
  return current;
}

export function getWorkspaceContextIdentityKey(item: WorkspaceSharedContextItem): string {
  return unwrapWorkspacePromotedItemId(item.promotedFrom?.itemId ?? item.id);
}

/**
 * Check if parent already contains a promoted copy of the origin item (idempotent guard).
 * Returns existing item if found (by deterministic id or by promotedFrom provenance).
 */
export function findExistingPromotedItem(
  parentItems: WorkspaceSharedContextItem[],
  fromSpaceId: string,
  originItemId: string,
  targetParentId: string,
): WorkspaceSharedContextItem | undefined {
  const originIdentity = unwrapWorkspacePromotedItemId(originItemId);
  const sameL1 = parentItems.find((it) => getWorkspaceContextIdentityKey(it) === originIdentity);
  if (sameL1) return sameL1;
  const detId = buildPromotedItemId(targetParentId, fromSpaceId, originItemId);
  const byId = parentItems.find((it) => it.id === detId);
  if (byId) return byId;
  // Fallback: provenance match (for items created before deterministic id convention)
  return parentItems.find(
    (it) => it.promotedFrom?.spaceId === fromSpaceId && unwrapWorkspacePromotedItemId(it.promotedFrom.itemId) === originIdentity,
  );
}

/**
 * Explicit promotion: child item -> immediate parent shared context.
 * - Only immediate parent (no multi-level implicit)
 * - Idempotent: duplicate promote returns alreadyExisted=true and reuses existing item
 * - Validates archived/cycle/missing parent deterministically
 * - Does NOT mutate itemsBySpace; caller must persist returned promotedItem if ok
 */
export function promoteWorkspaceItemToParent(
  input: PromoteWorkspaceItemInput,
): PromoteWorkspaceItemResult {
  const { item, fromSpaceId, spaces, now, includeArchived = false } = input;
  const itemsMap = toItemsMap(input.itemsBySpace);
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const effectiveMap = buildSpaceEffectiveMap(spaces);

  // Validate origin space
  if (!byId.has(fromSpaceId)) {
    return { ok: false, error: `来源空间不存在：${fromSpaceId}` };
  }
  if (!includeArchived && (effectiveMap.get(fromSpaceId) ?? false)) {
    return { ok: false, error: `来源空间已归档，拒绝提升：${fromSpaceId}` };
  }
  if (item.spaceId !== fromSpaceId) {
    return { ok: false, error: `条目 spaceId(${item.spaceId}) 与 fromSpaceId(${fromSpaceId}) 不一致` };
  }
  if (item.source === "promoted" || item.promotedFrom) {
    return { ok: false, error: "仅来源空间的本地条目可提升；已提升条目不能继续逐级提升" };
  }

  // Resolve immediate parent (deterministic, with missing-parent defense)
  const origin = byId.get(fromSpaceId)!;
  const targetParentId = origin.parentId ?? null;
  if (targetParentId == null) {
    return { ok: false, error: `空间 ${fromSpaceId} 为根空间，无父级可提升` };
  }
  if (targetParentId === fromSpaceId) {
    return { ok: false, error: `不能提升到自身（cycle 自环）：${fromSpaceId}` };
  }
  if (!byId.has(targetParentId)) {
    return { ok: false, error: `父级空间不存在（missing parent）：${targetParentId}` };
  }
  if (!includeArchived && (effectiveMap.get(targetParentId) ?? false)) {
    return { ok: false, error: `父级空间已归档，拒绝提升：${targetParentId}` };
  }

  // Sibling / archived parent guard via validation helper
  if (!isWorkspaceContextSpaceValid(targetParentId, spaces, { includeArchived })) {
    return { ok: false, error: `父级空间不可用：${targetParentId}` };
  }

  // Idempotent check
  const parentItems = getItemsForSpace(itemsMap, targetParentId);
  const existing = findExistingPromotedItem(parentItems, fromSpaceId, item.id, targetParentId);
  if (existing) {
    return { ok: true, targetParentId, promotedItem: existing, alreadyExisted: true, existingItem: existing };
  }

  const timestamp = now ?? Date.now();
  const promoted: WorkspaceSharedContextItem = {
    id: buildPromotedItemId(targetParentId, fromSpaceId, item.id),
    spaceId: targetParentId,
    content: item.content,
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: item.kind,
    source: "promoted",
    promotedFrom: { spaceId: fromSpaceId, itemId: item.id },
  };

  return { ok: true, targetParentId, promotedItem: promoted, alreadyExisted: false };
}

/**
 * Validate if promotion is possible without executing it (advisory).
 */
export function canPromoteToParent(
  fromSpaceId: string,
  spaces: SpaceDto[],
  opts: { includeArchived?: boolean } = {},
): { ok: true; parentId: string } | { ok: false; error: string } {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const origin = byId.get(fromSpaceId);
  if (!origin) return { ok: false, error: `来源空间不存在：${fromSpaceId}` };
  const parentId = origin.parentId ?? null;
  if (parentId == null) return { ok: false, error: `无父级` };
  if (!byId.has(parentId)) return { ok: false, error: `父级不存在：${parentId}` };
  if (!isWorkspaceContextSpaceValid(parentId, spaces, { includeArchived: opts.includeArchived ?? false })) {
    return { ok: false, error: `父级归档或无效：${parentId}` };
  }
  return { ok: true, parentId };
}

// ---------------------------------------------------------------------------
// Minimal adapter for PromptContextService integration (non-intrusive)
// ---------------------------------------------------------------------------

/**
 * Minimal prompt adapter: assembleWorkspaceSharedContext already returns digest,
 * but this helper produces a stable AssemblySegmentDto-like section for future
 * PromptContextService / PromptAssembly integration without modifying their core.
 * Caller can inject returned `content` as an additional segment.
 */
export function formatWorkspaceSharedContextForPrompt(
  result: AssembleWorkspaceSharedContextResult,
): string | null {
  if (result.blocks.length === 0) return null;
  return result.digest;
}

/**
 * In-memory store adapter for tests/tools (pure, no DB).
 * Provides minimal get/upsert/list for WorkspaceSharedContextItem without schema change.
 */
export function createInMemoryWorkspaceContextStore(
  initial?: Record<string, WorkspaceSharedContextItem[]>,
) {
  const map = new Map<string, WorkspaceSharedContextItem[]>();
  if (initial) {
    for (const k of Object.keys(initial)) map.set(k, [...(initial[k] ?? [])]);
  }
  return {
    get(spaceId: string): WorkspaceSharedContextItem[] {
      return [...(map.get(spaceId) ?? [])];
    },
    listBySpace(): Map<string, WorkspaceSharedContextItem[]> {
      return new Map(map);
    },
    upsert(item: WorkspaceSharedContextItem): void {
      const arr = map.get(item.spaceId) ?? [];
      const idx = arr.findIndex((x) => x.id === item.id);
      if (idx >= 0) arr[idx] = item;
      else arr.push(item);
      map.set(item.spaceId, arr);
    },
    delete(itemId: string, spaceId: string): boolean {
      const arr = map.get(spaceId);
      if (!arr) return false;
      const idx = arr.findIndex((x) => x.id === itemId);
      if (idx < 0) return false;
      arr.splice(idx, 1);
      return true;
    },
    asRecord(): Record<string, WorkspaceSharedContextItem[]> {
      const out: Record<string, WorkspaceSharedContextItem[]> = {};
      for (const [k, v] of map) out[k] = [...v];
      return out;
    },
    asMap(): Map<string, WorkspaceSharedContextItem[]> {
      return new Map(map);
    },
  };
}


// ---------------------------------------------------------------------------
// UI Foundation — structured view for renderer (no forked hierarchy)
// ---------------------------------------------------------------------------

/** IPC channels for shared-context UI foundation (typed, no raw DB upsert). */
export const WorkspaceSharedContextIpc = {
  getView: "workspace:getSharedContextView",
  promote: "workspace:promoteSharedContextItem",
} as const;

export interface WorkspaceSharedContextViewRequest {
  /** Current space id (null = standalone / no space). */
  currentSpaceId: string | null;
  /** Optional task id for future task+space surfacing (currently advisory, no auto). */
  taskId?: string | null;
}

export interface WorkspaceSharedContextPromoteRequest {
  itemId: string;
  fromSpaceId: string;
}

export type WorkspaceSharedContextPromoteResult =
  | { ok: true; targetParentId: string; alreadyExisted: boolean; message?: string }
  | { ok: false; error: string };

/** UI view item (block + display metadata). Never expose raw id as primary visual. */
export interface WorkspaceSharedContextViewItem {
  id: string;
  spaceId: string;
  spaceName: string;
  content: string;
  preview: string;
  scope: WorkspaceSharedContextScope;
  depth: number;
  priority: number;
  order: number;
  source: "task" | "space";
  updatedAt: number;
  createdAt: number;
  promotedFrom?: { spaceId: string; itemId: string; spaceName?: string };
  /** Whether Promote action is available for this item (local only). */
  canPromote: boolean;
  promoteDisabledReason?: string;
}

export interface WorkspaceSharedContextView {
  currentSpaceId: string | null;
  currentSpaceName: string | null;
  parentId: string | null;
  parentName: string | null;
  isRoot: boolean;
  hasParent: boolean;
  isStandalone: boolean;
  memoryEnabled: boolean;
  effectiveArchived: boolean;
  ancestorChain: string[];
  blocks: WorkspaceSharedContextViewItem[];
  grouped: {
    local: WorkspaceSharedContextViewItem[];
    inherited: WorkspaceSharedContextViewItem[];
    promoted: WorkspaceSharedContextViewItem[];
  };
  totalCount: number;
  message?: string;
}

/** Truncate content for preview (no id as primary visual). */
export function truncateWorkspaceContent(content: string, maxLen = 120): string {
  const t = content.trim();
  if (unicodeLength(t) <= maxLen) return t;
  return unicodeSlice(t, maxLen);
}

/** Reason helper for canPromote (deterministic, testable). */
export function getWorkspacePromoteDisabledReason(opts: {
  memoryEnabled: boolean;
  isStandalone: boolean;
  effectiveArchived: boolean;
  isRoot: boolean;
  hasParent: boolean;
  scope: WorkspaceSharedContextScope;
  alreadyExisted: boolean;
}): string | undefined {
  if (!opts.memoryEnabled) return "记忆已关闭，共享上下文未启用";
  if (opts.isStandalone) return "未绑定空间";
  if (opts.effectiveArchived) return "空间已归档";
  if (opts.isRoot || !opts.hasParent) return "根空间无父级";
  if (opts.scope !== "local") return "仅当前空间的本地条目可提升";
  if (opts.alreadyExisted) return "已提升到父空间";
  return undefined;
}

/**
 * Build renderer view from assembly result + spaces (pure, no DB).
 * Main must call this; renderer must not re-derive ancestors/effectiveArchived.
 */
export function buildWorkspaceSharedContextView(input: {
  spaces: SpaceDto[];
  currentSpaceId: string | null;
  memoryEnabled: boolean;
  result: AssembleWorkspaceSharedContextResult;
  itemsBySpace: Map<string, WorkspaceSharedContextItem[]> | Record<string, WorkspaceSharedContextItem[]>;
}): WorkspaceSharedContextView {
  const { spaces, currentSpaceId, memoryEnabled, result } = input;
  const itemsMap = toItemsMap(input.itemsBySpace);
  const isStandalone = currentSpaceId == null;
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const nameById = new Map(spaces.map((s) => [s.id, s.name]));
  const effectiveMap = buildSpaceEffectiveMap(spaces);
  const current = currentSpaceId ? byId.get(currentSpaceId) : undefined;
  const parentId = current?.parentId ?? null;
  const hasParent = parentId != null && byId.has(parentId);
  const isRoot = !isStandalone && parentId == null;
  const effectiveArchived = currentSpaceId ? (effectiveMap.get(currentSpaceId) ?? false) : false;
  const currentSpaceName = current?.name ?? null;
  const parentName = parentId ? (nameById.get(parentId) ?? null) : null;

  // Memory disabled or standalone => empty view with message, no blocks
  if (!memoryEnabled) {
    return {
      currentSpaceId,
      currentSpaceName,
      parentId,
      parentName,
      isRoot,
      hasParent,
      isStandalone,
      memoryEnabled: false,
      effectiveArchived,
      ancestorChain: result.ancestorChain ?? [],
      blocks: [],
      grouped: { local: [], inherited: [], promoted: [] },
      totalCount: 0,
      message: "记忆已关闭，共享上下文未启用",
    };
  }
  if (isStandalone) {
    return {
      currentSpaceId,
      currentSpaceName,
      parentId,
      parentName,
      isRoot: false,
      hasParent: false,
      isStandalone: true,
      memoryEnabled: true,
      effectiveArchived: false,
      ancestorChain: [],
      blocks: [],
      grouped: { local: [], inherited: [], promoted: [] },
      totalCount: 0,
      message: "未绑定空间",
    };
  }
  if (!current) {
    return {
      currentSpaceId,
      currentSpaceName: null,
      parentId: null,
      parentName: null,
      isRoot: false,
      hasParent: false,
      isStandalone: false,
      memoryEnabled: true,
      effectiveArchived: false,
      ancestorChain: [],
      blocks: [],
      grouped: { local: [], inherited: [], promoted: [] },
      totalCount: 0,
      message: "空间不存在",
    };
  }

  // Build view items from blocks (priority order preserved)
  const parentItems = parentId ? (itemsMap.get(parentId) ?? []) : [];
  const blocks: WorkspaceSharedContextViewItem[] = result.blocks.map((b) => {
    const spaceName = nameById.get(b.spaceId) ?? b.spaceId;
    const preview = truncateWorkspaceContent(b.item.content);
    let promotedFrom:
      | { spaceId: string; itemId: string; spaceName?: string }
      | undefined;
    if (b.item.promotedFrom) {
      promotedFrom = {
        spaceId: b.item.promotedFrom.spaceId,
        itemId: b.item.promotedFrom.itemId,
        spaceName: nameById.get(b.item.promotedFrom.spaceId) ?? b.item.promotedFrom.spaceId,
      };
    }
    // canPromote only for local scope; check alreadyExisted via parent store
    let alreadyExisted = false;
    if (b.scope === "local" && hasParent && parentId) {
      const existing = findExistingPromotedItem(parentItems, b.item.spaceId, b.item.id, parentId);
      alreadyExisted = Boolean(existing);
    }
    const disabledReason = getWorkspacePromoteDisabledReason({
      memoryEnabled: true,
      isStandalone: false,
      effectiveArchived,
      isRoot,
      hasParent,
      scope: b.scope,
      alreadyExisted,
    });
    const canPromote = disabledReason === undefined;
    return {
      id: b.item.id,
      spaceId: b.spaceId,
      spaceName,
      content: b.item.content,
      preview,
      scope: b.scope,
      depth: b.depth,
      priority: b.priority,
      order: b.order,
      source: b.source,
      updatedAt: b.item.updatedAt,
      createdAt: b.item.createdAt,
      promotedFrom,
      canPromote,
      promoteDisabledReason: disabledReason,
    };
  });

  const grouped = {
    local: blocks.filter((b) => b.scope === "local"),
    inherited: blocks.filter((b) => b.scope === "inherited"),
    promoted: blocks.filter((b) => b.scope === "promoted"),
  };

  // Validate grouping order: local first, then inherited, then promoted? Actually flat is priority order.
  // But grouped order is fixed local/inherited/promoted as display requirement.
  return {
    currentSpaceId,
    currentSpaceName,
    parentId,
    parentName,
    isRoot,
    hasParent,
    isStandalone: false,
    memoryEnabled: true,
    effectiveArchived,
    ancestorChain: result.ancestorChain ?? [],
    blocks,
    grouped,
    totalCount: blocks.length,
  };
}

/**
 * Group order helper for UI: local -> inherited -> promoted (display order).
 * Blocks already sorted by priority; this is for section rendering.
 */
export function getWorkspaceViewGroupOrder(): Array<keyof WorkspaceSharedContextView["grouped"]> {
  return ["local", "inherited", "promoted"];
}
