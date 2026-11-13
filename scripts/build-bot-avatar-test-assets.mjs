import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {buildBotAvatarImageAssets,avatarPhotonBuildOptions} from './build-bot-avatar-image-assets.mjs';
import {buildPiImageResizeAssets} from './build-pi-image-resize-assets.mjs';
const root=process.cwd(),output=join(root,'out/tests');mkdirSync(output,{recursive:true});
for(const asset of [...await buildBotAvatarImageAssets(root),...await buildPiImageResizeAssets(root)])writeFileSync(join(output,asset.fileName),asset.source);

// The raw decoding probe is test-only and is never emitted into the product.
const {build}=await import('esbuild');
const {createRequire}=await import('node:module');
const {realpathSync}=await import('node:fs');
const piRoot=realpathSync(join(root,'node_modules/@earendil-works/pi-coding-agent'));
const requirePi=createRequire(join(piRoot,'package.json'));
const probe=await build({entryPoints:[join(root,'scripts/bot-avatar-raw-decode-probe.mjs')],bundle:true,platform:'node',format:'cjs',target:'node22',write:false,alias:{'@silvia-odwyer/photon-node':requirePi.resolve('@silvia-odwyer/photon-node')}});
writeFileSync(join(output,'bot-avatar-raw-decode-probe.cjs'),probe.outputFiles[0].text);

const limitedProbe=await build({...avatarPhotonBuildOptions(root),entryPoints:[join(root,'scripts/bot-avatar-wasm-limit-probe.mjs')]});
writeFileSync(join(output,'bot-avatar-wasm-limit-probe.cjs'),limitedProbe.outputFiles[0].text);
