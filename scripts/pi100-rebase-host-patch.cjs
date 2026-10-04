const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), os = require('node:os');
const { createTwoFilesPatch } = require('diff');
const root = path.resolve(__dirname, '..'); process.chdir(root);
const upstream = path.join(root, 'artifacts/pi100-upgrade/upstream/pi-coding-agent/package');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi100-host-rebase-'));
const files = ['dist/config.d.ts','dist/config.js','dist/extensions/mcp/index.d.ts','dist/extensions/mcp/index.js','dist/index.d.ts','dist/index.js','dist/core/sdk.js'];
try {
  fs.cpSync(upstream, tmp, { recursive: true });
  const p = path.join(root, 'artifacts/pi100-upgrade/host-semantic.patch');
  const r = cp.spawnSync('git', ['apply','--verbose',p], { cwd: tmp, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (r.status !== 0) throw Error(r.stderr);
  const entry = path.join(tmp, 'dist/extensions/mcp/index.js');
  const old = fs.readFileSync(entry, 'utf8');
  if (!old.includes('credentials?.tokens(url)')) throw Error('Expected host credential call absent');
  fs.writeFileSync(entry, old.replace('credentials?.tokens(url)', 'credentials?.tokens(server.entry.name, url)'));
  const configPath = path.join(tmp, 'dist/config.js');
  const config = fs.readFileSync(configPath, 'utf8').replaceAll('\r\n', '\n');
  const docsBody = 'export function getDocsPath() {\n    return resolve(join(getPackageDir(), "docs"));\n}';
  if (!config.includes(docsBody)) throw Error('Native docs path changed');
  fs.writeFileSync(configPath, config.replace(docsBody, 'export function getDocsPath() {\n    // Embedded desktop bundles keep upstream reference docs beside their generated assets.\n    const embedded = join(getPackageDir(), "out", "main", "pi-docs");\n    return resolve(existsSync(join(embedded, "codemode.md")) ? embedded : join(getPackageDir(), "docs"));\n}'));
  const sdkPath=path.join(tmp,'dist/core/sdk.js');
  const sdk=fs.readFileSync(sdkPath,'utf8').replaceAll('\r\n','\n');
  const sdkNeedle='        initialActiveToolNames,\n        usesDefaultTools:';
  if(!sdk.includes(sdkNeedle))throw Error('Native SDK session constructor changed');
  fs.writeFileSync(sdkPath,sdk.replace(sdkNeedle,'        // Keep explicit SDK tool restrictions, otherwise restore the canonical Pi transcript loadout.\n        initialActiveToolNames: hasExistingSession && options.tools === undefined && !options.noTools ? undefined : initialActiveToolNames,\n        usesDefaultTools:'));
  let patch = '';
  for (const file of files) {
    const a = fs.readFileSync(path.join(upstream,file),'utf8');
    const b = fs.readFileSync(path.join(tmp,file),'utf8').replaceAll('\r\n','\n');
    if (a === b) throw Error('Expected patch missing ' + file);
    patch += 'diff --git a/'+file+' b/'+file+'\n' + createTwoFilesPatch('a/'+file,'b/'+file,a,b).split('\n').filter(l => !l.startsWith('===')).join('\n');
  }
  fs.writeFileSync('patches/@earendil-works__pi-coding-agent@1.0.0.patch', patch);
  console.log('Rebased host-only patch onto Pi 1.0.0; corrected per-server credential lookup; bytes=' + patch.length);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
