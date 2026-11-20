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

  constructor(private readonly options: DurableEvidenceOptions, private readonly conversation: Conversation, private readonly models: Models) {
    this.projection = new EphemeralContextProjection({ ...options, registerRequestGuard: () => {} });
  }

  async project(messages: readonly Message[], context: Context): Promise<readonly Message[]> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.conversation.entries({ ...(this.newest === undefined ? {} : { minEntryId: (this.newest + 1) as EntryId }), order: "ascending" }, 500, cursor, context);
      for (const entry of page.items) this.entries.set(entry.id, entry);
      this.newest = page.items.at(-1)?.id ?? this.newest;
      cursor = page.next;
    } while (cursor);
    const [agent, active] = await Promise.all([this.conversation.agent(context), this.conversation.context(context)]);
    const branch = [...this.entries.values()].sort((a, b) => a.id - b.id).flatMap(toProjectionEntry);
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
        buildSessionProjection: () => ({ entries: projected }),
        appendCustomEntry: (kind, data) => {
          const id = `pending-${randomUUID()}`;
          branch.push({ type: "custom", id, customType: kind, data });
          additions.push({ kind, data });
          return id;
        },
      },
    });
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

  captureRequestGuard(): () => void { return this.projection.captureRequestGuard(); }
  dispose(): void { this.projection.dispose(); }
}

function toProjectionEntry(entry: EntryRecord): EvidenceProjectionEntry[] {
  const id = String(entry.id);
  if (entry.kind === "mybuddy.context-ledger" || entry.kind === "mybuddy.context-reset") return [{ type: "custom", id, customType: entry.kind, data: entry.data }];
  if (entry.head) return [{ type: "compaction", id }];
  if (entry.kind === "pi.user" || entry.kind === "mybuddy.user") {
    const message = entry.model?.find(item => item.role === "user");
    if (message) return [{ type: "message", id, message }];
  }
  return [];
}

function toModelMessage(message: AgentMessage): Message {
  if (message.role === "custom") return { role: "user", content: message.content, timestamp: message.timestamp };
  if (message.role === "user" || message.role === "assistant" || message.role === "toolResult" || message.role === "system") return message;
  throw new Error(`Unsupported evidence projection message: ${message.role}`);
}
