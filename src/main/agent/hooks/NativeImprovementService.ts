import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import type { AppDatabase } from "../../db/AppDatabase";
import type { HookDraft } from "../../../shared/native-hooks";
import type { ChildReviewEvidence, ImprovementChild, ImprovementItem, ImprovementKind, ImprovementReport, ImprovementRun, ObservationSource } from "../../../shared/native-improvement";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import { readImprovementChild } from "./ImprovementChildHistory";
import { cards, fingerprint, improvementDraft } from "./ImprovementDecisions";
import { freshHistory, scanImprovementHistory } from "./ImprovementHistory";
import type { HistoryState, Observation } from "./ImprovementHistory";
import type { NativeHookStore } from "./NativeHookStore";
import { parseReflection, reflectionEvidence, type Reviewer } from "./ImprovementReflection";
import { ReadRecoveryHints, type ReadMapping } from "./ReadRecoveryHints";
import { ImprovementPackages } from "./ImprovementPackages";
import type { ImprovementKnowledge } from "./ImprovementKnowledge";
import type { DeliveryContract } from "./DeliveryContract";
import { writeImprovementWeek } from "./ImprovementWeeklyReport";
import { settleImprovementUses } from "./ImprovementAcceptance";
import { replayOriginalDelivery, UnverifiedOriginalDelivery } from "./ImprovementOriginalReplay";
import { improvementSourceContext } from "./ImprovementSourceContext";
import { rankImprovementCandidate } from "./ImprovementDecisions";

interface Group { key: string; kind: ImprovementKind; scope: string; total: number }
type Managed = { key: string; hook: string; revision: number; installed: number; week: string };
const day = 86400000;
function weekOf(time: number): string {
  const date = new Date(time);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - ((date.getUTCDay() + 6) % 7) * day).toISOString().slice(0, 10);
}
function scoped(source: Observation, task: { projectId?: string | null; spaceId?: string | null }): HookDraft["scope"] {
  if (source.project && source.project === task.projectId) return { kind: "project", id: source.project };
  if (!task.projectId && source.workspace && source.workspace === task.spaceId) return { kind: "workspace", id: source.workspace };
  return { kind: "task", id: source.source.taskId };
}

