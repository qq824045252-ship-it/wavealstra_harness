import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { transformSync } from "esbuild";
import { BrowserCollection, type CollectionSnapshot } from "../src/main/capabilities/browser/BrowserCollection.ts";

const root = mkdtempSync(join(tmpdir(), "browser-collection-"));
app.setPath("userData", join(root, "profile")); app.setPath("home", root);
const guard = setTimeout(() => { console.error("timed out"); app.exit(1); }, 20000);
void (async () => {
  try {
    await app.whenReady();
    const scopeJs = transformSync(readFileSync("src/main/capabilities/AutomationScope.ts", "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
    const { AutomationScope } = await import(`data:text/javascript;base64,${Buffer.from(scopeJs).toString("base64")}`);
    const win = new BrowserWindow({ show: false });
    const html = `<style>#grid { height:100px; overflow:auto; position:relative; }</style><main id=grid></main><button id=next>next</button><script>
      const data=[['a','Apple'],['b','Banana'],['c','Cherry'],['d','Date'],['e','Elderberry']];
      window.mode='virtual';window.step=0;window.query='all';window.expected=5;
      window.render=()=>{const start=mode==='infinite'?0:step*2;const end=mode==='infinite'?Math.min(2+step*2,5):Math.min(start+2,5);
        grid.innerHTML=(mode==="virtual"?'<div style="height:300px;position:relative">':'<div>')+data.slice(start,end).map((row,i)=>'<div style="'+(mode==="virtual"?'position:absolute;top:'+(step*100+i*25)+'px':' ')+'" data-key="'+row[0]+'" data-index="'+(start+i)+'">'+row[1]+'</div>').join('')+'</div>';
        grid.dataset.terminal=(end===5?'yes':'no');};
      next.onclick=()=>{if(mode!=='stall')step++;render()};grid.onscroll=()=>{if(mode==="virtual"){step=Math.floor(grid.scrollTop/100);render()}};render();
    </script>`;
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    const wc = win.webContents;
    const source = {
      snapshot: async (): Promise<CollectionSnapshot> => wc.executeJavaScript(`({rows:[...document.querySelectorAll('#grid [data-key]')].map(el=>({key:el.dataset.key,cells:[el.textContent],index:Number(el.dataset.index)})),expectedRows:window.expected,queryIdentity:window.query,terminal:grid.dataset.terminal==='yes'})`),
      advance: async (): Promise<void> => { await wc.executeJavaScript(`window.mode === "virtual" ? new Promise(resolve => { grid.scrollTop += 100; setTimeout(resolve, 50); }) : document.querySelector("#next").click()`); },
    };
    const reset = async (mode: string, expected=5) => wc.executeJavaScript(`window.mode=${JSON.stringify(mode)};grid.scrollTop=0;window.step=0;window.query='all';window.expected=${expected};render()`);
    const identity = { owner: "task-a", tab: "tab-a", document: "doc-a", query: "q-a" };
    const engine = new BrowserCollection();
    const expected = [["a","Apple"],["b","Banana"],["c","Cherry"],["d","Date"],["e","Elderberry"]];
    for (const mode of ["virtual", "pages", "infinite"]) {
      await reset(mode);
      const first = await engine.collect({identity, source, scope:new AutomationScope(), budget:{maxSteps:1,maxRows:10}});
      assert.equal(first.status,"partial"); assert.equal(first.reason,"budget"); assert(first.cursor);
      await assert.rejects(engine.collect({identity:{...identity,tab:"other"},source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10},cursor:first.cursor}));
      const rest = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10},cursor:first.cursor});
      assert.equal(rest.status,"complete"); assert.deepEqual(rest.rows.map(row=>[row.key,row.cells[0]]),expected);
      assert.deepEqual(rest.rows.map(row=>row.index),[0,1,2,3,4]);
    }
    await reset("pages");
    const limited = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:3}});
    assert.equal(limited.reason,"budget"); assert.equal(limited.rows.length,3); assert(limited.cursor);
    const resumed = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10},cursor:limited.cursor});
    assert.equal(resumed.status,"complete"); assert.deepEqual(resumed.rows.map(row=>[row.key,row.cells[0]]),expected);
    await reset("stall");
    const stalled = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10}});
    assert.equal(stalled.status,"partial"); assert.equal(stalled.reason,"no-progress"); assert(stalled.cursor); engine.discard(stalled.cursor,identity);
    await reset("stall");
    const noTerminalSource = { ...source, snapshot: async () => { const {terminal,...rest} = await source.snapshot(); return rest; } };
    const noTerminal = await engine.collect({identity,source:noTerminalSource,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10}});
    assert.equal(noTerminal.reason,"no-terminal"); assert(noTerminal.cursor); engine.discard(noTerminal.cursor,identity);
    await reset("pages",6);
    const mismatch = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10}});
    assert.equal(mismatch.status,"partial"); assert.equal(mismatch.reason,"count-mismatch");
    await reset("pages");
    const first = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:1,maxRows:10}}); assert(first.cursor);
    await wc.executeJavaScript("window.query='filtered'");
    const changed = await engine.collect({identity,source,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10},cursor:first.cursor});
    assert.equal(changed.reason,"changed");
    await reset("infinite");
    const sourceConflict = { ...source, advance: async () => { await wc.executeJavaScript("data[0][1]='Changed';document.querySelector('#next').click()"); } };
    const conflict = await engine.collect({identity,source:sourceConflict,scope:new AutomationScope(),budget:{maxSteps:10,maxRows:10}});
    assert.equal(conflict.reason,"conflict");
    win.destroy(); clearTimeout(guard); console.log("PASS actual DOM virtual/pages/infinite, cursor, stalls, mismatch, query change, conflict"); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(guard); app.exit(1); }
})();


