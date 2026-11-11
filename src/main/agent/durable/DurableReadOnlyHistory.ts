import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { TaskHistoryDto } from "../../../shared/agent-ipc";
import { DurableBotRuntime } from "./DurableBotRuntime";

/** A short-lived native viewer, never cached or promoted into an execution session. */
export async function readDurableReadOnlyHistory(input: {
  directory: string; cwd: string; models: ModelRuntime; beforeEntryId?: number;
}): Promise<TaskHistoryDto> {
  if (!existsSync(join(input.directory, "main.jsonl"))) return { messages: [], cwd: input.cwd };
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    const block = input.beforeEntryId === undefined ? undefined : await runtime.loadHistoryBlock(input.beforeEntryId);
    const snapshot = runtime.snapshot;
    return { messages: block?.messages ?? snapshot.messages, durable: snapshot, cwd: input.cwd,
      ...(block ? { page: { epoch: block.epoch, before: block.before } } : {}) };
  } finally { await runtime.close(); }
}

/** Read-only viewer for the complete user-question index; never promotes to a writer. */
export async function readDurableUserQuestions(input: {
  directory: string; cwd: string; models: ModelRuntime;
}): Promise<Array<{ id: string; text: string }>> {
  if (!existsSync(join(input.directory, "main.jsonl"))) return [];
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    return await runtime.loadUserQuestions();
  } finally { await runtime.close(); }
}

/** Read-only snapshot of the first N tokens of the conversation (AI naming). */
export async function readDurableConversationHead(input: {
  directory: string; cwd: string; models: ModelRuntime; maxTokens?: number;
}): Promise<string> {
  if (!existsSync(join(input.directory, "main.jsonl"))) return "";
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    return await runtime.loadHistoryHead(input.maxTokens ?? 1024);
  } finally { await runtime.close(); }
}
