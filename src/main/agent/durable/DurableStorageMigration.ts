/** One-time copy-only migration. All business records belong to official Durable Storage. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'node:fs';
import { copyFile, mkdir, open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '@earendil-works/chord';
import type { Storage, StorageWrite, Seq, DocumentId, DocumentPoint, Cursor } from '@earendil-works/pi-durable';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { DurableSqliteDatabase } from './DurableSqliteDatabase';
import { syncPublishedDirectory } from '../../platform/fs-durability';

export const SELECTOR = '.mybuddy-storage.json';
const INTENT = '.mybuddy-storage-intent.json';
const ARTIFACT = 'durable.sqlite';
const JOURNAL = /^(main|doc-[0-9]+|task-[0-9]+)\.jsonl$/;
type Fingerprint = Record<string, string>;
type Intent = { format: 1; backend: 'sqlite'; stage: string; source: Fingerprint; state: 'copying' | 'verified' | 'selected'; artifactHash?: string };

function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function sources(directory: string): Fingerprint {
  const result: Fingerprint = {};
  for (const name of readdirSync(directory).filter(n => JOURNAL.test(n)).sort()) {
    const file = join(directory, name);
    if (!lstatSync(file).isFile()) throw new Error(`Durable source is not a regular file: ${name}`);
    result[name] = digest(readFileSync(file));
  }
  return result;
}

/** Strict authoritative selection. Never fall back to stale JSONL after selection. */
export function selectedDurableSqlite(directory: string): string | undefined {
  const path = join(directory, SELECTOR);
  if (!existsSync(path)) {
    if (existsSync(join(directory, ARTIFACT))) throw new Error('Durable SQLite artifact exists without its authoritative selector; recovery is required');
    if (existsSync(join(directory, INTENT))) throw new Error('Durable storage migration is incomplete; writable recovery is required');
    return undefined;
  }
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value?.format !== 1 || value.backend !== 'sqlite' || value.file !== ARTIFACT) throw new Error('Invalid Durable backend selector');
  const target = join(directory, ARTIFACT);
  if (!existsSync(target) || !lstatSync(target).isFile()) throw new Error('Selected Durable SQLite artifact is missing or invalid');
  return target;
}

