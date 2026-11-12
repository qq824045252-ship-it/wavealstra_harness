/** Current-format storage only: real SQLite, owned discard, passive reads and process crashes. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '..');
const signature = async file => ({ bytes: createHash('sha256').update(await fs.readFile(file)).digest('hex'), mtime: (await fs.stat(file)).mtimeMs });
const load = async bundle => ({ ...(await import(pathToFileURL(bundle).href)), ...(await import('@earendil-works/chord/context')) });

if (process.argv[2] === '--init-child') {
  (async () => {
    const [bundle, directory, boundary] = process.argv.slice(3), rename = fs.rename;
    fs.rename = async (from, to) => {
      const selector = path.basename(String(to)) === '.mybuddy-storage.json';
      if (selector && boundary === 'before-selector') { process.stdout.write('BOUNDARY\n'); await new Promise(() => {}); }
      await rename(from, to);
      if (selector && boundary === 'after-selector') { process.stdout.write('BOUNDARY\n'); await new Promise(() => {}); }
    };
    syncBuiltinESMExports();
    const api = await load(bundle);
    await api.openDurableStorage(directory, api.BACKGROUND_CONTEXT);
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else (async () => {
  const base = process.env.TMPDIR || require('node:os').tmpdir();
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'ds-current-'));
  const bundle = path.join(repo, 'out/tests/durable-storage-current-fixture.mjs');
  const handles = new Set();
  try {
    await esbuild.build({ stdin: { contents: `export * from './src/main/agent/durable/DurableStorage.ts'; export * from './src/main/agent/durable/DurableStorageFormat.ts'; export { DurableSqliteDatabase as TestDatabase } from './src/main/agent/durable/DurableSqliteDatabase.ts';`, resolveDir: repo, loader: 'ts' },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    const api = await load(bundle), ctx = api.BACKGROUND_CONTEXT;
    const { CURRENT_SQLITE_SCHEMA_VERSION } = await import('@earendil-works/pi-durable/storage/sqlite');
    const Database = require('better-sqlite3');
    const currentSelector = { format: 1, backend: 'sqlite', file: 'durable.sqlite' };
    const initialization = { ...currentSelector, schemaVersion: CURRENT_SQLITE_SCHEMA_VERSION };
    const folder = async name => { const directory = path.join(root, name); await fs.mkdir(directory); return directory; };
    const open = async directory => { const handle = await api.openDurableStorage(directory, ctx); handles.add(handle); return handle; };
    const close = async handle => { try { await handle.storage.close(ctx); } finally { handle.lease?.release(); handles.delete(handle); } };
    const write = (directory, name, value) => fs.writeFile(path.join(directory, name), typeof value === 'string' ? value : JSON.stringify(value));
    const schema = async directory => { const db = new Database(path.toNamespacedPath(path.join(directory, 'durable.sqlite')), { readonly: true }); try { return db.prepare('SELECT version FROM durable_schema WHERE singleton=1').get().version; } finally { db.close(); } };

    const current = await folder('current');
    const first = await open(current);
    assert.equal((await first.storage.commit([[{ type: 'conversation', value: { id: 2 } },
      { type: 'entry', value: { id: 3, conversationId: 2, kind: 'original', data: { exact: 'CURRENT_EFFECT_RECORDED' } } }]], () => {}, ctx)).stored, 1);
    await close(first);
    const selectedFile = path.join(current, api.SELECTOR), databaseFile = path.join(current, 'durable.sqlite');
    const before = { selector: await signature(selectedFile), database: await signature(databaseFile) };
    const reopened = await open(current);
    assert.equal((await reopened.storage.entry(3, ctx)).entry.data.exact, 'CURRENT_EFFECT_RECORDED');
    await close(reopened);
    assert.deepEqual(await signature(selectedFile), before.selector, 'a valid current selector is not rewritten');
    assert.deepEqual(await signature(databaseFile), before.database, 'a valid current database is not reinitialized');
    const passiveBefore = await fs.readdir(current), reader = await api.openDurablePassiveStorage(current, ctx);
    assert(reader); assert.equal((await reader.entry(3, ctx)).entry.data.exact, 'CURRENT_EFFECT_RECORDED'); await reader.close(ctx);
    assert.deepEqual(await fs.readdir(current), passiveBefore);
    assert.deepEqual(await signature(databaseFile), before.database);
    assert.equal(await schema(current), CURRENT_SQLITE_SCHEMA_VERSION);
    console.log('PASS current official SQLite, exact persisted records, restart and physically passive reads');

    const obsolete = await folder('old-owned');
    await write(obsolete, 'main.jsonl', 'old data must be deleted, not interpreted');
    await write(obsolete, 'doc-1.jsonl', 'old sidecar');
    await write(obsolete, 'task-2.jsonl', 'old task data');
    await write(obsolete, 'main.jsonl.bak-previous', 'old backup');
    await write(obsolete, api.SELECTOR, { format: 0, backend: 'jsonl', file: 'main.jsonl' });
    await write(obsolete, '.mybuddy-storage-intent.json', { old: true });
    await write(obsolete, 'notes.txt', 'unrelated user file');
    const stage = '.mybuddy-migration-' + randomUUID(); await fs.mkdir(path.join(obsolete, stage));
    await write(path.join(obsolete, stage), 'owner.json', { format: 1, backend: 'sqlite', stage, source: {}, state: 'copying' });
    await write(path.join(obsolete, stage), 'old-copy.jsonl', 'owned old staging payload');
    const oldBefore = await signature(path.join(obsolete, 'main.jsonl'));
    assert.equal(await api.openDurablePassiveStorage(obsolete, ctx), undefined);
    assert.deepEqual(await signature(path.join(obsolete, 'main.jsonl')), oldBefore, 'passive open does not delete old data');
    const replaced = await open(obsolete); assert.equal((await replaced.storage.scanConversations({}, 10, undefined, ctx)).items.length, 0); await close(replaced);
    const remaining = await fs.readdir(obsolete);
    assert(!remaining.some(name => name.endsWith('.jsonl') || name.includes('bak-') || name === stage || name.includes('discarded')));
    assert.equal(await fs.readFile(path.join(obsolete, 'notes.txt'), 'utf8'), 'unrelated user file');
    assert.equal(await schema(obsolete), CURRENT_SQLITE_SCHEMA_VERSION);
    console.log('PASS old JSONL, selector and positively owned staging are deleted without import or backup');

    const oldDatabase = await folder('old-schema');
    const old = new Database(path.toNamespacedPath(path.join(oldDatabase, 'durable.sqlite')));
    old.exec('CREATE TABLE durable_schema(singleton INTEGER PRIMARY KEY,version INTEGER); CREATE TABLE old_payload(secret TEXT); INSERT INTO old_payload VALUES (\'OLD\')');
    old.prepare('INSERT INTO durable_schema VALUES(1,?)').run(CURRENT_SQLITE_SCHEMA_VERSION - 1); old.close();
    await write(oldDatabase, api.SELECTOR, currentSelector);
    const reset = await open(oldDatabase); await close(reset);
    assert.equal(await schema(oldDatabase), CURRENT_SQLITE_SCHEMA_VERSION);
    const inspect = new Database(path.toNamespacedPath(path.join(oldDatabase, 'durable.sqlite')), { readonly: true });
    assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE name='old_payload'").get(), undefined); inspect.close();
    assert(!(await fs.readdir(oldDatabase)).some(name => name.includes('discarded') || name.includes('backup')));
    console.log('PASS old SQLite schema is deleted instead of migrated');

    await fs.unlink(selectedFile); await write(current, '.mybuddy-storage-init.json', initialization);
    const unpublished = await signature(databaseFile), recovered = await open(current);
    assert.equal((await recovered.storage.entry(3, ctx)).entry.data.exact, 'CURRENT_EFFECT_RECORDED'); await close(recovered);
    assert.deepEqual(await signature(databaseFile), unpublished, 'committed current facts survive lost selector publication');
    assert.deepEqual(JSON.parse(await fs.readFile(selectedFile, 'utf8')), currentSelector);
    const empty = await folder('empty-initialization'); await write(empty, 'durable.sqlite', ''); await write(empty, '.mybuddy-storage-init.json', initialization);
    const completed = await open(empty); await close(completed); assert.equal(await schema(empty), CURRENT_SQLITE_SCHEMA_VERSION);
    const selectedEmpty = await folder('selected-empty'); await write(selectedEmpty, 'durable.sqlite', ''); await write(selectedEmpty, api.SELECTOR, currentSelector);
    await assert.rejects(open(selectedEmpty), /Empty|empty/); assert.equal((await fs.stat(path.join(selectedEmpty, 'durable.sqlite'))).size, 0);
    const unownedEmpty = await folder('unowned-empty'); await write(unownedEmpty, 'durable.sqlite', '');
    await assert.rejects(open(unownedEmpty), /Empty|empty/);
    console.log('PASS lost current selector and owned initialization recover; empty current or unowned artifacts fail closed');

    const orphan = await folder('orphan-sidecars');
    for (const suffix of ['-wal', '-shm', '-journal']) await write(orphan, 'durable.sqlite' + suffix, 'obsolete orphan journal must not replay');
    const orphanHandle = await open(orphan); await close(orphanHandle);
    assert.equal(await schema(orphan), CURRENT_SQLITE_SCHEMA_VERSION);
    assert(!(await fs.readdir(orphan)).some(name => /^durable\.sqlite-(wal|shm|journal)$/.test(name)));
    const broken = await folder('current-corrupt-metadata'), healthy = await open(broken); await close(healthy);
    const corruption = new Database(path.toNamespacedPath(path.join(broken, 'durable.sqlite'))); corruption.exec("UPDATE durable_metadata SET next_id='invalid'"); corruption.close();
    const invalidBytes = await signature(path.join(broken, 'durable.sqlite'));
    await assert.rejects(open(broken), /metadata/); assert.deepEqual(await signature(path.join(broken, 'durable.sqlite')), invalidBytes);
    console.log('PASS orphan old journals are cleared before fresh init; corrupt current metadata is never silently erased');

    const linked = await folder('linked-stage'), outside = await folder('unrelated-target');
    await write(outside, 'preserve.txt', 'PRESERVE');
    const ownedStage = '.mybuddy-migration-' + randomUUID(); await fs.mkdir(path.join(linked, ownedStage));
    await write(path.join(linked, ownedStage), 'owner.json', { format: 1, backend: 'sqlite', stage: ownedStage, source: {}, state: 'copying' });
    await fs.symlink(outside, path.join(linked, ownedStage, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(open(linked), /link/); assert.equal(await fs.readFile(path.join(outside, 'preserve.txt'), 'utf8'), 'PRESERVE');
    console.log('PASS old staging cleanup refuses links and preserves the external target');

    for (const boundary of ['before-selector', 'after-selector']) {
      const directory = await folder(boundary);
      const child = spawn(process.execPath, [__filename, '--init-child', bundle, directory, boundary], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = ''; child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { errors += value; });
      const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      const end = Date.now() + 15000;
      while (!output.includes('BOUNDARY') && child.exitCode === null && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      if (!output.includes('BOUNDARY')) { child.kill('SIGKILL'); await exited; throw Error('Missing actual publication boundary: ' + errors); }
      child.kill('SIGKILL'); await exited;
      const revived = await open(directory); await close(revived);
      assert.equal(await schema(directory), CURRENT_SQLITE_SCHEMA_VERSION);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, api.SELECTOR), 'utf8')), currentSelector);
      assert((await fs.readdir(directory)).includes('.mybuddy-writer-lock.sqlite'), 'the actual writer mutex is never unlinked by reset/recovery');
    }
    console.log('PASS real process termination before/after selector publication recovers current storage and preserves the mutex');
  } finally {
    for (const handle of handles) { try { await handle.storage.close(); } finally { handle.lease?.release(); } }
    const relative = path.relative(path.resolve(base), path.resolve(root));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
