/** Bounded structural preflight; this must run before a native/WASM raster allocation. */
export interface AvatarRasterInfo {
  type: "png" | "jpeg" | "gif" | "webp";
  width: number; height: number; frames: number; durationMs: number;
}
const MAX_EDGE = 2048;
const MAX_PIXELS = 4 * 1024 * 1024;
const MAX_FRAME_PIXELS = 16 * 1024 * 1024;
function checkDimensions(width: number, height: number, frames = 1): void {
  if (!width || !height || width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS || width * height * frames > MAX_FRAME_PIXELS)
    throw new Error("头像尺寸过大，最大 2048 × 2048，动图累计像素最多 1600 万");
}
const crcTable = Uint32Array.from({length:256}, (_,value) => {
  for (let bit=0;bit<8;bit++) value=(value&1) ? 0xedb88320^(value>>>1) : value>>>1;
  return value>>>0;
});
function pngCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc=0xffffffff;
  for(let p=start;p<end;p++)crc=crcTable[(crc^bytes[p])&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
export function inspectAvatarRaster(bytes: Uint8Array): AvatarRasterInfo {
  const b=bytes, view=new DataView(b.buffer,b.byteOffset,b.byteLength);
  if(!b.length || b.length>2*1024*1024)throw new Error("头像文件最大 2 MB，不能使用空文件");
  const ascii=(start:number,length:number)=>String.fromCharCode(...b.subarray(start,start+length));
  const u16=(n:number)=>view.getUint16(n,true), u32=(n:number)=>view.getUint32(n,true);
  const be32=(n:number)=>view.getUint32(n);
  const u24=(n:number)=>b[n]+(b[n+1]<<8)+(b[n+2]<<16);
  let width=0,height=0,frames=1,durationMs=0;
  let type: AvatarRasterInfo["type"];
  if(b.length>=33 && ascii(0,8)==="\x89PNG\r\n\x1a\n") {
    type="png";
    let p=8,header=false,data=false,dataEnded=false,end=false,palette=0,transparency=false,dataBytes=0,colorType=-1;
    while(p<b.length) {
      if(b.length-p<12)throw new Error("PNG 块不完整");
      const length=be32(p),tag=ascii(p+4,4),start=p+8;
      if(length>b.length-p-12)throw new Error("PNG 数据不完整");
      if(!/^[A-Za-z]{4}$/.test(tag) || (b[p+6]&32))throw new Error("PNG 块类型无效");
      if(pngCrc(b,p+4,start+length)!==be32(start+length))throw new Error("PNG 块校验失败，图片无法解码");
      if(!header && tag!=="IHDR")throw new Error("PNG 必须以 IHDR 开始");
      if(["acTL","fcTL","fdAT"].includes(tag))throw new Error("请使用静态 PNG，或上传 GIF 动画");
      if(tag==="IHDR") {
        if(header || p!==8 || length!==13)throw new Error("PNG IHDR 重复或无效");
        header=true;width=be32(start);height=be32(start+4);checkDimensions(width,height);
        const depth=b[start+8];colorType=b[start+9];
        const depths:Record<number,readonly number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
        if(!depths[colorType]?.includes(depth) || b[start+10]!==0 || b[start+11]!==0 || b[start+12]>1)throw new Error("PNG 图像格式无效");
      } else if(tag==="PLTE") {
        if(palette || data || !length || length>768 || length%3 || [0,4].includes(colorType))throw new Error("PNG 调色板重复或无效");
        palette=length/3;
      } else if(tag==="tRNS") {
        if(transparency || data || !((colorType===0&&length===2)||(colorType===2&&length===6)||(colorType===3&&palette&&length>0&&length<=palette)))throw new Error("PNG 透明信息重复或无效");
        transparency=true;
      } else if(tag==="IDAT") {
        if(dataEnded || (colorType===3&&!palette))throw new Error("PNG 图像数据顺序无效");
        data=true;dataBytes+=length;
      } else if(tag==="IEND") {
        if(length || !data || !dataBytes)throw new Error("PNG 结束块无效");
        end=true;p=start+length+4;
        if(p!==b.length)throw new Error("PNG 含额外数据");
        break;
      } else if(!(b[p+4]&32))throw new Error("PNG 含不支持的关键块");
      if(data && tag!=="IDAT")dataEnded=true;
      p=start+length+4;
    }
    if(!end)throw new Error("PNG 数据不完整");
  } else if(b.length>=13 && ["GIF87a","GIF89a"].includes(ascii(0,6))) {
    type="gif";width=u16(6);height=u16(8);frames=0;checkDimensions(width,height);
    const globalColors=(b[10]&128) ? 2**((b[10]&7)+1) : 0;
    let p=13+3*globalColors,ended=false,pendingDelay:number|undefined,pendingTransparent:number|undefined;
    if(p>=b.length || (globalColors&&b[11]>=globalColors))throw new Error("GIF 全局调色板无效");
    const blocks=()=>{
      let total=0;
      while(p<b.length) {
        const count=b[p++];if(!count)return total;
        if(count>b.length-p)throw new Error("GIF 数据不完整");
        total+=count;p+=count;
      }
      throw new Error("GIF 数据不完整");
    };
    while(p<b.length) {
      const tag=b[p++];
      if(tag===0x3b){ended=p===b.length && pendingDelay===undefined;break;}
      if(tag===0x21) {
        if(p>=b.length)throw new Error("GIF 扩展不完整");
        const label=b[p++];
        if(label===0xf9) {
          if(pendingDelay!==undefined || p+6>b.length || b[p]!==4 || b[p+5]!==0 || (b[p+1]&0xe0) || ((b[p+1]>>2)&7)>3)throw new Error("GIF 控制块重复或无效");
          pendingDelay=Math.max(20,u16(p+2)*10);pendingTransparent=(b[p+1]&1) ? b[p+4] : undefined;p+=6;
        } else if(label===0xff) {
          if(b[p]!==11 || p+12>b.length)throw new Error("GIF 应用扩展无效");
          p+=12;blocks();
        } else if(label===0xfe)blocks();
        else throw new Error("GIF 含不支持的扩展");
      } else if(tag===0x2c) {
        if(p+9>b.length)throw new Error("GIF 帧不完整");
        const fw=u16(p+4),fh=u16(p+6),packed=b[p+8];
        checkDimensions(fw,fh);
        if(u16(p)+fw>width || u16(p+2)+fh>height || (packed&0x18))throw new Error("GIF 帧尺寸或标记无效");
        frames++;if(frames>60)throw new Error("GIF 最多 60 帧");checkDimensions(width,height,frames);
        const localColors=(packed&128) ? 2**((packed&7)+1) : 0,colors=localColors||globalColors;
        p+=9+3*localColors;
        if(!colors || p>=b.length || (pendingTransparent!==undefined&&pendingTransparent>=colors) || b[p]<2 || b[p]>8)throw new Error("GIF 调色板或编码无效");
        p++;if(!blocks())throw new Error("GIF 图像数据为空");
        durationMs+=pendingDelay??20;pendingDelay=undefined;pendingTransparent=undefined;
        if(durationMs>15000)throw new Error("GIF 时长最多 15 秒");
      } else throw new Error("GIF 数据无效");
    }
    if(!ended || !frames)throw new Error("GIF 数据不完整");
  } else if(b.length>=12 && ascii(0,4)==="RIFF" && ascii(8,4)==="WEBP") {
    type="webp";
    if(u32(4)+8!==b.length)throw new Error("WebP RIFF 长度无效");
    let p=12,canvas:{width:number;height:number}|undefined,flags=0,imageTag="",alphaBytes=0,alphaCompression=-1;
    const seen=new Set<string>();
    while(p<b.length) {
      if(b.length-p<8)throw new Error("WebP 块头不完整");
      const tag=ascii(p,4),size=u32(p+4),start=p+8,end=start+size,next=end+(size&1);
      if(size>b.length-start || next>b.length || ((size&1)&&b[end]!==0))throw new Error("WebP 块长度或填充无效");
      if(seen.has(tag))throw new Error("WebP 块重复，拒绝歧义容器");
      seen.add(tag);
      if(tag==="ANIM" || tag==="ANMF")throw new Error("请使用静态 WebP");
      if(tag==="VP8X") {
        if(p!==12 || size!==10)throw new Error("WebP VP8X 顺序或长度无效");
        flags=b[start];
        if(flags&2)throw new Error("请使用静态 WebP");
        if((flags&0xc1)||b[start+1]||b[start+2]||b[start+3])throw new Error("WebP VP8X 保留位无效");
        canvas={width:u24(start+4)+1,height:u24(start+7)+1};checkDimensions(canvas.width,canvas.height);
      } else if(tag==="VP8 " || tag==="VP8L") {
        if(imageTag)throw new Error("WebP 图像块重复，拒绝混合编码");
        imageTag=tag;
        if(tag==="VP8L") {
          if(size<5 || b[start]!==0x2f || (u32(start+1)>>>29)!==0 || seen.has("ALPH"))throw new Error("WebP VP8L 文件头无效");
          const value=u32(start+1);width=(value&16383)+1;height=((value>>>14)&16383)+1;
        } else {
          if(size<10 || (b[start]&1) || ((b[start]>>1)&7)>3 || ascii(start+3,3)!=="\x9d\x01\x2a" || (u16(start+6)&0xc000) || (u16(start+8)&0xc000))throw new Error("WebP VP8 文件头无效");
          width=u16(start+6)&16383;height=u16(start+8)&16383;
        }
        // Check this bitstream's own dimensions immediately; never replace them with later metadata.
        checkDimensions(width,height);
        if(canvas && (width!==canvas.width || height!==canvas.height))throw new Error("WebP VP8X 与实际图像尺寸不一致");
      } else if(tag==="ALPH") {
        if(!canvas || !(flags&16) || imageTag || size<2 || (b[start]&0xc0) || (b[start]&3)>1 || ((b[start]>>4)&3)>1)throw new Error("WebP ALPH 顺序或格式无效");
        alphaBytes=size-1;alphaCompression=b[start]&3;
      } else if(tag==="ICCP") {
        if(!canvas || !(flags&32) || imageTag || seen.has("ALPH") || !size)throw new Error("WebP ICCP 顺序或标记无效");
      } else if(tag==="EXIF" || tag==="XMP ") {
        if(!canvas || !(flags&(tag==="EXIF"?8:4)) || !size)throw new Error("WebP 元数据标记无效");
      } else throw new Error("WebP 含不支持的块，拒绝歧义容器");
      p=next;
    }
    if(!imageTag)throw new Error("WebP 缺少图像块");
    if(!canvas && seen.size!==1)throw new Error("WebP 简单容器含额外块");
    if(canvas && ([['ICCP',32],['EXIF',8],['XMP ',4]] as const).some(([tag,flag])=>seen.has(tag)!==Boolean(flags&flag)))throw new Error("WebP 元数据块与标记不一致");
    if(imageTag==="VP8 " && (seen.has("ALPH")!==Boolean(flags&16) || (alphaCompression===0&&alphaBytes!==width*height)))throw new Error("WebP alpha 与图像不一致");
  } else if(b.length>=4 && b[0]===255 && b[1]===216) {
    type="jpeg";
    let p=2,header=false,scan=false,end=false;
    while(p<b.length) {
      if(b[p++]!==255)throw new Error("JPEG 标记无效");
      while(p<b.length&&b[p]===255)p++;
      if(p>=b.length)throw new Error("JPEG 标记不完整");
      const tag=b[p++];
      if(tag===0xd9){end=p===b.length;break;}
      if(tag===0 || tag===0xd8 || (tag>=0xd0&&tag<=0xd7) || tag===0xdc || tag===0xde || tag===0xdf)throw new Error("JPEG 含重复或歧义图像标记");
      if(p+2>b.length)throw new Error("JPEG 段不完整");
      const size=view.getUint16(p);
      if(size<2 || size>b.length-p)throw new Error("JPEG 数据不完整");
      if(tag>=0xc0&&tag<=0xcf&&![0xc4,0xc8,0xcc].includes(tag)) {
        if(header || ![0xc0,0xc1,0xc2].includes(tag) || size<8 || b[p+2]!==8 || ![1,3,4].includes(b[p+7]) || size!==8+3*b[p+7])throw new Error("JPEG 图像头重复或格式无效");
        header=true;height=view.getUint16(p+3);width=view.getUint16(p+5);checkDimensions(width,height);
      }
      if(tag===0xda) {
        if(!header || size<6 || !b[p+2] || size!==6+2*b[p+2])throw new Error("JPEG 扫描头无效");
        scan=true;p+=size;
        // Scan entropy bytes without interpreting them; stuffed FF00 and restart markers aren't new headers.
        while(p<b.length) {
          if(b[p]!==255){p++;continue;}
          const marker=p;while(p<b.length&&b[p]===255)p++;
          if(p>=b.length)throw new Error("JPEG 扫描不完整");
          if(b[p]===0 || (b[p]>=0xd0&&b[p]<=0xd7)){p++;continue;}
          p=marker;break;
        }
      } else p+=size;
    }
    if(!header || !scan || !end)throw new Error("JPEG 数据不完整");
  } else throw new Error("仅支持 PNG、JPEG、GIF 和静态 WebP 图片");
  checkDimensions(width,height,frames);
  return {type,width,height,frames,durationMs};
}
