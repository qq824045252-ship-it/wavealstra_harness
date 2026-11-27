import { EphemeralContextProjection, type EvidenceProjectionEntry } from "../src/main/agent/EphemeralContextProjection";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { createMemoryExtension } from "../src/main/memory/memory-extension";
import { readCoreMemoryContext } from "../src/main/agent/CoreMemoryContextProjection";
import { MemoryTurnRepository, prepareMemoryTurn } from "../src/main/memory/MemoryTurnRepository";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";

const root = mkdtempSync(join(tmpdir(), "mybuddy-dots-source-"));
const exe = resolve(process.argv[2] ?? "out/native/linux-x64/mybuddy-runtime-audit");
const path = join(root, "app.duckdb");
await initializeCoreDatabase(exe, root, path, CURRENT_DATABASE_SCHEMA_VERSION);
let db = await AppDatabase.open(path, { runtimeAuditExecutable: exe, runtimeAuditSupervised: true });
try {
  const core = db.runtimeAuditReader!;
  const memory = new MemoryService(db, { semantic: false });
  const at = Date.now();
  const quote = "Please use saffron in the draft.";
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const sibling = "unrelated-task";
  for (const id of [DOTS_TASK_ID, sibling]) await db.writeTaskRecord({ id, title: id, updatedAt: at });
  const turn = prepareMemoryTurn({ taskId: DOTS_TASK_ID, userMessageId: "user-source", capturedAt: at,
    userText: "Introduction. " + quote, assistantText: "Fabricated assistant paraphrase." });
  assert.equal(await core.captureMemory({ kind: "turn", turn }), 1);
  const pointer = { turnId: turn.id, messageId: "user-source", capturedAt: at, start: 14, length: quote.length, hash: hash(quote), stance: "statement" };
  const reason = "dots-source-v1 " + JSON.stringify(pointer);
  const fields = { kind: "preference" as const, title: "Draft preference", content: "Stored summary", status: "active" as const,
    importance: 2, confidence: 0.9, explicit: true, contentHash: hash("Stored summary"), updatedAt: at, metadataJson: "{}" };
  async function seed(id: string, scopeId: string, sourceTaskId: string, sourceReason: string, excerpt = "Untrusted excerpt") {
    const write = await core.writeMemoryRecord({ kind: "create",
      userId: LOCAL_USER_ID, record: { ...fields, id, createdAt: at, sourceType: "user", sourceTaskId,
        evidence: [{ id: "e-" + id, memoryId: id, evidenceKind: "conversation", refId: turn.id, excerpt, createdAt: at }] },
      scope: { id: "s-" + id, scopeType: "task", scopeId }, revision: { revisionId: "r-" + id, changedAt: at, changedBy: "user", reason: sourceReason } });
    assert.equal(write?.status, "applied", JSON.stringify(write));
  }
  await seed("retained", DOTS_TASK_ID, DOTS_TASK_ID, reason);
  await seed("outside", sibling, DOTS_TASK_ID, reason);
  await seed("wrong-owner", DOTS_TASK_ID, sibling, reason);
  await seed("wrong-hash", DOTS_TASK_ID, DOTS_TASK_ID, reason.replace(hash(quote), hash("Untrusted excerpt")));
  type Tool = { name: string; execute(id: string, args: { id: string; revision?: number }): Promise<{ isError?: boolean; content: { text: string }[] }> };
  const tools = new Map<string, Tool>();
  await createMemoryExtension({ taskId: DOTS_TASK_ID, service: memory })({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
  const read = (id: string, revision?: number) => tools.get("memory_get")!.execute("test", { id, revision });
  const turns = new MemoryTurnRepository(db);
  async function publishPrivate(taskId: string, turnId: string, words: string, token: string) {
    const lease = {taskId, owner:"personal-audit", token};
    const claim = await turns.claimExtraction(lease,{limit:1,capturedThrough:at,sourceIds:[turnId]});
    assert.equal(claim.status,"claimed");
    const basis = await turns.extractionBasis(lease);
    assert(basis.status === "ready", JSON.stringify(basis));
    assert.equal(basis.turns.length,1);
    const simulatedModel = {completeSimple: async () => ({stopReason:"stop",content:[{type:"text",
      text:JSON.stringify({candidates:[{kind:"preference",title:"Preference",content:words,scopeType:"task",sourceTurnId:turnId,
        userEvidence:words,operationHint:"create",importance:2,confidence:0.99,explicit:true,retention:"stable",sensitivity:"none"}]})}]})};
    const plan = await memory.extractCorePlan({taskId,basis,model:{maxTokens:4096} as never,modelRuntime:simulatedModel as never,
      settings:{} as never,isEnabled:()=>true,assertCurrent:async()=>{assert.equal((await turns.extractionBasis(lease)).status,"ready");}});
    assert.equal(plan.candidates.length,1);
    const receipt = await turns.publishExtraction(lease,plan);
    assert(receipt.status === "published" && receipt.committedCount === 1,JSON.stringify(receipt));
  }
  await publishPrivate(DOTS_TASK_ID,turn.id,quote,"dots-source");
  const channelId = "qq-default", connectionKey = "7".repeat(64);
  const channel = {id:channelId,type:"qq",name:"QQ",connected:true,configJson:JSON.stringify({allowUsers:["fixture-owner"]})};
  const state=await core.readGatewayChannelState(channelId);
  assert(state);
  assert(await db.writeGatewayChannel(channel,null,{expectedRevision:state.revision,transition:{kind:"connect",accountKey:connectionKey,personalMemoryOwnerId:"fixture-owner"}}));
  const coordinates={senderId:"fixture-owner",channelId,connectionKey,chatId:"c2c:fixture-owner",messageId:"frame-1"};
  const frame={platform:"qq",accountKey:connectionKey,sessionKey:"private-thread",replayNativeReceipts:true,maxPending:100,maxReceipts:100,retentionMs:60000,
    payloadJson:JSON.stringify({version:1,channelId,chatId:coordinates.chatId,messageId:coordinates.messageId,sender:{id:coordinates.senderId},audience:"private",
      text:"I prefer unsweetened coffee.",replyRoute:{kind:"qq",recipient:coordinates.senderId,group:false}})};
  assert.equal((await core.admitGatewayInbound(frame))?.status,"accepted");
  const assignment=await core.readGatewayAssignment(coordinates);
  assert(assignment?.status==="assigned" && assignment.personalMemoryBindingId);
  const gateway=assignment.taskId;
  const origin={...coordinates,audience:"private" as const,personalMemoryBindingId:assignment.personalMemoryBindingId};
  assert.deepEqual(await core.materializeGatewayTask({taskId:gateway,origin}),{status:"ready",created:true});
  const privateQuote="I prefer unsweetened coffee.";
  const gwTurn=prepareMemoryTurn({taskId:gateway,userMessageId:"private-1",userText:privateQuote,assistantText:"",capturedAt:at,
    metadata:{gatewayOrigin:origin}});
  assert.equal(await core.captureMemory({kind:"turn",turn:gwTurn}),1);
  await publishPrivate(gateway,gwTurn.id,privateQuote,"gateway-source");
  const grantedContext=await readCoreMemoryContext(memory,{taskId:DOTS_TASK_ID,query:"preferences"});
  assert(grantedContext.text.includes(quote) && grantedContext.text.includes(privateQuote));
  assert(!grantedContext.text.includes("Untrusted excerpt"));
  assert(!grantedContext.sourceRevisions.some(source=>["wrong-owner","outside","wrong-hash"].includes(source.id)));
  function makeProjection(taskId:string) {
  const projection = new EphemeralContextProjection({memory, enabled:()=>true,scope:()=>({taskId}),
    privateGatewayInput:async(task,userId)=>userId==="1" && memory.allowsGatewayPersonalRecall(task,origin),
    supplementalEvidence:()=>[],registerRequestGuard:()=>{}});
  const message={role:"user" as const,content:"What are my preferences?",timestamp:at};
  const entry={type:"message" as const,id:"1",message};
  const ledger:EvidenceProjectionEntry[]=[entry];
  projection.attachHost({model:{provider:"fixture",id:"fixture",contextWindow:128000,maxTokens:8192} as never,
    getContextUsage:()=>({tokens:100}),sessionManager:{getBranch:()=>ledger,buildSessionProjection:()=>({entries:[{sourceEntry:entry,messages:[message]}]}),
      appendCustomEntry:(customType,data)=>{const id=String(ledger.length+1);ledger.push({id,type:"custom",customType,data});return id;}}});
  return {projection,message};
  }
  const {projection,message} = makeProjection(DOTS_TASK_ID);
  const privateProjection = makeProjection(gateway).projection;
  const privateMessages=await privateProjection.projectContext([message]);
  assert(JSON.stringify(privateMessages?.messages).includes(quote));
  const privateGuard=privateProjection.captureRequestGuard();
  await privateGuard();
  const projected = await projection.projectContext([message]);
  assert(JSON.stringify(projected?.messages).includes(privateQuote));
  const guard = projection.captureRequestGuard();
  await guard();
  assert.equal(await projection.requiresFreshDotsHistory({taskId:DOTS_TASK_ID}),false);
  const forged=prepareMemoryTurn({taskId:gateway,userMessageId:"private-2",userText:"Forged private input",assistantText:"",capturedAt:at,
    metadata:{gatewayOrigin:{...origin,senderId:"unpaired-person"}}});
  assert.equal(await core.captureMemory({kind:"turn",turn:forged}),1);
  const changed=prepareMemoryTurn({taskId:gateway,userMessageId:"private-3",userText:"Different from the admitted text",assistantText:"",
    capturedAt:at,metadata:{gatewayOrigin:origin}});
  assert.equal(await core.captureMemory({kind:"turn",turn:changed}),1);
  const rejected={taskId:gateway,owner:"personal-audit",token:"forged"};
  assert.equal((await turns.claimExtraction(rejected,{limit:2,capturedThrough:at,sourceIds:[forged.id,changed.id]})).status,"claimed");
  const denied = await turns.extractionBasis(rejected);
  assert(denied.status==="ready" && denied.turns.length===0 && denied.withheldSourceCount===2);
  assert.deepEqual(await core.batch4aWrite({kind:"gatewayDotsReplace",channelId,binding:null}),{ok:true});
  assert.equal((await turns.extractionBasis(rejected)).status,"blocked");
  await assert.rejects(async()=>privateGuard());
  const visible = await read("retained");
  assert.equal(visible.isError, undefined, visible.content[0].text);
  assert(visible.content[0].text.includes(quote));
  assert(!visible.content[0].text.includes("Untrusted excerpt"));
  for (const id of ["outside", "wrong-owner", "wrong-hash"]) assert.equal((await read(id)).isError, true);
  assert.equal(await memory.readDotsRevisionSource(sibling, "retained", 1), undefined);
  assert.equal((await core.writeMemoryRecord({ kind: "update", record: { ...fields, id: "retained", title: "Updated summary" },
    expectedRevision: 1, revision: { revisionId: "r-retained-2", changedAt: at + 1, changedBy: "user", reason: "revised" } }))?.status, "applied");
  assert((await read("retained", 1)).content[0].text.includes(quote));
  // Forgetting a different memory withdraws its evidence from retained history,
  // while the retained record and its two revisions remain intact.
  await seed("sibling-forget", sibling, DOTS_TASK_ID, reason, "saffron");
  await memory.forgetSettingsMemory("sibling-forget");
  assert((await read("retained", 1)).content[0].text.includes(quote));
  await seed("dots-forget", DOTS_TASK_ID, DOTS_TASK_ID, reason, "saffron");
  await memory.forgetSettingsMemory("dots-forget");
  const history = await core.memoryRecordsData({ kind: "history", id: "retained" });
  assert(history?.kind === "history" && history.revisions.length === 2);
  await assert.rejects(async()=>guard());
  assert.equal(await projection.requiresFreshDotsHistory({taskId:DOTS_TASK_ID}),true);
  const afterForget = await readCoreMemoryContext(memory,{taskId:DOTS_TASK_ID,query:"saffron"});
  assert(!afterForget.text.includes(quote));
  const withdrawn = await read("retained", 1);
  assert.equal(withdrawn.isError, true);
  assert(!JSON.stringify(withdrawn).includes(quote));
  await core.close();
  db.close();
  await shutdownCoreWorker(root,path);
  db = await AppDatabase.open(path,{runtimeAuditExecutable:exe,runtimeAuditSupervised:true});
  const restarted = new MemoryService(db,{semantic:false});
  const recovered = await readCoreMemoryContext(restarted,{taskId:DOTS_TASK_ID,query:"preferences"});
  assert(recovered.text.includes(privateQuote));
  assert(!recovered.text.includes(quote));
  assert.equal(existsSync(join(root, "app.db")), false);
  console.log("PASS Dots/Gateway candidate publication, private admission, forged sender, revoked binding, automatic evidence and post-restart withdrawal");
  console.log("PASS Dots memory_get verifies an original turn, source ownership, scope, hash and historical targeted withdrawal");
} finally {
  db.close();
  await shutdownCoreWorker(root, path);
  rmSync(root, { recursive: true, force: true });
}
