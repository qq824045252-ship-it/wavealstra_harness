/** Upgrade verified Pi packages without discarding the caller's working tree. */
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), os = require('node:os');
const root = path.resolve(__dirname, '..'); process.chdir(root);
const out = path.join(root, 'artifacts/pi100-upgrade');
const names = ['pi-ai','pi-agent-core','pi-coding-agent','pi-mcp','pi-codemode','pi-tui','pi-telemetry','chord'];
const report = { startedAt: new Date().toISOString(), status: 'running', patches: [], installed: [] };
const save = () => fs.writeFileSync(path.join(out, 'upgrade-results.json'), JSON.stringify(report, null, 2) + '\n');
try {
  const audit = JSON.parse(fs.readFileSync(path.join(out, 'upstream-audit.json')));
  if (audit.status !== 'passed' || audit.packages.length !== 8 || audit.packages.some(p => p.version !== '1.0.0')) throw Error('Verified upstream audit required');
  for (const name of ['pi-ai', 'pi-coding-agent']) {
    const oldPatch = path.join(root, 'patches', `@earendil-works__${name}@1.0.0.patch`);
    const newPatch = path.join(root, 'patches', `@earendil-works__${name}@1.0.0.patch`);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi100-patch-'));
    try {
      fs.cpSync(path.join(out, 'upstream', name, 'package'), temp, { recursive: true });
      const r = cp.spawnSync('git', ['apply', '--verbose', oldPatch], { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 20000 });
      if (r.status !== 0) throw Error(`Patch ${name} failed: ${r.stderr}`);
      if (oldPatch !== newPatch) fs.copyFileSync(oldPatch, newPatch);
      report.patches.push({ name, appliedToCleanUpstream: true, path: path.relative(root, newPatch) });
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  for (const group of ['dependencies', 'devDependencies']) {
    for (const name of Object.keys(pkg[group] || {})) if (name.startsWith('@earendil-works/')) pkg[group][name] = '1.0.0';
  }
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync('pnpm-workspace.yaml', fs.readFileSync('pnpm-workspace.yaml', 'utf8').replaceAll('@0.99.2', '@1.0.0'));
  save();
  const log = fs.openSync(path.join(out, 'install.log'), 'w');
  const r = cp.spawnSync('C:/Program Files/Git/bin/bash.exe', ['--noprofile','--norc','-c','pnpm install --no-frozen-lockfile'], {
    cwd: root, windowsHide: true, timeout: 100000, stdio: ['ignore', log, log]
  });
  fs.closeSync(log);
  report.installExitCode = r.status;
  if (r.status !== 0) throw Error('Install failed: ' + (r.error?.message || 'see install.log'));
  report.installed = names.map(name => ({ name, version: JSON.parse(fs.readFileSync(path.join('node_modules/@earendil-works', name, 'package.json'))).version }));
  if (report.installed.some(p => p.version !== '1.0.0')) throw Error('Mixed Pi versions');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; process.exitCode = 1; }
finally { report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify(report, null, 2)); }
