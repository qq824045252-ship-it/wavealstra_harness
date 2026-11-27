import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc, ROOT_CONVERSATION_ID, type DocumentAddress } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { resolve } from "node:path";
import type { TaskHistoryDto, TaskHistoryTarget, TaskUserQuestionsDto, TaskUserQuestionsQuery } from "../../../shared/agent-ipc";
import type { RuntimeAuditDurableSnapshot, RuntimeAuditReader } from "../../platform/runtime-audit";
import { DurableBotRuntime } from "./DurableBotRuntime";
import { ActiveDurableConversation } from "./DurableConversationBranch";
import { durableHistoryIdentity } from "./DurableHistoryIdentity";
import { durableStorageExists, openRustDurableStorage } from "./DurableStorage";
import { decodePiStorageText } from "./DuckDbStorage";

export const PASSIVE_READONLY_MODELS = {
  getProviders: () => [],
  getProvider: () => undefined,
  getModels: () => [],
  getModel: () => undefined,
  getModelsOfType: () => [],
  getModelOfType: () => undefined,
  getAllModels: () => [],
  refresh: async () => undefined,
  checkAuth: async () => undefined,
  getAvailable: async () => [],
  getAvailableOfType: async () => [],
  getAllAvailable: async () => [],
  getAuth: async () => undefined,
  login: async () => { throw new Error("Read-only history model stub cannot login"); },
  logout: async () => { throw new Error("Read-only history model stub cannot logout"); },
  stream: () => { throw new Error("Read-only history model stub cannot execute models"); },
  complete: async () => { throw new Error("Read-only history model stub cannot execute models"); },
  streamSimple: () => { throw new Error("Read-only history model stub cannot execute models"); },
  completeSimple: async () => { throw new Error("Read-only history model stub cannot execute models"); },
} as unknown as Models;

interface PassiveSource {
  directory: string;
  cwd: string;
  models: Models;
  reader?: RuntimeAuditReader;
}

/** A short-lived native viewer, never cached or promoted into an execution session. */
export async function readDurableReadOnlyHistory(input: PassiveSource & {
  beforeEntryId?: TaskHistoryTarget;
  isDotsWorkerInput?: (requestId: string) => boolean;
  hasDotsDelegation?: () => boolean;
  observedUsage?: (conversationId: string) => import("../../../shared/task-diagnostics").ConversationUsageReceipt;
}): Promise<TaskHistoryDto> {
  if (!(await durableStorageExists(input.directory, input.reader))) return { messages: [], cwd: input.cwd };
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, observedUsage: input.observedUsage, isDotsWorkerInput: input.isDotsWorkerInput, hasDotsDelegation: input.hasDotsDelegation,
    readOnly: true, passiveReader: input.reader, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    const block = input.beforeEntryId === undefined ? undefined : await runtime.loadHistoryWindow(input.beforeEntryId);
    const { epoch: _epoch, revision: _revision, ...archive } = runtime.snapshot;
    return { messages: block?.messages ?? archive.messages, durable: archive, cwd: input.cwd,
      ...(block ? { page: { historyId: block.historyId, before: block.before, after: block.after } } : {}) };
  } finally { await runtime.close(); }
}

/** Read-only viewer for the complete user-question index; never promotes to a writer. */
export async function readDurableUserQuestions(input: PassiveSource & {
  query?: TaskUserQuestionsQuery; live?: () => Promise<TaskUserQuestionsDto>;
}): Promise<TaskUserQuestionsDto> {
  if (!(await durableStorageExists(input.directory, input.reader))) return input.live ? input.live() : { questions: [] };
  const before = input.query?.beforeEntryId;
  if (before !== undefined && (!Number.isSafeInteger(before) || before < 1)) throw new Error("Invalid question cursor");
  const native = await readTranscript(input, async (snapshot, conversationId, historyId) => {
    if (input.query?.historyId !== undefined && input.query.historyId !== historyId) {
      return { questions: [], historyId, nextBefore: undefined };
    }
    const page = await snapshot.questions(conversationId, before);
    return page && {
      questions: page.questions.map(question => ({ ...question, text: decodePiStorageText(question.text) })),
      historyId,
      nextBefore: page.nextBefore ?? undefined,
    };
  });
  if (native) {
    if (input.query?.historyId !== undefined && input.query.historyId !== native.historyId) {
      throw new Error("历史分支已变化，请重新打开提问列表");
    }
    return native;
  }
  if (input.live) return input.live();
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, passiveReader: input.reader, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    return await runtime.loadUserQuestions(input.query);
  } finally { await runtime.close(); }
}

/** Read-only snapshot of the first N tokens of the conversation (AI naming). */
export async function readDurableConversationHead(input: PassiveSource & { maxTokens?: number; live?: () => Promise<string> }): Promise<string> {
  if (!(await durableStorageExists(input.directory, input.reader))) return input.live ? input.live() : "";
  const maxTokens = input.maxTokens ?? 1024;
  if (Number.isFinite(maxTokens)) {
    const native = await readTranscript(input, async (snapshot, conversationId) => {
      const head = await snapshot.head(conversationId, maxTokens);
      return head === undefined ? undefined : decodePiStorageText(head);
    });
    if (native !== undefined) return native;
  }
  if (input.live) return input.live();
  const runtime = await DurableBotRuntime.open({ directory: input.directory, cwd: input.cwd,
    models: input.models, readOnly: true, passiveReader: input.reader, toolMode: "native", instructions: () => "", onSnapshot: () => {} });
  try {
    return await runtime.loadHistoryHead(maxTokens);
  } finally { await runtime.close(); }
}

async function readTranscript<T>(input: PassiveSource,
  read: (snapshot: RuntimeAuditDurableSnapshot, conversationId: number, historyId: string) => Promise<T | undefined>,
): Promise<T | undefined> {
  if (!input.reader) return undefined;
  try {
    const native = await openRustDurableStorage(input.directory, input.reader);
    if (!native) return undefined;
    try {
      const doc = async (address: DocumentAddress) => {
        const record = await native.storage.findDocument(address, "current", context);
        return record ? (await native.storage.document(record.id, "current", context))?.value : undefined;
      };
      const active = await doc({ kind: ActiveDurableConversation.definition.kind, scope: { kind: "session" } });
      const conversationId = (active?.conversationId ?? ROOT_CONVERSATION_ID) as typeof ROOT_CONVERSATION_ID;
      if (!await native.storage.conversation(conversationId, context)) throw new Error("当前会话分支不存在");
      const agent = await doc({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId } });
      if (typeof agent?.cwd === "string" && agent.cwd && resolve(agent.cwd) !== resolve(input.cwd)) {
        throw new Error("Bot 已绑定的工作目录与当前项目不一致");
      }
      return await read(native.snapshot, conversationId, durableHistoryIdentity(input.directory, String(conversationId), native.storage));
    } finally { await native.storage.close(context); }
  } catch { return undefined; }
}
