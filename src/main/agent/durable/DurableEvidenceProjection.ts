import { isGatewayConversation } from "../../../shared/gateway-task";
import { DOTS_TASK_ID } from "../../../shared/dots";
import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Models } from "@earendil-works/pi-ai";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { EphemeralContextProjection, type EvidenceProjectionEntry } from "../EphemeralContextProjection";
import type { AutomaticRecallReceipt } from "../../../shared/memory-kernel";

export type DurableEvidenceOptions = Omit<ConstructorParameters<typeof EphemeralContextProjection>[0], "registerRequestGuard" | "execution"> & {
  onAutomaticRecall?: (receipt: Omit<AutomaticRecallReceipt, "taskId" | "at">) => void;
};

type MemoryBody = { id: string; revision: number; scopeType: string; fullInstruction?: string };

/** Adapts Durable provenance to the existing evidence ledger and its access/revision checks. */
export class DurableEvidenceProjection {
  private readonly projection: EphemeralContextProjection;
  private requestRecall?: Pick<AutomaticRecallReceipt, "mode" | "semanticSources">;
  private readonly memoryBodies = new WeakMap<Message, { content: Message["content"]; bodies: MemoryBody[] }>();
  private readonly entries = new Map<number, EntryRecord>();
  private newest?: EntryId;
  private projectedWithdrawal = 0;
  private dotsBoundary?: { anchor: number; through: number; withdrawal?: number };

  get hasDotsBoundary(): boolean { return Boolean(this.dotsBoundary); }

  constructor(private readonly options: DurableEvidenceOptions, private readonly conversation: Conversation, private readonly models: Models) {
    this.projection = new EphemeralContextProjection({ ...options, registerRequestGuard: () => {},
      delegatedSources: userId => {
        const entry = this.entries.get(Number(userId));
        if (entry?.kind !== "mybuddy.user") return [];
        const input = (entry.data as { mybuddyInput?: import("./DurableHistoryProjection").DurableInputMetadata })?.mybuddyInput;
        return input?.inputRequestId?.startsWith("dots-input-") ? input.dotsMemoryRefs ?? [] : [];
      } });
  }

  private usesDotsPersonalScope(): boolean {
    const scope = this.options.scope();
    return scope.taskId === DOTS_TASK_ID || Boolean(scope.taskId && isGatewayConversation(scope.taskId)
      && this.options.memory?.resolveScopeChain(scope).some(item => item.scopeType === "task" && item.scopeId === DOTS_TASK_ID));
  }

