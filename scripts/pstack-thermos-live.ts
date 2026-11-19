import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { limitLiveRequests } from "./pstack-live-admission.mjs";
import { restrictAuthoredFixture } from "./pstack-authored-fixture-scope";

// Online acceptance via the configured MyBuddy foreground model, normal task
// admission and native child conversations. Never copy credentials into evidence.
const [scenario, arm, evidenceDir, desktopReport] = process.argv.slice(2);
const triggers = ["request", "merge", "changed", "length", "long-file", "branches", "criteria", "workers", "negated", "ui-threshold", "authored"];
if (!triggers.includes(scenario) || !["enabled", "control"].includes(arm) || !evidenceDir) throw Error("Pass scenario, enabled|control and output directory");
const output = resolve(evidenceDir, scenario + "-" + arm);
mkdirSync(output, { recursive: false });
const initialProfile = join(homedir(), ".mybuddy");
const load = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (file: string, obj: unknown) => writeFileSync(file, JSON.stringify(obj, null, 2));
const preferred = load(join(initialProfile, "settings.json"));
const scratch = mkdtempSync(join(tmpdir(), "mybuddy-thermos-live-"));
process.env.HOME = process.env.USERPROFILE = scratch;
const config = process.env.PI_CODING_AGENT_DIR = join(scratch, ".mybuddy");
mkdirSync(config);
const defaultModelId = preferred.defaultProvider + "/" + preferred.defaultModel;
const roleProfile = load(join(initialProfile, "subagent.json"));
const modelId = process.env.PSTACK_THERMOS_LIVE_MODEL || defaultModelId;
if (modelId !== defaultModelId && !Object.values(roleProfile.roles ?? {}).flat().includes(modelId)) throw Error("Choose an actually configured model.");
save(join(config, "settings.json"), { defaultProvider: preferred.defaultProvider, defaultModel: preferred.defaultModel,
  enabledModels: preferred.enabledModels, disabledModelIds: preferred.disabledModelIds, defaultThinkingLevel: preferred.defaultThinkingLevel,
  modelThinkingLevels: preferred.modelThinkingLevels, permissionMode: "auto", memoryEnabled: false });
