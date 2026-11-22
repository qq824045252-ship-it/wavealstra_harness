import { isDotsSearch, searchEpoch } from "./MemorySearchEpoch";
import type Database from "better-sqlite3";
import { setImmediate as yieldThread } from "node:timers/promises";
import type { MemoryRecordDto } from "../../shared/memory-kernel";
import type { MemoryRepository } from "./MemoryRepository";
import { memorySearchWhere, type MemorySearchScope } from "./MemorySearchScope";
import { buildMemoryFtsQuery, normalizeSearchText } from "./MemorySearchText";
import { dotsQuestionTerms } from "./DotsRecallRanking";

type Row = { id: string; title: string; content: string; content_hash: string; importance: number; updated_at: number };
// Exact postings for alphanumeric bigrams. Each row occupies 164 bytes and CJK
// or punctuation still uses the full normalized strings.
const gramStride = 41;
function letter(code: number): number {
  if (code >= 97 && code <= 122) return code - 97;
  return code >= 48 && code <= 57 ? code - 48 + 26 : -1;
}
function gram(text: string, i: number): number {
  const a = letter(text.charCodeAt(i)), b = letter(text.charCodeAt(i+1));
  return a < 0 || b < 0 ? -1 : a*36+b;
}
type IndexedRow = Row & { normalized?: true; postings?: Uint32Array; offset?: number; ascii?: boolean };
const textIndex = new WeakMap<Database.Database, { key: string; version: number; validUntil: number; pages: IndexedRow[][] }>();
type Ranked = { row: Row; exact: number; relevance: number; memory: MemoryRecordDto };
const compare = (a: Ranked, b: Ranked) => b.exact - a.exact || b.relevance - a.relevance
  || b.row.importance - a.row.importance || b.row.updated_at - a.row.updated_at || a.row.id.localeCompare(b.row.id);

/** Keyset pages are fully read before yielding. No SQLite statement or transaction
 * remains open while foreground writes, cancellation or scope changes can run. */
export class MemoryQueryCandidates {
  private readonly fts = new Map<string, MemoryRecordDto>();
  private readonly ftsRanks = new Map<string, number>();
  private readonly lexical: Ranked[] = [];
  // Per-query, bounded reuse for repeated source passages; never a durable truth cache.
  private readonly normalizedText = new Map<string, string>();
  private normalizedChars = 0;
  private readonly compact: string;
  private readonly terms: Array<{ text: string; gram: number; ascii: boolean }>;
  private readonly exactIdentifier: boolean;
  private readonly ftsQuery: string | null;

  constructor(private readonly options: { db: Database.Database; repository: MemoryRepository; query: string;
    scope: MemorySearchScope; limit: number; accept: (memory: MemoryRecordDto) => boolean }) {
    const normalized = options.query.normalize("NFKC").toLowerCase();
    this.compact = normalizeSearchText(normalized);
    this.exactIdentifier = isDotsSearch(options.scope) && /^[0-9a-f]{12,128}$/i.test(normalized.trim());
    const identifiers = normalized.match(/\b[0-9a-f]{12,128}\b/g);
    const words = dotsQuestionTerms(normalized).filter(term => term.length >= 3);
    const latinOnly = /^[\p{ASCII}\s]+$/u.test(normalized);
    const selective = isDotsSearch(options.scope) ? identifiers ?? (latinOnly ? words : undefined) : undefined;
    this.ftsQuery = selective?.length ? [...new Set(selective)].slice(0, 32).map(term => `"${term}"`).join(" OR ") : buildMemoryFtsQuery(options.query);
    const terms = new Set((normalized.match(/[\p{L}\p{N}_+.-]+/gu) ?? []).slice(0, 32).map(normalizeSearchText).filter(Boolean));
    const step = Math.max(1, (this.compact.length - 1) / 64);
    for (let i = 0; i < this.compact.length - 1; i += step) terms.add(this.compact.slice(Math.floor(i), Math.floor(i) + 2));
    this.terms = [...terms].map(text => ({ text, gram: text.length >= 2 ? gram(text,0) : -1, ascii: /^[\x00-\x7f]*$/.test(text) }));
  }

