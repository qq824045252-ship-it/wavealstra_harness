import type Database from "better-sqlite3";
import type { MemoryCandidateDto, MemoryRecordDto, MemoryRevisionDto, MemoryScopeType, MemoryTurnDto } from "../../shared/memory-kernel";
import { createHash } from "node:crypto";
import { memoryClauses, type MemoryForgetSource, type MemoryRemovalIntent } from "./MemoryIntent";

type Scope = { scopeType: MemoryScopeType; scopeId?: string };
type Target = { fingerprint: string; text_length: number; cutoff_at: number; allowed_message_id: string | null;
  value_fingerprint: string | null; guard_fingerprint: string | null; guard_length: number | null };
type Withdrawal = { kind: "selector" | "evidence"; value: string } | { kind: "fact"; value: string; identity: string };
const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
const textFingerprint = (text: string) => fingerprint((/^[a-z0-9]+$/i.test(text.normalize("NFKC").trim()) ? "word:" : "span:") + normalize(text));
const ADVANCE_IF_NEWER = `WHERE excluded.cutoff_at > cutoff_at OR (excluded.cutoff_at = cutoff_at
  AND (excluded.allowed_message_id IS NULL OR (allowed_message_id IS NOT NULL
    AND (SELECT ordinal FROM bot_messages WHERE message_id=excluded.allowed_message_id)
      >= (SELECT ordinal FROM bot_messages WHERE message_id=allowed_message_id))))`;

/** Source invalidation, not a second memory store: no forgotten content or history
 * deletion. Write invalidation in the same transaction as the corresponding removal. */
export class MemoryForgetWatermarks {
  constructor(private readonly db: Database.Database) {}

  withdrawRecord(record: MemoryRecordDto, revisions: readonly MemoryRevisionDto[], scopes: readonly Scope[],
    source?: MemoryForgetSource): void {
    const evidence = record.evidence.flatMap(item => {
      const quote = /^用户：([\s\S]*?)(?:\n助手：|$)/.exec(item.excerpt ?? "")?.[1] ?? item.excerpt ?? "";
      if (normalize(quote) === normalize(record.title) || revisions.some(revision => normalize(quote) === normalize(revision.title))) return [];
      const clauses = memoryClauses(quote);
      return clauses.length === 1 ? clauses : clauses.filter(clause => clause.includes(record.content));
    });
    // Whole multi-fact excerpts are not a deletion target. Minimal evidence and
    // historical revisions protect paraphrased atoms without withdrawing B.
    const facts: Withdrawal[] = [record, ...revisions].map(fact => ({ kind: "fact", value: fact.content, identity: fact.title }));
    this.persist(scopes, [...facts, ...evidence.map((value): Withdrawal => ({ kind: "evidence", value }))], source?.createdAt, source?.messageId);
    if (source) {
      const put = this.db.prepare(`INSERT OR IGNORE INTO memory_forget_receipts(scope_type,scope_id,source_message_id,request_fingerprint) VALUES (?,?,?,?)`);
      for (const scope of scopes) for (const clause of source.requestClauses ?? []) put.run(scope.scopeType, scope.scopeId ?? "", source.messageId, fingerprint(clause));
    }
  }

  recordIntent(scopes: readonly Scope[], intent: Extract<MemoryRemovalIntent, { kind: "forget" }>, cutoffAt: number, messageId: string): void {
    if (intent.all) { this.advance([...scopes], cutoffAt, messageId); return; }
    // The exact tool already bound this input to an atom. Do not later replace
    // that fact proof with its broad category wording during completion capture.
    if (scopes.some(scope => this.db.prepare(`SELECT 1 FROM memory_forget_receipts WHERE scope_type=? AND scope_id=?
      AND source_message_id=? AND request_fingerprint=?`).get(scope.scopeType, scope.scopeId ?? "", messageId, fingerprint(intent.clause)))) return;
    this.withdraw(scopes, [intent.target], cutoffAt, messageId);
  }