copyFileSync(join(initialProfile, "subagent.json"), join(config, "subagent.json"));
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { AgentService } = await import("../src/main/agent/AgentService");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { normalizePstackSettings } = await import("../src/shared/pstack");
const { openDurablePassiveStorage } = await import("../src/main/agent/durable/DurableStorage");
const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
const ui = scenario === "ui-threshold";
const authored = scenario === "authored";
if (ui && !desktopReport) throw new Error("Pass the real Windows desktop settings validation report for this pair.");
const policyPath = ui ? join(load(desktopReport).home, ".mybuddy", "modes", "coding", "policy.json") : undefined;
const desktopPolicy = policyPath ? load(policyPath).pstackThermos : undefined;
const settings = normalizePstackSettings(desktopPolicy ?? {}), enabled = arm === "enabled";
const policy = settings.thermos;
if (!ui) {
  policy.reviewerRole = "judgment";
  settings.roles.judgment = { ...settings.roles.judgment, model: modelId, effort: "default", count: scenario === "workers" && enabled ? 2 : 1 };
  for (const key of Object.keys(policy.criteria)) policy.criteria[key] = key === "type-boundaries" || (scenario === "criteria" && enabled && key === "simplification");
}
const workerConfig = settings.roles[policy.reviewerRole];
switch (scenario) {
  case "request": policy.onRequest = enabled; break;
  case "merge": policy.beforeMerge = enabled; break;
  case "changed": policy.changedLines = enabled ? 0 : 1; break;
  case "length": policy.fileLines = enabled ? 4 : 5; break;
  case "long-file": policy.fileLines = enabled ? 1000 : 1001; break;
  case "branches": policy.specialCases = enabled ? 3 : 4; break;
  case "negated": policy.onRequest = policy.beforeMerge = enabled; break;
  case "authored": policy.onRequest = policy.beforeMerge = false; break;
  case "ui-threshold":
    assert.equal(policy.changedLines, 211, "The UI write must exist on disk before this comparison.");
    if (enabled) policy.changedLines = normalizePstackSettings({}).thermos.changedLines;
    break;
}
const appDb = new AppDatabase(join(scratch, "app.db")), ws = new TaskExecutionWorkspace(join(scratch, "workspace"));
const taskId = "thermos", cwd = ws.ensureTaskExecutionWorkspace(taskId);
const git = (...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { windowsHide: true, stdio: "pipe" });
git("init", "-q", "-b", "main");
const program = "function answer() {\n  return 42;\n}\nmodule.exports = answer;\n";
const initial = scenario === "long-file" ? program + Array.from({length:996},(_,i)=>"// fixture row " + i + "\n").join("") : program;
writeFileSync(join(cwd, "target.cjs"), initial);
if (authored) {
  const catalog = [
    "const fs=require('node:fs'), path=require('node:path');",
    "const root="+JSON.stringify(join(config,"plugins","skills"))+";",
    "const ids=fs.readdirSync(root).filter(id=>{const m=path.join(root,id,'_user_meta.json');return fs.existsSync(m)&&JSON.parse(fs.readFileSync(m)).source==='authoring';});",
    "if(ids.length!==1)throw Error('Exactly one authored package is required');",
    "const file=path.join(root,ids[0],'SKILL.md');if(fs.realpathSync(file)!==file)throw Error('Unexpected package path');",
    "const header=fs.readFileSync(file,'utf8').split(/\\r?\\n---(?:\\r?\\n)/)[0];",
    "const head=[...header.split(/\\r?\\n/),'---','','# Approved rollout zones','','Match IANA identifiers exactly against the approved rollout list below. Return the accepted IDs and send unmatched IDs to launch steward Asha. Preserve original row numbers for accepted and rejected IDs.','','## Approved IDs'];",
    "const zones=Intl.supportedValuesOf('timeZone').slice(0,"+(enabled?201:200)+"-head.length);",
    "const contents=[...head,...zones.map(z=>'- '+z)].join('\\n')+'\\n';fs.writeFileSync(file,contents);console.log(JSON.stringify({file,lines:contents.split('\\n').length-1}));",
  ].join("\n");
  writeFileSync(join(cwd,"catalog.cjs"),catalog);
}
git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "baseline");
let deltaSha256: string | undefined;
if (ui) {
  const payload = Intl.supportedValuesOf("timeZone").slice(0, 205).join("\n") + "\n";
  assert.equal(payload.split("\n").length - 1, 205);
  writeFileSync(join(cwd, "time-zones.txt"), payload);
  deltaSha256 = createHash("sha256").update(payload).digest("hex");
}
if (["changed","length"].includes(scenario)) writeFileSync(join(cwd, "target.cjs"), "// Returns the constant for every input.\n" + initial);
if (scenario === "long-file") {
  const next = initial.replace("function answer() {","function answer() { // constant value").replace("// fixture row 995\n","// revised final row\n// end of fixture\n");
  assert.equal(initial.trimEnd().split("\n").length,1000);
  assert.equal(next.trimEnd().split("\n").length,1001);
  writeFileSync(join(cwd,"target.cjs"),next);
}
if (scenario === "branches") writeFileSync(join(cwd, "target.cjs"), [
  "function addFirst(delta) { if (delta === 10) return 1; return 0; }",
  "function addSecond(value) { if (value === 20) return 2; return 0; }",
  "function addThird(score) { if (score === 30) return 3; return 0; }",
  "function answer(x) { return 42 + addFirst(x) + addSecond(x) + addThird(x); }", "module.exports = answer;", ""].join("\n"));
