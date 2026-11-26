import type Database from "better-sqlite3";

export interface Batch4bWriter {
  supervised?: boolean;
  batch4bWrite<T = unknown>(request: Record<string, unknown>): Promise<T | undefined>;
}

export type OverlayRow = Record<string, unknown>;
type TableOverlay = Map<string, OverlayRow | null>;

interface RuntimeEntry {
  writer?: Batch4bWriter;
  overlays: Map<string, TableOverlay>;
  txDepth: number;
  txOps: Array<Record<string, unknown>>;
  writeTail: Promise<void>;
  pendingBatches: number;
  revision: number;
  lastError?: unknown;
}

const runtimes = new WeakMap<Database.Database, RuntimeEntry>();

function entryOf(db: Database.Database): RuntimeEntry {
  let entry = runtimes.get(db);
  if (!entry) {
    entry = {
      overlays: new Map(),
      txDepth: 0,
      txOps: [],
      writeTail: Promise.resolve(),
      pendingBatches: 0,
      revision: 0,
    };
    runtimes.set(db, entry);
  }
  return entry;
}

export function bindWorkDomainWriter(db: Database.Database, writer: Batch4bWriter | undefined): void {
  if (!writer) return;
  entryOf(db).writer = writer;
}

export function resolveWorkDomainWriter(db: Database.Database, explicit?: Batch4bWriter): Batch4bWriter | undefined {
  const entry = entryOf(db);
  if (explicit && !entry.writer) entry.writer = explicit;
  return explicit ?? entry.writer;
}

export function requiresWorkRustWrites(db: Database.Database, explicit?: Batch4bWriter): boolean {
  const writer = resolveWorkDomainWriter(db, explicit);
  return Boolean(db.readonly || writer?.supervised);
}

export function requireWorkRustWriter(db: Database.Database, explicit?: Batch4bWriter): Batch4bWriter {
  const writer = resolveWorkDomainWriter(db, explicit);
  if (!writer) throw new Error("Rust writer unavailable for readonly Work domain");
  return writer;
}

export function workDomainOverlayRevision(db: Database.Database): number {
  const entry = entryOf(db);
  return entry.revision + entry.pendingBatches * 1024 + entry.txDepth;
}

function cloneOverlays(source: Map<string, TableOverlay>): Map<string, TableOverlay> {
  const copy = new Map<string, TableOverlay>();
  for (const [table, rows] of source) copy.set(table, new Map(rows));
  return copy;
}

function submitBatch(entry: RuntimeEntry, writer: Batch4bWriter, ops: Array<Record<string, unknown>>): void {
  if (!ops.length) return;
  const payload = ops.length === 1 ? ops[0]! : { op: "batch", ops };
  entry.pendingBatches += 1;
  entry.revision += 1;
  entry.writeTail = entry.writeTail
    .then(async () => {
      const res = await writer.batch4bWrite(payload);
      if (res === undefined) throw new Error("Rust batch4bWrite returned undefined");
    })
    .catch(error => {
      entry.lastError ??= error;
      console.warn("[WorkDomain] Rust batch4bWrite failed", error);
    })
    .finally(() => {
      entry.pendingBatches = Math.max(0, entry.pendingBatches - 1);
      if (entry.pendingBatches === 0 && entry.txDepth === 0) {
        entry.overlays.clear();
        entry.revision += 1;
      }
    });
}

export function enqueueWorkOp(db: Database.Database, op: Record<string, unknown>, explicit?: Batch4bWriter): void {
  const writer = requireWorkRustWriter(db, explicit);
  const entry = entryOf(db);
  entry.revision += 1;
  if (entry.txDepth > 0) {
    entry.txOps.push(op);
    return;
  }
  submitBatch(entry, writer, [op]);
}

export function workDomainRunTx<T>(db: Database.Database, fn: () => T, explicit?: Batch4bWriter): T {
  if (!requiresWorkRustWrites(db, explicit)) {
    return db.transaction(fn).immediate();
  }
  const writer = requireWorkRustWriter(db, explicit);
  const entry = entryOf(db);
  const savedOverlays = cloneOverlays(entry.overlays);
  const savedOpsLen = entry.txOps.length;
  entry.txDepth += 1;
  try {
    const result = fn();
    if (entry.txDepth === 1) {
      const committed = entry.txOps.splice(0);
      entry.txDepth = 0;
      submitBatch(entry, writer, committed);
      return result;
    }
    entry.txDepth -= 1;
    return result;
  } catch (error) {
    entry.overlays = savedOverlays;
    entry.txOps.length = savedOpsLen;
    entry.txDepth -= 1;
    throw error;
  }
}

