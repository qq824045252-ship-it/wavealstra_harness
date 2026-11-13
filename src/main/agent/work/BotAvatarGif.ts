import {inspectAvatarRaster} from "../../../shared/bot-avatar-raster";
/** Preserve raster/GCE blocks, discard comments/application/plain-text metadata, force a local infinite loop. */
export function sanitizeBotAvatarGif(bytes: Buffer): Buffer {
 const info=inspectAvatarRaster(bytes);
 if(info.type!=="gif"||info.width>256||info.height>256||info.frames>48||info.durationMs>10000||bytes.length>1024*1024)
   throw new Error("GIF 头像最大 256 × 256、48 帧、10 秒和 1 MB");
 const globalEnd=13+((bytes[10]&128)?3*(2**((bytes[10]&7)+1)):0);
 const chunks=[Buffer.from("GIF89a","ascii"),bytes.subarray(6,globalEnd),Buffer.from([0x21,0xff,11]),Buffer.from("NETSCAPE2.0","ascii"),Buffer.from([3,1,0,0,0])];
 let p=globalEnd;
 const blocks=()=>{while(bytes[p])p+=bytes[p]+1;p++;};
 while(p<bytes.length){
  const start=p,tag=bytes[p++];
  if(tag===0x3b){chunks.push(Buffer.from([0x3b]));break;}
  if(tag===0x21){const label=bytes[p++];blocks();if(label===0xf9)chunks.push(bytes.subarray(start,p));}
  else if(tag===0x2c){const packed=bytes[p+8];p+=9;if(packed&128)p+=3*(2**((packed&7)+1));p++;blocks();chunks.push(bytes.subarray(start,p));}
 }
 return Buffer.concat(chunks);
}
