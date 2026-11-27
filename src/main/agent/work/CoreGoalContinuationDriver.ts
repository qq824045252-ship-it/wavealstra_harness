import { createHash } from "node:crypto";
import type { DurableBotSnapshot } from "../../../shared/durable-bot";
import type { GoalContinuationState } from "../../../shared/conversation-goal";
import { LOCAL_USER_ID } from "../../../shared/bot-work";
import type { CoreBusinessClient } from "../../platform/core-business-client";
import { RuntimeAuditUnknownOperationError } from "../../platform/runtime-audit";
import { normalizeGoalContinuationAttempts } from "../ConversationRuntimeData";

type Trigger = "settled" | "continued";
type GoalScope = { userId: string; taskId: string; workId: string };

export interface CoreGoalContinuationLedger {
  placementGuardVersion: number;
  activeClaimGuardVersion: number;
  intentRevision: number;
  stateVersion: number;
  ownerEpoch: number;
  attemptSerial: number;
  updatedAt: number;
  storeId: string;
  storeCommitSeq: number | null;
  canAdvance: boolean;
  state: GoalContinuationState;
}

export interface CoreGoalContinuationClaim extends GoalScope {
  status: "claimed";
  operationId: string;
  intentRevision: number;
  ownerEpoch: number;
  stateVersion: number;
  conversationId: number;
  storeId: string;
  sourceEntryId: number;
  hostGeneration: string;
  attempt: number;
  attemptSerial: number;
  maxAttempts: number;
  budget: number | null;
  tokensUsed: number;
  requestId: string;
  assistantMessageId: string;
}

export interface ActiveCoreGoalContinuation {
  taskId: string;
  workId: string;
  intentRevision: number;
  ownerEpoch: number;
  attemptSerial: number;
  conversationId: number;
  runTaskId: number;
  claimOperationId: string;
  hostGeneration: string;
  storeId: string;
}

export class CoreGoalContinuationRevokedError extends Error {
  constructor() { super("Goal 自动续跑的执行授权已失效"); }
}

export interface CoreGoalRuntimeWindow {
  snapshot: DurableBotSnapshot;
  storeId: string;
}

export type CoreGoalPlacement = "accepted" | "rejected" | "unknown";
export type CoreGoalContinuationDecision =
  | { status: "started" }
  | { status: "stopped"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "unknown" };

export interface CoreGoalContinuationOptions {
  getClient: () => Pick<CoreBusinessClient, "request" | "isClosed"> | undefined;
  hostGeneration: string;
  policy: () => { enabled: boolean; maxAttempts: number; tokenBudget: number | null };
  inspect: (taskId: string) => Promise<CoreGoalRuntimeWindow | undefined>;
  progressFingerprint: (taskId: string, workId: string, intentRevision: number) => Promise<string>;
  place: (claim: CoreGoalContinuationClaim, validate: () => Promise<boolean>) => Promise<CoreGoalPlacement>;
  canAdvance?: (taskId: string, workId: string) => boolean | Promise<boolean>;
  changed?: (taskId: string, workId: string) => void | Promise<void>;
}

