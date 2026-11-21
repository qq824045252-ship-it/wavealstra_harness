import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { createAgentDurableFixture } from "./agent-durable-fixture";
import { NativeImprovementService } from "../src/main/agent/hooks/NativeImprovementService";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { parseReflection } from "../src/main/agent/hooks/ImprovementReflection";
import { requestFeatures } from "../src/main/agent/hooks/ImprovementDecisions";

const root = mkdtempSync(join(tmpdir(), "native-improve-"));
process.env.HOME = process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");
mkdirSync(join(root, ".mybuddy/plugins/mcp"), { recursive: true });
const db = new AppDatabase(join(root, "app.db"));
const taskId = "learn", other = "unrelated";
for (const id of [taskId, other]) db.upsertTask({ id, title: id, updatedAt: 1, permissionMode: "auto", welcomeMode: "general" });
let seq = 0;
const text = (text: string): AssistantMessage["content"] => [{ type: "text", text }];
const tool = (name: string, args: Record<string, string>): AssistantMessage["content"] =>
  [{ type: "toolCall", id: "call-" + ++seq, name, arguments: args }];
let reply: (input: TranscriptContext) => AssistantMessage["content"] = () => text("完成");
const fixture = await createAgentDurableFixture(root,db,input => reply(input));
await fixture.agent.updateAppSettings({ memoryEnabled: false, permissionMode: "auto" });
const prompt = (text: string, id = taskId) => fixture.prompt({ taskId: id,text,userMessageId: "user" + ++seq,assistantMessageId: "answer" + seq });
const request = '写入 "report.md"，然后回读同一文件再交付。';
const ledger = fixture.agent.nativeImprovement, hooks = fixture.agent.nativeHooks;
try {
  // Same task, files and decision policy. Only the read tool's missing-file behavior differs.
  const cwd = join(root, "lookup-workspace");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "invoice-total.txt"), "实付 128 元");
  writeFileSync(join(cwd, "manifest.txt"), "invoice-total.txt");
  const rawRead = CodingTools.tools!.find(t => t.name === "read")!;
  const lookup = await DurableBotRuntime.open({ taskId: "lookup", directory: join(root, "lookup-history"), cwd,
    models: fixture.models, model: { provider: "fixture", modelId: "model" }, toolMode: "native",
    tools: [{ ...rawRead, name: "baseline_read" }], instructions: () => "lookup", onSnapshot: () => {} });
  try {
    for (const reader of ["baseline_read", "read"]) {
      const requested: string[] = [], results: string[] = [];
      const read = (path: string) => { requested.push(path); return tool(reader, {path}); };
      reply = input => {
        const last = input.messages.at(-1);
        if (last?.role !== "toolResult") return read("invoice-ttoal.txt");
        const body = last.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
        results.push(body);
        if (last.isError) {
          const candidates = body.match(/请按本次任务核对目标：(\[.*\])/u);
          return read(candidates ? JSON.parse(candidates[1])[0] : "manifest.txt");
        }
        if (requested.at(-1) === "manifest.txt") return read(body.trim());
        return text(body);
      };
      const turn = await lookup.submit("读取发票金额文件，必要时可查 manifest.txt。","lookup-" + reader);
      assert.equal((await turn.wait(ctx)).status, "done");
      await lookup.conversation.waitForIdle(ctx);
      assert.deepEqual(requested, reader === "baseline_read" ? ["invoice-ttoal.txt","manifest.txt","invoice-total.txt"]
        : ["invoice-ttoal.txt",join(cwd,"invoice-total.txt")]);
      assert.match(results[0], /ENOENT/);
      assert(!results[0].includes("实付"));
      assert.equal(results.at(-1), "实付 128 元");
    }
    console.log("PASS · cold file lookup: 3 native reads before, 2 after; both returned 实付 128 元");
  } finally { await lookup.close(); }
  reply = () => text("完成");
  assert.equal(requestFeatures("请写入 report.md 再回读。").target,"report.md");
  for (const s of ["写入 report.md，不需要回读。","先回读 report.md，再写入。","如何写入 report.md 并回读？","写入 a.md 和 b.md，再回读。"])
    assert.equal(requestFeatures(s).target,"");
  await prompt("请给出完整规划，保留实施步骤和验收要求。");
  await prompt("实施范围限定为原生会话。");
  await prompt("你漏了原先的验收要求，请补齐。");
  let step = 0;
  reply = () => ++step === 1 ? tool("write", { path: "report.md",content: "原始交付" }) : text("完成。");
  await prompt(request);
  step = 0;
  reply = () => ++step <= 2 ? tool("read", { path: "never-created.txt" }) : step === 3 ? tool("read", { path: "report.md" }) : text("完成");
  await prompt("读取本轮所需的文件");
  const [first, concurrent] = await Promise.all([ledger.review(), ledger.review()]);
  assert.deepEqual(first,concurrent);
  assert.deepEqual(first.runs[0].issues,[]);
  const hookSet = first.items.filter(i => i.hookId);
  assert.equal(hookSet.length, 3, JSON.stringify(first));
  assert.equal(first.items.some(i => i.title.includes("成功") && i.state === "candidate"), true);
  const rerun = await ledger.review();
  assert.equal(rerun.runs[0].scanned,first.runs[0].scanned);
  assert.deepEqual(rerun.items.map(i => i.count),first.items.map(i => i.count));
  for (const h of hookSet) {
    assert.equal(h.triggers,0);
    assert(h.sources[0].entry && h.sources[0].input && h.sources[0].trigger);
    assert.equal(hooks.find(h.hookId!)?.draft.scope.kind,"task");
  }
  const recorded: string[] = [];
  step = 0;
  reply = input => {
    const last = JSON.stringify(input.messages.at(-1)); recorded.push(last);
    if (++step === 1) return tool("write", { path: "report.md", content: "已核验内容" });
    if (last.includes("请按用户要求回读")) return tool("read", { path: "report.md" });
    return text("已完成");
  };
  await prompt(request);
  assert(recorded.some(s => s.includes("请按用户要求回读")), JSON.stringify(recorded).slice(-1600));
  assert(recorded.some(s => s.includes("已核验内容") && s.includes("toolResult")));
  const report = await ledger.review();
  const readback = report.items.find(i => i.title.includes("交付前漏"))!;
  assert.equal(readback.repaired,1,JSON.stringify(readback));
  assert.equal(readback.triggers,1);
  const binding = db.connection.prepare("SELECT cwd FROM durable_bot_bindings WHERE task_id=?").pluck().get(taskId) as string;
  assert.equal(readFileSync(join(binding,"report.md"),"utf8"),"已核验内容");
  // Code Mode nested calls must satisfy the same check, including real file identity.
  const task = db.getTask(taskId)!;
  db.upsertTask({...task,modePresetId:"codemode"});
  step = 0;
  reply = input => {
    if (++step === 1) return tool("codemode",{ code: 'await tools.write({path:"report.md",content:"嵌套交付"});' });
    if (JSON.stringify(input.messages.at(-1)).includes("请按用户要求回读")) return tool("codemode",{ code: 'await tools.read({path:"report.md"});' });
    return text("已完成");
  };
  await prompt(request);
  assert.equal(step,4);
  assert.equal(readFileSync(join(binding,"report.md"),"utf8"),"嵌套交付");
  db.upsertTask({...db.getTask(taskId)!,modePresetId:task.modePresetId ?? null});
  mkdirSync(join(binding,"docs"),{recursive:true});
  writeFileSync(join(binding,"docs","index.txt"),"真实索引");
  const indexReads: string[] = [];
  const lookupIndex = "帮我查找并读取 index.txt";
  reply = input => {
    const last = input.messages.at(-1);
    if (last?.role === "toolResult" && !last.isError) {
      assert(last.content.some(p => p.type === "text" && p.text === "真实索引"));
      return text("已找到索引");
    }
    const body = last?.role === "user" && typeof last.content === "string" ? last.content : "";
    const offered = body.match(/本任务曾在 "([^"]+)" 成功读取同名文件/);
    const path = offered?.[1] ?? (last?.role === "toolResult" ? "docs/index.txt" : "index.txt");
    indexReads.push(path);
    return tool("read", {path});
  };
  await prompt(lookupIndex);
  assert.deepEqual(indexReads, ["index.txt","docs/index.txt"]);
  const learned = (await ledger.review()).items.find(i => i.pathHint);
  assert(learned?.pathHint?.includes("docs/index.txt"),JSON.stringify((await ledger.review()).items));
  indexReads.length = 0;
  await prompt(lookupIndex);
  assert.deepEqual(indexReads, ["docs/index.txt"], "learned location is used before the first tool call");
  assert.equal(ledger.report().items.find(i => i.pathHint)?.repaired,1);
  console.log("PASS · same named-file task and provider policy: 2 reads before learning, 1 after");
  step = 0;
  reply = input => {
    const last = JSON.stringify(input.messages.at(-1)); recorded.push(last);
    if (++step === 1) return tool("read",{path:"index.txt"});
    if (last.includes("成功读取同名文件")) return tool("read",{path:"docs/index.txt"});
    return text("结束");
  };
  await prompt("再找一次索引。");
  assert(recorded.some(s => s.includes("真实索引")));
  assert.equal(ledger.report().items.find(i => i.pathHint)?.repaired,2);
  unlinkSync(join(binding,"docs","index.txt"));
  step = 0;
  await prompt("再找一次索引。");
  assert.equal(ledger.report().items.find(i => i.pathHint)?.state,"disabled");
  recorded.length = 0;
  reply = input => { recorded.push(JSON.stringify(input.messages.at(-1))); return text("已完成"); };
  await prompt("范围收窄到桌面入口");
  assert(recorded.at(-1)?.includes("对照上轮原始要求"));
  await prompt("范围收窄到桌面入口，只要一句话");
  assert(!recorded.at(-1)?.includes("对照上轮原始要求"));
  await prompt("先做一份清单", other);
  await prompt("范围收窄到桌面入口",other);
  assert(!recorded.at(-1)?.includes("对照上轮原始要求"));
  let attempt = 0;
  reply = input => {
    recorded.push(JSON.stringify(input.messages.at(-1)));
    return ++attempt <= 2 ? tool("read", { path: "absent.txt" }) : text("无法读取该路径");
  };
  await prompt("检查指定的源文件。");
  assert(recorded.at(-1)?.includes("两次相同的 read"));
  const disabled = ledger.disable(readback.key,readback.generation!);
  assert.equal(disabled.items.find(i => i.key === readback.key)?.state,"disabled");
  assert.throws(() => ledger.disable(readback.key,readback.generation!), /已变化/);
  const nextWeek = new NativeImprovementService(db,hooks,join(root,".mybuddy/native-improvement.sqlite"), () => Date.now() + 7 * 86400000);
  try {
    const next = await nextWeek.review();
    assert.equal(next.runs.length,2);
    assert.equal(next.runs[0].published,0);
    assert.equal(next.items.find(i => i.key === readback.key)?.state,"disabled");
  } finally { await nextWeek.close(); }
  // A closed child remains discoverable from storage. The next child uses the learned version.
  const childTask = "family", directory = join(root,childTask);
  db.upsertTask({id:childTask,title:"child",updatedAt:1});
  const nativeTools = createDurableSubagentTools({ cwd:root,taskId:childTask,models:fixture.models,permissionMode:()=>"auto",
    builtinRoles:[{name:"reader",description:"reader",systemPrompt:"reader",tools:["read"],source:"builtin",readOnly:true}] });
  const options = { taskId:childTask,directory,cwd:root,models:fixture.models,model:{provider:"fixture",modelId:"model"},tools:nativeTools,
    instructions:()=>"family",onSnapshot:()=>{},nativeHooks:{store:hooks,scope:()=>({taskId:childTask})} };
  let childReads=0,childSawHint=false;
  reply = context => {
    const last=context.messages.at(-1), visible=JSON.stringify(last);
    if (last?.role==="toolResult" && last.toolName==="subagent") return text("结束");
    if (visible.includes("DISPATCH_READER")) return tool("subagent",{agent:"reader",task:"读取所需文件",model:"fixture/model",isolation:"shared"});
    if (visible.includes("两次相同的 read")) childSawHint=true;
    return ++childReads<=2 ? tool("read",{path:"missing-child.txt"}) : text("无法读取");
  };
  const dispatch = async () => {
    const runtime=await DurableBotRuntime.open({...options,toolMode:"native"});
    try {
      assert.equal((await (await runtime.submit("DISPATCH_READER","child-"+ ++seq)).wait(ctx)).status,"done");
      await runtime.conversation.waitForIdle(ctx);
    } finally { await runtime.close(); }
  };
  await dispatch();
  db.connection.prepare("INSERT INTO durable_bot_bindings VALUES(?,'pi-durable',?,?)").run(childTask,directory,root);
  const children = await ledger.review();
  assert.equal(children.children.length,1);
  const reviewedChild = children.children[0]!;
  assert.equal(reviewedChild.status,"completed");
  const original = await ledger.child(childTask,reviewedChild.conversation);
  assert.equal(original.assignment,"读取所需文件");
  assert.deepEqual(original.tools.map(t => [t.name,t.status]),[["read","failed"],["read","failed"]]);
  assert.equal(original.submissions[0]?.answer,original.answer?.entry);
  assert.equal(original.answer?.text,"无法读取");
  assert(original.parentReturnEntry && original.parentCallId && original.parentSubmissions?.length === 1);
  assert.equal(original.diagnostics.inputTokens,null);
  const waitId = "durable:family:" + reviewedChild.conversation + ":" + original.tools[0]!.task;
  db.connection.prepare("INSERT INTO task_tool_diagnostics VALUES(?,?,?,?)").run("child-wait-tool",childTask,100,JSON.stringify({
    sourceKind:"subagent",conversationId:String(reviewedChild.conversation),executionId:waitId}));
  const addWait = db.connection.prepare(`INSERT INTO conversation_interactions
    (id,task_id,execution_id,assistant_message_id,kind,title,status,created_at,resolved_at) VALUES(?,?,?,'assistant','confirm','test','resolved',100,?)`);
  addWait.run("child-wait",childTask,waitId,140);
  addWait.run("other-wait",childTask,"durable:family:1:1",999);
  const d = (await ledger.child(childTask,reviewedChild.conversation)).diagnostics;
  assert.deepEqual([d.waits,d.answered,d.waitMs],[1,1,40]);
  assert.deepEqual((await ledger.review()).children,children.children);
  // A ledger from before child indexing already has the end-of-transcript checkpoint.
  const oldLedger = new Database(join(root,".mybuddy/native-improvement.sqlite"));
  try { oldLedger.prepare("DELETE FROM child_evidence WHERE task=?").run(childTask); }
  finally { oldLedger.close(); }
  const backfill = await ledger.review();
  assert.deepEqual(backfill.children,children.children);
  assert.equal(backfill.runs[0]?.scanned,children.runs[0]?.scanned);
  await assert.rejects(ledger.child("unrelated",reviewedChild.conversation));
  const childRule=children.items.find(i=>i.sources.some(s=>s.taskId===childTask && s.actor==="subagent"));
  assert(childRule?.hookId,JSON.stringify(children));
  childReads=0;
  await dispatch();
  assert(childSawHint);
  const another = (await ledger.review()).children.find(c => c.conversation !== reviewedChild.conversation)!;
  assert((await ledger.child(childTask,another.conversation)).hooks.some(h => h.id===childRule.hookId && h.revision===1 && h.executions>0));
  const sixth = "after-five";
  db.upsertTask({id:sixth,title:sixth,welcomeMode:"general",updatedAt:1});
  reply = () => text("完成");
  await prompt("完整规划包括验收标准",sixth);
  await prompt("范围收窄到前台",sixth);
  await prompt("你漏了验收要求",sixth);
  assert.equal((await ledger.review()).items.find(i => i.sources.some(s=>s.taskId===sixth))?.state,"candidate");
  const catchup = new NativeImprovementService(db,hooks,join(root,".mybuddy/native-improvement.sqlite"),()=>Date.now()+7*86400000);
  try {
    assert.equal((await catchup.review()).items.find(i => i.sources.some(s=>s.taskId===sixth))?.state,"watching");
  } finally { await catchup.close(); }
  db.upsertTask({...db.getTask(taskId)!,modelId:"fixture/model"});
  reply = input => {
    const m=input.messages.at(-1);
    if (m?.role !== "user" || typeof m.content !== "string" || !m.content.startsWith('[{"id":')) return text("[]");
    const source=JSON.parse(m.content) as {id:number}[];
    return text(JSON.stringify({route:"技能",finding:"已改用其他输入",reason:"需要核对任务目标",change:"核查技能的选择步骤",
      acceptance:"新样本能选择正确输入，轮询要求仍保留",evidence:source.map(s=>s.id)}));
  };
  await fixture.agent.updateAppSettings({memoryEnabled:true,defaultModelId:"fixture/model"});
  const analysis = await ledger.review();
  assert(analysis.items.some(i=>i.assessment?.route==="技能"),JSON.stringify(analysis.runs));
  assert.throws(()=>parseReflection(JSON.stringify({route:"工具",finding:"f",reason:"r",change:"c",acceptance:"a",evidence:[999]}),[]),/来源之外/);
  console.log("PASS · native main and child learning, bounded publication, Code Mode readback, learned file locations, rollback, next week and source-grounded model assessment");
} finally { await fixture.close(); db.close(); }