const request = authored ? [
  "Create one new disabled local MyBuddy skill in this disposable user profile to triage regional rollout zone IDs against an approved list, preserve source row IDs, and refer unrecognized IDs to launch steward Asha.",
  "Allowed directories: " + cwd + " and " + config + ". The built-in workflow has no external files to find. Use pstack_workflow skill/status if needed. Only read within these paths. The only authorized shell command is exactly node catalog.cjs; it runs in the current task working directory already.",
  'Before authoring, call pstack_workflow with {"action":"start","skill":"principle-prove-it-works"}. This selects the single principle used in this acceptance exercise. Use the registered skill_authoring_create (force_create is authorized). Keep the skill disabled. The tool chooses its own safe installed package path.',
  "After installation run the supplied local fixture exactly once with `node catalog.cjs`. It fills the newly installed markdown with the approved IANA catalog and prints the physical line count. Do not change project files. Read the installed version. Call pstack_workflow's `review` status action, satisfy any host gate, and complete this task.",
].join("\n") : [
  "Read the real target.cjs and describe its exported function in one sentence. This is a local read-only task. No remote writes, uploads or publication.",
  "Read ./target.cjs with the native read tool. Stay in this workspace. There are no other project directories. Leave all files unchanged, including decision logs and settings.",
  scenario === "merge" ? "This is the pre-merge check for the pending change. Do not perform the merge." :
  scenario === "negated" ? "Do not run a code review and do not merge anything. 这次无需审查，也不要合并。" :
  ["request","criteria","workers"].includes(scenario) ? "请对 target.cjs 进行独立代码审查。" : "",
  "Use the built-in pstack workflow. For this small task choose the single principle \`principle-prove-it-works\`, with \`baseRef: HEAD\` at start. Call its \`review\` status action to inspect the host decision, satisfy the host's gates, and finish. Leave all files unchanged.",
].filter(Boolean).join("\n");
const modelRuntime = await ModelRuntime.create({ authPath: join(initialProfile,"auth.json"), modelsPath: join(initialProfile,"models.json"), refreshOnCreate:false, allowModelNetwork:false });
limitLiveRequests(modelRuntime,tmpdir());
const agent = new AgentService(appDb, ws, { models: modelRuntime });
if(authored) restrictAuthoredFixture(agent,cwd,config);
const source = policyPath && { report: resolve(desktopReport), policy: policyPath, sha256: createHash("sha256").update(readFileSync(policyPath)).digest("hex"),
  savedChangedLines: desktopPolicy.thermos.changedLines, appliedChangedLines: policy.changedLines, deltaSha256 };
const setup = { scenario, arm, defaultModelId, modelId, cwd, scratch, request, source, settings: { ...policy, workers: workerConfig.count }, started: new Date().toISOString() };
save(join(output, "run.json"), setup);
let error = "", timeout = false;
const watchdog = setTimeout(()=>{timeout = true; void agent.abort(taskId);}, (authored?12:6) * 60_000);
try {
  await agent.init();
  const coding = agent.getModeProfile("coding").policy;
  agent.saveModePolicy("coding", { ...coding, pstackThermosEnabled:true, pstackThermos:settings });
  const selected = { welcomeMode:"coding" as const };
  appDb.upsertTask({ id:taskId,title:"Check target",cwd,modelId,...selected,updatedAt:Date.now() });
  await agent.prompt({ taskId, modelId,...selected,text: request,userMessageId:"input",assistantMessageId:"answer" }, { durableAdmissionOnly:false });
} catch (e) { error = String(e); }
finally { clearTimeout(watchdog); await agent.closeDurableBots(); agent.dispose(); appDb.close(); }
const store = await openDurablePassiveStorage(join(config,"durable",createHash("sha256").update(taskId).digest("hex")),ctx);
const rows: { chat: number; entry: number; role: string; model?: string; tool?: string; providerError?: string; failed?: boolean; calls: { name: string; args: unknown }[]; text: string }[] = [];
let run: import("../src/main/agent/pstack/PstackState").WorkflowRun | undefined;
if (store) try {
  for (const chat of (await store.scanConversations({},200,undefined,ctx)).items) {
    const doc = await store.findDocument({kind:"mybuddy.pstack-run",scope:{kind:"conversation",conversationId:chat.id}},"current",ctx);
    const stored = doc && await store.document(doc.id,"current",ctx);
    if (stored?.value?.run) run = stored.value.run as unknown as typeof run;
    let cursor;
    do {
      const page = await store.scanEntries({ conversationId:chat.id, order:"ascending" },100,cursor,ctx);
      for (const entry of page.items) for (const m of entry.model ?? []) if (m.role === "assistant" || m.role === "toolResult") rows.push({
        chat:chat.id,entry:entry.id,role:m.role, model:m.role==="assistant"?m.model:undefined, tool:m.role==="toolResult"?m.toolName:undefined,
        failed:m.role==="toolResult"&&m.isError, providerError:m.role==="assistant"?m.errorMessage:undefined,
        calls:m.content.flatMap(p=>p.type==="toolCall"?[{name:p.name,args:p.arguments}]:[]),
        text:m.content.flatMap(p=>p.type==="text"?[p.text]:[]).join("\n").slice(0,16000) });
      cursor=page.next;
    } while(cursor);
  }
} finally { await store.close(ctx); }
const decisions=rows.filter(row=>row.tool==="pstack_workflow"&&!row.failed).flatMap(row=>{try{const value=JSON.parse(row.text);return Array.isArray(value.reasons)?[value]:[]}catch{return []}});
const expectedReview=scenario!=="negated" && (enabled || scenario==="criteria" || scenario==="workers");
const result={ ...setup,end:new Date().toISOString(),error,timeout,phase:run?.phase,expectedReview,decisions,
  review:run?.review, rows };
