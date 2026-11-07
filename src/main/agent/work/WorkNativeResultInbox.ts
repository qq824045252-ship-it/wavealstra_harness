import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { AgentSubmissionReceipt } from "../../../shared/agent-ipc";
import type { WorkControlResult, WorkExecutionBindingDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";
import type { WorkExecutionObservation } from "./WorkExecutionAdapter";
import { workExecutionObservationSchema as observationSchema } from "../../../shared/bot-work-phase3";

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
    const recovery = z.object({ cycle_id: z.string() }).optional().parse(this.db.prepare("SELECT cycle_id FROM work_native_recovery WHERE binding_id=?").get(binding.bindingId));
    const factId = hash([namespaceHash, receipt.submissionId, payload, recovery?.cycle_id ?? null]);
    const artifactRefs = [...new Set([...(payload.status === "running" ? [] : payload.artifactRefs),...(payload.subitems ?? []).filter(item=>item.origin!=="artifact_revalidation" || item.outcome==="completed").flatMap(item => item.artifactRefs)])];
    const artifacts = this.works.artifacts.register(binding,artifactRefs);
    this.works.transaction(() => {
      this.assertAuthority();
      this.works.artifacts.record(binding,artifacts);
      this.db.prepare(`INSERT OR IGNORE INTO work_native_inbox(fact_id,binding_id,namespace_hash,payload_json,received_at)
        VALUES (?,?,?,?,?)`).run(factId, binding.bindingId, namespaceHash, JSON.stringify(payload), Date.now());
      // This position references a fact already durable in the same transaction. It is
      // a receive position, never permission to skip unconsumed inbox rows.
      this.db.prepare(`INSERT INTO work_native_cursors(binding_id,fact_id,updated_at) VALUES (?,?,?)
        ON CONFLICT(binding_id) DO UPDATE SET fact_id=excluded.fact_id,read_failures=0,updated_at=excluded.updated_at`)
        .run(binding.bindingId, factId, Date.now());
    });
    return this.consume();
  }

  consume(workId?: string): Array<{ bindingId: string; error: unknown }> {
    const failures: Array<{ bindingId: string; error: unknown }> = [];
    const pending = this.db.prepare(`SELECT fact_id,binding_id,namespace_hash,payload_json FROM work_native_inbox
      WHERE consumed_at IS NULL AND (? IS NULL OR binding_id IN (SELECT binding_id FROM work_execution_bindings WHERE work_id=?))
      ORDER BY received_at,rowid`).all(workId ?? null, workId ?? null).map(row => factSchema.parse(row));
    for (const fact of pending) {
      try { this.works.transaction(() => {
      this.assertAuthority();
      const unconsumed = this.db.prepare("SELECT 1 FROM work_native_inbox WHERE fact_id=? AND consumed_at IS NULL").get(fact.fact_id);
      if (!unconsumed) return;
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
        this.db.prepare("UPDATE work_native_inbox SET consume_error=? WHERE fact_id=? AND consumed_at IS NULL")
          .run("pending_adoption: 当前输入仍有效，等待当前负责人接管原执行委派", fact.fact_id);
        this.works.emitCurrentProjection(binding.workId);
        return;
      }
      if (observation.subitems?.length) this.works.partialResults.record(binding,observation.subitems);
      if (canSettle) {
        if ((observation.status === "completed" || observation.status === "failed")
          && !this.works.repo.listDeliverables(binding.workId).some(item => item.deliverableId === `result:${binding.bindingId}`)) {
          this.require(this.works.submitDeliverable({ kind: "worker", botId: binding.botId, bindingId: binding.bindingId }, {
            operationId: `result:${binding.bindingId}`, workId: binding.workId, bindingId: binding.bindingId,
            deliverableId: `result:${binding.bindingId}`, summary: observation.summary || "原生执行已结束，成果仍待负责人核验",
            artifactRefs: observation.artifactRefs, hasWriteConflicts: observation.hasWriteConflicts,
            evidence: [{ kind: "tool_receipt", sourceRef: `durable:${fact.namespace_hash}:answer:${observation.sourceEntryId ?? binding.bindingId}` }],
            uncoveredScope: observation.subitems?.filter(item => item.required && item.outcome !== "completed").map(item => `${item.task}：${item.outcome}`)
              ?? (observation.status === "failed" ? ["本次执行失败，必要目标仍待核验"] : []),
            uncoveredCriterionIds: [...new Set((observation.subitems ?? []).filter(item => item.required && item.outcome !== "completed").flatMap(item => item.criterionIds))],
          }));
        }
        this.reconcile(binding, observation);
        if(observation.status!=="running") this.works.partialResults.settle(binding);
      }
      this.db.prepare("UPDATE work_native_inbox SET consumed_at=?,consume_error=NULL WHERE fact_id=?").run(Date.now(), fact.fact_id);
      }); } catch (error) {
        failures.push({ bindingId: fact.binding_id, error });
        this.works.transaction(() => {
          this.assertAuthority();
          this.db.prepare("UPDATE work_native_inbox SET consume_error=? WHERE fact_id=?").run(error instanceof Error ? error.message : String(error), fact.fact_id);
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

  private reconcile(binding: WorkExecutionBindingDto, observation: WorkExecutionObservation): void {
    this.require(this.works.reconcileExecution({ kind: "system", reason: "native-result-inbox" }, {
      bindingId: binding.bindingId, outcome: observation.status,
      ...(observation.status === "running" ? {} : { note: observation.summary, usageTokens: observation.usageTokens }),
      reservationId: binding.reservationId,
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
    return !this.db.prepare("SELECT 1 FROM work_native_recovery WHERE binding_id=? AND exhausted_at IS NOT NULL").get(bindingId);
  }

  allowInspect(bindingId: string): void {
    this.works.transaction(() => {
      this.assertAuthority();
      this.db.prepare("UPDATE work_native_recovery SET failures=0,exhausted_at=NULL,first_failure_at=? WHERE binding_id=?").run(Date.now(), bindingId);
    });
  }

  readRecovered(binding: WorkExecutionBindingDto): void {
    this.works.transaction(() => {
      this.assertAuthority();
      this.db.prepare("DELETE FROM work_native_recovery WHERE binding_id=?").run(binding.bindingId);
      const work = this.works.getWork(binding.workId);
      const cleared = this.works.repo.listOpenBlockers(binding.workId).filter(blocker => blocker.unknownExternalEffectRef === `native-read:${binding.bindingId}`);
      for (const blocker of cleared) this.works.repo.clearBlocker(blocker.blockerId, binding.workId, Date.now());
      if (work && cleared.length) this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
    });
  }

  readFailed(binding: WorkExecutionBindingDto, error: unknown): void {
    this.works.transaction(() => {
      this.assertAuthority();
      const now = Date.now();
      this.db.prepare(`INSERT INTO work_native_recovery(binding_id,failures,first_failure_at,last_error) VALUES (?,1,?,?)
        ON CONFLICT(binding_id) DO UPDATE SET failures=failures+1,last_error=excluded.last_error,
        exhausted_at=CASE WHEN failures>=4 OR excluded.first_failure_at-first_failure_at>=90000 THEN excluded.first_failure_at ELSE exhausted_at END`)
        .run(binding.bindingId, now, error instanceof Error ? error.message : String(error));
      this.require(this.works.reconcileExecution({ kind: "system", reason: "native-readback-failed" }, {
        bindingId: binding.bindingId,
        outcome: ["completed", "failed", "stopped", "invalidated"].includes(this.works.repo.getBinding(binding.bindingId)?.status ?? "")
          ? this.works.repo.getBinding(binding.bindingId)!.status : "unknown",
        unknownExternalEffectRef: `native-read:${binding.bindingId}`,
      }));
    });
  }

  private assertAuthority(): void { if (!this.isAuthority()) throw new Error("当前宿主不持有结果消费租约"); }

  private require(result: WorkControlResult): void {
    if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  }
}
