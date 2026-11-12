/** Current official SQLite storage only. Old owned formats are discarded, never imported. */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { Context } from '@earendil-works/chord';
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { DurableSqliteDatabase } from './DurableSqliteDatabase';
import { syncPublishedDirectory } from '../../platform/fs-durability';

export const SELECTOR = '.mybuddy-storage.json';
const ARTIFACT = 'durable.sqlite';
const INITIALIZING = '.mybuddy-storage-init.json';
const OLD_INTENT = '.mybuddy-storage-intent.json';
const selectorSchema = z.object({ format: z.literal(1), backend: z.literal('sqlite'), file: z.literal(ARTIFACT) }).strict();
const initializationSchema = selectorSchema.extend({ schemaVersion: z.literal(CURRENT_SQLITE_SCHEMA_VERSION) });
const legacyJournal = /^(?:main|doc-\d+|task-\d+)\.jsonl(?:[.-].*)?$/;
const legacyStage = /^\.mybuddy-migration-[0-9a-f-]{36}$/;
const ownedTemporary = /^\.mybuddy-storage(?:-init)?\.json\.tmp-[0-9a-f-]{36}$/;

function ownedPath(directory: string, name: string): string {
  const root = realpathSync(directory), path = resolve(root, name), fromRoot = relative(root, path);
  if (!fromRoot || fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error('Durable owned artifact escapes its directory');
  return path;
}
function regularFile(directory: string, name: string): string | undefined {
  const path = ownedPath(directory, name);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Durable artifact must be a regular owned file: ${name}`);
  return path;
}
function selector(directory: string): { kind: 'missing' | 'old' } | { kind: 'current'; path: string } {
  const path = regularFile(directory, SELECTOR);
  if (!path) return { kind: 'missing' };
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  return selectorSchema.safeParse(value).success ? { kind: 'current', path } : { kind: 'old' };
}

/** Passive selection never cleans, initializes, migrates or falls back to JSONL. */
export function selectedDurableSqlite(directory: string): string | undefined {
  if (!existsSync(directory)) return undefined;
  if (selector(directory).kind !== 'current') return undefined;
  const path = regularFile(directory, ARTIFACT);
  if (!path) throw new Error('Selected current Durable SQLite artifact is missing');
  return path;
}
export async function syncDurableFile(path: string): Promise<void> {
  const handle = await open(path, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publishJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = ownedPath(directory, `${name}.tmp-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  await syncDurableFile(temporary);
  await rename(temporary, ownedPath(directory, name));
  await syncPublishedDirectory(directory);
}
async function removeFile(directory: string, name: string): Promise<void> {
  const path = regularFile(directory, name);
  if (path) await rm(path);
}
function validateOwnedTree(directory: string, name: string): string {
  const path = ownedPath(directory, name), stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing a linked or invalid old Durable staging directory');
  for (const entry of readdirSync(path)) {
    const child = ownedPath(directory, join(name, entry)), childStat = lstatSync(child);
    if (childStat.isSymbolicLink()) throw new Error('Refusing links in old Durable staging data');
    if (childStat.isDirectory()) validateOwnedTree(directory, join(name, entry));
    else if (!childStat.isFile()) throw new Error('Refusing a non-file old Durable staging artifact');
  }
  return path;
}
async function discardOldArtifacts(directory: string): Promise<void> {
  for (const name of readdirSync(directory)) {
    if (legacyJournal.test(name) || name === OLD_INTENT || ownedTemporary.test(name)) await removeFile(directory, name);
    else if (legacyStage.test(name)) {
      const path = validateOwnedTree(directory, name);
      const ownerFile = regularFile(path, 'owner.json');
      if (!ownerFile) throw new Error('Old Durable staging directory has no ownership record');
      const owner = z.object({ format: z.literal(1), backend: z.literal('sqlite'), stage: z.literal(name),
        source: z.record(z.string(), z.string()), state: z.enum(['copying', 'verified', 'selected']) }).passthrough()
        .safeParse(JSON.parse(readFileSync(ownerFile, 'utf8')));
      if (!owner.success) throw new Error('Old Durable staging ownership does not match its directory');
      await rm(path, { recursive: true });
    }
  }
}
async function artifactKind(path: string, context: Context): Promise<'empty' | 'old' | 'current'> {
  if (lstatSync(path).size === 0) return 'empty';
  const database = await DurableSqliteDatabase.open(path, { readonly: true });
  try {
    const schema = await database.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='durable_schema'");
    if (!schema) return 'old';
    const row = await database.get<{ version: unknown }>('SELECT version FROM durable_schema WHERE singleton=1');
    const version = z.object({ version: z.number().int().nonnegative() }).parse(row).version;
    if (version !== CURRENT_SQLITE_SCHEMA_VERSION) return 'old';
  } finally { await database.close(); }
  // Exact schema alone is not proof that the current artifact is healthy.
  // Invalid current metadata is an error, never permission to erase live facts.
  const current = await SqliteStorage.openReadOnly(await DurableSqliteDatabase.open(path, { readonly: true }));
  await current.close(context);
  return 'current';
}

/** Called only under the current writer mutex. Lease artifacts are never removed. */
export async function ensureDurableSqlite(directory: string, context: Context): Promise<string> {
  const selected = selector(directory), artifact = regularFile(directory, ARTIFACT);
  if (selected.kind === 'current' && !artifact) throw new Error('Selected current Durable SQLite artifact is missing');
  const kind = artifact ? await artifactKind(artifact, context) : undefined;
  const initialization = regularFile(directory, INITIALIZING);
  if (kind === 'empty') {
    const hasCurrentInitialization = initialization && initializationSchema.safeParse(JSON.parse(readFileSync(initialization, 'utf8'))).success;
    if (selected.kind === 'current' || !hasCurrentInitialization)
      throw new Error('Empty Durable artifact is not a recoverable current initialization');
  }
  if (artifact && kind === 'current') {
    await discardOldArtifacts(directory);
    if (selected.kind !== 'current') await publishJson(directory, SELECTOR, selectorSchema.parse({ format: 1, backend: 'sqlite', file: ARTIFACT }));
    await removeFile(directory, INITIALIZING);
    return artifact;
  }
  await publishJson(directory, INITIALIZING, { format: 1, backend: 'sqlite', file: ARTIFACT, schemaVersion: CURRENT_SQLITE_SCHEMA_VERSION });
  if (selected.kind !== 'missing') await removeFile(directory, SELECTOR);
  await discardOldArtifacts(directory);
  // Remove journals before their old main file. An interrupted discard must not
  // leave an old WAL that a fresh current database could replay.
  for (const name of [`${ARTIFACT}-wal`, `${ARTIFACT}-shm`, `${ARTIFACT}-journal`]) await removeFile(directory, name);
  if (kind === 'old' || kind === 'empty') await removeFile(directory, ARTIFACT);
  const path = ownedPath(directory, ARTIFACT);
  const storage = await SqliteStorage.open(await DurableSqliteDatabase.open(path));
  await storage.close(context);
  await syncDurableFile(path);
  await publishJson(directory, SELECTOR, { format: 1, backend: 'sqlite', file: ARTIFACT });
  await removeFile(directory, INITIALIZING);
  return path;
}
