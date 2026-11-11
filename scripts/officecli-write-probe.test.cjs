const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { probeOfficeCliWrite, runCommand, MAX_OUTPUT } = require('./skill-governance/payload/officecli/scripts/probe-write.cjs');

const ok = stdout => ({ exitCode: 0, signal: null, error: null, timedOut: false, stdout, stderr: '', durationMs: 1 });
const success = () => ok('{"success":true}');
function fixture(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'office-write-中文 space-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  let marker;
  const run = (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[0] === '--version') return ok('1.test\n');
    const file = args[1];
    if (args[0] === 'create') fs.writeFileSync(file, Buffer.from('PK\x03\x04created'));
    if (args[0] === 'set') {
      marker = args.find(a => a.startsWith('value=')).slice(6);
      fs.appendFileSync(file, marker);
    }
    if (args[0] === 'view') return ok(`A1=${marker}\n`);
    return success();
  };
  return { workspace, calls, run, options: { workspace, binary: process.execPath, env: { TMP: 'original-temp', OFFICECLI_SKIP_UPDATE: '0', OFFICECLI_NO_AUTO_RESIDENT: '0' } } };
}

test('success requires actual disk mutation, fresh-process exact-cell readback, JSON success and preserves evidence', t => {
  const f = fixture(t);
  const report = probeOfficeCliWrite(f.options, f.run);
  assert.equal(report.status, 'passed');
  assert.equal(f.calls.length, 5);
  assert.deepEqual(report.steps.map(s => s.name), ['version', 'create', 'write', 'readback', 'validate']);
  assert.equal(report.binary.path, fs.realpathSync(process.execPath));
  for (const c of f.calls) {
    assert.equal(c.binary, report.binary.path);
    assert.equal(c.options.cwd, path.dirname(report.reportPath));
    assert.equal(c.options.env.TMP, 'original-temp');
    assert.equal(c.options.env.OFFICECLI_NO_AUTO_RESIDENT, '1');
    assert.equal(c.options.env.OFFICECLI_SKIP_UPDATE, '1');
  }
  assert.equal(f.options.env.OFFICECLI_SKIP_UPDATE, '0');
  assert.deepEqual(JSON.parse(fs.readFileSync(report.reportPath, 'utf8')), report);
  assert.equal(report.fixture.sha256, crypto.createHash('sha256').update(fs.readFileSync(report.fixturePath)).digest('hex'));
  assert.match(report.unverified.join(' '), /Original denied path/);
  const other = probeOfficeCliWrite(f.options, f.run);
  assert.notEqual(other.reportPath, report.reportPath);
  assert.ok(fs.existsSync(report.reportPath));
});

for (const [label, failure] of [
  ['nonzero access denial', { ...ok(''), exitCode: 1, stderr: 'Access to the path is denied' }],
  ['spawn failure', { ...ok(''), exitCode: null, error: { code: 'EACCES', message: 'Access denied' } }],
  ['timeout', { ...ok(''), exitCode: null, signal: 'SIGKILL', timedOut: true, error: { code: 'ETIMEDOUT', message: 'timed out' } }],
  ['signal', { ...ok(''), exitCode: null, signal: 'SIGTERM' }],
  ['zero exit with rejected JSON', ok('{"success":false,"error":{"code":"io_error"}}')],
  ['zero exit with invalid JSON', ok('not JSON')],
]) {
  test(`${label}: first failed operation stops without retry or path fallback`, t => {
    const f = fixture(t);
    const report = probeOfficeCliWrite(f.options, (binary, args, options) => {
      const result = f.run(binary, args, options);
      return args[0] === 'set' ? failure : result;
    });
    assert.equal(report.status, 'failed');
    assert.equal(report.failure.stage, 'write');
    assert.equal(f.calls.length, 3);
    assert.deepEqual(report.steps[2], { name: 'write', args: f.calls[2].args, ...failure });
    assert.ok(fs.existsSync(report.reportPath));
  });
}

