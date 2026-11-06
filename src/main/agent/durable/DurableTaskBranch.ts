import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { InboxDoc, LiveDoc, type Conversation, type Cursor, type EntryDraft, type EntryRecord, type EntryId, type JsonObject } from "@earendil-works/pi-durable";
import type { CreateConversationBranchRequest } from "../../../shared/conversation-branch";
import { ConversationBranchDomainError } from "../../../shared/conversation-branch";
import type { DurableBotRuntime } from "./DurableBotRuntime";

export interface DurableBranchAnchor {
  conversationId: string;
  leafEntryId: string;
  userEntryId: string;
  resolvedUserMessageIndex: number;
  inheritedToolCallIds: string[];
}
export interface DurableBranchSeed {
  entries: Array<{ sourceId: EntryId; entry: EntryDraft; store: JsonObject }>;
}
export interface MaterializedDurableBranch {
  directory: string;
  inheritedLastEntryId: number;
}

async function entriesOf(conversation: Conversation): Promise<EntryRecord[]> {
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, context);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);
  return entries;
}
const isUser = (entry: EntryRecord) => (entry.kind === "pi.user" || entry.kind === "mybuddy.user") && entry.model?.some(message => message.role === "user");

export async function resolveDurableBranch(runtime: DurableBotRuntime, request: CreateConversationBranchRequest): Promise<DurableBranchAnchor> {
  if (!await runtime.isIdle()) throw new ConversationBranchDomainError("TASK_BUSY", "当前任务仍在运行");
  const entries = await entriesOf(runtime.conversation);
  const users = entries.filter(isUser);
  const selected = request.entryId ? entries.find(entry => String(entry.id) === request.entryId || `durable-${entry.id}` === request.entryId) : undefined;
  const owner = selected && (isUser(selected) || selected.model?.some(message => message.role === "assistant" || message.role === "toolResult"))
    ? entries.slice(0, entries.indexOf(selected) + 1).reverse().find(isUser) : undefined;
  const index = request.entryId ? (owner ? users.indexOf(owner) : -1) : request.userMessageIndex ?? -1;
  const user = users[index];
  if (!user) throw new ConversationBranchDomainError("ANCHOR_NOT_FOUND", "找不到当前分支中的用户消息");
  let leaf = user;
  if (request.position === "after_reply") {
    for (const entry of entries.slice(entries.indexOf(user) + 1)) {
      if (isUser(entry)) break;
      if (entry.model?.some(message => message.role === "assistant" || message.role === "toolResult")) leaf = entry;
    }
  }
  return { conversationId: String(runtime.conversation.id), leafEntryId: String(leaf.id), userEntryId: String(user.id), resolvedUserMessageIndex: index,
    inheritedToolCallIds: entries.filter(entry => entry.id <= leaf.id).flatMap(entry => (entry.model ?? []).flatMap(message => message.role === "assistant"
      ? message.content.flatMap(block => block.type === "toolCall" ? [block.id] : []) : [])) };
}

/** Pi forks its context and rewindable store. Only committed history is copied to the independent task. */
export async function captureDurableBranch(runtime: DurableBotRuntime, anchor: DurableBranchAnchor): Promise<DurableBranchSeed> {
  if (String(runtime.conversation.id) !== anchor.conversationId) throw new ConversationBranchDomainError("ANCHOR_NOT_IN_ACTIVE_BRANCH", "源分支已变化，请刷新后重试");
  const leaf = (await entriesOf(runtime.conversation)).find(entry => String(entry.id) === anchor.leafEntryId);
  if (!leaf) throw new ConversationBranchDomainError("ANCHOR_NOT_FOUND", "分支锚点已不存在");
  const fork = await runtime.conversation.fork(leaf.id, { ownership: { kind: "ownerless" }, init: async tx => {
    const live = await tx.doc(LiveDoc, runtime.conversation.id);
    const inbox = await tx.doc(InboxDoc, runtime.conversation.id);
    if (live.run || live.compactions?.length || inbox.items.length) throw new ConversationBranchDomainError("TASK_BUSY", "当前任务仍在运行");
  } }, context);
  const entries: DurableBranchSeed["entries"] = [];
  for (const source of await entriesOf(fork)) {
    const store = await runtime.harness.snapshotAsOf(CodemodeStoreDoc, fork.id, source.id, context);
    const data = source.data && typeof source.data === "object" && !Array.isArray(source.data) ? source.data : {};
    const input = data.mybuddyInput && typeof data.mybuddyInput === "object" && !Array.isArray(data.mybuddyInput)
      ? data.mybuddyInput : runtime.inputMetadata(source.id);
    entries.push({ sourceId: source.id, store: store?.values ?? {}, entry: {
      kind: source.kind, model: source.model, head: source.head, edits: source.edits,
      data: source.data !== undefined && (source.data === null || typeof source.data !== "object" || Array.isArray(source.data)) ? source.data : { ...data, inherited: true, sourceEntryId: String(source.id), ...(input ? {
        mybuddyInput: { text: input.text ?? "", displayText: input.displayText ?? "", attachments: input.attachments ?? [] },
      } : {}) },
    } });
  }
  return { entries };
}

/** Separate commits preserve Pi's document watermarks for later branches inside inherited history. */
export async function seedDurableBranch(conversation: Conversation, seed: DurableBranchSeed): Promise<void> {
  const ids = new Map<string, EntryId>();
  const remap = (id: EntryId): EntryId => {
    const mapped = ids.get(String(id));
    if (mapped === undefined) throw new Error(`分支历史引用不存在：${id}`);
    return mapped;
  };
  for (const { sourceId, entry, store } of seed.entries) {
    const head = entry.head === sourceId ? "self" : entry.head === undefined || entry.head === "self" ? entry.head : remap(entry.head);
    const edits = entry.edits?.map(edit => ({ ...edit, target: remap(edit.target) }));
    const data = entry.kind === "mybuddy.context-ledger" ? remapLedger(entry.data, ids) : entry.data;
    const saved = await conversation.commit(async tx => {
      (await tx.doc(CodemodeStoreDoc, conversation.id)).values = store;
      return tx.appendEntry(conversation.id, { ...entry, data, head, edits });
    }, context);
    ids.set(String(sourceId), saved.id);
  }
}

function remapLedger(data: EntryDraft["data"], ids: ReadonlyMap<string, EntryId>): JsonObject {
  if (!data || typeof data !== "object" || Array.isArray(data)
    || typeof data.anchor !== "string" || typeof data.boundary !== "string") throw new Error("分支证据账本缺少锚点");
  const remap = (value: string) => {
    const mapped = ids.get(value);
    if (mapped === undefined) throw new Error(`分支证据引用不存在：${value}`);
    return String(mapped);
  };
  // Scope and access witnesses describe the original evidence. The child's projection
  // validates them against its own scope; changing their identity would grant access.
  return { ...data, anchor: remap(data.anchor), boundary: ["root", "summary-lineage"].includes(data.boundary) ? data.boundary : remap(data.boundary) };
}
