import {inspectAvatarRaster} from '../../../shared/bot-avatar-raster';
import { parentPort } from 'node:worker_threads';
import { applyExifOrientation } from 'pi-avatar-exif';
parentPort.once('message', async ({bytes}) => {
  // Defense in depth: do not enter WASM even if a caller bypassed the main-process preflight.
  try {inspectAvatarRaster(bytes);}catch {parentPort.postMessage({type:'bot-avatar:error',code:'invalid_container'});return;}
  let raw,oriented,resized;
  try {
    const photon=await import('@silvia-odwyer/photon-node');
    raw=photon.PhotonImage.new_from_byteslice(bytes);
    oriented=applyExifOrientation(photon,raw,bytes);
    const width=oriented.get_width(),height=oriented.get_height();
    if(!width||!height||width>2048||height>2048||width*height>4194304)throw Error('图片实际尺寸无效');
    const scale=Math.min(1,256/width,256/height);
    resized=photon.resize(oriented,Math.max(1,Math.round(width*scale)),Math.max(1,Math.round(height*scale)),photon.SamplingFilter.Lanczos3);
    const poster=new Uint8Array(resized.get_bytes());
    if(poster.byteLength>128*1024)throw Error('转换后的头像过大，请选择其他图片');
    parentPort.postMessage({type:'bot-avatar:poster',poster},[poster.buffer]);
  } catch {parentPort.postMessage({type:'bot-avatar:error',message:'图片无法解码，请选择有效的 PNG、JPEG、GIF 或静态 WebP'});}
  finally {resized?.free();if(oriented && oriented!==raw)oriented.free();raw?.free();}
});