  private collectFts(): void {
    const query = this.ftsQuery;
    if (!query) return;
    const where = memorySearchWhere(this.options.scope);
    try {
      const rows = this.options.db.prepare(`SELECT m.id,bm25(memory_fts,0.0,3.0,1.0) score FROM memory_fts
        JOIN memory_records m ON m.id=memory_fts.memory_id WHERE memory_fts MATCH ? AND ${where.sql}
        ORDER BY score,m.id`).iterate(query, ...where.args) as Iterable<{ id: string }>;
      for (const row of rows) {
        const memory = this.options.repository.get(row.id);
        if (!memory || !this.options.accept(memory)) continue;
        this.fts.set(row.id, memory); this.ftsRanks.set(row.id, this.fts.size);
        if (this.fts.size >= this.options.limit) break;
      }
    } catch { /* A missing FTS index does not disable the complete lexical path. */ }
  }

  private *pages(): Generator<IndexedRow[]> {
    if (!isDotsSearch(this.options.scope)) { yield* this.readPages(); return; }
    const db = this.options.db;
    const key = JSON.stringify(this.options.scope);
    const version = searchEpoch(db, "text_version");
    const cache = textIndex.get(db);
    if (cache?.key === key && cache.version === version && Date.now() < cache.validUntil) {
      yield* cache.pages;
      return;
    }
    const pages: IndexedRow[][] = [];
    let chars = 0;
    const row = db.prepare(`SELECT MIN(value) AS next FROM (
      SELECT MIN(valid_from) AS value FROM memory_records WHERE valid_from>?
      UNION ALL SELECT MIN(valid_until) FROM memory_records WHERE valid_until>?)`).get(Date.now(), Date.now()) as { next: number | null };
    for (const page of this.readPages()) {
      const postings = new Uint32Array(page.length * gramStride);
      const indexed = page.map((item, rowIndex) => {
        const title = normalizeSearchText(item.title), content = normalizeSearchText(item.content);
        const offset = rowIndex * gramStride;
        for (const text of [title,content]) for (let i=0;i<text.length-1;i++) {
          const g = gram(text,i);
          if (g>=0) postings[offset+(g>>>5)]! |= 1 << (g&31);
        }
        return { ...item, title, content, normalized: true as const, postings, offset, ascii: /^[\x00-\x7f]*$/.test(title+content) };
      });
      chars += indexed.reduce((total,item) => total + item.title.length + item.content.length + item.id.length + item.content_hash.length,0);
      if (chars <= 32 * 1024 * 1024 && pages.length < 4096) pages.push(indexed);
      yield indexed;
    }
    if (db.open && pages.length < 4096 && chars <= 32 * 1024 * 1024 && version === searchEpoch(db, "text_version"))
      textIndex.set(db,{key,version,validUntil:row.next ?? Infinity,pages});
  }

  private *readPages(): Generator<Row[]> {
    if (!this.compact) return;
    const where = memorySearchWhere(this.options.scope);
    const highWater = this.options.db.prepare("SELECT COALESCE(MAX(rowid),0) n FROM memory_records").get() as { n: number };
    // The primary-key range bounds each read. A status/recency scan followed by
    // sorting every page would repeat the corpus work for each cursor.
    const read = this.options.db.prepare(`SELECT m.id,m.title,m.content,m.content_hash,m.importance,m.updated_at
      FROM memory_records m INDEXED BY sqlite_autoindex_memory_records_1
      WHERE m.id>? AND m.rowid<=? AND ${where.sql} ORDER BY m.id LIMIT 32`);
    let cursor = "";
    while (this.options.db.open) {
      const rows = read.all(cursor, highWater.n, ...where.args) as Row[];
      if (!rows.length) return;
      cursor = rows[rows.length - 1].id;
      yield rows;
    }
  }

