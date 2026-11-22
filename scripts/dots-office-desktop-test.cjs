const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const xlsx = require("xlsx");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

assert(fs.existsSync(path.resolve(__dirname, "../vendor/craft-office/assets/gridcraft/index.html")),
  "Prepare the existing Office runtime assets with pnpm run prepare:office-runtime before running the Excel desktop check.");
const space = "dots-office-space";
const filename = "报价.xlsx";
const original = "报价原件 A137";
const overwritten = "覆盖版本 B986";
function workbook(text) {
  const book = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(book, xlsx.utils.aoa_to_sheet([[text, 137]]), "报价");
  return xlsx.write(book, {type:"buffer", bookType:"xlsx"});
}

run(async env => {
  const {evaluate, rpc, until, report, out} = env;
  const {click, press} = routingControls(env);
  const workspace = path.join(env.home, "报价空间");
  fs.mkdirSync(workspace);
  const bytes = workbook(original);
  fs.writeFileSync(path.join(workspace, "template.xlsx"), bytes);
  await evaluate("window.api.db.upsertSpace(" + JSON.stringify({id:space, name:"报价空间", path:workspace}) + ")");
  await click("MyBuddy Dots", ".sidebar-scroll");
  await press("document.querySelector('textarea.input-textarea')", "Dots input");
  await rpc("Input.insertText", {text:"在报价空间复制 Excel 模板并交付报价.xlsx"});
  await press("document.querySelector('button[title=\"发送 (Enter)\"]')", "send Excel request");
  await until(() => evaluate("!!document.querySelector('.dots-result .artifact-chip-main')"), "Dots delivered the workbook");
  const [job] = await evaluate("window.api.dots.list()");
  const [file] = job.artifacts;
  assert.equal(file.name, filename);
  assert.deepEqual(fs.readFileSync(file.saved.snapshotPath), bytes);
  const source = path.join(workspace, filename);
  assert.deepEqual(fs.readFileSync(source), bytes);
  fs.writeFileSync(source, workbook(overwritten));
  const readA1 = target => xlsx.read(fs.readFileSync(target)).Sheets["报价"].A1.v;
  assert.equal(readA1(source), overwritten);
  await press("document.querySelector('.dots-result .artifact-chip-main')", "open delivered Excel after overwrite");
  let target;
  await until(async () => {
    target = (await rpc("Target.getTargets")).targetInfos.find(info => /\/session\/[\w-]+\/$/.test(info.url));
    return !!target;
  }, "native Office WebContentsView");
  const {sessionId} = await rpc("Target.attachToTarget", {targetId:target.targetId, flatten:true});
  const view = async expression => {
    const result = await rpc("Runtime.evaluate", {expression, awaitPromise:true, returnByValue:true}, sessionId);
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  await until(() => view("document.getElementById('editor')?.getAttribute('aria-busy') === 'false'"), "GridCraft loaded the workbook");
  const grid = "document.getElementById('editor').contentWindow.frames[0].gridcraft";
  await view(grid + ".request('ui.cell.click',{cell:'A1'})");
  await until(() => view(grid + ".docInspect().then(b=>b.selection==='A1')"), "select visible A1");
  const glyphs = await view(grid + ".request('mybuddy.activeCellGlyphs',{})");
  assert.deepEqual(glyphs, {text:original, missing:""});
  const shot = await rpc("Page.captureScreenshot", {format:"png"}, sessionId);
  fs.writeFileSync(path.join(out, "dots-excel-grid.png"), Buffer.from(shot.data, "base64"));
  assert.equal(await evaluate("document.querySelector('.chat-header-title').textContent"), "MyBuddy Dots");
  report.excel = {file:filename, liveA1:readA1(source), savedA1:readA1(file.saved.snapshotPath), gridcraftA1:glyphs.text, missingGlyphs:glyphs.missing};
  report.actualControlChecks.push("The ordinary task copied and registered a valid XLSX. After overwriting its workspace file, a click inside Dots opened GridCraft and rendered the original A1 glyphs.");
}, {
  name:"dots-office-desktop", isolatedDependencyCache:true, watchRenderer:false, settings:{permissionMode:"auto"},
  fixtureModel(request) {
    const names = request.tools?.map(tool => tool.function.name) ?? [];
    const last = request.messages.at(-1);
    if (names.includes("dots_action")) return last.role === "tool" ? "已交付。" : {tool:{name:"dots_action", arguments:{action:"delegate", spaceId:space, name:"复制工作簿", text:"复制 template.xlsx 成报价.xlsx，然后登记报价.xlsx"}}};
    if (!names.includes("register_artifact")) return "OK";
    if (last.role !== "tool") {
      if (names.includes("powershell")) return {tool:{name:"powershell",arguments:{command:"Copy-Item -LiteralPath template.xlsx -Destination 报价.xlsx"}}};
      return {tool:{name:"bash",arguments:{command:"cp template.xlsx 报价.xlsx"}}};
    }
    if (last.name === "register_artifact" || String(last.content).includes("Registered generated file")) return "报价已完成。";
    return {tool:{name:"register_artifact", arguments:{path:filename}}};
  },
});
