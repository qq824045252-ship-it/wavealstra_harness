import { buildSync } from 'esbuild';
import { mkdirSync,mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const out=join(process.cwd(),'out/diagnostics/performance-step5');mkdirSync(out,{recursive:true});
const entry=join(out,'db-growth-perf-history-test.cjs');
buildSync({entryPoints:['scripts/perf-bot-history-query.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:entry});
const run=spawnSync(process.execPath,['scripts/test-guard.mjs',entry,...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,HOME:mkdtempSync(join(out,'db-growth-perf-history-profile-')),GUARD_HOME:'host',GUARD_TIMEOUT_S:'180'}});process.exit(run.status??1);
