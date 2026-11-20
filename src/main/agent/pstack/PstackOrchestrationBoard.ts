import { defineDoc, type TaskId, type Tx } from "@earendil-works/pi-durable";
import type { Api, WorkflowRun } from "./PstackState";

export type Unit = { id: string; track: string; brief: string; dependencies: string[]; status: "pending" | "running" | "returned" | "failed" | "verified";
  attempts: number; unknownFailures: number; providerFailures?: number; dispatch: number; receipt: number; branch: string; pr: number; sha: string; lastError: string };
type Gate = { id: string; question: string; answer: string; input: number };
type Verification = { id: string; pr: number; sha: string; fingerprint: string; toolTaskId: number; command: string };
type Notice = { id: string; dispatch: number; status: string; note: string };
export type Board = { run: number; units: Unit[]; checks: Verification[]; gates: Gate[]; standing: string[];
  inbox: Notice[]; drained: Record<string, Notice[]>; order: string[]; generation: number; operations: number[] };
export const boardDoc = defineDoc({ kind: "mybuddy.pstack-orchestration", version: 1, scope: "conversation", history: "rewindable", fork: "initial",
  checkpointWhen: () => true, initial: (): { board: Board | null } => ({ board: null }) });
export const empty = (run: number): Board => ({ run, units: [], checks: [], gates: [], standing: [], inbox: [], drained: {}, order: [], generation: 0, operations: [] });

export async function isUnitOwnerDispatch(tx: Tx, api: Api, run: WorkflowRun, delegate: TaskId) {
  const parent = (await tx.task(delegate))?.owner;
  if (!parent) return false;
  const board = (await tx.doc(boardDoc, api.conversationId)).board;
  return board?.run === run.run && board.units.some(u => u.dispatch === parent && (u.status === "running" || u.receipt === delegate));
}
