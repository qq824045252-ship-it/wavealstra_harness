/** Repeatable serial regression runner; never reads or changes the user's profile. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const groups = {
  core: ['test:pi-native-control', 'test:message-lifecycle', 'test:prompt-submission', 'test:prompt-execution', 'test:streaming-send', 'test:session-lifecycle'],
  peripheral: ['test:conversation-runtime','test:conversation-input', 'test:conversation-runtime-ui', 'test:session-approval-bridge', 'test:pi-autonomous-execution','test:pi-native-core-tools', 'test:pi-reasoning-stream'],
  safety: ['test:mcp-execution-evidence', 'test:regenerate-lifecycle', 'test:architecture', 'test:harness-quality'],
};
const name = process.argv[2] || 'core';
if (!groups[name]) throw Error('Unknown regression group');
const out = path.join(root, 'artifacts/pi-native-control');
fs.mkdirSync(out, { recursive: true });
const report = { group: name, startedAt: new Date().toISOString(), tests: [] };
for (const test of groups[name]) {
  const started = Date.now();
  const r = cp.spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'pnpm', process.platform === 'win32' ? ['/d', '/s', '/c', `pnpm run ${test}`] : ['run', test], { cwd: root, encoding: 'utf8', timeout: 70000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  const text = `${r.stdout || ''}\n${r.stderr || ''}`;
  const log = test.replaceAll(':', '-') + '.log';
  fs.writeFileSync(path.join(out, log), text);
  const row = { name: test, passed: r.status === 0 && !r.error, exitCode: r.status, durationMs: Date.now() - started, log, ...(r.error ? { error: r.error.message } : {}) };
  report.tests.push(row);
  fs.writeFileSync(path.join(out, name + '-regression.json'), JSON.stringify(report, null, 2));
  console.log((row.passed ? 'PASS ' : 'FAIL ') + test + ' ' + row.durationMs + 'ms');
  if (!row.passed) console.log(text.slice(-4200));
}
report.passed = report.tests.every(t => t.passed);
report.finishedAt = new Date().toISOString();
fs.writeFileSync(path.join(out, name + '-regression.json'), JSON.stringify(report, null, 2));
process.exitCode = report.passed ? 0 : 1;
