/** Portable driver for the official Durable SQLite store. */
import Database from 'better-sqlite3';
import { mkdir, open } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';

export interface DurableSqliteDatabaseOptions {
  readonly readonly?: boolean;
  readonly busyTimeoutMs?: number;
  /** Pin a coherent passive snapshot until close (read-only connections only). */
  readonly snapshot?: boolean;
}

// DELETE-journal readers must not block this event loop while a local writer commits.
// Cross-process arbitration remains SQLite's job. No polling or filesystem writes.
class LocalGate {
  readers = 0;
  writer = false;
  waitingWriters = 0;
  waiters: Array<() => void> = [];
  private wait(): Promise<void> { return new Promise(resolve => this.waiters.push(resolve)); }
  private wake(): void { for (const resolve of this.waiters.splice(0)) resolve(); }
  async read(): Promise<() => void> {
    while (this.writer || this.waitingWriters) await this.wait();
    this.readers++;
    return () => { this.readers--; this.wake(); };
  }
  async write(): Promise<() => void> {
    this.waitingWriters++;
    while (this.writer || this.readers) await this.wait();
    this.waitingWriters--; this.writer = true;
    return () => { this.writer = false; this.wake(); };
  }
}
const localGates = new Map<string, { gate: LocalGate; connections: number }>();
function gateFor(path: string): { gate: LocalGate; releaseGate: () => void } {
  if (path === ':memory:') return { gate: new LocalGate(), releaseGate: () => {} };
  let key: string;
  try { key = realpathSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // mkdir has completed: canonicalize the parent even before a new artifact exists.
    key = join(realpathSync(dirname(path)), basename(path));
  }
  let held = localGates.get(key);
  if (!held) { held = { gate: new LocalGate(), connections: 0 }; localGates.set(key, held); }
  held.connections++;
  let released = false;
  return { gate: held.gate, releaseGate: () => {
    if (released) return;
    released = true;
    held.connections--;
    if (held.connections === 0) localGates.delete(key);
  } };
}

/** One serialized connection. Transaction handles bypass the queue only during their callback. */
export class DurableSqliteDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly statements = new Map<string, Database.Statement>();
  private constructor(private readonly database: Database.Database, private readonly readOnly: boolean, private readonly snapshot: boolean, private readonly gate: LocalGate, private readonly releaseGate: () => void, private readonly releaseSnapshot?: () => void) {}

  static async open(path: string, options: DurableSqliteDatabaseOptions = {}): Promise<DurableSqliteDatabase> {
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 0x7fffffff) throw new Error('Invalid SQLite busy timeout');
    if (!options.readonly && path !== ':memory:') await mkdir(dirname(path), { recursive: true });
    // Callers must hold the session lease across open/use. Inspect before SQLite opens:
    // even a readonly WAL connection can create shared-memory sidecars. This candidate
    // supports rollback-journal artifacts only and never converts an existing WAL store.
    if (path !== ':memory:') {
      let file;
      try { file = await open(path, 'r'); }
      catch (error) {
        if (options.readonly || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (file) {
        try {
          const header = Buffer.alloc(20);
          const { bytesRead } = await file.read(header, 0, header.length, 0);
          if (bytesRead !== 20 || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') {
            throw new Error('Invalid existing durable SQLite artifact');
          }
          if (header[18] !== 1 || header[19] !== 1) {
            throw new Error('WAL durable SQLite artifacts are not supported by this candidate');
          }
        } finally { await file.close(); }
      }
    }
    const { gate, releaseGate } = gateFor(path);
    const releaseSnapshot = options.readonly && options.snapshot ? await gate.read() : undefined;
    let database: Database.Database;
    try { database = new Database(path, { readonly: options.readonly ?? false,
      fileMustExist: options.readonly ?? false, timeout }); }
    catch (error) { releaseSnapshot?.(); releaseGate(); throw error; }
    try {
      if (options.readonly) {
        // Connection-local protection; no migration, checkpoint, or journal-mode change.
        database.pragma('query_only = ON');
        if (options.snapshot) database.exec('BEGIN');
      } else {
        // New SQLite databases default to DELETE. Never switch an existing journal mode.
        if (database.pragma('journal_mode', { simple: true }) !== 'delete' && path !== ':memory:') {
          throw new Error('Expected DELETE journal mode for durable SQLite artifact');
        }
        database.pragma('synchronous = FULL');
      }
      return new DurableSqliteDatabase(database, options.readonly ?? false, Boolean(options.readonly && options.snapshot), gate, releaseGate, releaseSnapshot);
    } catch (error) {
      database.close();
      releaseSnapshot?.();
      releaseGate();
      throw error;
    }
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private executor(assertActive: () => void): SqliteExecutor {
    const execute = async <T>(operation: () => T): Promise<T> => {
      assertActive();
      if (this.closed) throw new Error('SQLite database is closed');
      return operation();
    };
    const statement = (sql: string): Database.Statement => {
      let result = this.statements.get(sql);
      if (result) this.statements.delete(sql);
      else result = this.database.prepare(sql);
      this.statements.set(sql, result);
      if (this.statements.size > 256) this.statements.delete(this.statements.keys().next().value!);
      return result;
    };
    return {
      exec: sql => execute(() => { this.database.exec(sql); }),
      run: (sql, ...params) => execute(() => { statement(sql).run(...params); }),
      runCounted: (sql, ...params) => execute(() => statement(sql).run(...params).changes),
      get: <T extends object>(sql: string, ...params: SqliteValue[]) => execute(() => statement(sql).get(...params) as T | undefined),
      all: <T extends object>(sql: string, ...params: SqliteValue[]) => execute(() => statement(sql).all(...params) as T[]),
    };
  }

  /** Mutating SQL must use exec/run/runCounted or transaction, not get/all. */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('SQLite database is closed');
      const release = this.readOnly ? undefined : await this.gate.write();
      try { return await operation(); } finally { release?.(); }
    });
  }
  exec(sql: string): Promise<void> { return this.mutate(() => this.executor(() => {}).exec(sql)); }
  run(sql: string, ...params: SqliteValue[]): Promise<void> { return this.mutate(() => this.executor(() => {}).run(sql, ...params)); }
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> { return this.mutate(() => this.executor(() => {}).runCounted(sql, ...params)); }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> { return this.enqueue(() => this.executor(() => {}).get<T>(sql, ...params)); }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> { return this.enqueue(() => this.executor(() => {}).all<T>(sql, ...params)); }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (this.closed) throw new Error('SQLite database is closed');
      if (this.snapshot) {
        let active = true;
        try { return await callback(this.executor(() => { if (!active) throw new Error('SQLite transaction handle is no longer active'); })); }
        finally { active = false; }
      }
      const release = this.readOnly ? undefined : await this.gate.write();
      let active = true;
      try { this.database.exec(this.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE'); }
      catch (error) { release?.(); throw error; }
      const transaction = this.executor(() => { if (!active) throw new Error('SQLite transaction handle is no longer active'); });
      try {
        const result = await callback(transaction);
        active = false;
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        active = false;
        try { this.database.exec('ROLLBACK'); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'SQLite transaction failed and rollback failed'); }
        throw error;
      } finally { release?.(); }
    });
  }

  close(): Promise<void> {
    return this.enqueue(() => {
      if (this.closed) return;
      try {
        if (this.snapshot) this.database.exec('ROLLBACK');
      } finally {
        try { this.database.close(); }
        finally { this.releaseSnapshot?.(); this.releaseGate(); this.statements.clear(); this.closed = true; }
      }
    });
  }
}