export async function syncDurableFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(directory: string, name: string, value: unknown): Promise<void> {
  const temporary = join(directory, `${name}.tmp-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify(value), { flag: 'wx' });
  await syncDurableFile(temporary);
  await rename(temporary, join(directory, name));
  // A failure after rename is an uncertain publication, never an acknowledged success.
  await syncPublishedDirectory(directory);
}

async function equalRead(label: string, a: () => Promise<unknown>, b: () => Promise<unknown>): Promise<void> {
  const [left, right] = await Promise.allSettled([a(), b()]);
  if (left.status !== right.status || (left.status === 'fulfilled' && right.status === 'fulfilled'
    ? !isDeepStrictEqual(left.value, right.value)
    : left.status === 'rejected' && right.status === 'rejected' && (left.reason?.name !== right.reason?.name || left.reason?.message !== right.reason?.message))) {
    throw new Error(`Durable migration verification failed: ${label}`);
  }
}
async function equalPages<T>(label: string, a: (cursor: Cursor | undefined) => Promise<{ items: readonly T[]; next?: Cursor }>, b: (cursor: Cursor | undefined) => Promise<{ items: readonly T[]; next?: Cursor }>): Promise<T[]> {
  let ac: Cursor | undefined, bc: Cursor | undefined;
  const all: T[] = [];
  do {
    const [left, right] = await Promise.all([a(ac), b(bc)]);
    if (!isDeepStrictEqual(left.items, right.items) || Boolean(left.next) !== Boolean(right.next)) throw new Error(`Durable migration verification failed: ${label}`);
    all.push(...left.items); ac = left.next; bc = right.next;
  } while (ac);
  return all;
}

/** Streaming capture indexes only verification identities/points, never a second application state model. */
class Verification {
  private documents = new Map<DocumentId, Set<DocumentPoint>>();
  private entries = new Set<Parameters<Storage['findLatestHeadMarker']>[1]>();
  record(seq: Seq, writes: readonly StorageWrite[]): void {
    for (const write of writes) {
      if (write.type === 'entry') this.entries.add(write.value.id);
      if (write.type.startsWith('document.')) {
        const id = 'record' in write ? write.record.id : 'id' in write ? write.id : undefined;
        if (id !== undefined) {
          const points = this.documents.get(id) ?? new Set<DocumentPoint>(['current']);
          points.add(seq); if (seq > 1) points.add((seq - 1) as Seq);
          this.documents.set(id, points);
        }
        if (write.type === 'document.copy') {
          const points = this.documents.get(write.source.id) ?? new Set<DocumentPoint>(['current']);
          points.add(write.source.at); this.documents.set(write.source.id, points);
        }
      }
    }
  }
  async verify(source: Storage, target: Storage, context: Context): Promise<void> {
    const conversations = await equalPages('conversations', c => source.scanConversations({}, 256, c, context), c => target.scanConversations({}, 256, c, context));
    await equalPages('tasks/checkpoints', c => source.scanTasks({}, 256, c, context), c => target.scanTasks({}, 256, c, context));
    await equalPages('submissions/receipts', c => source.scanSubmissions({}, 256, c, context), c => target.scanSubmissions({}, 256, c, context));
    for (const conversation of conversations) {
      for (const order of ['ascending', 'descending'] as const) await equalPages('ancestry/entries', c => source.scanEntries({ conversationId: conversation.id, order }, 256, c, context), c => target.scanEntries({ conversationId: conversation.id, order }, 256, c, context));
      await equalRead('head', () => source.findLatestHeadMarker(conversation.id, undefined, context), () => target.findLatestHeadMarker(conversation.id, undefined, context));
    }
    for (const id of this.entries) if (id !== undefined) await equalRead('entry/commitSeq', () => source.entry(id, context), () => target.entry(id, context));
    for (const [id, points] of this.documents) for (const point of points) await equalRead(`document ${id}@${point}`, () => source.document(id, point, context), () => target.document(id, point, context));
    if (await source.mintId() !== await target.mintId()) throw new Error('Durable migration next global ID differs');
  }
}

function readIntent(directory: string): Intent | undefined {
  if (!existsSync(join(directory, INTENT))) return undefined;
  const value = JSON.parse(readFileSync(join(directory, INTENT), 'utf8')) as Intent;
  if (value?.format !== 1 || value.backend !== 'sqlite' || !/^\.mybuddy-migration-[0-9a-f-]{36}$/.test(value.stage) || !['copying', 'verified', 'selected'].includes(value.state) || typeof value.source !== 'object' || !value.source) throw new Error('Invalid Durable migration ownership record');
  return value;
}

/** Must be called under the exclusive writer lease. Failures keep staging unpublished and originals intact. */
export async function ensureDurableSqlite(directory: string, context: Context): Promise<string> {
  if (existsSync(join(directory, SELECTOR))) return selectedDurableSqlite(directory)!;
  let intent = readIntent(directory);
  if (intent?.state === 'selected') throw new Error('Durable backend selector is missing after SQLite selection');
  const artifact = join(directory, ARTIFACT);
  if (intent && !isDeepStrictEqual(intent.source, sources(directory))) throw new Error('Durable legacy source changed during migration; refusing recovery');
  if (intent?.state === 'verified') {
    const staged = join(directory, intent.stage, ARTIFACT);
    const candidate = existsSync(artifact) ? artifact : staged;
    if (!intent.artifactHash || digest(readFileSync(candidate)) !== intent.artifactHash) throw new Error('Verified Durable staging artifact is missing or changed');
    if (!existsSync(artifact)) await rename(staged, artifact);
  } else {
    if (existsSync(artifact)) throw new Error('Unowned Durable SQLite artifact without selector');
    // Never remove previous staging or backups. A failed/cancelled attempt remains diagnostic evidence.
    const source = sources(directory);
    if (!('main.jsonl' in source) && Object.keys(source).length) throw new Error('Durable JSONL sidecars exist without main journal');
    intent = { format: 1, backend: 'sqlite', stage: `.mybuddy-migration-${randomUUID()}`, source, state: 'copying' };
    await atomicJson(directory, INTENT, intent);
    const stage = join(directory, intent.stage); await mkdir(stage);
    await writeFile(join(stage, 'owner.json'), JSON.stringify(intent), { flag: 'wx' });
    const copy = join(stage, 'legacy-copy'); await mkdir(copy);
    for (const name of Object.keys(source)) await copyFile(join(directory, name), join(copy, name));
    if (!isDeepStrictEqual(source, sources(copy)) || !isDeepStrictEqual(source, sources(directory))) throw new Error('Durable source changed while copying');
    const targetPath = join(stage, ARTIFACT);
    let target: Storage | undefined;
    let recovered: Storage | undefined;
    try {
      const sqlite = await SqliteStorage.open(await DurableSqliteDatabase.open(targetPath)); target = sqlite;
      if ('main.jsonl' in source) {
        const verification = new Verification();
        // No task host/model is constructed. Official recovery runs only against our private copy.
        recovered = await openNodeJsonlStorage(copy, context, { fsync: true, onRecoveredCommit: async commit => {
          await sqlite.replayCommitForImport(commit); verification.record(commit.seq, commit.writes);
        } });
        await verification.verify(recovered, sqlite, context);
      }
      await recovered?.close(context); recovered = undefined;
      await target.close(context); target = undefined;
      await syncDurableFile(targetPath);
      if (!isDeepStrictEqual(source, sources(directory))) throw new Error('Durable source changed before publication');
      intent = { ...intent, state: 'verified', artifactHash: digest(readFileSync(targetPath)) };
      await atomicJson(directory, INTENT, intent);
      await rename(targetPath, artifact);
    } finally {
      try { await recovered?.close(context); } finally { await target?.close(context); }
    }
  }
  // Selector is the last publication step; target was fully closed, flushed, and verified first.
  await atomicJson(directory, SELECTOR, { format: 1, backend: 'sqlite', file: ARTIFACT });
  await atomicJson(directory, INTENT, { ...intent, state: 'selected' });
  return selectedDurableSqlite(directory)!;
}
