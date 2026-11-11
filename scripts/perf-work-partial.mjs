/** Run: TMPDIR=<WAL-capable temp directory> node scripts/perf-work-partial.mjs [baseline-ref] */
import { build } from 'esbuild';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
const ref = process.argv[2] ?? '1df82d13527083e39b503e5527cb54df8d96c8df';
const source = 'src/main/agent/work/WorkPartialResults.ts';
const baseline = execFileSync('git', ['show', `${ref}:${source}`], { encoding: 'utf8' });
const out = resolve('out/diagnostics/work-partial'); mkdirSync(out, { recursive: true });
const baselineModule = resolve(out, 'baseline.mjs');
await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: baselineModule,
  plugins: [{ name: 'baseline-partial-results', setup(builder) {
    builder.onLoad({ filter: /WorkPartialResults\.ts$/ }, args => args.path === resolve(source)
      ? { contents: baseline, loader: 'ts', resolveDir: dirname(args.path) } : undefined);
  } }] });
const entry = resolve(out, 'benchmark.mjs');
await build({ entryPoints: ['scripts/perf-work-partial.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
  alias: { electron: './scripts/arch-electron-stub.ts' }, outfile: entry });
const hash = value => createHash('sha256').update(value).digest('hex');
writeFileSync(resolve(out, 'metadata.json'), JSON.stringify({ baselineRef: ref, head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  baselineHash: hash(baseline), candidateHash: hash(readFileSync(source)),
  diff: execFileSync('git', ['diff', '--', source], { encoding: 'utf8' }),
  scriptHashes: Object.fromEntries(['scripts/perf-work-partial.mjs', 'scripts/perf-work-partial.ts'].map(path => [path, hash(readFileSync(path))])) }, null, 2));
const run = spawnSync(process.execPath, ['scripts/test-guard.mjs', entry, resolve(out, 'results.json')], {
  stdio: 'inherit', env: { ...process.env, PARTIAL_BASELINE_MODULE: baselineModule }, timeout: 900000 });
process.exit(run.status ?? 1);
