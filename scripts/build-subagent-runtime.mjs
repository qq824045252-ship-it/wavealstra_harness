/** Bundle the installed Pi CLI and SDK ONCE for a portable, version-locked worker. */
import { build } from 'esbuild';
import { createRequire, isBuiltin } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { piReferenceAssets } from './build-pi-codemode-assets.mjs';

export async function buildSubagentRuntime(root) {
  const piRoot=realpathSync(join(root,'node_modules/@earendil-works/pi-coding-agent'));
  const requirePi=createRequire(join(piRoot,'package.json'));
  const aiRoot=realpathSync(requirePi.resolve.paths('@earendil-works/pi-ai').map(p=>join(p,'@earendil-works/pi-ai')).find(p=>{try{return JSON.parse(readFileSync(join(p,'package.json'),'utf8')).name==='@earendil-works/pi-ai';}catch{return false;}}));
  const piVersion=JSON.parse(readFileSync(join(piRoot,'package.json'),'utf8')).version;
  const aiVersion=JSON.parse(readFileSync(join(aiRoot,'package.json'),'utf8')).version;
  const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  const expected=manifest.devDependencies?.['@earendil-works/pi-coding-agent'] ?? manifest.dependencies?.['@earendil-works/pi-coding-agent'];
  if(!/^\d+\.\d+\.\d+$/.test(expected)||piVersion!==expected||aiVersion!==piVersion)throw Error('Subagent Runtime versions are inconsistent');
  const launcher=readFileSync(join(root,'src/main/capabilities/subagent/worker-launcher.mjs'),'utf8');
  if(!launcher.includes('const EXPECTED_PI_VERSION = '+JSON.stringify(expected)+';'))throw Error('Subagent launcher version pin must match the installed runtime');
  const spec=p=>JSON.stringify(p.replaceAll('\\','/'));
  const entry=[
    `export * as pi from ${spec(join(piRoot,'dist/index.js'))};`,
    `export * as ai from ${spec(join(aiRoot,'dist/index.js'))};`,
    `export {main} from ${spec(join(piRoot,'dist/main.js'))};`,
    `export {setupCli} from ${spec(join(piRoot,'dist/cli/setup.js'))};`,
    `export {loadExtensionFromFactory} from ${spec(join(piRoot,'dist/core/extensions/loader.js'))};`,
    `export {writeRawStdout} from ${spec(join(piRoot,'dist/core/output-guard.js'))};`,
    `export {anthropicMessagesApi} from ${spec(join(aiRoot,'dist/api/anthropic-messages.lazy.js'))};`,
    `export {openAICompletionsApi} from ${spec(join(aiRoot,'dist/api/openai-completions.lazy.js'))};`,
    `export {openAIResponsesApi} from ${spec(join(aiRoot,'dist/api/openai-responses.lazy.js'))};`,
    `import {registerBunOAuthFlows} from ${spec(join(aiRoot,'dist/bun-oauth.js'))}; registerBunOAuthFlows();`,
    `import {bedrockProviderModule} from ${spec(join(aiRoot,'dist/bedrock-provider.js'))};`,
    `import {setBedrockProviderModule} from ${spec(join(aiRoot,'dist/compat.js'))}; setBedrockProviderModule(bedrockProviderModule);`,
  ].join('\n');
  const outdir=join(root,'out/subagent-runtime-build');
  const result=await build({stdin:{contents:entry,resolveDir:root,sourcefile:'pi-worker-runtime-entry.mjs',loader:'js'},outdir,
    entryNames:'pi-runtime',chunkNames:'chunks/[name]-[hash]',outExtension:{'.js':'.mjs'},
    bundle:true,platform:'node',format:'esm',target:'node22',splitting:true,write:false,metafile:true,
    external:['jiti','bufferutil','utf-8-validate','kerberos'],legalComments:'none',logLevel:'warning',
    banner:{js:'import {createRequire as __workerRequire} from "node:module"; const require=__workerRequire(import.meta.url);'},
  });
  const external=Object.values(result.metafile.outputs).flatMap(o=>o.imports).filter(i=>i.external&&!isBuiltin(i.path)&&!['jiti','jiti/static','bufferutil','utf-8-validate','kerberos'].includes(i.path));
  if(external.length)throw Error('Unpackaged worker dependency: '+external.map(i=>i.path).join(','));
  const prefix='capabilities/subagent/runtime/';
  return [...piReferenceAssets(piRoot, prefix+'docs/'), ...result.outputFiles.map(f=>({type:'asset',fileName:prefix+relative(outdir,f.path).replaceAll('\\','/'),source:f.contents})),
    {type:'asset',fileName:prefix+'package.json',source:JSON.stringify({name:'@wavealstra/pi-worker-runtime',private:true,type:'module',version:piVersion,piConfig:{name:'pi',configDir:'.pi'}})}];
}
