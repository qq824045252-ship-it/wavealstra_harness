#!/usr/bin/env node
// Fetch the pinned, self-contained binary at build time; users never download it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const { version, builds } = require('../src/shared/officecli-builds.json');
const key = process.argv[2] || `${process.platform}-${process.arch}`;
const build = builds[key];
if (!build) throw new Error(`Unsupported Office CLI build: ${key}`);
const target = path.resolve(__dirname, '..', 'vendor', 'officecli', key, build.binary);
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
if (fs.existsSync(target) && hash(fs.readFileSync(target)) === build.sha256) {
  if (!key.startsWith('win32-')) fs.chmodSync(target, 0o755);
  console.log(`Office CLI ${version} already prepared: ${target}`);
  process.exit(0);
}
function fetch(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => https.get(url, { headers: { 'User-Agent': 'MyBuddy-build' } }, response => {
    if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
      response.resume();
      fetch(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject);
      return;
    }
    if (response.statusCode !== 200) { response.resume(); reject(new Error(`Download failed: HTTP ${response.statusCode}`)); return; }
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  }).on('error', reject).setTimeout(120000, function () { this.destroy(new Error('Office CLI download timed out')); }));
}
fetch(`https://github.com/iOfficeAI/OfficeCLI/releases/download/v${version}/${build.asset}`).then(data => {
  if (hash(data) !== build.sha256) throw new Error('Office CLI SHA-256 mismatch');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode: 0o755 }); fs.renameSync(tmp, target); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  console.log(`Prepared Office CLI ${version}: ${target}`);
}).catch(error => { console.error(error); process.exitCode = 1; });
