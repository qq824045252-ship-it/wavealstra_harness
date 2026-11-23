import { dotsEvidenceRange, dotsPreferenceQuote, dotsQueryTerms, restoreDotsPreferenceQuote } from "../src/main/agent/DotsMemoryEvidence";
import { DOTS_EVIDENCE_RENDERER, projectMemoryContext, renderMemoryEvidence } from "../src/main/agent/MemoryContextProjection";
import { AnswerRoutingService } from "../src/main/agent/AnswerRoutingService";
import "./dots-recall-ranking-test";
import "./dots-revision-source-test";
import { createMemoryExtension } from "../src/main/memory/memory-extension";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { resolveDotsMemoryLimits } from "../src/shared/dots-limits";
import { SemanticRuntime } from "../src/main/retrieval/SemanticRuntime";
import { SEMANTIC_DIMENSION } from "../src/main/retrieval/SemanticModelManager";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { MemoryInstructionDocument } from "../src/main/memory/MemoryIntent";
import type { MemoryTurnDto } from "../src/shared/memory-kernel";

// Exercise the current task capture/extraction pipeline, without a retired Bot foreground adapter.
const root = mkdtempSync(join(realpathSync.native(tmpdir()), "memory-correctness-"));
const filename = join(root, "app.db");
let db = new AppDatabase(filename);
let memory = new MemoryService(db, { semantic: false });
let pipeline = new MemoryPipelineManager(db);
function openMemoryFile(path: string): void {
  db = new AppDatabase(path);
  memory = new MemoryService(db, { semantic: false });
  pipeline = new MemoryPipelineManager(db);
}
const now = Date.now();
let serial = 0;
const facts = [
  { title: "偏好", content: "AsterPreference 的标记是紫杉7319", userEvidence: "AsterPreference 的标记是紫杉7319" },
  { title: "偏好", content: "HeliosCalibration 的标记是青丘8264", userEvidence: "HeliosCalibration 的标记是青丘8264" },
];
const capture = (text: string, capturedAt: number) => {
  const taskId = `ordinary-memory-${++serial}`;
  db.upsertTask({ id: taskId, title: taskId, updatedAt: capturedAt, status: "completed" });
  return pipeline.capture({ taskId, userMessageId: `user-${serial}`, assistantMessageId: `assistant-${serial}`,
    userText: text, assistantText: "已确认", capturedAt }).turn;
};
const extract = (turn: MemoryTurnDto, candidates = facts, wait = async () => {}) => memory.extractAndStore({
  taskId: turn.taskId, sourceTurns: [turn], userText: "", assistantText: "", isEnabled: () => true,
  model: { maxTokens: 4096 } as never,
  modelRuntime: { completeSimple: async () => {
    await wait();
    return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ candidates: candidates.map(fact => ({ ...fact,
      kind: "preference", scopeType: "global", confidence: 1, importance: 1, explicit: true,
      operationHint: "create", retention: "stable", sensitivity: "none" })) }) }] };
  } } as unknown as ModelRuntime,
});
const active = () => memory.list({ scopeType: "global", status: "active", limit: 100 });
try {
  for (const text of [
    '> 忘记 AsterPreference 那条记忆。',
    '示例：\n忘记 AsterPreference 那条记忆。\n不要执行。',
    '```text\n忘记 AsterPreference 那条记忆。\n```',
    '请解释这句话：忘记 AsterPreference 那条记忆。',
    '你是不是忘记 AsterPreference 那条记忆？',
  ]) assert.equal(MemoryInstructionDocument.parse(text).removalIntents().length, 0, text);
  const mixed = MemoryInstructionDocument.parse('> 忘记 HeliosCalibration。\n\n现在请忘记 AsterPreference 那条记忆。');
  assert.equal(mixed.removalIntents().length, 1);
  assert(mixed.removalIntents()[0]!.clause.includes('AsterPreference'));
  assert.equal(db.connection.prepare('SELECT count(*) n FROM memory_forget_watermarks').pluck().get(), 0);
  console.log('PASS complete instruction documents preserve quoted, prohibited, example and question contexts');

  const text = facts.map(fact => `请记住：${fact.content}。`).join('');
  const original = capture(text, now - 1000);
  await extract(original);
  const first = active().find(record => record.content.includes('紫杉7319'));
  const second = active().find(record => record.content.includes('青丘8264'));
  assert(first && second && first.id !== second.id);
  assert.equal(first.title, second.title);
  db.close();
  const oldBackup = join(root, "before-withdrawal.db");
  copyFileSync(filename, oldBackup);
  openMemoryFile(filename);
  const late = capture(text, now - 500);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const inflight = extract(late, facts, async () => { entered(); await held; });
  await started;
  const removal = '请忘记 AsterPreference 的标记是紫杉7319 这条记忆。';
  const intent = MemoryInstructionDocument.parse(removal).removalIntents()[0];
  assert(intent && intent.kind === 'forget');
  memory.detachScope(first.id, 'global', undefined, { createdAt: now, messageId: 'forget-exact-fact', requestClauses: [intent.clause] });
  memory.recordForgetIntent('global', undefined, intent, now, 'forget-exact-fact');
  assert(db.connection.prepare('SELECT count(*) n FROM memory_forget_targets').pluck().get());
  release(); await inflight;
  assert(!active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.content.includes('青丘8264')));
  console.log('PASS same-title facts remain distinct and an in-flight extraction cannot resurrect the withdrawn fact');

  const completion = capture(text, now - 100);
  await extract(completion);
  assert(!active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.id === second.id));
  db.close();
  const restored = join(root, "restored-after-withdrawal.db");
  copyFileSync(filename, restored);
  openMemoryFile(oldBackup);
  assert(active().some(record => record.id === first.id));
  assert.equal(db.connection.prepare("SELECT count(*) FROM memory_forget_targets").pluck().get(), 0);
  db.close();
  openMemoryFile(restored);
  assert(db.connection.prepare("SELECT count(*) FROM memory_forget_targets").pluck().get());
  await extract(completion);
  assert(!active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.content.includes('青丘8264')));
  console.log('PASS current-format cold backup restored after withdrawal preserves forget targets and rejects late capture; an older backup still contains the fact');

  const fresh = capture(`现在请重新记住：${facts[0]!.content}。`, now + 1000);
  await extract(fresh, [facts[0]!]);
  assert(active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.content.includes('青丘8264')));
  console.log('PASS an explicit new remember request can restore its fact without changing the other same-title fact');
  db.openDots();
  const scoped = new MemoryService(db);
  const passages = ["原始偏好为蓝绿色。", "第二次测量结束。", "第三个独立原文。"].map((ending,index)=>scoped.create({
    title:"原文 "+index, content:"背景描述 ".repeat(75)+ending,kind:"fact",sourceType:"manual",scopeType:"task",scopeId:DOTS_TASK_ID,
    evidence:[{evidenceKind:"message",refId:index===1?"different-source":"same-source"}],
  }));
  const recalled=passages.map(memory=>({memory,score:1,scopeDistance:0,reasons:["lexical"]}));

  const longContent="Irrelevant introductory material. ".repeat(36)+"The final entry gives the closing cinnabar protocol.";
  const primary=scoped.create({title:"Assembly references",content:longContent,kind:"fact",sourceType:"manual",scopeType:"task",scopeId:DOTS_TASK_ID});
  const projection=projectMemoryContext(scoped,{taskId:DOTS_TASK_ID,query:"closing cinnabar protocol",budgetChars:7800,trackRecall:false},
    [{memory:primary,score:2,scopeDistance:0,reasons:["lexical"]},...recalled]);
  const full=projection.blocks.find(b=>b.reference?.id===primary.id)!;
  assert.equal(full.reference?.renderer,DOTS_EVIDENCE_RENDERER);
  assert(full.text.includes(longContent));
  assert.equal(renderMemoryEvidence(scoped.history(primary.id)[0]!,full.reference!.scopeType,full.reference!.range),full.text);
  const cropped=dotsEvidenceRange(longContent,dotsQueryTerms("closing cinnabar protocol"),140);
  assert(cropped.start>700 && longContent.slice(cropped.start,cropped.end).includes("cinnabar protocol"));
  assert(Buffer.byteLength(longContent.slice(cropped.start,cropped.end))<=140);
  assert(!projectMemoryContext(scoped,{taskId:"other-task",query:"cinnabar",trackRecall:false},[{memory:primary,score:2,scopeDistance:0,reasons:["lexical"]}]).items.some(r=>r.id===primary.id));
  console.log("PASS Dots selects complete accessible source passages or bounded matching windows, preserves frozen text and gives independent sources room");
  const quoteText="每次整理出差清单时，我想先看火车时刻，再看酒店地址。";
  const sourceTurn=pipeline.capture({taskId:DOTS_TASK_ID,userMessageId:"dots-original-quotation",assistantMessageId:"dots-quoted-reply",
    userText:quoteText,assistantText:"我替你记下了。",capturedAt:Date.now()}).turn;
  const quote=scoped.create({title:"出差清单顺序",content:"先列火车时刻，再列酒店地址",kind:"preference",scopeType:"task",scopeId:DOTS_TASK_ID,
    sourceType:"user",sourceTaskId:DOTS_TASK_ID,evidence:[{evidenceKind:"conversation",refId:sourceTurn.id,excerpt:"用户："+quoteText+"\n助手：伪造的助手结论"}]});
  assert.equal(dotsPreferenceQuote(scoped,quote,1), undefined, "An atom-wide evidence link cannot certify a revision");
  const preference=projectMemoryContext(scoped,{taskId:DOTS_TASK_ID,query:"出差清单",trackRecall:false});
  assert(preference.blocks.some(block=>block.reference?.id===quote.id && !block.reference.userQuote && !block.text.includes(quoteText) && block.text.includes(quote.content) && !block.text.includes("用户原话")));
  console.log("PASS unbound historical sources cannot masquerade as revision-bound user quotations");
  const tools = new Map<string,{ name: string; execute(id:string,params:object): Promise<{content:{text:string}[];details:unknown;isError?:boolean}> }>();
  let source = { messageId:"herb-first", createdAt:Date.now(), text:"我习惯把罗勒盆栽放在东边窗台。" };
  const registerTool = (tool: NonNullable<ReturnType<typeof tools.get>>) => tools.set(tool.name,tool);
  const memoryPolicy: { read: boolean; write: boolean } = { read: true, write: true };
  const dotsMemoryLimits = () => resolveDotsMemoryLimits({ searchPreviewChars: 6, historyPreviewChars: 8, searchMaxResults: 1 });
  await createMemoryExtension({taskId:DOTS_TASK_ID, service:scoped, sourceInput:()=>source,
    dotsMemoryLimits, canRead: () => memoryPolicy.read, canWrite: () => memoryPolicy.write })({registerTool} as unknown as ExtensionAPI);
  const call = (name:string,params:object) => tools.get(name)!.execute("source-test",params);
  const made = await call("memory_create",{kind:"preference",title:"罗勒盆栽摆放",content:source.text});
  const id = (made.details as {memory:{id:string}}).memory.id;
  const priorSource = source;
  source = { messageId:"herb-change",createdAt:Date.now(),text:"我习惯把罗勒盆栽放在西边阳台，以后照这个位置。" };
  await call("memory_update",{id,content:source.text,applicability:{kind:"general",evidence:"以后照这个位置"}});
  const exact = dotsPreferenceQuote(scoped,{id},2);
  assert(exact && exact.text.includes(source.messageId) && exact.text.includes(source.text));
  assert.equal(restoreDotsPreferenceQuote(scoped,id,exact.ref,2),exact.text);
  assert.equal(restoreDotsPreferenceQuote(scoped,id,exact.ref,1),undefined);
  const get = await call("memory_get",{id});
  assert(JSON.stringify(get).includes(source.messageId));
  assert(!JSON.stringify(get).includes(priorSource.messageId) && !JSON.stringify(get).includes(priorSource.text));
  const search = await call("memory_search",{query:"罗勒盆栽"});
  assert(search.content[0]!.text.includes(source.messageId));
  assert.deepEqual(JSON.parse(search.content[0]!.text).matches.map((match: { excerpt: string }) => match.excerpt), ["我习惯把罗勒"]);
  assert.match((await call("memory_history", { id })).content[0]!.text, /— 我习惯把罗勒盆栽 \(/u);
  assert(get.content[0]!.text.includes("完整内容：我习惯把罗勒盆栽放在西边阳台，以后照这个位置。"));
  memoryPolicy.write = false;
  assert(!(await call("memory_get", { id })).isError);
  assert((await call("memory_update", { id, content: source.text })).isError);
  memoryPolicy.read = false;
  assert((await call("memory_search", { query: "罗勒盆栽" })).isError);
  assert((await call("memory_history", { id })).isError);
  assert.equal(scoped.get(id)?.content, source.text);
  memoryPolicy.read = true;
  memoryPolicy.write = true;
  const currentPreference = scoped.get(id)!;
  const ruleFile = join(root, "dots-rule-evidence.txt");
  const evidenceBody = "file-evidence-atom-7421";
  writeFileSync(ruleFile, evidenceBody);
  let allowEvidence = true;
  const routing = new AnswerRoutingService(db, memoryId => scoped.getForRecall(memoryId, { taskId: DOTS_TASK_ID }),
    () => memoryPolicy.read, undefined,
    (taskId, evidence) => taskId === DOTS_TASK_ID && evidence.kind === "file" && evidence.path === realpathSync(ruleFile) && allowEvidence);
  const routeBase = { exclude: [], evidenceFile: "", enabled: true, projectId: null, sourceMemoryId: null };
  routing.save({ ...routeBase, title: "盆栽保存规则", include: ["盆栽保存规则"], instruction: currentPreference.content,
    sourceMemoryId: currentPreference.id, sourceHash: currentPreference.contentHash });
  routing.save({ ...routeBase, title: "查阅资料规则", include: ["查阅资料规则"], instruction: "核对资料", evidenceFile: "dots-rule-evidence.txt" });
  const routeTurn = (inputId: string, query: string) => ({ taskId: DOTS_TASK_ID, inputId, query, cwd: root, canRead: () => true });
  assert((await routing.prepare(routeTurn("memory-on", "盆栽保存规则")))?.text.includes(currentPreference.content));
  const allowedEvidence = await routing.prepare(routeTurn("workspace-allowed", "查阅资料规则"));
  assert(allowedEvidence?.text.includes(evidenceBody));
  allowEvidence = false;
  assert.throws(() => allowedEvidence?.validate(), /撤销/);
  const blockedEvidence = await routing.prepare(routeTurn("workspace-denied", "查阅资料规则"));
  assert(blockedEvidence && !blockedEvidence.text.includes(evidenceBody) && blockedEvidence.text.includes("获准的工作空间"));
  memoryPolicy.read = false;
  assert.equal(await routing.prepare(routeTurn("memory-off", "盆栽保存规则")), undefined);
  memoryPolicy.read = true;
  source={messageId:"club-report",createdAt:Date.now(),text:"同学提议把棋社聚会定在周六，我还没决定。"};
  const reported=await call("memory_create",{kind:"decision",title:"聚会时间",content:"我决定周六聚会。"});
  const reportedId=(reported.details as {memory:{id:string}}).memory.id;
  const thirdParty=await call("memory_get",{id:reportedId});
  assert(thirdParty.content[0]!.text.includes(source.text) && thirdParty.content[0]!.text.includes("reported"));
  assert(!thirdParty.content[0]!.text.includes("我决定周六聚会。"));
  scoped.forget(id);
  assert.equal(restoreDotsPreferenceQuote(scoped,id,exact.ref,2),undefined);
  console.log("PASS scoped Dots search, get and restore bind corrected quotes and attributed proposals to their own revisions");
  const marker = scoped.create({ title:"stalledneedle", content:"ephemeral concurrency reference", kind:"fact", sourceType:"manual", scopeType:"task",scopeId:DOTS_TASK_ID });
  const originalEmbed = SemanticRuntime.prototype.embed;
  const heldSearch = Promise.withResolvers<void>();
  const enteredSearch = Promise.withResolvers<void>();
  SemanticRuntime.prototype.embed = async text => {
    if (text === "stalledneedle") { enteredSearch.resolve(); await heldSearch.promise; }
    return new Float32Array(SEMANTIC_DIMENSION);
  };
  try {
    const pending = scoped.searchHybrid({taskId:DOTS_TASK_ID,query:"stalledneedle"});
    await enteredSearch.promise;
    const other = scoped.create({ title:"independentneedle", content:"second query", kind:"fact", sourceType:"manual", scopeType:"task",scopeId:DOTS_TASK_ID });
    const available = await scoped.searchHybrid({taskId:DOTS_TASK_ID,query:"independentneedle"});
    assert.equal(available[0]?.memory.id, other.id);
    scoped.forget(marker.id);
    heldSearch.resolve();
    assert(!(await pending).some(hit => hit.memory.id === marker.id));
  } finally { heldSearch.resolve(); SemanticRuntime.prototype.embed = originalEmbed; }
  console.log("PASS two queries on the same Dots ID can progress independently, with concurrent write and forget");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