  /** Target evidence survives L1 deletion without retaining forgotten plaintext. */
  withdraw(scopes: readonly Scope[], texts: readonly string[], cutoffAt = Date.now(), allowedMessageId?: string): void {
    this.persist(scopes, texts.map(value => ({ kind: "selector", value })), cutoffAt, allowedMessageId);
  }

  private persist(scopes: readonly Scope[], proofs: readonly Withdrawal[], cutoffAt = Date.now(), allowedMessageId?: string): void {
    if (!Number.isFinite(cutoffAt) || cutoffAt < 0) throw new Error("遗忘来源时间无效");
    const put = this.db.prepare(`INSERT INTO memory_forget_targets(scope_type,scope_id,fingerprint,text_length,cutoff_at,allowed_message_id,value_fingerprint,guard_fingerprint,guard_length)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope_type,scope_id,fingerprint) DO UPDATE SET
      cutoff_at=excluded.cutoff_at,allowed_message_id=excluded.allowed_message_id ${ADVANCE_IF_NEWER}`);
    for (const proof of proofs) {
      const original = proof.value;
      const text = normalize(original);
      if (!text) continue;
      // Latin identifiers match complete words. Forgetting AI must not revoke
      // RainfallGauge, while CJK evidence can still occur inside a sentence.
      const valueHash = textFingerprint(original);
      const guardHash = proof.kind === "fact" ? textFingerprint(proof.identity) : null;
      const key = guardHash ? fingerprint(`${valueHash}:${guardHash}`) : valueHash;
      for (const scope of scopes) put.run(scope.scopeType, scope.scopeId ?? "", key, text.length, cutoffAt, allowedMessageId ?? null,
        valueHash, guardHash, proof.kind === "fact" ? normalize(proof.identity).length : null);
    }
  }

  private targets(scopes: readonly Scope[]): Target[] {
    return scopes.flatMap(scope => this.db.prepare(`SELECT fingerprint,text_length,cutoff_at,allowed_message_id,value_fingerprint,guard_fingerprint,guard_length
      FROM memory_forget_targets WHERE scope_type=? AND scope_id=?`).all(scope.scopeType, scope.scopeId ?? "") as Target[]);
  }

  private matches(text: string, targets: readonly Target[], createdAt: number, messageId?: string): boolean {
    const value = normalize(text);
    const words = new Map<number, Set<string>>();
    for (const word of text.normalize("NFKC").toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let hashes = words.get(word.length);
      if (!hashes) { hashes = new Set(); words.set(word.length, hashes); }
      hashes.add(fingerprint(`word:${word}`));
    }
    const spans = new Map<number, Set<string>>();
    const contains = (hash: string, length: number) => {
      if (words.get(length)?.has(hash)) return true;
      let hashes = spans.get(length);
      if (!hashes) {
        hashes = new Set();
        for (let start = 0; start + length <= value.length; start++) hashes.add(fingerprint(`span:${value.slice(start, start + length)}`));
        spans.set(length, hashes);
      }
      return hashes.has(hash);
    };
    return targets.some(target => !this.after(target, createdAt, messageId)
      && contains(target.value_fingerprint ?? target.fingerprint, target.text_length)
      && (!target.guard_fingerprint || target.guard_length !== null && contains(target.guard_fingerprint, target.guard_length)));
  }

  private after(boundary: Pick<Target, "cutoff_at" | "allowed_message_id">, createdAt: number, messageId?: string): boolean {
    if (createdAt > boundary.cutoff_at || (messageId && messageId === boundary.allowed_message_id)) return true;
    if (createdAt !== boundary.cutoff_at || !messageId || !boundary.allowed_message_id) return false;
    // ordinals are durable across conversations, unlike completion/capture order.
    const order = this.db.prepare(`SELECT (SELECT ordinal FROM bot_messages WHERE message_id=?) >
      (SELECT ordinal FROM bot_messages WHERE message_id=?) AS newer`).get(messageId, boundary.allowed_message_id) as { newer: number | null };
    return Boolean(order.newer);
  }