save(join(output,"evidence.json"),result);
assert.equal(error,"");assert.equal(timeout,false);
assert(decisions.length,"Missing actual status decision");
assert.equal(decisions.some(row=>row.reasons.length>0),expectedReview);
const trigger = { merge: "pre-merge review", changed: "changed lines exceed 0", length: "file crossed 4 lines",
  branches: "possible new special cases: 3", "long-file":"file crossed 1000 lines", "ui-threshold": "changed lines exceed 200", authored:"changed lines exceed 200" }[scenario as "merge"|"changed"|"length"|"long-file"|"branches"|"ui-threshold"|"authored"] ?? "user requested review";
assert(decisions.some(row=>JSON.stringify(row.reasons)===JSON.stringify(expectedReview?[trigger]:[])));
assert.equal(!!run?.review,expectedReview);
if(expectedReview) {
  assert.equal(run!.review!.error,undefined);
  assert.equal(run!.review!.receipt.children.length,workerConfig.count);
  assert.equal(new Set(run!.review!.receipt.children).size,workerConfig.count);
  if (ui) assert(new Set(run!.review!.receipt.models).size >= 2);
  else assert.deepEqual([...new Set(run!.review!.receipt.models)], [modelId]);
  const rubric=Object.keys(policy.criteria).filter(id=>policy.criteria[id]);
  assert(decisions.some(row=>row.criteria.map((c:{id:string})=>c.id).sort().join()===rubric.sort().join()));
  assert(run!.review!.receipt.answers.every(a=>rubric.every(id=>a.includes('"'+id+'"'))));
  assert(run!.review!.inspections?.every(r=>r.observations.some(o=>o.tool==="read" && (o.path==="target.cjs" || (ui && o.path==="time-zones.txt") || (authored && o.path.endsWith("SKILL.md"))))));
  assert(run!.review!.passed ? run!.phase==="complete" : run!.phase==="blocked","Incorrect closure for the independent verdict");
} else assert.equal(run?.phase,"complete");
if (ui) assert(decisions.some(row => row.changedLines === 205 && row.paths.includes("time-zones.txt")));
if (scenario === "long-file") assert(decisions.some(row => row.changedLines === 5 && row.paths.includes("target.cjs")));
if (authored) {
  const final = decisions.findLast(row=>row.changedLines===(enabled?201:200));
  assert(final && final.paths.length===1 && final.authoredSkills.length===1);
  const doc=final.authoredSkills[0];
  assert.equal(doc.file,final.paths[0]); assert.equal(doc.sha256,createHash("sha256").update(readFileSync(doc.file)).digest("hex"));
  assert(doc.file.startsWith(join(config,"plugins","skills")) && doc.file.endsWith("SKILL.md")); assert.equal(git("status","--porcelain").toString(),"");
}
console.log(scenario,arm,"PASS",rows.length,"entries",run?.phase);