  async project(messages: readonly Message[], context: Context): Promise<readonly Message[]> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.conversation.entries({ ...(this.newest === undefined ? {} : { minEntryId: (this.newest + 1) as EntryId }), order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) {
        this.entries.set(entry.id, entry);
        if (entry.kind === "mybuddy.dots-evidence-boundary") {
          const boundary = entry.data as { anchor: number; through: number; withdrawal?: number };
          if (!Number.isSafeInteger(boundary?.anchor) || !Number.isSafeInteger(boundary.through)
            || boundary.anchor > boundary.through || boundary.through >= entry.id) throw new Error("Dots 历史边界已损坏");
          this.dotsBoundary = boundary;
        }
      }
      this.newest = page.items.at(-1)?.id ?? this.newest;
      cursor = page.next;
    } while (cursor);
    const [agent, active] = await Promise.all([this.conversation.agent(context), this.conversation.context(context)]);
    const ordered = [...this.entries.values()].sort((a, b) => a.id - b.id);
    const retainedId = (id: number) => !this.dotsBoundary || id === this.dotsBoundary.anchor || id > this.dotsBoundary.through;
    const retained = (entry: EntryRecord) => retainedId(entry.id);
    let branch = ordered.filter(retained).flatMap(toProjectionEntry);
    const additions: Array<{ kind: string; data: unknown }> = [];
    const projected = active.entries.flatMap(entry => {
      const sourceEntry = toProjectionEntry(entry)[0];
      return sourceEntry ? [{ sourceEntry, messages: [...entry.model ?? []] }] : [];
    });
    const lastAssistant = [...active.entries].reverse().flatMap(entry => entry.model ?? []).find(message => message.role === "assistant");
    this.projection.attachHost({
      model: agent.model ? this.models.getModel(agent.model.provider, agent.model.modelId) : undefined,
      getContextUsage: () => lastAssistant?.role === "assistant" ? { tokens: lastAssistant.usage.input + lastAssistant.usage.output + lastAssistant.usage.cacheRead + lastAssistant.usage.cacheWrite } : undefined,
      sessionManager: {
        getBranch: () => branch,
        buildSessionProjection: () => ({ entries: this.dotsBoundary ? projected.filter(item => retainedId(Number(item.sourceEntry.id))) : projected }),
        appendCustomEntry: (kind, data) => {
          const id = `pending-${randomUUID()}`;
          branch.push({ type: "custom", id, customType: kind, data });
          additions.push({ kind, data });
          return id;
        },
      },
    });
    const isDots = this.options.scope().taskId === DOTS_TASK_ID;
    const personalScope = this.usesDotsPersonalScope();
    const withdrawal = personalScope ? this.options.memory?.latestWithdrawalAt(DOTS_TASK_ID) ?? 0 : 0;
    this.projectedWithdrawal = withdrawal;
    const withdrawHistory = withdrawal > (this.dotsBoundary?.withdrawal ?? 0) && ordered.some(entry =>
      retained(entry) && entry.model?.some(message => message.role === "user" && message.timestamp <= withdrawal));
    const nativeUser = (entry: EntryRecord) => entry.kind === "mybuddy.user" || entry.kind === "pi.user";
    const origin = (entry: EntryRecord) =>
      (entry.data as { mybuddyInput?: import("./DurableHistoryProjection").DurableInputMetadata })?.mybuddyInput?.gatewayOrigin;
    // Replies and summaries from before the scope check could echo memories
    // the current Gateway task cannot access. Retain them in desktop history.
    const firstIsolatedGatewayInput = !this.dotsBoundary && isGatewayConversation(this.options.scope().taskId ?? "")
      ? ordered.find(entry => nativeUser(entry) && origin(entry)) : undefined;
    const legacyGatewayHistory = firstIsolatedGatewayInput && ordered.some(entry => entry.id < firstIsolatedGatewayInput.id && nativeUser(entry));
    if (legacyGatewayHistory || personalScope && (withdrawHistory || isDots && this.projection.requiresFreshDotsHistory())) {
      const anchor = [...ordered].reverse().find(nativeUser);
      if (!anchor || !this.newest) throw new Error("Dots 无法确认重建上下文的原始输入");
      const boundary = { anchor: anchor.id, through: this.newest, withdrawal };
      const stored = await this.conversation.commit(tx => tx.appendEntry(this.conversation.id, { kind: "mybuddy.dots-evidence-boundary", data: boundary }), context);
      this.entries.set(stored.id, stored);
      this.dotsBoundary = boundary;
      this.projection.resetSelection();
      branch = ordered.filter(retained).flatMap(toProjectionEntry);
    }
    if (this.dotsBoundary) {
      // Summaries can repeat withdrawn facts. Reconstruct only native inputs and replies
      // after the boundary; the visible transcript remains independently available.
      const safeEntries = active.entries.filter(entry => retained(entry) && !entry.head);
      const user = safeEntries.find(entry => entry.kind === "mybuddy.user" || entry.kind === "pi.user");
      if (!user) throw new Error("Dots 无法确认当前输入，请重新发送本轮消息");
      const boundary = this.dotsBoundary;
      const forgot = ordered.some(entry => entry.id > boundary.anchor && entry.id <= boundary.through
        && entry.model?.some(message => message.role === "toolResult" && message.toolName === "memory_forget" && !message.isError));
      messages = [...messages.slice(0, 1).filter(message => message.role === "system"),
        ...safeEntries.flatMap(entry => entry.kind === "mybuddy.user" || entry.kind === "pi.user"
          || entry.kind === "pi.assistant" || entry.kind === "pi.tool-result"
          ? [...entry.model ?? [], ...(forgot && entry.id === boundary.anchor
            ? [{ role: "user" as const, content: "宿主回执：本轮遗忘工具已成功移除所选记忆。", timestamp: 0 }] : [])] : [])];
    }
    const result = await this.projection.projectContext(messages);
    this.requestRecall = result ? this.projection.currentRecall : undefined;
    if (additions.length) {
      const stored = await this.conversation.commit(async tx => {
        const entries: EntryRecord[] = [];
        for (const addition of additions) entries.push(await tx.appendEntry(this.conversation.id, { kind: addition.kind, data: JSON.parse(JSON.stringify(addition.data)) }));
        return entries;
      }, context);
      for (const entry of stored) this.entries.set(entry.id, entry);
    }
    this.captureRequestGuard()();
    return result?.messages.map(message => {
      const projected = toModelMessage(message);
      if (message.role === "custom" && message.customType === "mybuddy.context-capsule") {
        const details = message.details as { memoryBodies?: MemoryBody[] } | undefined;
        if (details?.memoryBodies?.length) this.memoryBodies.set(projected, { content: projected.content, bodies: details.memoryBodies });
      }
      return projected;
    }) ?? messages;
  }

  findRuleInstruction(messages: readonly Message[], instruction: string, sourceId: string | null) {
    for (const message of messages) {
      const capsule = this.memoryBodies.get(message);
      if (!capsule || capsule.content !== message.content) continue;
      for (const body of capsule.bodies) {
        const original = body.fullInstruction;
        if (!original || (sourceId ? body.id !== sourceId : body.scopeType !== "global")) continue;
        if (instruction === original) return { id: body.id, revision: body.revision };
      }
    }
  }

  /** Snapshot authentic capsule contents before hooks, then match them at provider dispatch. */
  captureRecallReceipt(messages: readonly Message[]) {
    const recall = this.requestRecall;
    const report = this.options.onAutomaticRecall;
    if (!recall || !report) return;
    const selected = new Set(recall.semanticSources.map(source => source.id));
    const witnesses = selected.size ? messages.flatMap(message => {
      const bodies = this.memoryBodies.get(message)?.bodies;
      return message.role === "user" && typeof message.content === "string" && bodies?.some(body => selected.has(body.id))
        ? [{ timestamp: message.timestamp, content: message.content, bodies }] : [];
    }) : [];
    return (providerMessages: readonly Message[]) => {
      const present = witnesses.filter(witness => providerMessages.some(actual => actual.role === "user"
        && actual.timestamp === witness.timestamp && actual.content === witness.content));
      report({ mode: recall.mode, semanticSources: recall.semanticSources.filter(source =>
        present.some(({ bodies }) => bodies.some(body => body.id === source.id && body.revision === source.revision))) });
    };
  }

  captureRequestGuard(): () => void {
    const guard = this.projection.captureRequestGuard();
    if (!this.usesDotsPersonalScope()) return guard;
    const withdrawal = this.projectedWithdrawal;
    return () => {
      guard();
      if (!this.usesDotsPersonalScope() || (this.options.memory?.latestWithdrawalAt(DOTS_TASK_ID) ?? 0) !== withdrawal || this.projection.requiresFreshDotsHistory())
        throw new Error("Dots 的记忆在本次请求期间已变化，请重新发送");
    };
  }
  dispose(): void { this.projection.dispose(); }
}

function toProjectionEntry(entry: EntryRecord): EvidenceProjectionEntry[] {
  const id = String(entry.id);
  if (entry.kind === "mybuddy.context-ledger" || entry.kind === "mybuddy.context-reset") return [{ type: "custom", id, customType: entry.kind, data: entry.data }];
  if (entry.head) return [{ type: "compaction", id }];
  if (entry.kind === "pi.user" || entry.kind === "mybuddy.user") {
    const message = entry.model?.find(item => item.role === "user");
    if (message) {
      const input = (entry.data as { mybuddyInput?: { displayText?: string } } | undefined)?.mybuddyInput;
      return [{ type: "message", id, message, recallText: input?.displayText?.trim() || undefined }];
    }
  }
  return [];
}

function toModelMessage(message: AgentMessage): Message {
  if (message.role === "custom") return { role: "user", content: message.content, timestamp: message.timestamp };
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "system") return message;
  throw new Error(`Unsupported evidence projection message: ${message.role}`);
}
