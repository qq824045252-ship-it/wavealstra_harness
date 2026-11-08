import { resolve } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { AgentDoc, InboxDoc, LiveDoc, type Cursor, type Harness, type Tx } from "@earendil-works/pi-durable";
import { ActiveDurableConversation } from "./DurableConversationBranch";

export class WorkspaceMigrationBusyError extends Error {
  readonly code = "WORKSPACE_MIGRATION_BUSY";
  constructor() {
    super("Bot 仍有执行、排队或待回复操作，工作目录将在安全空闲后切换");
    this.name = "WorkspaceMigrationBusyError";
  }
}

/** A directory switch is a new execution boundary, never recovery of an in-flight effect. */
async function workspaceQuiescent(tx: Tx): Promise<boolean> {
  if ((await tx.doc(ActiveDurableConversation)).regeneration?.kind === "pending") return false;
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanTasks({}, 200, cursor);
    if (page.items.some(task => task.state.status !== "terminal")) return false;
    cursor = page.next;
  } while (cursor);
  do {
    const page = await tx.scanConversations({}, 200, cursor);
    for (const conversation of page.items) {
      const live = await tx.doc(LiveDoc, conversation.id);
      const inbox = await tx.doc(InboxDoc, conversation.id);
      if (live.run || live.compactions?.length || inbox.items.length
        || live.tools?.some(tool => tool.status !== "done")
        || live.nestedTools?.some(tool => tool.status !== "done")) return false;
    }
    cursor = page.next;
  } while (cursor);
  return true;
}

export async function canRebindDurableWorkspace(harness: Harness, context: Context): Promise<boolean> {
  return harness.commit(workspaceQuiescent, context);
}

/** Native transaction commits all branch bindings together; entries and historical artifacts stay untouched. */
export async function migrateDurableWorkspace(harness: Harness, from: string, to: string, context: Context): Promise<void> {
  await harness.commit(async tx => {
    if (!await workspaceQuiescent(tx)) throw new WorkspaceMigrationBusyError();
    let cursor: Cursor | undefined;
    do {
      const page = await tx.scanConversations({}, 200, cursor);
      for (const conversation of page.items) {
        // Task-owned transcripts retain their execution/worktree identity, even after completion.
        // Only the root and ownerless user-visible branches follow the Bot space.
        if (conversation.owner) continue;
        const agent = await tx.doc(AgentDoc, conversation.id);
        if (agent.cwd && resolve(agent.cwd) !== resolve(from) && resolve(agent.cwd) !== resolve(to)) {
          throw new Error("Bot 原生分支工作目录与迁移来源不一致，未修改绑定");
        }
        agent.cwd = to;
      }
      cursor = page.next;
    } while (cursor);
  }, context);
}
