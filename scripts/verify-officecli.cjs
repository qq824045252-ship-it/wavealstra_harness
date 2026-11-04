const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const pin = require('../src/shared/officecli-builds.json');

function verifyOfficeCli(resources, platform, arch = 'x64') {
  const errors = [];
  const key = `${platform}-${arch}`;
  const build = pin.builds[key];
  if (!build) return { errors: [`Unsupported OfficeCLI target: ${key}`], facts: {} };
  const binary = path.join(resources, 'officecli', build.binary);
  const facts = { officecliVersion: pin.version, officecliBinary: binary };
  if (!fs.existsSync(binary)) errors.push(`missing bundled OfficeCLI: ${binary}`);
  else {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    facts.officecliSha256 = sha;
    if (sha !== build.sha256) errors.push('bundled OfficeCLI SHA-256 mismatch');
    else if (platform === process.platform && arch === process.arch) {
      const run = spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, OFFICECLI_NO_AUTO_RESIDENT: '1' } });
      if (run.error || run.status !== 0 || run.stdout.trim() !== pin.version) errors.push(`bundled OfficeCLI version probe failed: ${run.error?.message ?? run.stderr ?? run.status}`);
    }
    if (platform === 'linux' && (fs.statSync(binary).mode & 0o111) === 0) errors.push('bundled OfficeCLI is not executable');
  }
  for (const rel of ['SKILL.md', 'LICENSE.txt', 'references/cli-operations.md', 'references/specialized-routing.md']) {
    const file = path.join(resources, 'builtin-skills', 'officecli', rel);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) errors.push(`missing bundled OfficeCLI skill asset: ${rel}`);
  }
  for (const rel of ['package.json', 'mybuddy.agent.js']) {
    if (!fs.existsSync(path.join(resources, 'magpie-agent-mybuddy', rel))) errors.push(`missing bundled Magpie agent plugin: ${rel}`);
  }
  return { errors, facts };
}
module.exports = { verifyOfficeCli };
