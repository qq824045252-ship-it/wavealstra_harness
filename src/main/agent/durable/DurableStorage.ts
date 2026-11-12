import type { Storage } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { claimDurableStorageLease, type DurableStorageLease } from './DurableStorageLease';
import { DurableSqliteDatabase } from './DurableSqliteDatabase';
import { ensureDurableSqlite, selectedDurableSqlite } from './DurableStorageFormat';

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
export function openDurableStorage(directory: string, context: Context, options: { readOnly?: boolean }): Promise<DurableStorageHandle>;
export async function openDurableStorage(directory: string, context: Context, options: { readOnly?: boolean } = {}): Promise<DurableStorageHandle> {
  if (options.readOnly) {
    const storage = await openDurablePassiveStorage(directory, context);
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
