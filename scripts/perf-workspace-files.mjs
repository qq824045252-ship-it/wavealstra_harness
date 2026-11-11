/** TMPDIR=<isolated-temp> node scripts/perf-workspace-files.mjs [baseline-ref] */
import { build } from 'esbuild';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const sourcePath = 'src/main/workspace/WorkspaceService.ts';
const ref = process.argv[2] ?? '6766877792496b1af1c617bba3eaf1138b3baad5';
const baseline = execFileSync('git', ['show', `${ref}:${sourcePath}`], { encoding: 'utf8' });
const out = resolve('out/diagnostics/workspace-files'); mkdirSync(out, { recursive: true });
const baselinePath = resolve(out, 'baseline.mjs');
await build({ entryPoints: [sourcePath], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { electron: './scripts/arch-electron-stub.ts' }, outfile: baselinePath,
  plugins: [{ name: 'reference-workspace-service', setup(builder) {
    builder.onLoad({ filter: /WorkspaceService\.ts$/ }, args => args.path === resolve(sourcePath)
      ? { contents: baseline, loader: 'ts', resolveDir: dirname(args.path) } : undefined);
  } }] });
const entry = resolve(out, 'benchmark.mjs');
await build({ entryPoints: ['scripts/perf-workspace-files.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { electron: './scripts/arch-electron-stub.ts' }, outfile: entry });
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(resolve(out, 'metadata.json'), JSON.stringify({ baselineRef: ref,
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), baselineHash: hash(baseline), candidateHash: hash(readFileSync(sourcePath)),
  diff: execFileSync('git', ['diff', '--', sourcePath], { encoding: 'utf8' }),
  scriptHashes: Object.fromEntries(['scripts/perf-workspace-files.ts', 'scripts/perf-workspace-files.mjs'].map(path => [path, hash(readFileSync(path))])) }, null, 2));
const run = spawnSync(process.execPath, ['scripts/test-guard.mjs', entry, resolve(out, 'results.json')], {
  stdio: 'inherit', env: { ...process.env, GUARD_HOME: 'sandbox', WORKSPACE_BASELINE: baselinePath,
    SOURCE_HEAD: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, timeout: 300000 });
process.exit(run.status ?? 1);
