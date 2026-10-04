/** Verify the installed core against the exact published 0.99.2 npm artifacts.
 * Read-only public fetches; no upgrades, no credentials, no installed-file mutation.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const report = { checkedAt: new Date().toISOString(), version: '0.99.2', packages: [], passed: false };
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
function tarFiles(gzip) {
  const b = zlib.gunzipSync(gzip), out = new Map();
  for (let p = 0; p + 512 <= b.length;) {
    const h = b.subarray(p, p + 512);
    if (h.every(v => v === 0)) break;
    const str = (start, end) => h.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100); const prefix = str(345, 500); if (prefix) name = prefix + '/' + name;
    const size = parseInt(str(124, 136).trim(), 8) || 0;
    const type = h[156];
    if (type === 0 || type === 48) out.set(name, b.subarray(p + 512, p + 512 + size));
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
(async () => {
  try {
    for (const spec of [
      { name: '@earendil-works/pi-agent-core', mode: 'all-js' },
      { name: '@earendil-works/pi-coding-agent', files: ['dist/core/agent-session.js', 'dist/core/agent-session-runtime.js', 'dist/core/agent-session-services.js', 'dist/core/session-manager.js', 'dist/core/settings-manager.js'] },
    ]) {
      const url = 'https://registry.npmjs.org/' + encodeURIComponent(spec.name) + '/0.99.2';
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error('Package metadata HTTP ' + response.status);
      const metadata = await response.json();
      if (metadata.version !== '0.99.2') throw Error('Unexpected registry version');
      const artifact = await fetch(metadata.dist.tarball, { signal: AbortSignal.timeout(30000) });
      if (!artifact.ok) throw Error('Package artifact HTTP ' + artifact.status);
      const bytes = Buffer.from(await artifact.arrayBuffer());
      const integrity = metadata.dist.integrity;
      if (integrity) {
        const first = integrity.split(' ')[0], sep = first.indexOf('-');
        const actual = crypto.createHash(first.slice(0, sep)).update(bytes).digest('base64');
        if (actual !== first.slice(sep + 1)) throw Error('Published tarball integrity mismatch');
      }
      const archive = tarFiles(bytes);
      const files = spec.mode === 'all-js' ? [...archive.keys()].filter(p => p.startsWith('package/dist/') && p.endsWith('.js')).map(p => p.slice(8)) : spec.files;
      if (!files.length) throw Error('No upstream core files found');
      const installed = path.join(root, 'node_modules', ...spec.name.split('/'));
      const checks = files.map(file => {
        const original = archive.get('package/' + file);
        if (!original) throw Error('Upstream core file missing: ' + file);
        const local = fs.readFileSync(path.join(installed, file));
        return { file, upstreamSha256: hash(original), installedSha256: hash(local), exactMatch: original.equals(local) };
      });
      const row = { name: spec.name, version: metadata.version, registry: url, tarball: metadata.dist.tarball, integrityVerified: !!integrity, checks, passed: checks.every(c => c.exactMatch) };
      report.packages.push(row);
      console.log((row.passed ? 'PASS ' : 'FAIL ') + spec.name + ': ' + checks.length + ' upstream core files compared');
    }
    report.passed = report.packages.length === 2 && report.packages.every(p => p.passed);
  } catch (error) { report.error = String(error); }
  fs.mkdirSync('artifacts/pi-host-exit', { recursive: true });
  fs.writeFileSync('artifacts/pi-host-exit/upstream-core-integrity.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, error: report.error, report: 'artifacts/pi-host-exit/upstream-core-integrity.json' }));
  process.exitCode = report.passed ? 0 : 1;
})();
