/** Bundle the native Durable package probe, without the old CLI/RPC runner. */
import { build } from 'esbuild';
import { createRequire, isBuiltin } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';

export async function buildSubagentRuntime(root) {
  const piRoot=realpathSync(join(root,'node_modules/@earendil-works/pi-coding-agent'));
  const requirePi=createRequire(join(piRoot,'package.json'));
  const aiRoot=realpathSync(requirePi.resolve.paths('@earendil-works/pi-ai').map(p=>join(p,'@earendil-works/pi-ai')).find(p=>{try{return JSON.parse(readFileSync(join(p,'package.json'),'utf8')).name==='@earendil-works/pi-ai';}catch{return false;}}));
  const piVersion=JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8')).version;
  const aiVersion=JSON.parse(readFileSync(join(aiRoot,'package.json'),'utf8')).version;
  const durableVersion=JSON.parse(readFileSync(join(root,'node_modules/@earendil-works/pi-durable/package.json'),'utf8')).version;
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const expected=manifest.devDependencies?.['@earendil-works/pi-coding-agent'] ?? manifest.dependencies?.['@earendil-works/pi-coding-agent'];
  if(!/^\d+\.\d+\.\d+$/.test(expected)||piVersion!==expected||aiVersion!==piVersion||durableVersion!==piVersion)throw Error('Native Runtime versions are inconsistent');
  const launcher=readFileSync(join(root,'src/main/capabilities/subagent/worker-launcher.mjs'),'utf8');
  if(!launcher.includes('const EXPECTED_PI_VERSION = '+JSON.stringify(expected)+';'))throw Error('Subagent launcher version pin must match the installed runtime');
  const spec=p=>JSON.stringify(p.replaceAll('\\','/'));
  // The SDK barrel exports its extension loader, whose virtual modules import the entire CLI.
  // This isolated probe only needs these upstream modules; no SDK implementation is replaced.
  const sdkExports = [
    ['config.js', 'VERSION, CONFIG_DIR_NAME, getAgentDir'],
    ['core/model-runtime.js', 'ModelRuntime'],
    ['core/settings-manager.js', 'SettingsManager'],
    ['core/model-resolver.js', 'resolveModelScopeWithDiagnostics'],
    ['core/tools/find.js', 'createFindTool'],
    ['core/tools/grep.js', 'createGrepTool'],
    ['core/tools/ls.js', 'createLsTool'],
    ['utils/frontmatter.js', 'parseFrontmatter'],
  ].map(([file, names]) => `export { ${names} } from ${spec(join(piRoot, 'dist', file))};`).join('\n');
  const entry = 'export { VERSION, verifyPackagedDurable } from ' + spec(join(root, 'src/main/agent/durable/PackagedDurableProbe.ts')) + ';';
  const outdir=join(root,'out/subagent-runtime-build');
  const result=await build({stdin:{contents:entry,resolveDir:root,sourcefile:'pi-worker-runtime-entry.mjs',loader:'js'},outdir,
    entryNames:'pi-runtime',chunkNames:'chunks/[name]-[hash]',outExtension:{'.js':'.mjs'},
    bundle:true,platform:'node',format:'esm',target:'node22',splitting:true,write:false,metafile:true,
    external:['jiti','bufferutil','utf-8-validate','kerberos'],legalComments:'none',logLevel:'warning',
    plugins: [{ name: 'durable-probe-sdk', setup(plugin) {
      plugin.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({ path: 'sdk', namespace: 'durable-probe-sdk' }));
      plugin.onLoad({ filter: /.*/, namespace: 'durable-probe-sdk' }, () => ({ contents: sdkExports, loader: 'js', resolveDir: root }));
    } }],
    banner:{js:'import {createRequire as __workerRequire} from "node:module"; const require=__workerRequire(import.meta.url);'},
  });
  const external=Object.values(result.metafile.outputs).flatMap(o=>o.imports).filter(i=>i.external&&!isBuiltin(i.path)&&!['jiti','jiti/static','bufferutil','utf-8-validate','kerberos'].includes(i.path));
  if(external.length)throw Error('Unpackaged worker dependency: '+external.map(i=>i.path).join(','));
  const obsolete = [...new Set(Object.values(result.metafile.outputs).flatMap(output => Object.entries(output.inputs)
    // Pi's model resolver shares isValidThinkingLevel from cli/args; executable CLI/RPC modules remain forbidden.
    .filter(([file, info]) => info.bytesInOutput > 0 && /pi-coding-agent[\\/].*[\\/](?:cli|modes[\\/]rpc)(?:[.\\/])/.test(file)
      && !/[\\/]dist[\\/]cli[\\/]args\.js$/.test(file)).map(([file]) => file)))];
  if (obsolete.length) throw Error('Obsolete CLI entered Durable package probe: ' + obsolete.join(', '));
  const prefix='capabilities/subagent/runtime/';
  return [...result.outputFiles.map(f=>({type:'asset',fileName:prefix+relative(outdir,f.path).replaceAll('\\','/'),source:f.contents})),
    {type:'asset',fileName:prefix+'package.json',source:JSON.stringify({name:'@wavealstra/pi-durable-probe',private:true,type:'module',version:piVersion})}];
}
