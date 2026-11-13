import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {readFileSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {limitAvatarWasmMemory} from './avatar-wasm-memory-limit.mjs';
export const AVATAR_WASM_FILE='bot-avatar-photon.wasm';
export function avatarPhotonBuildOptions(root) {
 const piRoot=realpathSync(join(root,'node_modules/@earendil-works/pi-coding-agent'));
 const requirePi=createRequire(join(piRoot,'package.json'));
 const photonEntry=requirePi.resolve('@silvia-odwyer/photon-node');
 return {bundle:true,platform:'node',format:'cjs',target:'node22',write:false,
  alias:{'@silvia-odwyer/photon-node':photonEntry,'pi-avatar-exif':join(piRoot,'dist/utils/exif-orientation.js')},legalComments:'none',
  plugins:[{name:'avatar-bounded-photon',setup(builder){
   let patched=false;
   builder.onLoad({filter:/\.[cm]?js$/},args=>{
    if(args.path!==photonEntry)return;
    const source=readFileSync(args.path,'utf8');
    if(!source.includes('photon_rs_bg.wasm'))throw Error('Avatar Photon loader changed; cannot guarantee bounded WASM');
    patched=true;
    return {contents:source.replaceAll('photon_rs_bg.wasm',AVATAR_WASM_FILE),loader:'js',resolveDir:dirname(args.path)};
   });
   builder.onEnd(()=>{if(!patched)throw Error('Avatar Photon loader was not bounded; refusing decoder output');});
  }}]};
}
export async function buildBotAvatarImageAssets(root) {
 const options=avatarPhotonBuildOptions(root);
 const result=await build({...options,entryPoints:[join(root,'src/main/agent/work/bot-avatar-image-worker.mjs')]});
 const wasm=readFileSync(join(dirname(options.alias['@silvia-odwyer/photon-node']),'photon_rs_bg.wasm'));
 return [{type:'asset',fileName:'bot-avatar-image-worker.cjs',source:result.outputFiles[0].text},
  {type:'asset',fileName:AVATAR_WASM_FILE,source:limitAvatarWasmMemory(wasm)}];
}
