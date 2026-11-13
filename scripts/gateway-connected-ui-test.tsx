import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import QQ from "../src/renderer/src/components/settings/QQGatewaySettings";
import Weixin from "../src/renderer/src/components/settings/WeixinGatewaySettings";
const { window: w, document: d } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { window: w, document: d, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const tick = async () => { await act(async () => { await new Promise(r => setTimeout(r, 10)); }); };
for (const [Component,id,title] of [[QQ,"qq-default","QQ"],[Weixin,"weixin-default","微信"]] as const) {
 let connected=true, fail=false, starts=0, disconnects=0;
 let listener: ((event: any)=>void)|undefined;
 Object.assign(w,{api:{gateway:{
  status:async()=>{if(fail)throw new Error("offline");return {channels:[{id,connected}]};},
  onEvent:(fn:any)=>{listener=fn;return()=>{listener=undefined;};},
  qqQrStart:async()=>{starts++;throw new Error("unused");},weixinQrStart:async()=>{starts++;throw new Error("unused");},
  disconnect:async()=>{disconnects++;connected=false;}
 }}});
 const host=d.body.appendChild(d.createElement("div"));const root=createRoot(host);
 await act(async()=>root.render(<Component/>));await tick();
 const btn=(name:string)=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent===name) as HTMLButtonElement|undefined;
 assert.equal(starts,0);assert(!host.textContent?.includes("尚未开始扫码"));assert(!btn("开始扫码授权"));
 assert.equal(btn("管理")?.getAttribute("aria-expanded"),"false");
 await act(async()=>btn("管理")!.click());assert.equal(btn("收起")?.getAttribute("aria-expanded"),"true");
 await act(async()=>listener?.({channelId:id,direction:"system"}));await tick();
 assert(btn("收起"),"refresh must preserve explicit expansion");
 await act(async()=>btn("重新授权")!.click());assert(btn("开始扫码授权")?.disabled,"reauthorization requires explicit consent");
 fail=true;await act(async()=>listener?.({channelId:id,direction:"system"}));await tick();
 assert(host.textContent?.includes("状态未知"));assert(btn("开始扫码授权")?.disabled);
 fail=false;connected=false;await act(async()=>listener?.({channelId:id,direction:"system"}));await tick();
 assert(host.textContent?.includes("未连接"));assert.equal(disconnects,0);
 await act(async()=>root.unmount());assert.equal(listener,undefined);host.remove();
}
console.log("Gateway connected UI PASS: restored state, collapsed management, event refresh, consent and unknown state");
