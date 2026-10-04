const fs = require('node:fs'), path = require('node:path');
process.chdir(path.resolve(__dirname,'..'));
function edit(file, replacements) {
  let source = fs.readFileSync(file,'utf8');
  for (const [from,to] of replacements) {
    if (!source.includes(from)) throw Error('Missing expected source in '+file+': '+from);
    source = source.replace(from,to);
  }
  fs.writeFileSync(file,source.replaceAll('\r\n','\n'));
}
edit('src/main/mcp/McpRuntimeService.ts',[
  ["// Classifier/Jev routing is not part of this migration. Keep model invocation\n      // behind the host's scoped, explicit model tools rather than a second unscoped API.","// Pi's models facade exposes catalog lookup, explicit classification and image generation.\n      // It uses this session's native ModelRegistry/auth; no chat stream or automatic router is added."],
  ["createCodemodeExtension({ mode: 'on', models: false })","createCodemodeExtension({ mode: 'on', models: true })"],
  ["this.credentialStore().remove(config.url)","this.credentialStore().remove(name, config.url)"],
  ["this.credentialStore().tokens(entry.url)","this.credentialStore().tokens(name, entry.url)"],
]);
edit('src/shared/pi-code-mode.ts',[
  ['models: false;', 'models: boolean;'],
  ['active, models: false', 'active, models: isPiCodeModeEnabled(welcomeMode)'],
]);
edit('src/main/capabilities/subagent/worker-launcher.mjs',[[ 'const EXPECTED_PI_VERSION = "0.99.2";', 'const EXPECTED_PI_VERSION = "1.0.0";' ]]);
edit('src/main/mcp/NativeMcpConfig.ts',[
  ["['clientId', 'clientSecret', 'clientName', 'callbackUrl', 'scope'] as const", "['clientId', 'clientSecret', 'clientName', 'callbackUrl', 'scope', 'authServerMetadataUrl'] as const"],
  ['        if (raw.callbackPort != null) {', `        if (oauth.authServerMetadataUrl != null) {
          const metadata = new URL(oauth.authServerMetadataUrl);
          if (metadata.protocol !== 'https:' && !(metadata.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(metadata.hostname)))
            throw new Error('OAuth metadata URL requires HTTPS except on loopback');
          if (metadata.username || metadata.password || metadata.hash) throw new Error('invalid OAuth metadata URL');
        }
        if (raw.callbackPort != null) {`],
]);
const p = JSON.parse(fs.readFileSync('package.json','utf8'));
// CODEMODE_DOCS_PATH is resolved by native Pi against the embedded application's package root.
// Keep the upstream reference there, rather than making the model read a nonexistent dev dependency.
p.build.files.push({ from: 'node_modules/@earendil-works/pi-coding-agent/docs', to: 'docs', filter: ['**/*'] });
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');
console.log('Updated native model facade, OAuth key/metadata projection, worker version and packaged reference docs.');
