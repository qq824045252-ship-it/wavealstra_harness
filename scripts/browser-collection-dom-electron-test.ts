import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { AutomationScope } from "../src/main/capabilities/AutomationScope";
import { BrowserCollection } from "../src/main/capabilities/browser/BrowserCollection";
import { createBrowserCollectionDomSource, type CollectionDomTarget } from "../src/main/capabilities/browser/BrowserCollectionDom";

const home = mkdtempSync(join(tmpdir(), "browser-collection-dom-"));
app.setPath("home", home);
app.setPath("userData", join(home, "profile"));
const guard = setTimeout(() => app.exit(1), 25_000);

const html = `<!doctype html><meta charset="utf-8"><style>
  #grid{width:150px;height:95px;overflow:auto;border:1px solid black}
  #spacer{position:relative;width:400px;height:180px}
  .row{position:absolute;left:0;width:400px;height:28px}
  .cell{position:absolute;width:90px}
</style><div id="state" data-query="all" data-expected="4"></div>
<div id="grid" data-end="no" data-columns="4"><div id="spacer"></div></div>
<button id="next">Next</button><script>
  const data=[['a','A'],['b','B'],['c','C'],['d','D']];let page=0,mode='pages';
  function render(){
    const first=Math.min(3,Math.floor(grid.scrollLeft/90));
    const visible=mode==='infinite' ? data.slice(0,Math.min(2+Math.floor(grid.scrollTop/50)*2,4)).map((value,index)=>[value,index])
      : data.slice(page===0?0:1,page===0?2:4).map((value,index)=>[value,index+(page===0?0:1)]);
    spacer.innerHTML=visible.map(([[key,value],index],i)=>
      '<div class="row" data-key="'+key+'" data-index="'+index+'" style="top:'+(i*30)+'px">'+
      [first,first+1].filter(col=>col<4).map(col=>'<span class="cell" data-column="'+col+'" style="left:'+(col*90)+'px">'+value+col+'</span>').join('')+'</div>').join('');
    grid.dataset.end=(mode==='infinite'?visible.length===4:page===1)?'yes':'no';next.disabled=page===1;
  }
  grid.addEventListener('scroll',render);
  next.addEventListener('click',()=>{if(page<1){page++;render();}});
  window.testReset=(nextMode='pages')=>{page=0;mode=nextMode;grid.scrollLeft=0;grid.scrollTop=0;state.dataset.query='all';state.dataset.expected='4';render();};
  render();
</script>`;

