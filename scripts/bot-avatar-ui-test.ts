import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { normalizeBotAvatar } from "../src/main/agent/work/BotAvatarImageDecoder";
import { BotAvatarService } from "../src/main/agent/work/BotAvatarService";
import { createBotAvatarIpcHandler } from "../src/main/agent/work/BotAvatarIpc";
import { builtinBotAvatars } from "../src/shared/bot-avatar";
// Browser runner is optional tooling; production has no browser automation dependency.
const {chromium}=createRequire(import.meta.url)("playwright");
const directory=mkdtempSync(join(tmpdir(),"bot-avatar-ui-")), dbPath=join(directory,"app.db");
const output=join(process.cwd(),"out/tests/bot-avatar-review");mkdirSync(output,{recursive:true});
let db=new Database(dbPath);db.exec("CREATE TABLE bots(bot_id TEXT PRIMARY KEY,user_id TEXT); INSERT INTO bots VALUES('a','owner'),('b','owner')");
let service=new BotAvatarService(db,"owner",join(directory,"private"));
const assets=join(process.cwd(),"src/renderer/src/assets/bot-avatars");
const poster=readFileSync(join(assets,builtinBotAvatars[0].poster.file));
const selected=join(directory,"selected.png");writeFileSync(selected,poster);
let rejectUpload=false,selectGif=false;
const gifPath=join(directory,"selected.gif");writeFileSync(gifPath,readFileSync(join(assets,builtinBotAvatars[0].animation!.file)));
let activeUrl="";
const requestFrames: Array<{kind:string;assetId?:string}> = [];
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>
html,body{height:auto!important;min-height:100%;overflow:auto!important}body{margin:0;background:var(--bg);color:var(--fg);font-family:system-ui}.avatar-fixture{max-width:1000px;margin:auto;padding:20px}button{font:inherit}.avatar-fixture-content{display:grid;grid-template-columns:180px minmax(0,1fr);gap:20px}.avatar-fixture aside button{display:flex;align-items:center;gap:8px;margin:10px 0}.avatar-fixture header{display:flex;align-items:center;gap:8px;padding:14px 0}[data-testid=message],[data-testid=collaboration]{padding:12px;border:1px solid var(--border-subtle);border-radius:10px;margin:8px 0}[data-testid=many]{display:flex;gap:3px;flex-wrap:wrap} @media(max-width:600px){.avatar-fixture{padding:12px}.avatar-fixture-content{grid-template-columns:minmax(0,1fr)}.avatar-fixture aside{display:flex;gap:8px}}</style><div id="root"></div><script src="/fixture.js"></script></html>`;
const server=createServer(async(req,res)=>{
 try {
  if(req.url==='/command'){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);const command=JSON.parse(Buffer.concat(chunks).toString());requestFrames.push(command);
   const frame={url:activeUrl},sender={isDestroyed:()=>false,mainFrame:frame};
   const handler=createBotAvatarIpcHandler({service,getWindow:()=>({isDestroyed:()=>false,webContents:sender}),rendererUrl:activeUrl,
    pick:async()=>{if(rejectUpload){const bad=join(directory,'bad.svg');writeFileSync(bad,'<svg/>');return bad;}return selectGif ? gifPath : selected;},normalize:normalizeBotAvatar});
   res.setHeader('Content-Type','application/json');res.end(JSON.stringify(await handler({sender,senderFrame:frame},command)));return;
  }
  if(req.url==='/pick-gif'){selectGif=true;res.end('ok');return;}
  if(req.url==='/pick-png'){selectGif=false;res.end('ok');return;}
  if(req.url==='/restart'){db.close();db=new Database(dbPath);service=new BotAvatarService(db,'owner',join(directory,'private'));res.end('ok');return;}
  if(req.url==='/reject-upload'){rejectUpload=true;res.end('ok');return;}
  if(req.url==='/accept-upload'){rejectUpload=false;res.end('ok');return;}
  if(req.url?.startsWith('/avatar-assets/')){const name=req.url.slice('/avatar-assets/'.length);if(!/^[a-z0-9.-]+$/.test(name))throw Error('invalid');res.setHeader('Content-Type',name.endsWith('.gif')?'image/gif':'image/png');res.end(readFileSync(join(assets,name)));return;}
  if(req.url==='/fixture.js'||req.url==='/fixture.css'){res.setHeader('Content-Type',req.url.endsWith('js')?'application/javascript':'text/css');res.end(readFileSync(join(process.cwd(),'out/tests',req.url.slice(1).replace('fixture','bot-avatar-ui-fixture'))));return;}
  if(req.url?.match(/^\/[A-Za-z0-9_-]+\.(woff2?|ttf)$/)){res.end(readFileSync(join(process.cwd(),'out/tests',req.url.slice(1))));return;}
  res.setHeader('Content-Type','text/html');res.end(html);
 }catch(error){res.statusCode=500;res.end(String(error));}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
activeUrl=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/`;
if(process.env.BOT_AVATAR_PREVIEW==='1'){
 console.log(`Avatar acceptance preview: ${activeUrl}`);
 process.on('SIGTERM',()=>{server.close();db.close();rmSync(directory,{recursive:true,force:true});process.exit(0);});
 await new Promise(()=>{});
}
let browser;
try {browser=await chromium.launch({headless:true,...(process.env.MYBUDDY_CHROMIUM_EXECUTABLE ? {executablePath:process.env.MYBUDDY_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});}
catch(error){await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();rmSync(directory,{recursive:true,force:true});throw error;}
try {
 const context=await browser.newContext({viewport:{width:1100,height:900},reducedMotion:"no-preference"});
 const page=await context.newPage();const failures:string[]=[];
 page.on('pageerror',error=>failures.push(error.message));
 const leaked:string[]=[];page.on('request',request=>{if(!request.url().startsWith(activeUrl)&&!request.url().startsWith('data:'))leaked.push(request.url());});
 await page.goto(activeUrl);await page.getByRole('radio',{name:'默认头像',exact:true}).waitFor();
 await page.getByRole('radio',{name:builtinBotAvatars[0].label,exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('[data-testid="header"] [data-animated="true"]'));
 const assertIdentity=async(id:string)=>{
  for(const target of ['header','message','collaboration'])assert.equal(await page.locator(`[data-testid="${target}"] [data-avatar-id]`).getAttribute('data-avatar-id'),id);
 };
 await assertIdentity(builtinBotAvatars[0].id);
 assert.equal(await page.locator('[data-testid="many"] [data-animated="true"]').count(),0,'99 list rows are static');
 assert.equal(await page.locator('canvas').count(),0,'No per-row canvas or WebGL');
 assert.equal(await page.locator('[data-animated="true"]').count(),1,'Only the active header animates');
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>!document.querySelector('[data-animated="true"]'));
 assert((await page.locator('[data-testid="header"] img').getAttribute('src'))?.endsWith('.png'));
 await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>document.querySelector('[data-animated="true"]'));
 await page.getByRole('checkbox',{name:'播放标题头像动画'}).uncheck();await page.waitForFunction(()=>!document.querySelector('[data-animated="true"]'));
 await page.reload();await page.getByRole('radio',{name:builtinBotAvatars[0].label,exact:true}).waitFor();assert.equal(await page.getByRole('checkbox').isChecked(),false);
 await page.getByRole('button',{name:'切换 B',exact:true}).click();await assertIdentity('default');
 await page.getByRole('radio',{name:builtinBotAvatars[1].label,exact:true}).click();await assertIdentity(builtinBotAvatars[1].id);
 await page.getByRole('button',{name:'添加本地头像',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="header"] [data-avatar-id^="upload:"]'));
 const upload=await page.locator('[data-testid="header"] [data-avatar-id]').getAttribute('data-avatar-id');assert(upload);
 await page.waitForFunction(()=>document.querySelector('[data-testid="header"] img')?.getAttribute('src')?.startsWith('data:image/png;base64,'));
 await page.request.get(activeUrl+'restart');await page.reload();await page.getByRole('button',{name:'切换 B',exact:true}).click();await assertIdentity(upload);
 await page.getByRole('button',{name:'切换 A',exact:true}).click();await assertIdentity(builtinBotAvatars[0].id);
 await page.request.get(activeUrl+'reject-upload');await page.getByRole('button',{name:'添加本地头像',exact:true}).click();await page.getByRole('alert').waitFor();await assertIdentity(builtinBotAvatars[0].id);
 await page.request.get(activeUrl+'accept-upload');
 // Broken animation falls back to poster; broken poster retains accessible named icon.
 await page.getByRole('checkbox').check();
 await page.locator('[data-testid="header"] img').dispatchEvent('error');await page.waitForFunction(()=>document.querySelector('[data-testid="header"] img')?.getAttribute('src')?.endsWith('.png'));
 await page.locator('[data-testid="header"] img').dispatchEvent('error');assert.equal(await page.locator('[data-testid="header"] svg').count(),1);
 assert.equal(await page.getByRole('img',{name:'薄荷搭档的头像',exact:true}).count()>=3,true);
 await page.reload();await page.getByRole('radio',{name:builtinBotAvatars[0].label,exact:true}).waitFor();
 await page.getByRole('checkbox').check();await page.waitForFunction(()=>document.querySelector('[data-animated="true"]'));
 // Hiding the active header stops GIF use through the real IntersectionObserver.
 await page.locator('[data-testid="header"]').evaluate(element=>(element as HTMLElement).style.display='none');
 await page.waitForFunction(()=>!document.querySelector('[data-animated="true"]'));
 await page.locator('[data-testid="header"]').evaluate(element=>(element as HTMLElement).style.display='flex');
 await page.waitForFunction(()=>document.querySelector('[data-animated="true"]'));
 // Simulate Chromium visibility signal with the actual shared subscription.
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>!document.querySelector('[data-animated="true"]'));
 await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'));});
 await page.waitForFunction(()=>document.querySelector('[data-animated="true"]'));
 for(const width of [1100,390])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.setAttribute('data-theme',theme),theme);
  await page.screenshot({path:join(output,`avatars-${width}-${theme}.png`),fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No horizontal overflow');
 }
 await page.getByRole('button',{name:'切换 B',exact:true}).click();
 await page.getByRole('button',{name:/移除本地头像/}).click();await assertIdentity('default');
 await page.getByRole('button',{name:'添加本地头像',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="header"] img')?.getAttribute('src')?.startsWith('data:image/png;base64,'));
 assert.deepEqual(leaked,[],'No external avatar requests');assert.deepEqual(failures,[],'No browser exceptions');
 assert(requestFrames.every(command=>!('path' in command)),'Renderer never submits a source file path');
 console.log('[bot-avatar-ui] PASS: real React + Chromium, real temporary SQLite/private files across reload/reopen, per-Bot selection and identity, upload/error/remove/reimport, reduced motion, persisted animation switch, real offscreen observer, visibility signal, failed GIF/poster fallback, 99 static rows/no canvas, light/dark 1100/390px screenshots, no external requests');

}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();rmSync(directory,{recursive:true,force:true});}
