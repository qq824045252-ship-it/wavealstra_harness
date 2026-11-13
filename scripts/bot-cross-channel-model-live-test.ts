import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// NETWORK: real model, isolated application composition, real Discord adapter with synthetic HTTP/WebSocket.
const requireRoot = createRequire(resolve("package.json"));
const baseUrl = process.env.BOT_CROSS_CHANNEL_MODEL_BASE_URL ?? "http://127.0.0.1:3425/v1";
const modelId = process.env.BOT_CROSS_CHANNEL_MODEL_ID ?? "auto/deepseek-v4.1-flash";
const methodOnly = process.env.BOT_CROSS_CHANNEL_METHOD_ONLY === "1";
const protocolOnly = process.env.BOT_CROSS_CHANNEL_PROTOCOL_ONLY === "1";
const comparison = process.env.BOT_CROSS_CHANNEL_COMPARISON;
if(comparison) assert(["control","treatment"].includes(comparison));
const comparisonRoot=resolve(process.env.BOT_CROSS_CHANNEL_COMPARISON_ROOT??"out/diagnostics/bot-cross-channel/method-ab");
if(comparison) assert(comparisonRoot.startsWith(resolve("out/diagnostics/bot-cross-channel")+sep),"Comparison profiles must stay under isolated diagnostics");
const out = resolve("out/diagnostics/bot-cross-channel/model-live", new Date().toISOString().replace(/[:.]/g, "-"));
const home = comparison ? resolve(comparisonRoot,`${comparison}-home`) : join(out, "home"), config = join(home, ".mybuddy"), workspace = join(home, "workspace");
if(comparison) assert(existsSync(join(config,"app.db")),"Independent baseline profile must be copied before running");
for (const directory of [out, config, workspace, join(config, "plugins/mcp")]) mkdirSync(directory, { recursive: true });
process.env.HOME = home; process.env.USERPROFILE = home; process.env.PI_CODING_AGENT_DIR = config;
const report: any = { status: "running", out, home, modelId, channel: "real Discord adapter; synthetic provider HTTP/WebSocket, not real account acceptance", pricing: "unknown, catalog zero cost is not measured billing", stages: [], calls: [] };
report.scenario = methodOnly ? "method-reuse-subscenario; does not validate desktop amend" : "cross-channel-amend-and-method-reuse";
report.sourceHashes=Object.fromEntries(["src/main/agent/AgentService.ts","src/main/agent/work/WorkCompletionDecision.ts","src/main/agent/work/WorkPhase5Facts.ts","src/main/agent/work/WorkResultCards.ts","src/main/agent/work/WorkDeliveryArtifacts.ts","src/main/agent/work/BotWorkMethodFeedback.ts","src/main/memory/MemoryService.ts"].map(path=>[path,createHash("sha256").update(readFileSync(path)).digest("hex")]));
report.executableBundleHash=createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex");
report.expectedStages=["submit-gateway",...(methodOnly?["unique-work-completed"]:["real-draft","real-partial-returned-and-awaiting-user","desktop-amend-submitted","unique-work-amended-and-completed"]),"original-file-delivery-verified","explicit-method-correction","grounded-method-feedback","synthetic-candidate-review","reviewed-method-enabled","second-work-request","real-second-work-method-use","ownership-and-delivery-dedup-verified"];
if(protocolOnly) { report.scenario="synthetic-discord-protocol-only; no model/story acceptance"; report.expectedStages=["protocol-heartbeats-and-offline-admission"]; }
if(comparison) { report.scenario=`method-equivalent-comparison-${comparison}`; report.expectedStages=["comparison-baseline","comparison-submitted","comparison-observed"]; report.baselineDbHash=createHash("sha256").update(readFileSync(join(config,"app.db"))).digest("hex"); }
const save = () => {
  const usages=report.calls.flatMap((call:any)=>call.usage?.length?[call.usage.at(-1)]:[]);
  report.usage={calls:report.calls.length,callsWithUsage:usages.length,promptTokens:usages.reduce((n:number,u:any)=>n+(u.prompt_tokens??0),0),completionTokens:usages.reduce((n:number,u:any)=>n+(u.completion_tokens??0),0),cost:"unknown; totals include retries and failed story calls"};
  report.notReachedExpectedStages=report.expectedStages.filter((name:string)=>!report.stages.some((item:any)=>item.name===name));
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
};
const stage = (name: string, evidence: unknown) => { report.stages.push({ name, at: new Date().toISOString(), evidence }); save(); console.log(name, JSON.stringify(evidence)); };
const configured = await requireRoot(resolve("scripts/bot-live-model-config.cjs")).loadLiveModel(baseUrl, modelId);
report.modelCatalog = configured.evidence;
const proxy = createServer(async (req, res) => {
  const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
  const body = Buffer.concat(parts); const ordinal = report.calls.length + 1;
  const record: any = { ordinal, path: req.url, startedAt: Date.now(), requestBytes: body.length };
  report.calls.push(record); save();
  writeFileSync(join(out, `model-request-${ordinal}.json`), body);
  try {
    const upstream = await fetch(baseUrl.replace(/\/v1\/?$/, "") + req.url, { method: req.method,
      headers: { "content-type": "application/json", authorization: "Bearer isolated-public-local-gateway" }, body,
      signal: AbortSignal.timeout(180000) });
    record.status = upstream.status; res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
    const output: Buffer[] = [];
    for await (const chunk of upstream.body!) { const bytes = Buffer.from(chunk); output.push(bytes); res.write(bytes); }
    const text = Buffer.concat(output).toString(); writeFileSync(join(out, `model-response-${ordinal}.txt`), text);
    record.usage = text.split(/\r?\n/).flatMap(line => { try { const obj = JSON.parse(line.replace(/^data:\s*/, "")); return obj.usage ? [obj.usage] : []; } catch { return []; } });
    record.finishedAt = Date.now(); res.end(); save();
  } catch (error) { record.error = String(error); save(); res.destroy(error instanceof Error ? error : undefined); }
});
await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
const address = proxy.address(); assert(address && typeof address !== "string");
writeFileSync(join(config, "models.json"), JSON.stringify({ providers: { acceptance: { api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "isolated-public-local-gateway", models: [configured.model] } } }));
writeFileSync(join(config, "settings.json"), JSON.stringify({ defaultProvider: "acceptance", defaultModel: modelId, defaultModelId: `acceptance/${modelId}`, enabledModels: [`acceptance/${modelId}`], permissionMode: "auto", memoryEnabled: true, memorySemanticEnabled: false, retry: { enabled: false } }));
writeFileSync(join(config, "auth.json"), "{}"); writeFileSync(join(config, "plugins/mcp/mcp.json"), '{"mcpServers":{}}');
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { AgentService } = await import("../src/main/agent/AgentService");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { CronService } = await import("../src/main/cron/CronService");
const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
const { GatewayService } = await import("../src/main/gateway/GatewayService");
const { createArtifactDomain } = await import("../src/main/artifact/ArtifactDomainSetup");
const { WorkNotificationHost } = await import("../src/main/agent/work/WorkNotificationHost");
const { WorkGatewayNotificationChannels } = await import("../src/main/agent/work/WorkGatewayNotificationChannel");
const { configureGatewayBotBinding } = await import("../src/main/gateway/GatewayBotBindingSettings");
const { gatewayWorkTargetSchema } = await import("../src/main/gateway/work-outbound");
const db = new AppDatabase(join(config, "app.db"));
const runtime = await ModelRuntime.create({ authPath: join(config, "auth.json"), modelsPath: join(config, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
const agent = new AgentService(db, new TaskExecutionWorkspace(join(home, "tasks")), { models: runtime });
const terminalHost = new TerminalHost({ resolveCwd: () => workspace });
const cron = new CronService(db, agent); agent.setLocalWorkflowServices({ cron, terminal: new TaskTerminalService(terminalHost) });
const artifacts = createArtifactDomain(db.connection); agent.setArtifactDomain(artifacts.service, artifacts.coordinator);
const sent: any[] = [], replies: any[] = [];
const { DiscordGatewayAdapter } = await import("../src/main/gateway/DiscordGatewayAdapter");
class Socket {
  heartbeats = 0;
  onmessage: any = null; onclose: any = null; onerror: any = null;
  frame(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  send(value: string) { const frame = JSON.parse(value); if(frame.op===1) { this.heartbeats++; queueMicrotask(()=>this.frame({op:11,d:null})); } if(frame.op===6) queueMicrotask(()=>this.frame({op:0,t:"RESUMED",s:3,d:{}})); if(frame.op===2) queueMicrotask(()=>this.frame({op:0,t:"READY",s:1,d:{user:{id:"100",bot:true},application:{id:"200"},session_id:"synthetic-session",resume_gateway_url:"wss://gateway.discord.gg"}})); }
  close() { this.onclose?.({code:1000}); }
}
let socket: Socket;
const adapter = new DiscordGatewayAdapter("discord-default", "Synthetic Discord provider", {
  deferInboundUntilActivated: true,
  socketFactory: () => { socket = new Socket(); queueMicrotask(()=>socket.frame({op:10,d:{heartbeat_interval:protocolOnly?100:60000}})); return socket; },
  fetch: async (url, init) => {
    const route = String(url).split("/v10")[1];
    if(route === "/users/@me") return Response.json({id:"100",bot:true});
    if(route === "/oauth2/applications/@me") return Response.json({id:"200"});
    if(route === "/gateway/bot") return Response.json({url:"wss://gateway.discord.gg",session_start_limit:{remaining:10}});
    const files: any[] = []; let body: any;
    if(init?.body instanceof FormData) { body=JSON.parse(String(init.body.get("payload_json"))); for(const [name,value] of init.body.entries()) if(value instanceof Blob) { const bytes=Buffer.from(await value.arrayBuffer()); files.push({name,sha256:createHash("sha256").update(bytes).digest("hex"),text:bytes.toString()}); } }
    else body=JSON.parse(String(init?.body ?? "{}"));
    const record={route,body,files}; sent.push(record); stage("discord-http-send",record);
    return Response.json({id:String(900+sent.length),channel_id:"500"});
  },
});
const gateway = new GatewayService(db, agent, undefined, { adapters: { discord: adapter } });
const works = agent.getWorkService();
const channels = new WorkGatewayNotificationChannels(db.connection, works, gateway, { isAuthority: () => agent.getWorkHostStatus().isAuthority });
const notifications = new WorkNotificationHost(works, { isAuthority: () => agent.getWorkHostStatus().isAuthority, channels: () => [], asyncChannels: () => channels.channels(), intervalMs: 250, onError: error => stage("notification-error", String(error)), onBlocked: outcome => { if(!report.lastBlocked || JSON.stringify(report.lastBlocked)!==JSON.stringify(outcome)) { report.lastBlocked=outcome; stage("notification-blocked",outcome); } } });
const wait = async (name: string, predicate: () => any, timeout = 180000) => { report.waitingFor=name; save(); const deadline = Date.now() + timeout; while (Date.now() < deadline) { const value = predicate(); if (value) { delete report.waitingFor; return value; } await delay(250); } throw Error(`Timeout: ${name}`); };
const pendingRequest = (receipt: {assistantMessageId:string}, expected: string, allowRecipientPending = false) => {
  const response:any=db.connection.prepare("SELECT status,error,text FROM bot_messages WHERE message_id=?").get(receipt.assistantMessageId);
  if (response?.status === "completed" && allowRecipientPending) {
    // A finishes after durable delivery; B owns the asynchronous decision. Do not
    // confuse A's receipt with B's completion or loosen the outer Work deadline.
    const pending = db.connection.prepare(`SELECT d.operation_id FROM bot_peer_deliveries d
      LEFT JOIN bot_messages m ON m.message_id=d.accepted_message_id
      WHERE json_extract(d.origin_json,'$.kind')='request'
        AND json_extract(d.origin_json,'$.sourceAssistantMessageId')=?
        AND d.cancelled_at IS NULL AND d.error IS NULL
        AND (d.accepted_message_id IS NULL OR m.status IN ('queued','running','unknown')) LIMIT 1`).get(receipt.assistantMessageId);
    if (pending) return;
  }
  if(response && ["completed","failed","cancelled"].includes(response.status)) throw Error(`${expected} was not produced before request settled: ${JSON.stringify(response)}`);
};
const snapshot = () => { for (const table of ["memory_records", "memory_scopes", "memory_candidates", "memory_turns", "works", "work_execution_bindings", "bot_collaborations", "bot_messages", "work_generated_artifacts", "work_result_cards", "work_completion_turns", "work_deliverables", "bot_work_method_feedback", "memory_skill_candidates", "memory_skill_effectiveness", "work_notifications", "work_notification_attempts"]) { try { writeFileSync(join(out, `${table}.json`), JSON.stringify(db.connection.prepare(`SELECT * FROM ${table}`).all(), null, 2)); } catch {} } };
try {
  await agent.init();
  agent.setWorkNotificationWake(() => notifications.wake()); notifications.start(); await agent.resumePersistedTasks();
  if(comparison) {
    const { runMethodComparison } = await import("./bot-cross-channel-model-comparison");
    await runMethodComparison({agent,db,works,workspace,out,variant:comparison,stage,wait,pendingRequest,report});
  } else {
  const create = (displayName: string) => { const result = agent.createBot({ requestId: randomUUID(), displayName, responsibilitySummary: displayName === "验收A" ? "协调事项并委派给验收B" : "处理文本文件，核验真实输出。" }); assert(result.ok, JSON.stringify(result)); return result.bot; };
  const a = create("验收A"), b = create("验收B"); report.bots = { a, b };
  const assertOwnership = (expectedB: number) => {
    const count=(botId:string)=>(db.connection.prepare("SELECT COUNT(*) n FROM works WHERE owner_bot_id=?").get(botId) as {n:number}).n;
    assert.equal(count(a.botId),0,"source A must not own a duplicate personal Work"); assert.equal(count(b.botId),expectedB);
    assert.equal((db.connection.prepare("SELECT COUNT(*) n FROM work_teams").get() as {n:number}).n,0,"delegation must not create a team");
    return {sourceA:count(a.botId),executorB:count(b.botId),teams:0};
  };
  for (const bot of [a,b]) { const view = await agent.getBotSettings(bot.botId); const { revision, spaceId, effectiveWorkspacePath, ...settings } = view.settings;
    const saved = await agent.saveBotSettings({ ...settings, modelId: `acceptance/${modelId}`, workspacePath: workspace, expectedRevision: revision }); assert(saved.ok, JSON.stringify(saved)); }
  await gateway.connect(adapter.id, { botToken: "synthetic-only", applicationId:"200", allowUsers: ["300"], guildIds:[], allowDirectMessages:true });
  const bindings = configureGatewayBotBinding({ action: "bind", channelId: adapter.id, botId: a.botId, ownerSenderIds: ["300"] }, { current: {}, connectedIdentity: id => gateway.connectedWorkIdentity(id), ownsActiveBot: id => agent.listBots().some(bot => bot.botId === id && bot.status === "active") });
  await agent.updateAppSettings({ gatewayBotBindings: bindings });
  if(protocolOnly) {
    const initial=socket!;
    await wait("three real adapter heartbeat rounds",()=>initial.heartbeats>=3,5000);
    assert.equal(socket!,initial); assert(adapter.isConnected());
    const target={version:1 as const,channelId:adapter.id,channelType:"discord" as const,connectionKey:adapter.workConnectionKey()!,chatId:"discord-default:200:100:dm:500:300",senderId:"300",address:{channelId:"500",guildId:null,applicationId:"200",botId:"100",messageId:"1"}};
    assert.equal(gateway.checkWorkTarget(target),undefined);
    initial.close(); assert.equal(adapter.isConnected(),false);
    const blockedReason=gateway.checkWorkTarget(target); assert(blockedReason?.includes("未连接"));
    stage("protocol-heartbeats-and-offline-admission",{heartbeats:initial.heartbeats,intervalMs:100,sameSocket:true,blockedReason,modelCalls:report.calls.length}); report.status="passed";
  } else {
  const text = methodOnly ? `请委派给验收B一个单次事项：在工作目录 ${workspace} 实际写final.txt，内容逐字 FINAL_BETA，读取核验后登记为成果并交付文件，完成这个事项。只建一个B负责的Work，不组队。`
    : `请委派给验收B一个事项，目标是在工作目录生成final.txt。现在先实际写draft.txt，逐字内容为 DRAFT_ALPHA，然后登记为成果并报告真实进度。final.txt的最终内容我稍后补充，所以现在不要猜内容，也不要写final.txt，不要等待轮询；保留事项等待我的补充，不算整体完成。必须只建立一个由验收B负责的Work，不建团队。工作目录 ${workspace}。`;
  stage("submit-gateway", { text });
  socket!.frame({op:0,t:"MESSAGE_CREATE",s:2,d:{id:"1",channel_id:"500",author:{id:"300"},mentions:[],content:text}});
  const work: any = await wait("delegated Work", () => db.connection.prepare("SELECT * FROM works WHERE owner_bot_id=? ORDER BY created_at LIMIT 1").get(b.botId)); report.workId = work.work_id;
  if (!methodOnly) {
  await wait("real draft file", () => existsSync(join(workspace,"draft.txt")) && readFileSync(join(workspace,"draft.txt"),"utf8").includes("DRAFT_ALPHA"));
  stage("real-draft", { workId: work.work_id, sha256: createHash("sha256").update(readFileSync(join(workspace,"draft.txt"))).digest("hex") }); snapshot();
  const partial = await wait("completed binding and real user-input blocker",()=> {
    const current=works.getWork(work.work_id); if(current?.lifecycle === "closed") throw Error(`Partial Work closed before returning to user: ${current.closureConclusion}`);
    const binding=db.connection.prepare("SELECT * FROM work_execution_bindings WHERE work_id=? AND intent_revision=1 AND status='completed' AND invalidated_at IS NULL ORDER BY admitted_at DESC LIMIT 1").get(work.work_id);
    const blocker=db.connection.prepare("SELECT * FROM work_blockers WHERE work_id=? AND status='open' AND waiting_for_user_input=1 LIMIT 1").get(work.work_id);
    return binding&&blocker&&{binding,blocker,current};
  });
  await wait("original Discord channel receives exact partial file",()=>sent.some(item=>item.route==="/channels/500/messages"&&item.files.some((file:any)=>file.text==="DRAFT_ALPHA")),60000);
  assertOwnership(1);
  stage("real-partial-returned-and-awaiting-user",{...partial,delivery:sent.filter(item=>item.files.some((file:any)=>file.text==="DRAFT_ALPHA")),ownership:assertOwnership(1)});
  const control = await agent.sendBotMessage({ botId: a.botId, requestId: randomUUID(), text: `补充给验收B刚才的事项 ${work.work_id}：最终内容改为逐字 FINAL_BETA。请查询已有协作后amend同一个Work；保留draft.txt已完成部分，写final.txt并读取核验后登记成果。只改原事项，不新建Work。` });
  stage("desktop-amend-submitted", control);
  await wait("intent revision 2", () => { const current=works.getWork(work.work_id); if(current?.lifecycle === "closed" && current.intentRevision < 2) throw Error(`Original Work closed before amendment: ${current.closureConclusion}; ${current.closureSummary}`); if(current && current.intentRevision >= 2) return current; pendingRequest(control,"Amended original Work",true); });
  }
  await wait("real final file", () => existsSync(join(workspace,"final.txt")) && readFileSync(join(workspace,"final.txt"),"utf8").includes("FINAL_BETA"));
  await wait("work closes succeeded", () => { const current=works.getWork(work.work_id); return current?.lifecycle === "closed" && current; });
  snapshot(); const final = works.getWork(work.work_id)!;
  assert.equal(final.closureConclusion,"succeeded");
  assert.equal(readFileSync(join(workspace,"final.txt"),"utf8"),"FINAL_BETA");
  assertOwnership(1);
  stage(methodOnly ? "unique-work-completed" : "unique-work-amended-and-completed", { work: final, finalText: readFileSync(join(workspace,"final.txt"),"utf8"), sent, replies });
  await wait("Discord original recipient file",()=>sent.some(item=>item.route==="/channels/500/messages" && item.files.some((file:any)=>file.text.includes("FINAL_BETA"))),60000);
  stage("original-file-delivery-verified",sent.filter(item=>item.route==="/channels/500/messages" && item.files.some((file:any)=>file.text.includes("FINAL_BETA"))));
  const relation: any = db.connection.prepare("SELECT collaboration_id FROM bot_collaborations WHERE work_id=?").get(work.work_id);
  assert(relation);
  const feedback = await agent.sendBotMessage({ botId:a.botId,requestId:randomUUID(),selectedCollaborationId:relation.collaboration_id,
    text:`纠正验收B在事项 ${work.work_id} 的方法：以后这类生成文本文件的任务，必须先读取现有文件，再写新文件，然后重新读取新文件核对，并另外写verification.txt，内容逐字为 VERIFIED_REUSE。请查询当前关联协作的真实已完成成果，保存这次方法纠正供验收B复用；不要新建Work，也不要改已交付final.txt。` });
  stage("explicit-method-correction",feedback);
  const candidate: any = await wait("grounded Bot B candidate",()=> {
    const recorded:any=db.connection.prepare("SELECT result_json FROM bot_work_method_feedback WHERE user_message_id=? AND work_id=?").get(feedback.userMessageId,work.work_id);
    if(recorded) {
      const result=JSON.parse(recorded.result_json);
      assert.equal(result.status,"procedure_revised",JSON.stringify(result));
      const row=db.connection.prepare("SELECT c.* FROM memory_skill_candidates c,json_each(c.source_memory_ids_json) s WHERE c.scope_type='bot' AND c.scope_id=? AND c.status IN ('draft','ready') AND s.value=? ORDER BY c.updated_at DESC LIMIT 1").get(b.botId,result.memoryId);
      if(row) { stage("grounded-method-feedback",result); return row; }
    }
    pendingRequest(feedback,"Real method feedback and grounded candidate",true);
  });
  assert(candidate.instructions.includes("VERIFIED_REUSE"),"reviewed method must retain the explicit correction");
  stage("synthetic-candidate-review",{actor:"automated acceptance reviewer, not a human UI click",candidateId:candidate.id,scopeType:candidate.scope_type,scopeId:candidate.scope_id,instructions:candidate.instructions,decision:"approve for one isolated reuse experiment",expectedEvidence:"actual Skill read, second.txt and verification.txt disk bytes"});
  const approved = agent.approveKernelMemorySkillCandidate(candidate.id); assert(approved.installedSkillId);
  agent.setSkillEnabled(approved.installedSkillId,true);
  const bSettings = await agent.getBotSettings(b.botId); const {revision:revisionB,spaceId:spaceB,effectiveWorkspacePath:pathB,...bValues}=bSettings.settings;
  const applied = await agent.saveBotSettings({...bValues,skillIds:[approved.installedSkillId],expectedRevision:revisionB}); assert(applied.ok,JSON.stringify(applied));
  assert(!(await agent.getBotSettings(a.botId)).skills.some(skill=>skill.id===approved.installedSkillId),"A cannot discover B's private method");
  stage("reviewed-method-enabled",{candidate,approved,selection:applied});
  const second = await agent.sendBotMessage({botId:a.botId,requestId:randomUUID(),text:"请委派验收B一个新的独立事项，按它已经审核启用的方法处理同一目录：读取final.txt，然后生成second.txt，内容逐字为 SECOND_GAMMA，核验并登记全部本次输出。这是方法复用验收，必须先读取实际挂载Skill，再照方法执行，不得只口头说已用。"});
  stage("second-work-request",second);
  const next: any = await wait("second delegated Work",()=> { const row=db.connection.prepare("SELECT * FROM works WHERE owner_bot_id=? AND work_id<>? ORDER BY created_at DESC LIMIT 1").get(b.botId,work.work_id); if(row)return row; pendingRequest(second,"Second Work",true); });
  await wait("second Work completed",()=>works.getWork(next.work_id)?.lifecycle==="closed");
  assert.equal(works.getWork(next.work_id)?.closureConclusion,"succeeded");
  assert.equal(readFileSync(join(workspace,"second.txt"),"utf8"),"SECOND_GAMMA");
  assert.equal(readFileSync(join(workspace,"verification.txt"),"utf8"),"VERIFIED_REUSE");
  assert.equal(readFileSync(join(workspace,"final.txt"),"utf8"),"FINAL_BETA","reusing a method must preserve the prior deliverable");
  const actualUse=db.connection.prepare(`SELECT i.* FROM memory_skill_effectiveness i JOIN work_execution_bindings b ON b.task_id=i.task_id WHERE b.work_id=? AND i.skill_id=? AND i.invoked_at IS NOT NULL`).all(next.work_id,approved.installedSkillId);
  assert(actualUse.length,"second Work must actually read and expose installed skill, not a manually seeded invocation");
  stage("real-second-work-method-use",{work:works.getWork(next.work_id),actualUse,verification:readFileSync(join(workspace,"verification.txt"),"utf8")});
  await notifications.drainAsync(); await notifications.drainAsync();
  const effects=db.connection.prepare("SELECT effect_key,notification_id FROM work_notification_effects WHERE channel='gateway:discord-default'").all() as Array<{effect_key:string;notification_id:string}>;
  const deliveryCounts=effects.map(effect=>{const nonce=createHash("sha256").update(effect.effect_key).digest("hex").slice(0,24); const count=sent.filter(item=>item.body?.nonce===nonce).length; assert(count<=1,`notification ${effect.notification_id} sent ${count} times`); return {...effect,nonce,count};});
  stage("ownership-and-delivery-dedup-verified",{ownership:assertOwnership(2),deliveryCounts});
  report.status=methodOnly?"partial-pass":"passed"; report.unverified=["Real channel provider delivery", "Long-term method effectiveness beyond this one reuse", ...(methodOnly?["Desktop amendment / partial-result story not tested in this subscenario"]:[])];
  }
  }
} catch(error) { report.status="failed"; report.error=error instanceof Error ? error.stack : String(error); console.error(report.error); process.exitCode=1; }
finally { snapshot(); save(); notifications.stop(); cron.stop(); await gateway.stop(); await agent.closeDurableBots(); agent.dispose(); terminalHost.dispose(); db.close(); proxy.closeAllConnections(); await new Promise<void>(done=>proxy.close(()=>done())); console.log(`EVIDENCE ${out}`); }