export class NativeImprovementService {
  private readonly ledger: Database.Database;
  readonly readHints: ReadRecoveryHints;
  readonly packages: ImprovementPackages;
  private readonly output:string;
  private progress = {phase:"idle",done:0,total:0};
  private flight?: Promise<void>;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  constructor(private readonly app: AppDatabase, private readonly hooks: NativeHookStore, path: string, private readonly now = Date.now, private readonly reviewer?: Reviewer,
    readonly knowledge:()=>ImprovementKnowledge|undefined = ()=>undefined, private readonly flushDiagnostics?: () => Promise<void>) {
    this.ledger = new Database(path);
    this.ledger.pragma("journal_mode = WAL");
    this.ledger.exec([
      "CREATE TABLE IF NOT EXISTS checkpoints(task TEXT,conversation TEXT,state TEXT NOT NULL, PRIMARY KEY(task,conversation))",
      "CREATE TABLE IF NOT EXISTS child_evidence(task TEXT,directory TEXT,conversation INTEGER,childId TEXT,immutable INTEGER,summary TEXT NOT NULL, PRIMARY KEY(task,conversation))",
      "CREATE TABLE IF NOT EXISTS child_review_weeks(week TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS release_review_weeks(week TEXT PRIMARY KEY)",
      "CREATE TABLE IF NOT EXISTS improvement_unverified(key TEXT PRIMARY KEY,source TEXT,reason TEXT)",
      "CREATE TABLE IF NOT EXISTS weekly_cost(week TEXT PRIMARY KEY,duration INTEGER DEFAULT 0,requests INTEGER DEFAULT 0)",
      "CREATE TABLE IF NOT EXISTS improvement_inputs(task TEXT,conversation TEXT,entry INTEGER,at INTEGER,eligible INTEGER,actor TEXT,PRIMARY KEY(task,conversation,entry))",
      "CREATE INDEX IF NOT EXISTS improvement_inputs_week ON improvement_inputs(at,eligible)",
      "CREATE TABLE IF NOT EXISTS improvement_input_scopes(task TEXT,conversation TEXT,entry INTEGER,project TEXT,workspace TEXT,PRIMARY KEY(task,conversation,entry))",
      "CREATE TABLE IF NOT EXISTS observations(key TEXT,kind TEXT,scope TEXT,task TEXT,conversation TEXT,entry INTEGER,source TEXT,replay TEXT,generation INTEGER, PRIMARY KEY(task,conversation,entry,kind))",
      "CREATE INDEX IF NOT EXISTS observations_by_key ON observations(key)",
      "CREATE TABLE IF NOT EXISTS managed(key TEXT PRIMARY KEY,hook TEXT,revision INTEGER,installed INTEGER,week TEXT)",
      "CREATE TABLE IF NOT EXISTS slots(key TEXT PRIMARY KEY,week TEXT NOT NULL)",
      "CREATE TABLE IF NOT EXISTS assessments(key TEXT,week TEXT,source TEXT,assessment TEXT,error TEXT,PRIMARY KEY(key,week))",
      "CREATE TABLE IF NOT EXISTS followup(week TEXT,key TEXT,metrics TEXT,PRIMARY KEY(week,key))",
      "CREATE TABLE IF NOT EXISTS cycles(week TEXT PRIMARY KEY,at INTEGER,scanned INTEGER DEFAULT 0,added INTEGER DEFAULT 0,issues TEXT DEFAULT '[]',finished INTEGER DEFAULT 0)",
    ].join(";\n"));
    this.readHints = new ReadRecoveryHints(this.ledger);
    this.packages = new ImprovementPackages(this.ledger,hooks,now,knowledge,(draft,dir)=>replayOriginalDelivery(app,draft,dir));
    this.output=join(dirname(path),"improvement");
  }
  start() {
    if (this.timer || this.stopping) return;
    const due = () => {
      if (!this.timer || this.stopping || this.flight) return;
      const row = this.ledger.prepare("SELECT finished FROM cycles WHERE week=?").get(weekOf(this.now())) as { finished: number } | undefined;
      if (!row?.finished || !this.ledger.prepare("SELECT 1 FROM release_review_weeks WHERE week=?").get(weekOf(this.now()))
        || this.ledger.prepare("SELECT 1 FROM cycles WHERE finished=0 AND week<? LIMIT 1").get(weekOf(this.now())))
        void this.run().catch(e => console.warn("[NativeImprovement]", e));
    };
    this.timer = setInterval(due, 60 * 60 * 1000);
    this.timer.unref();
    setImmediate(due);
  }
  stopSchedule() {
    clearInterval(this.timer);
    this.timer = undefined;
  }
  async close() {
    this.stopping = true;
    this.abort.abort();
    this.stopSchedule();
    await this.flight?.catch(() => undefined);
    if (this.ledger.open) this.ledger.close();
  }
  async review(): Promise<ImprovementReport> { await this.run(); return this.report(); }
  async source(key: string, task: string, conversation: string, entry: number) {
    const src = this.ledger.prepare("SELECT source FROM observations WHERE key=? AND task=? AND conversation=? AND entry=?").pluck().get(key,task,conversation,entry);
    const dir = this.app.connection.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").pluck().get(task);
    if (typeof src !== "string" || typeof dir !== "string") throw new Error("原始来源已不可用");
    return this.evidence(dir,JSON.parse(src));
  }
  async child(task: string, conversation: number): Promise<ChildReviewEvidence> {
    const dir = this.app.connection.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").pluck().get(task);
    if (typeof dir !== "string" || !Number.isSafeInteger(conversation)) throw new Error("找不到这次子代理交接");
    const indexed = this.ledger.prepare("SELECT childId FROM child_evidence WHERE task=? AND directory=? AND conversation=?").pluck().get(task,dir,conversation);
    if (typeof indexed !== "string") throw new Error("找不到这次子代理交接");
    const storage = await openDurablePassiveStorage(dir,ctx);
    if (!storage) throw new Error("无法读取原始会话");
    try {
      const c = await storage.conversation(conversation as ConversationId,ctx);
      const evidence = c && await readImprovementChild(storage,task,c,true);
      if (!evidence || evidence.child.childId !== indexed) throw new Error("子代理原始身份已变化");
      await this.flushDiagnostics?.();
      return { ...evidence, ...this.childContext(task,String(conversation)) };
    } finally { await storage.close(ctx); }
  }
  private childContext(task: string, id: string) {
    const diagnostics = this.app.connection.prepare(`
        WITH requests AS (SELECT record_json AS r FROM task_request_diagnostics WHERE task_id=@task
          AND json_extract(record_json,'$.sourceKind')='subagent' AND json_extract(record_json,'$.executionScope')=@task
          AND json_extract(record_json,'$.conversationId')=@id),
        execution_ids AS (
          SELECT COALESCE(json_extract(r,'$.executionId'),'durable:'||@task||':'||@id||':'||json_extract(r,'$.generationTaskId')) FROM requests
          UNION SELECT json_extract(record_json,'$.executionId') FROM task_tool_diagnostics
            WHERE task_id=@task AND json_extract(record_json,'$.sourceKind')='subagent' AND json_extract(record_json,'$.conversationId')=@id),
        waits AS (SELECT i.* FROM conversation_interactions i WHERE i.task_id=@task AND i.execution_id IN execution_ids)
        SELECT count(*) requests,
          CASE WHEN count(json_extract(r,'$.usage.input'))=count(*) THEN sum(json_extract(r,'$.usage.input')) END inputTokens,
          CASE WHEN count(json_extract(r,'$.usage.output'))=count(*) THEN sum(json_extract(r,'$.usage.output')) END outputTokens,
          CASE WHEN count(json_extract(r,'$.usage.cacheRead'))=count(*) THEN sum(json_extract(r,'$.usage.cacheRead')) END cacheReadTokens,
          (SELECT count(*) FROM waits) waits, (SELECT count(*) FROM waits WHERE status='resolved') answered,
          (SELECT sum(max(0,resolved_at-created_at)) FROM waits WHERE resolved_at IS NOT NULL) waitMs FROM requests`)
        .get({task,id}) as ChildReviewEvidence["diagnostics"];
    return {diagnostics, hooks:this.hooks.childReviewReceipts(task,id)};
  }
  private async evidence(directory: string, source: ObservationSource) {
    const raw = await reflectionEvidence(directory,source);
    if (raw.length) {
      await this.flushDiagnostics?.();
      const context=await improvementSourceContext(this.app.connection,directory,source,this.hooks);
      raw[0]!.content.push({role:"原始决策的诊断、能力和验收凭据",text:JSON.stringify(context)});
      const used=this.packages.sourceUses(source);
      if(used.length)raw[0]!.content.push({role:"本次交付实际获得的改进资产及结果",text:JSON.stringify(used)});
    }
    return raw;
  }
  private run(): Promise<void> {
    if (this.stopping) return Promise.reject(new Error("自我改进服务已关闭"));
    return this.flight ??= this.cycle().finally(() => { this.flight = undefined; this.progress={phase:"idle",done:0,total:0}; });
  }
  private groups(): Group[] {
    const rows=this.ledger.prepare("SELECT key,kind,scope,count(*) total,max(CAST(json_extract(replay,'$.repairMs') AS REAL)) cost FROM observations GROUP BY key HAVING kind<>'sequence' OR count(DISTINCT json_array(task,conversation,json_extract(source,'$.input')))>=2").all() as (Group & {cost:number|null})[];
    const score=(g:typeof rows[number])=>rankImprovementCandidate(g.kind,g.total,JSON.parse(g.scope).kind,g.cost??0);
    return rows.sort((a,b)=>score(b)-score(a)||a.key.localeCompare(b.key));
  }
  private managed(): Managed[] { return this.ledger.prepare("SELECT * FROM managed").all() as Managed[]; }
  private reserve(key: string, week: string): string | undefined {
    return this.ledger.transaction(() => {
      const prior = this.ledger.prepare("SELECT week FROM slots WHERE key=?").pluck().get(key);
      if (typeof prior === "string") return prior;
      if (Number(this.ledger.prepare("SELECT count(*) FROM slots WHERE week=?").pluck().get(week)) >= 5) return;
      this.ledger.prepare("INSERT INTO slots VALUES(?,?)").run(key,week);
      return week;
    }).immediate();
  }