  private normalize(text: string): string {
    const cached = this.normalizedText.get(text);
    if (cached !== undefined) return cached;
    const result = normalizeSearchText(text);
    if (text.length <= 32768 && this.normalizedChars + text.length + result.length <= 262144) {
      this.normalizedText.set(text, result);
      this.normalizedChars += text.length + result.length;
    }
    return result;
  }

  private collectPage(rows: readonly IndexedRow[]): void {
    for (const row of rows) {
      const title = row.normalized ? row.title : this.normalize(row.title), content = row.normalized ? row.content : this.normalize(row.content);
      if (this.exactIdentifier && !title.includes(this.compact) && !content.includes(this.compact)) continue;
      let relevance = 0;
      for (const term of this.terms) {
        if (row.ascii && !term.ascii) continue;
        if (row.postings && term.gram >= 0) {
          if (!(row.postings[row.offset!+(term.gram>>>5)]! & (1 << (term.gram&31)))) continue;
          if (term.text.length===2) { relevance++; continue; }
        }
        if (title.includes(term.text) || content.includes(term.text)) relevance++;
      }
      if (!relevance) continue;
      const exact = Number(title.includes(this.compact) || content.includes(this.compact));
      const worst = this.lexical.at(-1);
      // Compare lightweight rows before expanding an atom's evidence/relations.
      if (worst && this.lexical.length >= this.options.limit) {
        const order = worst.exact - exact || worst.relevance - relevance || worst.row.importance - row.importance
          || worst.row.updated_at - row.updated_at || row.id.localeCompare(worst.row.id);
        if (order >= 0) continue;
      }
      const memory = this.fts.get(row.id) ?? this.options.repository.get(row.id);
      if (!memory || memory.contentHash !== row.content_hash || !this.options.accept(memory)) continue;
      this.lexical.push({ row, exact, relevance, memory }); this.lexical.sort(compare);
      if (this.lexical.length > this.options.limit) this.lexical.pop();
    }
  }

  private *finishSteps() {
    const selected = new Map(this.fts);
    for (const item of this.lexical) selected.set(item.row.id, item.memory);
    const scoped: ReturnType<MemoryRepository["listByScopes"]> = [];
    const statuses = this.options.scope.statuses?.length ? this.options.scope.statuses : ["active"];
    const now = Date.now();
    for (const [id, old] of selected) {
      yield;
      const memory = this.options.repository.get(id);
      if (!memory || memory.contentHash !== old.contentHash || !statuses.includes(memory.status)
        || (this.options.scope.kinds?.length && !this.options.scope.kinds.includes(memory.kind))
        || (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)
          || (memory.validUntil !== undefined && memory.validUntil <= now))) || !this.options.accept(memory)) {
        this.ftsRanks.delete(id); continue;
      }
      if (this.fts.get(id)?.contentHash !== memory.contentHash) this.ftsRanks.delete(id);
      for (const scope of memory.scopes) {
        if (this.options.scope.scopes.some(match => match.scopeType === scope.scopeType && match.scopeId === scope.scopeId)) scoped.push({ memory, ...scope });
      }
    }
    return { scoped, ftsRanks: this.ftsRanks };
  }

  private finish() {
    const steps = this.finishSteps();
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
  }

  private async finishAsync() {
    const steps = this.finishSteps();
    let started = performance.now();
    let next = steps.next();
    while (!next.done) {
      if (performance.now() - started >= 4) {
        await yieldThread();
        if (!this.options.db.open) return { scoped: [], ftsRanks: new Map<string, number>() };
        started = performance.now();
      }
      next = steps.next();
    }
    return next.value;
  }

  search() {
    this.collectFts();
    for (const page of this.pages()) this.collectPage(page);
    return this.finish();
  }

  async searchAsync() {
    this.collectFts();
    let started = performance.now();
    for (const page of this.pages()) {
      this.collectPage(page);
      if (performance.now() - started >= 4) {
        await yieldThread();
        if (!this.options.db.open) return { scoped: [], ftsRanks: new Map<string, number>() };
        started = performance.now();
      }
    }
    return this.finishAsync();
  }
}
