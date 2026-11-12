import type Database from "better-sqlite3";
import type { WorkService } from "./WorkService";
import type { WorkResultDecision, WorkResultTurnInput } from "./WorkResultDecision";
import { recordCollaborationReturnFailure } from "./BotCollaborationExecutionFacts";
import { CompletionDeliveryError, applyCompletionDecision } from "./WorkCompletionDecision";
import { workDeliveryFiles, workDeliveryResults } from "./WorkDeliveryArtifacts";
import { completionEvidence, completionFingerprint } from "./WorkCompletionEvidence";
import { resultDecisionSchema } from "./WorkResultDecision";
import { WorkResultLifecycleError } from "./WorkResultLifecycleError";
import type { WorkFeedbackDto } from "../../../shared/bot-conversation";

export interface WorkCompletionDelivery {
  bindingId: string; eventId: string; text: string; category: "progress" | "result" | "decision"; notices?: string[];
  completion?: NonNullable<WorkFeedbackDto["report"]>["completion"];
  primaryArtifactRefs?: string[];
  sourceNotices?: string[];
}
export interface CompletionTurn { binding_id: string; context_json: string; decision_json: string | null; state: string; attempts: number; retry_at: number; error: string | null }
export interface WorkCompletionOptions {
  db: Database.Database; works: WorkService; isAuthority: () => boolean;
  preferences?: (taskId: string) => string;
  review: (input: WorkResultTurnInput) => Promise<WorkResultDecision>;
  deliver: (input: WorkCompletionDelivery) => boolean; wake: () => void;
}
/** Independent result lane: delivery commits before closure, retries never resubmit business work. */
export class WorkCompletionCoordinator {
  private readonly active = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private recoveredAt = 0;
  constructor(private readonly options: WorkCompletionOptions) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS work_completion_turns (
      binding_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, decision_json TEXT,
      state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT)`);
  }
  start(): void { if (this.timer) return; this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake(); }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  wake(): void {
    if (this.closed || !this.options.isAuthority()) return;
    if (Date.now() - this.recoveredAt > 30000) {
      this.options.works.transaction(() => this.options.works.automaticCompletion.recoverUnreviewed());
      this.recoveredAt = Date.now();
    }
    // Older hosts left reviews running after recovery superseded their binding.
    // Reconcile only consumed reviews, never a paused or temporarily blocked one.
    this.options.db.prepare(`UPDATE work_completion_turns SET state='superseded',retry_at=0,error=NULL
      WHERE state IN ('queued','running') AND EXISTS (
        SELECT 1 FROM work_automatic_completion completion
        WHERE completion.binding_id=work_completion_turns.binding_id AND completion.consumed_at IS NOT NULL)`).run();
    for (const bindingId of this.options.works.automaticCompletion.pending()) {
      if (this.active.size >= 2) break;
      if (this.active.has(bindingId)) continue;
      const candidate = this.options.works.transaction(() => this.current(bindingId));
      if (!candidate) continue;
      const old = this.row(bindingId);
      if (old && (["delivered", "continued", "asking"].includes(old.state) || old.retry_at > Date.now())) continue;
      this.active.add(bindingId);
      void this.process(bindingId).catch(error => console.warn("[Bot] 结果交付稍后重试", bindingId, error))
        .finally(() => { this.active.delete(bindingId); });
    }
  }
  private row(bindingId: string): CompletionTurn | undefined {
    return this.options.db.prepare("SELECT * FROM work_completion_turns WHERE binding_id=?").get(bindingId) as CompletionTurn | undefined;
  }
  private temporalContext(bindingId: string) {
    const receipt = this.options.db.prepare("SELECT MAX(received_at) observed_at FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NOT NULL")
      .get(bindingId) as { observed_at: number | null };
    const tracked = this.options.db.prepare("SELECT recovered FROM work_automatic_completion WHERE binding_id=?").get(bindingId) as { recovered: number } | undefined;
    return { reviewAt: new Date().toISOString(), observedAt: receipt.observed_at == null ? null : new Date(receipt.observed_at).toISOString(),
      observedAtMeaning: "host_received_execution_receipt_not_source_measurement_time", historicalRecovery: Boolean(tracked?.recovered),
      freshExecution: false };
  }
  private current(bindingId: string) {
    const candidate = this.options.works.automaticCompletion.outcome(bindingId);
    if (!candidate) {
      const completion = this.options.db.prepare("SELECT consumed_at FROM work_automatic_completion WHERE binding_id=?")
        .get(bindingId) as { consumed_at: number | null } | undefined;
      const consumed = completion?.consumed_at != null;
      this.options.db.prepare(`UPDATE work_completion_turns SET state=?,retry_at=0,error=NULL
        WHERE binding_id=? AND (state='running' OR (? AND state='queued'))`)
        .run(consumed ? "superseded" : "queued", bindingId, Number(consumed));
    }
    return candidate;
  }
  private async process(bindingId: string): Promise<void> {
    const { works, db } = this.options;
    const candidate = works.transaction(() => this.current(bindingId));
    const binding = works.repo.getBinding(bindingId);
    if (!candidate || !binding || this.closed || !this.options.isAuthority()) return;
    const eventId = `completion:${bindingId}`;
    const snapshot = () => {
      const current = this.current(bindingId);
      const latestBinding = works.repo.getBinding(bindingId);
      if (!current || !latestBinding) return;
      const personalPreferences = this.options.preferences?.(binding.taskId) ?? "";
      const context = { ...completionEvidence(db, works, latestBinding, current),
        preferenceFingerprint: completionFingerprint(personalPreferences) };
      return { current, context, personalPreferences, fingerprint: completionFingerprint(context) };
    };
    const refresh = (latest: NonNullable<ReturnType<typeof snapshot>>) => {
      db.prepare(`INSERT INTO work_completion_turns(binding_id,context_json) VALUES (?,?)
        ON CONFLICT(binding_id) DO UPDATE SET context_json=excluded.context_json,decision_json=NULL,
        state='queued',attempts=0,retry_at=0,error=NULL`).run(bindingId, JSON.stringify({ ...latest.context,
          evidenceFingerprint: latest.fingerprint, temporalContext: this.temporalContext(bindingId) }));
    };
    const initial = works.transaction(snapshot);
    if (!initial) return;
    const old = this.row(bindingId);
    const { evidenceFingerprint: storedFingerprint, temporalContext: _temporal, ...storedContext } = old ? JSON.parse(old.context_json) : {};
    if (!old || storedFingerprint !== initial.fingerprint || completionFingerprint(storedContext) !== storedFingerprint) refresh(initial);
    const row = this.row(bindingId)!;
    const frozenFingerprint: string = JSON.parse(row.context_json).evidenceFingerprint;
    let phase: "review" | "application" | "delivery" = "review";
    try {
      let decision: WorkResultDecision;
      if (row.decision_json) decision = resultDecisionSchema.parse(JSON.parse(row.decision_json));
      else {
        // A progress notification failure must not consume a semantic review attempt.
        try { this.options.deliver({ bindingId, eventId: `${eventId}:progress`, category: "progress",
          text: this.temporalContext(bindingId).historicalRecovery
            ? "正在整理此前执行的历史结果，没有重新执行任务。你可以继续交代其他事情。"
            : "后台结果已返回，我正在对照你的委托整理结论。你可以继续交代其他事情。" }); }
        catch (error) { console.warn("[Bot] 整理进度通知待恢复", bindingId, error); }
        const attempt = row.state === "running" ? Math.max(1, row.attempts) : row.attempts + 1;
        db.prepare("UPDATE work_completion_turns SET state='running',attempts=? WHERE binding_id=?").run(attempt, bindingId);
        decision = resultDecisionSchema.parse(await this.options.review({
          eventId: `${eventId}:review:${attempt}:${initial.context.preferenceFingerprint}:${frozenFingerprint}`,
          botId: binding.botId, personalPreferences: initial.personalPreferences,
          context: { ...initial.context, temporalContext: this.temporalContext(bindingId) },
        }));
      }
      if (this.closed || !this.options.isAuthority()) return;
      phase = "application";
      // Persist a valid review independently of delivery. Reuse it only against its exact inputs.
      const saved = works.transaction(() => {
        const latest = snapshot();
        if (!latest) return false;
        if (latest.fingerprint !== frozenFingerprint) { refresh(latest); return false; }
        db.prepare("UPDATE work_completion_turns SET decision_json=?,error=NULL WHERE binding_id=?").run(JSON.stringify(decision), bindingId);
        return true;
      });
      if (!saved) return;
      works.transaction(() => {
        const latest = snapshot();
        if (!latest) return;
        if (latest.fingerprint !== frozenFingerprint) { refresh(latest); return; }
        applyCompletionDecision(this.options, binding, latest.current.work, decision, eventId);
      });
    } catch (error) {
      if (this.closed || !this.options.isAuthority()) return;
      if (error instanceof CompletionDeliveryError) phase = "delivery";
      const lifecycle = error instanceof WorkResultLifecycleError;
      const failurePhase = lifecycle ? `runtime:${error.phase}` : phase;
      const message = error instanceof Error ? error.message : String(error);
      try { recordCollaborationReturnFailure(db, candidate.work.userId, binding.workId, error, phase === "review" ? "review" : phase); }
      catch (recordError) { console.warn("[Work] 协作成果失败回执待重试", binding.workId, recordError); }
      works.transaction(() => {
        if (!this.current(bindingId)) return;
        db.prepare("UPDATE work_completion_turns SET state=?,retry_at=?,error=? WHERE binding_id=?")
          .run(lifecycle ? "running" : "queued", Date.now() + 15000, `${failurePhase}: ${message}`, bindingId);
      });
      // Application and local delivery failures retain the decision and its attempt.
      // Only actual model/format failures use the bounded raw-result fallback.
      if (phase !== "review" || lifecycle || this.row(bindingId)?.decision_json) return;
      works.transaction(() => {
        if (!this.current(bindingId)) return;
        const exhausted = (this.row(bindingId)?.attempts ?? 0) >= 2;
        const historical = this.temporalContext(bindingId).historicalRecovery;
        const fallbackFiles = workDeliveryFiles(works, workDeliveryResults(works, binding)).filter(file => file.openPath);
        const delivered = this.options.deliver({ bindingId, eventId: `${eventId}:fallback:${exhausted ? "final" : "retrying"}`, category: "result",
          text: `${historical ? "历史执行结果" : "执行结果"}已保留，但还没能整理出可靠结论，目标是否达成尚未核实。${fallbackFiles.length ? "你可以先打开下方已登记的文件；" : ""}原始报告保留在执行详情里。`,
          completion: { outcome: "unknown", nextStep: "deliver" },
          notices: [...historical ? ["这是历史记录，未重新执行或核实当前状态。"] : [], ...(exhausted ? [] : ["正在重试整理，不会重跑业务任务。"])],
          sourceNotices: [message, ...candidate.conclusion === "ended_unsuccessfully" ? [candidate.summary] : []] });
        if (exhausted && delivered) {
          works.automaticCompletion.recordDelivery(bindingId, "已交付原始执行结果；结果整理失败，未将其冒充独立核验。", "unknown");
          works.automaticCompletion.drain();
          db.prepare("UPDATE work_completion_turns SET state='delivered' WHERE binding_id=?").run(bindingId);
        }
      });
    }
  }
}
