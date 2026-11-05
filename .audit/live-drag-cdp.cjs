const fs=require('fs');(async()=>{const pages=await fetch('http://127.0.0.1:19231/json/list').then(r=>r.json());console.log(JSON.stringify(pages.map(p=>({title:p.title,url:p.url})),null,2));const page=pages.find(p=>p.type==='page'&&(p.url.includes('index.html')||p.url.startsWith('http://localhost:')));if(!page)throw Error('no app page');const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.addEventListener('open',r,{once:true}));let seq=0;const pending=new Map();socket.addEventListener('message',e=>{const v=JSON.parse(e.data);if(pending.has(v.id)){const p=pending.get(v.id);pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result)}});const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};const action=process.argv[2];if(action==='close'){await rpc('Browser.close');}else if(action==='inspect'){console.log(await evaluate(`JSON.stringify({title:document.title,rows:[...document.querySelectorAll('[draggable]')].map(e=>({text:e.textContent.slice(0,130),html:e.outerHTML.slice(0,500),rect:e.getBoundingClientRect().toJSON()}))})`));}else if(action==='screenshot'){fs.writeFileSync('out/real-live-drag.png',Buffer.from((await rpc('Page.captureScreenshot')).data,'base64'));}else if(action==='eval'){console.log(JSON.stringify(await evaluate(fs.readFileSync(process.argv[3],'utf8'))));}else if(action==='intercept'){
const d=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
await rpc('Input.setInterceptDrags',{enabled:true});
const got=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('no intercepted drag')),5000);socket.addEventListener('message',e=>{const v=JSON.parse(e.data);if(v.method==='Input.dragIntercepted'){clearTimeout(timer);resolve(v.params.data)}})});
await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:d.fromX,y:d.fromY});
await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:d.fromX,y:d.fromY,button:'left',buttons:1,clickCount:1});
await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:d.fromX+12,y:d.fromY+1,buttons:1});
const data=await got;console.log('intercept',JSON.stringify(data));
for(const type of ['dragEnter','dragOver','dragOver','drop']){await rpc('Input.dispatchDragEvent',{type,x:d.toX,y:d.toY,data});await new Promise(r=>setTimeout(r,150));}
await rpc('Input.setInterceptDrags',{enabled:false});console.log('intercepted drag completed');
}else if(action==='native'){
const d=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:d.fromX,y:d.fromY});
await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:d.fromX,y:d.fromY,button:'left',buttons:1,clickCount:1});
for(let i=1;i<=8;i++){await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:d.fromX+(d.toX-d.fromX)*i/8,y:d.fromY+(d.toY-d.fromY)*i/8,button:'left',buttons:1});await new Promise(r=>setTimeout(r,50));}
await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:d.toX,y:d.toY,button:'left',buttons:0,clickCount:1});
console.log('mouse drag completed');
}else if(action==='drag'){const data=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));for(const type of ['dragEnter','dragOver','drop'])await rpc('Input.dispatchDragEvent',{type,x:data.x,y:data.y,data:{items:[{mimeType:data.mime,data:data.taskId}],dragOperationsMask:16}});console.log('drop sent');}socket.close();})().catch(e=>{console.error(e);process.exitCode=1});

