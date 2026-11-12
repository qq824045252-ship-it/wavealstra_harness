import type { Models } from "@earendil-works/pi-ai";
import type { TaskHistoryDto, TaskHistoryTarget, TaskUserQuestionsDto, TaskUserQuestionsQuery } from "../../../shared/agent-ipc";
import { DurableBotRuntime } from "./DurableBotRuntime";
import { durableStorageExists } from "./DurableStorage";

/** A short-lived native viewer, never cached or promoted into an execution session. */
export async function readDurableReadOnlyHistory(input: {
  directory: string; cwd: string; models: Models; beforeEntryId?: TaskHistoryTarget;
}): Promise<TaskHistoryDto> {
  if (!durableStorageExists(input.directory)) return { messages: [], cwd: input.cwd };
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    const block = input.beforeEntryId === undefined ? undefined : await runtime.loadHistoryWindow(input.beforeEntryId);
    const snapshot = runtime.snapshot;
    return { messages: block?.messages ?? snapshot.messages, durable: snapshot, cwd: input.cwd,
      ...(block ? { page: { historyId: block.historyId, before: block.before, after: block.after } } : {}) };
  } finally { await runtime.close(); }
}

/** Read-only viewer for the complete user-question index; never promotes to a writer. */
export async function readDurableUserQuestions(input: {
  directory: string; cwd: string; models: Models; query?: TaskUserQuestionsQuery;
}): Promise<TaskUserQuestionsDto> {
  if (!durableStorageExists(input.directory)) return { questions: [] };
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    return await runtime.loadUserQuestions(input.query);
  } finally { await runtime.close(); }
}

/** Read-only snapshot of the first N tokens of the conversation (AI naming). */
export async function readDurableConversationHead(input: {
  directory: string; cwd: string; models: Models; maxTokens?: number;
}): Promise<string> {
  if (!durableStorageExists(input.directory)) return "";
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    return await runtime.loadHistoryHead(input.maxTokens ?? 1024);
  } finally { await runtime.close(); }
}
