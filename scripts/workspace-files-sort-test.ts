import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, stat, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { listWorkspaceFiles } from '../src/main/workspace/WorkspaceService';
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
async function equal(path: string) { assert.deepEqual(await listWorkspaceFiles(path), await previous(path)); }
async function failure(fn: () => Promise<unknown>) {
  try { await fn(); return { success: true }; }
  catch (error) { const e = error as NodeJS.ErrnoException; return { name: e.name, message: e.message, code: e.code }; }
}
try {
  const names = ['file1.txt', 'file2.txt', 'file10.txt', 'file02.txt', 'File2.txt', '中文2.txt', '中文10.txt', '重庆.txt', '重阳.txt',
    'école2.txt', 'e\u0301cole2.txt', 'Ärger2.txt', 'ångström10.txt', 'I.txt', 'İ.txt', 'ı.txt', 'Ａ1.txt', 'emoji😀2.txt', '.visible-file', '_1.txt', '-2.txt'];
  await Promise.all(names.map(name => writeFile(join(root, name), '')));
  for (const folder of ['folder2', 'folder10', '文件夹2', '文件夹10', '.hidden', 'node_modules', 'out']) {
    await mkdir(join(root, folder)); await writeFile(join(root, folder, 'nested2.txt'), '');
  }
  await writeFile(join(root, MANIFEST_FILENAME), '{}'); await writeFile(join(root, `internal${MANIFEST_TMP_SUFFIX}`), '');
  await equal(root);
  const initial = await listWorkspaceFiles(root);
  assert(initial.every((node, index) => node.kind !== 'folder' || !initial.slice(0, index).some(prior => prior.kind === 'file')));
  assert(initial.some(node => node.name === '.visible-file'));
  assert(!initial.some(node => ['node_modules', '.hidden', 'out', MANIFEST_FILENAME].includes(node.name)));
  assert(initial.findIndex(node => node.name === 'file2.txt') < initial.findIndex(node => node.name === 'file10.txt'));
  await writeFile(join(root, 'file3.txt'), 'new'); await equal(root);
  assert((await listWorkspaceFiles(root)).some(node => node.name === 'file3.txt'));
  for (const path of [join(root, 'missing'), join(root, 'file1.txt')]) {
    const a = await failure(() => listWorkspaceFiles(path)); assert.equal('success' in a, false);
    assert.deepEqual(a, await failure(() => previous(path)));
  }
  const denied = join(root, 'denied'); await mkdir(denied); await chmod(denied, 0);
  try {
    const result = await failure(() => listWorkspaceFiles(denied));
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
    assert.equal((await listWorkspaceFiles(large)).length, 5010, 'sorting must not introduce a new flat-directory truncation');
    let deep = root; for (let i = 0; i < 15; i++) { deep = join(deep, `depth-${i}`); await mkdir(deep); await writeFile(join(deep, 'file2.txt'), ''); }
    await equal(root);
    for (const locale of ['en_US.UTF-8', 'de_DE.UTF-8', 'tr_TR.UTF-8', 'zh_CN.UTF-8']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--locale-child'], {
        encoding: 'utf8', timeout: 30000, env: { ...process.env, LANG: locale, LC_ALL: locale, EXPECTED_TEST_LOCALE: locale.split('.')[0].replace('_', '-') },
      });
      assert.equal(child.status, 0, `${locale}: ${child.stdout}\n${child.stderr}`);
      console.log(child.stdout.trim());
    }
  }
  if (process.platform === 'linux' && process.env.EXPECTED_TEST_LOCALE) {
    assert.equal(new Intl.Collator().resolvedOptions().locale, process.env.EXPECTED_TEST_LOCALE);
  }
  console.log(`PASS workspace file order, visibility, refresh and errors; default locale=${new Intl.Collator().resolvedOptions().locale}`);
} finally { await rm(root, { recursive: true, force: true }); }
