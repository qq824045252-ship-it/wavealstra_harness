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
  const entry = 'export { VERSION, verifyPackagedDurable } from ' + spec(join(root, 'src/main/agent/durable/PackagedDurableProbe.ts')) + ';';
  const outdir=join(root,'out/subagent-runtime-build');
  const result=await build({stdin:{contents:entry,resolveDir:root,sourcefile:'pi-worker-runtime-entry.mjs',loader:'js'},outdir,
    entryNames:'pi-runtime',chunkNames:'chunks/[name]-[hash]',outExtension:{'.js':'.mjs'},
    bundle:true,platform:'node',format:'esm',target:'node22',splitting:true,write:false,metafile:true,
    external:['jiti','bufferutil','utf-8-validate','kerberos'],legalComments:'none',logLevel:'warning',
    banner:{js:'import {createRequire as __workerRequire} from "node:module"; const require=__workerRequire(import.meta.url);'},
  });
  const external=Object.values(result.metafile.outputs).flatMap(o=>o.imports).filter(i=>i.external&&!isBuiltin(i.path)&&!['jiti','jiti/static','bufferutil','utf-8-validate','kerberos'].includes(i.path));
  if(external.length)throw Error('Unpackaged worker dependency: '+external.map(i=>i.path).join(','));
  if (Object.values(result.metafile.outputs).some(output => Object.entries(output.inputs).some(([file, info]) => info.bytesInOutput > 0 && /pi-coding-agent[\\/].*[\\/](?:cli|modes[\\/]rpc)(?:[.\\/])/.test(file)))) throw Error('Obsolete CLI entered Durable package probe');
  const prefix='capabilities/subagent/runtime/';
  return [...result.outputFiles.map(f=>({type:'asset',fileName:prefix+relative(outdir,f.path).replaceAll('\\','/'),source:f.contents})),
    {type:'asset',fileName:prefix+'package.json',source:JSON.stringify({name:'@wavealstra/pi-durable-probe',private:true,type:'module',version:piVersion})}];
}
