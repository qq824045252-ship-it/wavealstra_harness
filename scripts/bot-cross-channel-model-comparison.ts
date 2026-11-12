import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

/** A measured experiment, not a gate that assumes treatment improves the outcome. */
export async function runMethodComparison({agent,db,works,workspace,out,variant,stage,wait,pendingRequest,report}: any) {
  const original=JSON.parse(readFileSync(resolve("out/diagnostics/bot-cross-channel/model-live/2026-11-12T07-23-06-850Z/report.json"),"utf8"));
  const botId=original.bots.b.botId;
  const enabled=original.stages.find((item:any)=>item.name==="reviewed-method-enabled").evidence;
  const skillId=enabled.approved.installedSkillId;
  const candidate=db.connection.prepare("SELECT * FROM memory_skill_candidates WHERE id=?").get(enabled.candidate.id);
  assert(candidate); assert.equal(candidate.status,"materialized");
  assert(!existsSync(join(workspace,"verification.txt"))); assert(!existsSync(join(workspace,"second.txt")));
  writeFileSync(join(workspace,"final.txt"),"FINAL_BETA");
  const before=await agent.getBotSettings(botId);
  const {revision,spaceId,effectiveWorkspacePath,...values}=before.settings;
  // Retain the exact selected package; only its global enabled switch differs.
  const saved=await agent.saveBotSettings({...values,workspacePath:workspace,expectedRevision:revision});
  assert(saved.ok,JSON.stringify(saved));
  agent.setSkillEnabled(skillId,variant==="treatment");
  const allMemories=db.connection.prepare("SELECT r.*,s.scope_type,s.scope_id FROM memory_records r JOIN memory_scopes s ON s.memory_id=r.id").all();
  const visibleInitial=allMemories.filter((row:any)=>row.scope_type==="global"||row.scope_type==="bot"&&row.scope_id===botId);
  const baseline={botId,variant,skillId,candidate,instructionsSha256:createHash("sha256").update(candidate.instructions).digest("hex"),
    settingsBefore:before,settingsAfter:await agent.getBotSettings(botId),visibleInitial,allMemoryScopes:allMemories,
    seed:{name:"final.txt",text:"FINAL_BETA",sha256:createHash("sha256").update("FINAL_BETA").digest("hex")},
    contamination:"Both arms independently restore the same closed synthetic profile. Existing B memory and other Skills are retained equally. A is not called. Historic B Work memories remain in their original Work scopes; actual prompts are saved for auditing retrieval."};
  writeFileSync(join(out,"comparison-baseline.json"),JSON.stringify(baseline,null,2));
  stage("comparison-baseline",{botId,variant,skillId,candidateId:candidate.id,instructionsSha256:baseline.instructionsSha256,visibleInitial});
  const oldWorks=new Set(db.connection.prepare("SELECT work_id FROM works").all().map((row:any)=>row.work_id));
  const startedAt=Date.now();
  const text="请创建一个由你负责的单次事项：在当前工作目录生成second.txt，内容逐字为 SECOND_GAMMA，并交付文件。";
  const receipt=await agent.sendBotMessage({botId,requestId:randomUUID(),text});
  stage("comparison-submitted",{text,receipt});
  const work=await wait("comparison personal Work",()=> { const found=db.connection.prepare("SELECT * FROM works WHERE owner_bot_id=? ORDER BY created_at DESC").all(botId).find((row:any)=>!oldWorks.has(row.work_id)); if(found)return found;pendingRequest(receipt,"Personal Work"); });
  await wait("comparison Work closed",()=>works.getWork(work.work_id)?.lifecycle==="closed");
  const file=(name:string)=>existsSync(join(workspace,name))?{text:readFileSync(join(workspace,name),"utf8"),sha256:createHash("sha256").update(readFileSync(join(workspace,name))).digest("hex")}:null;
  const observed={work:works.getWork(work.work_id),files:{final:file("final.txt"),second:file("second.txt"),verification:file("verification.txt")},
    skillReads:db.connection.prepare("SELECT * FROM memory_skill_effectiveness WHERE exposed_at>=?").all(startedAt),
    bindings:db.connection.prepare("SELECT * FROM work_execution_bindings WHERE work_id=?").all(work.work_id),
    businessSucceeded:works.getWork(work.work_id)?.closureConclusion==="succeeded"&&file("second.txt")?.text==="SECOND_GAMMA",
    correctedExtraObserved:file("verification.txt")?.text==="VERIFIED_REUSE"};
  stage("comparison-observed",observed);
  report.status="measured"; report.unverified=["Single pair only; no general causal-effect estimate", "Model nondeterminism remains", "No real channel provider in this personal Work experiment"];
}
