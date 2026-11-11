import { watchObservationDelivery, watchReadEvidence } from "./WorkWatchObservation";
import type { WorkCompletionDelivery } from "./WorkCompletionCoordinator";
import { watchEndedByTime } from "../../../shared/work-watch-expiry";
import type Database from "better-sqlite3";
import type { WorkFeedbackDto } from "../../../shared/bot-conversation";
import type { WorkDto } from "../../../shared/bot-work";
import { BotConversationRepository } from "./BotConversationRepository";
import { projectTeamReport } from "./WorkReportPresentation";
import { workDeliveryFiles, workDeliveryResults } from "./WorkDeliveryArtifacts";
import type { WorkService } from "./WorkService";

export interface WorkConversationFeedbackOptions {
  db: Database.Database;
  userId: string;
  works: WorkService;
  isAuthority: () => boolean;
  pollIntervalMs?: number;
  superviseWatch?: boolean;
  prepareImages?: (workId: string) => Promise<void>;
}

/** Durable facts are replayable inputs; completed Bot messages are atomic delivery
 * receipts. No native submission, model turn, user acceptance or Work mutation.
 * Recovery also scans closed Works and archived originating conversations.
 */
export class WorkConversationFeedback {
  readonly messages: BotConversationRepository;
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly options: WorkConversationFeedbackOptions) {
    this.messages = new BotConversationRepository(options.db);
  }

  /** Start the retry loop before recovery so a transient startup failure cannot
   * leave persisted facts stranded until an unrelated Work changes. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.drain(), Math.max(10, this.options.pollIntervalMs ?? 2000));
    this.timer.unref();
    this.recover();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  recover(): number { return this.drain(); }

  drain(workId?: string): number {
    try { return this.drainPending(workId); }
    catch (error) {
      // Feedback must never turn an already committed Work operation into a
      // reported failure. Durable source facts remain available on the next tick.
      console.warn("[Work] 原对话反馈待重试", workId ?? "recovery", error);
      return 0;
    }
  }

  /** Exact event delivery, used by the independent result-processing lane. */
  deliverCompletion(input: WorkCompletionDelivery): boolean {
    if (!this.options.isAuthority()) return false;
    const { works, userId } = this.options;
    return works.transaction(() => {
      const binding = works.repo.getBinding(input.bindingId);
      const work = binding && works.getWork(binding.workId);
      if (!binding || !work || work.userId !== userId || binding.intentRevision !== work.intentRevision
        || binding.inputSnapshotId !== work.inputSnapshotId || binding.ownerEpoch !== work.ownerEpoch) return false;
      const results = workDeliveryResults(works, binding);
      const files = workDeliveryFiles(works, results);
      const refs = [...new Set(files.map(file => file.ref))];
      const ownResults = results.filter(item => item.executionId === binding.bindingId);
      const raw = ownResults.map(item => item.summary).join("\n\n") || binding.settlementNote || "没有可用结果正文";
      const result = ownResults.at(-1);
      const primaryArtifactRefs = input.primaryArtifactRefs === undefined ? undefined
        : [...new Set(input.primaryArtifactRefs.filter(ref => files.some(file => file.ref === ref && file.openPath)))];
      const metadata: WorkFeedbackDto = { workId: work.workId, eventId: input.eventId,
        kind: input.category === "progress" ? "binding" : "result", category: input.category,
        executionId: binding.bindingId, intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
        ...(input.category === "progress" ? {} : { report: {
          title: work.title, summary: input.text, artifactRefs: refs, reviewStatus: result?.status ?? "proposed", current: true,
          ...(input.completion ? { completion: input.completion } : {}),
          ...(primaryArtifactRefs ? { primaryArtifactRefs } : {}),
          ...(input.completion ? { sourceNotices: [...new Set(results.flatMap(item => item.uncoveredScope))] } : {}),
          ...projectTeamReport(raw, works.repo.reportContext(binding)),
          notices: [...input.notices ?? [], ...input.completion ? [] : results.flatMap(item => item.uncoveredScope),
            ...results.some(item => item.hasWriteConflicts) ? ["成果存在写入冲突"] : [],
            ...results.some(item => item.isSpeculation) ? ["部分结论尚未验证"] : []],
          files,
        } }),
      };
      const text = `【${work.title}】\n${input.text}${input.category !== "progress" && raw !== input.text ? `\n\n原始执行记录：\n${raw}` : ""}`;
      return this.messages.appendWorkDelivery(userId, work.workId, input.eventId, JSON.stringify([input.text,input.notices ?? [],refs,input.completion ?? null,primaryArtifactRefs ?? null]), text, metadata).delivered;
    });
  }

  private drainPending(workId?: string): number {
    if (!this.options.isAuthority()) return 0;
    const { works, userId } = this.options;
    const candidates = workId ? [works.getWork(workId)].filter((work): work is WorkDto => !!work)
      : works.repo.listWorks(userId, { includeClosed: true });
    let inserted = 0;
    for (const candidate of candidates) {
      try { inserted += works.transaction(() => {
        if (!this.options.isAuthority()) return 0;
        const work = works.getWork(candidate.workId);
        if (!work || work.userId !== userId) return 0;
        const origin = this.messages.resolveWorkDelivery(userId, work.workId);
        if (!origin) return 0; // Never guess an active conversation as a fallback.
        const managed = (bindingId: string) => (this.options.superviseWatch && work.mode === "watch"
          && (() => {
            const binding = works.repo.getBinding(bindingId);
            if (!binding) return false;
            // Team member observations remain in the Work detail. The owner
            // delivers one coherent round, including any partial failures.
            if (binding.botId !== work.ownerBotId && works.teams.get(work.workId)) return true;
            if (binding.botId !== work.ownerBotId || !["completed", "failed", "stopped"].includes(binding.status)) return false;
            const table = this.options.db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_watch_reviews'").get();
            if (table && this.options.db.prepare("SELECT 1 FROM work_watch_reviews WHERE binding_id=? AND state IN ('delivered','silent')").get(bindingId)) return true;
            return ["active", "paused", "closing"].includes(work.lifecycle) && !binding.invalidatedAt
              && binding.intentRevision === work.intentRevision && binding.inputSnapshotId === work.inputSnapshotId
              && binding.ownerEpoch === work.ownerEpoch;
          })()) || work.mode === "once"
          && (work.lifecycle === "active" || work.closeOperationId?.startsWith("automatic-completion:"))
          && works.automaticCompletion.tracked(bindingId)
          && works.repo.getBinding(bindingId)?.botId === work.ownerBotId;
        let count = 0;
        const emit = (event: string, version: unknown, body: string, metadata: Omit<WorkFeedbackDto, "workId" | "eventId">) => {
          if (this.messages.appendWorkFeedback(origin, work.workId, event, JSON.stringify(version), `【${work.title}】\n${body}`, { ...metadata, workId: work.workId, eventId: event })) count++;
        };
        const results = works.repo.listDeliverables(work.workId);
        const generated = works.generatedArtifacts.list(work.workId, true);
        const completed = new Set(works.repo.listBindings(work.workId).filter(b => b.status === "completed").map(b => b.bindingId));
        const watchResults = results.filter(r => completed.has(r.executionId));
        const delivery = (result: typeof results[number]) => completed.has(result.executionId)
          ? watchObservationDelivery(work, result, watchResults, item => watchReadEvidence(this.options.db, works.repo.getBinding(item.executionId), item)) : { silent: false, summary: result.summary };
        const memberBindings = new Set((this.options.db.prepare(`SELECT b.binding_id FROM work_team_executions e
          JOIN work_execution_bindings b ON b.work_id=e.work_id AND b.task_id=e.task_id
          WHERE e.work_id=? AND e.role='member'`).all(work.workId) as Array<{ binding_id: string }>).map(row => row.binding_id));
        for (const binding of works.repo.listBindings(work.workId)) {
          if (!["completed", "failed", "stopped", "invalidated", "unknown"].includes(binding.status) || managed(binding.bindingId)) continue;
          const watchResult = results.find(r => r.deliverableId === `result:${binding.bindingId}`);
          // A scheduled observation has one user-facing result, not a separate
          // "result returned" progress bubble. Quiet checks have neither.
          if (watchResult && binding.status === "completed" && work.mode === "watch"
            && work.watchRule?.notificationMode === "changes_only") continue;
          const labels: Record<string, string> = { completed: "后台结果已返回。",
            failed: "后台执行失败，事项尚未因此完成。", stopped: "后台执行已停止。",
            invalidated: "该后台执行已失效，其结果不能作为当前事项完成的依据。", unknown: "后台执行结果暂不确定，需要核对。" };
          // The execution note and deliverable often originate from the same
          // native observation. Keep both durable facts, but report its body once.
          // Only the exact aggregate Inbox result can replace an identical body.
          // Partial results and distinct/unknown terminal diagnostics are retained.
          const hasResult = binding.status === "completed" && results.some(result => result.deliverableId === `result:${binding.bindingId}`
            && result.executionId === binding.bindingId && result.ownerEpoch === binding.ownerEpoch
            && result.intentRevision === binding.intentRevision && result.inputSnapshotId === binding.inputSnapshotId
            && result.summary === binding.settlementNote);
          emit(`binding:${binding.bindingId}`, [binding.status, binding.settlementNote ?? null, binding.settledAt ?? null],
            [labels[binding.status], hasResult ? undefined : binding.settlementNote].filter(Boolean).join("\n"),
            { kind: "binding", category: "progress",
              executionId: binding.bindingId, intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId });
        }
        for (const result of results) {
          if (managed(result.executionId)) continue;
          const presentationResult = delivery(result);
          if (presentationResult.silent) continue;
          const current = result.intentRevision === work.intentRevision && result.inputSnapshotId === work.inputSnapshotId;
          let presentation: ReturnType<typeof projectTeamReport> = {};
          try {
            const binding = works.repo.getBinding(result.executionId);
            if (binding && binding.botId === result.producerBotId && binding.workId === work.workId && binding.intentRevision === result.intentRevision
              && binding.inputSnapshotId === result.inputSnapshotId && binding.ownerEpoch === result.ownerEpoch)
              presentation = projectTeamReport(result.summary, works.repo.reportContext(binding));
          } catch { /* Missing historical context falls back to the unchanged report. */ }

          const review = { proposed: "结果已返回", accepted: "已采纳", rejected: "未采纳", superseded: "已被后续成果替代" }[result.status];
          const label = !current ? "历史执行成果（不代表当前要求已完成）" : "后台成果";
          emit(`result:${result.deliverableId}`, [result, current],
            `${label}，${review}\n${presentationResult.summary}${result.artifactRefs.length ? `\n成果：${result.artifactRefs.join("\n")}` : ""}`
            + `${result.uncoveredScope.length ? `\n尚未覆盖：${result.uncoveredScope.join("；")}` : ""}`
            + `${result.isSpeculation ? "\n该成果包含推测，仍需验证。" : ""}`
            + `${result.hasWriteConflicts ? "\n存在写入冲突，仍需处理。" : ""}`
            + `${result.rejectedReason ? `\n未通过核验：${result.rejectedReason}` : ""}`,
            { kind: "result", category: memberBindings.has(result.executionId) ? "progress" : "result", executionId: result.executionId,
              intentRevision: result.intentRevision, inputSnapshotId: result.inputSnapshotId,
              report: { title: work.title, summary: presentationResult.summary, artifactRefs: result.artifactRefs, ...presentation,
                files: result.artifactRefs.map(ref => {
                  const candidates = generated.filter(item => item.bindingId === result.executionId);
                  const sources = candidates.filter(item => item.path === ref);
                  const artifact = candidates.find(item => item.snapshotPath === ref) ?? (sources.length === 1 ? sources[0] : undefined);
                  return { ref, name: (artifact?.path ?? ref).split(/[\\/]/).pop() || ref, openPath: artifact?.snapshotPath ?? artifact?.path };
                }),
                reviewStatus: result.status, current, notices: [
                  ...result.uncoveredScope.length ? [`尚未覆盖：${result.uncoveredScope.join("；")}`] : [],
                  ...result.isSpeculation ? ["该成果包含推测，仍需验证。"] : [],
                  ...result.hasWriteConflicts ? ["存在写入冲突，仍需处理。"] : [],
                  ...result.rejectedReason ? [`未通过核验：${result.rejectedReason}`] : [],
                ] } });
        }
        for (const blocker of works.repo.listBlockers(work.workId)) {
          // Recovery and effect reconciliation are host work, not a request for
          // the user to approve another run. Preserve real information questions.
          const needsInput = blocker.waitingForUserInput && blocker.kind === "operational"
            && !blocker.unknownExternalEffectRef && (!blocker.reasonCode || blocker.reasonCode === "user-input")
            && !blocker.blockerId.startsWith("continuation:");
          // Routine recovery may clear many internal blockers in a single pass.
          // Their facts remain in Work history; don't send a message per cleanup.
          if (blocker.status !== "open" && !needsInput) continue;
          emit(`blocker:${blocker.blockerId}`, blocker,
            blocker.status === "open"
              ? `后台事项受阻：${blocker.reason}\n${needsInput ? "需要你补充信息后才能继续。" : "需要进一步处理，事项尚未完成。"}`
              : `阻塞已解除：${blocker.reason}`,
            { kind: "blocker", category: blocker.status === "open" && needsInput ? "decision" : "progress" });
        }
        if (work.lifecycle === "closing" && work.watchRule?.termination) {
          emit("watch-expiry", work.watchRule.termination, "持续追踪期限已到，已停止新的检查，正在结算在途执行并整理最后一轮汇报。", { kind: "binding", category: "progress" });
        }
        if (work.lifecycle === "closed" && (work.mode === "watch" || !works.repo.listBindings(work.workId).some(binding => managed(binding.bindingId)))) {
          emit("closure", [work.closedAt, work.closureConclusion, work.closureSummary],
            work.closeOperationId?.startsWith("watch-goal:") ? work.closureSummary || "持续委托已完成，后续不再检查。" : `事项已关闭（${watchEndedByTime(work) ? "到期结束" : work.closureConclusion ?? "已结束"}）。${work.closureSummary ? `\n${work.closureSummary}` : ""}\n关闭状态不等同于用户验收。`, { kind: "closure", category: "result" });
        }
        return count;
      });
        // File reads/materialization must run after all enclosing Work transactions.
        if (this.options.prepareImages) queueMicrotask(() => {
          void this.options.prepareImages!(candidate.workId).catch(error => console.warn("[Work] 报告图片待重试", error));
        });
      } catch (error) {
        // A broken Work must not starve feedback for every other original chat.
        console.warn("[Work] 原对话反馈待重试", candidate.workId, error);
      }
    }
    return inserted;
  }
}
