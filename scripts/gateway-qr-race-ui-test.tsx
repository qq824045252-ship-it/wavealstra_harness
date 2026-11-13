import assert from "node:assert/strict";
import {parseHTML} from "linkedom";
import {act} from "react";
import QQ from "../src/renderer/src/components/settings/QQGatewaySettings";
import Weixin from "../src/renderer/src/components/settings/WeixinGatewaySettings";
const {window:w,document:d}=parseHTML("<html><body></body></html>");Object.assign(globalThis,{window:w,document:d,IS_REACT_ACT_ENVIRONMENT:true});
const {createRoot}=await import("react-dom/client");const tick=async(ms=20)=>{await act(async()=>{await new Promise(r=>setTimeout(r,ms));});};
for(const [Component,prefix,id] of [[QQ,"qq","qq-default"],[Weixin,"weixin","weixin-default"]] as const){
 let poll!:(value:any)=>void,cancel!:(value:any)=>void;
 const gateway:any={status:async()=>({channels:[{id,connected:false}]}),onEvent:()=>()=>{}};
 gateway[prefix+"QrStart"]=async()=>({state:"waiting",sessionId:"old",qrUrl:"https://example.test/qr",message:"waiting"});
 gateway[prefix+"QrState"]=()=>new Promise(r=>poll=r);
 gateway[prefix+"QrCancel"]=()=>new Promise(r=>cancel=r);
 Object.assign(w,{api:{gateway}});const host=d.body.appendChild(d.createElement("div"));const root=createRoot(host);
 const btn=(name:string)=>Array.from(host.querySelectorAll("button")).find(b=>b.textContent===name) as HTMLButtonElement;
 await act(async()=>root.render(<Component/>));await tick();await act(async()=>btn("配置").click());
 await act(async()=>{const input=host.querySelector("input") as HTMLInputElement;input.checked=true;input.dispatchEvent(new w.Event("click",{bubbles:true}));});
 await act(async()=>btn("开始扫码授权").click());await tick(1100);assert(poll);
 await act(async()=>btn("取消扫码").click());assert(cancel);
 await act(async()=>poll({state:"connected",sessionId:"old",message:"late-authorized"}));await tick();
 assert(!host.textContent?.includes("late-authorized"),"late polling response must not mutate cancelling enrollment");
 await act(async()=>cancel({state:"cancelled",sessionId:"old",message:"cancelled"}));await tick();assert.equal(host.querySelector("img"),null);
 await act(async()=>root.unmount());host.remove();
}
console.log("Gateway QR race PASS: QQ/Weixin late authorization ignored during in-flight cancellation");
