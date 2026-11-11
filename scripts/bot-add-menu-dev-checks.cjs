/** Actual pnpm dev app/preload/store, isolated HOME; deterministic local provider, not live-model acceptance. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
module.exports=async({evaluate,rpc,until,report,out,botId})=>{
 const click=async selector=>{const p=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});};
 const pause=()=>new Promise(r=>setTimeout(r,100));
 await until(()=>evaluate(`Boolean(document.querySelector('[aria-label="添加"]:not(:disabled)'))`),'Bot add readiness');
 for(const width of [1280,640,360]){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await pause();
  await click('[aria-label="添加"]');await until(()=>evaluate(`document.querySelectorAll('.add-menu > .add-menu-item').length===9`),'nine menu items');
  const layout=await evaluate(`(()=>{const a=document.querySelector('.add-menu-anchor').getBoundingClientRect(),m=document.querySelector('.add-menu').getBoundingClientRect();return {gap:a.top-m.bottom,left:m.left,right:m.right,screen:innerWidth}})()`);
  assert(Math.abs(layout.gap-8)<2);assert(layout.left>=0 && layout.right<=layout.screen);
  const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`bot-add-menu-dev-${width}.png`),Buffer.from(shot.data,'base64'));
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>evaluate(`!document.querySelector('.add-menu')`),'escape closes');
 }
 // Native host IPC persists and replies to a real menu-capable composer send.
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await click('#bot-draft');await rpc('Input.insertText',{text:'添加菜单验收消息'});await click('[aria-label="发送消息"]');
 await until(()=>evaluate(`document.querySelector('.bot-thread')?.textContent.includes('前台界面真实回复') || [...document.querySelectorAll('.bot-assistant-content')].some(el=>el.textContent.includes('前台界面真实回复'))`),'native Bot reply');
 const history=await evaluate(`window.api.botWork.history({botId:${JSON.stringify(botId)}})`);assert(history.messages.some(message=>message.role==='user' && message.text==='添加菜单验收消息'));assert(history.messages.some(message=>message.role==='assistant' && message.status==='completed'));
 report.checks.push('Actual pnpm dev/Electron/preload: 9-item Bot menu at 1280/640/360px, exact 8px anchor gap, Escape, native send and completed provider-fixture reply');
};