export function workDomainInTx(db: Database.Database, explicit?: Batch4bWriter): boolean {
  if (requiresWorkRustWrites(db, explicit)) return entryOf(db).txDepth > 0 || db.inTransaction;
  return db.inTransaction;
}

export async function flushWorkDomainWrites(db: Database.Database): Promise<void> {
  const entry = runtimes.get(db);
  if (!entry) return;
  await entry.writeTail;
  if (entry.lastError) {
    const err = entry.lastError;
    entry.lastError = undefined;
    throw err;
  }
}

// ------------------------------------------------------------ Overlay helpers

function tableMap(db: Database.Database, table: string): TableOverlay | undefined {
  return entryOf(db).overlays.get(table);
}

function ensureTableMap(db: Database.Database, table: string): TableOverlay {
  const entry = entryOf(db);
  let map = entry.overlays.get(table);
  if (!map) {
    map = new Map();
    entry.overlays.set(table, map);
  }
  return map;
}

export function overlayHasTable(db: Database.Database, table: string): boolean {
  const map = tableMap(db, table);
  return Boolean(map && map.size > 0);
}

/**
 * Lookup a row when overlay is active:
 * - returns `{ hit: true, row }` if present (null means deleted in overlay)
 * - returns `{ hit: false }` if overlay has no entry for pk (caller should read SQLite)
 */
export function overlayLookup<T extends OverlayRow = OverlayRow>(
  db: Database.Database,
  table: string,
  pk: string,
): { hit: true; row: T | undefined } | { hit: false } {
  const map = tableMap(db, table);
  if (!map || !map.has(pk)) return { hit: false };
  const val = map.get(pk);
  return { hit: true, row: val ? (val as T) : undefined };
}

export function overlayReadOne<T extends OverlayRow = OverlayRow>(
  db: Database.Database,
  table: string,
  pk: string,
  fetchDb: () => T | undefined,
): T | undefined {
  const hit = overlayLookup<T>(db, table, pk);
  if (hit.hit) return hit.row;
  return fetchDb();
}

export function overlaySet(db: Database.Database, table: string, pk: string, row: OverlayRow): void {
  ensureTableMap(db, table).set(pk, { ...row });
}

export function overlayDelete(db: Database.Database, table: string, pk: string): void {
  ensureTableMap(db, table).set(pk, null);
}

export function overlayMutate<T extends OverlayRow = OverlayRow>(
  db: Database.Database,
  table: string,
  pk: string,
  fetchDb: () => T | undefined,
  mutate: (current: T | undefined) => T | null | undefined,
): T | undefined {
  const current = overlayReadOne<T>(db, table, pk, fetchDb);
  const next = mutate(current ? { ...current } : undefined);
  if (next === undefined) return current;
  if (next === null) {
    overlayDelete(db, table, pk);
    return undefined;
  }
  overlaySet(db, table, pk, next);
  return next;
}

export function overlayMergeAll<T extends OverlayRow = OverlayRow>(
  db: Database.Database,
  table: string,
  dbRows: T[],
  pkOf: (row: T) => string,
  predicate?: (row: T) => boolean,
  comparator?: (a: T, b: T) => number,
): T[] {
  const map = tableMap(db, table);
  if (!map || !map.size) {
    const filtered = predicate ? dbRows.filter(predicate) : [...dbRows];
    return comparator ? filtered.sort(comparator) : filtered;
  }
  const result = new Map<string, T>();
  for (const row of dbRows) {
    if (!predicate || predicate(row)) result.set(pkOf(row), row);
  }
  for (const [pk, val] of map) {
    if (val === null) {
      result.delete(pk);
    } else {
      const typed = val as T;
      if (!predicate || predicate(typed)) result.set(pk, typed);
      else result.delete(pk);
    }
  }
  const merged = [...result.values()];
  return comparator ? merged.sort(comparator) : merged;
}

export function overlayFindAll<T extends OverlayRow = OverlayRow>(
  db: Database.Database,
  table: string,
  dbRows: T[],
  pkOf: (row: T) => string,
  predicate: (row: T) => boolean,
  comparator?: (a: T, b: T) => number,
): T[] {
  return overlayMergeAll(db, table, dbRows, pkOf, predicate, comparator);
}
