import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import Database from "better-sqlite3";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { BrowserHost } from "../src/main/browser/BrowserHost";
import { BrowserAutomationService } from "../src/main/capabilities/BrowserAutomationService";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";

const output = join(process.cwd(), "out/diagnostics/browser-p0p1");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, "tool-bridge-"));
app.setPath("userData", join(root, "profile")); app.setPath("home", root);
app.on("window-all-closed", () => {});
const writes: Array<{ source: string; value: string; trusted: boolean }> = [];
let artifactFailure = false, exportRequests = 0;
const uploadedBodies: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
let win: BrowserWindow | undefined, host: BrowserHost | undefined, runtime: DurableBotRuntime | undefined;
const guard = setTimeout(() => { console.error("browser capability tool bridge timed out"); app.exit(1); }, 90000);
async function serve(hostname: string, body: (path: string) => string) {
  const server = createServer((req, res) => {
    if (req.url === "/export") { exportRequests++; if (exportRequests === 2) artifactFailure = true; res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", 'attachment; filename="report.csv"'); res.end("name,value\n可信导出,42\n"); return; }
    if (req.url === "/upload") { const chunks: Buffer[]=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{uploadedBodies.push(Buffer.concat(chunks).toString());res.end('uploaded')});return; }
    if (req.url === "/save") {
      const chunks: Buffer[] = []; req.on("data", chunk => chunks.push(chunk));
      req.on("end", () => { writes.push(JSON.parse(Buffer.concat(chunks).toString())); res.end("saved"); }); return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/recovery") {
      res.end(`<div onclick="history.pushState({},'',location.pathname+'?new')"><span>开启新对话</span></div><textarea aria-label="消息"></textarea><p id="submission"></p><script>window.submissions=0;document.querySelector('textarea').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();window.submissions++;history.pushState({},'',location.pathname+'?submitted');document.querySelector('#submission').textContent='已发送 '+window.submissions;}};</script>`);return;
    }
    res.end(body(req.url ?? "/"));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, hostname, resolve));
  const address = server.address(); assert(address && typeof address !== "string"); return `http://${hostname}:${address.port}`;
}

