const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");
const {createHash} = require("node:crypto");
const { run } = require("./desktop-dev-harness.cjs");
const { routingControls } = require("./answer-routing-desktop-controls.cjs");

const goalScenario = process.env.MYBUDDY_DOTS_LIVE_GOAL === "1";

run(async env => {
  const { evaluate, until, rpc, report } = env;
  const { press, click } = routingControls(env);
  const folder = path.join(env.home, "周转库");
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder,"调拨.csv"), "货架,数量\n甲,148\n乙,57\n丙,31\n");
  const api = (method,...args) => evaluate("window.api."+method+"("+args.map(arg=>JSON.stringify(arg)).join(",")+")");
  await until(()=>evaluate("Boolean(window.api?.db && document.querySelector('.sidebar-scroll'))"), "initial sidebar and preload ready");
  await api("db.upsertSpace",{id:"sp-transfer",name:"周转库",path:folder});
  await api("db.upsertTask",{id:"desk-other",title:"另一项工作",welcomeMode:"general",updatedAt:Date.now()});
  let goal;
  if (goalScenario) {
    await api("db.upsertTask",{id:"desk-transfer-goal",title:"调拨数量核对",spaceId:"sp-transfer",cwd:folder,welcomeMode:"general",updatedAt:Date.now()});
    const created = await api("conversationRuntime.createGoal", {taskId:"desk-transfer-goal",title:"调拨数量核对",
      description:"核对调拨.csv 的三行货架，并在最终回复中交付数量合计。",criteria:[{text:"实际读到调拨.csv 的三行数据，并算出总数量"}]});
    assert(created.ok, JSON.stringify(created));
    goal = created.goal;
  }
  await rpc("Page.reload");
  await until(()=>evaluate("Boolean(document.querySelector('.sidebar-scroll'))"), "sidebar mounted");
  await click("MyBuddy Dots",".sidebar-scroll");
  await press("document.querySelector('textarea.input-textarea')","Dots input");
  const request=goal ? `把这次核对委派给原任务 desk-transfer-goal，关联已有 Goal ${goal.id}。读取调拨.csv，计算三个货架总量，按真实读到的数据自动结项，将数字回我。` : "请在「周转库」空间委派一个普通任务，读取调拨.csv，算出调拨总数量。只需把数字回我。";
  await rpc("Input.insertText",{text:request});
  await press("document.querySelector('button[title=\"发送 (Enter)\"]')","send original request");
  const history = async id => (await api("agent.loadTaskHistory",id)).messages;
  const ledger = path.join(env.home,".mybuddy","durable",createHash("sha256").update("mybuddy-dots").digest("hex"),"durable.sqlite");
  await until(()=>fs.existsSync(ledger),"original conversation opened");
  const reader = new Database(ledger,{readonly:true,fileMustExist:true});
  try {
    const ack = reader.prepare(`SELECT 1 FROM entries, json_each(record,'$.model') m WHERE json_extract(m.value,'$.role')='assistant'
      AND json_extract(m.value,'$.stopReason')='stop' AND json_extract(record,'$.kind')<>'mybuddy.dots-assistant-reply' LIMIT 1`);
    await until(()=>Boolean(ack.get()),"foreground acknowledgement");
    await press("[...document.querySelectorAll('.task-item-title')].find(el=>el.textContent==='另一项工作')","switch to unrelated task");
    const delivered = reader.prepare("SELECT 1 FROM entries WHERE json_extract(record,'$.kind')='mybuddy.dots-assistant-reply' LIMIT 1");
    await until(()=>Boolean(delivered.get()),"background assistant reply");
  } finally { reader.close(); }
  const records = await history("mybuddy-dots");
  const results = records.filter(m=>m.dotsDelivery);
  if (goal) {
    await until(async () => (await history("mybuddy-dots")).some(m=>m.dotsDelivery?.kind==="conclusion" && /236/.test(m.text)), "Goal conclusion on original Dots conversation");
    const deliveries = (await history("mybuddy-dots")).filter(m=>m.dotsDelivery?.kind==="conclusion");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].text.trim(), "236");
    assert.equal(deliveries[0].dotsDelivery.artifacts.length, 0);
    const snapshot = await api("conversationRuntime.snapshot","desk-transfer-goal");
    assert(!snapshot.interactions.some(i=>i.kind==="confirm"), JSON.stringify(snapshot));
    const target = await history("desk-transfer-goal");
    assert(target.some(m=>m.tools?.some(t=>t.name==="conversation_goal_propose_complete") ||
      Array.isArray(m.blocks) && m.blocks.some(b=>b.name==="conversation_goal_propose_complete")) ||
      JSON.stringify(target).includes("conversation_goal_propose_complete"));
    const appDb = new Database(path.join(env.home, ".mybuddy", "app.db"),{readonly:true,fileMustExist:true});
    try {
      const work = appDb.prepare("SELECT lifecycle,closure_conclusion,intent_revision FROM works WHERE work_id=?").get(goal.id);
      assert.equal(work?.lifecycle, "closed");
      assert.equal(work?.closure_conclusion, "succeeded");
      const evidence = appDb.prepare("SELECT kind,provenance,source_ref,detail FROM work_evidence WHERE work_id=?").all(goal.id);
      assert(evidence.some(item=>item.provenance==="system" && /甲,148|乙,57|丙,31/.test(item.detail)), JSON.stringify(evidence));
      assert(evidence.every(item=>item.kind!=="user_attestation"));
      report.goalClosure = {work, evidence};
    } finally { appDb.close(); }
    report.actualControlChecks.push("Existing native Goal closed with evidence from the actual CSV read and delivered to the original Dots turn without a confirmation interaction.");
    report.goalId = goal.id;
    report.goalResult = snapshot;
    report.deliveries = (await history("mybuddy-dots")).filter(m=>m.dotsDelivery);
    return;
  }
  assert.equal(results.length,1);
  assert.match(results[0].text,/236/);
  assert.equal(results[0].dotsDelivery.artifacts.length,0);
  assert.equal(records.filter(m=>m.role==="user").length,1);
  assert(records.some(m=>m.role==="assistant" && m.text.trim() && !m.dotsDelivery));
  assert(!(await history("desk-other")).some(m=>m.dotsDelivery));
  report.deliveries=records.filter(m=>m.text?.trim()).map(m=>({id:m.id,role:m.role,text:m.text,source:m.dotsDelivery?.sourceMessageId}));
  report.actualControlChecks.push("One user input, foreground acknowledgement, worker read the workspace data, computed 236 and delivered a standalone text message to the original conversation.");
}, {name:goalScenario?"dots-goal-live":"dots-handoff-live",liveModel:true,isolatedDependencyCache:true,watchRenderer:false,
  settings:{permissionMode:"auto",notificationPreferences:{desktopEnabled:false}},rpcTimeoutMs:150000});
