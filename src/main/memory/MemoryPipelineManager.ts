import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryPipelineStateDto, MemoryTurnDto } from "../../shared/memory-kernel";
import { MemoryTurnRepository, prepareMemoryTurn, type CaptureMemoryTurnInput, type DurableMemoryTurn, type RuntimeMemoryCapture } from "./MemoryTurnRepository";

export interface MemoryCaptureDecision {
  turn: MemoryTurnDto;
  created: boolean;
  shouldExtractL1: boolean;
  reason: "duplicate" | "turn_completed";
  pendingTurns: MemoryTurnDto[];
  state: MemoryPipelineStateDto;
}

/**
 * Schedules memory cognition without becoming a second memory truth.
 * L0 = raw turn/evidence. L1 = MemoryRecord (MemoryService remains the only durable cognition truth).
 * Dots maintains its own derived L2/L3 views in MemoryCognitionService. Other scopes use manual generation.
 */
export class MemoryPipelineManager {
  readonly turns: MemoryTurnRepository;
  private readonly taskCaptures = new Map<string, Promise<void>>();
  private captureFence: Promise<void> = Promise.resolve();
  private capturesClosed = false;

  constructor(private readonly db: AppDatabase) {
    this.turns = new MemoryTurnRepository(db);
  }

  captureCompleted(input: CaptureMemoryTurnInput): Promise<boolean> {
    const turn = prepareMemoryTurn(input);
    return this.captureTask(input.taskId, async () => {
      if (this.capturesClosed) return false;
      return (await this.storeCapture({ kind: "turn", turn })) > 0;
    });
  }

  projectCompleted(taskId: string, turns: readonly DurableMemoryTurn[], enabled: () => boolean): Promise<boolean> {
    return this.captureTask(taskId, async () => {
      if (this.capturesClosed || !turns.length) return false;
      const capture = enabled();
      const entries = turns.map(turn => ({
        entryId: turn.entryId,
        turn: capture && !turn.skipCapture ? prepareMemoryTurn(turn) : undefined,
      }));
      return (await this.storeCapture({ kind: "durable", taskId, entries })) > 0;
    });
  }

  private async storeCapture(capture: RuntimeMemoryCapture): Promise<number> {
    const saved = await this.db.runtimeAuditReader?.captureMemory(capture);
    if (saved !== undefined) return saved;
    if (this.db.readonly || this.db.runtimeAuditReader?.supervised) {
      throw new Error("保存对话记忆回执失败：Rust 写入核心未就绪或未确认");
    }
    const recovered = this.turns.captureCompletedOnHost(capture);
    // A worker that exited after commit already advanced the Durable watermark.
    // Any pending originals can still be picked up by the extraction queue.
    if (!recovered && capture.kind === "durable" && capture.entries.some(entry => entry.turn)
        && this.turns.listPending(capture.taskId, 1).length) return 1;
    return recovered;
  }

  private captureTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.captureFence, this.taskCaptures.get(taskId)]).then(operation);
    const settled = result.then(() => undefined, () => undefined).finally(() => {
      if (this.taskCaptures.get(taskId) === settled) this.taskCaptures.delete(taskId);
    });
    this.taskCaptures.set(taskId, settled);
    return result;
  }

  /** Erasure and shutdown fence already accepted captures across tasks. */
  withCaptureWrites<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = Promise.all([this.captureFence, ...this.taskCaptures.values()]).then(operation);
    this.captureFence = result.then(() => undefined, () => undefined);
    return result;
  }

  async flushCaptureWrites(): Promise<void> {
    await Promise.all([this.captureFence, ...this.taskCaptures.values()]);
    await this.turns.flush();
  }

  closeCaptureWrites(): Promise<void> {
    return this.withCaptureWrites(async () => {
      this.capturesClosed = true;
      await this.turns.flush();
    });
  }

  capture(input: CaptureMemoryTurnInput): MemoryCaptureDecision {
    const captured = this.turns.capture(input);
    if (!captured.created) {
      const state = this.turns.getPipelineState(input.taskId);
      return {
        ...captured,
        shouldExtractL1: false,
        reason: "duplicate",
        pendingTurns: this.turns.listPending(input.taskId),
        state,
      };
    }

    const state = this.turns.noteCaptured(input.taskId, captured.turn.capturedAt);
    return {
      ...captured,
      shouldExtractL1: true,
      reason: "turn_completed",
      pendingTurns: this.turns.listPending(input.taskId),
      state,
    };
  }

  beginL1(turns: readonly MemoryTurnDto[]): void {
    this.turns.markProcessing(turns.map((turn) => turn.id));
  }

  completeL1(taskId: string, turns: readonly MemoryTurnDto[]): MemoryPipelineStateDto {
    this.turns.markCompleted(turns.map((turn) => turn.id));
    const remainingPending = this.turns.listPending(taskId, 50).length;
    return this.turns.noteL1Completed(taskId, remainingPending);
  }

  failL1(turns: readonly MemoryTurnDto[], error: unknown): void {
    this.turns.markFailed(turns.map((turn) => turn.id), error);
  }

}
