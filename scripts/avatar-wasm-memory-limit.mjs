/** Limit the avatar decoder's own wasm32 memory. Do not alter the shared Pi WASM asset. */
export const AVATAR_WASM_MAX_PAGES = 2048; // 128 MiB; V8 Worker heap limits do not cap WASM memory.
function readU32(bytes,state) {
 let value=0,shift=0;
 for(let i=0;i<5;i++) {
  if(state.p>=bytes.length)throw Error('Truncated WASM integer');
  const byte=bytes[state.p++];if(i===4&&(byte&0xf0))throw Error('Invalid WASM integer');
  value+=(byte&127)*2**shift;
  if(!(byte&128))return value;
  shift+=7;
 }
 throw Error('Invalid WASM integer');
}
function leb(value) {
 const bytes=[];
 do {let byte=value%128;value=Math.floor(value/128);if(value)byte|=128;bytes.push(byte);}while(value);
 return Buffer.from(bytes);
}
export function limitAvatarWasmMemory(input) {
 const bytes=Buffer.from(input);
 if(!bytes.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])))throw Error('Unsupported avatar WASM header');
 const parts=[bytes.subarray(0,8)],state={p:8};let found=false;
 while(state.p<bytes.length) {
  const sectionStart=state.p,id=bytes[state.p++],size=readU32(bytes,state),start=state.p,end=start+size;
  if(end>bytes.length)throw Error('Truncated avatar WASM section');
  if(id===5) {
   if(found)throw Error('Duplicate avatar WASM memory section');found=true;
   const section={p:start};
   if(readU32(bytes,section)!==1)throw Error('Avatar WASM must define exactly one memory');
   const flags=readU32(bytes,section);
   if(flags!==0&&flags!==1)throw Error('Only unshared wasm32 avatar memory is supported');
   const minimum=readU32(bytes,section),maximum=flags===1?readU32(bytes,section):AVATAR_WASM_MAX_PAGES;
   const limited=Math.min(maximum,AVATAR_WASM_MAX_PAGES);
   if(section.p!==end||minimum>limited)throw Error('Avatar WASM cannot fit its memory budget');
   const payload=Buffer.concat([leb(1),leb(1),leb(minimum),leb(limited)]);
   parts.push(Buffer.from([5]),leb(payload.length),payload);
  } else parts.push(bytes.subarray(sectionStart,end));
  state.p=end;
 }
 if(!found)throw Error('Avatar WASM must define bounded memory');
 const output=Buffer.concat(parts);
 const module=new WebAssembly.Module(output);
 if(WebAssembly.Module.imports(module).some(item=>item.kind==='memory')||WebAssembly.Module.exports(module).filter(item=>item.kind==='memory').length!==1)throw Error('Unsupported avatar WASM memory layout');
 return output;
}
