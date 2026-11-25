import { dotsRecordApplicability } from "../memory/DotsRevisionSource";
import { dotsEvidenceRange, dotsPreferenceQuote, dotsQueryTerms, type DotsUserQuote, type EvidenceRange } from "./DotsMemoryEvidence";
import { isGatewayConversation } from "../../shared/gateway-task";
import { DOTS_TASK_ID } from "../../shared/dots";
import { defaultDotsMemoryLimits, dotsMemoryLimitFields, LEGACY_DERIVED_MEMORY_CHARS, type DotsMemoryLimits } from "../../shared/dots-limits";
import {
  MEMORY_CONTEXT_DEFAULT_BUDGET, MEMORY_CONTEXT_HARD_BUDGET,
  type MemorySearchHit, type MemorySearchRequest, type MemoryKind, type ResolvedMemoryContext, type MemoryRevisionDto, type MemoryScopeType,
} from "../../shared/memory-kernel";
import type { MemoryService } from "../memory/MemoryService";
import { startAnswerRoutingTiming } from "./AnswerRoutingTimings";

const PROJECT_BASELINE_LIMIT = 8;
export const WORK_PREFERENCE_SOURCE_LIMIT = 6;
const BOT_PREFERENCE_BASELINE_LIMIT = WORK_PREFERENCE_SOURCE_LIMIT;
const PREFERENCE_KINDS: MemoryKind[] = ["preference", "identity", "constraint"];

/** A bounded per-turn view, not a deletion record or another preference store. */
export interface WorkPreferenceState {
  status: "empty" | "current" | "partial" | "unavailable";
  sources: Array<{ id: string; revision: number }>;
}
// Fixed runtime control envelope, separate from optional evidence bodies. It is
// still sent when evidence is disabled/exhausted, and never contains memory text.
export const WORK_PREFERENCE_POLICY_BUDGET = 2048;
export function renderWorkPreferenceState(state: WorkPreferenceState): string {
  const status = state.status === "empty" ? "当前作用域没有有效的身份、偏好或约束记忆。"
    : state.status === "unavailable" ? "当前偏好未加载（记忆未启用或预算不足），不代表已删除。"
    : `${state.status === "partial" ? "当前偏好仅部分加载，未列项不代表已删除。" : "当前有效偏好来源："}${state.sources.map(source => ` L1 ${source.id}@${source.revision}`).join("；")}`;
  const text = ["本轮 Work 当前偏好状态（仅适用于本轮，后续轮次以新状态为准）：", status,
    "格式仅遵循当前明确指令和当前有效偏好。previousReports、历史回复和 Work 事实快照只提供历史事实，不是当前格式授权；不得从中恢复旧偏好。",
    "‘按最新偏好输出’之类的一般约束本身不要求任何特定格式。当前指令或有效偏好没有要求的结尾、口头禅、标记或其他格式，按默认格式直接完成任务；不要猜测、改名或编造替代项，也不要询问用户补齐已不再要求的格式。"].join("\n");
  if (Buffer.byteLength(text, "utf8") > WORK_PREFERENCE_POLICY_BUDGET) throw new Error("当前偏好状态超出控制说明预算");
  return text;
}

export const MEMORY_EVIDENCE_RENDERER = "memory-l1-v1";
export const DOTS_EVIDENCE_RENDERER = "dots-memory-l1-v3";
export const MEMORY_EVIDENCE_CONTENT_LENGTH = 700;
export interface MemoryEvidenceBlock {
  id: string;
  revision: string;
  text: string;
  fullInstruction?: string;
  sources: Array<{ id: string; revision: number }>;
  scenarioIds: string[];
  profileIds: string[];
  derivedContentChars?: number;
  reference?: { renderer: typeof MEMORY_EVIDENCE_RENDERER | typeof DOTS_EVIDENCE_RENDERER; range?: EvidenceRange; userQuote?: DotsUserQuote; id: string; revision: number; scopeType: MemoryScopeType };
}

