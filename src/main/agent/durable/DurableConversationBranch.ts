import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, defineDoc, InboxDoc, LiveDoc, type Conversation, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type SubmissionId, type Tx, type UserInput } from "@earendil-works/pi-durable";
import type { DurableInputMetadata } from "./DurableHistoryProjection";

type ContentFields<T> = { [Key in keyof T]: T[Key] };
export type DurableRegenerationInput = { operationId: string; content: string | Array<ContentFields<Exclude<UserInput, string>[number]>>; metadata?: DurableInputMetadata };
export type DurableRegenerationState = { kind: "pending"; input: DurableRegenerationInput } | { kind: "admitted"; operationId: string; submissionId: SubmissionId };

/** The product's visible branch. Previous conversations remain immutable audit history. */
export const ActiveDurableConversation = defineDoc({
  kind: "mybuddy.active-conversation", version: 1, scope: "session", checkpointWhen: () => false,
  initial: (): { conversationId: ConversationId | null; regeneration?: DurableRegenerationState } => ({ conversationId: null }),
});

export async function resolveActiveDurableConversation(harness: Harness, root: Conversation, context: Context): Promise<Conversation> {
  const active = await harness.snapshot(ActiveDurableConversation, context);
  if (active?.conversationId == null) return root;
  const conversation = await harness.conversation(active.conversationId, context);
  if (!conversation) throw new Error("当前会话分支不存在，原执行记录已保留");
  return conversation;
}

/** Creation and the visible pointer commit together; an unsuccessful fork never changes the user's branch. */
export async function forkDurableConversation(harness: Harness, source: Conversation, at: EntryId | undefined, context: Context, regeneration?: DurableRegenerationInput): Promise<Conversation> {
  const activate = async (tx: Tx, id: ConversationId) => {
    const active = await tx.doc(ActiveDurableConversation);
    if (active.conversationId !== null && active.conversationId !== source.id) throw new Error("会话分支已变化，请刷新后重试");
    if (active.regeneration?.kind === "pending") throw new Error("上一次重新生成仍在接收，请稍后重试");
    const live = await tx.doc(LiveDoc, source.id);
    const inbox = await tx.doc(InboxDoc, source.id);
    if (live.run || live.compactions?.length || inbox.items.length) throw new Error("任务仍在运行，请先停止生成");
    if (regeneration || at === undefined) {
      const target = await tx.doc(AgentDoc, id);
      const current = await tx.doc(AgentDoc, source.id);
      for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
      Object.assign(target, current);
    }
    active.conversationId = id;
    active.regeneration = regeneration ? { kind: "pending", input: regeneration } : undefined;
  };
  if (at !== undefined) return source.fork(at, { ownership: { kind: "ownerless" }, init: activate }, context);
  return harness.createConversation({ ownership: { kind: "ownerless" }, init: activate }, context);
}

export class DurableUserEntryNotFoundError extends Error {
  constructor() { super("找不到所选用户消息"); this.name = "DurableUserEntryNotFoundError"; }
}

export async function findDurableUserEntry(source: Conversation, target: { entryId?: string; userMessageIndex: number }, context: Context): Promise<{ entry: EntryRecord; previous?: EntryRecord }> {
  let cursor: Cursor | undefined;
  let previous: EntryRecord | undefined;
  let index = 0;
  do {
    const page = await source.entries({ order: "ascending" }, 500, cursor, context);
    for (const entry of page.items) {
      if ((entry.kind === "pi.user" || entry.kind === "mybuddy.user") && entry.model?.some(message => message.role === "user")) {
        const selected = target.entryId ? target.entryId === String(entry.id) || target.entryId === `durable-${entry.id}` : index === target.userMessageIndex;
        if (selected) return { entry, previous };
        index++;
      }
      previous = entry;
    }
    cursor = page.next;
  } while (cursor);
  throw new DurableUserEntryNotFoundError();
}
