// Isolated synthetic database benchmark. No product build, live profile or network.
import { buildSync } from 'esbuild';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const out=join(process.cwd(),'out/diagnostics/performance-step5');
mkdirSync(out,{recursive:true});
const entry=join(out,'db-growth-perf-run.cjs');
buildSync({entryPoints:['scripts/db-growth-perf-step5.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:entry});
const home=mkdtempSync(join(out,'db-growth-perf-profile-'));
const run=spawnSync(process.execPath,['scripts/test-guard.mjs',entry],{stdio:'inherit',env:{...process.env,HOME:home,GUARD_HOME:'host',GUARD_TIMEOUT_S:'180'}});
process.exit(run.status??1);