  private async cycle() {
    const now = this.now(), week = weekOf(now);
    const started=Date.now();
    this.progress={phase:"回填上期",done:0,total:0};
    this.packages.followup(week,now);
    this.ledger.prepare("INSERT INTO cycles(week,at) VALUES(?,?) ON CONFLICT(week) DO UPDATE SET at=excluded.at,finished=0").run(week, now);
    const issues: string[] = [];
    for (const m of this.managed()) {
      const h = this.hooks.find(m.hook);
      const metrics = this.hooks.improvementMetrics(m.hook, m.revision);
      if (h) this.ledger.prepare("INSERT OR REPLACE INTO followup VALUES(?,?,?)").run(week,m.key,JSON.stringify({
        title: this.hooks.version(m.hook,m.revision).draft.title, scope: h.draft.scope.kind === "global" ? "全局" : h.draft.scope.id, ...metrics }));
      if (h?.enabled && h.generation === 1 && metrics.errors)
        this.hooks.activate(h.id, h.generation, h.revision, false);
    }
    const paths = this.ledger.prepare("SELECT key,task FROM path_hints").all() as {key:string;task:string}[];
    for (const p of paths) this.ledger.prepare("INSERT OR REPLACE INTO followup VALUES(?,?,?)").run(week,p.key,JSON.stringify({
      title: cards.readPath[0], scope: p.task, ...this.readHints.stats(p.key) }));
    const bindings = this.app.connection.prepare("SELECT task_id,directory FROM durable_bot_bindings ORDER BY task_id").all() as { task_id: string; directory: string }[];
    this.progress={phase:"读取原生会话和子代理",done:0,total:bindings.length};
    const insert = this.ledger.prepare("INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?,?,?)");
    const save = this.ledger.prepare("INSERT INTO checkpoints VALUES(?,?,?) ON CONFLICT(task,conversation) DO UPDATE SET state=excluded.state");
    for (const { task_id: taskId, directory } of bindings) {
      if (this.stopping) return;
      try {
        const seen = new Set<number>();
        await scanImprovementHistory(taskId, directory, identity => {
          const data = this.ledger.prepare("SELECT state FROM checkpoints WHERE task=? AND conversation=?").pluck().get(taskId, identity.conversationId);
          return typeof data === "string" ? JSON.parse(data) as HistoryState : freshHistory();
        }, (identity, state, observations, scanned) => {
          const task = this.app.getTask(taskId);
          if (!task) return;
          this.ledger.transaction(() => {
            let added = 0;
            for (const o of observations) {
              const scope = o.kind === "readPath" ? { kind: "task", id: taskId } : scoped(o, task);
              const key = o.kind === "readPath" ? fingerprint([o.kind,scope,o.replay]) : (o.kind === "correction" || o.kind === "oscillation" || o.kind === "sequence") ? fingerprint([o.kind, scope, o.replay.pattern ?? [taskId,identity.conversationId,o.source.entry]]) : fingerprint([o.kind, scope]);
              added += insert.run(key, o.kind, JSON.stringify(scope), taskId, identity.conversationId, o.source.entry, JSON.stringify(o.source),
                JSON.stringify(o.replay), o.priorGeneration ?? null).changes;
              if(o.kind==="deliveryContract") this.packages.correction(o.source);
            }
            save.run(taskId, identity.conversationId, JSON.stringify(state));
            this.ledger.prepare("UPDATE cycles SET added=added+?,scanned=scanned+? WHERE week=?").run(added, scanned, week);
          }).immediate();
        }, () => this.stopping, {
          needsRead: (conversation,childId) => {
            seen.add(conversation);
            return !this.ledger.prepare("SELECT 1 FROM child_evidence WHERE task=? AND directory=? AND conversation=? AND childId=? AND immutable=1")
              .get(taskId,directory,conversation,childId);
          },
          save: (child, immutable) => this.ledger.prepare("INSERT OR REPLACE INTO child_evidence VALUES(?,?,?,?,?,?)")
            .run(taskId,directory,child.conversation,child.childId,Number(immutable),JSON.stringify(child)),
        }, (identity,inputs)=>{
          const add=this.ledger.prepare("INSERT OR IGNORE INTO improvement_inputs VALUES(?,?,?,?,?,?)");
          const scope=this.ledger.prepare("INSERT OR IGNORE INTO improvement_input_scopes VALUES(?,?,?,?,?)");
          this.ledger.transaction(()=>{for(const input of inputs){
            add.run(taskId,identity.conversationId,input.entry,input.at,Number(input.contract),identity.actor);
            scope.run(taskId,identity.conversationId,input.entry,input.project??null,input.workspace??null);
          }}).immediate();
        });
        await settleImprovementUses(this.ledger,this.packages,taskId,directory);
        const past = this.ledger.prepare("SELECT conversation FROM child_evidence WHERE task=?").pluck().all(taskId) as number[];
        for (const id of past) if (!seen.has(id)) this.ledger.prepare("DELETE FROM child_evidence WHERE task=? AND conversation=?").run(taskId,id);
      } catch (e) { issues.push(taskId + " · " + String(e instanceof Error ? e.message : e).slice(0, 240)); }
      this.progress.done++;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const candidates=this.groups();
    this.progress={phase:"验证和发布改进",done:0,total:candidates.length};
    for (const g of candidates) {
      this.progress.done++;
      if (this.stopping) return;
      if (this.ledger.prepare("SELECT 1 FROM managed WHERE key=?").get(g.key)) continue;
      const scope: HookDraft["scope"] = JSON.parse(g.scope);
      if(g.kind==="deliveryContract" && scope.kind!=="global"){
        if(this.packages.current(g.key) || !this.knowledge()) continue;
        const row=this.ledger.prepare("SELECT source,replay FROM observations WHERE key=? ORDER BY rowid DESC LIMIT 1").get(g.key) as {source:string;replay:string};
        const source=JSON.parse(row.source) as ObservationSource;
        if(this.ledger.prepare("SELECT 1 FROM improvement_unverified WHERE key=? AND source=?").get(g.key,row.source))continue;
        const sourceTask=this.app.getTask(source.taskId);
        if(!sourceTask || this.packages.sourceUses(source).length || this.packages.select({taskId:source.taskId,projectId:sourceTask.projectId,workspaceId:sourceTask.spaceId}))continue;
        const contract=JSON.parse(JSON.parse(row.replay).contract) as DeliveryContract;
        const reserved=this.reserve(g.key,week);
        if(!reserved)continue;
        try {
          const draft=await this.packages.createDraft(g.key,scope,source,contract,reserved);
          const hash=await this.packages.stage(draft);
          if(this.stopping) return;
          const currentTask=this.app.getTask(source.taskId);
          if(!currentTask || scope.kind==="project" && scope.id!==currentTask.projectId || scope.kind==="workspace" && scope.id!==currentTask.spaceId)
            throw new Error("来源任务范围已变化");
          this.packages.activate(hash,0);
        } catch(e) {
          if(!this.packages.current(g.key))this.ledger.prepare("DELETE FROM slots WHERE key=?").run(g.key);
          if(e instanceof UnverifiedOriginalDelivery){
            this.ledger.prepare("INSERT OR REPLACE INTO improvement_unverified VALUES(?,?,?)").run(g.key,row.source,e.message);
          }else issues.push(cards.deliveryContract[0]+" · "+String(e).slice(0,240));
        }
        continue;
      }
      if (g.kind === "readPath" && scope.kind === "task" && !this.readHints.state(g.key)) {
        const sample = this.ledger.prepare("SELECT replay FROM observations WHERE key=? LIMIT 1").pluck().get(g.key) as string;
        try {
          const m = JSON.parse(sample) as ReadMapping;
          const current = this.app.connection.prepare("SELECT cwd FROM durable_bot_bindings WHERE task_id=?").pluck().get(scope.id);
          if (current !== m.cwd) continue;
          const reserved = this.reserve(g.key,week);
          if (reserved && !await this.readHints.publish(g.key,scope.id,m,reserved) && !this.readHints.state(g.key))
            this.ledger.prepare("DELETE FROM slots WHERE key=?").run(g.key);
        } catch (e) { issues.push(cards.readPath[0] + " · " + String(e).slice(0,240)); }
        continue;
      }
      const draft = improvementDraft(g.kind, scope);
      if (!draft) continue;
      try {
        const samples = this.ledger.prepare("SELECT replay,task FROM observations WHERE key=? ORDER BY rowid DESC LIMIT 3").all(g.key) as { replay: string; task: string }[];
        const actual = samples.find(s => {
          const t = this.app.getTask(s.task);
          return t && (scope.kind === "task" || scope.kind === "project" && t.projectId === scope.id || scope.kind === "workspace" && t.spaceId === scope.id);
        });
        if (!actual) continue;
        // The pre-decision evidence must actually trigger the proposed action, in addition to the maintained controls.
        const replay = JSON.parse(actual.replay);
        const reserved = this.reserve(g.key,week);
        if (!reserved) continue;
        if (await this.hooks.check(draft, replay) !== draft.cases[0].expected) throw new Error("原始决策输入未复现");
        const h = await this.hooks.installImprovement({ ...draft, cases: [{ input: replay, expected: draft.cases[0].expected }, ...draft.cases] }, "improvement-" + g.key);
        this.ledger.prepare("INSERT OR IGNORE INTO managed VALUES(?,?,?,?,?)").run(g.key, h.id, 1, this.now(), reserved);
      } catch (e) { issues.push(cards[g.kind][0] + " · " + String(e instanceof Error ? e.message : e).slice(0, 240)); }
    }
    this.progress={phase:"核对归因和验收结果",done:0,total:1};
    if (this.reviewer && !this.stopping) await this.assess(week,this.reviewer);
    if (this.stopping) return;
    this.ledger.prepare("INSERT INTO weekly_cost(week,duration) VALUES(?,?) ON CONFLICT(week) DO UPDATE SET duration=duration+excluded.duration").run(week,Date.now()-started);
    this.ledger.prepare("UPDATE cycles SET issues=? WHERE week=?").run(JSON.stringify(issues),week);
    const last=this.ledger.prepare("SELECT max(week) FROM cycles WHERE week<? AND finished=1").pluck().get(week) as string|null;
    if(last) for(let t=Date.parse(last+"T00:00:00Z")+7*day;t<Date.parse(week+"T00:00:00Z");t+=7*day){
      const missed=weekOf(t);
      this.ledger.prepare("INSERT OR IGNORE INTO cycles(week,at) VALUES(?,?)").run(missed,now);
    }
    this.progress={phase:"保存周报和验证回执",done:0,total:1};
    const unfinished=this.ledger.prepare("SELECT week FROM cycles WHERE (finished=0 OR week IN (SELECT week FROM improvement_dirty_weeks)) AND week<=? ORDER BY week").pluck().all(week) as string[];
    for(const w of unfinished){
      this.packages.followup(w,now);
      await writeImprovementWeek(this.output,this.report(w),w,this.packages.replays(w));
      this.ledger.prepare("DELETE FROM improvement_dirty_weeks WHERE week=?").run(w);
      if(w===week || !issues.length)this.ledger.prepare("UPDATE cycles SET finished=? WHERE week=?").run(Number(!issues.length),w);
    }
    if (!issues.length) {
      this.ledger.prepare("INSERT OR IGNORE INTO child_review_weeks VALUES(?)").run(week);
      this.ledger.prepare("INSERT OR IGNORE INTO release_review_weeks VALUES(?)").run(week);
    }
  }
  private async assess(week: string, reviewer: Reviewer) {
    const pending = this.ledger.prepare(`
      SELECT o.key,o.source FROM observations o
      JOIN (SELECT key,MAX(rowid) latest,COUNT(*) total FROM observations
        WHERE kind IN ('correction','handoff','redundant','recovery','childDelivery','childSteer','deliveryContract','oscillation','sequence','progress') GROUP BY key HAVING kind<>'sequence' OR count(DISTINCT json_array(task,conversation,json_extract(source,'$.input')))>=2) b ON b.latest=o.rowid
      WHERE NOT EXISTS (SELECT 1 FROM assessments a WHERE a.key=o.key
        AND ((a.week=? AND COALESCE(a.error,'')<>'运行中') OR (a.source=o.source AND a.assessment IS NOT NULL)))
      ORDER BY b.total DESC,o.rowid DESC`).all(week) as { key: string; source: string }[];
    for (const candidate of pending) {
      if (this.stopping) return;
      const s = JSON.parse(candidate.source) as ObservationSource;
      const stamp = reviewer.scope(s.taskId);
      const binding = this.app.connection.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").pluck().get(s.taskId);
      if (!stamp || typeof binding !== "string") continue;
      const reserved = this.ledger.prepare(`INSERT OR IGNORE INTO assessments
        SELECT @key,@week,@source,NULL,'运行中' WHERE (SELECT COUNT(*) FROM assessments WHERE week=@week)<5`)
        .run({ key: candidate.key, week, source: candidate.source });
      if (!reserved.changes && !this.ledger.prepare("SELECT 1 FROM assessments WHERE key=? AND week=? AND error='运行中'").get(candidate.key,week)) continue;
      try {
        const input = await this.evidence(binding,s);
        if (this.stopping || reviewer.scope(s.taskId) !== stamp) continue;
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(60000)]);
        this.ledger.prepare("INSERT INTO weekly_cost(week,requests) VALUES(?,1) ON CONFLICT(week) DO UPDATE SET requests=requests+1").run(week);
        const analysis = parseReflection(await reviewer.complete(s.taskId,input,signal),input);
        if (this.stopping || reviewer.scope(s.taskId) !== stamp) continue;
        this.ledger.prepare("UPDATE assessments SET assessment=?,error=NULL WHERE key=? AND week=?").run(JSON.stringify(analysis),candidate.key,week);
      } catch (e) {
        if (this.stopping) return;
        this.ledger.prepare("UPDATE assessments SET error=? WHERE key=? AND week=?").run(String(e instanceof Error ? e.message : e).slice(0,240),candidate.key,week);
      }
    }
  }
  report(exportWeek?:string): ImprovementReport {
    const managed = new Map(this.managed().map(m => [m.key, m]));
    const packages=this.packages.list();
    const active=new Map(packages.map(p=>[p.id,p]));
    const items = this.groups().map((g): ImprovementItem => {
      const m = managed.get(g.key), h = m && this.hooks.find(m.hook);
      const hint = g.kind === "readPath" && this.readHints.state(g.key);
      const [title,cause,change,proof] = cards[g.kind];
      const sourceRows = this.ledger.prepare("SELECT source FROM observations WHERE key=? ORDER BY rowid DESC LIMIT 8").pluck().all(g.key) as string[];
      const scope = JSON.parse(g.scope) as { kind: string; id: string };
      const sources = sourceRows.map(s => JSON.parse(s) as ObservationSource);
      const bundle=active.get(g.key);
      const pendingReason=!bundle && g.kind==="deliveryContract" ? this.ledger.prepare("SELECT reason FROM improvement_unverified WHERE key=?").pluck().get(g.key) as string|undefined : undefined;
      const assessment = this.ledger.prepare("SELECT assessment,source FROM assessments WHERE key=? AND assessment IS NOT NULL ORDER BY week DESC LIMIT 1").get(g.key) as {assessment:string; source:string} | undefined;
      const recurrences = m ? (this.ledger.prepare("SELECT task,conversation,generation FROM observations WHERE key=? AND generation IS NOT NULL AND json_extract(source,'$.at')>=?").all(g.key,m.installed) as {task:string; conversation:string; generation:number}[])
        .filter(s => this.hooks.hadImprovementFeedback(m.hook,m.revision,s.task,s.conversation,s.generation)).length : 0;
      return { key: g.key,title,cause,change,proof,scope: ({ task: "任务", project: "项目", workspace: "工作空间" }[scope.kind] ?? scope.kind) + " " + scope.id,
        count: g.total,sources,hookId: h?.id,generation: bundle?.generation ?? (hint ? 1 : h?.generation),revision: bundle?.revision ?? (hint ? 1 : m?.revision),recurrences,
        ...(pendingReason ? {pendingReason}:{}), ...(hint ? { pathHint: hint.missing + " → " + hint.found } : {}),
        ...(assessment ? {assessment: {...JSON.parse(assessment.assessment),source: JSON.parse(assessment.source)}} : {}),
        state: bundle ? (bundle.enabled?"watching":"disabled") : hint ? hint.enabled ? "watching" : "disabled" : !m ? "candidate" : !h?.enabled ? "disabled" : h.revision !== m.revision ? "changed" : "watching",
        ...(hint ? this.readHints.stats(g.key) : m ? this.hooks.improvementMetrics(m.hook,m.revision) : { triggers: 0, repaired: 0, errors: 0 }) };
    });
    const runs = this.ledger.prepare("SELECT week,at,scanned,added,issues,(SELECT COUNT(*) FROM managed m WHERE m.week=c.week)+(SELECT COUNT(*) FROM path_hints p WHERE p.week=c.week)+(SELECT count(*) FROM improvement_versions v JOIN improvement_staged s ON s.hash=v.hash WHERE json_extract(s.draft,'$.week')=c.week) published FROM cycles c WHERE week IN (SELECT week FROM cycles ORDER BY week DESC LIMIT 12) OR week=? ORDER BY week DESC").all(exportWeek??null) as (Omit<ImprovementRun, "issues"> & {issues: string})[];
    const bindings = new Map((this.app.connection.prepare("SELECT task_id,directory FROM durable_bot_bindings").all() as {task_id:string;directory:string}[]).map(b => [b.task_id,b.directory]));
    const children = (this.ledger.prepare("SELECT task,directory,summary FROM child_evidence ORDER BY json_extract(summary,'$.startedAt') DESC,task,conversation")
      .all() as {task:string;directory:string;summary:string}[]).filter(r => bindings.get(r.task) === r.directory).map(r => JSON.parse(r.summary) as ImprovementChild);
    const weeklyMetrics=runs.map(r=>{
      const start=Date.parse(r.week+"T00:00:00Z"),end=start+7*day;
      const m=this.packages.metrics(r.week);
      const costs=this.ledger.prepare("SELECT duration,requests FROM weekly_cost WHERE week=?").get(r.week) as {duration:number;requests:number}|undefined;
      const inputs=this.ledger.prepare("SELECT count(*) inputs,count(CASE WHEN eligible=1 THEN 1 END) eligible FROM improvement_inputs WHERE at>=? AND at<?").get(start,end) as {inputs:number;eligible:number};
      const corrections=Number(this.ledger.prepare("SELECT count(*) FROM observations WHERE kind='deliveryContract' AND json_extract(source,'$.at')>=? AND json_extract(source,'$.at')<?").pluck().get(start,end));
      const executions=Number(this.ledger.prepare("SELECT count(*) FROM improvement_uses WHERE kind='tool' AND event='executed' AND at>=? AND at<?").pluck().get(start,end));
      return {...m,durationMs:costs?.duration??0,modelRequests:costs?.requests??0,toolCalls:executions,userInputs:inputs.inputs,opportunities:inputs.eligible,corrections};
    });
    return { items, children,packages,outcomes:this.packages.outcomes(),versionEvidence:this.packages.versionEvidence(),weeklyMetrics,progress:{...this.progress}, runs: runs.map(r => ({ ...r, issues: [...JSON.parse(r.issues),
      ...this.ledger.prepare("SELECT error FROM assessments WHERE week=? AND error IS NOT NULL").pluck().all(r.week).map(e => "AI 归因 · " + String(e))],
      followup: (this.ledger.prepare("SELECT metrics FROM followup WHERE week=? ORDER BY key").pluck().all(r.week) as string[]).map(s => JSON.parse(s)) })) };
  }
  disable(key: string, generation: number): ImprovementReport {
    if(this.packages.current(key)){this.packages.disable(key,generation);return this.report();}
    if (generation === 1 && this.readHints.state(key)) { this.readHints.disable(key); return this.report(); }
    const m = this.ledger.prepare("SELECT * FROM managed WHERE key=?").get(key) as Managed | undefined;
    if (!m) throw new Error("找不到此改进");
    const h = this.hooks.find(m.hook);
    if (!h || h.revision !== m.revision) throw new Error("版本已变化，请在执行钩子中管理当前版本");
    this.hooks.activate(h.id, generation, h.revision, false);
    return this.report();
  }
}
