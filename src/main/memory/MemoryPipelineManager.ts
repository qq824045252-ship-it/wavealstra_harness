import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryPipelineStateDto, MemoryTurnDto } from "../../shared/memory-kernel";
import { MemoryTurnRepository, type CaptureMemoryTurnInput } from "./MemoryTurnRepository";

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
 * L2/L3 are manually proposed and approved derived views; they have no automatic cadence.
 */
export class MemoryPipelineManager {
  readonly turns: MemoryTurnRepository;

  constructor(db: AppDatabase) {
    this.turns = new MemoryTurnRepository(db);
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
