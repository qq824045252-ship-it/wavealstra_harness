import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, stat, rm, chmod, symlink, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { diffWorkspaceSnapshot, listWorkspaceFiles, previewWorkspaceFile, readWorkspaceFile, snapshotWorkspace } from '../src/main/workspace/WorkspaceService';
import { locateRuntimeAudit, RuntimeAuditReader } from '../src/main/platform/runtime-audit';
import { MANIFEST_FILENAME, MANIFEST_TMP_SUFFIX } from '../src/main/task/TaskExecutionWorkspace';
import type { WorkspaceFileNodeDto } from '../src/shared/agent-ipc';

// The pre-change reader is the behavioral oracle, including its exact stable
// ordering and existing limits. Do not "repair" unrelated traversal semantics.
async function previous(root: string): Promise<WorkspaceFileNodeDto[]> {
  const base = resolve(root); if (!(await stat(base)).isDirectory()) throw Error('工作区路径不是文件夹');
  let seen = 0;
  const ignored = new Set(['.git', '.idea', '.venv', '.vscode', 'node_modules', 'out', 'release']);
  const walk = async (dir: string, prefix = '', depth = 0): Promise<WorkspaceFileNodeDto[]> => {
    if (depth > 12 || seen > 5000) return [];
    const nodes: WorkspaceFileNodeDto[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === MANIFEST_FILENAME || entry.name.endsWith(MANIFEST_TMP_SUFFIX)) continue;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (entry.isDirectory() && ignored.has(entry.name)) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) nodes.push({ name: entry.name, path, kind: 'folder', children: await walk(resolve(dir, entry.name), path, depth + 1) });
      else if (entry.isFile()) { seen++; nodes.push({ name: entry.name, path, kind: 'file' }); }
    }
    return nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true }) : a.kind === 'folder' ? -1 : 1);
  };
  return walk(base);
}
const root = await mkdtemp(join(tmpdir(), 'wfs-'));
const useNative = process.argv.includes('--native');
const executable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert.ok(executable, 'Rust workspace scanner required');
const db = join(root, `scan-db${MANIFEST_TMP_SUFFIX}`);
await writeFile(db, '');
const reader = executable ? new RuntimeAuditReader(executable, db) : undefined;
const files = (path: string, depth?: number) => listWorkspaceFiles(path, depth, reader);
async function equal(path: string) { assert.deepEqual(await files(path), await previous(path)); }
async function failure(fn: () => Promise<unknown>) {
  try { await fn(); return { success: true }; }
  catch (error) { const e = error as NodeJS.ErrnoException; return { name: e.name, message: e.message, code: e.code }; }
}
try {
  const preview = join(root, 'preview.txt');
  for (const content of ['', 'data:ordinary text', '中文 JSON {"ok":true}']) {
    await writeFile(preview, content);
    const result = await readWorkspaceFile(preview, '', true);
    assert.equal(result.content, content); assert.equal(result.truncated, false);
  }
  const limit = 256 * 1024;
  await writeFile(preview, 'a'.repeat(limit - 1) + '中文');
  const bounded = await readWorkspaceFile(preview, '', true);
  assert.equal(bounded.content, 'a'.repeat(limit - 1)); assert.equal(bounded.truncated, true);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([0xe4, 0xb8]), Buffer.from([0x61, 0])]) {
    await writeFile(preview, bytes); await assert.rejects(readWorkspaceFile(preview, '', true), /UTF-8|二进制/);
  }
  await assert.rejects(readWorkspaceFile(root, '', true), /普通文件/);
  await assert.rejects(readWorkspaceFile(root, 'missing.txt', true));
  await assert.rejects(readWorkspaceFile(root, '../outside.txt', true), /工作区/);
  await writeFile(preview, 'legacy reader'); assert.equal((await readWorkspaceFile(root, 'preview.txt')).content, 'legacy reader');
  const officePath = join(root, 'source.xlsx');
  const officeBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  await writeFile(officePath, officeBytes);
  const office = await readWorkspaceFile(root, 'source.xlsx');
  assert.equal(office.kind, 'xlsx');
  assert.equal(office.content, '');
  assert.equal(office.bytes, officeBytes.length);
  assert.equal(office.path, officePath);
  assert.match((await previewWorkspaceFile(officePath)).content, /base64,UEsDBA==$/);
  await rm(officePath);
  await rm(preview);
  const names = ['file1.txt', 'file2.txt', 'file10.txt', 'file02.txt', 'File2.txt', '中文2.txt', '中文10.txt', '重庆.txt', '重阳.txt',
    'école2.txt', 'e\u0301cole2.txt', 'Ärger2.txt', 'ångström10.txt', 'I.txt', 'İ.txt', 'ı.txt', 'Ａ1.txt', 'emoji😀2.txt', '.visible-file', '_1.txt', '-2.txt'];
  await Promise.all(names.map(name => writeFile(join(root, name), '')));
  for (const folder of ['folder2', 'folder10', '文件夹2', '文件夹10', '.hidden', 'node_modules', 'out', 'build']) {
    await mkdir(join(root, folder)); await writeFile(join(root, folder, 'nested2.txt'), '');
  }
  await symlink(join(root, 'folder2'), join(root, 'alias-folder'), 'junction');
  await writeFile(join(root, MANIFEST_FILENAME), '{}'); await writeFile(join(root, `internal${MANIFEST_TMP_SUFFIX}`), '');
  await equal(root);
  const initial = await files(root);
  assert(initial.every((node, index) => node.kind !== 'folder' || !initial.slice(0, index).some(prior => prior.kind === 'file')));
  assert(initial.some(node => node.name === '.visible-file'));
  assert(!initial.some(node => ['node_modules', '.hidden', 'out', 'alias-folder', MANIFEST_FILENAME].includes(node.name)));
  assert(initial.findIndex(node => node.name === 'file2.txt') < initial.findIndex(node => node.name === 'file10.txt'));
  const oneLevel = await files(root, 0);
  assert.deepEqual(oneLevel.find(node => node.name === 'folder2'), { name: 'folder2', path: 'folder2', kind: 'folder', children: [] });
  assert.deepEqual(oneLevel.find(node => node.name === 'file2.txt'), { name: 'file2.txt', path: 'file2.txt', kind: 'file' });
  const stamp = join(root, 'folder2', 'nested2.txt');
  for (const seconds of [1_700_000_000.0004, 1_700_000_000.0006, 1_700_000_000.123456]) {
    await utimes(stamp, seconds, seconds);
    assert.deepEqual(await snapshotWorkspace(root, reader), await snapshotWorkspace(root));
  }
  const before = await snapshotWorkspace(root, reader);
  assert.equal(before.has(stamp), true);
  assert.equal(before.has(join(root, 'build', 'nested2.txt')), false);
  await writeFile(stamp, 'changed');
  const report = join(root, '报告.md');
  await writeFile(report, '# 结果');
  await writeFile(join(root, 'build', 'nested2.txt'), 'ignored build change');
  const changed = diffWorkspaceSnapshot(before, await snapshotWorkspace(root, reader));
  assert.deepEqual(changed, { changed: [stamp, report] });
  assert.deepEqual(await snapshotWorkspace(root, reader), await snapshotWorkspace(root));
  await writeFile(join(root, 'file3.txt'), 'new'); await equal(root);
  assert((await files(root)).some(node => node.name === 'file3.txt'));
  for (const path of [join(root, 'missing'), join(root, 'file1.txt')]) {
    const a = await failure(() => files(path)); assert.equal('success' in a, false);
    assert.deepEqual(a, await failure(() => previous(path)));
  }
  const denied = join(root, 'denied'); await mkdir(denied); await chmod(denied, 0);
  try {
    const result = await failure(() => files(denied));
    assert.deepEqual(result, await failure(() => previous(denied)));
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      assert.equal('code' in result ? result.code : undefined, 'EACCES', 'non-root POSIX must exercise permission denial');
    }
  }
  finally { await chmod(denied, 0o700); }
  if (!process.argv.includes('--locale-child')) {
    const large = join(root, 'large'); await mkdir(large);
    for (let start = 0; start < 5010; start += 50) await Promise.all(Array.from({ length: Math.min(50, 5010 - start) }, (_, i) => writeFile(join(large, `文件-${(start + i) * 7919 % 5010}-${start + i}.txt`), '')));
    await equal(large);
    assert.equal((await files(large)).length, 5010, 'sorting must not introduce a new flat-directory truncation');
    const largeSnapshot = await snapshotWorkspace(large, reader);
    assert.equal(largeSnapshot.size, 5000);
    assert.deepEqual(largeSnapshot, await snapshotWorkspace(large));
    let deep = root; for (let i = 0; i < 15; i++) { deep = join(deep, `depth-${i}`); await mkdir(deep); await writeFile(join(deep, 'file2.txt'), ''); }
    await equal(root);
    for (const locale of ['en_US.UTF-8', 'de_DE.UTF-8', 'tr_TR.UTF-8', 'zh_CN.UTF-8']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--locale-child', ...(useNative ? ['--native'] : [])], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, LANG: locale, LC_ALL: locale, EXPECTED_TEST_LOCALE: locale.split('.')[0].replace('_', '-') },
      });
      assert.equal(child.status, 0, `${locale}: ${child.stdout}\n${child.stderr}`);
      console.log(child.stdout.trim());
    }
  }
  if (process.platform === 'linux' && process.env.EXPECTED_TEST_LOCALE) {
    assert.equal(new Intl.Collator().resolvedOptions().locale, process.env.EXPECTED_TEST_LOCALE);
  }
  console.log(`PASS workspace file order, snapshot diff, limits and errors (${useNative ? 'Rust' : 'Node'}); default locale=${new Intl.Collator().resolvedOptions().locale}`);
} finally {
  await reader?.close();
  await rm(root, { recursive: true, force: true });
}
