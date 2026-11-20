'use strict';
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { access, mkdir, readFile, readdir, realpath, rename, rm, writeFile } = require('node:fs/promises');
const { isAbsolute, join, relative, resolve } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');
const pins = require('../vendor/craft-office/native-releases.json');

const run = promisify(execFile);
const target = process.argv[2] ?? (process.platform === 'win32' ? 'win-x64' : 'linux-x64');
const assets = resolve(__dirname, '../vendor/craft-office/assets/native');
const verifyAt = process.argv.indexOf('--verify-assets');
const output = verifyAt < 0 ? join(assets, target) : resolve(process.argv[verifyAt + 1]);
const windows = target === 'win-x64';
const bin = engine => windows ? engine + '-cli.exe' : join('bin', engine + '-cli');

async function sha(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function installed(dir, engine, expected) {
  try {
    const state = JSON.parse(await readFile(join(dir, 'receipt.json')));
    if (state.archive !== expected) return false;
    const files = await Promise.all([bin(engine), windows ? engine + '.exe' : join('bin', engine)].map(async file =>
      state.files[file] === await sha(join(dir, file))));
    return files.every(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function prepare(engine, entry) {
  const directory = join(output, engine);
  const expected = entry[target];
  if (await installed(directory, engine, expected)) return;
  if (verifyAt >= 0) throw new Error(`Missing or invalid ${engine} native resources`);
  const name = engine + '-' + entry.version + (windows ? '-windows-x64-portable.zip' : '-linux-x86_64.tar.gz');
  const workspace = join(output, `.${engine}-${randomUUID()}`);
  const archive = join(workspace, name);
  const unpack = join(workspace, 'unpack');
  await mkdir(unpack, { recursive: true });
  try {
    try {
      const response = await fetch(`https://github.com/storytold/${engine}/releases/download/v${entry.version}/${name}`, {
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} downloading ${name}`);
      await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }));
    } catch (error) {
      throw new Error(`Cannot prepare ${engine}: ${error.message}`, { cause: error });
    }
    if (await sha(archive) !== expected) throw new Error(`SHA-256 mismatch for ${name}`);
    await run('tar', ['-xf', archive, '-C', unpack], { windowsHide: true, timeout: 120_000 });
    let payload = unpack;
    try { await access(join(payload, bin(engine))); }
    catch {
      const folders = (await readdir(unpack, { withFileTypes: true })).filter(item => item.isDirectory());
      if (folders.length !== 1) throw new Error(`Cannot locate the ${engine} runtime in ${name}`);
      payload = join(unpack, folders[0].name);
    }
    const executables = [bin(engine), windows ? engine + '.exe' : join('bin', engine)];
    const files = Object.fromEntries(await Promise.all(executables.map(async file => [file, await sha(join(payload, file))])));
    await writeFile(join(payload, 'receipt.json'), JSON.stringify({ archive: expected, files }));
    // Exchange only the known engine directory inside the pinned assets destination.
    const old = join(workspace, 'old');
    let replaced = false;
    try { await rename(directory, old); replaced = true; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(payload, directory); }
    catch (error) { if (replaced) await rename(old, directory); throw error; }
    console.log(`Prepared ${engine} ${entry.version} for ${target}`);
  } finally {
    const relativeWorkspace = relative(await realpath(assets), await realpath(workspace));
    if (!relativeWorkspace || isAbsolute(relativeWorkspace) || relativeWorkspace.startsWith('..')) {
      throw new Error('Native Office temporary path is outside its assets directory');
    }
    await rm(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function main() {
  if (!['win-x64', 'linux-x64'].includes(target)) throw new Error(`Unsupported Office native target: ${target}`);
  const results = await Promise.allSettled(Object.entries(pins).map(([name, entry]) => prepare(name, entry)));
  for (const result of results) if (result.status === 'rejected') {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });
