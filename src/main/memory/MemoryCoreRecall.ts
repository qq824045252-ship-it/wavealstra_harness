import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryRecordDto, MemorySearchHit, MemorySearchRequest } from "../../shared/memory-kernel";
import { isGatewayBotTaskId, isGatewayConversation } from "../../shared/gateway-task";
import { readCoreRecallAuthority, type CoreMemoryRecallAuthority } from "./AssistantMemoryScopes";
import { memoryRecordFromWire } from "./MemoryRecordsData";
import { rankMemoryBaselines, rankMemorySearchAsync } from "./MemoryRecallRanking";
import { memoryListScopeWhere, memorySearchWhere } from "./MemorySearchScope";
import { buildMemoryFtsQuery, normalizeSearchText } from "./MemorySearchText";

export class CoreMemoryRecallUnavailable extends Error {}

export interface CoreMemoryRecallAtom {
  memory: MemoryRecordDto;
  revision: number;
}

export function coreRecallVisible(memory: MemoryRecordDto, authority: CoreMemoryRecallAuthority, request: MemorySearchRequest): boolean {
  if (memory.id.startsWith("mem_weekly_") || memory.metadata.dotsPrivateGateway === true || (memory.sourceTaskId && (isGatewayConversation(memory.sourceTaskId)
    || isGatewayBotTaskId(memory.sourceTaskId) || memory.sourceTaskId.startsWith("gw-")))) return false;
  if (!memory.explicit && memory.sourceType === "agent" && memory.sourceId && ["fact", "constraint", "decision"].includes(memory.kind)
    && memory.scopes.some(scope => ["bot", "team", "global"].includes(scope.scopeType))) return false;
  return memory.scopes.some(scope => authority.scopes.some(allowed => scope.scopeType === allowed.scopeType
    && scope.scopeId === allowed.scopeId)) && (!request.kinds?.length || request.kinds.includes(memory.kind));
}

export async function readCoreRecallAtom(db: AppDatabase, id: string, request: MemorySearchRequest,
  authority: CoreMemoryRecallAuthority): Promise<CoreMemoryRecallAtom | undefined> {
  const detail = await db.runtimeAuditReader?.memoryRecordsData({ kind: "detail", id });
  if (detail?.kind !== "detail") throw new CoreMemoryRecallUnavailable("Core 未确认记忆内容读取");
  if (!detail.record) return;
  if (typeof detail.revision !== "number" || !Number.isSafeInteger(detail.revision) || detail.revision < 1) {
    throw new CoreMemoryRecallUnavailable("Core 未确认记忆版本");
  }
  const memory = memoryRecordFromWire(detail.record);
  if (!coreRecallVisible(memory, authority, request)) return;
  // The original evidence excerpts require withdrawal-aware projection before disclosure.
  return { memory: { ...memory, evidence: [] }, revision: detail.revision };
}

async function readAtomMap(db: AppDatabase, ids: readonly string[], request: MemorySearchRequest, authority: CoreMemoryRecallAuthority) {
  const atoms = new Map<string, MemoryRecordDto>();
  const distinct = [...new Set(ids)];
  for (let index = 0; index < distinct.length; index += 8) {
    const page = await Promise.all(distinct.slice(index, index + 8).map(id => readCoreRecallAtom(db, id, request, authority)));
    for (const atom of page) if (atom) atoms.set(atom.memory.id, atom.memory);
  }
  return atoms;
}

export async function searchCoreMemory(db: AppDatabase, request: MemorySearchRequest,
  authority: CoreMemoryRecallAuthority): Promise<MemorySearchHit[]> {
  const reader = db.runtimeAuditReader;
  if (!reader || !db.isOpen) throw new CoreMemoryRecallUnavailable("Core 记忆查询连接不可用");
  if (!authority.scopes.length) return [];
  const query = request.query?.trim() ?? "";
  const limit = Math.max(1, Math.min(100, Math.trunc(request.limit || 20)));
  const maxCandidates = Math.max(limit * 4, 100);
  const statuses = request.statuses?.length ? request.statuses : ["active" as const];
  const scope = { scopes: authority.scopes, statuses, kinds: request.kinds };

  let hits: MemorySearchHit[];
  if (!query) {
    const rows = (await reader.memoryBaselines([{ scope: memoryListScopeWhere(scope), limit: maxCandidates }]))?.[0];
    if (!rows) throw new CoreMemoryRecallUnavailable("Core 未确认记忆基线读取");
    const atoms = await readAtomMap(db, rows.map(row => row.id), request, authority);
    hits = rankMemoryBaselines(rows, authority.scopes, limit, id => atoms.get(id), () => true);
  } else {
    const normalized = query.normalize("NFKC").toLowerCase();
    const compact = normalizeSearchText(normalized);
    if (!compact) return [];
    const terms = new Set((normalized.match(/[\p{L}\p{N}_+.-]+/gu) ?? []).slice(0, 32).map(normalizeSearchText).filter(Boolean));
    const step = Math.max(1, (compact.length - 1) / 64);
    for (let i = 0; i < compact.length - 1; i += step) terms.add(compact.slice(Math.floor(i), Math.floor(i) + 2));
    const searchScope = memorySearchWhere(scope);
    const candidates = await reader.memoryLexical({ scope: searchScope, compact, terms: [...terms],
      ftsQuery: buildMemoryFtsQuery(query), exactIdentifier: false });
    if (!candidates) throw new CoreMemoryRecallUnavailable("Core 未确认记忆词法搜索");
    const lexical = candidates.lexical.sort((a, b) => b.exact - a.exact || b.relevance - a.relevance || b.importance - a.importance
      || b.updated_at - a.updated_at || a.id.localeCompare(b.id)).slice(0, maxCandidates);
    const lexicalById = new Map(lexical.map(match => [match.id, match]));
    const fts = candidates.fts.slice(0, maxCandidates);
    const atoms = await readAtomMap(db, [...fts, ...lexicalById.keys()], request, authority);
    const scoped = [...atoms.values()].flatMap(memory => {
      const match = lexicalById.get(memory.id);
      if (!statuses.includes(memory.status) || (match && match.content_hash !== memory.contentHash)) return [];
      return memory.scopes.filter(binding => authority.scopes.some(allowed => allowed.scopeType === binding.scopeType
        && allowed.scopeId === binding.scopeId)).map(binding => ({ ...binding, memory }));
    });
    const scores = scoped.length ? await reader.memoryLexicalScores({ scope: searchScope, compact,
      targets: [...atoms.values()].map(({ id, contentHash }) => ({ id, contentHash })) }) : undefined;
    hits = await rankMemorySearchAsync({ scoped, ftsRank: new Map(fts.map((id, index) => [id, index + 1])), query,
      textScores: scores && new Map(scores.map(({ id, similarity }) => [id, similarity])),
      request: { ...request, limit }, scopes: authority.scopes, visible: () => true, current: id => atoms.get(id) });
  }
  const refreshed = await readAtomMap(db, hits.map(hit => hit.memory.id), request, authority);
  const current = await readCoreRecallAuthority(db, request);
  if (current?.witness !== authority.witness || JSON.stringify(current.scopes) !== JSON.stringify(authority.scopes)) {
    throw new CoreMemoryRecallUnavailable("记忆读取期间任务的可见范围已变化");
  }
  const now = Date.now();
  return hits.flatMap(hit => {
    const memory = refreshed.get(hit.memory.id);
    if (!memory || memory.contentHash !== hit.memory.contentHash || memory.status !== hit.memory.status
      || (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)
        || (memory.validUntil !== undefined && memory.validUntil <= now)))) return [];
    return [{ ...hit, memory }];
  });
}
