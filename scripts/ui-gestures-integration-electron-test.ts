import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Module from "node:module";
import { app, BrowserWindow } from "electron";
import { build } from "esbuild";
const root=mkdtempSync(join(tmpdir(),"ui-gestures-")); app.setPath("userData",join(root,"profile")); app.setPath("home",root);
const guard=setTimeout(()=>{console.error("timed out");app.exit(1)},30000);
void (async()=>{try{
 await app.whenReady();
 const bundle=await build({stdin:{contents:`export { UiAutomationService } from './src/main/capabilities/UiAutomationService'; export { pageInspectionService } from './src/main/artifact/PageInspectionService'; export { browserNativeInput } from './src/main/capabilities/BrowserNativeInput'; export { htmlDrag } from './src/main/capabilities/browser/BrowserGestures';`,resolveDir:process.cwd(),loader:"ts"},bundle:true,write:false,platform:"node",format:"cjs",packages:"external"});
 const module=new Module(join(process.cwd(),"gesture-in-memory.cjs")); module.filename=join(process.cwd(),"gesture-in-memory.cjs"); module.paths=Reflect.get(Module,"_nodeModulePaths")(process.cwd()); Reflect.get(module,"_compile").call(module,bundle.outputFiles[0].text,module.filename);
 const {UiAutomationService,pageInspectionService,browserNativeInput,htmlDrag}=module.exports;
 const win=new BrowserWindow({show:false,width:1000,height:800});
 const html=`<meta charset=utf-8><style>button,div,input{margin:10px}#source,#dest{display:inline-block;width:150px;height:100px;background:#ddd}</style><button id=click>Click</button><div id=source>source</div><div id=dest>dest</div><input id=normal><div id=editor contenteditable=true>old</div><input id=date type=date><script>
 window.log=[];click.addEventListener('click',e=>log.push(['click',e.isTrusted,e.ctrlKey,e.detail]));click.addEventListener('dblclick',e=>log.push(['dblclick',e.isTrusted,e.detail]));click.addEventListener('contextmenu',e=>{e.preventDefault();log.push(['contextmenu',e.isTrusted])});document.addEventListener('mousemove',e=>{window.lastButtons=e.buttons;if(e.buttons)log.push(['move',e.isTrusted,e.buttons])});dest.addEventListener('mouseup',e=>log.push(['drop',e.isTrusted]));dest.addEventListener('dragover',e=>e.preventDefault());dest.addEventListener('drop',e=>{e.preventDefault();window.htmlDrop={trusted:e.isTrusted,value:e.dataTransfer.getData('text/plain')}});normal.addEventListener('input',e=>log.push(['input',e.isTrusted]));date.addEventListener('input',e=>log.push(['date-input',e.isTrusted]));date.addEventListener('change',e=>log.push(['date-change',e.isTrusted]));</script>`;
 await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
 const wc=win.webContents, session=pageInspectionService.acquire(wc,"browser-host");await session.attach(wc.debugger);
 const ui=new UiAutomationService({app:()=>wc,browser:()=>wc,artifact:()=>null,input:browserNativeInput(session)});
 const find=async(selector)=>{const r=await ui.execute({action:'find',target:'browser',selector});assert.equal(r.elements.length,1);return r.elements[0];};
 let click=await find('#click'); await ui.execute({action:'click',target:'browser',selector:click.selector,button:'left',clickCount:2,modifiers:['control'],observedSelectors:[click.selector]});
 click=await find('#click'); await ui.execute({action:'click',target:'browser',selector:click.selector,button:'right',observedSelectors:[click.selector]});
 const source=await find('#source'),dest=await find('#dest');
 await ui.execute({action:'drag',target:'browser',selector:source.selector,dragTo:dest.selector,observedSelectors:[source.selector,dest.selector],dragToExpected:{tag:dest.tag,name:dest.name}});
 const htmlUi=new UiAutomationService({app:()=>wc,browser:()=>wc,artifact:()=>null,input:browserNativeInput(session),htmlDrag:(points,scope)=>htmlDrag(session,scope,points,{items:[{mimeType:'text/plain',data:'fixture-data'}],dragOperationsMask:1})});
 await htmlUi.execute({action:'drag',target:'browser',selector:source.selector,dragTo:dest.selector,dragMode:'html',observedSelectors:[source.selector,dest.selector],dragToExpected:{tag:dest.tag,name:dest.name}});
 assert.deepEqual(await wc.executeJavaScript('window.htmlDrop'),{trusted:true,value:'fixture-data'});
 const staleSource=await find('#source'),staleDest=await find('#dest');
 await wc.executeJavaScript("dest.outerHTML='<div id=dest style=\\\"display:inline-block;width:150px;height:100px\\\">dest</div>'");
 await assert.rejects(ui.execute({action:'drag',target:'browser',selector:staleSource.selector,dragTo:staleDest.selector,observedSelectors:[staleSource.selector,staleDest.selector]}));
 const controller=new AbortController(); const actualInput=browserNativeInput(session);
 const abortInput={...actualInput,send:async event=>{await actualInput.send(event);if(event.type==='mouseDown')controller.abort();}};
 const abortUi=new UiAutomationService({app:()=>wc,browser:()=>wc,artifact:()=>null,input:abortInput});
 const abortSource=await find('#source'),abortDest=await find('#dest');
 await assert.rejects(abortUi.execute({action:'drag',target:'browser',selector:abortSource.selector,dragTo:abortDest.selector,observedSelectors:[abortSource.selector,abortDest.selector]},controller.signal));
 await actualInput.send({type:'mouseMove',x:20,y:20});
 assert.equal(await wc.executeJavaScript("window.lastButtons"),0);
 const field=await find('#normal'); await ui.execute({action:'fill',target:'browser',selector:field.selector,value:'中🙂文',inputMode:'sequential',observedSelectors:[field.selector]});
 const editor=await find('#editor'); await ui.execute({action:'fill',target:'browser',selector:editor.selector,value:'编辑🙂',observedSelectors:[editor.selector]});
 const date=await find('#date');const dateResult=await ui.execute({action:'fill',target:'browser',selector:date.selector,value:'2026-11-17',dateType:'date',observedSelectors:[date.selector]});
 const log=await wc.executeJavaScript('window.log');assert(log.some(x=>x[0]==='dblclick'&&x[1]===true));assert(log.some(x=>x[0]==='click'&&x[1]===true&&x[2]===true));assert(log.some(x=>x[0]==='contextmenu'&&x[1]===true));assert(log.some(x=>x[0]==='move'&&x[1]===true&&x[2]===1));assert(log.some(x=>x[0]==='drop'&&x[1]===true));
 assert.equal(await wc.executeJavaScript('normal.value'),'中🙂文');assert.equal(await wc.executeJavaScript('editor.innerText'),'编辑🙂');assert.equal(await wc.executeJavaScript('date.value'),'2026-11-17');assert(dateResult.detail.includes('synthetic-setter'));assert(log.some(x=>x[0]==='date-input'&&x[1]===false));
 pageInspectionService.release(wc,'browser-host');win.destroy();clearTimeout(guard);console.log('PASS production UI + inspector + native input gestures');app.exit(0);
}catch(error){console.error(error);clearTimeout(guard);app.exit(1)}})();



