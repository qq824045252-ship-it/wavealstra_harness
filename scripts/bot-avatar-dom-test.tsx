import assert from "node:assert/strict";
import {parseHTML} from "linkedom";
import {act} from "react";
import {BotAvatar} from "../src/renderer/src/components/common/BotAvatar";
import {BotAvatarSettings} from "../src/renderer/src/components/pages/BotAvatarSettings";
import {avatarCommand,loadAvatarImage,useBotAvatarStore} from "../src/renderer/src/lib/botAvatarStore";
import {builtinBotAvatars,type BotAvatarCommand,type BotAvatarSnapshot} from "../src/shared/bot-avatar";

const {window}=parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
const document=window.document;
Object.assign(globalThis,{window,document,HTMLElement:window.HTMLElement,Event:window.Event,IS_REACT_ACT_ENVIRONMENT:true});
Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
const mediaListeners=new Set<()=>void>();
const media={matches:false,addEventListener:(_name:string,callback:()=>void)=>mediaListeners.add(callback),removeEventListener:(_name:string,callback:()=>void)=>mediaListeners.delete(callback)};
Object.assign(window,{matchMedia:()=>media});
const observers=new Set<Observer>();
class Observer {
 constructor(private callback:(entries:Array<{isIntersecting:boolean}>)=>void){observers.add(this);}
 observe(){} disconnect(){observers.delete(this);} set(visible:boolean){this.callback([{isIntersecting:visible}]);}
}
Object.assign(globalThis,{IntersectionObserver:Observer});
let saved:BotAvatarSnapshot={selections:{},uploads:[],motion:true};
let failNext=false;
const calls:BotAvatarCommand[]=[];
const upload='upload:'+ 'a'.repeat(64);
Object.assign(window,{api:{botWork:{avatars:async(request:BotAvatarCommand)=>{
 calls.push(request);
 if(failNext){failNext=false;return {ok:false,message:'模拟保存失败'};}
 if(request.kind==='set')saved.selections[request.botId]={assetId:request.assetId,revision:request.expectedRevision+1};
 if(request.kind==='motion')saved.motion=request.enabled;
 if(request.kind==='import'&&!saved.uploads.length)saved.uploads=[{id:upload,label:'本地GIF',animated:true}];
 if(request.kind==='remove'){saved.uploads=[];for(const choice of Object.values(saved.selections))if(choice.assetId===request.assetId){choice.assetId=null;choice.revision++;}}
 return {ok:true,snapshot:structuredClone(saved),importedId:request.kind==='import'?upload:undefined,image:request.kind==='read'?`data:image/${request.variant==='animation'?'gif':'png'};base64,AAAA`:undefined};
}}}});
function Fixture({botId}:{botId:string}) {
 return <><div data-header><BotAvatar botId={botId} name={`Bot ${botId}`} play/></div>
 <div data-static>{Array.from({length:99},(_,index)=><BotAvatar key={index} botId={botId} name={`Bot ${botId}`}/>)}</div>
 <div data-message><BotAvatar botId={botId} name={`Bot ${botId}`}/><strong>Bot {botId}</strong></div>
 <BotAvatarSettings key={botId} botId={botId} name={`Bot ${botId}`}/></>;
}
async function main(){
 const {createRoot}=await import('react-dom/client');const root=createRoot(document.getElementById('root')!);
 const draw=(botId='a')=>act(async()=>{root.render(<Fixture botId={botId}/>);});
 const click=(label:string)=>act(async()=>{const button=document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);assert(button,label);button.click();});
 const visible=(value:boolean)=>act(()=>{for(const observer of observers)observer.set(value);});
 const animated=()=>document.querySelector('[data-header] [data-animated]')?.getAttribute('data-animated');
 const identity=()=>document.querySelector('[data-header] [data-avatar-id]')?.getAttribute('data-avatar-id');
 await draw();assert.equal(calls.filter(call=>call.kind==='list').length,1,'All 100+ instances share one snapshot request');
 assert.equal(identity(),'default');
 await click(builtinBotAvatars[0].label);await visible(true);assert.equal(animated(),'true');
 assert.equal(document.querySelectorAll('[data-static] [data-animated="true"]').length,0);
 assert.equal(document.querySelectorAll('canvas').length,0);
 assert.equal(document.querySelectorAll('[data-animated="true"]').length,1);
 await act(()=>{media.matches=true;for(const listener of mediaListeners)listener();});assert.equal(animated(),'false');
 assert(document.querySelector('[data-header] img')?.getAttribute('src')?.endsWith('.png'));
 await act(()=>{media.matches=false;for(const listener of mediaListeners)listener();});assert.equal(animated(),'true');
 await visible(false);assert.equal(animated(),'false');await visible(true);assert.equal(animated(),'true');
 await act(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new window.Event('visibilitychange'));});assert.equal(animated(),'false');
 await act(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new window.Event('visibilitychange'));});assert.equal(animated(),'true');
 await act(async()=>{await avatarCommand({kind:'motion',enabled:false});});assert.equal(animated(),'false');
 await draw('b');assert.equal(identity(),'default');await click(builtinBotAvatars[1].label);assert.equal(identity(),builtinBotAvatars[1].id);
 await draw('a');assert.equal(identity(),builtinBotAvatars[0].id,'Switching Bots restores each saved selection');
 failNext=true;await click(builtinBotAvatars[1].label);assert.equal(identity(),builtinBotAvatars[0].id);assert(document.querySelector('[role="alert"]')?.textContent?.includes('模拟保存失败'));
 // Import button runs the production add-then-set path and all repeated instances share a poster read.
 await act(async()=>{Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='添加本地头像')!.click();});
 assert.equal(identity(),upload);assert(document.querySelector('[data-header] img')?.getAttribute('src')?.startsWith('data:image/png;'));
 assert.equal(calls.filter(call=>call.kind==='read'&&call.assetId===upload&&call.variant==='poster').length,1);
 assert.equal(calls.filter(call=>call.kind==='read'&&call.variant==='animation').length,0,'Animation disabled means no private GIF read');
 await act(async()=>{await avatarCommand({kind:'motion',enabled:true});});await visible(true);
 assert.equal(animated(),'true');assert.equal(calls.filter(call=>call.kind==='read'&&call.variant==='animation').length,1);
 await act(()=>{document.querySelector('[data-header] img')!.dispatchEvent(new window.Event('error'));});assert.equal(animated(),'false');assert(document.querySelector('[data-header] img')?.getAttribute('src')?.startsWith('data:image/png;'));
 await act(()=>{document.querySelector('[data-header] img')!.dispatchEvent(new window.Event('error'));});assert(document.querySelector('[data-header] svg'));
 assert.equal(document.querySelector('[data-header] [role="img"]')?.getAttribute('aria-label'),'Bot a的头像');
 await act(async()=>{document.querySelector<HTMLButtonElement>('button[aria-label="移除本地GIF"]')!.click();});assert.equal(identity(),'default');
 await act(async()=>{Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='添加本地头像')!.click();});
 assert.equal(identity(),upload);assert(document.querySelector('[data-header] img'));
 assert.equal(calls.filter(call=>call.kind==='read'&&call.assetId===upload&&call.variant==='poster').length,2,'Reimport clears a removed image cache entry');
 await act(()=>root.unmount());assert.equal(observers.size,0);assert.equal(mediaListeners.size,0,'Shared global media subscription is cleaned up');
 await act(async()=>{for(let i=0;i<6;i++)await loadAvatarImage('upload:'+i.toString(16).padStart(64,'0'),'animation');});
 assert.equal(Object.keys(useBotAvatarStore.getState().images).filter(key=>key.endsWith(':animation')).length,4,'Private animation cache is bounded');
 assert(calls.every(call=>!('path' in call)));
 console.log('[bot-avatar-ui/dom] PASS: real React events, shared hydration, per-Bot save/switch, rejected save, import/remove/reimport, GIF/poster fallback, accessible names, reduced motion/visibility/observer signals, 99 static rows, one lazy GIF read and bounded cache, listener cleanup. Pixel layout and native dialog are separate.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