void (async () => {
  let win: BrowserWindow | undefined;
  try {
    await app.whenReady();
    win = new BrowserWindow({ show: true, width: 500, height: 400, webPreferences: { sandbox: true } });
    await win.loadURL(`data:text/html,${encodeURIComponent(`<iframe srcdoc="${html.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe>`)}`);
    const wc = win.webContents;
    const frame = wc.mainFrame.framesInSubtree.find(member => member !== wc.mainFrame);
    assert(frame, "selected iframe must exist");
    wc.debugger.attach("1.3");
    const context = {
      validate: () => { assert(!frame.isDestroyed() && !frame.detached); },
      evaluate: (script: string) => frame.executeJavaScript(script),
    };
    const point = (value: unknown): { x: number; y: number } => {
      assert(value && typeof value === "object" && "x" in value && "y" in value
        && typeof value.x === "number" && typeof value.y === "number");
      return { x: value.x, y: value.y };
    };
    const center = async (target: CollectionDomTarget): Promise<{ x: number; y: number }> => {
      const rect = point(await frame.executeJavaScript(`(() => {const matches=document.querySelectorAll(${JSON.stringify(target.selector)});if(matches.length!==1)throw Error('ambiguous input target');const r=matches[0].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`));
      const iframeRect = point(await wc.executeJavaScript(`(() => {const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()`));
      return { x: iframeRect.x + rect.x, y: iframeRect.y + rect.y };
    };
    const input = {
      click: async (target: CollectionDomTarget) => {
        const p = await center(target);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
      },
      scroll: async (target: CollectionDomTarget, axis: "vertical" | "horizontal", direction: "forward" | "start") => {
        const p = await center(target);
        await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", x: p.x, y: p.y,
          deltaX: axis === "horizontal" ? (direction === "start" ? -600 : 90) : 0,
          deltaY: axis === "vertical" ? 80 : 0 });
        await new Promise(resolve => setTimeout(resolve, 70));
      },
    };
    const options = {
      scopeSelector: "#grid", rowSelector: ".row", keyAttribute: "data-key", cellSelector: ".cell", rowIndexAttribute: "data-index",
      expectedRows: { selector: "#state", attribute: "data-expected" }, queryIdentity: { selector: "#state", attribute: "data-query" },
      terminal: { kind: "attribute" as const, target: { selector: "#grid", attribute: "data-end" }, value: "yes" },
      advance: { kind: "next" as const, target: { selector: "#next" } },
      horizontal: { viewport: { selector: "#grid" }, columnIndexAttribute: "data-column", expectedColumns: { selector: "#grid", attribute: "data-columns" }, maxSteps: 6 },
    };
    const source = createBrowserCollectionDomSource({ context, input, options });
    const engine = new BrowserCollection();
    const identity = { owner: "task-a", tab: "tab-a", document: "iframe-doc-a", query: "all" };
    const first = await engine.collect({ identity, source, scope: new AutomationScope(), budget: { maxSteps: 1, maxRows: 10 } });
    assert.equal(first.status, "partial"); assert.equal(first.reason, "budget"); assert(first.cursor);
    assert.equal(source.coverage.horizontalComplete, true);
    const result = await engine.collect({ identity, source, scope: new AutomationScope(), budget: { maxSteps: 5, maxRows: 10 }, cursor: first.cursor });
    assert.equal(result.status, "complete");
    assert.deepEqual(result.rows.map(row => [row.key, row.cells]), dataExpected());
    assert.equal(result.rows.find(row => row.key === "b")?.sourceStep, 1, "duplicate row preserves its first observation");
    await frame.executeJavaScript("window.testReset('infinite')");
    const infinite = createBrowserCollectionDomSource({ context, input, options: { ...options, advance: { kind: "scroll", target: { selector: "#grid" } } } });
    const infiniteResult = await engine.collect({ identity, source: infinite, scope: new AutomationScope(), budget: { maxSteps: 5, maxRows: 10 } });
    assert.equal(infiniteResult.status, "complete");
    assert.deepEqual(infiniteResult.rows.map(row => [row.key, row.cells]), dataExpected());
    await frame.executeJavaScript("window.testReset()");
    const changedFirst = await engine.collect({ identity, source, scope: new AutomationScope(), budget: { maxSteps: 1, maxRows: 10 } });
    assert(changedFirst.cursor);
    await frame.executeJavaScript("state.dataset.query='filtered'");
    const changed = await engine.collect({ identity, source, scope: new AutomationScope(), budget: { maxSteps: 5, maxRows: 10 }, cursor: changedFirst.cursor });
    assert.equal(changed.reason, "changed");
    await frame.executeJavaScript("window.testReset();state.dataset.expected='5'");
    const mismatch = await engine.collect({ identity, source, scope: new AutomationScope(), budget: { maxSteps: 5, maxRows: 10 } });
    assert.equal(mismatch.reason, "count-mismatch");
    wc.debugger.detach(); win.destroy(); clearTimeout(guard);
    console.log("PASS selected iframe, trusted input, horizontal virtual columns, duplicate pages, infinite scroll, filter and count evidence");
    app.exit(0);
  } catch (error) {
    console.error(error); win?.destroy(); clearTimeout(guard); app.exit(1);
  }
})();

function dataExpected(): Array<[string, string[]]> {
  return [["a", ["A0", "A1", "A2", "A3"]], ["b", ["B0", "B1", "B2", "B3"]],
    ["c", ["C0", "C1", "C2", "C3"]], ["d", ["D0", "D1", "D2", "D3"]]];
}
