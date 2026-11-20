'use strict';

const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { createReadStream, createWriteStream } = require('node:fs');
const { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const release = require('../vendor/cadcraft/releases.json');

const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const vendorRoot = path.resolve(__dirname, '../vendor/cadcraft/assets');

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function invalidAssets(destination, target, pin) {
  const invalid = [];
  for (const [name, expected] of Object.entries(pin.files)) {
    const file = path.join(destination, name);
    const info = await lstat(file).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    const executable = target === 'linux-x64' && process.platform === 'linux' &&
      (name === pin.editor || name === pin.cli);
    if (!info?.isFile() || (executable && !(info.mode & 0o111)) || await sha256(file) !== expected) {
      invalid.push(name);
    }
  }
  return invalid;
}

async function prepare(destination, target, pin, missing) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mybuddy-cadcraft-'));
  try {
    const suppliedArchive = option('--archive');
    const archive = suppliedArchive ? path.resolve(suppliedArchive) : path.join(temporary, 'release.archive');
    if (!suppliedArchive) {
      const response = await fetch(pin.url, { signal: AbortSignal.timeout(300000) });
      if (!response.ok || !response.body) throw new Error(`CADCraft download failed with HTTP ${response.status}`);
      await pipeline(response.body, createWriteStream(archive, { flags: 'wx' }));
    }
    if (await sha256(archive) !== pin.sha256) throw new Error('CADCraft release archive SHA-256 mismatch');

    if (target === 'web') {
      // The pinned web release is ZIP. GNU tar cannot read it on Linux.
      const zip = await require('jszip').loadAsync(await readFile(archive));
      for (const name of missing) {
        const member = pin.prefix + name;
        const entry = zip.file(member);
        if (!entry || entry.unsafeOriginalName !== member) {
          throw new Error(`Missing or invalid CADCraft archive member: ${member}`);
        }
        const output = path.join(temporary, member);
        await mkdir(path.dirname(output), { recursive: true });
        await pipeline(entry.nodeStream(), createWriteStream(output, { flags: 'wx' }));
      }
    } else {
      execFileSync('tar', ['-xf', archive, '-C', temporary, ...missing.map(name => pin.prefix + name)], {
        windowsHide: true,
        timeout: 120000,
      });
    }
    for (const name of missing) {
      const source = path.join(temporary, pin.prefix, name);
      if (await sha256(source) !== pin.files[name]) throw new Error(`CADCraft asset SHA-256 mismatch: ${name}`);
      const file = path.join(destination, name);
      await mkdir(path.dirname(file), { recursive: true });
      const staging = `${file}.${randomUUID()}.tmp`;
      try {
        await copyFile(source, staging);
        if (target === 'linux-x64' && (name === pin.editor || name === pin.cli)) await chmod(staging, 0o755);
        await rename(staging, file);
      } finally {
        await rm(staging, { force: true });
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function installTarget(target, verificationRoot, verifyOnly) {
  if (!Object.hasOwn(release.targets, target)) throw new Error(`CADCraft is unavailable for ${target}`);
  const pin = release.targets[target];
  const destination = verificationRoot ? path.resolve(verificationRoot) : path.join(vendorRoot, target);
  const missing = await invalidAssets(destination, target, pin);
  if (missing.length) {
    if (verifyOnly) {
      throw new Error(`Missing or changed CADCraft ${target} assets: ${missing.join(', ')}`);
    }
    await prepare(destination, target, pin, missing);
  }
  if (!verifyOnly && hostTarget === 'win-x64' && target === hostTarget) {
    // A Low-integrity workspace marks its children Low on extraction. CADCraft
    // needs normal desktop write access to save a drawing selected by the user.
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    for (const name of [pin.editor, pin.cli]) {
      execFileSync(icacls, [path.join(destination, name), '/setintegritylevel', 'M', '/L', '/Q'], {
        windowsHide: true, timeout: 15000,
      });
    }
  }
  if (target === hostTarget) {
    const actual = execFileSync(path.join(destination, pin.cli), ['--version'], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
    }).trim();
    if (actual.split(/\s+/)[1] !== release.version) throw new Error(`Unexpected CADCraft CLI version: ${actual}`);
  }
  console.log(`Verified CADCraft ${release.version} for ${target}.`);
}

async function main() {
  const target = option('--target') ?? hostTarget;
  const verificationRoot = option('--verify-assets');
  const verifyOnly = Boolean(verificationRoot || process.argv.includes('--verify'));
  await installTarget(target, verificationRoot, verifyOnly);
  if (target !== 'web' && !verificationRoot && !option('--archive')) {
    await installTarget('web', undefined, verifyOnly);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
