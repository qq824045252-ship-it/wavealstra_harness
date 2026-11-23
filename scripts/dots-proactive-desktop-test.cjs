const assert = require("node:assert/strict");
const fs = require("node:fs");
const Database = require("better-sqlite3");
const { createHash } = require("node:crypto");
const path = require("node:path");
const {run} = require("./desktop-dev-harness.cjs");
const {routingControls} = require("./answer-routing-desktop-controls.cjs");

const spaceId = "drops-workspace";
const otherId = "other-desk";
const ackOnly = process.env.MYBUDDY_DOTS_DESKTOP_ACK_ONLY === "1";
const cases = [
  {id:"text", name:"盘点回报", result:"仓库清点完成，共有 37 台。", status:"completed"},
  {id:"file", name:"发货回报", result:"发货凭证.md", status:"completed"},
  {id:"failed", name:"校验回报", result:"仓储端已拒绝此次校验", status:"failed"},
  {id:"visible", name:"前台盘点", result:"返仓签收为 89 箱。", status:"completed"},
  {id:"blocked", name:"图纸回报", result:"请选择图纸的计量单位", status:"blocked"},
  {id:"ack-error", name:"接单中断", result:"记录已核对，共 41 份。", status:"completed"},
].filter(item => !ackOnly || item.id === "ack-error");
const gates = new Map(cases.map(item => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return [item.id, {wait, release}];
}));
const firstReply = Promise.withResolvers();
const afterLookup = Promise.withResolvers();
const lookupObserved = Promise.withResolvers();
const requestedModels = {front: new Set(), worker: new Set(), existingWorker: new Set()};
const history = taskId => "window.api.agent.loadTaskHistory(" + JSON.stringify(taskId) + ").then(h=>h.messages)";
run(async env => {
  const {evaluate, rpc, until, report, home} = env;
  const {press,click} = routingControls(env);
  const workspace = path.join(home,"交付空间");
  fs.mkdirSync(workspace);
  await evaluate("window.api.agent.updateAppSettings({dotsSettings:{modelId:'fixture/dots-front'}})");
  await evaluate("window.api.db.upsertSpace(" + JSON.stringify({id:spaceId,name:"交付空间",path:workspace}) + ")");
  await evaluate("window.api.db.upsertTask(" + JSON.stringify({id:"pinned-worker-task",spaceId,title:"前台盘点",modelId:"fixture/pinned-worker",updatedAt:Date.now()}) + ")");
  await evaluate("window.api.db.upsertTask(" + JSON.stringify({id:otherId,title:"其他工作台",welcomeMode:"general",updatedAt:Date.now()}) + ")");
  await rpc("Page.reload");
  await until(() => evaluate("[...document.querySelectorAll('.task-item-title')].some(el=>el.textContent==='其他工作台')"), "seeded ordinary workspace visible");
  const dots = () => click("MyBuddy Dots",".sidebar-scroll");
  const other = () => press("[...document.querySelectorAll('.task-item-title')].find(el=>el.textContent==='其他工作台')","switch to other task");
  const active = () => evaluate("document.querySelector('.chat-header-title')?.textContent");
  const resultIds = [];
  const proof = (event) => fs.appendFileSync(path.join(env.out,"proactive-events.jsonl"), JSON.stringify({at:new Date().toISOString(),...event})+"\n");
  for (const item of cases) {
    await dots();
    await press("document.querySelector('textarea.input-textarea')","input for " + item.name);
    await rpc("Input.insertText",{text:"请处理" + item.name});
    await press("document.querySelector('button[title=\"发送 (Enter)\"]')","send " + item.name);
    if (item.id === "text") {
      const activity = ".message-list .dots-activity";
      const visible = () => evaluate(`(() => { const el=document.querySelector('${activity}'); if (!el) return false; const r=el.getBoundingClientRect(); return r.height>0 && r.top>=0 && r.bottom<=innerHeight && !!el.innerText.trim(); })()`);
      try {
        await until(visible, "visible Dots status before the model returns any content");
        firstReply.resolve();
        await lookupObserved.promise;
        await until(() => evaluate(`document.querySelector('${activity}')?.innerText.includes("查看工作空间")`), "actual Dots workspace lookup remains visible between tool calls");
        assert(await visible());
        const {data} = await rpc("Page.captureScreenshot", {format:"png"});
        fs.writeFileSync(path.join(env.out,"dots-in-progress.png"),Buffer.from(data,"base64"));
        proof({case:item.id,step:"in-progress",visibleText:await evaluate(`document.querySelector('${activity}').innerText`)});
      } finally { firstReply.resolve(); afterLookup.resolve(); }
    }
    if (item.id === "ack-error") {
      await until(async () => (await evaluate(history("mybuddy-dots"))).some(row => row.role === "assistant" && row.text.includes("接单回复生成失败")), "native acknowledgement failure");
      proof({case:item.id,step:"ack-failed-after-admission"});
    } else {
      await until(() => evaluate("document.querySelector('.message-list')?.innerText.includes(" + JSON.stringify("已接单："+item.name) + ")"),"native acknowledgement");
      proof({case:item.id,step:"acknowledged"});
    }
    await other();
    await until(async () => (await active()) === "其他工作台","other ordinary task active");
    if (item.id === "visible") await dots();
    gates.get(item.id).release();
    // Observe the committed entry without invoking app IPC or refreshing the UI.
    const file = path.join(home, ".mybuddy", "durable", createHash("sha256").update("mybuddy-dots").digest("hex"), "durable.sqlite");
    const db = new Database(file,{readonly:true,fileMustExist:true});
    let delivered;
    try {
      const read = db.prepare("SELECT id,record FROM entries WHERE json_extract(record,'$.kind')='mybuddy.dots-assistant-reply' AND json_extract(record,'$.data.title')=?");
      await until(() => {
        const rows = read.all(item.name);
        assert(rows.length <= 1);
        if (!rows.length) return false;
        const record = JSON.parse(rows[0].record);
        if (item.id === "file") assert.equal(record.model, undefined, "attachment-only delivery needs no synthetic model text");
        else assert.equal(record.model?.[0].role, "assistant");
        delivered = {id:"durable-" + rows[0].id, dotsDelivery:record.data};
        return true;
      }, "physical Dots history has " + item.id + " without a follow-up");
    } finally { db.close(); }
    proof({case:item.id,step:"stored",id:delivered.id,source:delivered.dotsDelivery.sourceMessageId,kind:delivered.dotsDelivery.kind});
    assert.equal(await active(),item.id === "visible" ? "MyBuddy Dots" : "其他工作台");
    if (item.id !== "visible") {
      assert(!(await evaluate("document.querySelector('.message-list')?.innerText || ''")).includes(item.result));
      await dots();
    }
    const select = "document.getElementById("+JSON.stringify("msg-" + delivered.id)+")";
    await until(() => evaluate(select+"?.querySelector('.msg-row .assistant-card') != null"),"independent Dots assistant bubble");
    assert((await evaluate(select+".textContent")).includes(item.result), "assistant message must contain " + item.result);
    assert.deepEqual([...requestedModels.front],["dots-front"],"foreground transport uses Dots' selected model");
    assert.deepEqual([...requestedModels.worker],["ui-fixture"],"worker transport uses the main model configured for ordinary tasks");
    if (item.id==="visible") assert.deepEqual([...requestedModels.existingWorker],["pinned-worker"],"continuation keeps the target task's saved selection");
    assert(!(await evaluate(select+".innerText")).includes("已接单："));
    assert(!(await evaluate(history(otherId))).some(m => m.dotsDelivery));
    if (item.id === "file") {
      assert.equal(delivered.dotsDelivery.text, "", "a file-only delivery has no prose");
      fs.writeFileSync(path.join(workspace,item.result),"源文件已改");
      await press(select+".querySelector('.artifact-chip-main')","open file from proactive bubble");
      await until(() => evaluate("document.querySelector('.bot-work-file-preview-body')?.innerText.includes('原始发货编号 K-381')"),"file result opens original bytes");
    }
    if (item.id === "text" || item.id === "file") {
      const worker = await evaluate(history(delivered.dotsDelivery.taskId));
      assert(worker.some(row => row.role === "assistant" && row.finalAssistantReply
        && row.text === (item.id === "file" ? "" : item.result)), "ordinary task shows only the intended content");
      assert(!worker.some(row => row.role === "assistant" && row.text.includes('"dotsState"')));
    }
    assert.equal(delivered.dotsDelivery.kind, ["blocked","failed"].includes(item.id) ? "question" : "conclusion");
    proof({case:item.id,step:"shown",id:delivered.id});
    resultIds.push(delivered.id);
  }
  // Simulate an already terminal pre-outbox record. It must stay visible as
  // historical result content and must never be counted as a new assistant.
  await env.restart(async () => {
    const archival = new Database(path.join(home, ".mybuddy", "app.db"), {fileMustExist:true});
    try {
      const inserted = archival.prepare(`INSERT INTO dots_delegations(operation_id,task_id,source_message_id,title,status,text,files,created_at,updated_at,space_id,cwd)
        SELECT 'pre-outbox-result',task_id,source_message_id,'旧版留档','completed','旧仓记录 L-43','[]',created_at,updated_at,space_id,cwd
        FROM dots_delegations WHERE title=? LIMIT 1`).run(cases[0].name);
      assert.equal(inserted.changes, 1);
    } finally { archival.close(); }
  });
  await dots();
  await until(() => evaluate(JSON.stringify(resultIds)+".every(id=>document.getElementById('msg-'+id)?.querySelector('.assistant-card'))"),"all independent bubbles persisted");
  await until(() => evaluate("document.querySelector('[data-delegation-id=pre-outbox-result]')?.textContent.includes('旧仓记录 L-43')"),"legacy result survived as a card");
  assert.equal(await evaluate("document.querySelectorAll('.dots-result[data-delegation-id]').length"),1);
  const restored = await evaluate(history("mybuddy-dots"));
  assert.deepEqual(restored.filter(m=>m.dotsDelivery).map(m=>m.id),resultIds);
  assert.equal(restored.filter(m=>m.role==="user").length,cases.length);
  for (const item of cases) {
    const source = restored.find(m=>m.role==="user" && m.text==="请处理" + item.name);
    const reply = restored.find(m=>m.dotsDelivery?.title===item.name);
    assert(source && reply);
    assert.equal(reply.dotsDelivery.sourceMessageId, source.inputRequestId);
    assert.equal(String(reply.dotsDelivery.origin.entryId), source.entryId);
    assert(Number(reply.entryId) > Number(source.entryId));
  }
  const {data} = await rpc("Page.captureScreenshot",{format:"png"});
  fs.writeFileSync(path.join(env.out,"dots-proactive.png"),Buffer.from(data,"base64"));
  if (!ackOnly) report.actualControlChecks.push("Background delegations and a live Dots view returned separate durable text, file, failure and blocked messages after restart without manual follow-up.");
  report.actualControlChecks.push("When the acknowledgement failed after admission, the ordinary task still delivered to the original turn.");
  proof({step:"restored",ids:resultIds});
  report.deliveries = restored.filter(m=>m.dotsDelivery).map(m=>({id:m.id,text:m.text,kind:m.dotsDelivery.kind}));
  report.requestedModels = Object.fromEntries(Object.entries(requestedModels).map(([role,ids])=>[role,[...ids]]));
}, {
  name:ackOnly ? "dots-ack-failure-desktop" : "dots-proactive-desktop", rpcTimeoutMs:60000, isolatedDependencyCache:true, watchRenderer:false, fixtureModelIds:["dots-front","pinned-worker"],
  settings:{permissionMode:"auto",notificationPreferences:{desktopEnabled:false}},
  async fixtureModel(request) {
    const names=request.tools?.map(t=>t.function.name)??[];
    const last=request.messages.at(-1);
    const user=request.messages.findLast(m=>m.role==="user");
    const item=cases.find(c=>JSON.stringify(user?.content).includes(c.name));
    if (!item) return "OK";
    if (names.includes("dots_action")) {
      requestedModels.front.add(request.model);
      if (item.id==="text" && last.role==="user") {
        await firstReply.promise;
        return {tool:{name:"dots_action",arguments:{action:"spaces"}}};
      }
      if (item.id==="text" && last.role==="tool" && !request.messages.some(m=>m.role==="assistant" && m.tool_calls?.some(t=>t.function.arguments.includes('"delegate"')))) {
        lookupObserved.resolve();
        await afterLookup.promise;
        return {tool:{name:"dots_action",arguments:{action:"delegate",spaceId,name:item.name,text:"执行"+item.name}}};
      }
      if(last.role==="tool") return item.id==="ack-error"
        ? {fixtureFault:"model-error",message:"接单回复生成失败"} : "已接单："+item.name;
      return {tool:{name:"dots_action",arguments:{action:"delegate",spaceId,name:item.name,text:"执行"+item.name,
        ...(item.id==="visible" ? {targetTaskId:"pinned-worker-task"} : {})}}};
    }
    requestedModels[item.id==="visible"?"existingWorker":"worker"].add(request.model);
    await gates.get(item.id).wait;
    if(item.id==="failed") return {fixtureFault:"model-error",message:item.result};
    if(item.id==="blocked") {
      if (last.role==="tool") throw new Error("Unexpected return from a pending user question: "+last.content);
      return {tool:{name:"request_user_input",arguments:{kind:"short_text",title:item.result}}};
    }
    if(item.id==="file" && last.role!=="tool") return {tool:{name:"write",arguments:{path:item.result,content:"原始发货编号 K-381"}}};
    return JSON.stringify({dotsState:"complete",result:item.id==="file"?"":item.result});
  },
});
