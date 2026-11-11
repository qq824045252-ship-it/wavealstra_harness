import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkService } from "./WorkService";
import type { WorkResultDecision, WorkResultTurnInput } from "./BotWorkResultTurn";
import { completionMilestoneEvidence } from "./WorkCompletionMilestoneEvidence";
import { applyCompletionDecision } from "./WorkCompletionDecision";
import { workDeliveryFiles, workDeliveryResults } from "./WorkDeliveryArtifacts";
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
/** Exact registered immutable snapshots only. Content is untrusted evidence,
 * never reviewer instructions. Both file IO and total model text are bounded. */
export interface CompletionArtifactEvidence {
  ref: string; name: string; trust: "untrusted_artifact_content";
  registeredDigest?: string; registeredSizeBytes?: number;
  state: string; omittedEvidenceCount?: number; reason?: string; text?: string; truncated?: boolean; placeholderIndicators?: string[];
}
export function completionArtifactEvidence(works: WorkService, binding: Parameters<typeof workDeliveryResults>[1]): CompletionArtifactEvidence[] {
  const registered = works.generatedArtifacts.list(binding.workId);
  let remaining = 48000;
  const files = workDeliveryFiles(works, workDeliveryResults(works, binding));
  return files.slice(0, 20).map((file, index) => {
    const artifact = file.openPath ? registered.find(item => item.snapshotPath === file.ref) : undefined;
    const base = { ref: file.ref, name: file.name, ...(index === 0 && files.length > 20 ? { omittedEvidenceCount: files.length - 20 } : {}), trust: "untrusted_artifact_content" as const,
      registeredDigest: artifact?.digest, registeredSizeBytes: artifact?.sizeBytes };
    if (!artifact?.snapshotPath) return { ...base, state: "unavailable", reason: "No immutable registered snapshot" };
    if (remaining <= 0) return { ...base, state: "unavailable", reason: "Review text budget exhausted" };
    let fd: number | undefined;
    try {
      fd = openSync(artifact.snapshotPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 1024 * 1024) return { ...base, state: "unavailable", reason: "Not a regular file or exceeds 1 MiB inspection limit" };
      const bytes = Buffer.alloc(stat.size + 1);
      let length = 0, read = 0;
      while (length < bytes.length && (read = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += read;
      const content = bytes.subarray(0, length);
      const digest = createHash("sha256").update(content).digest("hex");
      if (length !== artifact.sizeBytes || digest !== artifact.digest) return { ...base, state: "changed", reason: "Snapshot bytes do not match registration" };
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
      catch { return { ...base, state: "unavailable", reason: "Binary or unsupported text encoding" }; }
      if (text.includes("\0")) return { ...base, state: "unavailable", reason: "Binary content requires separate verification" };
      const limit = Math.min(12000, remaining);
      const excerpt = text.slice(0, limit); remaining -= excerpt.length;
      return { ...base, state: text.trim() ? "text" : "empty", text: excerpt, truncated: text.length > excerpt.length,
        // Indicators are not a blanket verdict: the user may have requested a template.
        placeholderIndicators: [...new Set(text.match(/\b(?:TODO|TBD|PLACEHOLDER|LOREM IPSUM)\b|待填写|待补充|占位/gi) ?? [])].slice(0, 12) };
    } catch { return { ...base, state: "unavailable", reason: "Registered snapshot cannot be read" }; }
    finally { if (fd !== undefined) closeSync(fd); }
  });
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
  private questions(workId: string) {
    return this.options.works.repo.listOpenBlockers(workId)
      .filter(item => item.waitingForUserInput && item.kind === "operational" && !item.unknownExternalEffectRef)
      .map(item => ({blockerId:item.blockerId,reason:item.reason})).sort((a,b)=>a.blockerId.localeCompare(b.blockerId));
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
    const results = workDeliveryResults(works, binding);
    const availableFiles = workDeliveryFiles(works, results).filter(file => file.openPath).map(({ref, name}) => ({ref, name}));
    const artifactEvidence = completionArtifactEvidence(works, binding);
    const milestoneDeliveryEvidence = completionMilestoneEvidence(db, binding);
    const eventId = `completion:${bindingId}`;
    const personalPreferences = this.options.preferences?.(binding.taskId) ?? "";
    const preferenceFingerprint = createHash("sha256").update(personalPreferences).digest("hex");
    if (!this.row(bindingId)) {
      const source = JSON.parse(works.repo.executionInput(binding));
      // Execution recipes (including team report JSON instructions) are not the
      // user's request. Feeding them back to the judge can override its schema.
      const { teamAssignment: _teamAssignment, instructions: _instructions, ...originalRequest } = source;
      db.prepare("INSERT OR IGNORE INTO work_completion_turns(binding_id,context_json) VALUES (?,?)").run(bindingId, JSON.stringify({
        temporalContext: this.temporalContext(bindingId), preferenceFingerprint,
        originalRequest, title: candidate.work.title, goal: candidate.work.goalDescription,
        results: results.map(item => ({ summary: item.summary, artifactRefs: item.artifactRefs, uncoveredScope: item.uncoveredScope })),
        availableFiles, artifactEvidence, milestoneDeliveryEvidence,
        previousResults: works.repo.listDeliverables(binding.workId).filter(item => item.executionId !== bindingId
          && item.intentRevision === binding.intentRevision && item.inputSnapshotId === binding.inputSnapshotId && item.status !== "superseded")
          .map(item => ({ executionId:item.executionId, summary:item.summary, artifactRefs:item.artifactRefs, uncoveredScope:item.uncoveredScope, status:item.status })),
        // These are observations, not a verdict that the original request failed.
        executionFacts: { status: binding.status, outputReceived: candidate.executionDelivered,
          diagnosticSummary: candidate.summary },
        criteria: candidate.work.criteria,
        continuationScope: binding.delegatedScope,
        teamContinuationTargets: works.teams.continuationTargets(binding),
        pendingQuestions: this.questions(binding.workId),
        actualMissing: works.partialResults.gaps(binding.workId).map(item => ({task:item.task, summary:item.summary, outcome:item.outcome})),
        unknownEffects: works.repo.listAdmissions(binding.workId).filter(item => item.state === "unknown").map(item => item.operationId),
      }));
    }
    let row = this.row(bindingId)!;
    if (JSON.parse(row.context_json).preferenceFingerprint !== preferenceFingerprint
      || JSON.stringify(JSON.parse(row.context_json).milestoneDeliveryEvidence) !== JSON.stringify(milestoneDeliveryEvidence)
      || JSON.stringify(JSON.parse(row.context_json).artifactEvidence) !== JSON.stringify(artifactEvidence)) {
      db.prepare("UPDATE work_completion_turns SET context_json=?,decision_json=NULL,state='queued',retry_at=0 WHERE binding_id=?")
        .run(JSON.stringify({...JSON.parse(row.context_json),preferenceFingerprint,artifactEvidence,milestoneDeliveryEvidence}),bindingId);
      row = this.row(bindingId)!;
    }
    try {
      let decision: WorkResultDecision;
      if (row.decision_json) decision = JSON.parse(row.decision_json);
      else {
        this.options.deliver({ bindingId, eventId: `${eventId}:progress`, category: "progress", text: this.temporalContext(bindingId).historicalRecovery
          ? "正在整理此前执行的历史结果，没有重新执行任务。你可以继续交代其他事情。"
          : "后台结果已返回，我正在对照你的委托整理结论。你可以继续交代其他事情。" });
        const attempt = row.state === "running" ? Math.max(1,row.attempts) : row.attempts + 1;
        db.prepare("UPDATE work_completion_turns SET state='running',attempts=? WHERE binding_id=?").run(attempt,bindingId);
        const reviewContext = JSON.parse(row.context_json);
        // Also sanitize persisted turns written by an older host.
        const { teamAssignment: _teamAssignment, instructions: _instructions, ...originalRequest } = reviewContext.originalRequest ?? {};
        decision = await this.options.review({ eventId: `${eventId}:review:${attempt}:${preferenceFingerprint}:${createHash("sha256").update(JSON.stringify(milestoneDeliveryEvidence)).digest("hex")}`, botId: binding.botId, personalPreferences, context: {...reviewContext, originalRequest, temporalContext: this.temporalContext(bindingId)} });
      }
      if (this.closed || !this.options.isAuthority()) return;
      const latestArtifactEvidence = completionArtifactEvidence(works, binding);
      works.transaction(() => {
        const current = this.current(bindingId);
        if (!current) return;
        const latestMilestoneDeliveryEvidence = completionMilestoneEvidence(db, binding);
        const deliveryResults = workDeliveryResults(works, binding);
        const latestResults = deliveryResults.map(item => ({summary:item.summary,artifactRefs:item.artifactRefs,uncoveredScope:item.uncoveredScope}));
        const latestFiles = workDeliveryFiles(works, deliveryResults).filter(file => file.openPath).map(({ref,name}) => ({ref,name}));
        const frozen = JSON.parse(row.context_json);
        const pendingQuestions = this.questions(binding.workId);
        const latestPreferences = this.options.preferences?.(binding.taskId) ?? "";
        const latestPreferenceFingerprint = createHash("sha256").update(latestPreferences).digest("hex");
        if (latestPreferenceFingerprint !== preferenceFingerprint
          || JSON.stringify(latestMilestoneDeliveryEvidence) !== JSON.stringify(frozen.milestoneDeliveryEvidence)
          || JSON.stringify(latestArtifactEvidence) !== JSON.stringify(frozen.artifactEvidence)
          || JSON.stringify(latestResults) !== JSON.stringify(frozen.results)
          || JSON.stringify(latestFiles) !== JSON.stringify(frozen.availableFiles ?? [])
          || JSON.stringify(works.teams.continuationTargets(binding)) !== JSON.stringify(frozen.teamContinuationTargets)
          || JSON.stringify(pendingQuestions) !== JSON.stringify(frozen.pendingQuestions ?? [])) {
          db.prepare("UPDATE work_completion_turns SET context_json=?,decision_json=NULL,state='queued',retry_at=0 WHERE binding_id=?")
            .run(JSON.stringify({...frozen,preferenceFingerprint:latestPreferenceFingerprint,results:latestResults,availableFiles:latestFiles,artifactEvidence:latestArtifactEvidence,milestoneDeliveryEvidence:latestMilestoneDeliveryEvidence,pendingQuestions,teamContinuationTargets:works.teams.continuationTargets(binding),actualMissing:current.conclusion === "succeeded" ? [] : [current.summary]}),bindingId);
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
