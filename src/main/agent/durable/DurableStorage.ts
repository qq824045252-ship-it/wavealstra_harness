import type { Storage } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { claimDurableStorageLease, type DurableStorageLease } from './DurableStorageLease';
import { DurableRustSqliteDatabase, DurableSqliteDatabase } from './DurableSqliteDatabase';
import { ensureDurableSqlite, selectedDurableSqlite } from './DurableStorageFormat';
import type { RuntimeAuditReader } from '../../platform/runtime-audit';

export interface DurableStorageHandle {
  storage: Storage;
  lease?: DurableStorageLease;
}
/** Selectors are authoritative; malformed/missing selected artifacts are errors, not empty histories. */
export function durableStorageExists(directory: string): boolean {
  return Boolean(selectedDurableSqlite(directory));
}
/** Sole writer opener: mutex -> discard old owned data -> current official SQLite. */
export function openDurableStorage(directory: string, context: Context, options?: { readOnly?: false }): Promise<DurableStorageHandle & { lease: DurableStorageLease }>;
export function openDurableStorage(directory: string, context: Context, options: { readOnly?: boolean; reader?: RuntimeAuditReader }): Promise<DurableStorageHandle>;
export async function openDurableStorage(directory: string, context: Context, options: { readOnly?: boolean; reader?: RuntimeAuditReader } = {}): Promise<DurableStorageHandle> {
  if (options.readOnly) {
    const storage = options.reader
      ? (await openRustDurableStorage(directory, options.reader))?.storage
      : await openDurablePassiveStorage(directory, context);
    if (!storage) throw new Error('Durable storage does not exist');
    return { storage };
  }
  const lease = claimDurableStorageLease(directory);
  try {
    const path = await ensureDurableSqlite(directory, context);
    return { storage: await SqliteStorage.openExisting(await DurableSqliteDatabase.open(path)), lease };
  } catch (error) { lease.release(); throw error; }
}
/** No ownership/repair/bootstrap writes or task execution. SQLite snapshot lasts until close. */
export async function openDurablePassiveStorage(directory: string, _context: Context): Promise<Storage | undefined> {
  const path = selectedDurableSqlite(directory);
  return path ? SqliteStorage.openReadOnly(await DurableSqliteDatabase.open(path, { readonly: true, snapshot: true })) : undefined;
}

export async function openRustDurableStorage(directory: string, reader: RuntimeAuditReader) {
  const path = selectedDurableSqlite(directory);
  if (!path) return undefined;
  const database = await DurableRustSqliteDatabase.open(path, reader);
  const storage = await SqliteStorage.openReadOnly(database);
  return { storage, snapshot: database.snapshot };
}
