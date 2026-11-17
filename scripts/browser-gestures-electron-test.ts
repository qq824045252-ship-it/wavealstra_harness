import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, type WebContents } from "electron";
import { pointerDrag, htmlDrag, insertTextSequential, setDateInput } from "../src/main/capabilities/browser/BrowserGestures.ts";
import { transformSync } from "esbuild";
import type { UiNativeInput } from "../src/main/capabilities/UiAutomationService.ts";

const root = mkdtempSync(join(tmpdir(), "browser-gestures-"));
app.setPath("userData", join(root, "profile")); app.setPath("home", root);
const guard = setTimeout(() => { console.error("timed out"); app.exit(1); }, 20000);
void (async () => {
  try {
    await app.whenReady();
    const scopeJs = transformSync(readFileSync("src/main/capabilities/AutomationScope.ts", "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
    const { AutomationScope } = await import(`data:text/javascript;base64,${Buffer.from(scopeJs).toString("base64")}`);
    const win = new BrowserWindow({ show: false, width: 800, height: 600 });
    const html = `<style>body{margin:0} #source,#target{position:absolute;top:40px;width:150px;height:120px;background:#ccc}#source{left:20px}#target{left:300px}</style><div id=source>source</div><div id=target>target</div><input id=text style="position:absolute;top:250px"><input id=date type=date style="position:absolute;top:300px"><script>window.log=[];window.drops=[];document.addEventListener('mousedown',e=>log.push(['down',e.isTrusted,e.buttons]));document.addEventListener('mousemove',e=>log.push(['move',e.isTrusted,e.buttons]));document.addEventListener('mouseup',e=>log.push(['up',e.isTrusted,e.buttons]));target.addEventListener('dragover',e=>e.preventDefault());target.addEventListener('drop',e=>{e.preventDefault();drops.push({data:e.dataTransfer.getData('text/plain'),trusted:e.isTrusted})});date.addEventListener('input',e=>log.push(['date-input',e.isTrusted]));date.addEventListener('change',e=>log.push(['date-change',e.isTrusted]));</script>`;
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    const wc: WebContents = win.webContents; wc.debugger.attach("1.3");
    const protocol = { protocolCommand: (method: string, params?: unknown) => wc.debugger.sendCommand(method, params) };
    const input: UiNativeInput = {
      send: async event => {
        if (!("x" in event) || !("y" in event)) throw new Error("expected mouse event");
        const type = event.type === "mouseDown" ? "mousePressed" : event.type === "mouseUp" ? "mouseReleased" : "mouseMoved";
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type, x: event.x, y: event.y, button: event.button ?? "none", buttons: event.modifiers?.includes("leftbuttondown") ? 1 : 0, clickCount: "clickCount" in event ? event.clickCount : 0 });
      },
      insertText: async text => { await wc.debugger.sendCommand("Input.insertText", { text }); },
    };
    await pointerDrag(input, new AutomationScope(), [{x:50,y:70},{x:150,y:70},{x:350,y:70}]);
    const pointer = await wc.executeJavaScript("log");
    assert(pointer.some((item: unknown[]) => item[0] === "down" && item[1] === true));
    assert(pointer.some((item: unknown[]) => item[0] === "move" && item[2] === 1));
    assert(pointer.some((item: unknown[]) => item[0] === "up" && item[1] === true));
    await htmlDrag(protocol, new AutomationScope(), [{x:320,y:70},{x:350,y:70}], {items:[{mimeType:"text/plain",data:"payload 你好"}],dragOperationsMask:1});
    assert.deepEqual(await wc.executeJavaScript("drops"), [{data:"payload 你好",trusted:true}]);
    const abort = new AbortController();
    const abortInput: UiNativeInput = { ...input, send: async event => { await input.send(event); if (event.type === "mouseDown") abort.abort(); } };
    await assert.rejects(pointerDrag(abortInput, new AutomationScope(abort.signal), [{x:50,y:70},{x:350,y:70}]));
    await input.send({type:"mouseMove",x:60,y:80});
    assert.equal(await wc.executeJavaScript("log.at(-1)[2]"), 0);
    await wc.executeJavaScript("document.querySelector('#text').focus()");
    await insertTextSequential(input, new AutomationScope(), "中🙂文");
    assert.equal(await wc.executeJavaScript("document.querySelector('#text').value"), "中🙂文");
    const date = await setDateInput(new AutomationScope(), fn => wc.executeJavaScript(`(${fn})(document.querySelector('#date'))`), "date", "2026-11-17");
    assert.equal(date.strategy,"synthetic-setter");
    assert.equal(await wc.executeJavaScript("document.querySelector('#date').value"),"2026-11-17");
    assert.deepEqual((await wc.executeJavaScript("log")).slice(-2), [["date-input",false],["date-change",false]]);
    await assert.rejects(setDateInput(new AutomationScope(), fn => wc.executeJavaScript(`(${fn})(document.querySelector('#date'))`), "date", "2026-02-30"));
    win.destroy(); clearTimeout(guard); console.log("PASS trusted pointer/HTML drop/cancel, Unicode, synthetic date"); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(guard); app.exit(1); }
})();



