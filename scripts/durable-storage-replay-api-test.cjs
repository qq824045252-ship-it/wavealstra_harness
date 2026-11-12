/** Candidate API test. Never patches installed dependencies or touches real journals.
 * Run explicitly: node scripts/durable-storage-replay-api-test.cjs
 * Copies the pinned package, applies the candidate patch there, and transpiles only the test driver facade.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '..');
const url = p => pathToFileURL(p).href;
async function snapshot(dir) {
  const result = {};
  for (const item of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    result[item.name] = item.isDirectory() ? await snapshot(path.join(dir, item.name)) : (await fs.readFile(path.join(dir, item.name))).toString('base64');
  }
  return result;
}
(async () => {
  const base = process.env.DURABLE_API_TEST_TMP ?? require('node:os').tmpdir();
  await fs.mkdir(base, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(base, 'durable-api-'));
  try {
    const installed = path.dirname(path.dirname(require.resolve('@earendil-works/pi-durable')));
    const manifest = JSON.parse(await fs.readFile(path.join(installed, 'package.json'), 'utf8'));
    const launcher = await fs.readFile(path.join(repo, 'src/main/capabilities/subagent/worker-launcher.mjs'), 'utf8');
    const pinned = launcher.match(/EXPECTED_PI_VERSION\s*=\s*['"]([^'"]+)/)?.[1];
    assert.equal(manifest.version, pinned, 'test only the current pinned SDK');
    const pkg = path.join(tmp, 'package');
    await fs.mkdir(pkg);
    await fs.cp(path.join(installed, 'dist'), path.join(pkg, 'dist'), { recursive: true });
    await fs.copyFile(path.join(installed, 'package.json'), path.join(pkg, 'package.json'));
    await fs.symlink(path.join(repo, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');
    const patch = path.join(repo, `patches/@earendil-works__pi-durable@${pinned}.patch`);
    const alreadyPatched = (await fs.readFile(path.join(pkg, 'dist/storage/sqlite/storage.js'), 'utf8')).includes('replayCommitForImport');
    if (!alreadyPatched) {
      const apply = spawnSync('git', ['apply', patch], { cwd: pkg, encoding: 'utf8' });
      assert.equal(apply.status, 0, apply.stderr);
    }
    const facadeSource = await fs.readFile(path.join(repo, 'src/main/agent/durable/DurableSqliteDatabase.ts'), 'utf8');
    const facadePath = path.join(tmp, 'facade.mjs');
    await fs.writeFile(facadePath, esbuild.transformSync(facadeSource, { loader: 'ts', target: 'es2022', format: 'esm' }).code);
    const { DurableSqliteDatabase: DB } = await import(url(facadePath));
    const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
    const { SqliteStorage: SQL, CURRENT_SQLITE_SCHEMA_VERSION: schemaVersion } = await import(url(path.join(pkg, 'dist/storage/sqlite/index.js')));
    const { openNodeJsonlStorage: jsonl } = await import(url(path.join(pkg, 'dist/storage/jsonl/node.js')));
    const { openNodeJsonlStorage: originalJsonl } = await import('@earendil-works/pi-durable/storage/jsonl/node');
    const data = path.join(tmp, 'data'); await fs.mkdir(data);
    const source = path.join(data, 'source');
    const journal = await originalJsonl(source, ctx);
    const doc = (id, scope, history = 'latest') => ({ id, kind: `fixture-${id}`, scope, history, fork: 'asOf' });
    const baseWrite = (record, value) => ({ type: 'document.create', record, content: { kind: 'base', version: 1, value } });
    const change = (id, value) => ({ type: 'document.change', id, content: { kind: 'base', version: 1, value } });
    const task = status => ({ id: 30, conversationId: 2, kind: 'fixture', version: 1, input: {}, background: false, abortRequested: false,
      state: status === 'terminal' ? { status, outcome: { kind: 'success', value: 'done' } } : { status, checkpoint: { exact: 'task state' } } });
    const commit = async writes => { const result = await journal.commit([writes], () => {}, ctx); assert.equal(result.stored, 1, String(result.refused)); };
    await commit([{ type: 'conversation', value: { id: 2 } },
      { type: 'entry', value: { id: 10, conversationId: 2, kind: 'original', data: '原文\nexact' } },
      baseWrite(doc(20, { kind: 'conversation', conversationId: 2 }, 'rewindable'), { text: 'before' }),
      baseWrite(doc(21, { kind: 'session' }), { old: true }),
      baseWrite(doc(22, { kind: 'task', taskId: 30 }), { old: true }),
      baseWrite(doc(23, { kind: 'session' }), { retire: true }),
      { type: 'task', value: task('running') }]);
    await commit([change(21, { current: 'session' }), change(22, { current: 'task' }), change(20, { text: 'after' })]);
    await commit([change(21, { current: 'session newest' })]);
    await commit([{ type: 'task', value: task('terminal') }]);
    await commit([{ type: 'conversation', value: { id: 3, parent: { conversationId: 2, at: 10 } } },
      { type: 'document.copy', record: { ...doc(24, { kind: 'conversation', conversationId: 3 }, 'rewindable'), kind: 'fixture-20' }, source: { id: 20, at: 1 } },
      { type: 'document.retire', id: 23 }]);
    await commit([]);
    await journal.close(ctx);
    // Synthetic gap fixture: alter all persisted marker/sidecar sequence numbers consistently.
    for (const name of await fs.readdir(source)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(source, name);
      const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(s => { const x = JSON.parse(s); x.seq *= 3; return JSON.stringify(x); });
      await fs.writeFile(file, lines.length ? lines.join('\n') + '\n' : '');
    }
    const before = await snapshot(source);
    const referenceDir = path.join(data, 'reference'); await fs.cp(source, referenceDir, { recursive: true });
    const reference = await originalJsonl(referenceDir, ctx);
    const copy = path.join(data, 'migration-copy'); await fs.cp(source, copy, { recursive: true });
    const sqlitePath = path.join(data, 'target.sqlite');
    let target = await SQL.open(await DB.open(sqlitePath));
    const recovered = [];
    const exported = await jsonl(copy, ctx, { onRecoveredCommit: async batch => { recovered.push(structuredClone(batch)); await target.replayCommitForImport(batch); batch.writes.length = 0; } });
    assert.deepEqual(recovered.map(x => x.seq), [3,6,9,12,15,18]);
    assert(recovered.some(x => x.writes.length === 0), 'reclaimed/empty commits must be exported');
    for (const id of [10, 999]) assert.deepEqual(await target.entry(id, ctx), await reference.entry(id, ctx));
    assert.equal((await target.entry(10, ctx)).commitSeq, 3);
    for (const id of [20,21,22,23,24]) for (const at of [3,6,9,12,15,18,'current']) {
      const outcomes = await Promise.allSettled([target.document(id, at, ctx), reference.document(id, at, ctx)]);
      assert.equal(outcomes[0].status, outcomes[1].status, `document ${id}@${at}`);
      if (outcomes[0].status === 'fulfilled') assert.deepEqual(outcomes[0].value, outcomes[1].value, `document ${id}@${at}`);
      else assert.equal(outcomes[0].reason.message, outcomes[1].reason.message);
    }
    for (const order of ['ascending','descending']) assert.deepEqual(await target.scanEntries({ conversationId: 3, order }, 2, undefined, ctx), await reference.scanEntries({ conversationId: 3, order }, 2, undefined, ctx));
    assert.deepEqual(await target.task(30, ctx), await reference.task(30, ctx));
    assert.deepEqual(await exported.task(30, ctx), await reference.task(30, ctx), 'callback cannot mutate recovery state');
    assert.equal(await target.mintId(), await reference.mintId());
    for (const seq of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,18,3]) await assert.rejects(target.replayCommitForImport({ seq, writes: [] }));
    await assert.rejects(target.replayCommitForImport({ seq: 19, writes: [{ type: 'entry', value: { id: 50, conversationId: 2, kind: 'x', data: 'must roll back' } }, { type: 'conversation', value: { id: 20 } }] }));
    assert.equal(await target.entry(50, ctx), undefined);
    const receipts = [];
    assert.deepEqual(await target.commit([[]], (_, seq) => receipts.push(seq), ctx), { stored: 1 });
    assert.deepEqual(receipts, [19]);
    await target.close(ctx); await reference.close(ctx); await exported.close(ctx);
    assert.deepEqual(await snapshot(source), before, 'source immutable');
    // Official no-migration read-only open: physical bytes + directory entries invariant, writes throw.
    const sqliteBefore = await fs.readFile(sqlitePath); const names = await fs.readdir(data);
    target = await SQL.openReadOnly(await DB.open(sqlitePath, { readonly: true }));
    assert.equal((await target.entry(10, ctx)).commitSeq, 3);
    await assert.rejects(target.commit([[]], () => assert.fail('receipt on read-only'), ctx), /read-only/);
    await assert.rejects(target.mintId(), /read-only/);
    await assert.rejects(target.replayCommitForImport({ seq: 20, writes: [] }), /read-only/);
    await target.close(ctx);
    assert.deepEqual(await fs.readFile(sqlitePath), sqliteBefore); assert.deepEqual(await fs.readdir(data), names);
    // Exact schema, metadata and prefix rejection must close the owned facade and never migrate.
    for (const sql of [
      `UPDATE durable_schema SET version = ${schemaVersion-1}`, `UPDATE durable_schema SET version = ${schemaVersion+1}`,
      'DELETE FROM durable_schema', 'DROP TABLE durable_schema', 'DELETE FROM durable_metadata',
      "UPDATE durable_metadata SET next_id = 'NaN'", "UPDATE durable_metadata SET next_id = '01'", 'UPDATE durable_metadata SET next_seq = 0',
    ]) {
      const invalidPath = path.join(data, 'invalid.sqlite'); await fs.copyFile(sqlitePath, invalidPath);
      const edit = await DB.open(invalidPath); await edit.exec(sql); await edit.close();
      const bytes = await fs.readFile(invalidPath); const db = await DB.open(invalidPath, { readonly: true });
      await assert.rejects(SQL.openReadOnly(db)); await assert.rejects(db.get('SELECT 1'), /closed/);
      assert.deepEqual(await fs.readFile(invalidPath), bytes);
    }
    const exhaustedPath = path.join(data, 'exhausted.sqlite'); await fs.copyFile(sqlitePath, exhaustedPath);
    const exhaustedEdit = await DB.open(exhaustedPath);
    await exhaustedEdit.run('UPDATE durable_metadata SET next_id = ?, next_seq = ?', String(Number.MAX_SAFE_INTEGER + 1), Number.MAX_SAFE_INTEGER + 1);
    await exhaustedEdit.close();
    const exhausted = await SQL.openReadOnly(await DB.open(exhaustedPath, { readonly: true }));
    assert.equal((await exhausted.entry(10, ctx)).commitSeq, 3); await exhausted.close(ctx);
    const invalidPrefix = await DB.open(sqlitePath, { readonly: true });
    await assert.rejects(SQL.openReadOnly(invalidPrefix, { prefix: 'bad;DROP TABLE entries' }));
    await assert.rejects(invalidPrefix.get('SELECT 1'), /closed/);
    const prefixedPath = path.join(data, 'prefix.sqlite');
    const prefixed = await SQL.open(await DB.open(prefixedPath), { prefix: 'test_' }); await prefixed.close(ctx);
    const prefixedRO = await SQL.openReadOnly(await DB.open(prefixedPath, { readonly: true }), { prefix: 'test_' }); await prefixedRO.close(ctx);
    // Failure after actual writes rolls back rows, next_id and next_seq; retry same seq can succeed.
    const raw = await DB.open(sqlitePath); let inject = true;
    const faulty = Object.create(raw);
    faulty.transaction = cb => raw.transaction(tx => cb({ ...tx, run: async (sql, ...args) => { await tx.run(sql, ...args); if (inject && sql.startsWith('UPDATE durable_metadata')) throw new Error('injected write failure'); } }));
    target = await SQL.open(faulty);
    const nextBefore = await raw.get('SELECT * FROM durable_metadata');
    await assert.rejects(target.replayCommitForImport({ seq: 25, writes: [{ type: 'entry', value: { id: 80, conversationId: 2, kind: 'fault', data: 'rollback' } }] }), /injected/);
    assert.equal(await target.entry(80, ctx), undefined); assert.deepEqual(await raw.get('SELECT * FROM durable_metadata'), nextBefore);
    inject = false; await target.replayCommitForImport({ seq: 25, writes: [] }); await target.close(ctx);
    // Normal recovery behavior is unchanged for torn tails, confirmed corruption and callback failure.
    for (const mode of ['torn', 'corrupt', 'missing', 'unconfirmed', 'interleaved']) {
      const src = path.join(data, mode); await fs.cp(source, src, { recursive: true });
      if (mode === 'torn') await fs.appendFile(path.join(src, 'main.jsonl'), '{"torn":');
      if (mode === 'corrupt') await fs.appendFile(path.join(src, 'main.jsonl'), '{"invalid":true}\n');
      if (mode === 'missing') await fs.rm(path.join(src, 'doc-20.jsonl'));
      if (mode === 'unconfirmed' || mode === 'interleaved') {
        const sidecar = path.join(src, 'doc-20.jsonl');
        const lines = (await fs.readFile(sidecar, 'utf8')).trim().split('\n');
        const extra = JSON.parse(lines[0]); extra.seq = mode === 'unconfirmed' ? 999 : 4;
        if (mode === 'unconfirmed') lines.push(JSON.stringify(extra));
        else lines.splice(1, 0, JSON.stringify(extra));
        await fs.writeFile(sidecar, lines.join('\n') + '\n');
      }
      const pristine = await snapshot(src); const a = src + '-a'; const b = src + '-b';
      await fs.cp(src,a,{recursive:true}); await fs.cp(src,b,{recursive:true});
      const results = await Promise.allSettled([originalJsonl(a,ctx),jsonl(b,ctx,{onRecoveredCommit:()=>{}})]);
      assert.equal(results[0].status,results[1].status);
      assert.equal(results[0].status, ['torn','unconfirmed'].includes(mode) ? 'fulfilled' : 'rejected', mode);
      for (const result of results) if(result.status === 'fulfilled') await result.value.close(ctx);
      assert.deepEqual(await snapshot(a), await snapshot(b)); assert.deepEqual(await snapshot(src),pristine);
    }
    const aborted = path.join(data,'aborted'); await fs.cp(source,aborted,{recursive:true});
    await assert.rejects(jsonl(aborted,ctx,{onRecoveredCommit:()=>{throw new Error('stop export');}}),/stop export/);
    assert.deepEqual(await snapshot(source),before);
    console.log('PASS candidate Durable replay APIs: normalized recovery, reclaimed/session/task/fork history, seq gaps/empty commits, read-only schema/bytes, rollback, source immutability');
  } finally { await fs.rm(tmp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
