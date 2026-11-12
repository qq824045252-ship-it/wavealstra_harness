import type Database from "better-sqlite3";
import type { MemoryRecordDto, MemoryScopeType, MemoryEvidenceDto } from "../../shared/memory-kernel";
import { MEMORY_SCOPE_TYPES } from "../../shared/memory-kernel";
import { MemoryForgetWatermarks } from "./MemoryForgetWatermarks";
import { createHash } from "node:crypto";

type Scope = { scopeType: MemoryScopeType; scopeId?: string };
type Dependency = { id: string; hash: string; scopes: Scope[]; evidence?: Array<{ id: string; hash: string }> };
type Lineage = { version: 1; records: Dependency[]; sourceMessageIds: string[]; sourceHashes?: Record<string, string>; incomplete?: boolean };
export const recallSourceHash = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (raw?: string) => { try { return JSON.parse(raw ?? "{}") as Record<string, unknown>; } catch { return {}; } };
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** Host-observed dependency identities, not another copy of memory content.
 * Runs own in-flight dependencies; L0 retains them after completion/restart. */
export class MemoryRecallLineage {
  constructor(private readonly db: Database.Database) {}

  snapshot(assistantId: string): Lineage | undefined {
    const run = this.db.prepare("SELECT context_json FROM bot_request_runs WHERE message_id=?").get(assistantId) as { context_json: string } | undefined;
    const turn = this.db.prepare("SELECT metadata_json FROM memory_turns WHERE assistant_message_id=?").get(assistantId) as { metadata_json: string } | undefined;
    const context = object(run?.context_json);
    const saved = (context.memoryRecallDependencies ?? object(turn?.metadata_json).memoryRecallDependencies) as Partial<Lineage> | undefined;
    const sources = [...new Set([...strings(context.sourceMessageIds), ...strings(saved?.sourceMessageIds)])];
    if (!run && !saved) return;
    const valid = (value: unknown): value is Dependency => {
      if (!value || typeof value !== "object") return false;
      const d = value as Dependency;
      return typeof d.id === "string" && Boolean(d.id) && typeof d.hash === "string" && Boolean(d.hash)
        && Array.isArray(d.scopes) && d.scopes.length > 0 && d.scopes.every(scope => scope && MEMORY_SCOPE_TYPES.includes(scope.scopeType)
          && (scope.scopeId === undefined || typeof scope.scopeId === "string"))
        && (d.evidence === undefined || Array.isArray(d.evidence) && d.evidence.every(item => item && typeof item.id === "string" && typeof item.hash === "string"));
    };
    const records = Array.isArray(saved?.records) ? saved.records.filter(valid) : [];
    const hashes = saved?.sourceHashes && typeof saved.sourceHashes === "object" && !Array.isArray(saved.sourceHashes)
      ? Object.fromEntries(Object.entries(saved.sourceHashes).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
    const incomplete = Boolean(saved && (saved.version !== 1 || !Array.isArray(saved.records) || records.length !== saved.records.length || saved.incomplete));
    return { version: 1, records, sourceMessageIds: sources, sourceHashes: hashes, incomplete };
  }

  record(assistantId: string, records: readonly MemoryRecordDto[] = [], sourceMessageIds: readonly string[] = [], sourceHashes: Record<string, string> = {}): void {
    const old = this.snapshot(assistantId) ?? { version: 1 as const, records: [], sourceMessageIds: [] };
    const byIdentity = new Map(old.records.map(record => [JSON.stringify(record), record]));
    for (const record of records) {
      const dependency: Dependency = { id: record.id, hash: record.contentHash,
        scopes: record.scopes.map(({ scopeType, scopeId }) => ({ scopeType, scopeId })),
        evidence: record.evidence.map(item => ({ id: item.id, hash: recallSourceHash(JSON.stringify([item.excerpt ?? null, item.refTitle ?? null])) })) };
      // Retain every distinct actually consumed projection, including a broader
      // excerpt read before a later withdrawal in this same running response.
      byIdentity.set(JSON.stringify(dependency), dependency);
    }
    const hashes = { ...old.sourceHashes };
    for (const [id, hash] of Object.entries(sourceHashes)) {
      if (!old.sourceMessageIds.includes(id)) hashes[id] = hash;
      else if (hashes[id] !== hash) delete hashes[id]; // Never erase a previously consumed raw/older dependency.
    }
    const value: Lineage = { version: 1, records: [...byIdentity.values()], sourceMessageIds: [...new Set([...old.sourceMessageIds, ...sourceMessageIds])].filter(id => id !== assistantId), sourceHashes: hashes, incomplete: old.incomplete };
    const json = JSON.stringify(value);
    this.db.prepare("UPDATE bot_request_runs SET context_json=json_set(context_json,'$.memoryRecallDependencies',json(?)) WHERE message_id=?").run(json, assistantId);
    this.db.prepare("UPDATE memory_turns SET metadata_json=json_set(metadata_json,'$.memoryRecallDependencies',json(?)) WHERE assistant_message_id=?").run(json, assistantId);
  }

  /** Only the dependent assistant quote is withheld. User evidence is projected
   * independently; unrelated B and other answers remain eligible. Unknown legacy
   * provenance is not reconstructed by guessing or disabling a whole scope. */
  assistantRevoked(assistantId: string, scopes: readonly Scope[]): boolean {
    return this.projection(scopes)(assistantId);
  }

  /** One synchronous projection batch only; never reuse after writes or awaits. */
  projection(scopes: readonly Scope[]): (assistantId: string) => boolean {
    const memo = new Map<string, boolean>();
    const visiting = new Set<string>();
    const recordMemo = new Map<string, boolean>();
    const withdrawals = new MemoryForgetWatermarks(this.db);
    const evaluate = (id: string, hash?: string): boolean => {
      const key = id + ":" + (hash ?? "raw");
      if (memo.has(key)) return memo.get(key)!;
      // Fail closed for this derived quote only, not the scope's original sources.
      if (visiting.has(key) || visiting.size >= 512 || memo.size >= 10000) return true;
      visiting.add(key);
      const done = (result: boolean) => { visiting.delete(key); memo.set(key, result); return result; };
      const message = this.db.prepare("SELECT role,text,created_at,conversation_id FROM bot_messages WHERE message_id=?").get(id) as
        { role: string; text: string; created_at: number; conversation_id: string } | undefined;
      if (message?.role === "user") {
        const currentScopes = [...scopes.filter(scope => scope.scopeType !== "conversation"), { scopeType: "conversation" as const, scopeId: message.conversation_id }];
        const safe = withdrawals.sourceFilter(currentScopes)(message.text, "", message.created_at, id).userText;
        return done(hash ? recallSourceHash(safe) !== hash : safe !== message.text);
      }
      const lineage = this.snapshot(id);
      if (!lineage) return done(false);
      if (lineage.incomplete) return done(true);
      for (const dependency of lineage.records) {
        const recordKey = JSON.stringify(dependency);
        if (recordMemo.has(recordKey)) { if (recordMemo.get(recordKey)) return done(true); else continue; }
        const record = this.db.prepare("SELECT content_hash,status,valid_until FROM memory_records WHERE id=?").get(dependency.id) as
          { content_hash: string; status: string; valid_until: number | null } | undefined;
        const revoked = !record || record.content_hash !== dependency.hash || record.status !== "active"
          || record.valid_until !== null && record.valid_until <= Date.now()
          || !dependency.scopes.some(scope => this.db.prepare("SELECT 1 FROM memory_scopes WHERE memory_id=? AND scope_type=? AND COALESCE(scope_id,'')=?")
            .get(dependency.id, scope.scopeType, scope.scopeId ?? ""));
        recordMemo.set(recordKey, revoked);
        if (revoked) return done(true);
        if (dependency.evidence?.length) {
          const evidence = this.db.prepare("SELECT id,memory_id memoryId,evidence_kind evidenceKind,ref_id refId,ref_title refTitle,excerpt,created_at createdAt FROM memory_evidence WHERE memory_id=?")
            .all(dependency.id) as MemoryEvidenceDto[];
          const safe = withdrawals.projectEvidence({ evidence } as MemoryRecordDto, dependency.scopes).evidence;
          if (dependency.evidence.some(item => !safe.some(current => current.id === item.id
            && recallSourceHash(JSON.stringify([current.excerpt ?? null, current.refTitle ?? null])) === item.hash))) {
            recordMemo.set(recordKey, true); return done(true);
          }
        }
      }
      return done(lineage.sourceMessageIds.some(sourceId => evaluate(sourceId, lineage.sourceHashes?.[sourceId])));
    };
    return id => evaluate(id);
  }
}
