import assert from "node:assert/strict";
import {Worker} from "node:worker_threads";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {crc32} from "node:zlib";
import {inspectAvatarRaster} from "../src/shared/bot-avatar-raster";
import {normalizeBotAvatar} from "../src/main/agent/work/BotAvatarImageDecoder";
import {sanitizeBotAvatarGif} from "../src/main/agent/work/BotAvatarGif";
const root=join(process.cwd(),"fixtures/bot-avatars");
async function probe(file:string,bytes:Buffer,post=false):Promise<Record<string,any>> {
 const worker=new Worker(join(__dirname,file),{workerData:post?undefined:{bytes:new Uint8Array(bytes)}});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error("decoder fixture timed out")),5000);
  worker.once("error",reject);worker.once("message",resolve);
  if(post)worker.postMessage({bytes:new Uint8Array(bytes)});
 });}finally{if(timer)clearTimeout(timer);await worker.terminate();}
}
function webpChunks(bytes:Buffer):Buffer[] {
 const result:Buffer[]=[];
 for(let p=12;p<bytes.length;){const next=p+8+bytes.readUInt32LE(p+4)+(bytes.readUInt32LE(p+4)&1);result.push(bytes.subarray(p,next));p=next;}
 return result;
}
function chunk(tag:string,payload:Buffer,pad=0):Buffer {
 const header=Buffer.alloc(8);header.write(tag);header.writeUInt32LE(payload.length,4);
 return Buffer.concat([header,payload,...(payload.length&1?[Buffer.from([pad])]:[])]);
}
function riff(chunks:Buffer[]):Buffer {
 const body=Buffer.concat(chunks),header=Buffer.from('RIFF0000WEBP');header.writeUInt32LE(body.length+4,4);return Buffer.concat([header,body]);
}
function extended(width:number,height:number,flags=0):Buffer {
 const body=Buffer.alloc(10);body[0]=flags;body.writeUIntLE(width-1,4,3);body.writeUIntLE(height-1,7,3);return chunk('VP8X',body);
}
function pngChunk(tag:string,payload:Buffer):Buffer {
 const header=Buffer.alloc(8),crc=Buffer.alloc(4);header.writeUInt32BE(payload.length);header.write(tag,4);crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(tag),payload])));return Buffer.concat([header,payload,crc]);
}
function pngDimensions(bytes:Buffer,width:number,height:number):Buffer {
 const result=Buffer.from(bytes);result.writeUInt32BE(width,16);result.writeUInt32BE(height,20);result.writeUInt32BE(crc32(result.subarray(12,29)),29);return result;
}
function firstGifFrame(bytes:Buffer):{start:number;end:number;gce:number;header:number} {
 let p=13+((bytes[10]&128)?3*2**((bytes[10]&7)+1):0),gce=-1;const header=p;
 while(bytes[p]===0x21){if(bytes[p+1]===0xf9)gce=p;p+=2;while(bytes[p])p+=1+bytes[p];p++;}
 assert.equal(bytes[p],0x2c);const start=p;p+=10+((bytes[p+9]&128)?3*2**((bytes[p+9]&7)+1):0);p++;
 while(bytes[p])p+=1+bytes[p];p++;return {start,end:p,gce,header};
}
async function main(){
 const attack=readFileSync(join(root,"webp-large-first-small-last.webp"));
 const decoded=await probe("bot-avatar-raw-decode-probe.cjs",attack);
 assert.deepEqual(decoded,{width:4096,height:4096},"Actual Photon takes the first large image, not the trailing small one");
 let inspected:unknown;try{inspected=inspectAvatarRaster(attack);}catch{inspected="rejected";}
 console.log('[bot-avatar-container] real decoder reproduction',JSON.stringify({bytes:attack.length,decoded,preflight:inspected}));
 assert.throws(()=>inspectAvatarRaster(attack),/WebP|尺寸/,"Ambiguous WebP must be rejected before native/WASM decoding");
 await assert.rejects(()=>normalizeBotAvatar(attack),/WebP|尺寸/);
 const simple=readFileSync(join(root,'synthetic-mint.webp')),image=webpChunks(simple).find(part=>part.toString('ascii',0,4)==='VP8L')!;
 const losslessInfo=inspectAvatarRaster(simple);assert.equal(losslessInfo.width,128);
 const validExtended=riff([extended(128,128),image]);
 assert.equal(inspectAvatarRaster(validExtended).width,128);
 assert.deepEqual(await probe('bot-avatar-raw-decode-probe.cjs',validExtended),{width:128,height:128});
 const alpha=readFileSync(join(root,'synthetic-alpha-lossy.webp'));assert.equal(inspectAvatarRaster(alpha).width,128);
 const lossyImage=webpChunks(alpha).find(part=>part.toString('ascii',0,4)==='VP8 ')!;
 const truncatedLossless=chunk('VP8L',Buffer.from([47,0,0,0]));
 const badVersion=Buffer.from(image);badVersion[12]|=0xe0;
 const badReserved=Buffer.from(extended(128,128));badReserved[9]=1;
 const shortExtended=chunk('VP8X',Buffer.alloc(9));
 const crcPng=readFileSync(join(root,'synthetic-mint.png')),gif=readFileSync(join(root,'synthetic-mint.gif'));
 const gifFrame=firstGifFrame(gif),repeat=(count:number)=>Buffer.concat([gif.subarray(0,gifFrame.header),...Array.from({length:count},()=>gif.subarray(gifFrame.start,gifFrame.end)),Buffer.from([0x3b])]);
 const gifOversizedFrame=Buffer.from(gif);gifOversizedFrame.writeUInt16LE(4096,gifFrame.start+5);
 const gifOutside=Buffer.from(gif);gifOutside.writeUInt16LE(128,gifFrame.start+1);
 const gifDuration=Buffer.from(gif);assert(gifFrame.gce>=0);gifDuration.writeUInt16LE(2000,gifFrame.gce+4);
 const gifPixels=repeat(5);gifPixels.writeUInt16LE(2048,6);gifPixels.writeUInt16LE(2048,8);
 const pngHeader=crcPng.subarray(8,33),pngLargeHeader=pngDimensions(crcPng,4096,4096).subarray(8,33);
 const pngBadCrc=Buffer.from(crcPng);pngBadCrc[29]^=1;
 const badRiffSize=Buffer.from(simple);badRiffSize.writeUInt32LE(simple.length+100,4);
 const badChunkSize=Buffer.from(simple);badChunkSize.writeUInt32LE(0xffffffff,16);
 const malformed:Record<string,Buffer>={
  'WebP real large-first/small-last':attack,
  'WebP reverse duplicate':riff(webpChunks(attack).reverse()),
  'WebP same-size duplicate':riff([image,image]),
  'WebP VP8 then VP8L':riff([lossyImage,image]),
  'WebP VP8L then VP8':riff([image,lossyImage]),
  'WebP duplicate VP8X':riff([extended(128,128),extended(128,128),image]),
  'WebP canvas width mismatch':riff([extended(127,128),image]),
  'WebP canvas height mismatch':riff([extended(128,127),image]),
  'WebP canvas oversized':riff([extended(4096,4096),image]),
  'WebP late canvas':riff([image,extended(128,128)]),
  'WebP canvas only':riff([extended(128,128)]),
  'WebP short VP8L':riff([truncatedLossless]),
  'WebP reserved VP8L version':riff([badVersion]),
  'WebP reserved VP8X bytes':riff([badReserved,image]),
  'WebP short VP8X':riff([shortExtended,image]),
  'WebP missing metadata':riff([extended(128,128,8),image]),
  'WebP duplicate metadata':riff([extended(128,128,4),image,chunk('XMP ',Buffer.from('a')),chunk('XMP ',Buffer.from('b'))]),
  'WebP metadata undeclared':riff([extended(128,128),image,chunk('XMP ',Buffer.from('a'))]),
  'WebP nonzero padding':riff([extended(128,128,4),image,chunk('XMP ',Buffer.from('a'),1)]),
  'WebP unknown chunk':riff([extended(128,128),image,chunk('JUNK',Buffer.from('ab'))]),
  'WebP bad RIFF size':badRiffSize,
  'WebP bad chunk size':badChunkSize,
  'WebP trailing chunk header':riff([image,Buffer.from('EXIF')]),
  'WebP animation marker':riff([extended(128,128,2),image]),
  'WebP ANIM without marker':riff([image,chunk('ANIM',Buffer.alloc(6))]),
  'PNG duplicate header':Buffer.concat([crcPng.subarray(0,33),pngHeader,crcPng.subarray(33)]),
  'PNG small then large header':Buffer.concat([crcPng.subarray(0,33),pngLargeHeader,crcPng.subarray(33)]),
  'PNG large then small header':Buffer.concat([pngDimensions(crcPng,4096,4096).subarray(0,33),pngHeader,crcPng.subarray(33)]),
  'PNG oversized CRC-valid header':pngDimensions(crcPng,2049,128),
  'PNG bad CRC':pngBadCrc,
  'PNG short end':crcPng.subarray(0,-1),
  'PNG trailing data':Buffer.concat([crcPng,Buffer.from('junk')]),
  'PNG APNG control':Buffer.concat([crcPng.subarray(0,33),pngChunk('acTL',Buffer.alloc(8)),crcPng.subarray(33)]),
  'PNG APNG frame without control':Buffer.concat([crcPng.subarray(0,33),pngChunk('fcTL',Buffer.alloc(26)),crcPng.subarray(33)]),
  'PNG unknown critical chunk':Buffer.concat([crcPng.subarray(0,33),pngChunk('ABCD',Buffer.alloc(0)),crcPng.subarray(33)]),
  'GIF oversized frame':gifOversizedFrame,
  'GIF frame outside canvas':gifOutside,
  'GIF duplicate control':Buffer.concat([gif.subarray(0,gifFrame.start),gif.subarray(gifFrame.gce,gifFrame.gce+8),gif.subarray(gifFrame.start)]),
  'GIF truncated data':gif.subarray(0,-2),
  'GIF trailing image':Buffer.concat([gif,gif]),
  'GIF empty frames':Buffer.concat([gif.subarray(0,gifFrame.header),Buffer.from([0x3b])]),
  'GIF frame count budget':repeat(61),
  'GIF canvas/frame pixel budget':gifPixels,
  'GIF duration budget':gifDuration,
 };
 for(const [name,bytes] of Object.entries(malformed)){
  assert.throws(()=>inspectAvatarRaster(bytes),name);
  const result=await probe('bot-avatar-image-worker.cjs',bytes,true);
  assert.deepEqual(result,{type:'bot-avatar:error',code:'invalid_container'},`${name}: production Worker rejects before loading/decoding untrusted bytes`);
 }
 for(const bytes of [simple,validExtended,alpha,crcPng,gif,readFileSync(join(root,'synthetic-progressive.jpg')),readFileSync(join(root,'synthetic-maximum.png'))]){
  const output=await normalizeBotAvatar(bytes),info=inspectAvatarRaster(output);
  assert.equal(info.type,'png');assert(info.width<=256&&info.height<=256);assert(output.length<=128*1024);
 }
 const gif49=repeat(49);assert.equal(inspectAvatarRaster(gif49).frames,49);assert.throws(()=>sanitizeBotAvatarGif(gif49),/48/);
 const cleaned=sanitizeBotAvatarGif(gif);assert.equal(inspectAvatarRaster(cleaned).frames,3);
 assert.deepEqual(await normalizeBotAvatar(cleaned),await normalizeBotAvatar(gif),'Sanitized animation retains its exact poster');
 const limit=await probe('bot-avatar-wasm-limit-probe.cjs',simple);
 assert.deepEqual(limit,{growthRejected:true,growthWasAtomic:true,width:128,height:128},'Actual avatar WASM rejects memory growth beyond 128 MiB');
 console.log(`[bot-avatar-container] PASS: real-decoder red/green reproduction; ${Object.keys(malformed).length} malformed containers rejected in main and Worker preflight; PNG/GIF/WebP/progressive JPEG/max-size normal decode; animated poster; actual WASM memory ceiling`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
