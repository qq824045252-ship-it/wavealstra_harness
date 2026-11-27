import { LiveDoc, ProviderDoc, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness, type HookApi,
  type Storage, type SubmissionRecord, type TaskId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ActiveCoreGoalContinuation } from "../work/CoreGoalContinuationDriver";

type AuthorityStorage = Pick<Storage, "conversation" | "task" | "submission" | "submissionByRequest" | "entry" | "scanEntries">;
type AuthorityApi = Pick<HookApi, "snapshot" | "conversationId">;
type Verify = (origin: ActiveCoreGoalContinuation) => Promise<void>;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function stale(): Error { return new Error("Goal 自动续跑的执行授权已失效"); }

function continuation(taskId: string, entry: EntryRecord | undefined, requestId: string | undefined): Omit<ActiveCoreGoalContinuation, "runTaskId"> | undefined {
  const input = object(object(entry?.data)?.mybuddyInput);
  const raw = input?.goalContinuation;
  if (raw === undefined && !requestId?.startsWith("goal-continuation:")) return;
  const marker = object(raw);
  const { workId, intentRevision, ownerEpoch, attemptSerial, claimOperationId, hostGeneration, storeId } = marker ?? {};
  if (!entry || entry.kind !== "mybuddy.user" || marker?.taskId !== taskId || typeof workId !== "string" || !workId
    || !integer(intentRevision) || !integer(ownerEpoch) || !integer(attemptSerial)
    || typeof claimOperationId !== "string" || !claimOperationId || typeof hostGeneration !== "string" || !hostGeneration
    || typeof storeId !== "string" || !storeId || requestId !== `goal-continuation:${workId}:${intentRevision}:${attemptSerial}`
    || requestId !== input?.inputRequestId) throw stale();
  return { taskId, workId, intentRevision, ownerEpoch, attemptSerial, claimOperationId, hostGeneration, storeId, conversationId: entry.conversationId };
}

async function userAt(storage: AuthorityStorage, conversationId: ConversationId, at: EntryId, context: Context) {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, maxEntryId: at, order: "descending" }, 100, cursor, context);
    const entry = page.items.find(entry => entry.kind === "mybuddy.user" || entry.kind === "pi.user");
    if (entry) return entry;
    cursor = page.next;
  } while (cursor);
}

/** Use the committed input for this invocation, including a resumed native tool or child conversation. */
export async function assertDurableGoalContinuation(taskId: string, storage: AuthorityStorage, api: AuthorityApi,
  context: Context, verify: Verify, toolTask?: TaskId): Promise<boolean> {
  let conversationId = api.conversationId;
  let anchor = toolTask;
  while (true) {
    const conversation = await storage.conversation(conversationId, context);
    if (!conversation) throw stale();
    const owner = conversation.owner;
    if (!owner) break;
    if (owner.conversationId >= conversationId) throw stale();
    conversationId = owner.conversationId;
    anchor = owner.taskId;
  }

  let assistant: EntryId | undefined;
  while (anchor !== undefined) {
    const task = await storage.task(anchor, context);
    if (!task || task.conversationId !== conversationId) throw stale();
    const input = object(task.input);
    if (integer(input?.assistant)) { assistant = input.assistant as EntryId; break; }
    const parent = input?.kind === "nested" && integer(input.parent) ? input.parent as TaskId : task.owner;
    if (parent !== undefined && parent >= anchor) throw stale();
    anchor = parent;
  }

  const live = await api.snapshot(LiveDoc, conversationId, context);
  const run = live?.run;
  let current: SubmissionRecord | undefined;
  for (const id of [...(run?.inputs ?? [])].reverse()) {
    const submitted = await storage.submission(id, context);
    if (submitted?.conversationId !== conversationId) throw stale();
    if (submitted.type !== "input") continue;
    if (submitted.entry === undefined) throw stale();
    current = submitted;
    break;
  }
  if (current?.entry !== undefined && (!assistant || current.entry < assistant)) {
    const entry = (await storage.entry(conversationId, current.entry, context))?.entry;
    if (!entry) throw stale();
    const origin = continuation(taskId, entry, current.requestId);
    if (origin && run) await verify({ ...origin, runTaskId: run.taskId });
    return Boolean(origin);
  }

  const at = assistant ?? live?.run?.first;
  if (!at) return false;
  const entry = await userAt(storage, conversationId, at, context);
  const requestId = object(object(entry?.data)?.mybuddyInput)?.inputRequestId;
  const origin = continuation(taskId, entry, typeof requestId === "string" ? requestId : undefined);
  if (origin) {
    // A descendant or delayed tool cannot borrow a newer foreground input's authority.
    const submission = await storage.submissionByRequest(conversationId, `goal-continuation:${origin.workId}:${origin.intentRevision}:${origin.attemptSerial}`, context);
    if (!run || submission?.type !== "input" || submission.entry !== entry?.id || current?.id !== submission.id) throw stale();
    await verify({ ...origin, runTaskId: run.taskId });
  }
  return Boolean(origin);
}

/** Pi's resumed native compaction supplies its persisted provider session ID rather than a generation hook. */
export async function assertDurableGoalCompaction(taskId: string, storage: AuthorityStorage & Pick<Storage, "scanConversations">,
  harness: Pick<Harness, "snapshot">, sessionId: string | undefined, context: Context, verify: Verify): Promise<void> {
  if (!sessionId) throw stale();
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, 100, cursor, context);
    for (const conversation of page.items) {
      if ((await harness.snapshot(ProviderDoc, conversation.id, context))?.sessionId === sessionId) {
        await assertDurableGoalContinuation(taskId, storage, { conversationId: conversation.id, snapshot: harness.snapshot.bind(harness) }, context, verify);
        return;
      }
    }
    cursor = page.next;
  } while (cursor);
  throw stale();
}
