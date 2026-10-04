// Exercise actual Windows pipe closure in the Electron renderer test process.
// Intercept the native error dialog in this fault-injection harness only.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const audit = path.resolve(process.env.REMOTE_STDIO_AUDIT_DIR || path.join(root, 'artifacts/remote-renderer-stdio/latest'));
const target = path.join(root, 'scripts/remote-renderer-regression-test.cjs');
fs.mkdirSync(audit, { recursive: true });

if (process.argv.includes('--probe')) {
  const { app, dialog } = require('electron');
  const name = process.env.STDIO_PROBE_CASE;
  const metaFile = path.join(audit, name + '-process.json');
  const meta = { pid: process.pid, electron: process.versions.electron, dialogCount: 0, uncaught: [] };
  const save = () => fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  save();
  process.on('uncaughtExceptionMonitor', error => { meta.uncaught.push({ code: error.code, message: error.message, stack: error.stack }); save(); });
  dialog.showErrorBox = (title, content) => { meta.dialogCount++; meta.dialog = { title, content }; save(); app.exit(86); };
  if (name === 'stderr-closed-on-assertion') {
    assert.equal = () => { throw Error('INJECTED_ASSERTION_FAILURE'); };
  }
  // First PASS is emitted after the test creates its actual offscreen window.
  // The parent closes the selected readers immediately, before subsequent writes.
  const source = process.env.STDIO_BASELINE_SOURCE || target;
  const Module = require('node:module');
  const fixtureModule = new Module(target, module);
  fixtureModule.filename = target;
  fixtureModule.paths = Module._nodeModulePaths(path.dirname(target));
  fixtureModule._compile(fs.readFileSync(source, 'utf8'), target);
} else {
  (async () => {
    process.chdir(root);
    require('esbuild').buildSync({ entryPoints: ['scripts/remote-renderer-regression-fixture.tsx'], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: 'out/remote-tests/fixture.js', define: { 'process.env.NODE_ENV': '"production"' } });
    fs.writeFileSync('out/remote-tests/index.html', '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
    const baseline = process.argv.includes('--baseline');
    if (baseline && !process.env.STDIO_BASELINE_SOURCE) throw Error('Baseline source path required');
    const cases = baseline ? ['stdout-closed'] : ['normal', 'stdout-closed', 'both-closed', 'stderr-closed-on-assertion'];
    const results = [];
    for (const name of cases) {
      const artifactDir = path.join(audit, (baseline ? 'before-' : 'after-') + name);
      fs.mkdirSync(artifactDir, { recursive: true });
      for (const file of [path.join(artifactDir, 'renderer-results.json'), path.join(audit, name + '-process.json')]) if (fs.existsSync(file)) fs.unlinkSync(file);
      const env = { ...process.env, REMOTE_RENDERER_ARTIFACT_DIR: artifactDir, REMOTE_STDIO_AUDIT_DIR: audit, STDIO_PROBE_CASE: name };
      delete env.ELECTRON_RUN_AS_NODE;
      if (!baseline) delete env.STDIO_BASELINE_SOURCE;
      const result = await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename, '--probe', '--no-sandbox', '--disable-gpu'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', disconnected = false, timedOut = false;
        // An assertion failure occurs before PASS, so close only stderr upfront.
        if (name === 'stderr-closed-on-assertion') { child.stderr.destroy(); disconnected = true; }
        child.stdout.on('data', chunk => {
          stdout += chunk.toString();
          if (!disconnected && name !== 'normal' && stdout.includes('PASS ')) {
            disconnected = true;
            child.stdout.destroy();
            if (name === 'both-closed') child.stderr.destroy();
          }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        const timer = setTimeout(() => {
          timedOut = true;
          if (process.platform === 'win32') spawnSync('C:/Windows/System32/taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          else child.kill('SIGKILL');
        }, 25000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', (code, signal) => { clearTimeout(timer); resolve({ name, pid: child.pid, code, signal, timedOut, disconnected, stdout, stderr }); });
      });
      const metaFile = path.join(audit, name + '-process.json');
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile)) : null;
      const reportFile = path.join(artifactDir, 'renderer-results.json');
      const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile)) : null;
      result.meta = meta;
      result.report = report;
      results.push(result);
      fs.writeFileSync(path.join(audit, baseline ? 'baseline-results.json' : 'regression-results.json'), JSON.stringify(results, null, 2) + '\n');
      assert.equal(result.timedOut, false, name + ' must exit without a dialog or timeout');
      if (baseline) {
        assert.equal(result.code, 86);
        assert.equal(meta.dialogCount, 1);
        assert.ok(meta.uncaught.some(e => e.code === 'EPIPE'));
      } else if (name === 'normal') {
        assert.equal(result.code, 0);
        assert.equal(meta.dialogCount, 0);
        assert.equal(report.ok, true);
        assert.ok(report.passed >= 30, 'Full renderer assertions must run');
      } else {
        assert.equal(result.disconnected, true);
        assert.equal(result.code, 1);
        assert.equal(meta.dialogCount, 0);
        assert.equal(meta.uncaught.length, 0);
        assert.equal(report.ok, false);
        assert.match(report.error, name === 'stderr-closed-on-assertion' ? /INJECTED_ASSERTION_FAILURE/ : /EPIPE/);
      }
      console.log(JSON.stringify({ name, code: result.code, dialogCount: meta?.dialogCount, testPassed: report?.passed, recordedFailure: report?.error, expected: true }));
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
