const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepareOfficeCli, receiptName } = require('./prepare-officecli.cjs');
const { verifyOfficeCli } = require('./verify-officecli.cjs');

const key = 'win32-x64';
const asset = 'officecli-win-x64.exe';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'officecli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function upstream(data, tag = 'v9.8.7', override = {}) {
  const calls = [];
  const fetch = async url => {
    calls.push(url);
    if (url.includes('/releases/')) return Buffer.from(JSON.stringify({ tag_name: tag, assets: [{ name: asset, browser_download_url: 'https://example.test/binary' }, { name: 'SHA256SUMS', browser_download_url: 'https://example.test/sums' }] }));
    if (url.endsWith('/sums')) return Buffer.from(override.manifest ?? `${digest(data)}  ${asset}\n`);
    if (url.endsWith('/binary')) return override.binary ?? data;
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { fetch, calls };
}
function makeResources(root, data) {
  const resources = path.join(root, 'resources');
  const files = ['builtin-skills/officecli/SKILL.md', 'builtin-skills/officecli/LICENSE.txt', 'builtin-skills/officecli/references/cli-operations.md', 'builtin-skills/officecli/references/specialized-routing.md', 'magpie-agent-mybuddy/package.json', 'magpie-agent-mybuddy/mybuddy.agent.js'];
  for (const rel of files) { const file = path.join(resources, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); }
  fs.mkdirSync(path.join(resources, 'officecli'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'officecli', 'officecli.exe'), data);
  return resources;
}

test('accepts an existing arbitrary version only after upstream verification, and detects cache tampering', async t => {
  const root = fixture(t), data = Buffer.from('existing release');
  const dir = path.join(root, key), file = path.join(dir, 'officecli.exe');
  fs.mkdirSync(dir); fs.writeFileSync(file, data);
  const server = upstream(data);
  const options = { vendorRoot: root, fetch: server.fetch, version: 'v9.8.7' };
  assert.equal((await prepareOfficeCli(key, options)).cached, true);
  assert.ok(server.calls[0].endsWith('/tags/v9.8.7'));
  assert.equal(server.calls.some(url => url.endsWith('/binary')), false);
  fs.writeFileSync(file, 'tampered');
  await assert.rejects(prepareOfficeCli(key, { vendorRoot: root, fetch: server.fetch }), /cache does not match upstream/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'tampered');
  assert.equal((await prepareOfficeCli(key, { vendorRoot: root, fetch: server.fetch, refresh: true })).cached, false);
  assert.equal(fs.readFileSync(file, 'utf8'), data.toString());
  assert.ok(server.calls.some(url => url.endsWith('/releases/latest')));
});

test('rejects bad downloads, missing and ambiguous checksums without overwriting cache', async t => {
  const root = fixture(t), good = Buffer.from('good');
  for (const override of [{ binary: Buffer.from('bad') }, { manifest: '' }, { manifest: `${digest(good)}  ${asset}\n${digest(good)}  ${asset}\n` }]) {
    await assert.rejects(prepareOfficeCli(key, { vendorRoot: root, fetch: upstream(good, 'v9.8.7', override).fetch }));
    assert.equal(fs.existsSync(path.join(root, key, 'officecli.exe')), false);
  }
});

test('a failed refresh leaves the old cache intact', async t => {
  const root = fixture(t), data = Buffer.from('old cache');
  const dir = path.join(root, key), file = path.join(dir, 'officecli.exe');
  fs.mkdirSync(dir); fs.writeFileSync(file, data);
  const server = upstream(Buffer.from('new release'), 'v10', { binary: Buffer.from('corrupted download') });
  await assert.rejects(prepareOfficeCli(key, { vendorRoot: root, fetch: server.fetch, refresh: true }), /SHA-256 mismatch/);
  assert.deepEqual(fs.readFileSync(file), data);
});

test('packaged binary is checked against the build receipt, not the package receipt', async t => {
  const nativeTarget = process.platform === 'win32' && process.arch === 'x64';
  const root = fixture(t), vendorRoot = path.join(root, 'vendor');
  const data = nativeTarget ? fs.readFileSync(process.execPath) : Buffer.from('verified');
  const resources = makeResources(root, data);
  assert.match(verifyOfficeCli(resources, 'win32', 'x64', { vendorRoot }).errors.join('\n'), /missing or invalid OfficeCLI build integrity receipt/);
  await prepareOfficeCli(key, { vendorRoot, fetch: upstream(data).fetch });
  const verified = verifyOfficeCli(resources, 'win32', 'x64', { vendorRoot });
  assert.deepEqual(verified.errors, []);
  if (nativeTarget) assert.equal(verified.facts.officecliVersion, process.version);
  else assert.equal(verified.facts.officecliVersion, undefined);
  const binary = path.join(resources, 'officecli', 'officecli.exe');
  fs.writeFileSync(binary, 'tampered');
  fs.writeFileSync(path.join(resources, 'officecli', receiptName), JSON.stringify({ key, asset, tag: 'v9.8.7', sha256: digest(Buffer.from('tampered')) }));
  assert.match(verifyOfficeCli(resources, 'win32', 'x64', { vendorRoot }).errors.join('\n'), /SHA-256 mismatch/);
  fs.writeFileSync(path.join(vendorRoot, key, receiptName), '{}');
  assert.match(verifyOfficeCli(resources, 'win32', 'x64', { vendorRoot }).errors.join('\n'), /invalid OfficeCLI build integrity receipt/);
});