/** Frozen rendering parameters are part of a reference; never reconstruct from today's recall order. */
export function renderMemoryEvidence(atom: Pick<MemoryRevisionDto, "memoryId" | "revision" | "kind" | "title" | "content">, scopeType: MemoryScopeType, range?: EvidenceRange, userQuote?: string): string {
  const content=range ? (range.start>0 ? "…" : "")+atom.content.slice(range.start,range.end)+(range.end<atom.content.length ? "…" : "")
    : atom.content.slice(0,MEMORY_EVIDENCE_CONTENT_LENGTH);
  const heading = `- [L1 ${atom.memoryId}@${atom.revision}][${atom.kind}][${scopeType}] ${atom.title}`;
  if (range && userQuote && content === atom.content && userQuote.endsWith("：" + content)) {
    return `${heading} — ${content}\n上文为${userQuote.slice(0, -(content.length + 1))}。`;
  }
  const body = atom.content ? ` — ${content}` : "";
  const source = range && userQuote ? "\n" + userQuote : "";
  return heading + body + source;
}

export function renderDerivedMemoryEvidence(kind: "scenario" | "profile",
  view: { id: string; scopeType: MemoryScopeType; title: string; body: string },
  sources: MemoryEvidenceBlock["sources"],
  limit: number = LEGACY_DERIVED_MEMORY_CHARS[kind],
): string {
  const layer = kind === "profile" ? "L3" : "L2";
  const revisions = sources.map(({ id, revision }) => `${id}@${revision}`).join(",");
  return `- [${layer} derived:${view.id}][${view.scopeType}] ${view.title} — ${view.body.slice(0, limit)} (sources: ${revisions})`;
}

export interface ProjectedMemoryContext extends ResolvedMemoryContext {
  blocks: MemoryEvidenceBlock[];
  sourceRevisions: Array<{ id: string; revision: number }>;
  groundingScenarioIds: string[];
  currentPreferences?: WorkPreferenceState;
}

export function memoryProjectionQuery(input: MemorySearchRequest): MemorySearchRequest {
  return { ...input, statuses: input.statuses ?? ["active"], limit: Math.max(32, (input.limit ?? 16) * 3) };
}

type BaselineKind = "workPreferences" | "project" | "bot" | "shared" | "episode";
const BASELINE_KINDS: BaselineKind[] = ["workPreferences", "project", "bot", "shared", "episode"];
type MemoryContextBaselines = { version: number; hits: Partial<Record<BaselineKind, MemorySearchHit[]>> };

function baselineRequests(memory: MemoryService, input: MemorySearchRequest, workScope: boolean): Partial<Record<BaselineKind, MemorySearchRequest>> {
  const requests: Partial<Record<BaselineKind, MemorySearchRequest>> = {};
  const preferences = PREFERENCE_KINDS.filter(kind => !input.kinds?.length || input.kinds.includes(kind));
  const base: MemorySearchRequest = { ...input, query: undefined, statuses: ["active"] };
  if (workScope && preferences.length) {
    requests.workPreferences = { ...base, kinds: preferences, limit: BOT_PREFERENCE_BASELINE_LIMIT + 1 };
  }
  if (!input.query?.trim()) return requests;
  if (input.projectId || input.taskId) {
    requests.project = { ...base, scopeTypes: ["project"], limit: PROJECT_BASELINE_LIMIT };
  }
  if (preferences.length) {
    const preferenceQuery = { ...base, kinds: preferences, limit: BOT_PREFERENCE_BASELINE_LIMIT };
    if (memory.allowsPersonalBotBaseline(input)) requests.bot = { ...preferenceQuery, scopeTypes: ["bot"] };
    const includesTask = input.taskId === DOTS_TASK_ID || Boolean(input.taskId && isGatewayConversation(input.taskId));
    requests.shared = { ...preferenceQuery, scopeTypes: includesTask ? ["task", "team", "global"] : ["team", "global"] };
  }
  requests.episode = { ...base, scopeTypes: ["conversation", "work"], limit: 6 };
  return requests;
}