type ClaimReply = CoreGoalContinuationClaim | { status: "stopped"; reason: string } | { status: "rejected"; code: string };
type ReportReply = { status: "reported"; state: GoalContinuationState } | { status: "rejected"; code: string };
type SettledEntry = { conversationId: number; entryId: number };

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function latestChatEntry(snapshot: DurableBotSnapshot): SettledEntry | undefined {
  const conversationId = positiveInteger(snapshot.conversationId);
  if (!conversationId) return;
  const message = snapshot.messages.filter(message => (message.role === "assistant" || message.role === "user") && !message.dotsProactive).at(-1);
  if (!message) return snapshot.historyBefore === undefined ? { conversationId, entryId: 0 } : undefined;
  const entryId = positiveInteger(message.entryId ?? /^durable-(\d+)$/.exec(message.id)?.[1]);
  if (entryId !== undefined) return { conversationId, entryId };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function skip(reason: string): CoreGoalContinuationDecision { return { status: "skipped", reason }; }

function trace(taskId: string, phase: string, detail?: unknown): void {
  if (process.env.MYBUDDY_ADMISSION_TRACE === "1") console.info("[CoreGoalContinuation]", taskId, phase, detail ?? "");
}

/** Core owns attempts and terminal receipts. The host only reads a live Pi window and places an authorized input. */
export class CoreGoalContinuationDriver {
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly pendingClaims = new Map<string, CoreGoalContinuationClaim>();
  private readonly unconfirmedClaims = new Set<string>();
  private disposed = false;

  constructor(private readonly options: CoreGoalContinuationOptions) {}

  onSettled(taskId: string, snapshot: DurableBotSnapshot, expectedGoalId?: string | null): void {
    if (this.disposed) return;
    const source = latestChatEntry(snapshot);
    if (!source || !source.entryId || !snapshot.outcome) {
      trace(taskId, "no_settle_source", { source, outcome: snapshot.outcome });
      return;
    }
    trace(taskId, "settled", { source, expectedGoalId, outcome: snapshot.outcome });
    void this.enqueue(taskId, async () => {
      const pending = this.pendingClaims.get(taskId);
      if (pending) {
        if (pending.conversationId !== source.conversationId || source.entryId <= pending.sourceEntryId) return;
        const progress = await this.options.progressFingerprint(taskId, pending.workId, pending.intentRevision).catch(error => {
          console.warn("[CoreGoalContinuation] terminal progress unavailable", error);
          return undefined;
        });
        if (this.disposed) return;
        await this.report(pending, "settled", progress);
        if (this.pendingClaims.has(taskId)) return;
      }
      if (expectedGoalId) trace(taskId, "decision", await this.evaluate(taskId, expectedGoalId, "settled", source));
    }).catch(error => console.warn("[CoreGoalContinuation] settle evaluation failed", error));
  }

  continue(taskId: string, workId: string): Promise<CoreGoalContinuationDecision> {
    return this.enqueue(taskId, () => this.evaluate(taskId, workId, "continued"));
  }

  async assertCurrent(origin: ActiveCoreGoalContinuation): Promise<void> {
    const pending = this.pendingClaims.get(origin.taskId);
    if (!pending || this.options.hostGeneration !== origin.hostGeneration || pending.operationId !== origin.claimOperationId
      || pending.workId !== origin.workId || pending.intentRevision !== origin.intentRevision || pending.ownerEpoch !== origin.ownerEpoch
      || pending.attemptSerial !== origin.attemptSerial || pending.conversationId !== origin.conversationId || pending.storeId !== origin.storeId
      || !await this.allowed(origin.taskId, origin.workId)) throw new CoreGoalContinuationRevokedError();
    const query = { kind: "activeClaim", userId: pending.userId, taskId: pending.taskId, workId: pending.workId,
      storeId: pending.storeId, hostGeneration: pending.hostGeneration, conversationId: origin.conversationId, runTaskId: origin.runTaskId };
    const current = await this.client().request<{ status?: string; workId?: string; attemptSerial?: number }>({ operation: "readGoalContinuation", query });
    if (current?.status !== "current" || current.workId !== pending.workId || current.attemptSerial !== pending.attemptSerial
      || this.pendingClaims.get(origin.taskId) !== pending
      || this.disposed || !this.options.policy().enabled) throw new CoreGoalContinuationRevokedError();
  }

  dispose(): void {
    this.disposed = true;
    this.pendingClaims.clear();
    this.unconfirmedClaims.clear();
  }

  private enqueue<T>(taskId: string, run: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(taskId);
    const next = (tail ?? Promise.resolve()).catch(() => undefined).then(run);
    this.tails.set(taskId, next);
    return next.finally(() => { if (this.tails.get(taskId) === next) this.tails.delete(taskId); });
  }

  private async allowed(taskId: string, workId: string): Promise<boolean> {
    if (this.disposed || !this.options.policy().enabled) return false;
    return await this.options.canAdvance?.(taskId, workId) !== false && !this.disposed && this.options.policy().enabled;
  }

  private async evaluate(taskId: string, workId: string, trigger: Trigger, expected?: SettledEntry): Promise<CoreGoalContinuationDecision> {
    if (this.unconfirmedClaims.has(taskId)) return { status: "unknown" };
    if (this.pendingClaims.has(taskId)) return skip("igniting");
    if (!await this.allowed(taskId, workId)) return skip("policy");
    const scope: GoalScope = { userId: LOCAL_USER_ID, taskId, workId };
    // This protocol ingress was introduced with the Pi commit-time claim fence.
    const ledger = await this.client().request<CoreGoalContinuationLedger | null>({ operation: "readGoalContinuation", query: scope });
    if (!ledger?.canAdvance || ledger.storeCommitSeq == null) return skip("goal_not_eligible");
    if (ledger.placementGuardVersion !== 1 || ledger.activeClaimGuardVersion !== 1) return skip("placement_not_supported");
    if (trigger === "settled" ? ledger.state !== "idle" : ledger.state !== "deferred" && ledger.state !== "exhausted") return skip("invalid_state");
    const progressFingerprint = await this.options.progressFingerprint(taskId, workId, ledger.intentRevision);
    const window = await this.options.inspect(taskId);
    if (!window || window.storeId !== ledger.storeId) return skip("no_session");
    const source = latestChatEntry(window.snapshot);
    if (!source || (expected && (source.conversationId !== expected.conversationId || source.entryId !== expected.entryId))) return skip("source_changed");
    if (window.snapshot.busy || window.snapshot.queued > 0 || window.snapshot.compacting || window.snapshot.status === "waiting_input") return skip("conversation_busy");
    if (!await this.allowed(taskId, workId)) return skip("policy");
    const policy = this.options.policy();
    if (!policy.enabled) return skip("policy");
    const fallbackBudget = policy.tokenBudget === null ? null : positiveInteger(Math.ceil(policy.tokenBudget));
    if (fallbackBudget === undefined) return skip("invalid_budget");
    const fields = { ...scope, intentRevision: ledger.intentRevision, stateVersion: ledger.stateVersion, ownerEpoch: ledger.ownerEpoch,
      storeId: ledger.storeId, expectedStoreCommitSeq: ledger.storeCommitSeq, expectedAttemptSerial: ledger.attemptSerial,
      expectedLedgerUpdatedAt: ledger.updatedAt, hostGeneration: this.options.hostGeneration, conversationId: source.conversationId,
      sourceEntryId: source.entryId, trigger, maxAttempts: normalizeGoalContinuationAttempts(policy.maxAttempts),
      fallbackBudget, progressFingerprint };
    const operationId = `goal-claim:${hash(fields)}`;
    const reply = await this.write<ClaimReply>({ kind: "claim", operationId, ...fields });
    trace(taskId, "claim", { status: reply?.status, code: reply?.status === "rejected" ? reply.code : undefined,
      attemptSerial: ledger.attemptSerial, commitSeq: ledger.storeCommitSeq, source });
    if (!reply) {
      this.unconfirmedClaims.add(taskId);
      return { status: "unknown" };
    }
    if (reply.status === "rejected") return skip(reply.code);
    if (reply.status === "stopped") {
      this.changed(taskId, workId);
      return reply;
    }
    if (reply.status !== "claimed" || reply.operationId !== operationId || reply.taskId !== taskId || reply.workId !== workId
      || reply.storeId !== window.storeId || reply.conversationId !== source.conversationId || reply.hostGeneration !== this.options.hostGeneration
      || reply.userId !== scope.userId || reply.ownerEpoch !== ledger.ownerEpoch || reply.intentRevision !== ledger.intentRevision
      || reply.stateVersion !== ledger.stateVersion || reply.attemptSerial !== ledger.attemptSerial + 1 || reply.sourceEntryId !== source.entryId) {
      this.unconfirmedClaims.add(taskId);
      return { status: "unknown" };
    }
    this.pendingClaims.set(taskId, reply);
    this.changed(taskId, workId);
    let result: CoreGoalPlacement;
    try {
      const validate = () => this.allowed(taskId, workId);
      result = await validate() ? await this.options.place(reply, validate) : "rejected";
    } catch (error) {
      console.warn("[CoreGoalContinuation] placement unconfirmed", error);
      return { status: "unknown" };
    }
    if (result === "unknown") return { status: "unknown" };
    trace(taskId, "placement", result);
    if (result === "accepted") return { status: "started" };
    await this.report(reply, "submitRejected");
    return this.pendingClaims.has(taskId) ? { status: "unknown" } : skip("submit_rejected");
  }

  private async report(claim: CoreGoalContinuationClaim, outcome: "settled" | "submitRejected", progressFingerprint?: string): Promise<void> {
    const command = { kind: "reportAttempt", taskId: claim.taskId, userId: claim.userId, workId: claim.workId,
      storeId: claim.storeId, hostGeneration: claim.hostGeneration, operationId: `${claim.operationId}:${outcome}`,
      claimOperationId: claim.operationId, outcome, progressFingerprint };
    const reply = await this.write<ReportReply>(command);
    if (!reply || reply.status === "rejected" && !["stale_attempt", "scope_changed", "writer_fenced", "store_replaced"].includes(reply.code)) return;
    if (this.pendingClaims.get(claim.taskId) === claim) this.pendingClaims.delete(claim.taskId);
    this.changed(claim.taskId, claim.workId);
  }

  private client(): Pick<CoreBusinessClient, "request" | "isClosed"> {
    const client = this.options.getClient();
    if (!client || client.isClosed) throw new Error("Core 执行宿主连接未就绪");
    return client;
  }

  private async write<T>(command: Record<string, unknown>): Promise<T | undefined> {
    const payload = { operation: "writeGoalContinuation", command };
    try {
      return await this.client().request<T>(payload);
    } catch (error) {
      if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
      // Repeat the same domain operation. A second loss leaves Core's receipt authoritative.
      try { return await this.client().request<T>(payload); }
      catch { return undefined; }
    }
  }

  private changed(taskId: string, workId: string): void {
    void Promise.resolve().then(() => this.options.changed?.(taskId, workId))
      .catch(error => console.warn("[CoreGoalContinuation] projection refresh failed", error));
  }
}
