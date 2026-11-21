import type Database from "better-sqlite3";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HookDraft } from "../../../shared/native-hooks";
import type { ImprovementAssetKind, ImprovementOutcome, ImprovementPackage, ImprovementScope, ImprovementVersionEvidence, ImprovementWeeklyMetrics, ObservationSource } from "../../../shared/native-improvement";
import { parseDeliveryContract, verifyDeliveryContract, type DeliveryContract } from "./DeliveryContract";
import { deliveryTool, executeDeliveryTool } from "./DeliveryTool";
import { fingerprint } from "./ImprovementDecisions";
import type { ImprovementKnowledge, ImprovementKnowledgeTask, PreparedImprovementKnowledge } from "./ImprovementKnowledge";
import type { NativeHookStore } from "./NativeHookStore";

export interface ReleaseDraft {
  id:string; week:string; scope:ImprovementScope; source:ObservationSource; contract:DeliveryContract;
  knowledge:PreparedImprovementKnowledge[]; convention:string; tool:typeof deliveryTool; hook:HookDraft;
}
export interface ImprovementUse {
  task:string; conversation:string; actor:"main"|"subagent"; run:string; kind:ImprovementAssetKind;
  event:string; generation?:number|string; detail?:string; at?:number;
}
type Replay = {name:string;expected:unknown;observed:unknown;passed:boolean};
type VersionRow = {id:string;revision:number;generation:number;enabled:number;previous:number|null;hash:string;draft:string};
const catalogJoin = " FROM improvement_heads h JOIN improvement_versions v ON v.id=h.id JOIN improvement_staged s ON s.hash=v.hash ";
const columns = "SELECT v.id,v.revision,h.generation,(h.enabled AND v.retired=0) enabled,v.previous,v.hash,s.draft ";
const reminder = "交付检查还缺少：";
const unknown = "交付检查无法核实本轮产物。请检查文件和本轮生成凭据。";
function assets(d:ReleaseDraft): ImprovementPackage["assets"] {
  return [{kind:"hook",hash:fingerprint(d.hook)}, {kind:"tool",hash:fingerprint(d.tool)}, {kind:"convention",hash:fingerprint(d.convention)},
    ...d.knowledge.map(a=>({kind:a.kind,hash:a.version}))];
}
function decode(row:VersionRow) {
  const draft = JSON.parse(row.draft) as ReleaseDraft;
  if (fingerprint(draft)!==row.hash) throw new Error("改进版本校验失败");
  const release:ImprovementPackage = {id:row.id,revision:row.revision,generation:row.generation,enabled:Boolean(row.enabled),
    previous:row.previous,hash:row.hash,week:draft.week,scope:draft.scope,source:draft.source,assets:assets(draft)};
  return {draft,release};
}
function sourceTask(d:ReleaseDraft): ImprovementKnowledgeTask {
  return {taskId:d.source.taskId, projectId:d.scope.kind==="project"?d.scope.id:undefined,
    workspaceId:d.scope.kind==="workspace"?d.scope.id:undefined,canUseSkill:()=>true};
}
export class ImprovementPackages {
  constructor(private readonly db:Database.Database,private readonly hooks:NativeHookStore,private readonly now:()=>number,
    readonly knowledge:()=>ImprovementKnowledge|undefined,
    private readonly original:(d:ReleaseDraft,directory:string)=>Promise<Awaited<ReturnType<typeof verifyDeliveryContract>> & {expectedEvidence:Record<string,string>}>) {
    db.exec([
      "CREATE TABLE IF NOT EXISTS improvement_staged(hash TEXT PRIMARY KEY,draft TEXT NOT NULL,replays TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS improvement_versions(id TEXT,revision INTEGER,hash TEXT,previous INTEGER,at INTEGER,retired INTEGER DEFAULT 0,PRIMARY KEY(id,revision),UNIQUE(id,hash))",
      "CREATE TABLE IF NOT EXISTS improvement_heads(id TEXT PRIMARY KEY,revision INTEGER,generation INTEGER,enabled INTEGER,scopeKind TEXT,scopeId TEXT)",
      "CREATE INDEX IF NOT EXISTS improvement_scope ON improvement_heads(scopeKind,scopeId,enabled)",
      "CREATE TABLE IF NOT EXISTS improvement_switches(id TEXT,generation INTEGER,revision INTEGER,at INTEGER,enabled INTEGER,PRIMARY KEY(id,generation))",
      "CREATE TABLE IF NOT EXISTS improvement_uses(id TEXT,revision INTEGER,task TEXT,conversation TEXT,actor TEXT,run TEXT,kind TEXT,event TEXT,generation TEXT,detail TEXT,at INTEGER,PRIMARY KEY(id,revision,task,conversation,run,kind,event,generation))",
      "CREATE INDEX IF NOT EXISTS improvement_use_run ON improvement_uses(task,conversation,run)",
      "CREATE TABLE IF NOT EXISTS improvement_dirty_weeks(week TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS improvement_regressions(id TEXT,hash TEXT,input TEXT,revision INTEGER,PRIMARY KEY(id,hash))",
      "CREATE TABLE IF NOT EXISTS improvement_results(week TEXT,id TEXT,revision INTEGER,result TEXT,PRIMARY KEY(week,id,revision))",
    ].join(";"));
  }
  async createDraft(id:string,scope:ImprovementScope,source:ObservationSource,contract:DeliveryContract,week:string):Promise<ReleaseDraft> {
    const knowledge = this.knowledge();
    if (!knowledge) throw new Error("缺少本机记忆服务");
    return {id,scope,source,contract,week,knowledge:await knowledge.prepareDelivery(scope,source),tool:structuredClone(deliveryTool),
      convention:"本轮用户明确要求 Markdown 章节或附件时，按本轮要求检查实际文件。用户调整或取消交付要求时随之更新。",
      hook:{title:"结束前核对明确的交付要求",event:"beforeFinish",actor:"all",tool:"",scope,
        script:'return event.status === "passed" ? true : event.status === "missing" ? '+JSON.stringify(reminder)+' + event.missing.join("、") : '+JSON.stringify(unknown)+';',
        cases:[{input:{status:"passed",missing:[]},expected:true},{input:{status:"missing",missing:["附件"]},expected:reminder+"附件"},
          {input:{status:"unknown",missing:[]},expected:unknown}]}};
  }
  private async validate(d:ReleaseDraft):Promise<Replay[]> {
    const knowledge = this.knowledge(), t = sourceTask(d);
    if (!knowledge || !d.id || fingerprint(d.tool)!==fingerprint(deliveryTool) || !d.convention.trim() || d.convention.length>2000 ||
      d.hook.event!=="beforeFinish" || d.hook.actor!=="all" || d.hook.tool || fingerprint(d.hook.scope)!==fingerprint(d.scope) ||
      d.knowledge.length!==2 || new Set(d.knowledge.map(a=>a.kind)).size!==2 ||
      !d.knowledge.some(a=>a.kind==="skill") || !d.knowledge.some(a=>a.kind==="memory") ||
      d.knowledge.some(a=>fingerprint(a.scope)!==fingerprint(d.scope)) ||
      !(await Promise.all(d.knowledge.map(a=>knowledge.resolve(a,t)))).every(Boolean)) throw new Error("五项资产或依赖的来源不完整");
    if (d.hook.script.length>16000 || d.hook.cases.length>12) throw new Error("检查脚本超过范围");
    const cases:Replay[]=[];
    // The oracle lives in the host. A candidate cannot choose its acceptance cases.
    const observe=(name:string,expected:unknown,observed:unknown) => {
      const passed=fingerprint(expected)===fingerprint(observed);
      cases.push({name,expected,observed,passed});
      if (!passed) throw new Error("独立回放未通过："+name);
    };
    const controls=[...d.hook.cases,{input:{status:"unknown",missing:[]},expected:unknown}];
    for (const test of controls) observe("检查脚本",test.expected,await this.hooks.check(d.hook,test.input));
    const past=this.db.prepare("SELECT input FROM improvement_regressions WHERE id=? ORDER BY rowid").pluck().all(d.id) as string[];
    for(const raw of past){
      const input=JSON.parse(raw) as Awaited<ReturnType<typeof verifyDeliveryContract>>;
      const expected=input.status==="passed"?true:input.status==="missing"?reminder+input.missing.join("、"):unknown;
      observe("已撤回版本的失败输入",expected,await this.hooks.check(d.hook,input));
    }
    const root=await mkdtemp(join(tmpdir(),"mybuddy-delivery-"));
    try {
      for (const [i,c] of [d.contract,{document:"variant.md",headings:["Results"],attachments:["support.csv"]}].entries()) {
        if (!/\.md$/i.test(c.document) || !c.headings.length&&!c.attachments.length || c.headings.length+c.attachments.length>50 ||
          [c.document,...c.attachments].some(p=>!p || p.length>220 || p.split(/[\\/]/).some(s=>!s || s==="." || s==="..") || /[:\0]/.test(p))) throw new Error("超出本地交付契约的验证范围");
        const cwd=join(root,String(i)); await mkdir(cwd);
        if(i===0) {
          const history=join(root,"historical");await mkdir(history);
          const actual=await this.original(d,history);
          observe("原始保存版本与用户指出的缺项",reminder+actual.missing.join("、"),await this.hooks.check(d.hook,actual));
          observe("原始交付物指纹",actual.expectedEvidence,actual.evidence);
        }
        const write=async (file:string,value:string)=>{const path=join(cwd,file);await mkdir(dirname(path),{recursive:true});await writeFile(path,value);};
        await write(c.document,"# Draft\n");
        const bad=await executeDeliveryTool(d.tool,cwd,c);
        const missing=[...c.headings.map(h=>h==="\0citations"?"引用来源":"标题: "+h),...c.attachments];
        observe(i?"变体漏项":"原契约漏项",missing,bad.missing);
        observe("反馈具体缺项",reminder+missing.join("、"),await this.hooks.check(d.hook,bad));
        await write(c.document,c.headings.map(h=>h==="\0citations"?"[证据](https://example.org/source)":"## "+h).join("\n")+"\n");
        for (const p of c.attachments) await write(p,"sample\n");
        const fixed=await executeDeliveryTool(d.tool,cwd,c);
        observe("修复后独立读回","passed",fixed.status);
        observe("完整交付放行",true,await this.hooks.check(d.hook,fixed));
      }
      observe("无关请求不触发",false,Boolean(parseDeliveryContract("请解释这份文档的含义。")));
      observe("用户取消要求不触发",false,Boolean(parseDeliveryContract("不要生成 report.md 或提供附件。")));
      return cases;
    } finally {await rm(root,{recursive:true,force:true});}
  }
  async stage(input:ReleaseDraft):Promise<string> {
    const d=structuredClone(input), hash=fingerprint(d), replays=await this.validate(d);
    this.db.prepare("INSERT OR IGNORE INTO improvement_staged VALUES(?,?,?)").run(hash,JSON.stringify(d),JSON.stringify(replays));
    return hash;
  }
  activate(hash:string,expectedGeneration:number):ImprovementPackage {
    return this.db.transaction(()=>{
      const raw=this.db.prepare("SELECT draft FROM improvement_staged WHERE hash=?").pluck().get(hash);
      if(typeof raw!=="string") throw new Error("没有已验证的暂存版本");
      const d=JSON.parse(raw) as ReleaseDraft,k=this.knowledge();
      if(hash!==fingerprint(d) || !k || !d.knowledge.every(a=>k.isCurrent(a,sourceTask(d)))) throw new Error("发布依赖已改变");
      const head=this.db.prepare("SELECT revision,generation FROM improvement_heads WHERE id=?").get(d.id) as {revision:number;generation:number}|undefined;
      if((head?.generation??0)!==expectedGeneration) throw new Error("基础版本已变化，请重新验证");
      const existing=this.db.prepare("SELECT revision,retired FROM improvement_versions WHERE id=? AND hash=?").get(d.id,hash) as {revision:number;retired:number}|undefined;
      if(existing && (!head || existing.retired || existing.revision!==head.revision)) throw new Error("该改进版本已撤回");
      if(!existing){
        const revision=1+Number(this.db.prepare("SELECT max(revision) FROM improvement_versions WHERE id=?").pluck().get(d.id));
        this.db.prepare("INSERT INTO improvement_versions(id,revision,hash,previous,at) VALUES(?,?,?,?,?)").run(d.id,revision,hash,head?.revision??null,this.now());
        this.db.prepare("INSERT INTO improvement_heads VALUES(?,?,?,1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,generation=excluded.generation,enabled=1,scopeKind=excluded.scopeKind,scopeId=excluded.scopeId")
          .run(d.id,revision,expectedGeneration+1,d.scope.kind,d.scope.id);
        this.db.prepare("INSERT INTO improvement_switches VALUES(?,?,?,?,1)").run(d.id,expectedGeneration+1,revision,this.now());
      }
      return this.current(d.id)!.release;
    }).immediate();
  }
  async publish(d:ReleaseDraft,expectedGeneration:number) {return this.activate(await this.stage(d),expectedGeneration);}
  current(id:string) {
    const r=this.db.prepare(columns+catalogJoin+"WHERE h.id=? AND h.revision=v.revision").get(id) as VersionRow|undefined;
    return r&&decode(r);
  }
  draft(id:string) {return this.current(id)?.draft;}
  version(id:string,revision:number) {
    const r=this.db.prepare(columns+catalogJoin+"WHERE v.id=? AND v.revision=?").get(id,revision) as VersionRow|undefined;
    return r&&decode(r);
  }
  list() {return (this.db.prepare(columns+catalogJoin+"WHERE v.revision=h.revision ORDER BY v.at DESC").all() as VersionRow[]).map(r=>decode(r).release);}
  select(task:{taskId:string;projectId?:string|null;workspaceId?:string|null}) {
    const r=this.db.prepare(columns+catalogJoin+"WHERE v.revision=h.revision AND h.enabled=1 AND ((scopeKind='task' AND scopeId=?) OR (scopeKind='project' AND scopeId=?) OR (scopeKind='workspace' AND scopeId=?)) ORDER BY CASE scopeKind WHEN 'task' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,v.at DESC LIMIT 1")
      .get(task.taskId,task.projectId??null,task.workspaceId??null) as VersionRow|undefined;
    return r&&decode(r);
  }
  revert(id:string,generation:number) {
    return this.db.transaction(()=>{
      const r=this.current(id)?.release;
      if(!r?.enabled || r.generation!==generation) throw new Error("基础版本已变化，请刷新");
      this.db.prepare("UPDATE improvement_versions SET retired=1 WHERE id=? AND revision=?").run(id,r.revision);
      const candidates=this.db.prepare("SELECT revision FROM improvement_versions WHERE id=? AND revision<? AND retired=0 ORDER BY revision DESC").pluck().all(id,r.revision) as number[];
      const previous=candidates.find(n=>{
        const draft=this.version(id,n)?.draft,k=this.knowledge();
        return draft && k && draft.knowledge.every(a=>k.isCurrent(a,sourceTask(draft)));
      });
      this.db.prepare("UPDATE improvement_heads SET revision=?,enabled=?,generation=generation+1 WHERE id=?").run(previous??r.revision,Number(previous!==undefined),id);
      this.db.prepare("INSERT INTO improvement_switches VALUES(?,?,?,?,?)").run(id,generation+1,previous??r.revision,this.now(),Number(previous!==undefined));
      return this.current(id)!.release;
    }).immediate();
  }
  disable(id:string,generation:number) {
    this.db.transaction(()=>{
      const r=this.current(id)?.release;
      if(!r?.enabled || r.generation!==generation) throw new Error("基础版本已变化，请刷新");
      this.db.prepare("UPDATE improvement_heads SET enabled=0,generation=generation+1 WHERE id=?").run(id);
      this.db.prepare("INSERT INTO improvement_switches VALUES(?,?,?,?,0)").run(id,generation+1,r.revision,this.now());
    }).immediate();
  }
  regression(id:string,revision:number,input:Awaited<ReturnType<typeof verifyDeliveryContract>>,usage:ImprovementUse) {
    this.db.transaction(()=>{
      this.db.prepare("INSERT OR IGNORE INTO improvement_regressions VALUES(?,?,?,?)").run(id,fingerprint(input),JSON.stringify(input),revision);
      this.record(id,revision,usage);
    }).immediate();
  }
  async runHook(d:ReleaseDraft,fields:Record<string,unknown>) {
    const result=await this.hooks.check(d.hook,fields);return result===true?"":result;
  }
  record(id:string,revision:number,u:ImprovementUse) {
    const added=this.db.prepare("INSERT OR IGNORE INTO improvement_uses VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(id,revision,u.task,u.conversation,u.actor,String(u.run),u.kind,u.event,String(u.generation??""),u.detail?.slice(0,1500)??"",u.at??this.now());
    if(added.changes && ["accepted","correction","error","falseTrigger"].includes(u.event)){
      // A result arriving late belongs to the original input's cohort.
      this.db.prepare("INSERT OR IGNORE INTO improvement_dirty_weeks SELECT r.week FROM improvement_results r WHERE r.id=? AND r.revision=? AND EXISTS (SELECT 1 FROM improvement_uses WHERE id=r.id AND revision=r.revision AND task=? AND conversation=? AND run=? GROUP BY task HAVING min(at)>=unixepoch(r.week,'-7 days')*1000 AND min(at)<unixepoch(r.week)*1000)").run(id,revision,u.task,u.conversation,String(u.run));
    }
    if(u.event==="error" || u.event==="falseTrigger"){
      const r=this.current(id)?.release;
      if(r?.enabled && r.revision===revision) this.revert(id,r.generation);
    }
  }
  uses(id:string,revision:number) {
    return this.db.prepare("SELECT * FROM improvement_uses WHERE id=? AND revision=? ORDER BY at,rowid").all(id,revision) as ImprovementUse[];
  }
  correction(s:ObservationSource) {
    const used=this.db.prepare("SELECT DISTINCT id,revision FROM improvement_uses WHERE task=? AND conversation=? AND run=?").all(s.taskId,s.conversationId,String(s.input)) as {id:string;revision:number}[];
    for(const r of used) this.record(r.id,r.revision,{task:s.taskId,conversation:s.conversationId,actor:s.actor,run:String(s.input),kind:"hook",event:"correction",at:s.at,generation:s.entry});
  }
  sourceUses(source:ObservationSource) {
    return this.db.prepare("SELECT id,revision,kind,event,generation FROM improvement_uses WHERE task=? AND conversation=? AND run=? ORDER BY at,rowid LIMIT 80").all(source.taskId,source.conversationId,String(source.input));
  }
  replays(week:string) {
    return (this.db.prepare("SELECT v.id,v.revision,v.hash,s.draft,s.replays FROM improvement_versions v JOIN improvement_staged s ON s.hash=v.hash WHERE json_extract(s.draft,'$.week')=?").all(week) as {id:string;revision:number;hash:string;draft:string;replays:string}[]).map(r=>({packageId:r.id,revision:r.revision,hash:r.hash,source:(JSON.parse(r.draft) as ReleaseDraft).source,cases:JSON.parse(r.replays) as Replay[]}));
  }
  versionEvidence():ImprovementVersionEvidence[] {
    const versions=this.db.prepare("SELECT v.id,v.revision,v.previous,v.retired,v.hash,(h.revision=v.revision AND h.enabled) active,s.draft,s.replays FROM improvement_versions v JOIN improvement_heads h ON h.id=v.id JOIN improvement_staged s ON s.hash=v.hash ORDER BY v.at DESC,v.revision DESC")
      .all() as {id:string;revision:number;previous:number|null;retired:number;hash:string;active:number;draft:string;replays:string}[];
    const receipts=this.db.prepare("SELECT task,conversation,actor,run,kind,event,at FROM improvement_uses WHERE id=? AND revision=? ORDER BY at DESC,rowid DESC LIMIT 32");
    const count=this.db.prepare("SELECT count(*) FROM improvement_uses WHERE id=? AND revision=?");
    return versions.map(v=>{const draft=JSON.parse(v.draft) as ReleaseDraft;
      return {packageId:v.id,revision:v.revision,previous:v.previous,active:Boolean(v.active),retired:Boolean(v.retired),week:draft.week,
      source:draft.source,hash:v.hash,scope:draft.scope,assets:assets(draft),
      cases:(JSON.parse(v.replays) as Replay[]).map(r=>({name:r.name,passed:r.passed})),
      useCount:Number(count.pluck().get(v.id,v.revision)),uses:receipts.all(v.id,v.revision) as ImprovementVersionEvidence["uses"]};});
  }
  followup(week:string,now=this.now()) {
    const versions=this.db.prepare("SELECT v.id,v.revision,v.at,s.draft FROM improvement_versions v JOIN improvement_staged s ON s.hash=v.hash WHERE json_extract(s.draft,'$.week')<?").all(week) as {id:string;revision:number;at:number;draft:string}[];
    for(const v of versions){
      const start=Date.parse(week+"T00:00:00Z")-7*86400000;
      // Group by the original opportunity, including its later terminal answer and corrections.
      const rows=this.db.prepare("SELECT max(event='accepted') accepted,max(event='correction') corrected,max(event IN ('error','falseTrigger')) error,max(kind='tool' AND event='executed') tool,max(kind='hook' AND event IN ('passed','feedback','unknown','error','falseTrigger')) hook,max(kind='convention' AND event='applied') convention,max(kind='memory' AND event='recalled') memory,max(kind='skill' AND event='read') skill FROM improvement_uses WHERE id=? AND revision=? AND at<=? GROUP BY task,conversation,run HAVING min(at)>=? AND min(at)<?")
        .all(v.id,v.revision,now,Math.max(start,v.at),start+7*86400000) as (Record<ImprovementAssetKind,number>&{accepted:number;corrected:number;error:number})[];
      const accepted=rows.filter(r=>r.accepted&&!r.corrected&&!r.error).length, corrections=rows.filter(r=>r.corrected).length, errors=rows.filter(r=>r.error).length;
      const scope=(JSON.parse(v.draft) as ReleaseDraft).scope;
      const missed=Number(this.db.prepare("SELECT count(*) FROM improvement_inputs i LEFT JOIN improvement_input_scopes t USING(task,conversation,entry) WHERE i.eligible=1 AND i.at>=@start AND i.at<@end AND ((@kind='task' AND i.task=@scope) OR (@kind='project' AND t.project=@scope) OR (@kind='workspace' AND t.workspace=@scope)) AND @revision=(SELECT CASE WHEN x.enabled THEN x.revision END FROM improvement_switches x WHERE x.id=@id AND x.at<=i.at ORDER BY x.generation DESC LIMIT 1) AND NOT EXISTS (SELECT 1 FROM improvement_uses u WHERE u.task=i.task AND u.conversation=i.conversation AND u.run=CAST(i.entry AS TEXT))")
        .pluck().get({start,end:Math.min(start+7*86400000,now+1),kind:scope.kind,scope:scope.id,revision:v.revision,id:v.id}));
      const opportunities=rows.length+missed;
      const state=errors?"regressed":corrections?"ineffective":accepted?"effective":"pending";
      const byAsset=assets(JSON.parse(v.draft) as ReleaseDraft).map(({kind})=>{
        const used=rows.filter(r=>r[kind]),bad=used.filter(r=>r.error).length,again=used.filter(r=>r.corrected).length,ok=used.filter(r=>r.accepted&&!r.corrected&&!r.error).length;
        const verdict:ImprovementOutcome["state"]=bad?"regressed":again?"ineffective":ok?"effective":"pending";
        return {kind,state:verdict,opportunities,used:used.length,accepted:ok,corrections:again,errors:bad};
      });
      const result:ImprovementOutcome={week,packageId:v.id,revision:v.revision,state,accepted,opportunities,corrections,errors,assets:byAsset};
      const changed=this.db.prepare("INSERT INTO improvement_results VALUES(?,?,?,?) ON CONFLICT(week,id,revision) DO UPDATE SET result=excluded.result WHERE result<>excluded.result").run(week,v.id,v.revision,JSON.stringify(result));
      if(changed.changes)this.db.prepare("INSERT OR IGNORE INTO improvement_dirty_weeks VALUES(?)").run(week);
    }
    return this.outcomes();
  }
  outcomes():ImprovementOutcome[] {return (this.db.prepare("SELECT result FROM improvement_results ORDER BY week DESC,id,revision DESC").pluck().all() as string[]).map(s=>JSON.parse(s));}
  metrics(week:string):ImprovementWeeklyMetrics {
    const start=Date.parse(week+"T00:00:00Z");
    const rows=this.db.prepare(`SELECT max(event='accepted') accepted,max(event='correction') corrected,
      max(event IN ('error','falseTrigger')) error,max(event='falseTrigger') falseTrigger,max(event='executed') used,
      max(kind='tool' AND event IN ('passed','missing')) checked
      FROM improvement_uses GROUP BY task,conversation,run HAVING min(at)>=? AND min(at)<?`)
      .all(start,start+7*86400000) as {accepted:number;corrected:number;error:number;falseTrigger:number;used:number;checked:number}[];
    return {week,opportunities:rows.length,accepted:rows.filter(r=>r.accepted).length,corrections:rows.filter(r=>r.corrected).length,
      unassisted:rows.filter(r=>r.accepted&&!r.corrected&&!r.error).length,recurrences:rows.filter(r=>r.corrected).length,
      exposed:rows.length,used:rows.filter(r=>r.used).length,errors:rows.filter(r=>r.error).length,
      falseTriggers:rows.some(r=>r.checked||r.falseTrigger)?rows.filter(r=>r.falseTrigger).length:null,
      durationMs:0,modelRequests:0,toolCalls:0,userInputs:0};
  }
}
