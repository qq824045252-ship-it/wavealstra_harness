import type Database from "better-sqlite3";
import type { WorkService } from "./WorkService";
import type { WorkResultDecision, WorkResultTurnInput } from "./BotWorkResultTurn";
import { applyCompletionDecision } from "./WorkCompletionDecision";

export interface WorkCompletionDelivery {
  bindingId: string; eventId: string; text: string; category: "progress" | "result" | "decision"; notices?: string[];
}
export interface CompletionTurn { binding_id: string; context_json: string; decision_json: string | null; state: string; attempts: number; retry_at: number; error: string | null }
export interface WorkCompletionOptions {
  db: Database.Database; works: WorkService; isAuthority: () => boolean;
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
    for (const bindingId of this.options.works.automaticCompletion.pending()) {
      if (this.active.size >= 2) break;
      if (this.active.has(bindingId)) continue;
      const candidate = this.options.works.transaction(() => this.options.works.automaticCompletion.outcome(bindingId));
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
  private questions(workId: string) {
    return this.options.works.repo.listOpenBlockers(workId)
      .filter(item => item.waitingForUserInput && item.kind === "operational" && !item.unknownExternalEffectRef)
      .map(item => ({blockerId:item.blockerId,reason:item.reason})).sort((a,b)=>a.blockerId.localeCompare(b.blockerId));
  }
  private current(bindingId: string) { return this.options.works.automaticCompletion.outcome(bindingId); }
  private async process(bindingId: string): Promise<void> {
    const { works, db } = this.options;
    const candidate = works.transaction(() => this.current(bindingId));
    const binding = works.repo.getBinding(bindingId);
    if (!candidate || !binding || this.closed || !this.options.isAuthority()) return;
    const results = works.repo.listDeliverables(binding.workId).filter(item => item.executionId === bindingId && item.status !== "superseded");
    const raw = results.map(item => item.summary).filter(Boolean).join("\n\n");
    const eventId = `completion:${bindingId}`;
    if (!this.row(bindingId)) {
      const source = JSON.parse(works.repo.executionInput(binding));
      // Execution recipes (including team report JSON instructions) are not the
      // user's request. Feeding them back to the judge can override its schema.
      const { teamAssignment: _teamAssignment, instructions: _instructions, ...originalRequest } = source;
      db.prepare("INSERT OR IGNORE INTO work_completion_turns(binding_id,context_json) VALUES (?,?)").run(bindingId, JSON.stringify({
        originalRequest, title: candidate.work.title, goal: candidate.work.goalDescription,
        results: results.map(item => ({ summary: item.summary, artifactRefs: item.artifactRefs, uncoveredScope: item.uncoveredScope })),
        previousResults: works.repo.listDeliverables(binding.workId).filter(item => item.executionId !== bindingId
          && item.intentRevision === binding.intentRevision && item.inputSnapshotId === binding.inputSnapshotId && item.status !== "superseded")
          .map(item => ({ executionId:item.executionId, summary:item.summary, artifactRefs:item.artifactRefs, uncoveredScope:item.uncoveredScope, status:item.status })),
        // These are observations, not a verdict that the original request failed.
        executionFacts: { status: binding.status, outputReceived: candidate.executionDelivered,
          diagnosticSummary: candidate.summary },
        criteria: candidate.work.criteria,
        continuationScope: binding.delegatedScope,
        pendingQuestions: this.questions(binding.workId),
        actualMissing: works.partialResults.gaps(binding.workId).map(item => ({task:item.task, summary:item.summary, outcome:item.outcome})),
        unknownEffects: works.repo.listAdmissions(binding.workId).filter(item => item.state === "unknown").map(item => item.operationId),
      }));
    }
    const row = this.row(bindingId)!;
    try {
      let decision: WorkResultDecision;
      if (row.decision_json) decision = JSON.parse(row.decision_json);
      else {
        this.options.deliver({ bindingId, eventId: `${eventId}:progress`, category: "progress", text: "后台结果已返回，我正在对照你的委托整理结论。你可以继续交代其他事情。" });
        const attempt = row.state === "running" ? Math.max(1,row.attempts) : row.attempts + 1;
        db.prepare("UPDATE work_completion_turns SET state='running',attempts=? WHERE binding_id=?").run(attempt,bindingId);
        const reviewContext = JSON.parse(row.context_json);
        // Also sanitize persisted turns written by an older host.
        const { teamAssignment: _teamAssignment, instructions: _instructions, ...originalRequest } = reviewContext.originalRequest ?? {};
        decision = await this.options.review({ eventId: `${eventId}:review:${attempt}`, botId: binding.botId, context: {...reviewContext, originalRequest} });
      }
      if (this.closed || !this.options.isAuthority()) return;
      works.transaction(() => {
        const current = this.current(bindingId);
        if (!current) return;
        const latestResults = works.repo.listDeliverables(binding.workId).filter(item => item.executionId === bindingId && item.status !== "superseded")
          .map(item => ({summary:item.summary,artifactRefs:item.artifactRefs,uncoveredScope:item.uncoveredScope}));
        const frozen = JSON.parse(row.context_json);
        const pendingQuestions = this.questions(binding.workId);
        if (JSON.stringify(latestResults) !== JSON.stringify(frozen.results)
          || JSON.stringify(pendingQuestions) !== JSON.stringify(frozen.pendingQuestions ?? [])) {
          db.prepare("UPDATE work_completion_turns SET context_json=?,decision_json=NULL,state='queued',retry_at=0 WHERE binding_id=?")
            .run(JSON.stringify({...frozen,results:latestResults,pendingQuestions,actualMissing:current.conclusion === "succeeded" ? [] : [current.summary]}),bindingId);
          return; // A late result must not be guided by a decision on older evidence.
        }
        db.prepare("UPDATE work_completion_turns SET decision_json=?,error=NULL WHERE binding_id=?").run(JSON.stringify(decision), bindingId);
        applyCompletionDecision(this.options, binding, current.work, decision, eventId);
      });
    } catch (error) {
      if (this.closed || !this.options.isAuthority()) return;
      const message = error instanceof Error ? error.message : String(error);
      works.transaction(() => {
        if (!this.current(bindingId)) return;
        const exhausted = (this.row(bindingId)?.attempts ?? 0) >= 2;
        db.prepare("UPDATE work_completion_turns SET state='queued',retry_at=?,error=? WHERE binding_id=?").run(Date.now() + 15000, message, bindingId);
        const delivered = this.options.deliver({ bindingId, eventId: `${eventId}:fallback:${exhausted ? "final" : "retrying"}`, category: "result", text: raw || "后台没有返回可用的结果正文。",
          notices: [exhausted ? "结果整理未能完成，先交付真实执行结果；没有重跑业务任务。" : "结果整理暂时失败，先交付真实执行结果；正在重试整理，不会重跑业务任务。", message, ...candidate.conclusion === "ended_unsuccessfully" ? [candidate.summary] : []] });
        if (exhausted && delivered) {
          works.automaticCompletion.recordDelivery(bindingId, "已交付原始执行结果；结果整理失败，未将其冒充独立核验。", "unknown");
          works.automaticCompletion.drain();
          db.prepare("UPDATE work_completion_turns SET state='delivered' WHERE binding_id=?").run(bindingId);
        }
      });
    }
  }
}