  /** Read original sources transiently, removing only affected evidence clauses.
   * An answer to a withdrawn user clause is not independent supporting evidence. */
  sourceFilter(scopes: readonly Scope[]) {
    const targets = this.targets(scopes);
    return (userText: string, assistantText: string, createdAt: number, messageId?: string) => {
      const keep = (text: string) => text.replace(/[^，,、。；;！!？?\n]+[，,、。；;！!？?\n]*/g,
        clause => this.matches(clause, targets, createdAt, messageId) ? "" : clause);
      const user = keep(userText);
      const changed = userText !== user;
      return { userText: user, assistantText: changed ? "" : keep(assistantText) };
    };
  }

  candidateSources(scopeType: MemoryScopeType, scopeId: string | undefined, turns: readonly MemoryTurnDto[], text: string): MemoryTurnDto[] {
    const targets = this.targets([{ scopeType, scopeId }]);
    return this.newerSources(scopeType, scopeId, turns).filter(turn => !this.matches(text, targets, turn.capturedAt, turn.userMessageId));
  }

  reviewSources(candidate: MemoryCandidateDto, turns: readonly MemoryTurnDto[]): MemoryTurnDto[] | undefined {
    const text = `${candidate.title}\n${candidate.content}`;
    const eligible = this.candidateSources(candidate.scopeType, candidate.scopeId, turns, text);
    if (turns.length && !eligible.length) return;
    if (!turns.length) {
      const boundary = this.db.prepare("SELECT cutoff_at,allowed_message_id FROM memory_forget_watermarks WHERE scope_type=? AND scope_id=?")
        .get(candidate.scopeType, candidate.scopeId ?? "") as Pick<Target, "cutoff_at" | "allowed_message_id"> | undefined;
      if ((boundary && !this.after(boundary, candidate.createdAt))
        || this.matches(text, this.targets([{ scopeType: candidate.scopeType, scopeId: candidate.scopeId }]), candidate.createdAt)) return;
    }
    let quote: unknown;
    try { quote = JSON.parse(candidate.rawJson ?? "{}").userEvidence; } catch { /* normal reconciliation validates evidence */ }
    if (typeof quote === "string" && quote.trim() && turns.some(turn => turn.userText.includes(quote))
      && !eligible.some(turn => turn.userText.includes(quote))) return;
    return eligible;
  }

  advance(scopes: Array<{ scopeType: MemoryScopeType; scopeId?: string }>, cutoffAt = Date.now(), allowedMessageId?: string): void {
    if (!Number.isFinite(cutoffAt) || cutoffAt < 0) throw new Error("遗忘来源时间无效");
    const put = this.db.prepare(`INSERT INTO memory_forget_watermarks(scope_type,scope_id,cutoff_at,allowed_message_id) VALUES (?,?,?,?)
      ON CONFLICT(scope_type,scope_id) DO UPDATE SET cutoff_at=excluded.cutoff_at,allowed_message_id=excluded.allowed_message_id
      ${ADVANCE_IF_NEWER}`);
    for (const scope of scopes) put.run(scope.scopeType, scope.scopeId ?? "", cutoffAt, allowedMessageId ?? null);
  }

  newerSources(scopeType: MemoryScopeType, scopeId: string | undefined, turns: readonly MemoryTurnDto[]): MemoryTurnDto[] {
    const row = this.db.prepare("SELECT cutoff_at,allowed_message_id FROM memory_forget_watermarks WHERE scope_type=? AND scope_id=?")
      .get(scopeType, scopeId ?? "") as { cutoff_at: number; allowed_message_id: string | null } | undefined;
    // A mixed forget-A/remember-B request may supply new B evidence in this exact
    // message. The evidence filter still rejects its forget/negative clauses.
    const filter = this.sourceFilter([{ scopeType, scopeId }]);
    return turns.filter(turn => !row || this.after(row, turn.capturedAt, turn.userMessageId))
      .map(turn => ({ ...turn, ...filter(turn.userText, turn.assistantText, turn.capturedAt, turn.userMessageId) }))
      .filter(turn => turn.userText.trim() || turn.assistantText.trim());
  }
}
