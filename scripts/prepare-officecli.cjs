#!/usr/bin/env node
// Resolve a release from upstream before trusting either a cached or downloaded binary.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const { builds } = require('../src/shared/officecli-builds.json');

const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const receiptName = 'officecli-integrity.json';

function fetch(url, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  if (new URL(url).protocol !== 'https:') return Promise.reject(new Error('Office CLI download requires HTTPS'));
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

function atomicWrite(file, data, mode = 0o644) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, data, { mode, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

async function prepareOfficeCli(key, options = {}) {
  const build = builds[key];
  if (!build) throw new Error(`Unsupported Office CLI build: ${key}`);
  const dir = path.join(options.vendorRoot || path.resolve(__dirname, '..', 'vendor', 'officecli'), key);
  const target = path.join(dir, build.binary);
  const receipt = path.join(dir, receiptName);
  const download = options.fetch || fetch;
  let prior;
  try { prior = JSON.parse(fs.readFileSync(receipt, 'utf8')); } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  // A receipt selects a version, but never supplies the trusted digest: always re-fetch upstream.
  const requested = options.refresh ? '' : (options.version || (prior?.key === key && prior?.asset === build.asset && typeof prior.tag === 'string' ? prior.tag : ''));
  const endpoint = requested ? `tags/${encodeURIComponent(requested)}` : 'latest';
  const release = JSON.parse((await download(`https://api.github.com/repos/iOfficeAI/OfficeCLI/releases/${endpoint}`)).toString('utf8'));
  if (typeof release.tag_name !== 'string' || !release.tag_name || (requested && release.tag_name !== requested)) throw new Error('Office CLI release tag mismatch');
  const asset = release.assets?.find(item => item.name === build.asset);
  const sums = release.assets?.find(item => item.name === 'SHA256SUMS');
  if (!asset?.browser_download_url || !sums?.browser_download_url) throw new Error('Office CLI release lacks the required asset or checksums');
  const manifest = (await download(sums.browser_download_url)).toString('utf8');
  const entries = manifest.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line)).filter(match => match && match[2] === build.asset);
  if (entries.length !== 1) throw new Error('Office CLI checksum entry missing or ambiguous');
  const sha256 = entries[0][1].toLowerCase();
  let valid = false;
  try { valid = fs.statSync(target).isFile() && hash(fs.readFileSync(target)) === sha256; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!valid) {
    if (fs.existsSync(target) && !options.refresh) throw new Error('Office CLI cache does not match upstream; use --refresh to replace it');
    const data = await download(asset.browser_download_url);
    if (hash(data) !== sha256) throw new Error('Office CLI SHA-256 mismatch');
    fs.mkdirSync(dir, { recursive: true });
    atomicWrite(target, data, 0o755);
  }
  if (!key.startsWith('win32-')) fs.chmodSync(target, 0o755);
  atomicWrite(receipt, JSON.stringify({ key, asset: build.asset, tag: release.tag_name, sha256 }) + '\n');
  return { target, tag: release.tag_name, cached: valid };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const keys = args.filter(arg => arg !== '--refresh');
  if (keys.length > 1 || keys.some(arg => arg.startsWith('--'))) throw new Error('Usage: prepare-officecli.cjs [platform-arch] [--refresh]');
  prepareOfficeCli(keys[0] || `${process.platform}-${process.arch}`, { version: process.env.OFFICECLI_VERSION, refresh: args.includes('--refresh') }).then(result => {
    console.log(`Office CLI ${result.tag} ${result.cached ? 'already prepared' : 'prepared'}: ${result.target}`);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { prepareOfficeCli, receiptName };
