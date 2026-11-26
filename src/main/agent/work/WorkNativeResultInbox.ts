import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentSubmissionReceipt } from "../../../shared/agent-ipc";
import type { WorkControlResult, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { WorkExecutionObservation } from "./WorkExecutionObservation";
import { workExecutionObservationSchema as observationSchema } from "../../../shared/bot-work-phase3";
import { enqueueWorkOp, overlayDelete, overlayFindAll, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites } from "./WorkDomainRuntime";

const factSchema = z.object({ fact_id: z.string(), binding_id: z.string(), namespace_hash: z.string(), payload_json: z.string() });
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const namespace = (binding: WorkExecutionBindingDto) => hash([binding.taskId, binding.durableStoreKey,
  binding.conversationId, binding.workspaceBinding, binding.operationId]);

/** One durable receive/consume path for startup, polling and event wakeups. */
export class WorkNativeResultInbox {
  constructor(private readonly db: Database.Database, private readonly works: WorkService, private readonly isAuthority: () => boolean) {}

  receive(binding: WorkExecutionBindingDto, receipt: AgentSubmissionReceipt, observation: WorkExecutionObservation) {
    const payload = observationSchema.parse(this.works.partialResults.observe(binding,observationSchema.parse(observation)));
    if (receipt.taskId !== binding.taskId || receipt.operationId !== binding.operationId) throw new Error("结果回执不属于该执行绑定");
    const namespaceHash = namespace(binding);
    const recovery = overlayReadOne<{ cycle_id?: string | null }>(this.db, "work_native_recovery", binding.bindingId, () =>
      this.db.prepare("SELECT * FROM work_native_recovery WHERE binding_id=?").get(binding.bindingId) as { cycle_id?: string | null } | undefined);
    const factId = hash([namespaceHash, receipt.submissionId, payload, recovery?.cycle_id ?? null]);
    const artifactRefs = [...new Set([...(payload.status === "running" ? [] : payload.artifactRefs),...(payload.subitems ?? []).filter(item=>item.origin!=="artifact_revalidation" || item.outcome==="completed").flatMap(item => item.artifactRefs)])];
    const artifacts = this.works.artifacts.register(binding,artifactRefs);
    this.works.transaction(() => {
      this.assertAuthority();
      const rust = requiresWorkRustWrites(this.db);
      const now = Date.now();
      const currentBinding = this.works.repo.getBinding(binding.bindingId);
      if (currentBinding) this.works.automaticCompletion.observe(currentBinding, payload.status);
      this.works.artifacts.record(binding,artifacts);
      this.works.generatedArtifacts.record(binding,payload.generatedArtifacts ?? []);
      if (this.works.runtimeObservations.record(binding,payload)) {
        const work = this.works.getWork(binding.workId);
        if (work) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
        this.works.emitCurrentProjection(binding.workId);
      }
      const payloadJson = JSON.stringify(payload);
      if (rust) {
        overlayMutate(this.db, "work_native_inbox", factId, () =>
          this.db.prepare("SELECT * FROM work_native_inbox WHERE fact_id=?").get(factId) as Record<string, unknown> | undefined,
        cur => cur ?? {
          fact_id: factId, binding_id: binding.bindingId, namespace_hash: namespaceHash,
          payload_json: payloadJson, received_at: now, consumed_at: null, consume_error: null,
        });
        enqueueWorkOp(this.db, {
          op: "workNativeInboxWrite", mode: "receive", factId, bindingId: binding.bindingId,
          namespaceHash, payloadJson, now, consumeError: null,
        });
      } else {
        this.db.prepare(`INSERT OR IGNORE INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at)
          VALUES (?,?,?,?,?)`).run(factId, binding.bindingId, namespaceHash, payloadJson, now);
        // This position references a fact already durable in the same transaction. It is
        // a receive position, never permission to skip unconsumed inbox rows.
        this.db.prepare(`INSERT INTO work_native_cursors(binding_id,fact_id,updated_at) VALUES (?,?,?)
          ON CONFLICT(binding_id) DO UPDATE SET fact_id=excluded.fact_id,read_failures=0,updated_at=excluded.updated_at`)
          .run(binding.bindingId, factId, now);
      }
    });
    return this.consume();
  }

  consume(workId?: string): Array<{ bindingId: string; error: unknown }> {
    const failures: Array<{ bindingId: string; error: unknown }> = [];
    const rust = requiresWorkRustWrites(this.db);
    const dbPending = this.db.prepare(`SELECT fact_id,binding_id,namespace_hash,payload_json,received_at,consumed_at FROM work_native_inbox
      WHERE consumed_at IS NULL AND (? IS NULL OR binding_id IN (SELECT binding_id FROM work_execution_bindings WHERE work_id=?))
      ORDER BY received_at,rowid`).all(workId ?? null, workId ?? null) as Array<Record<string, unknown>>;
    const allowedBindings = workId ? new Set(this.works.repo.listBindings(workId).map(b => b.bindingId)) : undefined;
    const pending = overlayFindAll(this.db, "work_native_inbox", dbPending, r => String(r.fact_id),
      r => (r.consumed_at ?? null) === null && (!allowedBindings || allowedBindings.has(String(r.binding_id))),
      (a, b) => Number(a.received_at ?? 0) - Number(b.received_at ?? 0))
      .map(row => factSchema.parse(row));
    for (const fact of pending) {
      try { this.works.transaction(() => {
      this.assertAuthority();
      const unconsumedRaw = overlayReadOne<Record<string, unknown>>(this.db, "work_native_inbox", fact.fact_id, () =>
        this.db.prepare("SELECT * FROM work_native_inbox WHERE fact_id=?").get(fact.fact_id) as Record<string, unknown> | undefined);
      if (!unconsumedRaw || (unconsumedRaw.consumed_at ?? null) !== null) return;
      const binding = this.works.repo.getBinding(fact.binding_id);
      if (!binding || namespace(binding) !== fact.namespace_hash) throw new Error("结果执行命名空间不匹配");
      const work = this.works.getWork(binding.workId);
      if (!work) throw new Error("结果执行缺少原事项");
      const observation = observationSchema.parse(JSON.parse(fact.payload_json));
      const terminal = ["completed", "failed", "stopped", "invalidated"].includes(binding.status);
      const canSettle = !terminal || binding.status === observation.status;
      const awaitingAdoption = (work.lifecycle === "active" || work.lifecycle === "paused")
        && this.works.collaboration.isDelegationPending(binding, work);
      this.adoptionBlocker(binding, awaitingAdoption);
      {
        for (const blocker of this.works.repo.listOpenBlockers(binding.workId)) {
          if (blocker.blockerId === `inbox:${fact.fact_id}` || blocker.unknownExternalEffectRef === `native-read:${binding.bindingId}`) {
            this.works.repo.clearBlocker(blocker.blockerId, binding.workId, Date.now());
          }
        }
      }
      if (awaitingAdoption) {
        // Native completion and its actual usage are facts even while a delegation
        // awaits adoption. Keep the original payload/cursor durable and retryable;
        // publishing aggregate or partial deliverables still requires the owner.
        if (canSettle) this.reconcile(binding, observation);
        const msg = "pending_adoption: 当前输入仍有效，等待当前负责人接管原执行委派";
        if (rust) {
          overlayMutate(this.db, "work_native_inbox", fact.fact_id, () => unconsumedRaw,
            cur => cur && (cur.consumed_at ?? null) === null ? { ...cur, consume_error: msg } : cur);
          enqueueWorkOp(this.db, {
            op: "workNativeInboxWrite", mode: "pendingAdoption", factId: fact.fact_id,
            bindingId: null, namespaceHash: null, payloadJson: null, now: null, consumeError: msg,
          });
        } else {
          this.db.prepare("UPDATE work_native_inbox SET consume_error=? WHERE fact_id=? AND consumed_at IS NULL")
            .run(msg, fact.fact_id);
        }
        this.works.emitCurrentProjection(binding.workId);
        return;
      }
      if (observation.subitems?.length) this.works.partialResults.record(binding,observation.subitems);
      // Settlement cannot move a terminal binding backwards, but late output is
      // still evidence. submitDeliverable preserves invalidated output as history.
      if (observation.status !== "running") this.preserveResult(binding, observation, fact.namespace_hash);
      if (canSettle) {
        this.reconcile(binding, observation);
        if(observation.status!=="running") this.works.partialResults.settle(binding);
      }
      const now = Date.now();
      if (rust) {
        overlayMutate(this.db, "work_native_inbox", fact.fact_id, () => unconsumedRaw,
          cur => cur ? { ...cur, consumed_at: now, consume_error: null } : cur);
        enqueueWorkOp(this.db, {
          op: "workNativeInboxWrite", mode: "consumed", factId: fact.fact_id,
          bindingId: null, namespaceHash: null, payloadJson: null, now, consumeError: null,
        });
      } else {
        this.db.prepare("UPDATE work_native_inbox SET consumed_at=?,consume_error=NULL WHERE fact_id=?").run(now, fact.fact_id);
      }
      }); } catch (error) {
        failures.push({ bindingId: fact.binding_id, error });
        this.works.transaction(() => {
          this.assertAuthority();
          const errMsg = error instanceof Error ? error.message : String(error);
          if (rust) {
            overlayMutate(this.db, "work_native_inbox", fact.fact_id, () =>
              this.db.prepare("SELECT * FROM work_native_inbox WHERE fact_id=?").get(fact.fact_id) as Record<string, unknown> | undefined,
            cur => cur ? { ...cur, consume_error: errMsg } : cur);
            enqueueWorkOp(this.db, {
              op: "workNativeInboxWrite", mode: "consumeError", factId: fact.fact_id,
              bindingId: null, namespaceHash: null, payloadJson: null, now: null, consumeError: errMsg,
            });
          } else {
            this.db.prepare("UPDATE work_native_inbox SET consume_error=? WHERE fact_id=?").run(errMsg, fact.fact_id);
          }
          const binding = this.works.repo.getBinding(fact.binding_id);
          if (binding && !this.works.repo.listBlockers(binding.workId).some(item => item.blockerId === `inbox:${fact.fact_id}`)) {
            this.works.repo.insertBlocker({ blockerId: `inbox:${fact.fact_id}`, workId: binding.workId,
              reason: "持久结果消费失败，原始事实已保留等待重新核对", kind: "operational", waitingForUserInput: false, status: "open", createdAt: Date.now() });
            const work = this.works.getWork(binding.workId);
            if (work) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
          }
        });
      }
    }
    return failures;
  }

  private preserveResult(binding: WorkExecutionBindingDto, observation: Exclude<WorkExecutionObservation, { status: "running" }>, namespaceHash: string): void {
    const rootId = `result:${binding.bindingId}`;
    const results = this.works.repo.listDeliverables(binding.workId);
    const existing = results.find(item => item.deliverableId === rootId);
    const failureReason = observation.failureReason?.trim();
    const summary = observation.summary.trim();
    // Old failed observations used summary for the error itself. Without separate
    // result content or artifact evidence, do not propose that error as an output.
    const resultSummary = observation.status === "completed" || failureReason && summary !== failureReason ? summary : "";
    const work = this.works.getWork(binding.workId)!;
    if (existing?.status === "proposed" && observation.status !== "completed" && failureReason
      && !existing.artifactRefs.length && existing.summary.trim() === failureReason
      && binding.intentRevision === work.intentRevision && binding.inputSnapshotId === work.inputSnapshotId && !binding.invalidatedAt) {
      this.works.repo.updateDeliverableReview(existing.deliverableId, { status: "superseded", reviewedAt: Date.now(),
        rejectedReason: "原记录仅包含执行异常，已保留为历史事实，不作为成果" });
      this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
    }
    if (observation.status !== "completed" && !resultSummary && !observation.artifactRefs.length) return;
    const deliverableSummary = resultSummary || "已保留原执行产物，成果仍待负责人核验";
    if (existing && existing.summary === deliverableSummary && existing.hasWriteConflicts === observation.hasWriteConflicts && observation.artifactRefs.every(path => existing.artifactRefs.includes(path))) return;
    // Backfill must not rewrite an earlier receipt or silently drop newly recovered
    // artifacts. This stable ID survives rereads, restarts and inbox recovery cycles.
    const deliverableId = existing ? `result-recovered:${binding.bindingId}:${hash([resultSummary, [...observation.artifactRefs].sort(), observation.hasWriteConflicts])}` : rootId;
    if (results.some(item => item.deliverableId === deliverableId)) return;
    const incomplete = observation.subitems?.filter(item => item.required && item.outcome !== "completed") ?? [];
    this.require(this.works.submitDeliverable({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
      operationId: deliverableId, workId: binding.workId, bindingId: binding.bindingId, deliverableId,
      summary: deliverableSummary,
      artifactRefs: observation.artifactRefs, hasWriteConflicts: observation.hasWriteConflicts,
      evidence: [{ kind: "tool_receipt", sourceRef: `durable:${namespaceHash}:answer:${observation.sourceEntryId ?? binding.bindingId}` }],
      uncoveredScope: [...incomplete.map(item => `${item.task}：${item.outcome}`),
        ...(observation.status === "completed" ? [] : [observation.status === "stopped" ? "本次执行已停止，剩余目标仍待核验" : "本次执行失败，剩余目标仍待核验"])],
      uncoveredCriterionIds: [...new Set(incomplete.flatMap(item => item.criterionIds))],
    }));
  }

  private reconcile(binding: WorkExecutionBindingDto, observation: WorkExecutionObservation): void {
    this.require(this.works.reconcileExecution({ kind: "system", reason: "native-result-inbox" }, {
      bindingId: binding.bindingId, outcome: observation.status,
      ...(observation.status === "running" ? {} : { note: observation.failureReason || observation.summary, usageTokens: observation.usageTokens }),
    }));
  }

  private adoptionBlocker(binding: WorkExecutionBindingDto, pending: boolean): void {
    const blockerId = `adoption:${binding.bindingId}`;
    const existing = this.works.repo.getBlocker(blockerId);
    const now = Date.now();
    if (pending && existing?.status !== "open") {
      if (existing) this.works.repo.reopenBlocker(blockerId, binding.workId);
      else this.works.repo.insertBlocker({ blockerId, workId: binding.workId,
        reason: "原执行回执已保留，等待当前负责人接管委派后核验成果", kind: "operational",
        waitingForUserInput: false, status: "open", createdAt: now });
    } else if (!pending && existing?.status === "open") {
      this.works.repo.clearBlocker(blockerId, binding.workId, now);
    } else return;
    const work = this.works.getWork(binding.workId)!;
    this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
    this.works.emitCurrentProjection(binding.workId);
  }

  shouldInspect(bindingId: string): boolean {
    const row = overlayReadOne<Record<string, unknown>>(this.db, "work_native_recovery", bindingId, () =>
      this.db.prepare("SELECT * FROM work_native_recovery WHERE binding_id=?").get(bindingId) as Record<string, unknown> | undefined);
    return !(row && row.exhausted_at !== null && row.exhausted_at !== undefined);
  }

  allowInspect(bindingId: string): void {
    this.works.transaction(() => {
      this.assertAuthority();
      const now = Date.now();
      if (requiresWorkRustWrites(this.db)) {
        overlayMutate(this.db, "work_native_recovery", bindingId,
          () => this.db.prepare("SELECT * FROM work_native_recovery WHERE binding_id=?").get(bindingId) as Record<string, unknown> | undefined,
          cur => cur ? { ...cur, failures: 0, exhausted_at: null, first_failure_at: now } : undefined);
        enqueueWorkOp(this.db, {
          op: "workNativeRecoveryWrite", mode: "allowInspect", bindingId, now, lastError: null,
        });
        return;
      }
      this.db.prepare("UPDATE work_native_recovery SET failures=0,exhausted_at=NULL,first_failure_at=? WHERE binding_id=?").run(now, bindingId);
    });
  }

  readRecovered(binding: WorkExecutionBindingDto): void {
    this.works.transaction(() => {
      this.assertAuthority();
      if (requiresWorkRustWrites(this.db)) {
        overlayDelete(this.db, "work_native_recovery", binding.bindingId);
        enqueueWorkOp(this.db, {
          op: "workNativeRecoveryWrite", mode: "delete", bindingId: binding.bindingId, now: null, lastError: null,
        });
      } else {
        this.db.prepare("DELETE FROM work_native_recovery WHERE binding_id=?").run(binding.bindingId);
      }
      const work = this.works.getWork(binding.workId);
      const cleared = this.works.repo.listOpenBlockers(binding.workId).filter(blocker => blocker.unknownExternalEffectRef === `native-read:${binding.bindingId}`);
      for (const blocker of cleared) this.works.repo.clearBlocker(blocker.blockerId, binding.workId, Date.now());
      if (work && cleared.length) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
    });
  }

  readFailed(binding: WorkExecutionBindingDto, error: unknown): void {
    const observationChanged = this.works.runtimeObservations.readFailed(binding,error);
    this.works.transaction(() => {
      this.assertAuthority();
      const now = Date.now();
      const lastError = error instanceof Error ? error.message : String(error);
      if (requiresWorkRustWrites(this.db)) {
        overlayMutate(this.db, "work_native_recovery", binding.bindingId,
          () => this.db.prepare("SELECT * FROM work_native_recovery WHERE binding_id=?").get(binding.bindingId) as Record<string, unknown> | undefined,
          cur => {
            if (!cur) return { binding_id: binding.bindingId, failures: 1, first_failure_at: now, exhausted_at: null, last_error: lastError };
            const failures = Number(cur.failures ?? 0);
            const firstFailureAt = Number(cur.first_failure_at ?? now);
            const exhaustedAt = failures >= 4 || now - firstFailureAt >= 90000 ? now : (cur.exhausted_at ?? null);
            return { ...cur, failures: failures + 1, last_error: lastError, exhausted_at: exhaustedAt };
          });
        enqueueWorkOp(this.db, {
          op: "workNativeRecoveryWrite", mode: "readFailed", bindingId: binding.bindingId, now, lastError,
        });
      } else {
        this.db.prepare(`INSERT INTO work_native_recovery(binding_id,failures,first_failure_at,last_error) VALUES (?,1,?,?)
          ON CONFLICT(binding_id) DO UPDATE SET failures=failures+1,last_error=excluded.last_error,
          exhausted_at=CASE WHEN failures>=4 OR excluded.first_failure_at-first_failure_at>=90000 THEN excluded.first_failure_at ELSE exhausted_at END`)
          .run(binding.bindingId, now, lastError);
      }
      // A failed status query says nothing about whether the original native
      // process stopped. Keep its last lifecycle/admissions, so cancellation and
      // recovery cannot race a still-running writer. The outage itself is only a
      // nonblocking diagnostic and does not freeze independent tools or Works.
      const ref = `native-read:${binding.bindingId}`;
      const recorded = this.works.repo.listBlockers(binding.workId).some(item => item.unknownExternalEffectRef === ref);
      if (!recorded) this.works.repo.insertBlocker({ blockerId: `native-read-diagnostic:${binding.bindingId}`,
        workId: binding.workId, kind: "external_effect", unknownExternalEffectRef: ref,
        reason: "原生执行状态暂不可回读；保留原执行身份，不自动重发", waitingForUserInput: false,
        status: "open", createdAt: now });
      if (!recorded || observationChanged) {
        const work = this.works.repo.getWork(binding.workId);
        if (work) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: now });
      }
    });
  }

  private assertAuthority(): void { if (!this.isAuthority()) throw new Error("当前宿主不持有结果消费租约"); }

  private require(result: WorkControlResult): void {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  }
}
