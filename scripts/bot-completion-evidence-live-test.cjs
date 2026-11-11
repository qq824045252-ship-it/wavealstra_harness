/** Opt-in real-result-model/registered-artifact acceptance. Does not build or launch the product. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const retryArg = args.find(arg => arg.startsWith('--retry-schema-from='));
if (args.length > 1 || args.some(arg => !['--live', '--check-harness'].includes(arg) && !arg.startsWith('--retry-schema-from='))) {
  throw Error('Usage: node scripts/bot-completion-evidence-live-test.cjs --live | --check-harness | --retry-schema-from=<original-report.json>');
}
if (retryArg && !fs.statSync(retryArg.slice('--retry-schema-from='.length)).isFile()) throw Error('Original report must exist');
if (!args.length) {
  console.log('Opt-in test: --live runs all six distinct task types, each with an incomplete and a complete candidate (12 production result reviews). --check-harness checks registration/inputs without inference.');
  process.exit(0);
}
const expectedCommit = process.env.BOT_COMPLETION_EVIDENCE_EXPECT_COMMIT;
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (expectedCommit && (!/^[a-f0-9]{40}$/.test(expectedCommit) || commit !== expectedCommit)) throw Error('Fixed commit mismatch before compilation');
const tmp = fs.realpathSync(process.env.TMPDIR || os.tmpdir());
if (tmp === root || tmp.startsWith(root + path.sep)) throw Error('TMPDIR must be outside the repository');
const home = fs.mkdtempSync(path.join(tmp, 'ce-'));
const out = path.join(root, 'out/diagnostics/bot-completion-evidence', new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out); // Exclusive run directory: never overwrite an earlier run.
const bundle = path.join(out, 'bot-completion-evidence-live-test.mjs');
const compilation = buildSync({ metafile: true, absWorkingDir: root, entryPoints: ['scripts/bot-completion-evidence-live-test.ts'], bundle: true,
  platform: 'node', format: 'esm', packages: 'external', alias: { electron: path.join(root, 'scripts/arch-electron-stub.ts') }, outfile: bundle });
const sha = value => createHash('sha256').update(value).digest('hex');
const compiledInputFiles = Object.fromEntries(Object.keys(compilation.metafile.inputs).sort().map(name => [name, sha(fs.readFileSync(path.resolve(root, name)))]));
fs.writeFileSync(path.join(out, 'compile-provenance.json'), JSON.stringify({ commit, expectedCommit: expectedCommit || null, bundleSha256: sha(fs.readFileSync(bundle)), compiledInputFiles }, null, 2));
// Explicit allowlist: no inherited API keys, provider auth, user profile or UI session.
const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: tmp, HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
  XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
  PI_CODING_AGENT_DIR: path.join(home, '.mybuddy'), BOT_COMPLETION_EVIDENCE_HOME: home,
  BOT_COMPLETION_EVIDENCE_OUT: out, BOT_COMPLETION_EVIDENCE_REPO: root,
  BOT_COMPLETION_EVIDENCE_EXPECT_COMMIT: expectedCommit || '' };
fs.writeFileSync(path.join(out, 'launch.json'), JSON.stringify({ home, out, root, args, commit, expectedCommit: expectedCommit || null, node: process.version, startedAt: new Date().toISOString() }, null, 2));
console.log('Completion evidence artifacts: ' + out);
console.log('Isolated HOME (preserved): ' + home);
const child = spawnSync(process.execPath, ['--max-old-space-size=2048', bundle, ...args], { cwd: root, env, stdio: 'inherit', timeout: 20 * 60 * 1000 });
fs.writeFileSync(path.join(out, 'exit.json'), JSON.stringify({ code: child.status, signal: child.signal, error: child.error?.message, finishedAt: new Date().toISOString() }, null, 2));
process.exitCode = child.status ?? 1;
