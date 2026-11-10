import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import { isScheduledFollowUp, scheduledFollowUpCurrent } from "./WorkScheduledFollowUp";
import { createHash,randomUUID } from "node:crypto";
import { z } from "zod";
import type { AppDatabase } from "../../db/AppDatabase";
import type { WorkActor, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { WorkExecutionAdapter } from "./WorkExecutionAdapter";
import { DESKTOP_USER_GRANTS } from "./WorkService";
import { WorkSourceObserver,sourceSnapshot } from "./WorkSourceObserver";

const rowSchema = z.object({ operation_id: z.string(), work_id: z.string(), task_id: z.string(), bot_id: z.string(),
  intent_revision: z.number(), input_snapshot_id: z.string(), continuation_plan_id: z.string().nullable().optional(),
  inbox_event_id: z.string().nullable().optional() });
const sameInput = (binding: WorkExecutionBindingDto, work: WorkDto) => binding.intentRevision === work.intentRevision
  && binding.inputSnapshotId === work.inputSnapshotId;
// Invalidating a result never erases execution/effect history. Only an explicitly
// invalidated binding with no possible submission is safe to replace unchanged.
const retainsInput = (binding: WorkExecutionBindingDto, work: WorkDto) => sameInput(binding, work)
  && (binding.status !== "invalidated" || binding.attemptId !== undefined || binding.submissionReceipt !== undefined || binding.submittedAt !== undefined);

/** Business transaction persists the execution intent; native preparation can be resumed separately. */
export class WorkDispatchQueue {
  private flushing?: Promise<void>;
  private dirty = false;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: AppDatabase, private readonly works: WorkService,
    private readonly adapter: WorkExecutionAdapter, private readonly isAuthority: () => boolean,
    private readonly defaultModel: () => string | undefined,
    private readonly permissionMode: () => import("../../../shared/agent-ipc").PermissionMode = () => "default",
    private readonly resumeDeferredActions?: () => Promise<void>,
    private readonly botSettings?: (work: WorkDto, botId?: string) => import("../../../shared/bot-settings").BotSettingsDto) {}

  enqueue(work: WorkDto, operationId: string, retryBlocked = false, inboxEventId?: string): void {
    const current = this.works.getWork(work.workId);
    if (!current || watchTimeExpired(current, Date.now()) || current.lifecycle !== "active" || current.intentRevision !== work.intentRevision || current.inputSnapshotId !== work.inputSnapshotId) return;
    work = current;
    if (this.works.teams.get(work.workId)) return;
    if (this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE operation_id=?").get(operationId)) return;
    const bindings = this.works.repo.listBindings(work.workId);
    this.syncContinuationBlockers(work, bindings);
    if (retryBlocked) this.db.connection.prepare("UPDATE work_dispatch_requests SET state='pending',attempts=0 WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND state='blocked'")
      .run(work.workId, work.intentRevision, work.inputSnapshotId);
    if (this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND state IN ('pending','blocked')")
      .get(work.workId, work.intentRevision, work.inputSnapshotId)) return;
    // Resume changes control state, not input identity. Preserve completed results
    // and partial/failed executions too: a fresh root would repeat their effects.
    // Pending bindings resume through the adapter; only a new input/revision can
    // authorize a separately planned continuation.
    const inboxEvent = inboxEventId ? this.works.repo.getInbox(inboxEventId) : undefined;
    const readOnlyFollowUp = isScheduledFollowUp(inboxEvent);
    if (readOnlyFollowUp && !scheduledFollowUpCurrent(work, inboxEvent, inboxEvent?.subscriptionId ? this.works.repo.getSubscription(inboxEvent.subscriptionId) : undefined)) return;
    if (inboxEventId && inboxEvent?.workId !== work.workId) return;
    if (!readOnlyFollowUp && bindings.some(binding => retainsInput(binding, work))) return;
    const taskId = `work-execution-${randomUUID()}`;
    const settings = this.botSettings?.(work);
    this.db.upsertTask({ id: taskId, title: work.title, updatedAt: Date.now(), cwd: work.workspacePath ?? settings?.effectiveWorkspacePath, spaceId: settings?.spaceId,
      projectId: work.projectId, modelId: settings?.modelId || this.defaultModel(), permissionMode: readOnlyFollowUp ? "readonly" : this.permissionMode(), modePresetId: "native" });
    this.db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,inbox_event_id)
      VALUES (?,?,?,?,?,?,'pending',?,?)`).run(operationId, work.workId, taskId, work.ownerBotId, work.intentRevision, work.inputSnapshotId, Date.now(), inboxEventId ?? null);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.wake(), 1000);
    this.timer.unref?.();
    this.wake();
  }
  wake(): void { void this.flush().catch(error => console.warn("[Work] 派发恢复待核对", error)); }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.flushing; }
  flush(): Promise<void> {
    this.dirty = true;
    if (!this.flushing) this.flushing = (async () => {
      do { this.dirty = false; await this.deliver(); } while (this.dirty);
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async deliver(): Promise<void> {
    if (!this.isAuthority()) return;
    await this.resumeDeferredActions?.();
    this.resumeRetiredQuotaRequests();
    await this.works.teams.dispatchPending(this.db, this.adapter, this.defaultModel, this.permissionMode, this.botSettings);
    await this.drainSourceEvents();
    this.prepareSourceIntents();
    this.prepareContinuations();
    for (const request of this.db.connection.prepare("SELECT * FROM work_dispatch_requests WHERE state='pending' ORDER BY created_at,rowid").all().map(row => rowSchema.parse(row))) {
      if (!this.isAuthority()) return;
      const original = this.works.repo.getBindingByOperation(request.work_id, `dispatch:${request.operation_id}`);
      if (original) {
        if (original.taskId !== request.task_id || original.botId !== request.bot_id || original.intentRevision !== request.intent_revision || original.inputSnapshotId !== request.input_snapshot_id) throw new Error("原始派发命名空间不匹配");
        this.finishRequest(request.operation_id, request.work_id, "dispatched");
        continue;
      }
      const work = this.works.getWork(request.work_id);
      if (!work || watchTimeExpired(work, Date.now()) || work.lifecycle === "closed" || work.lifecycle === "closing" || work.intentRevision !== request.intent_revision || work.inputSnapshotId !== request.input_snapshot_id) {
        this.db.connection.prepare("UPDATE work_dispatch_requests SET state='cancelled' WHERE operation_id=?").run(request.operation_id);
        continue;
      }
      if (work.lifecycle !== "active") continue;
      if (work.ownerBotId !== request.bot_id) {
        // Never reinterpret an old owner's unsubmitted decision as new authorization.
        this.finishRequest(request.operation_id,request.work_id,"cancelled");
        continue;
      }
      // A pending request can outlive the caller/crash that created it. Apply the
      // same input dedupe on recovery, before preparing another native namespace.
      // The matching operation above keeps its original binding/receipt instead.
      const continuation = request.continuation_plan_id && this.works.partialResults.plans(work.workId).find(plan => plan.planId === request.continuation_plan_id);
      if (request.continuation_plan_id && (!continuation || continuation.state === "cancelled" || continuation.ownerEpoch !== work.ownerEpoch || continuation.ownerBotId !== work.ownerBotId)) {
        this.finishRequest(request.operation_id,request.work_id,"cancelled"); continue;
      }
      const requestEvent = request.inbox_event_id ? this.works.repo.getInbox(request.inbox_event_id) : undefined;
      const readOnlyFollowUp = isScheduledFollowUp(requestEvent);
      if (readOnlyFollowUp && !scheduledFollowUpCurrent(work, requestEvent, requestEvent?.subscriptionId ? this.works.repo.getSubscription(requestEvent.subscriptionId) : undefined)) {
        this.finishRequest(request.operation_id, request.work_id, "cancelled"); continue;
      }
      if (!continuation && !readOnlyFollowUp && this.works.repo.listBindings(work.workId).some(binding => retainsInput(binding, work))) {
        this.finishRequest(request.operation_id, request.work_id, "cancelled");
        continue;
      }
      try {
        const actor: WorkActor = { kind: "bot", userId: work.userId, botId: work.ownerBotId, host: "background", grants: DESKTOP_USER_GRANTS };
        const result = await this.adapter.dispatch(actor, { taskId: request.task_id, operationId: `dispatch:${request.operation_id}`,
          workId: work.workId, botId: request.bot_id,
          delegatedScope: readOnlyFollowUp ? ["workspace:read"]
            : continuation && this.works.partialResults.isReadOnlyPlan(continuation) ? ["workspace:read"]
              : continuation ? work.authorization.allowedScopes.filter(scope => this.works.repo.getBinding(continuation.sourceBindingId)?.delegatedScope.includes(scope))
                : work.authorization.allowedScopes,
          inboxEventId: request.inbox_event_id ?? undefined,
          causal: requestEvent ? { source: requestEvent.source, sourceEventId: requestEvent.sourceEventId,
            causalEventId: requestEvent.causalEventId, trustedRoot: true, actionKind: readOnlyFollowUp ? "scheduled-follow-up" : "source-dispatch" } : undefined,
          versionGuard: { expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch } });
        if (!result.ok) {
          if (["version_conflict", "epoch_mismatch", "invalid_lifecycle_transition"].includes(result.code)) continue;
          throw new Error(`${result.code}: ${result.message}`);
        }
        this.finishRequest(request.operation_id, request.work_id, "dispatched");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.works.transaction(() => {
          if (!this.isAuthority()) return;
          this.db.connection.prepare("UPDATE work_dispatch_requests SET attempts=attempts+1,error=?,state=CASE WHEN attempts>=2 THEN 'blocked' ELSE 'pending' END WHERE operation_id=?")
            .run(message, request.operation_id);
          const current = this.works.getWork(request.work_id);
          if (current && !this.works.repo.getBlocker(`dispatch:${request.operation_id}`)) {
            this.works.repo.insertBlocker({ blockerId: `dispatch:${request.operation_id}`, workId: current.workId,
              reason: `后台准备受阻，保留原派发身份；核验后暂停/恢复可再次尝试：${message}`,
              kind: "operational", waitingForUserInput: false, status: "open", createdAt: Date.now() });
            this.works.repo.updateWork({ ...current, stateVersion: current.stateVersion + 1, updatedAt: Date.now() });
          }
        });
        this.works.emitCurrentProjection(request.work_id);
        console.warn("[Work] 派发受阻", request.work_id, message);
      }
    }
    await this.adapter.flush();
    for (const row of this.db.connection.prepare(`SELECT DISTINCT request.work_id FROM work_dispatch_requests request
      JOIN works work ON work.work_id=request.work_id WHERE request.state='dispatched' AND work.lifecycle='active'`).all()) {
      const work = this.works.getWork(z.object({ work_id: z.string() }).parse(row).work_id);
      if (work) this.syncContinuationBlockers(work, this.works.repo.listBindings(work.workId));
    }
    if (this.isAuthority()) this.works.automaticCompletion.drain();
  }

  private resumeRetiredQuotaRequests(): void {
    this.works.transaction(() => {
      if (!this.isAuthority()) return;
      const rows = this.db.connection.prepare("SELECT * FROM work_dispatch_requests WHERE state='blocked'").all();
      for (const raw of rows) {
        const request = rowSchema.extend({ error: z.string().nullable() }).parse(raw);
        if (!request.error?.startsWith("budget_exhausted: ")) continue;
        // Only a proven pre-submission quota refusal is eligible. Retain the
        // operation/task identity and original error until normal dispatch settles.
        if (this.works.repo.bindingForTask(request.task_id)
          || this.works.repo.getBindingByOperation(request.work_id, `dispatch:${request.operation_id}`)) continue;
        this.db.connection.prepare("UPDATE work_dispatch_requests SET state='pending',attempts=0 WHERE operation_id=? AND state='blocked'")
          .run(request.operation_id);
      }
    });
  }

  private prepareSourceIntents():void {
    this.works.transaction(()=>{
      if(!this.isAuthority())return;
      for(const raw of this.db.connection.prepare("SELECT event_id FROM work_events_outbox WHERE event_type='work.source_dispatch_requested' AND delivery_status='pending' ORDER BY created_at,rowid").all()) {
        const event=this.works.repo.getOutbox(z.object({event_id:z.string()}).parse(raw).event_id);if(!event)continue;
        const work=this.works.getWork(event.workId);
        if(!work || ["closing","closed"].includes(work.lifecycle) || work.intentRevision!==event.intentRevision || work.ownerEpoch!==event.ownerEpoch || work.inputSnapshotId!==event.payload.inputSnapshotId) {
          this.works.repo.markOutboxStatus(event.eventId,"invalidated");continue;
        }
        if(work.lifecycle!=="active")continue;
        this.enqueue(work,`source:${event.eventId}`,false,event.payload.inboxEventId as string | undefined);
        this.works.repo.markOutboxStatus(event.eventId,"delivered");
      }
    });
  }

  private async drainSourceEvents():Promise<void> {
    const ids=this.db.connection.prepare(`SELECT DISTINCT work_id FROM work_events_inbox WHERE status IN ('pending','merged','blocked')
      UNION SELECT subscription.work_id FROM work_paused_source_routes route JOIN work_subscriptions subscription ON subscription.subscription_id=route.subscription_id WHERE route.inbox_event_id IS NULL`).all().map(row=>z.object({work_id:z.string()}).parse(row).work_id);
    const observer=new WorkSourceObserver(this.works);
    for(const workId of ids) {
      if(!this.isAuthority())return;
      let work=this.works.getWork(workId);if(!work || work.lifecycle!=="active")continue;
      this.works.transaction(()=>{
        this.works.pausedBacklog.refill(workId,Date.now());
        // Reorder the finite overflow back into the active queue before scanning it.
        for(const subscription of this.works.repo.listSubscriptions(workId)) this.works.ingress.refillBlocked(subscription);
      });
      work=this.works.getWork(workId)!;
      const pendingBinding=this.works.repo.listBindings(workId).some(binding=>["pending","submitted","running","unknown"].includes(binding.status));
      const pendingIntent=this.works.repo.listOutbox(workId,["pending","attempted","unknown"]).some(event=>event.eventType==="work.source_dispatch_requested");
      if(pendingBinding || pendingIntent || this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND state IN ('pending','blocked')").get(workId))continue;
      const event=this.works.ingress.listReady(workId,Date.now())[0];if(!event)continue;
      const subscription=event.subscriptionId?this.works.repo.getSubscription(event.subscriptionId):undefined;
      if(event.subscriptionId && !subscription) {this.sourceBlocked(workId,event.eventId,"事件缺少原订阅，等待核对");continue;}
      if (isScheduledFollowUp(event) && !scheduledFollowUpCurrent(work, event, subscription)) {
        this.works.repo.setInboxStatus(event.eventId, "skipped", Date.now()); continue;
      }
      try {
        const result=await this.works.pausedBacklog.consume(event.eventId,async()=>{
          if(isScheduledFollowUp(event)) return {inputSnapshotId:work.inputSnapshotId, sources:work.goalSources};
          const needsReadback=subscription?.catchUpPolicy==="latest" || event.payload.authoritativeReadbackRequired===true;
          if(needsReadback) return observer.readCurrent(work);
          // each obligations need no current-state readback: their immutable event payload is the input.
          const sourceRef=`work-event:${event.subscriptionId ?? event.source}`;
          const eventSource={sourceType:"external_input" as const,sourceRef,inputSnapshotId:`source-event:${createHash("sha256").update(JSON.stringify([event.source,event.sourceEventId,event.sourceVersion,event.frozenPayload ?? event.payload])).digest("hex")}`,observedAt:Date.now()};
          const sources=[...work.goalSources.filter(item=>!(item.sourceType==="external_input" && item.sourceRef===sourceRef)),eventSource];
          return {inputSnapshotId:sourceSnapshot(sources),sources};
        },(current,original,source)=>{
          if(isScheduledFollowUp(original)) {
            this.works.repo.insertOutbox({ eventId:`followup-outbox:${original.eventId}`,
              dedupeKey:`work:${current.workId}:op:followup:${original.eventId}:work.source_dispatch_requested`,
              eventType:"work.source_dispatch_requested", workId:current.workId, intentRevision:current.intentRevision,
              stateVersion:current.stateVersion, ownerEpoch:current.ownerEpoch, requestId:`followup:${original.eventId}`,
              payload:{ inputSnapshotId:current.inputSnapshotId, inboxEventId:original.eventId }, deliveryStatus:"pending",
              attemptCount:0, createdAt:Date.now() });
            return;
          }
          const applied=this.works.applyObservedSources(current.workId,`source-inbox:${original.eventId}`,current,source);
          if(!applied.ok)throw Error(`${applied.code}: ${applied.message}`);
          this.works.repo.clearBlocker(`source-readback:${original.eventId}`,current.workId,Date.now());
        });
        if(result.ok)this.works.emitCurrentProjection(workId);
      } catch(error) {this.sourceBlocked(workId,event.eventId,error instanceof Error?error.message:String(error));}
    }
  }
  private sourceBlocked(workId:string,eventId:string,reason:string):void {
    this.works.transaction(()=>{
      if(!this.isAuthority())return;
      const work=this.works.getWork(workId),event=this.works.repo.getInbox(eventId);if(!work || work.lifecycle!=="active" || !event || !["pending","merged"].includes(event.status))return;
      this.works.repo.setInboxStatus(eventId,"blocked");
      this.db.connection.prepare("UPDATE work_events_inbox SET payload_json=? WHERE event_id=?").run(JSON.stringify({...event.payload,_sourceReadbackError:reason,_sourceReadbackFailedAtSourceVersion:work.sourceVersion}),eventId);
      const blockerId=`source-readback:${eventId}`;
      if(!this.works.repo.getBlocker(blockerId))this.works.repo.insertBlocker({blockerId,workId,kind:"operational",reason:`来源回读受阻：${reason}`,waitingForUserInput:true,status:"open",createdAt:Date.now()});
      else this.works.repo.reopenBlocker(blockerId,workId);
      this.works.repo.updateWork({...work,stateVersion:work.stateVersion+1,updatedAt:Date.now()});this.works.emitCurrentProjection(workId);
    });
  }

  private prepareContinuations(): void {
    this.works.transaction(() => {
      if (!this.isAuthority()) return;
      for (const raw of this.db.connection.prepare("SELECT DISTINCT work_id FROM work_continuation_plans WHERE state='pending'").all()) {
        const work = this.works.getWork(z.object({work_id:z.string()}).parse(raw).work_id);
        if (work) this.prepareWorkContinuations(work);
      }
    });
  }
  private prepareWorkContinuations(work: WorkDto): void {
    for (let plan of this.works.partialResults.plans(work.workId).filter(plan => plan.state === "pending")) {
      const source = this.works.repo.getBinding(plan.sourceBindingId);
      if (this.works.partialResults.recovery.record(plan.planId) && source
        && plan.intentRevision === work.intentRevision && plan.inputSnapshotId === work.inputSnapshotId
        && this.works.collaboration.isDelegationAdopted(source, work)
        && !this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests request JOIN work_execution_bindings binding ON binding.task_id=request.task_id WHERE request.continuation_plan_id=?").get(plan.planId)
        && (plan.ownerEpoch !== work.ownerEpoch || plan.ownerBotId !== work.ownerBotId)) {
        this.db.connection.prepare("UPDATE work_continuation_plans SET owner_bot_id=?,owner_epoch=? WHERE plan_id=?")
          .run(work.ownerBotId, work.ownerEpoch, plan.planId);
        this.db.connection.prepare("UPDATE work_dispatch_requests SET bot_id=? WHERE continuation_plan_id=?")
          .run(work.ownerBotId, plan.planId);
        plan = { ...plan, ownerBotId: work.ownerBotId, ownerEpoch: work.ownerEpoch };
      }
      if (work.intentRevision !== plan.intentRevision || work.inputSnapshotId !== plan.inputSnapshotId || work.ownerEpoch !== plan.ownerEpoch || work.ownerBotId !== plan.ownerBotId || ["closed","closing"].includes(work.lifecycle)
        || source && !this.works.scheduledBindingCurrent(source)) {
        this.db.connection.prepare("UPDATE work_continuation_plans SET state='cancelled' WHERE plan_id=?").run(plan.planId);
        this.works.repo.markOutboxStatus(`continuation-approved:${plan.planId}:${plan.ownerEpoch}`,"invalidated");continue;
      }
      if (work.lifecycle !== "active") continue;
      const request=z.object({operation_id:z.string(),task_id:z.string(),state:z.string()}).optional().parse(this.db.connection.prepare("SELECT operation_id,task_id,state FROM work_dispatch_requests WHERE continuation_plan_id=?").get(plan.planId));
      if(request) {
        if (!this.works.repo.bindingForTask(request.task_id) && this.works.partialResults.isReadOnlyPlan(plan)) {
          const task = this.db.getTask(request.task_id);
          if (task && task.permissionMode !== "readonly") this.db.upsertTask({ ...task, permissionMode: "readonly", updatedAt: Date.now() });
        }
        if(request.state==="cancelled" && !this.works.repo.bindingForTask(request.task_id)
          && !this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND state='pending' AND operation_id!=?").get(work.workId,request.operation_id))
          this.db.connection.prepare("UPDATE work_dispatch_requests SET state='pending',bot_id=?,error=NULL WHERE operation_id=?").run(work.ownerBotId,request.operation_id);
        this.works.repo.markOutboxStatus(`continuation-approved:${plan.planId}:${plan.ownerEpoch}`,"delivered");
        continue;
      }
      if (this.db.connection.prepare("SELECT 1 FROM work_dispatch_requests WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND state='pending'").get(work.workId,work.intentRevision,work.inputSnapshotId)) continue;
      const taskId = `work-execution-${randomUUID()}`;
      const sourceBinding = this.works.repo.getBinding(plan.sourceBindingId);
      const sourceTask = sourceBinding && this.db.getTask(sourceBinding.taskId);
      this.db.upsertTask({id:taskId,title:`补齐：${work.title}`,updatedAt:Date.now(),cwd:sourceBinding?.workspaceBinding ?? work.workspacePath,spaceId:sourceTask?.spaceId,projectId:work.projectId,modelId:sourceTask?.modelId ?? this.defaultModel(),permissionMode:this.works.partialResults.isReadOnlyPlan(plan) || sourceTask?.permissionMode === "readonly" || this.permissionMode() === "readonly" ? "readonly" : sourceTask?.permissionMode ?? this.permissionMode(),modePresetId:"native"});
      this.db.connection.prepare(`INSERT INTO work_dispatch_requests(operation_id,work_id,task_id,bot_id,intent_revision,input_snapshot_id,state,created_at,continuation_plan_id)
        VALUES (?,?,?,?,?,?,'pending',?,?)`).run(plan.planId,work.workId,taskId,work.ownerBotId,work.intentRevision,work.inputSnapshotId,Date.now(),plan.planId);
      this.works.repo.markOutboxStatus(`continuation-approved:${plan.planId}:${plan.ownerEpoch}`,"delivered");
    }
  }

  private syncContinuationBlockers(work: WorkDto, bindings: WorkExecutionBindingDto[]): void {
    const changed = this.works.transaction(() => {
      if (!this.isAuthority()) return false;
      let changed = false;
      const now = Date.now();
      for (const binding of bindings) {
        const blockerId = `continuation:${binding.bindingId}`;
        const blocker = this.works.repo.getBlocker(blockerId);
        const planned = this.works.partialResults.plans(work.workId).some(plan => plan.sourceBindingId === binding.bindingId && plan.state !== "cancelled");
        // A failed native input gets an exact persisted continuation. A user stop
        // or invalidation is never permission to restart it.
        if (this.works.partialResults.recovery.settleReadback(this.works.getWork(work.workId)!, binding, now)) changed = true;
        if (!planned && this.works.partialResults.recovery.prepare(work, binding, now)) changed = true;
        if (blocker?.status === "open") {
          this.works.repo.clearBlocker(blockerId, work.workId, now); changed = true;
        }
      }
      if (changed) {
        const latest = this.works.getWork(work.workId);
        if (latest) this.works.repo.updateWork({ ...latest, stateVersion: latest.stateVersion + 1, updatedAt: now });
      }
      return changed;
    });
    if (changed) this.works.emitCurrentProjection(work.workId);
  }

  private finishRequest(operationId: string, workId: string, state: "dispatched" | "cancelled"): void {
    this.works.transaction(() => {
      if (!this.isAuthority()) return;
      this.db.connection.prepare("UPDATE work_dispatch_requests SET state=?,error=NULL WHERE operation_id=?").run(state, operationId);
      this.db.connection.prepare(`UPDATE work_continuation_plans SET state=? WHERE plan_id=(SELECT continuation_plan_id FROM work_dispatch_requests WHERE operation_id=?)`)
        .run(state === "dispatched" ? "dispatched" : "cancelled",operationId);
      const blocker = this.works.repo.getBlocker(`dispatch:${operationId}`);
      const work = this.works.getWork(workId);
      if (blocker?.status === "open" && work) {
        this.works.repo.clearBlocker(blocker.blockerId, workId, Date.now());
        this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
      }
    });
    this.works.emitCurrentProjection(workId);
  }
}
