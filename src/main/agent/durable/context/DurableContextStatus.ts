import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type DocumentAddress, type Storage, type ConversationId } from "@earendil-works/pi-durable";
import { openDurablePassiveStorage } from "../DurableStorage";
import { durableStorageOwnerState } from "../DurableStorageLease";
import { ActiveDurableConversation } from "../DurableConversationBranch";
import { DurableContextStateDoc, persistedContextStatus, matchesNativeContextCommit, type DurableContextPersistedState } from "./DurableContextState";
import type { ContextManagementStatusDto } from "../../../../shared/context-management";

/** No Harness, model, scheduler, lease file, repair, or document initialization on a passive read.
 * The passive Storage pins one read snapshot through close, so branch, state, native head
 * and submission proof cannot come from different commits of an active writer.
 */
export async function readDurableContextStatus(directory: string): Promise<ContextManagementStatusDto | undefined> {
  const storage = await openDurablePassiveStorage(directory, ctx);
  if (!storage) return undefined;
  try {
    const read = async (address: DocumentAddress) => {
      const doc = await storage.findDocument(address, "current", ctx);
      return doc ? (await storage.document(doc.id, "current", ctx))?.value : undefined;
    };
    const active = await read({ kind: ActiveDurableConversation.definition.kind, scope: { kind: "session" } });
    const conversationId = (active?.conversationId ?? ROOT_CONVERSATION_ID) as typeof ROOT_CONVERSATION_ID;
    const state = await read({ kind: DurableContextStateDoc.definition.kind, scope: { kind: "conversation", conversationId } });
    return state ? await contextStatusFromStorage(state as DurableContextPersistedState, storage, conversationId, durableStorageOwnerState(directory) === "inactive") : undefined;
  } finally { await storage.close(ctx); }
}

export async function contextStatusFromStorage(state: DurableContextPersistedState, storage: Storage, conversationId: ConversationId, passive = true): Promise<ContextManagementStatusDto> {
  const operation = state.lastOperation;
  if (operation?.phase === "applying") {
    const head = await storage.findLatestHeadMarker(conversationId, undefined, ctx);
    if (await matchesNativeContextCommit(operation, head, requestId => storage.submissionByRequest(conversationId, requestId, ctx))) {
      return persistedContextStatus({ ...state, lastOperation: { ...operation, phase: "completed", interrupted: false,
        message: "原生压缩边界已提交，维护终态可从该记录恢复" } }, false);
    }
  }
  return persistedContextStatus(state, passive);
}
