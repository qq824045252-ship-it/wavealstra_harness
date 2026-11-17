import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { build } from "esbuild";

const root = mkdtempSync(join(tmpdir(), "browser-conditions-"));
app.setPath("userData", join(root, "profile")); app.setPath("home", root);
const guard = setTimeout(() => { console.error("timed out"); app.exit(1); }, 20000);
void (async () => {
  try {
    await app.whenReady();
    const built = await build({entryPoints:["src/main/capabilities/browser/BrowserConditions.ts"],bundle:true,write:false,platform:"node",format:"esm"});
    const {browserConditionsScript,parseBrowserConditionEvidence} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`);
    const win = new BrowserWindow({show:false,width:800,height:600});
    const html = `<meta charset="utf-8"><div id=scope><h1>订单完成</h1><input id=field value="hello"><input id=pw type=password value="secret-password"><button id=disabled disabled>disabled</button><input id=checked type=checkbox checked><details id=details open><summary>More</summary>content</details><span class=duplicate>A</span><span class=duplicate>B</span><div id=host></div></div><script>host.attachShadow({mode:'open'}).innerHTML='<button id="shadow">Shadow action</button>'</script>`;
    await win.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    const conditions = [
      {kind:"url",value:"data:text/html",match:"contains"},
      {kind:"text",within:"#scope",selector:"h1",value:"订单完成"},
      {kind:"text",within:"#scope",selector:"#shadow",value:"Shadow action"},
      {kind:"value",selector:"#field",value:"hello"},
      {kind:"value",selector:"#pw",value:"secret-password"},
      {kind:"count",within:"#scope",selector:".duplicate",count:2},
      {kind:"state",selector:"#disabled",state:"disabled"},
      {kind:"state",selector:"#checked",state:"checked"},
      {kind:"state",selector:"#details",state:"expanded"},
      {kind:"state",selector:"#field",state:"editable"},
      {kind:"state",selector:"#shadow",state:"visible"},
      {kind:"state",selector:"#missing",state:"detached"},
      {kind:"text",selector:".duplicate",value:"A"},
      {kind:"state",within:".duplicate",selector:"#field",state:"visible"},
      {kind:"value",selector:"#pw",value:"wrong-password"},
      {kind:"state",selector:"[",state:"visible"}
    ];
    const raw = await win.webContents.executeJavaScript(browserConditionsScript(conditions));
    const evidence = parseBrowserConditionEvidence(raw);
    assert.deepEqual(evidence.map((item: {matched:boolean})=>item.matched),[true,true,true,true,true,true,true,true,true,true,true,true,false,false,false,false]);
    assert.equal(evidence[12].reason,"ambiguous target"); assert.equal(evidence[13].reason,"ambiguous scope");
    assert.equal(evidence[15].reason,"invalid selector or page state");
    assert.equal(evidence[4].observed,"[redacted]"); assert.equal(evidence[4].expected,"[redacted]");
    assert(!JSON.stringify(evidence).includes("secret-password")); assert(!JSON.stringify(evidence).includes("wrong-password"));
    assert.throws(()=>parseBrowserConditionEvidence([{kind:"url",matched:"yes",observed:"",expected:""}]));
    assert.throws(()=>browserConditionsScript([{kind:"state",selector:"#a",state:"bogus"}]));
    win.destroy(); clearTimeout(guard); console.log("PASS condition schema, shadow scope, state/value/count, ambiguity, password redaction"); app.exit(0);
  } catch (error) {console.error(error);clearTimeout(guard);app.exit(1);}
})();


