/** Real Electron + production registration, protocol, file reader and React components.
 * Synthetic documents, not a live-model or complete application test. */
import { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { BrowserHost } from '../src/main/browser/BrowserHost';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { inspectDurableArtifact } from '../src/main/agent/durable/DurableArtifactRegistration';
import { captureSavedWebBundle, savedArtifactPreviewService as service } from '../src/main/artifact/SavedArtifactPreview';
import { ArtifactProtocol } from '../src/main/artifact/ArtifactProtocol';
import { WebArtifactRuntime } from '../src/main/artifact/WebArtifactRuntime';
import { readWorkspaceFile } from '../src/main/workspace/WorkspaceService';
const dir=mkdtempSync(join(tmpdir(),'saved-preview-'));
app.setPath('userData',join(dir,'profile'));
protocol.registerSchemesAsPrivileged([{scheme:'mybuddy-artifact',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let win:BrowserWindow;
const browser = new BrowserHost();
const server = createServer((_req,res)=>res.end('<h1>Internal browser destination</h1>'));
const results:string[]=[];
const record=(s:string)=>{results.push(s);console.log('PASS '+s)};
const ev=(s:string)=>win.webContents.executeJavaScript(s);
async function until(fn:()=>Promise<any>,label:string){for(let i=0;i<150;i++){if(await fn())return;await sleep(60)}throw Error('Timed out: '+label)}
async function click(text:string){await ev(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);}
async function frame(){await until(async()=>win.webContents.mainFrame.frames.some(f=>f.url.startsWith('mybuddy-artifact:')),'saved frame');return win.webContents.mainFrame.frames.find(f=>f.url.startsWith('mybuddy-artifact:'))!;}
async function render(name:string,path:string,manifest?:string){await ev(`window.savedPreviewFixture.render([{ref:${JSON.stringify(path)},name:${JSON.stringify(name)},openPath:${JSON.stringify(path)},artifact:{bindingId:'b',path:${JSON.stringify(path)},snapshotPath:${JSON.stringify(path)},digest:'test',sizeBytes:1,registeredAt:1,sourceEntryId:1,previewManifestPath:${JSON.stringify(manifest)}}}])`);await sleep(100);await click('预览');}
app.whenReady().then(async()=>{
 try{
 assert(process.env.DISPLAY||process.env.WAYLAND_DISPLAY,'Real desktop required');
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const linkUrl = `http://127.0.0.1:${(server.address() as {port:number}).port}/`;
 const cwd=join(dir,'work'),state=join(dir,'state');mkdirSync(cwd);mkdirSync(state);
 const html='<!doctype html><html><head><link rel="stylesheet" href="theme.css"></head><body><h1 id="title">项目管理 V1</h1><button id="add">新增任务</button><div id="count">0</div><a id="external" href="https://example.com/">打开参考</a><a id="next" href="other.html">下一页</a><script src="app.js"></script></body></html>';
 writeFileSync(join(cwd,'index.html'),html.replace('https://example.com/',linkUrl));writeFileSync(join(cwd,'theme.css'),'h1{color:rgb(10, 90, 180)}');
 writeFileSync(join(cwd,'app.js'),'let n=0;document.querySelector("#add").onclick=()=>{localStorage.setItem("n",String(++n));document.querySelector("#count").textContent=String(n)}');
 writeFileSync(join(cwd,'other.html'),'<h1>同版本子页面</h1>');
 const saved=await inspectDurableArtifact(cwd,'index.html',state);assert(saved.snapshotPath);
 const manifest=await captureSavedWebBundle(cwd,join(cwd,'index.html'),saved.snapshotPath,state,inspectDurableArtifact);
 // Mutable original changes cannot leak into the saved resource bundle.
 writeFileSync(join(cwd,'theme.css'),'h1{color:red}');writeFileSync(join(cwd,'index.html'),'<h1>CHANGED</h1>');
 const domain=new ArtifactProtocol(new WebArtifactRuntime({rootOf:()=>null,filePathOf:()=>null,contentOf:async()=>null}));domain.register();
 const links:string[]=[];
 ipcMain.handle('fixture:prepare',(e,r)=>service.prepare(e.sender.id,r));ipcMain.handle('fixture:release',(e,t)=>service.release(e.sender.id,t));
 ipcMain.handle('fixture:read',(_e,...a)=>readWorkspaceFile(a[0],a[1],a[2]));ipcMain.on('fixture:link',(_e,url)=>{links.push(url);browser.open(url)});
 const preload=join(dir,'preload.cjs');writeFileSync(preload,`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{savedArtifact:{prepare:r=>ipcRenderer.invoke('fixture:prepare',r),release:t=>ipcRenderer.invoke('fixture:release',t)},readWorkspaceFile:(...a)=>ipcRenderer.invoke('fixture:read',...a),browser:{open:url=>ipcRenderer.send('fixture:link',url)},showItemInFolder:async()=>{},openFolder:async()=>{}})`);
 const appCsp = readFileSync('src/renderer/index.html', 'utf8').match(/content="(default-src[^"]+)"/)![1];
 const page=join(dir,'fixture.html');writeFileSync(page,`<!doctype html><html data-theme="light"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${appCsp}"><link rel="stylesheet" href="${pathToFileURL(resolve('out/tests/saved-preview-fixture.css')).href}"><div id="root"></div><script src="${pathToFileURL(resolve('out/tests/saved-preview-fixture.js')).href}"></script></html>`);
 win=new BrowserWindow({show:true,width:1100,height:900,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:true}});
 win.webContents.on("console-message", (_e, level, message)=>console.log("renderer",level,message));
 win.webContents.on("render-process-gone", (_e,d)=>console.log(d));
 browser.attach(win);
 service.attachOwner(win.webContents, url=>{links.push(url);browser.open(url)});
 await win.loadFile(page);await until(()=>ev('!!window.savedPreviewFixture'),'fixture boot');await render('index.html',saved.snapshotPath,manifest);
 let f=await frame();await until(()=>f.executeJavaScript('!!document.querySelector("#add")'),'HTML content');
 assert.equal(await f.executeJavaScript('document.querySelector("h1").textContent'),'项目管理 V1');
 assert.equal(await f.executeJavaScript('getComputedStyle(document.querySelector("h1")).color'),'rgb(10, 90, 180)');record('HTML rendered using immutable HTML and CSS, not mutable original');
 await f.executeJavaScript('document.querySelector("#add").click()');assert.equal(await f.executeJavaScript('localStorage.getItem("n")'),'1');record('JavaScript and localStorage interaction');
 assert.equal(await f.executeJavaScript('typeof window.api+":"+typeof require'),'undefined:undefined');
 assert.equal(await f.executeJavaScript('(()=>{try{return parent.document.title}catch{return "isolated"}})()'),'isolated');record('No app bridge/Node or parent DOM access');
 await click('源码');assert(await ev('document.querySelector(".code-view").textContent.includes("项目管理 V1")'));
 await click('预览');assert.equal(await f.executeJavaScript('localStorage.getItem("n")'),'1');record('Source switch preserves live preview state');
 await f.executeJavaScript('document.querySelector("#external").click()');await until(async()=>links.length===1,'internal browser request');assert.equal(links[0],linkUrl);await until(async()=>Boolean(browser.inspectionWebContents&&!browser.inspectionWebContents.isLoading()),'internal page');assert.equal(await browser.inspectionWebContents!.executeJavaScript('document.querySelector("h1").textContent'),'Internal browser destination');browser.close();record('External link loads actual production internal BrowserHost; no external browser');
 await click('展开查看');assert(await ev('document.querySelector(".bot-work-file-preview.is-expanded")!==null'));await click('收起查看');
 await f.executeJavaScript('document.querySelector("#next").click()');await sleep(200);f=await frame();assert.equal(await f.executeJavaScript('document.querySelector("h1").textContent'),'同版本子页面');record('Versioned relative subpage navigation');
 mkdirSync('out/tests',{recursive:true});writeFileSync('out/tests/saved-preview-html.png',(await win.webContents.capturePage()).toPNG());
 await click('关闭预览');assert.equal(await ev('document.querySelector("textarea").value'),'保留这段草稿');
 await render('index.html',saved.snapshotPath,manifest);f=await frame();await until(()=>f.executeJavaScript('!!document.querySelector("#add")'),'reopened page');assert.equal(await f.executeJavaScript('localStorage.getItem("n")'),null);record('Close/reopen resets isolated interaction state, preserves draft');
 await click('关闭预览');renameSync(saved.snapshotPath,saved.snapshotPath+'.held');await render('index.html',saved.snapshotPath,manifest);await until(()=>ev('!!document.querySelector("[role=alert]")'),'missing snapshot error');renameSync(saved.snapshotPath+'.held',saved.snapshotPath);await click('重试读取');await frame();record('Missing snapshot does not fallback; retry recovers actual saved bytes');
 for(const [name,content,selector,expected] of [['report.md','# 报告标题\n\n这是正文。','.md-section-heading','报告标题'],['data.json','{"value":58}','.code-view','58'],['report.csv','name,value\nCoffee,118','pre','Coffee,118']] as const){
  await click('关闭预览');const path=join(cwd,name);writeFileSync(path,content);await render(name,path);await until(()=>ev(`!!document.querySelector(${JSON.stringify(selector)})&&document.querySelector(${JSON.stringify(selector)}).textContent.includes(${JSON.stringify(expected)})`),name);record(name+' uses its expected viewer');
 }
 writeFileSync('out/tests/saved-preview-data.png',(await win.webContents.capturePage()).toPNG());
 record('Actual Electron production component + filesystem/protocol chain completed; no model calls');
 }catch(error){console.error(error);process.exitCode=1}
 finally{writeFileSync('out/tests/saved-preview-desktop-results.json',JSON.stringify({passed:results,exitCode:process.exitCode||0,profile:dir},null,2));browser.dispose();server.close();if(win){service.releaseOwner(win.webContents.id);win.destroy()}app.exit(Number(process.exitCode)||0)}
});
