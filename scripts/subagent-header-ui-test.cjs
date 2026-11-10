const { runRendererFixture } = require("./renderer-fixture-driver.cjs");
const { settleFramesScript } = require("./ui-capture.cjs");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const assert = require("node:assert/strict");
const output = join(__dirname, "../out/tests");
runRendererFixture({ name: "subagent-header-ui", width: 1640, height: 600 }, async fixture => {
  mkdirSync(output, { recursive: true });
  const html = join(output, "subagent-header-ui.html");
  writeFileSync(html, '<!doctype html><html lang="zh"><head><meta charset="UTF-8"><link rel="stylesheet" href="subagent-header-ui.css"></head><body><div id="root"></div><script src="subagent-header-ui.js"></script></body></html>');
  await fixture.loadFile(html);
  const evaluate = code => fixture.evaluate(code);
  const settle = () => evaluate(settleFramesScript);
  await settle();
  for (const width of [1560, 1100, 760, 560, 390, 320]) {
    await evaluate(`document.getElementById("column").style.width="${width}px"`);
    await settle();
    const layout = await evaluate(`(() => {
      const header = document.querySelector(".subagent-detail-header"), h = header.getBoundingClientRect();
      const items = [...header.querySelectorAll(".subagent-detail-metrics > div, .subagent-detail-heading, .subagent-detail-status, .subagent-detail-close")].map(el=>{ const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}; });
      return { h:{left:h.left,right:h.right,top:h.top,bottom:h.bottom}, items, scroll:header.scrollWidth, client:header.clientWidth, bodyTop:document.getElementById("body-marker").getBoundingClientRect().top };
    })()`);
    assert(Math.abs(layout.h.right - layout.h.left - width) < 1, `actual test column width is ${width}`);
    assert(layout.scroll <= layout.client + 1, `${width}: header must not overflow`);
    assert(layout.bodyTop >= layout.h.bottom, `${width}: header must not cover conversation`);
    for (const item of layout.items) {
      assert(item.left >= layout.h.left - 1 && item.right <= layout.h.right + 1 && item.bottom <= layout.h.bottom + 1, `${width}: item stays inside header`);
    }
    const metrics = layout.items.slice(2, 8);
    for (let i=0; i<metrics.length; i++) for (let j=i+1; j<metrics.length; j++) {
      const a=metrics[i], b=metrics[j];
      assert(!(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1), `${width}: metrics do not overlap`);
    }
    const close = layout.items.at(-1);
    assert(layout.items.slice(0,-1).every(a=>Math.min(a.right,close.right)-Math.max(a.left,close.left)<=1 || Math.min(a.bottom,close.bottom)-Math.max(a.top,close.top)<=1), `${width}: close button stays unobscured`);
    if ([1560,560,320].includes(width)) await fixture.screenshot(join(output, `subagent-header-${width}.png`));
  }
  const values = () => evaluate('Object.fromEntries([...document.querySelectorAll("[data-metric]")].map(el=>[el.dataset.metric,el.querySelector("dd").textContent]))');
  let v = await values();
  assert.deepEqual(v, {input:"0.125M",output:"0.022M",cacheRead:"0.875M",cacheWrite:"0M",hit:"88%",elapsed:"16m 56s"});
  await evaluate('window.setScenario("missing")'); await settle(); v=await values();
  assert(Object.values(v).every(value=>value==="—"), "missing receipt never displays zero usage or duration");
  await evaluate('window.setScenario("other")'); await settle(); v=await values();
  assert(v.hit==="0%" && v.cacheRead==="0M" && v.input==="0.001M", "switch child snapshot replaces metrics without aggregation");
  await evaluate('window.setScenario("running")'); await settle();
  assert((await values()).elapsed==="3m 12s", "running elapsed refreshes");
  await evaluate('document.querySelector(".subagent-detail-heading .icon-btn").click()'); await settle();
  await evaluate('document.querySelector(".subagent-detail-close").click()'); await settle();
  assert.equal(await evaluate('document.getElementById("back-count").textContent'),"2", "back/close each call navigation once");
  console.log("PASS: six widths, no clipping/overlap, child-only metrics, missing and zero, updates, back/close");
});