export async function readMemoryContextBaselines(memory: MemoryService, input: MemorySearchRequest): Promise<MemoryContextBaselines | undefined> {
  const requests = baselineRequests(memory, input, memory.resolveScopeChain(input).some(scope => scope.scopeType === "work"));
  const kinds = BASELINE_KINDS.filter(kind => requests[kind] !== undefined);
  const candidates = await memory.searchBaselines(kinds.map(kind => requests[kind]!));
  return candidates && { version: candidates.version, hits: Object.fromEntries(kinds.map((kind, index) => [kind, candidates.hits[index]])) };
}

/** Stateless selection/serialization. Memory repositories own facts and grounding. */
export function projectMemoryContext(
  memory: MemoryService,
  input: MemorySearchRequest & { budgetChars?: number; trackRecall?: boolean; dotsLimits?: DotsMemoryLimits },
  recalled?: MemorySearchHit[],
  delegatedSources: Array<{ id: string; revision: number }> = [],
  baselines?: MemoryContextBaselines,
): ProjectedMemoryContext {
  const isDots = input.taskId === DOTS_TASK_ID;
  const dotsLimits = isDots ? input.dotsLimits ?? defaultDotsMemoryLimits : undefined;
  const budget = Math.max(0, Math.min(MEMORY_CONTEXT_HARD_BUDGET, dotsLimits?.contextBytes ?? Infinity,
    input.budgetChars ?? MEMORY_CONTEXT_DEFAULT_BUDGET));
  const result: ProjectedMemoryContext = {
    items: [], text: "", query: input.query?.trim() ?? "", budgetChars: budget,
    includedChars: 0, trimmed: false, scenarioIds: [], profileIds: [],
    blocks: [], sourceRevisions: [], groundingScenarioIds: [],
  };
  if (!budget) return result;
  const header = isDots
    ? "历史记忆证据：L1 是事实来源，L2/L3 是仍有依据的派生视图；本轮明确指令优先。明确提及项目或工作空间时，先应用该范围的例外，再采用其他默认偏好。"
    : "历史记忆证据：L1 是事实来源，L2/L3 是经审批且仍有依据的派生视图；本轮明确指令优先。";
  const optionalDotsViews: MemoryEvidenceBlock[] = [];
  const lines: string[] = [];
  // UTF-8 byte budget is conservative for tokens, including labels and separators.
  let bytes = Buffer.byteLength(header + "\n", "utf8");
  const push = (line: string): boolean => {
    const size = Buffer.byteLength(line + "\n", "utf8");
    if (bytes + size > budget) { result.trimmed = true; return false; }
    lines.push(line);
    bytes += size;
    return true;
  };
  const chain = memory.resolveScopeChain(input);
  const workScope = chain.some(scope => scope.scopeType === "work");
  const requests = baselineRequests(memory, input, workScope);
  const baseline = (kind: BaselineKind) => {
    const request = requests[kind];
    if (!request) return [];
    if (baselines && baselines.hits[kind] && memory.isCurrentBaselineVersion(baselines.version)) return baselines.hits[kind];
    return memory.search(request);
  };
  // Use the same authoritative Work/Bot scope for derived views and L1 recall.
  // Passing taskId here would let cognition fall back to unrelated UI task metadata.
  const sources = memory.cognition.getContextSources({
    taskId: isDots && chain.some(scope => scope.scopeType === "task" && scope.scopeId === DOTS_TASK_ID)
      ? DOTS_TASK_ID : undefined,
    projectId: chain.find(scope => scope.scopeType === "project")?.scopeId,
    workspaceId: chain.find(scope => scope.scopeType === "workspace")?.scopeId,
  });
  const allowedScopes = new Set(chain.map(scope => `${scope.scopeType}:${scope.scopeId ?? ""}`));
  const now = Date.now();
  const visibility = new Map<string, boolean>();
  const overriddenDefaults = new Set<string>();
  const visible = (id: string): boolean => {
    if (overriddenDefaults.has(id)) return false;
    const previous = visibility.get(id);
    if (previous !== undefined) return previous;
    const atom = memory.get(id);
    const current = atom?.status === "active" && memory.canAccess(id, input)
      && (atom.validFrom === undefined || atom.validFrom <= now)
      && (atom.validUntil === undefined || atom.validUntil > now);
    visibility.set(id, current);
    return current;
  };
  // Only current typed L1 atoms may authorize inherited formatting. Query-free
  // lookup is bounded and scope-checked; historical progress snapshots never qualify.
  const workPreferences = workScope ? baseline("workPreferences").filter(hit => visible(hit.memory.id)
    && PREFERENCE_KINDS.includes(hit.memory.kind)) : undefined;
  const preferenceIds = new Set(workPreferences?.slice(0, BOT_PREFERENCE_BASELINE_LIMIT).map(hit => hit.memory.id));
  const finishSearch = recalled ? undefined : startAnswerRoutingTiming("memorySearch");
  const queryHits = recalled ? recalled.flatMap(hit => {
    const current = memory.get(hit.memory.id);
    return current?.contentHash === hit.memory.contentHash
      ? [{ ...hit, memory: { ...hit.memory, metadata: current.metadata } }] : [];
  }) : memory.search(memoryProjectionQuery(input));
  finishSearch?.(() => ({ method: "lexical", outcome: "completed",
    resultCount: queryHits.length, returnedMemoryIds: queryHits.map(hit => hit.memory.id) }));
  const exceptionHits = isDots ? queryHits.filter(hit => memory.dotsExceptionApplies(hit.memory, input) && visible(hit.memory.id)) : [];
  for (const { memory: exception } of exceptionHits) {
    const defaultId = exception.metadata.dotsOverrides;
    if (typeof defaultId === "string" && defaultId !== exception.id) overriddenDefaults.add(defaultId);
  }
  const scenarios = sources.scenarios.filter((scenario) => allowedScopes.has(`${scenario.scopeType}:${scenario.scopeId ?? ""}`)
    && scenario.sourceMemoryIds.length > 0 && scenario.sourceMemoryIds.every(visible));
  const byScenario = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const coveredAtoms = new Set<string>();
  const coveredScenarios = new Set<string>();
  const versionById = new Map<string, number>();
  const latestRevision = (id: string) => {
    const known = versionById.get(id);
    if (known !== undefined) return known;
    const revision = memory.history(id)[0]?.revision ?? 0;
    versionById.set(id, revision);
    return revision;
  };
  const sourceVersions = (ids: string[]) => ids.map(id => ({ id, revision: latestRevision(id) }));
  const revisions = (sources: MemoryEvidenceBlock["sources"]) => sources.map(({ id, revision }) => `${id}@${revision}`).join(",");
  const derivedLimit = (kind: "scenario" | "profile", body: string) => {
    const configured = dotsLimits?.[kind === "scenario" ? "scenarioChars" : "profileChars"];
    if (configured === undefined) return undefined;
    const selected = Math.min(configured, body.length);
    return selected === Math.min(LEGACY_DERIVED_MEMORY_CHARS[kind], body.length) ? undefined : selected;
  };
  // Only use a derived view if all of its grounding remains visible. Deduplication
  // follows source IDs, never similarity or untraceable paraphrase heuristics.
  for (const profile of sources.profiles) {
    if (dotsLimits?.profileChars === 0) break;
    if (!allowedScopes.has(`${profile.scopeType}:${profile.scopeId ?? ""}`)) continue;
    if (!profile.sourceScenarioIds.every((id) => byScenario.has(id))) continue;
    const atomIds = [...new Set(profile.sourceScenarioIds.flatMap((id) => byScenario.get(id)!.sourceMemoryIds))];
    if (!atomIds.length || atomIds.every((id) => coveredAtoms.has(id))) continue;
    const grounding = sourceVersions(atomIds);
    const derivedContentChars = derivedLimit("profile", profile.content);
    const line = renderDerivedMemoryEvidence("profile", { ...profile, body: profile.content }, grounding, derivedContentChars);
    const block = { id: `profile:${profile.id}`, revision: revisions(grounding), text: line,
      sources: grounding, scenarioIds: [...profile.sourceScenarioIds], profileIds: [profile.id], derivedContentChars };
    if (isDots) {
      optionalDotsViews.push(block);
      continue;
    }
    if (push(line)) {
      result.blocks.push(block);
      result.profileIds!.push(profile.id);
      profile.sourceScenarioIds.forEach((id) => coveredScenarios.add(id));
      atomIds.forEach((id) => coveredAtoms.add(id));
    }
  }
  const queried = queryHits.filter(hit => visible(hit.memory.id) && (!isDots || !dotsRecordApplicability(hit.memory)));
  // Shared project cognition is a baseline for every bound task, not only for lexically similar prompts.
  const queriedIds = new Set(queried.map((hit) => hit.memory.id));
  const projectBaseline = baseline("project").filter(hit => !queriedIds.has(hit.memory.id) && visible(hit.memory.id));
  // Language, units and formatting preferences apply even to an unrelated Work query.
  // Keep this bounded, current and personal; unrelated facts still require query recall.
  const botBaseline = baseline("bot").filter(hit => visible(hit.memory.id));
  // Stable shared preferences and the current episode survive unrelated follow-up wording.
  // Scope-chain filtering still owns visibility; this does not expand ownership.
  const sharedBaseline = baseline("shared").filter(hit => visible(hit.memory.id) && (!isDots || !dotsRecordApplicability(hit.memory)));
  const episodeBaseline = baseline("episode").filter(hit => visible(hit.memory.id));
  const hits = [...exceptionHits, ...(workPreferences?.slice(0, BOT_PREFERENCE_BASELINE_LIMIT) ?? []), ...botBaseline, ...sharedBaseline, ...episodeBaseline, ...queried, ...projectBaseline];
  const relevantIds = queriedIds;
  for (const scenario of scenarios) {
    if (dotsLimits?.scenarioChars === 0) break;
    if (coveredScenarios.has(scenario.id)) continue;
    if (input.query?.trim() && !scenario.sourceMemoryIds.some((id) => relevantIds.has(id))) continue;
    if (scenario.sourceMemoryIds.every((id) => coveredAtoms.has(id))) continue;
    const grounding = sourceVersions(scenario.sourceMemoryIds);
    const derivedContentChars = derivedLimit("scenario", scenario.summary);
    const line = renderDerivedMemoryEvidence("scenario", { ...scenario, body: scenario.summary }, grounding, derivedContentChars);
    const block = { id: `scenario:${scenario.id}`, revision: revisions(grounding), text: line,
      sources: grounding, scenarioIds: [scenario.id], profileIds: [], derivedContentChars };
    if (isDots) {
      optionalDotsViews.push(block);
      continue;
    }
    if (push(line)) {
      result.blocks.push(block);
      result.scenarioIds!.push(scenario.id);
      coveredScenarios.add(scenario.id);
      scenario.sourceMemoryIds.forEach((id) => coveredAtoms.add(id));
    }
  }
  const delegatedHits: MemorySearchHit[] = [];
  for (const { id, revision } of delegatedSources.slice(0, 8)) {
    const record = input.taskId && memory.currentDelegationSource(input.taskId, id, revision);
    if (!record || !visible(id)) continue;
    delegatedHits.push({ memory: record, score: 1, reasons: ["dots-delegation"], scopeDistance: 0 });
  }
  const decorated = [...delegatedHits, ...hits].map((hit) => ({ hit, scope: memory.bestMatchedScope(hit.memory, chain) }));
  const picked = new Set<string>();
  const ordered: typeof decorated = [];
  const add = (entry: typeof decorated[number]) => {
    if (picked.has(entry.hit.memory.id) || (coveredAtoms.has(entry.hit.memory.id) && !preferenceIds.has(entry.hit.memory.id))) return;
    picked.add(entry.hit.memory.id);
    ordered.push(entry);
  };
  decorated.filter(entry => entry.hit.reasons.includes("dots-delegation")).forEach(add);
  decorated.filter(entry => preferenceIds.has(entry.hit.memory.id)).forEach(add);
  for (const scope of isDots ? [] : chain) {
    const first = decorated.find((entry) => entry.scope.scopeType === scope.scopeType && entry.scope.scopeId === scope.scopeId);
    if (first) add(first);
  }
  decorated.forEach(add);
  const terms = isDots ? dotsQueryTerms(input.query ?? "") : [];
  for (const { hit, scope } of ordered) {
    if (result.items.length >= (input.limit ?? dotsLimits?.entries ?? 16)) { result.trimmed = true; break; }
    const atom = hit.memory;
    const revision = latestRevision(atom.id);
    const snapshot = { ...atom, memoryId: atom.id, revision };
    // A few complete source passages retain list entries, dates and corrections.
    // Further candidates share the remaining capacity with query-centred excerpts.
    let range: EvidenceRange | undefined;
    if (dotsLimits) {
      const overhead=Buffer.byteLength(renderMemoryEvidence({...snapshot,content:""},scope.scopeType))+16;
      const remaining=budget-bytes-overhead;
      const cap = Math.min(remaining, result.items.length < dotsLimits.extendedEntries ? dotsLimits.extendedBytes : dotsLimits.excerptBytes);
      if (cap < dotsMemoryLimitFields.excerptBytes.min) { result.trimmed = true; continue; }
      range=dotsEvidenceRange(atom.content,terms,cap);
    }
    const quote = dotsLimits ? dotsPreferenceQuote(memory, atom, revision, dotsLimits.quoteBytes) : undefined;
    const plain=renderMemoryEvidence(snapshot,scope.scopeType,range);
    const quoted=quote ? renderMemoryEvidence(snapshot,scope.scopeType,range,quote.text) : undefined;
    const useQuote=quoted!==undefined && bytes+Buffer.byteLength(quoted+"\n")<=budget;
    const text=useQuote ? quoted! : plain;
    if (!push(text)) continue;
    result.blocks.push({ id: `memory:${atom.id}`, revision: String(revision), text,
      fullInstruction: atom.content.length <= MEMORY_EVIDENCE_CONTENT_LENGTH && (!range || (range.start===0 && range.end===atom.content.length)) ? atom.content : undefined,
      sources: [{ id: atom.id, revision }], scenarioIds: [], profileIds: [],
      reference: { renderer: range ? DOTS_EVIDENCE_RENDERER : MEMORY_EVIDENCE_RENDERER, ...(range ? {range} : {}), ...(useQuote ? {userQuote:quote!.ref} : {}), id: atom.id, revision, scopeType: scope.scopeType } });
    result.items.push({ id: atom.id, kind: atom.kind, title: atom.title, content: atom.content,
      scopeType: scope.scopeType, scopeId: scope.scopeId, importance: atom.importance, confidence: atom.confidence,
      score: hit.score, reasons: hit.reasons });
  }
  for (const block of optionalDotsViews) {
    if (!push(block.text)) continue;
    result.blocks.push(block);
    result.profileIds!.push(...block.profileIds);
    if (!block.profileIds.length) result.scenarioIds!.push(...block.scenarioIds);
    block.scenarioIds.forEach(id => coveredScenarios.add(id));
    block.sources.forEach(({ id }) => coveredAtoms.add(id));
  }
  if (lines.length) result.text = [header, ...lines].join("\n");
  result.includedChars = result.text.length;
  const sourceIds = [...new Set([...coveredAtoms, ...result.items.map((item) => item.id)])];
  result.sourceRevisions = sourceVersions(sourceIds);
  result.groundingScenarioIds = [...coveredScenarios];
  if (workPreferences) {
    const currentSources = result.sourceRevisions.filter(source => preferenceIds.has(source.id)
      && result.items.some(item => item.id === source.id));
    const filtered = input.kinds?.length && !PREFERENCE_KINDS.every(kind => input.kinds!.includes(kind));
    result.currentPreferences = { status: filtered ? "partial" : workPreferences.length === 0 ? "empty"
      : workPreferences.length > currentSources.length ? "partial" : "current", sources: currentSources };
  }
  if (input.trackRecall !== false) memory.noteContextRecall(sourceIds);
  return result;
}

/** Current task ownership only. A removed workspace must not fall back to session creation metadata. */
export function resolveTaskMemoryScope(taskId: string, task: { projectId?: string | null; spaceId?: string | null } | undefined) {
  return { taskId, projectId: task?.projectId ?? undefined, workspaceId: task?.spaceId ?? undefined };
}