test('touch success, missing sample, unchanged sample and false readback never become Office write success', t => {
  for (const mode of ['missing', 'plain-text', 'unchanged', 'wrong-cell', 'wrong-value', 'cell-suffix', 'value-prefix']) {
    const f = fixture(t);
    const report = probeOfficeCliWrite(f.options, (binary, args, options) => {
      if (args[0] === 'create' && mode === 'missing') return success();
      if (args[0] === 'set' && mode === 'unchanged') return success();
      const result = f.run(binary, args, options);
      if (args[0] === 'create' && mode === 'plain-text') fs.writeFileSync(args[1], 'touch passed');
      if (args[0] === 'view' && mode === 'wrong-cell') return ok(result.stdout.replace('A1=', 'B1='));
      if (args[0] === 'view' && mode === 'cell-suffix') return ok(result.stdout.replace('A1=', 'BA1='));
      if (args[0] === 'view' && mode === 'value-prefix') return ok(result.stdout.replace('\n', '-extra\n'));
      if (args[0] === 'view' && mode === 'wrong-value') return ok('A1=not-the-probe-value');
      return result;
    });
    assert.equal(report.status, 'failed', mode);
    assert.ok(report.steps.length < 5, mode);
  }
});

test('validate failure cannot hide behind earlier successful disk readback', t => {
  const f = fixture(t);
  const report = probeOfficeCliWrite(f.options, (binary, args, options) => {
    const result = f.run(binary, args, options);
    return args[0] === 'validate' ? ok('{"success":false}') : result;
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.failure.stage, 'validate');
  assert.equal(report.steps.length, 5);
});

test('missing/relative executable produces failed report without launching PATH or another binary', t => {
  const f = fixture(t);
  for (const binary of [undefined, 'officecli', path.join(f.workspace, 'missing')]) {
    const report = probeOfficeCliWrite({ ...f.options, binary }, f.run);
    assert.equal(report.status, 'failed');
    assert.equal(report.failure.stage, 'binary');
    assert.equal(report.steps.length, 0);
    assert.ok(fs.existsSync(report.reportPath));
  }
  assert.equal(f.calls.length, 0);
});

test('invalid workspace does not silently fall back to cwd or system temp', t => {
  const f = fixture(t);
  for (const workspace of [undefined, '.', path.join(f.workspace, 'missing')]) {
    assert.throws(() => probeOfficeCliWrite({ ...f.options, workspace }, f.run));
  }
  assert.equal(f.calls.length, 0);
});

test('process runner preserves actual nonzero exit/stderr and never invokes a shell', () => {
  const result = runCommand(process.execPath, ['-e', 'process.stderr.write("intentional exit"); process.exit(7)'], {});
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'intentional exit');
  assert.equal(result.error, null);
});

test('process runner bounds actual output and kills an over-budget child', () => {
  const flooded = runCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(1024*1024))'], {});
  assert.ok(flooded.error || flooded.signal || flooded.exitCode !== 0);
  assert.ok(Buffer.byteLength(flooded.stdout) <= MAX_OUTPUT);
  const unicode = runCommand(process.execPath, ['-e', 'process.stdout.write("诊断".repeat(1024*1024))'], {});
  assert.ok(unicode.error || unicode.signal || unicode.exitCode !== 0);
  assert.ok(Buffer.byteLength(unicode.stdout) <= MAX_OUTPUT);
  const hung = runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 50 });
  assert.equal(hung.timedOut, true);
  assert.equal(hung.error.code, 'ETIMEDOUT');
  assert.equal(hung.exitCode, null);
  assert.ok(hung.durationMs < 5000);
});

test('empty version output stops before any Office mutation', t => {
  const f = fixture(t);
  const report = probeOfficeCliWrite(f.options, () => ok(''));
  assert.equal(report.status, 'failed');
  assert.equal(report.failure.stage, 'version');
  assert.equal(report.steps.length, 1);
  assert.equal(fs.existsSync(report.fixturePath), false);
});

test('CLI failure returns nonzero and links the saved failure report', t => {
  const f = fixture(t);
  const env = { ...process.env };
  delete env.MYBUDDY_OFFICECLI;
  const result = runCommand(process.execPath, [path.resolve('scripts/skill-governance/payload/officecli/scripts/probe-write.cjs'), f.workspace], { env });
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.failure.stage, 'binary');
  assert.equal(report.steps.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(report.reportPath, 'utf8')).status, 'failed');
});
