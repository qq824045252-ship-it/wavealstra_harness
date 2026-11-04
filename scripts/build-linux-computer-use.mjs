import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LINUX_ATSPI_WORKER_FILE = 'atspi-worker.cjs';
export const LINUX_INPUT_GUARDIAN_FILE = 'input-guardian.cjs';
export const LINUX_CU_RUNTIME_FILE = 'linux-computer-use-runtime.json';

/**
 * The accessibility worker uses the application's Electron Node runtime. Bundle
 * dbus-native and its JavaScript dependencies here so a packaged child never
 * resolves dependencies from the developer's node_modules or an asar archive.
 * No D-Bus/AT-SPI connection or desktop operation occurs during this build.
 */
export async function buildLinuxComputerUseAssets(root) {
  const requireRoot = createRequire(join(root, 'package.json'));
  const appManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const dbusManifest = requireRoot('dbus-native/package.json');
  const pinnedVersion = appManifest.dependencies['dbus-native'];
  if (dbusManifest.version !== pinnedVersion) {
    throw new Error(`dbus-native ${dbusManifest.version} is installed; package.json pins ${pinnedVersion}`);
  }
  const result = await build({
    entryPoints: [join(root, 'src/main/platform/computer-use/linux/atspiWorker.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    write: false,
    outfile: LINUX_ATSPI_WORKER_FILE,
    metafile: true,
    legalComments: 'none',
    external: ['electron'],
  });
  if (Object.keys(result.metafile.inputs).some((name) => /\.node$/i.test(name))) {
    throw new Error('The AT-SPI worker must not bundle a native addon');
  }
  const acceptance = await build({
    entryPoints: [join(root, 'scripts/computer-use-linux-smoke.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
    outfile: 'linux-computer-use-acceptance.cjs', legalComments: 'none', external: ['electron'],
  });
  const guardian = await build({
    entryPoints: [join(root, 'src/main/platform/computer-use/linux/inputGuardianWorker.ts')],
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', write: false,
    outfile: LINUX_INPUT_GUARDIAN_FILE, legalComments: 'none',
  });
  const runtime = {
    protocol: 1,
    backend: 'linux-atspi',
    appVersion: appManifest.version,
    minimumNodeVersion: '24.0.0',
    dbusNativeVersion: dbusManifest.version,
    dbusNativeNodeEngine: dbusManifest.engines.node,
    worker: LINUX_ATSPI_WORKER_FILE,
    inputGuardian: LINUX_INPUT_GUARDIAN_FILE,
  };
  return [
    ...result.outputFiles.map((file) => ({
      type: 'asset', fileName: LINUX_ATSPI_WORKER_FILE, source: file.contents,
    })),
    { type: 'asset', fileName: LINUX_CU_RUNTIME_FILE, source: JSON.stringify(runtime, null, 2) + '\n' },
    { type: 'asset', fileName: LINUX_INPUT_GUARDIAN_FILE, source: guardian.outputFiles[0].contents },
    { type: 'asset', fileName: 'linux-computer-use-acceptance.cjs', source: acceptance.outputFiles[0].contents },
    ...['linux-computer-use-fixture.cjs', 'linux-computer-use-fixture.html'].map((fileName) => ({
      type: 'asset', fileName, source: readFileSync(join(root, 'scripts', fileName)),
    })),
  ];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const outputRoot = join(root, 'out/main');
  mkdirSync(outputRoot, { recursive: true });
  for (const asset of await buildLinuxComputerUseAssets(root)) {
    // Parallel headless gates may both prepare workers. Readers must never see
    // a truncated half-written program while another build is publishing it.
    const destination = join(outputRoot, asset.fileName);
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, asset.source);
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { force: true }); }
    console.log(`[linux-computer-use] wrote out/main/${asset.fileName}`);
  }
}
