/** Candidate driver only: no production backend switch, JSONL migration, or model calls. */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { JsonValue } from '@earendil-works/chord';
import { SqliteStorage, type SqliteExecutor } from '@earendil-works/pi-durable/storage/sqlite';
import { MemoryStorage, type ConversationId, type EntryId, type DocumentId, type TaskId, type SubmissionId, type Seq, type StorageWrite } from '@earendil-works/pi-durable';
import { DurableSqliteDatabase } from '../src/main/agent/durable/DurableSqliteDatabase';

const conversationId = 2 as ConversationId;
const forkId = 3 as ConversationId;
const documentId = 4 as DocumentId;
const original = (id: number) => ({ id: id as EntryId, conversationId, kind: 'original', data: `EXACT_${id} /tmp/原文 🧭\n` + 'archive '.repeat(128) });
if (process.argv[2] === '--cold') {
  const db = await DurableSqliteDatabase.open(process.argv[3]!);
  const store = await SqliteStorage.open(db);
  assert.deepEqual((await store.entry(1500 as EntryId, ctx))?.entry, original(1500));
  const plan = await db.all<{ detail: string }>('EXPLAIN QUERY PLAN SELECT record FROM entries WHERE id = ?', 1500);
  assert(plan.some(row => /SEARCH.*INTEGER PRIMARY KEY/.test(row.detail)));
  assert(!plan.some(row => /SCAN entries/.test(row.detail)));
  const page = await store.scanEntries({ conversationId, order: 'descending' }, 3, undefined, ctx);
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0]?.id, 2099);
  await store.close(ctx);
  console.log('process-cold official storage indexed retrieval PASS');
} else {
  const root = process.env.DURABLE_SQLITE_TEST_TMP ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'sqlite-adapter-'));
  try {
    const db = await DurableSqliteDatabase.open(join(directory, 'driver.db'));
    await db.exec('CREATE TABLE example (id INTEGER PRIMARY KEY, value BLOB)');
    assert.equal(await db.runCounted('INSERT INTO example VALUES (?, ?)', 1, new Uint8Array([0, 255])), 1);
    assert.deepEqual(Array.from((await db.get<{ value: Uint8Array }>('SELECT value FROM example WHERE id = ?', 1))!.value), [0, 255]);
    let expired!: SqliteExecutor;
    const failure = new Error('callback rejection');
    await assert.rejects(db.transaction(async tx => {
      expired = tx;
      await tx.run('INSERT INTO example VALUES (?, ?)', 2, null);
      throw failure;
    }), error => error === failure);
    assert.equal(await db.get('SELECT * FROM example WHERE id = 2'), undefined);
    await assert.rejects(expired.get('SELECT 1'), /no longer active/);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = db.transaction(async tx => {
      await tx.run('INSERT INTO example VALUES (?, ?)', 3, 'committed');
      entered();
      await barrier;
    });
    await started;
    let outsideFinished = false;
    const outside = db.get('SELECT * FROM example WHERE id = 3').then(row => { outsideFinished = true; return row; });
    await Promise.resolve();
    assert.equal(outsideFinished, false);
    release();
    await pending;
    assert.deepEqual(await outside, { id: 3, value: 'committed' });
    await db.close();
    await db.close();
    await assert.rejects(db.get('SELECT 1'), /closed/);

    const path = join(directory, 'session.durable.sqlite');
    let store = await SqliteStorage.open(await DurableSqliteDatabase.open(path));
    const memory = new MemoryStorage();
    const commit = async (writes: StorageWrite[]) => {
      const observed: number[] = [];
      const expected: number[] = [];
      assert.deepEqual(await store.commit([writes], (_, seq) => observed.push(seq), ctx),
        await memory.commit([writes], (_, seq) => expected.push(seq), ctx));
      assert.deepEqual(observed, expected);
      return observed[0]! as Seq;
    };
    const first = await commit([
      { type: 'conversation', value: { id: conversationId } },
      { type: 'task', value: { id: 5 as TaskId<JsonValue>, conversationId, kind: 'fixture', version: 1, input: {}, background: false, abortRequested: false, state: { status: 'sleeping', checkpoint: { exact: '保存' }, until: 12345 } } },
      { type: 'submission', value: { id: 6 as SubmissionId, conversationId, requestId: 'request-26', type: 'input', status: 'queued' } },
      { type: 'document.create', record: { id: documentId, kind: 'ledger', scope: { kind: 'conversation', conversationId }, history: 'rewindable', fork: 'asOf' }, content: { kind: 'base', version: 1, value: { value: 'before' } } },
      ...Array.from({ length: 2000 }, (_, n): StorageWrite => ({ type: 'entry', value: original(n + 100) })),
    ]);
    const second = await commit([
      { type: 'conversation', value: { id: forkId, parent: { conversationId, at: 1000 as EntryId } } },
      { type: 'document.change', id: documentId, content: { kind: 'base', version: 1, value: { value: 'after' } } },
    ]);
    // Cross-kind ID collision refuses the whole batch; the preceding new entry must not leak.
    await commit([{ type: 'entry', value: original(3000) }, { type: 'conversation', value: { id: documentId as unknown as ConversationId } }]);
    assert.equal(await store.entry(3000 as EntryId, ctx), undefined);
    await store.close(ctx);
    store = await SqliteStorage.open(await DurableSqliteDatabase.open(path));
    for (const at of [first, second, 'current'] as const) {
      assert.deepEqual(await store.document(documentId, at, ctx), await memory.document(documentId, at, ctx));
    }
    assert.deepEqual(await store.entry(1500 as EntryId, ctx), await memory.entry(1500 as EntryId, ctx));
    assert.deepEqual(await store.task(5 as TaskId, ctx), await memory.task(5 as TaskId, ctx));
    assert.deepEqual(await store.submissionByRequest(conversationId, 'request-26', ctx), await memory.submissionByRequest(conversationId, 'request-26', ctx));
    const query = { conversationId: forkId, order: 'descending' as const };
    assert.deepEqual(await store.scanEntries(query, 7, undefined, ctx), await memory.scanEntries(query, 7, undefined, ctx));
    assert((await store.mintId()) > 2099);
    await store.close(ctx);
    const cold = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--cold', path], { encoding: 'utf8' });
    assert.equal(cold.status, 0, cold.stderr + cold.stdout);
    process.stdout.write(cold.stdout);

    // A cleanly closed artifact is byte-identical after passive reads and rejected writes.
    const before = await readFile(path);
    const names = (await readdir(directory)).sort();
    const readonly = await DurableSqliteDatabase.open(path, { readonly: true });
    assert(await readonly.get('SELECT record FROM entries WHERE id = ?', 1500));
    await readonly.transaction(async tx => { assert(await tx.get('SELECT record FROM entries WHERE id = ?', 1500)); });
    await assert.rejects(readonly.run('DELETE FROM entries'));
    await readonly.close();
    assert.deepEqual(await readFile(path), before);
    assert.deepEqual((await readdir(directory)).sort(), names);
    // Public SDK open currently migrates even a current schema: do not silently swallow those writes.
    await assert.rejects(SqliteStorage.open(await DurableSqliteDatabase.open(path, { readonly: true })));
    assert.deepEqual(await readFile(path), before);
    await assert.rejects(DurableSqliteDatabase.open(join(directory, 'missing', 'session.sqlite'), { readonly: true }));
    const walPath = join(directory, 'unsupported-wal.sqlite');
    const wal = new Database(walPath);
    wal.pragma('journal_mode = WAL');
    wal.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY)');
    wal.close();
    const walBytes = await readFile(walPath);
    const walNames = (await readdir(directory)).sort();
    for (const readonly of [true, false]) {
      await assert.rejects(DurableSqliteDatabase.open(walPath, { readonly }), /WAL.*not supported/);
    }
    assert.deepEqual(await readFile(walPath), walBytes);
    assert.deepEqual((await readdir(directory)).sort(), walNames);
    console.log('durable SQLite candidate: queue, rollback, expired handles, persistence, sequences, rewindable history, fork ancestry, global IDs, passive facade PASS');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
