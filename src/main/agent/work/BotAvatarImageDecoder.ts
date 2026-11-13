import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectAvatarRaster } from "../../../shared/bot-avatar-raster";
import { AVATAR_UPLOAD_BYTES } from "../../../shared/bot-avatar";
let decoding = false;
/** Adapt the existing Photon Rust/WASM decoder to a bounded first-frame PNG interface.
 * The worker accepts bytes only, never user paths; no model, browser, or network is involved.
 */
export async function normalizeBotAvatar(bytes: Buffer): Promise<Buffer> {
  if (decoding) throw new Error("正在处理另一张头像，请稍后重试");
  if (bytes.length > AVATAR_UPLOAD_BYTES) throw new Error("头像文件最大 2 MB");
  inspectAvatarRaster(bytes);
  decoding=true;
  let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const directory=typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
    worker=new Worker(join(directory,"bot-avatar-image-worker.cjs"),{resourceLimits:{maxOldGenerationSizeMb:64,maxYoungGenerationSizeMb:16,stackSizeMb:4}});
    const active=worker, input=new Uint8Array(bytes);
    const result=await new Promise<Buffer>((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error("头像解码超时，请选择其他图片")),5000);
      active.once("error",()=>reject(new Error("头像解码器暂不可用，请重试")));
      active.once("exit",()=>reject(new Error("头像解码器已退出，请重试")));
      active.on("message",message=>{
        if(message?.type === "bot-avatar:error")reject(new Error("图片无法解码，请选择有效的 PNG、JPEG、GIF 或静态 WebP"));
        if(message?.type === "bot-avatar:poster" && message.poster instanceof Uint8Array && message.poster.length<=128*1024)resolve(Buffer.from(message.poster));
      });
      active.postMessage({bytes:input},[input.buffer]);
    });
    const output=inspectAvatarRaster(result);
    if(output.type!=="png"||output.frames!==1||output.width>256||output.height>256)throw new Error("头像转换结果无效");
    return result;
  } finally {if(timer)clearTimeout(timer);if(worker)await worker.terminate();decoding=false;}
}
