import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Run in the installed ego-browser Node SDK with a caller-owned test space. */
export async function runEgoParity(task, base, dir) {
  const page = task.page("p1");
  const results = [];
  async function test(name, operation) {
    try { await operation(); results.push({ name, pass: true }); }
    catch (error) { results.push({ name, pass: false, error: String(error).slice(0, 400) }); }
  }
  const equals = async (selector, text) => page.waitForFunction(
    ([selector, text]) => document.querySelector(selector)?.textContent === text, [selector, text], { timeout: 5000 });
  const click = (selector, label) => page.click(selector, { label });
  const file = join(dir, "fixture.txt");
  const bytes = "Browser parity fixture\n";
  await writeFile(file, bytes);
  await page.goto(base + "/entry");
  await test("login", async () => {
    await page.waitForSelector("text=Sign in"); await click("text=Sign in", "Sign into fixture account");
    await page.waitForSelector("#account"); assert.equal(await page.title(), "Order workspace");
  });
  await test("read", async () => assert.match(await page.snapshot(), /Order workspace/));
  await test("fill_press", async () => {
    await page.fill("#memo", "你好123"); await page.press("#memo", "Enter"); await equals("#result", "你好123");
  });
  await test("double_click", async () => {
    await page.dblclick("#double", { label: "Double click fixture button" }); await equals("#double", "Double clicked");
  });
  await test("select_check", async () => {
    await page.selectOption("#city", "Paris"); await click("#flag", "Mark order as final");
    assert.deepEqual(await page.evaluate(() => [document.querySelector("#city").value, document.querySelector("#flag").checked]), ["Paris", true]);
  });
  await test("hover", async () => {
    await page.hover("#hover", { label: "Hover over fixture button" }); assert.equal(await page.evaluate(() => document.querySelector("#hover").dataset.hovered), "yes");
  });
  await test("page_script", async () => assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll(".amount"), el => Number(el.textContent)).reduce((a,b) => a+b, 0)), 30));
  await test("script_form_edit", async () => {
    await page.evaluate(() => { const el = document.querySelector("#memo"); el.value += " 单"; });
    await page.press("#memo", "Enter"); await equals("#result", "你好123 单");
  });
  const json = response => typeof response.body === "string" ? JSON.parse(response.body) : response.body;
  await test("network", async () => {
    const r = await page.fetch("/api/orders"); assert.equal(r.status, 200); assert.deepEqual(json(r), { orders: [11,19] });
  });
  await test("network_write", async () => {
    const r = await page.fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ memo: "季度草稿" }) });
    assert.equal(r.status, 200); assert.deepEqual(json(await page.fetch("/api/draft")), { memo: "季度草稿" });
  });
  await test("public_cors", async () => {
    const r = await page.fetch(base.replace("127.0.0.1", "localhost") + "/public"); assert.equal(r.status, 200); assert.deepEqual(json(r), { currency: "CNY" });
  });
  await test("binary_fetch", async () => {
    const file = join(dir, "ego-binary.bin"); await page.fetch("/bytes", { saveAs: file });
    assert.deepEqual([...await readFile(file)], [0, 255, 13, 10, 100]);
  });
  await test("focus_insert_chord", async () => {
    await page.focus("#cursor");
    assert.equal(await page.evaluate(() => document.activeElement.id), "cursor");
    await page.keyboard.insertText("AB"); await page.keyboard.press("ArrowLeft"); await page.keyboard.insertText("中");
    await page.keyboard.press("Shift+ArrowLeft"); await page.keyboard.insertText("甲");
    assert.equal(await page.evaluate(() => document.querySelector("#cursor").value), "A甲B");
  });
  await test("rich_paste", async () => {
    await page.focus("#editor"); await page.keyboard.paste({ text: "重要", html: "<b>重要</b>" }); await equals("#editor b", "重要");
  });
  await test("pointer_drag", async () => {
    await page.dragAndDrop("#source", "#drop", { label: "Drag fixture to destination" }); await equals("#drop", "Dropped");
  });
  await test("wheel", async () => {
    const point = await page.evaluate(() => { const r = document.querySelector("#wheel").getBoundingClientRect(); return { x: r.left+20, y: r.top+15 }; });
    await page.mouse.move(point.x, point.y, { label: "Target fixture scroll area" }); await page.mouse.wheel(0, 100, { label: "Scroll fixture wheel area" });
    await page.waitForSelector("#wheel[data-scrolled=yes]");
  });
  await test("held_key_pointer_path", async () => {
    await page.hover("#pad", { label: "Locate drawing test area" });
    const points = await page.evaluate(() => {
      const r=document.querySelector("#pad").getBoundingClientRect();
      return [[0.1,0.2],[0.5,0.8],[0.8,0.4]].map(([x,y])=>[r.left+x*(r.width-1),r.top+y*(r.height-1)]);
    });
    await page.mouse.move(...points[0], { label: "Position at stroke start" });
    await page.keyboard.down("Shift");
    try {
      await page.mouse.down();
      try { for(const p of points.slice(1)) await page.mouse.move(...p, { label: "Draw test stroke segment" }); }
      finally { await page.mouse.up(); }
    } finally { await page.keyboard.up("Shift"); }
    await page.waitForSelector("#pad[data-stroke=done]");
  });
  await test("upload", async () => { await page.setInputFiles("#upload", [file]); await equals("#uploaded", bytes.trim()); });
  await test("file_chooser", async () => {
    const wait = page.waitForFileChooser({ timeout: 5000 });
    await click("#chooser", "Choose a fixture file"); await (await wait).setFiles(file); await equals("#uploaded", "chosen " + bytes.trim());
  });
  await test("download", async () => {
    const wait = page.waitForEvent("download", { timeout: 5000 }); await click("a[download]", "Download fixture document");
    const path = join(dir, "ego-download.txt"); await (await wait).saveAs(path); assert.equal(await readFile(path, "utf8"), bytes);
  });
  await test("dialog", async () => { await click("#dialog", "Open fixture confirmation"); await page.acceptDialog(); await equals("#result", "Accepted"); });
  await test("async_wait", async () => { await click("#delayed", "Start delayed fixture update"); await equals("#result", "Ready"); });
  await test("scoped_event_script", async () => {
    await page.evaluate(() => document.querySelector("#delayed").addEventListener("click", e => { window.fixtureClick = e.isTrusted && e.type; }, { once: true }));
    await click("#delayed", "Trigger observed fixture event");
    assert.equal(await page.evaluate(() => window.fixtureClick), "click");
  });
  await test("iframe", async () => { await click("#inside", "Click embedded frame button"); await page.waitForSelector("text=Frame clicked"); });
  await test("shadow", async () => { await click("#shadow", "Click shadow tree button"); await page.waitForSelector("text=Shadow clicked"); });
  await test("screenshot", async () => { const path = await page.screenshot({ path: join(dir, "ego.png") }); assert((await stat(path)).size > 500); });
  await test("popup", async () => {
    const wait = page.waitForEvent("popup", { timeout: 5000 }); await click("a[target=_blank]", "Open fixture receipt");
    const receipt = await wait; await receipt.waitForSelector("h1"); assert.equal(await receipt.title(), "Popup");
  });
  await test("new_tab_session", async () => {
    const next = await task.newPage(); await next.goto(base + "/work"); await next.waitForSelector("#account"); assert.equal(await next.title(), "Order workspace");
  });
  await test("live_script_event", async () => {
    await page.evaluate(() => document.querySelector("#delayed").addEventListener("click", () => { window.browserParityClicks = 1; }, { once: true }));
    await click("#delayed", "Check live script listener");
    assert.equal(await page.evaluate(() => window.browserParityClicks ?? 0), 1);
  });
  await writeFile(join(dir, "ego.json"), JSON.stringify(results, null, 2));
  return results;
}