void (async () => {
  await app.whenReady();
  let origin = "";
  const remote = await serve("127.0.0.2", () => `<iframe name="nested-editor" src="${origin}/nested" style="border:5px solid;padding:3px;width:420px;height:220px"></iframe>`);
  origin = await serve("127.0.0.1", path => path === "/nested" ? `<label>备注<input id="memo"></label><button id="frame-save">保存</button><p id="receipt"></p><input id="upload" type="file"><p id="upload-receipt"></p><div id="grid" data-count="2"><div class="row" data-key="a" data-index="0"><span class="cell">甲</span></div></div><button id="next">下一页</button><div id="drag-source" draggable="true" style="display:inline-block;width:130px;height:70px;background:#ddd">拖动源</div><div id="drag-destination" style="display:inline-block;width:130px;height:70px;background:#cfc">放置区</div><p id="drag-receipt"></p><script>document.querySelector('#drag-source').ondragstart=e=>{window.sourceTrusted=e.isTrusted;e.dataTransfer.setData('text/plain','源数据中文🙂')};document.querySelector('#drag-destination').ondragover=e=>e.preventDefault();document.querySelector('#drag-destination').ondrop=e=>{e.preventDefault();document.querySelector('#drag-receipt').textContent=(e.isTrusted&&window.sourceTrusted?'可信':'失败')+e.dataTransfer.getData('text/plain')};document.querySelector('#upload').onchange=async e=>{const body=await e.target.files[0].text();await fetch('/upload',{method:'POST',body});document.querySelector('#upload-receipt').textContent='uploaded '+body};document.querySelector('#next').onclick=e=>{document.querySelector('#grid').innerHTML='<div class="row" data-key="b" data-index="1"><span class="cell">乙</span></div>';e.target.disabled=true};document.querySelector('#frame-save').addEventListener('click',async e=>{await fetch('/save',{method:'POST',body:JSON.stringify({source:'frame',value:document.querySelector('#memo').value,trusted:e.isTrusted})});document.querySelector('#receipt').textContent='已保存 frame';})</script>` : `<h1>能力验收</h1><button id="prompt" aria-labelledby="native-name">Prompt</button><span id="native-name" hidden>身份确认</span><p id="prompt-result"></p><a id="export" href="/export">导出</a><input type="date" id="date"><div id="editor" contenteditable="true" aria-label="编辑器"></div><button id="double">双击</button><p id="double-result"></p><section id="long-table" data-count="4"><table><tbody>${Array.from({length:4},(_,i)=>`<tr data-key="row-${i}" data-index="${i}"><td>${('完整中文🙂行'+i).repeat(70)}</td></tr>`).join('')}</tbody></table></section><button id="long-end" disabled>已到底</button><script>document.querySelector('#prompt').onclick=()=>{document.querySelector('#prompt-result').textContent=prompt('请输入验证文本')||'取消';console.log('dialog completed')};document.querySelector('#double').ondblclick=e=>{document.querySelector('#double-result').textContent=e.isTrusted?'可信双击':'untrusted'}</script><iframe name="cross-origin" src="${remote}" style="border:7px solid;margin:20px;width:600px;height:360px"></iframe><section id="scope-a"></section><section id="scope-b"></section><script>
    for(const id of ['a','b']){const host=document.querySelector('#scope-'+id),root=host.attachShadow({mode:'open'});host.innerHTML='<span slot="button-label">保存</span>';root.innerHTML='<label>备注<input id="memo"></label><button><slot name="button-label"></slot></button><p role="status"></p>';root.querySelector('button').addEventListener('click',async e=>{await fetch('/save',{method:'POST',body:JSON.stringify({source:'shadow-'+id,value:root.querySelector('input').value,trusted:e.isTrusted})});root.querySelector('p').textContent='已保存 shadow-'+id;});}
    </script>`);
  win = new BrowserWindow({ show: false, width: 1200, height: 900 }); await win.loadURL("data:text/html,isolated capability tool bridge");
  host = new BrowserHost(); host.attach(win);
  const browser = new BrowserAutomationService(() => host ?? null);
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  for (const key of ["web", "vision", "imageGeneration", "videoGeneration", "speechToText", "textToSpeech", "subagent", "multiModelConsult", "diagnostics", "ocr"] as const) { const capability = config[key]; if (capability) capability.enabled = false; }
  config.execution.codeExecutionEnabled = false; config.execution.terminalEnabled = false;
  const store = new BuiltinCapabilityStore(join(root, "capabilities.json")); store.write(config);
  writeFileSync(join(root, "upload.txt"), "真实文件中文🙂");
  const artifactDb = new Database(join(root, "artifacts.db"));
  class FixtureArtifactService extends ArtifactService {
    override async register(registration: Parameters<ArtifactService["register"]>[0]) {
      if (artifactFailure) { artifactFailure = false; throw new Error("injected artifact registration failure"); }
      return super.register(registration);
    }
  }
  const artifacts = new FixtureArtifactService(new ArtifactStorage(join(root, "artifact-content")), new ArtifactRepository(artifactDb), new ArtifactRegistry());
  const capabilities = new BuiltinCapabilityRuntime({ store, credentials: { has: () => false, get: () => null, set: () => { throw Error("isolated test has no credentials"); }, clear: () => {} } });
  artifactDb.exec("CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY); INSERT INTO tasks(id) VALUES ('browser-capabilities')");
  const failures = new ExecutionFailureRepository(artifactDb);
  const bridge = await durableDomainTools([createBuiltinCapabilityExtension({ taskId: "browser-capabilities", taskRoot: root, nativeExecution: true,
    browserRecovery: { resolveContext: () => ({ taskId: "browser-capabilities", executionId: "fixture", assistantMessageId: "fixture" }), failures },
    runtime: capabilities, browser, artifactService: () => artifacts, getProducerMessageId: () => undefined, getIsolationLevel: () => "none" })]);
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
  let generations = 0;
  const code = `
    const step=async input=>{const r=await tools.browser_exec(input);if(r.isError)throw Error(JSON.stringify(r));return r;};
    const recovery=await step({action:'navigate',url:${JSON.stringify(origin + "/recovery")},after:{mode:'interactive'}});
    const rejected=await tools.browser_exec({action:'click',tabId:recovery.tabId,role:'button',name:'开启新对话',exact:true});
    if(!rejected.isError||rejected.code!=='SELECTOR_NOT_FOUND')throw Error('custom span unexpectedly matched button');
    const custom=await step({action:'find',tabId:recovery.tabId,name:'开启新对话',exact:true});
    await step({action:'click',tabId:recovery.tabId,selector:custom.elements[0].selector});
    await step({action:'find',tabId:recovery.tabId,role:'textbox',name:'消息',exact:true});
    await step({action:'fill',tabId:recovery.tabId,role:'textbox',name:'消息',exact:true,text:'实际提交一次'});
    const sent=await step({action:'press',tabId:recovery.tabId,role:'textbox',name:'消息',exact:true,key:'Enter',after:{mode:'text'}});
    if(sent.outcome.effect!=='confirmed'||sent.observation.status!=='completed'||!sent.observation.result.text.includes('已发送 1'))throw Error(JSON.stringify(sent));
    const opened=await step({action:'navigate',url:${JSON.stringify(origin)},after:{mode:'interactive'}});
    const tabId=opened.tabId;
    const fs=await step({action:'frames',tabId});const frame=fs.frames.find(f=>f.name==='nested-editor');if(!frame)throw Error('nested frame missing');
    const frameId=frame.frameId;
    await step({action:'find',tabId,frameId,role:'textbox',name:'备注',exact:true});
    await step({action:'fill',tabId,frameId,role:'textbox',name:'备注',exact:true,text:'跨域中文🙂'});
    await step({action:'find',tabId,frameId,role:'button',name:'保存',exact:true});
    await step({action:'click',tabId,frameId,role:'button',name:'保存',exact:true,response:{urlIncludes:'/save',status:200},expect:[{kind:'text',selector:'#receipt',value:'已保存 frame'}]});
    await step({action:'wait_for',tabId,frameId,selector:'#receipt',state:'visible'});
    await step({action:'find',tabId,frameId,selector:'#upload'});
    await step({action:'upload',tabId,frameId,selector:'#upload',files:['upload.txt'],expect:[{kind:'text',selector:'#upload-receipt',value:'uploaded 真实文件中文🙂'}]});
    const collected=await step({action:'collect',tabId,frameId,collection:{rowSelector:'.row',keyAttribute:'data-key',rowIndexAttribute:'data-index',cellSelector:'.cell',expectedRows:{selector:'#grid',attribute:'data-count'},terminal:{kind:'disabled',target:{selector:'#next'}},advance:{kind:'next',target:{selector:'#next'}}}});if(collected.collection.status!=='complete'||collected.collection.rows.map(r=>r.cells[0]).join('')!=='甲乙')throw Error('frame collection failed');
    const dragSource=await step({action:'find',tabId,frameId,selector:'#drag-source'});const dragEnd=await step({action:'find',tabId,frameId,selector:'#drag-destination'});
    await step({action:'drag',tabId,frameId,selector:dragSource.elements[0].selector,dragTo:dragEnd.elements[0].selector,dragMode:'html',expect:[{kind:'text',selector:'#drag-receipt',value:'可信源数据中文🙂'}]});
    await step({action:'find',tabId,within:'#scope-a',role:'textbox',name:'备注',exact:true});
    await step({action:'fill',tabId,within:'#scope-a',role:'textbox',name:'备注',exact:true,text:'Shadow 中文🙂'});
    await step({action:'find',tabId,within:'#scope-a',role:'button',name:'保存',exact:true});
    await step({action:'click',tabId,within:'#scope-a',role:'button',name:'保存',exact:true});
    await step({action:'wait_for',tabId,within:'#scope-a',selector:'p',state:'visible'});
    await step({action:'assert',tabId,expect:[{kind:'text',within:'#scope-a',selector:'p',value:'已保存 shadow-a'}]});
    const semantic=await step({action:'accessibility',tabId});const native=semantic.accessibility.nodes.find(n=>n.role==='button'&&n.name==='身份确认');if(!native)throw Error('native AX name missing');
    const resolved=await step({action:'find',tabId,axNodeId:native.nodeId,documentId:native.documentId});
    await step({action:'click',tabId,selector:resolved.elements[0].selector,dialogRules:[{type:'prompt',messageIncludes:'验证文本',answer:{action:'accept',promptText:'确认🙂'}}],expect:[{kind:'text',selector:'#prompt-result',value:'确认🙂'}]});
    await step({action:'find',tabId,selector:'#date'});await step({action:'fill',tabId,selector:'#date',text:'2026-11-17',expect:[{kind:'value',selector:'#date',value:'2026-11-17'}]});
    await step({action:'find',tabId,selector:'#editor'});await step({action:'fill',tabId,selector:'#editor',text:'逐字🙂中文',inputMode:'sequential',expect:[{kind:'text',selector:'#editor',value:'逐字🙂中文'}]});
    await step({action:'find',tabId,selector:'#double'});await step({action:'click',tabId,selector:'#double',clickCount:2,expect:[{kind:'text',selector:'#double-result',value:'可信双击'}]});
    await step({action:'find',tabId,selector:'#export'});const file=await step({action:'click',tabId,selector:'#export',download:{filename:'report.csv'}});if(file.download.state!=='completed'||!file.artifactId)throw Error('download artifact missing');
    await step({action:'find',tabId,selector:'#export'});
    const retained=await tools.browser_exec({action:'click',tabId,selector:'#export',download:{filename:'report.csv'}});if(!retained.download)throw Error(JSON.stringify(retained));if(!retained.isError||retained.download.state!=='completed'||retained.outcome.effect!=='confirmed'||retained.downloadArtifact.status!=='failed'||!retained.download.path)throw Error('registration failure lost completed action evidence');
    const failed=await tools.browser_exec({action:'assert',tabId,timeout_ms:150,expect:[{kind:'count',selector:'#missing',count:1}]});if(!failed.isError||failed.businessResult.status!=='failed')throw Error('assertion incorrectly passed');
    const long=await step({action:'collect',tabId,max_chars:1000,collection:{scopeSelector:'#long-table',rowSelector:'tr',cellSelector:'td',keyAttribute:'data-key',rowIndexAttribute:'data-index',expectedRows:{selector:'#long-table',attribute:'data-count'},terminal:{kind:'disabled',target:{selector:'#long-end'}},advance:{kind:'next',target:{selector:'#long-end'}}}});if(!long.collection.outputTruncated||long.collection.status!=='complete'||long.collectionArtifact.status!=='registered'||!long.collectionFile.path)throw Error('full collection artifact missing');
    const diag=await step({action:'diagnostics',tabId});if(!diag.diagnostics.events.some(e=>e.kind==='console'))throw Error('diagnostic console missing');
    const opened2=await step({action:'open',url:${JSON.stringify(origin + "/other")}});
    const tabs=await step({action:'tabs'});if(tabs.tabId!==opened2.tabId||!tabs.tabs.some(t=>t.id===tabId))throw Error('new tab was not adopted');
    const switched=await step({action:'select_tab',tabId,after:{mode:'text'}});if(switched.activeTabId!==tabId||switched.observation.status!=='completed')throw Error('tab switch/observe failed');
    const current=await step({action:'read',mode:'text'});if(current.tabId!==tabId)throw Error('implicit read returned the old tab');
    await step({action:'close',tabId:opened2.tabId});
    const read=await step({action:'read',tabId,selector:'#scope-a',mode:'text'});text({frames:fs.frames.length,text:read.text});
  `;
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "isolated", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "capability tool bridge", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, request) => {
      const previous = request.messages.at(-1); generations++;
      const content: AssistantMessage["content"] = previous?.role === "toolResult" ? [{ type: "text", text: "verified" }] : [{ type: "toolCall", id: "run-capabilities", name: "codemode", arguments: { code } }];
      if (previous?.role === "toolResult") { console.log("capability-result", JSON.stringify(previous.content)); assert.equal(previous.isError, false, JSON.stringify(previous.content)); assert.match(JSON.stringify(previous.content), /已保存 shadow-a/); }
      const stream = createAssistantMessageEventStream(), reason = previous?.role === "toolResult" ? "stop" : "toolUse";
      queueMicrotask(() => { stream.push({ type: "done", reason, message: { role: "assistant", content, stopReason: reason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end(); }); return stream;
    } });
  const open = () => DurableBotRuntime.open({ taskId: "browser-capabilities", cwd: root, directory: join(root, "state"), models, model: { provider: "fixture", modelId: "model" }, toolMode: "codemode", tools: bridge.tools, instructions: () => "isolated browser capability fixture", onSnapshot: () => {} });
  runtime = await open(); assert.equal((await (await runtime.submit("run", "stable-input")).wait(BACKGROUND_CONTEXT)).status, "done");
  assert.equal(failures.list("browser-capabilities").filter(item => !item.resolvedAt).length,0,"real Code Mode locator correction and SPA submit leave no stale recovery cards");
  assert.deepEqual(writes, [{ source: "frame", value: "跨域中文🙂", trusted: true }, { source: "shadow-a", value: "Shadow 中文🙂", trusted: true }]);
  assert.deepEqual(uploadedBodies, ["真实文件中文🙂"]);
  const exported = artifacts.listByTask("browser-capabilities"); assert.equal(exported.length, 2);
  const collectionArtifact = exported.find(a => a.title === "浏览器集合完整数据"); assert(collectionArtifact?.source.type === "workspace-file"); const allRows = JSON.parse(readFileSync(collectionArtifact.source.entryFile, "utf8")); assert.equal(allRows.rows.length, 4); assert.equal(allRows.rows[3].cells[0], ("完整中文🙂行3").repeat(70));
  const file = exported.find(a => a.title?.endsWith("report.csv"))?.source; assert(file?.type === "workspace-file"); assert.equal(readFileSync(file.entryFile, "utf8"), "name,value\n可信导出,42\n");
  await runtime.close(); runtime = await open(); await (await runtime.submit("run", "stable-input")).wait(BACKGROUND_CONTEXT);
  assert.equal(writes.length, 2); assert.equal(generations, 2); assert.equal(exportRequests, 2); assert.equal(win.isVisible(), false);
  writeFileSync(join(output, "tool-bridge.json"), JSON.stringify({ passed: true, root, writes, generations, electron: process.versions.electron, requirements: ["nested-cross-origin-input", "open-shadow-input", "slotted-button-name", "exact-scoped-semantic-locators", "native-AX-ref", "prompt", "date-and-sequential-input", "trusted-double-click", "frame-native-HTML5-source-data", "frame-upload-content", "frame-paginated-collection", "download-artifact-bytes", "artifact-failure-retains-action", "full-collection-artifact", "failed-business-assertion", "diagnostics", "task-tabs", "native-tool-schema", "durable-no-replay"] }, null, 2));
  console.log("PASS real browser_exec schema + Durable Code Mode + nested cross-origin and scoped Shadow DOM trusted save, no replay");
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await runtime?.close(); host?.dispose(); win?.destroy(); for (const server of servers) server.close(); clearTimeout(guard); app.exit(process.exitCode ? 1 : 0);
});
