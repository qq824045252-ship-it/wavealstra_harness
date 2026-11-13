import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {normalizeBotAvatar} from "../src/main/agent/work/BotAvatarImageDecoder";
import manifest from "../fixtures/bot-avatars/manifest.json";
const builtinBotAvatars=manifest.entries;
import {inspectAvatarRaster} from "../src/shared/bot-avatar-raster";
async function main(){
 const root=join(process.cwd(),"fixtures/bot-avatars");
 for(const entry of builtinBotAvatars){
  const poster=await normalizeBotAvatar(readFileSync(join(root,entry.poster.file)));
  assert.equal(inspectAvatarRaster(poster).type,"png");
  const gif=readFileSync(join(root,entry.animation!.file));
  const frame=await normalizeBotAvatar(gif);
  assert.deepEqual(frame,poster,"Real GIF decoder returns its exact first frame, re-encoded as PNG");
  const first=normalizeBotAvatar(gif);await assert.rejects(()=>normalizeBotAvatar(gif),/另一张/);await first;
 }
 for(const file of ['synthetic-mint.jpg','synthetic-mint.webp','synthetic-wide.png']){
  const output=await normalizeBotAvatar(readFileSync(join(root,file)));const info=inspectAvatarRaster(output);
  assert.equal(info.type,'png');assert(info.width<=256&&info.height<=256);
  if(file==='synthetic-wide.png'){assert.equal(info.width,256);assert.equal(info.height,128);}
 }
 await assert.rejects(()=>normalizeBotAvatar(Buffer.from('<svg/>')));
 const corrupted=readFileSync(join(root,builtinBotAvatars[0].poster.file));corrupted[45]^=255;
 await assert.rejects(()=>normalizeBotAvatar(corrupted),/解码/);
 console.log('[bot-avatar-decoder] PASS: actual emitted Photon/WASM test worker, PNG/JPEG/WebP/GIF decode and exact GIF first frame, PNG re-encode, bounded concurrency, malformed raster rejection, worker cleanup');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
