import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mock } from 'node:test';
import { DurableSqliteDatabase } from '../src/main/agent/durable/DurableSqliteDatabase';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { DurableBotRuntime } from '../src/main/agent/durable/DurableBotRuntime';

const root = mkdtempSync(join(tmpdir(), 'durable-sqlite-close-retry-'));
const nativeClose = Database.prototype.close;
try {
  const longParent = join(root, 'parent-'.repeat(14));
  const longDirectory = join(longParent, 'child-'.repeat(17));
  const longFile = join(longDirectory, 'durable.sqlite');
  assert(longFile.length > 260, 'fixture exercises native Windows paths beyond MAX_PATH');
  let longWriter: DurableSqliteDatabase | undefined;
  let longReader: DurableSqliteDatabase | undefined;
  try {
    longWriter = await DurableSqliteDatabase.open(longFile);
    await longWriter.exec('CREATE TABLE long_path(value INTEGER)');
    await longWriter.run('INSERT INTO long_path VALUES (?)', 42);
    await longWriter.close();
    longWriter = undefined;
    longReader = await DurableSqliteDatabase.open(longFile, { readonly: true, snapshot: true });
    assert.deepEqual(await longReader.get('SELECT value FROM long_path'), { value: 42 });
    await longReader.close();
    longReader = undefined;
    console.log('PASS production native SQLite long path: create, write, close and read-only reopen beyond MAX_PATH');
  } finally {
    await longReader?.close();
    await longWriter?.close();
    // Remove the known deep leaf directly; Windows recursive-directory walkers
    // can themselves lose the extended-path prefix on long child entries.
    rmSync(longFile, { force: true });
    if (existsSync(longDirectory)) rmdirSync(longDirectory);
    if (existsSync(longParent)) rmdirSync(longParent);
  }
  for (const failureStage of ['before', 'after'] as const) {
    const file = join(root, `${failureStage}.db`);
    const seed = await DurableSqliteDatabase.open(file);
    await seed.exec('CREATE TABLE records(value INTEGER)');
    await seed.close();
    const reader = await DurableSqliteDatabase.open(file, { readonly: true, snapshot: true });
    await reader.get('SELECT COUNT(*) AS count FROM records');
    let writer: DurableSqliteDatabase | undefined;
    let attempts = 0;
    let handle: Database.Database | undefined;
    const failure = new Error(`fixture native close failed ${failureStage} release`);
    const closing = mock.method(Database.prototype, 'close', function (this: Database.Database) {
      handle = this;
      attempts++;
      if (attempts === 1 && failureStage === 'before') throw failure;
      const result = nativeClose.call(this);
      if (attempts === 1) throw failure;
      return result;
    });
    try {
      const first = reader.close();
      assert.strictEqual(reader.close(), first, 'concurrent callers observe the same native close outcome');
      await assert.rejects(first, error => error === failure);
      assert.equal(handle?.open, failureStage === 'before');
      await assert.rejects(reader.get('SELECT 1'), /closing|closed/);
      await assert.rejects(reader.exec('SELECT 1'), /closing|closed/);
      await assert.rejects(reader.transaction(async tx => tx.get('SELECT 1')), /closing|closed/);

      // Open after the failure: the retained snapshot must still belong to the
      // same local gate, not a new gate created after premature deregistration.
      writer = await DurableSqliteDatabase.open(file, { busyTimeoutMs: 0 });
      let written = false;
      const write = writer.run('INSERT INTO records VALUES (1)').then(() => { written = true; });
      await nextTurn();
      if (failureStage === 'before') assert.equal(written, false, 'snapshot/gate remain owned until native handle closes');
      else await write;

      const retry = reader.close();
      if (failureStage === 'before') assert.strictEqual(reader.close(), retry);
      await retry;
      await write;
      assert.equal(handle?.open, false);
      assert.equal(attempts, failureStage === 'before' ? 2 : 1, 'retry closes an open native handle, never an already released handle');
      assert.equal(written, true);
      await reader.close();
      assert.equal(attempts, failureStage === 'before' ? 2 : 1);
      console.log(`PASS production better-sqlite3 close ${failureStage} release: shared outcome, retry, admission seal, snapshot and local gate ownership`);
    } finally {
      closing.mock.restore();
      await reader.close();
      await writer?.close();
    }
  }

  const database = await DurableSqliteDatabase.open(':memory:');
  try {
    let entered = () => {};
    const started = new Promise<void>(resolve => { entered = resolve; });
    let finish = () => {};
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const transaction = database.transaction(async tx => {
      entered();
      await barrier;
      await tx.exec('CREATE TABLE admitted(value INTEGER)');
    });
    await started;
    let ended = false;
    const close = database.close();
    void close.then(() => { ended = true; });
    assert.strictEqual(database.close(), close);
    await assert.rejects(database.get('SELECT 1'), /closing|closed/);
    await nextTurn();
    assert.equal(ended, false, 'close waits for work admitted before it sealed the queue');
    finish();
    await transaction;
    await close;
    console.log('PASS production close drains admitted transaction, rejects new calls and is concurrent-idempotent');
  } finally { await database.close(); }

  for (const failureStage of ['before', 'after'] as const) {
    const directory = join(root, `runtime-${failureStage}`);
    const models = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null,
      modelsStorePath: join(root, 'models.json'), refreshOnCreate: false });
    let modelCalls = 0;
    models.registerProvider('fixture', { api: 'openai-completions', apiKey: 'fixture-only', baseUrl: 'http://127.0.0.1:1',
      models: [{ id: 'close', name: 'close', reasoning: false, input: ['text'], contextWindow: 128000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple: () => { modelCalls++; throw Error('closing must not invoke a model'); } });
    // No injected storage: exercise the production SQLite selector, driver and lease.
    const runtime = await DurableBotRuntime.open({ directory, cwd: root, models,
      model: { provider: 'fixture', modelId: 'close' }, toolMode: 'native', instructions: () => '', onSnapshot: () => {} });
    let attempts = 0, stopped = 0;
    let handle: Database.Database | undefined;
    runtime.harness.subscribeClose(() => { stopped++; });
    const failure = new Error(`fixture production runtime close ${failureStage} release`);
    const closing = mock.method(Database.prototype, 'close', function (this: Database.Database) {
      // Passive projection viewers own separate read-only connections. Inject
      // only the writer whose release controls the runtime's session lease.
      if (this.readonly || handle && this !== handle) return nativeClose.call(this);
      handle = this;
      attempts++;
      if (attempts === 1 && failureStage === 'before') throw failure;
      const result = nativeClose.call(this);
      if (attempts === 1) throw failure;
      return result;
    });
    try {
      const first = runtime.close();
      assert.strictEqual(runtime.close(), first);
      await assert.rejects(first, error => error === failure);
      assert.equal(handle?.open, failureStage === 'before');
      assert.equal(existsSync(join(directory, '.mybuddy-owner.json')), true, 'runtime retains ownership until cleanup is confirmed');
      assert.equal((await runtime.harness.closed).kind, 'failed');
      await assert.rejects(runtime.submit('must not run', 'after-close'), /closing|closed/);
      await assert.rejects(runtime.harness.commit(async () => undefined, ctx), /closed|SessionFailed/);
      const retry = runtime.close();
      assert.strictEqual(runtime.close(), retry);
      await retry;
      assert.equal(handle?.open, false);
      assert.equal(attempts, failureStage === 'before' ? 2 : 1);
      assert.equal(stopped, 1, 'storage cleanup retry never restarts execution shutdown');
      assert.equal(existsSync(join(directory, '.mybuddy-owner.json')), false);
      assert.equal((await runtime.harness.closed).kind, 'failed', 'original failure remains observable');
      await runtime.close();
      assert.equal(attempts, failureStage === 'before' ? 2 : 1);
      assert.equal(modelCalls, 0);
      console.log(`PASS production Runtime → Session → better-sqlite3 ${failureStage} release: true lease, retry, concurrency and sealed admission`);
    } finally {
      closing.mock.restore();
      await runtime.close();
    }
  }
} finally {
  mock.restoreAll();
  rmSync(root, { recursive: true, force: true });
}
