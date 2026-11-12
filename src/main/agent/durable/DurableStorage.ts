import type { Storage } from '@earendil-works/pi-durable';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JsonlStorage, openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { DurableReadOnlyFiles } from './DurableReadOnlyFiles';
import type { DurableLogRepairReport } from './DurableLogRepair';
import { claimDurableStorageLease, type DurableStorageLease } from './DurableStorageLease';
import { DurableSqliteDatabase } from './DurableSqliteDatabase';
import { ensureDurableSqlite, selectedDurableSqlite } from './DurableStorageMigration';

type JsonlContext = Parameters<typeof openNodeJsonlStorage>[1];
export interface DurableStorageHandle {
  storage: Storage;
  lease?: DurableStorageLease;
  repair?: DurableLogRepairReport;
}
export function isJsonlCorruption(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return candidate.name === 'JsonlCorruptionError' || typeof candidate.message === 'string' && candidate.message.includes('JsonlCorruptionError');
}
/** Selectors are authoritative; malformed/missing selected artifacts are errors, not empty histories. */
export function durableStorageExists(directory: string): boolean {
  return Boolean(selectedDurableSqlite(directory)) || existsSync(join(directory, 'main.jsonl'));
}
/** Sole writer opener: ownership -> copy-only migration -> authoritative official SQLite. */
export function openDurableStorage(directory: string, context: JsonlContext, options?: { readOnly?: false }): Promise<DurableStorageHandle & { lease: DurableStorageLease }>;
export function openDurableStorage(directory: string, context: JsonlContext, options: { readOnly?: boolean }): Promise<DurableStorageHandle>;
export async function openDurableStorage(directory: string, context: JsonlContext, options: { readOnly?: boolean } = {}): Promise<DurableStorageHandle> {
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
export async function openDurablePassiveStorage(directory: string, context: JsonlContext): Promise<Storage | undefined> {
  const path = selectedDurableSqlite(directory);
  if (path) return SqliteStorage.openReadOnly(await DurableSqliteDatabase.open(path, { readonly: true, snapshot: true }));
  if (!existsSync(join(directory, 'main.jsonl'))) return undefined;
  return JsonlStorage.open(directory, new DurableReadOnlyFiles({ cwd: directory }), context, { fsync: true });
}
