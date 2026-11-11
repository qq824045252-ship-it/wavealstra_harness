import { WorkAutomaticRecovery } from "./WorkAutomaticRecovery";
import { WorkGapCoverage } from "./WorkGapCoverage";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkControlResult, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { workSubitemSchema, type ContinuationWorkParams, type WorkContinuationDto, type WorkSubitemDto, type WorkSubitemResult } from "../../../shared/bot-work-phase3";
import type { WorkService } from "./WorkService";
import type {WorkExecutionObservation} from "./WorkExecutionAdapter";

export function ensureWorkPartialTables(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS work_subitem_results (
    fact_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id),
    item_id TEXT NOT NULL, result_json TEXT NOT NULL CHECK(json_valid(result_json)), deliverable_id TEXT REFERENCES work_deliverables(deliverable_id),
    created_at INTEGER NOT NULL, UNIQUE(binding_id,item_id)
  );
  CREATE TABLE IF NOT EXISTS work_continuation_plans (
    plan_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(work_id), source_binding_id TEXT NOT NULL REFERENCES work_execution_bindings(binding_id),
    operation_id TEXT NOT NULL, intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL, owner_bot_id TEXT NOT NULL,
    gap_items_json TEXT NOT NULL CHECK(json_valid(gap_items_json)), reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','dispatched','settled','cancelled')), created_at INTEGER NOT NULL,
    UNIQUE(work_id,operation_id)
  );
  CREATE TABLE IF NOT EXISTS work_continuation_gaps (
    gap_key TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES work_continuation_plans(plan_id)
  );`);
  const columns = db.prepare("PRAGMA table_info(work_dispatch_requests)").all().map(row => z.object({ name: z.string() }).parse(row).name);
  if (columns.length && !columns.includes("continuation_plan_id")) db.exec("ALTER TABLE work_dispatch_requests ADD COLUMN continuation_plan_id TEXT REFERENCES work_continuation_plans(plan_id)");
}
const itemRow = z.object({ fact_id: z.string(), work_id: z.string(), binding_id: z.string(), result_json: z.string(), deliverable_id: z.string().nullable(), created_at: z.number() });
const planRow = z.object({ plan_id: z.string(), work_id: z.string(), source_binding_id: z.string(), intent_revision: z.number(), input_snapshot_id: z.string(),
  owner_epoch: z.number(), owner_bot_id: z.string(), gap_items_json: z.string(), reason: z.string(), state: z.enum(["pending", "dispatched", "settled", "cancelled"]), created_at: z.number() });
interface PartialGapRead {
  items: WorkSubitemDto[];
  plans: () => WorkContinuationDto[];
  bindingForPlan: (planId: string) => WorkExecutionBindingDto | undefined;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Facts and continuation intents share the WorkService business transaction. */
export class WorkPartialResults {
  readonly coverage: WorkGapCoverage;
  readonly recovery: WorkAutomaticRecovery;
  constructor(private readonly db: Database.Database, private readonly works: WorkService) {
    ensureWorkPartialTables(db); this.coverage = new WorkGapCoverage(db, works); this.recovery = new WorkAutomaticRecovery(db, works);
  }

  list(workId: string): WorkSubitemDto[] {
    return this.readItems(workId, new Map());
  }
  private readItems(workId: string, bindings: Map<string, WorkExecutionBindingDto | undefined>): WorkSubitemDto[] {
    return this.db.prepare("SELECT * FROM work_subitem_results WHERE work_id=? ORDER BY created_at,rowid").all(workId).map(raw => {
      const row = itemRow.parse(raw);
      if (!bindings.has(row.binding_id)) bindings.set(row.binding_id, this.works.repo.getBinding(row.binding_id));
      const binding = bindings.get(row.binding_id);
      if (!binding) throw new Error("逐项事实缺少原执行绑定");
      return this.coverage.project({ ...workSubitemSchema.parse(JSON.parse(row.result_json)), factId: row.fact_id, workId, bindingId: row.binding_id,
        intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId, deliverableId: row.deliverable_id ?? undefined, createdAt: row.created_at });
    });
  }
  plans(workId: string): WorkContinuationDto[] {
    return this.db.prepare("SELECT * FROM work_continuation_plans WHERE work_id=? ORDER BY created_at,rowid").all(workId).map(raw => {
      const row = planRow.parse(raw);
      return { planId: row.plan_id, workId, sourceBindingId: row.source_binding_id, gapItemIds: z.array(z.string()).parse(JSON.parse(row.gap_items_json)),
        intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id, ownerEpoch: row.owner_epoch, ownerBotId: row.owner_bot_id,
        state: row.state, reason: row.reason, createdAt: row.created_at };
    });
  }
  /** Exact persisted continuation ancestry, never guessed from file paths or task names. */
  deliverySource(binding: WorkExecutionBindingDto): WorkExecutionBindingDto | undefined {
    const request = z.object({ continuation_plan_id: z.string().nullable(), state: z.string() }).optional().parse(
      this.db.prepare("SELECT continuation_plan_id,state FROM work_dispatch_requests WHERE task_id=? AND work_id=? AND bot_id=? AND intent_revision=? AND input_snapshot_id=?")
        .get(binding.taskId, binding.workId, binding.botId, binding.intentRevision, binding.inputSnapshotId));
    if (!request?.continuation_plan_id || request.state === "cancelled") return undefined;
    const plan = this.plans(binding.workId).find(item => item.planId === request.continuation_plan_id);
    if (!plan || plan.state === "cancelled" || plan.intentRevision !== binding.intentRevision
      || plan.inputSnapshotId !== binding.inputSnapshotId || plan.ownerEpoch !== binding.ownerEpoch || plan.ownerBotId !== binding.botId) return undefined;
    const source = this.works.repo.getBinding(plan.sourceBindingId);
    return source && source.bindingId !== binding.bindingId && source.workId === binding.workId
      && source.intentRevision === binding.intentRevision && source.inputSnapshotId === binding.inputSnapshotId
      && source.ownerEpoch === binding.ownerEpoch ? source : undefined;
  }
  gaps(workId: string): WorkSubitemDto[] {
    const work = this.works.getWork(workId);
    if (!work) return [];
    // Reuse immutable facts only within this synchronous read. No cache survives
    // a call: a later read must see settlements, owner changes and rollbacks.
    const bindings = new Map<string, WorkExecutionBindingDto | undefined>();
    const items = this.readItems(workId, bindings);
    const adopted = new Map<string, boolean>();
    let plans: WorkContinuationDto[] | undefined;
    const planBindings = new Map<string, WorkExecutionBindingDto | undefined>();
    const read: PartialGapRead = { items, plans: () => plans ??= this.plans(workId), bindingForPlan: planId => {
      if (!planBindings.has(planId)) {
        const request = z.object({ task_id: z.string() }).optional().parse(this.db.prepare("SELECT task_id FROM work_dispatch_requests WHERE continuation_plan_id=? AND state='dispatched'").get(planId));
        planBindings.set(planId, request ? this.works.repo.bindingForTask(request.task_id) : undefined);
      }
      return planBindings.get(planId);
    } };
    const all = items.filter(item => {
      const binding = bindings.get(item.bindingId);
      if (item.intentRevision !== work.intentRevision || item.inputSnapshotId !== work.inputSnapshotId || !binding) return false;
      if (!adopted.has(binding.bindingId)) adopted.set(binding.bindingId, this.works.collaboration.isDelegationAdopted(binding, work));
      return adopted.get(binding.bindingId);
    });
    return all.filter(item => item.required && item.outcome !== "completed" && !item.coverage && !this.resolvedByContinuation(item, read));
  }
  settle(binding:WorkExecutionBindingDto):void {
    if(!this.db.inTransaction) throw Error("补跑结算必须与原生 Inbox 同事务提交");
    this.db.prepare(`UPDATE work_continuation_plans SET state='settled' WHERE plan_id=(SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?) AND state='dispatched'`).run(binding.taskId);
  }
  artifactGap(binding:WorkExecutionBindingDto,path:string,criterionIds:string[],now:number):void {
    if(!this.db.inTransaction)throw Error("产物核验缺口必须与失效事实同事务提交");
    const itemId=`artifact-check:${hash(path)}`,factId=`artifact-gap:${hash([binding.bindingId,path])}`;
    const result:WorkSubitemResult={itemId,task:`仅重新读取并核验当前产物 ${path}。保留已有业务效果，不重复原写入、发送或发布。`,required:true,dependencies:[],criterionIds,
      nativeStatus:"host_artifact_observation",outcome:"blocked",artifactRefs:[path],writeConflicts:[],summary:"产物版本变化，需要独立只读核验与当前版本反馈",origin:"artifact_revalidation"};
    this.db.prepare("INSERT OR IGNORE INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,created_at) VALUES (?,?,?,?,?,?)").run(factId,binding.workId,binding.bindingId,itemId,JSON.stringify(result),now);
  }
  isReadOnlyPlan(plan:WorkContinuationDto):boolean {
    const source = this.works.repo.getBinding(plan.sourceBindingId);
    if (this.recovery.readOnlyPlan(plan.planId) || source && this.recovery.sourceReadOnly(source)) return true;
    const items = this.list(plan.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    if (items.length === plan.gapItemIds.length && items.length > 0
      && items.every(item => item.nativeStatus === "watch_read_followup" && item.itemId.startsWith("watch-followup:"))) return true;
    if (items.length === plan.gapItemIds.length && items.length > 0
      && items.every(item => item.nativeStatus === "result_read_followup" && item.itemId.startsWith("result-followup:"))) return true;
    return this.isArtifactRevalidationPlan(plan);
  }
  private isArtifactRevalidationPlan(plan:WorkContinuationDto):boolean {
    const items=this.list(plan.workId).filter(item=>item.bindingId===plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    return items.length > 0 && items.length===plan.gapItemIds.length && items.every(item=>item.origin==="artifact_revalidation");
  }
  observe(binding:WorkExecutionBindingDto,observation:WorkExecutionObservation):WorkExecutionObservation {
    if(observation.status==="running")return observation;
    const request=z.object({continuation_plan_id:z.string().nullable()}).optional().parse(this.db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(binding.taskId));
    const plan=request?.continuation_plan_id && this.plans(binding.workId).find(plan=>plan.planId===request.continuation_plan_id);
    if (!plan) return observation;
    if (this.recovery.record(plan.planId)) {
      const source = this.works.repo.getBinding(plan.sourceBindingId);
      if (!source) return observation;
      const item = this.list(plan.workId).find(item => item.bindingId === source.bindingId && item.itemId === `recover:${source.bindingId}`);
      if (!item) return observation;
      return { ...observation, subitems: [...observation.subitems ?? [], { itemId: item.itemId, task: item.task,
        required: true, dependencies: [], criterionIds: item.criterionIds, nativeStatus: observation.status,
        outcome: observation.status === "completed" ? this.recovery.record(plan.planId)?.mode === "readback" ? "blocked" : "completed" : observation.status === "stopped" ? "stopped" : "failed",
        artifactRefs: observation.artifactRefs, writeConflicts: [], summary: observation.summary }] };
    }
    if(!this.isArtifactRevalidationPlan(plan))return observation;
    const items=this.list(plan.workId).filter(item=>item.bindingId===plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    const verified=observation.status==="completed" && items.every(item=>item.artifactRefs.every(path=>observation.readPaths?.includes(path)));
    const results:WorkSubitemResult[]=items.map(item=>({itemId:item.itemId,task:item.task,required:true,dependencies:item.dependencies,criterionIds:item.criterionIds,
      nativeStatus:observation.status,outcome:verified?"completed":observation.status==="completed"?"blocked":observation.status==="stopped"?"stopped":"failed",
      artifactRefs:item.artifactRefs,writeConflicts:[],summary:verified?"原生只读执行已读取当前产物，仍等待必要验收反馈":"核验未提供当前产物的成功读取凭据，原业务效果未重做",origin:"artifact_revalidation"}));
    return {...observation,artifactRefs:[...new Set([...observation.artifactRefs,...(verified?items.flatMap(item=>item.artifactRefs):[])])],subitems:[...observation.subitems ?? [],...results]};
  }
  private resolvedByContinuation(item: WorkSubitemDto, read: PartialGapRead, seen = new Set<string>()): boolean {
    return read.plans().filter(plan => plan.sourceBindingId === item.bindingId && plan.gapItemIds.includes(item.itemId))
      .some(plan => this.continuationCompletes(item, plan.planId, seen, read));
  }
  private continuationCompletes(item: WorkSubitemDto, planId: string, seen: Set<string>, read: PartialGapRead): boolean {
    if (seen.has(planId)) return false;
    const nextSeen = new Set(seen).add(planId);
    const binding = read.bindingForPlan(planId);
    if (!binding || !["completed", "failed", "stopped"].includes(binding.status)) return false;
    if (read.items.some(result => result.bindingId === binding.bindingId
      && (result.itemId === item.itemId || result.task === item.task) && result.outcome === "completed")) return true;
    // A continuation may fail before emitting this item. Its persistent descendant
    // still owns the same gap; only a real matching completed fact resolves it.
    return read.plans().filter(plan => plan.sourceBindingId === binding.bindingId && plan.state !== "cancelled")
      .some(plan => this.continuationCompletes(item, plan.planId, nextSeen, read));
  }
  record(binding: WorkExecutionBindingDto, items: WorkSubitemResult[], now = Date.now()): void {
    if (!this.db.inTransaction) throw new Error("逐项结果必须与原生 Inbox 消费同事务提交");
    let changed = false;
    for (const input of items) {
      const item = workSubitemSchema.parse(input);
      const factId = `item:${hash([binding.taskId,binding.durableStoreKey,binding.conversationId,binding.workspaceBinding,binding.operationId,item.itemId])}`;
      const prior = itemRow.optional().parse(this.db.prepare("SELECT * FROM work_subitem_results WHERE fact_id=?").get(factId));
      const priorResult = prior && workSubitemSchema.parse(JSON.parse(prior.result_json));
      // Terminal item evidence is immutable. A delayed running/unknown projection cannot erase it.
      if (priorResult && !["unknown", "not_started"].includes(priorResult.outcome)) continue;
      let deliverableId = prior?.deliverable_id ?? undefined;
      if (item.outcome === "completed" && !this.recovery.isSyntheticItem(binding, item.itemId)) {
        deliverableId = `partial:${factId}`;
        const result = this.works.submitDeliverable({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
          operationId: deliverableId, deliverableId, workId: binding.workId, bindingId: binding.bindingId,
          summary: item.summary || item.task || "已保留子项成果，等待核验", artifactRefs: item.artifactRefs,
          evidence: [{ kind: "tool_receipt", sourceRef: `durable:${binding.durableStoreKey}:${binding.conversationId}:${item.itemId}`, criterionIds: item.criterionIds }],
        });
        if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
      }
      this.db.prepare(`INSERT INTO work_subitem_results(fact_id,work_id,binding_id,item_id,result_json,deliverable_id,created_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(fact_id) DO UPDATE SET result_json=excluded.result_json,deliverable_id=excluded.deliverable_id`)
        .run(factId,binding.workId,binding.bindingId,item.itemId,JSON.stringify(item),deliverableId ?? null,now);
      changed = true;
    }
    const current = this.works.getWork(binding.workId);
    if (current && changed) this.works.repo.updateWork({ ...current, stateVersion: current.stateVersion + 1, updatedAt: now });
  }
  /** Called by WorkService's owner-only, full-CAS control wrapper, never by model data directly. */
  continue(work: WorkDto, params: ContinuationWorkParams, now: number): { ok: true; outboxEventId?:string } | Extract<WorkControlResult, { ok: false }> {
    if (!this.db.inTransaction) throw new Error("缺口计划必须通过 Work 控制事务");
    const source = this.works.repo.getBinding(params.sourceBindingId);
    if (!source || !this.works.collaboration.isDelegationAdopted(source, work))
      return { ok: false, code: "version_conflict", message: "缺口执行不属于当前输入要求" };
    if (!["completed","failed","stopped"].includes(source.status))
      return { ok: false, code: "unsettled_effects", message: "原执行或外部效果尚未核对，不能补跑" };
    const ids = [...new Set(params.gapItemIds)].sort();
    const available = this.gaps(work.workId).filter(item => item.bindingId === source.bindingId);
    const selected = ids.map(id => available.find(item => item.itemId === id));
    if (selected.some(item => !item || item.outcome === "unknown")) return { ok: false, code: "invalid_request", message: "只能补跑已核实、仍未覆盖的必要子项" };
    const readonly=selected.filter(item=>item?.origin==="artifact_revalidation").length;
    if(readonly && readonly!==selected.length)return {ok:false,code:"invalid_request",message:"产物只读核验与业务补跑必须分别受理，保持核验执行只读"};
    const keys = ids.map(id => hash([source.bindingId,id]));
    const planId = `continuation:${hash([work.workId,work.intentRevision,work.inputSnapshotId,keys])}`;
    const existing = this.plans(work.workId).find(plan => plan.planId === planId);
    if (existing) {
      if(existing.ownerBotId!==work.ownerBotId || existing.ownerEpoch!==work.ownerEpoch) {
        const submitted=this.db.prepare(`SELECT 1 FROM work_dispatch_requests request JOIN work_execution_bindings binding ON binding.task_id=request.task_id WHERE request.continuation_plan_id=?`).get(planId);
        if(submitted) return {ok:true};
        if(this.db.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND state='pending' AND COALESCE(continuation_plan_id,'')!=?").get(work.workId,work.intentRevision,work.inputSnapshotId,planId))
          return {ok:false,code:"version_conflict",message:"当前输入已有待派发计划，先核对该计划再采纳旧缺口"};
        this.db.prepare("UPDATE work_continuation_plans SET owner_bot_id=?,owner_epoch=?,state='pending',reason=? WHERE plan_id=?")
          .run(work.ownerBotId,work.ownerEpoch,params.reason,planId);
        this.db.prepare("UPDATE work_dispatch_requests SET bot_id=?,state='pending',attempts=0,error=NULL WHERE continuation_plan_id=? AND state!='dispatched'").run(work.ownerBotId,planId);
        return this.approved(work,params,planId,now);
      }
      return { ok: true };
    }
    if (keys.some(key => this.db.prepare("SELECT 1 FROM work_continuation_gaps WHERE gap_key=?").get(key)))
      return { ok: false, code: "version_conflict", message: "缺口已由另一已受理计划占用，请核对原计划" };
    this.db.prepare(`INSERT INTO work_continuation_plans(plan_id,work_id,source_binding_id,operation_id,intent_revision,input_snapshot_id,owner_epoch,owner_bot_id,gap_items_json,reason,state,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(planId,work.workId,source.bindingId,params.operationId,work.intentRevision,work.inputSnapshotId,work.ownerEpoch,work.ownerBotId,JSON.stringify(ids),params.reason,now);
    for (const key of keys) this.db.prepare("INSERT INTO work_continuation_gaps(gap_key,plan_id) VALUES (?,?)").run(key,planId);
    return this.approved(work,params,planId,now);
  }
  private approved(work:WorkDto,params:ContinuationWorkParams,planId:string,now:number):{ok:true;outboxEventId:string} {
    const next={...work,stateVersion:work.stateVersion+1,updatedAt:now};this.works.repo.updateWork(next);
    const eventId=`continuation-approved:${planId}:${work.ownerEpoch}`;
    this.works.repo.insertOutbox({eventId,dedupeKey:eventId,eventType:"work.continuation_approved",workId:work.workId,
      intentRevision:work.intentRevision,stateVersion:next.stateVersion,ownerEpoch:work.ownerEpoch,requestId:params.operationId,
      deliveryStatus:"pending",attemptCount:0,payload:{planId,sourceBindingId:params.sourceBindingId,gapItemIds:params.gapItemIds},createdAt:now});
    return {ok:true,outboxEventId:eventId};
  }
  executionInput(binding: WorkExecutionBindingDto): string | undefined {
    const row = z.object({ continuation_plan_id: z.string().nullable() }).optional().parse(this.db.prepare("SELECT continuation_plan_id FROM work_dispatch_requests WHERE task_id=?").get(binding.taskId));
    const plan = row?.continuation_plan_id && this.plans(binding.workId).find(item => item.planId === row.continuation_plan_id);
    if (!plan) return undefined;
    const recovery = this.recovery.input(binding, plan.planId); if (recovery) return recovery;
    const items = this.list(binding.workId).filter(item => item.bindingId === plan.sourceBindingId && plan.gapItemIds.includes(item.itemId));
    return JSON.stringify({ continuation: { planId: plan.planId,
      instructions: "只完成以下已受理的缺口计划。已完成的文件、发送或其他效果不得重做。未核实的未知外部效果不得重放；只推进与其无依赖的独立步骤，核对实际状态或幂等回执前不重复同一操作。originalGoal 仅用于核对原始输入与要求，不扩大本次续跑范围。",
      items: items.map(item => ({ itemId: item.itemId, task: item.task, criterionIds: item.criterionIds,
        dependencies: item.dependencies, previousOutcome: item.outcome, writeConflicts: item.writeConflicts })) },
      originalGoal: JSON.parse(this.works.repo.executionInput(binding)) });
  }
}
