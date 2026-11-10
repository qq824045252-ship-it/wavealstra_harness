const {app,BrowserWindow}=require("electron");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os"),assert=require("node:assert/strict");
const {pathToFileURL}=require("node:url");
const dir=fs.mkdtempSync(path.join(os.tmpdir(),"rename-ui-"));app.setPath("userData",path.join(dir,"profile"));
app.whenReady().then(async()=>{
 let win;
 try {
 const out=path.resolve("out/tests"),html=path.join(dir,"fixture.html");
 fs.writeFileSync(html,`<html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out,"bot-rename-desktop-fixture.css"))}"><div id="root"></div><script src="${pathToFileURL(path.join(out,"bot-rename-desktop-fixture.js"))}"></script></html>`);
 win=new BrowserWindow({width:1000,height:700,show:true});await win.loadFile(html);
 const run=s=>win.webContents.executeJavaScript(s);
 const wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,30));}throw Error(s);};
 const click=t=>run(`[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(t)}).click()`);
 const fill=t=>run(`(()=>{const el=document.querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,${JSON.stringify(t)});el.dispatchEvent(new Event("input",{bubbles:true}));})()`);
 await wait('document.querySelector("h1")');
 await click("重命名");await wait('document.querySelector("dialog").open');await fill("  ");
 assert(await run('document.querySelector("button[type=submit]").disabled'));
 await fill("取消内容");await click("取消");assert.equal((await run("window.renameCalls")).length,0);
 await click("重命名");await fill("重复");await click("保存名称");await wait('document.body.textContent.includes("已有同名")');
 await click("取消");await click("重命名");await fill("过时修改");await run("window.concurrentRename()");await click("保存名称");
 await wait('document.body.textContent.includes("其他位置更新")');await click("取消");
 await click("重命名");await fill("新的助理");await click("保存名称");
 await wait('!document.querySelector("dialog").open && document.querySelector("h1").textContent==="新的助理"');
 assert(await run('document.querySelector("aside").textContent.includes("新的助理")'));
 fs.writeFileSync(path.join(out,"bot-rename-desktop.png"),(await win.webContents.capturePage()).toPNG());
 await win.reload();await wait('document.querySelector("h1")?.textContent==="新的助理"');
 await click("重命名");await wait('document.querySelector("dialog").open');
 await win.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});await win.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});await wait('!document.querySelector("dialog").open');
 console.log("PASS real Electron: visible entry, empty/cancel/duplicate/conflict/save, shared names, reload persistence, Escape");
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});
