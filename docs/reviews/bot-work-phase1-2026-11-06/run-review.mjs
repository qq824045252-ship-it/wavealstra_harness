import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const actualHash = createHash('sha256').update(readFileSync(join(root, 'draft.ts.txt'))).digest('hex');
if (actualHash !== manifest.attachment.sha256) {
  throw new Error('Archived draft bytes differ from the reviewed source. Do not overwrite the evidence snapshot.');
}

const output = process.argv[2]
  ? resolve(process.argv[2])
  : mkdtempSync(join(tmpdir(), 'bot-work-phase1-review-'));
if (output === join(root, 'results')) {
  throw new Error('Use a new output directory; results/ contains the original recorded evidence.');
}
mkdirSync(output, { recursive: true });

for (const [probe, filename] of [
  ['logic-repro.mjs', 'logic-results.json'],
  ['schema-repro.mjs', 'schema-results.json'],
]) {
  const result = spawnSync(process.execPath, [join(root, 'probes', probe)],
    { cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr);
    process.exitCode = 1;
    break;
  }
  const data = JSON.parse(result.stdout);
  if (Array.isArray(data) && data.some(row => row.error)) {
    console.error('One or more probes raised an unexpected error:', data.filter(row => row.error));
    process.exitCode = 1;
  }
  writeFileSync(join(output, filename), JSON.stringify(data, null, 2) + '\n');
  writeFileSync(join(output, filename.replace('.json', '.stderr.txt')), result.stderr);
  console.log(`${probe}: collected ${Array.isArray(data) ? data.length : Object.keys(data).length} observations`);
}

writeFileSync(join(output, 'run-metadata.json'), JSON.stringify({
  node: process.version,
  sqlite: process.versions.sqlite,
  recordedAt: new Date().toISOString(),
  sourceSha256: actualHash,
  executionStatus: process.exitCode ? 'probe-execution-error' : 'observations-collected',
  acceptanceStatus: 'NOT_RUN',
  note: 'ok:true in probe output is the original service response, not a test PASS. These are fixed-draft defect reproductions, not repository acceptance tests.',
}, null, 2) + '\n');

console.log(`Results: ${output}`);
if (!process.exitCode) console.log('Reproduction completed. This is NOT an acceptance PASS. Read README.md and the observation records.');
