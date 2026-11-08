import type Database from "better-sqlite3";
import type { WorkDto } from "../../../shared/bot-work";
import { BotConversationRepository } from "./BotConversationRepository";
import type { WorkService } from "./WorkService";

export interface WorkConversationFeedbackOptions {
  db: Database.Database;
  userId: string;
  works: WorkService;
  isAuthority: () => boolean;
  pollIntervalMs?: number;
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
        const origin = this.messages.workOrigin(userId, work.workId);
        if (!origin) return 0; // Never guess an active conversation as a fallback.
        let count = 0;
        const emit = (event: string, version: unknown, body: string) => {
          if (this.messages.appendWorkFeedback(origin, work.workId, event, JSON.stringify(version), `【${work.title}】\n${body}`)) count++;
        };
        for (const binding of works.repo.listBindings(work.workId)) {
          if (!["completed", "failed", "stopped", "invalidated", "unknown"].includes(binding.status)) continue;
          const labels: Record<string, string> = { completed: "后台执行已结束，成果仍需核验；不代表用户已验收。",
            failed: "后台执行失败，事项尚未因此完成。", stopped: "后台执行已停止。",
            invalidated: "该后台执行已失效，其结果不能作为当前事项完成的依据。", unknown: "后台执行结果暂不确定，需要核对。" };
          emit(`binding:${binding.bindingId}`, [binding.status, binding.settlementNote ?? null, binding.settledAt ?? null],
            [labels[binding.status], binding.settlementNote].filter(Boolean).join("\n"));
        }
        for (const result of works.repo.listDeliverables(work.workId)) {
          const current = result.intentRevision === work.intentRevision && result.inputSnapshotId === work.inputSnapshotId;
          const review = { proposed: "待负责人核验", accepted: "负责人核验通过", rejected: "未通过负责人核验", superseded: "已被后续成果替代" }[result.status];
          const label = !current ? "历史执行成果（不代表当前要求已完成）" : "后台成果（不代表用户已验收）";
          emit(`result:${result.deliverableId}`, [result, current],
            `${label}，${review}\n${result.summary}${result.artifactRefs.length ? `\n成果：${result.artifactRefs.join("\n")}` : ""}`
            + `${result.uncoveredScope.length ? `\n尚未覆盖：${result.uncoveredScope.join("；")}` : ""}`
            + `${result.isSpeculation ? "\n该成果包含推测，仍需验证。" : ""}`
            + `${result.hasWriteConflicts ? "\n存在写入冲突，仍需处理。" : ""}`
            + `${result.rejectedReason ? `\n未通过核验：${result.rejectedReason}` : ""}`);
        }
        for (const blocker of works.repo.listBlockers(work.workId)) {
          emit(`blocker:${blocker.blockerId}`, blocker,
            blocker.status === "open"
              ? `后台事项受阻：${blocker.reason}\n${blocker.waitingForUserInput ? "需要你的输入或决定后才能继续。" : "需要进一步处理，事项尚未完成。"}`
              : `阻塞已解除：${blocker.reason}`);
        }
        if (work.lifecycle === "closed") {
          emit("closure", [work.closedAt, work.closureConclusion, work.closureSummary],
            `事项已关闭（${work.closureConclusion ?? "已结束"}）。${work.closureSummary ? `\n${work.closureSummary}` : ""}\n关闭状态不等同于用户验收。`);
        }
        return count;
      }); } catch (error) {
        // A broken Work must not starve feedback for every other original chat.
        console.warn("[Work] 原对话反馈待重试", candidate.workId, error);
      }
    }
    return inserted;
  }
}
