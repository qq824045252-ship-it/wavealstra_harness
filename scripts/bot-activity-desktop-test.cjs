const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"); const path = require("node:path"); const os = require("node:os"); const { pathToFileURL } = require("node:url"); const assert = require("node:assert/strict");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "activity-ui-")); app.setPath("userData", path.join(profile, "profile"));
app.whenReady().then(async () => {
 let win; try {
 const out=path.resolve("out/tests"); const html=path.join(profile,"index.html");
 fs.writeFileSync(html, `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out,"bot-activity-desktop-fixture.css"))}"><style>:root{--bg-panel:#fff;--bg-app:#fafafa;--fg-primary:#222;--fg-secondary:#666;--border-default:#ddd;--bg-hover:#eee}*{box-sizing:border-box}body{font:14px system-ui;margin:20px}button,input,select{font:inherit}</style></head><body><div id="root"></div><script src="${pathToFileURL(path.join(out,"bot-activity-desktop-fixture.js"))}"></script></body></html>`);
 win=new BrowserWindow({width:1050,height:850,show:true,webPreferences:{contextIsolation:true}});
 const errors=[]; win.webContents.on("console-message",(_e,level,message)=>{if(level>=3)errors.push(message)});
 await win.loadFile(html); win.webContents.debugger.attach("1.3");
 const ev=s=>win.webContents.executeJavaScript(s);
 const wait=async(s)=>{const end=Date.now()+10000;while(!await ev(s)){if(Date.now()>end)throw Error("Timeout "+s);await new Promise(r=>setTimeout(r,30));}};
 const open=async()=>{await ev("document.querySelector('#root button').click()");await wait("document.querySelectorAll('.bot-activity-row').length === 4");};
 await wait("document.querySelector('#root button')"); await open();
 assert(await ev("document.querySelector('.bot-activity-summary').textContent.includes('执行中 3')"));
 assert(!await ev("document.querySelector('[data-activity-id=\"task:failed\"]')"));
 await ev("document.querySelector('input[type=checkbox]').click()");
 await wait("document.querySelectorAll('.bot-activity-row').length === 6");
 assert(await ev("document.querySelector('[data-activity-id=\"task:failed\"]').textContent.includes('执行失败')"));
 for(const width of [1050,760,440]){
 await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride",{width,height:850,deviceScaleFactor:1,mobile:false});
 await new Promise(r=>setTimeout(r,100));
 assert(await ev("(()=>{const d=document.querySelector('dialog');const r=d.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && d.scrollWidth<=d.clientWidth+1})()"),"no overflow "+width);
 const shot=await win.webContents.debugger.sendCommand("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
 fs.writeFileSync(path.join(out,"bot-activity-"+width+".png"),Buffer.from(shot.data,"base64"));
 }
 await ev("document.querySelector('[data-activity-id=\"sub:ordinary:child\"]').click()");
 await wait("!document.querySelector('dialog')");
 assert.deepEqual(await ev("window.monitorNavigations.slice(-2)"),["task:ordinary","sub:ordinary:child"]);
 await open(); await ev("document.querySelector('[data-activity-id=\"work:work\"]').click()"); await wait("!document.querySelector('dialog')");
 assert.deepEqual(await ev("window.monitorNavigations.slice(-3)"),["bot:owner","work:work","page:bot"]);
 await open(); await ev("document.querySelector('[data-activity-id=\"bot:reply\"]').click()"); await wait("!document.querySelector('dialog')");
 assert.equal(await ev("window.monitorNavigations.at(-1)"),"message:reply");
 await open();
 await ev("(()=>{const i=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'季度');i.dispatchEvent(new Event('input',{bubbles:true}))})()");
 await wait("document.querySelectorAll('.bot-activity-row').length === 1");
 await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
 await wait("!document.querySelector('dialog')");
 await open();
 await ev(`window.monitorSetActive([{message:{messageId:"old",conversationId:"archived",botId:"owner",requestId:"old-request",ordinal:1,role:"assistant",text:"旧会话仍在核对",status:"running",workIds:[],createdAt:1,updatedAt:200},prompt:{text:"旧会话委托"},archived:true}])`);
 await wait(`document.querySelector('[data-activity-id="bot:old"]')`);
 await ev(`document.querySelector('[data-activity-id="bot:old"]').click()`);
 await wait("document.querySelector('.bot-activity-request')?.textContent.includes('原对话已归档')");
 assert(await ev("document.querySelector('.bot-activity-request').textContent.includes('旧会话委托')"));
 assert(!await ev("window.monitorNavigations.includes('message:old')"),"old request must not navigate to current conversation");
 await ev("document.querySelector('.bot-activity-request button').click()");
 await ev("window.monitorSetActive([])");
 await wait(`!document.querySelector('[data-activity-id="bot:old"]')`);
 assert.deepEqual(errors,[]);
 console.log("PASS real Electron activity window: default/current + ended filter, search, three source navigations, reopen, Escape, 1050/760/440px layouts.");
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});
