import { randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, Models } from "@earendil-works/pi-ai";
import type { Conversation, Cursor, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { EphemeralContextProjection, type EvidenceProjectionEntry } from "../EphemeralContextProjection";

export type DurableEvidenceOptions = Omit<ConstructorParameters<typeof EphemeralContextProjection>[0], "registerRequestGuard" | "execution">;

/** Adapts Durable provenance to the existing evidence ledger and its access/revision checks. */
export class DurableEvidenceProjection {
  private readonly projection: EphemeralContextProjection;
  private readonly entries = new Map<number, EntryRecord>();
  private newest?: EntryId;
  private guard?: () => void;

  constructor(options: DurableEvidenceOptions, private readonly conversation: Conversation, private readonly models: Models) {
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
    const result = this.projection.projectContext(messages);
    if (additions.length) {
      const stored = await this.conversation.commit(async tx => {
        const entries: EntryRecord[] = [];
        for (const addition of additions) entries.push(await tx.appendEntry(this.conversation.id, { kind: addition.kind, data: JSON.parse(JSON.stringify(addition.data)) }));
        return entries;
      }, context);
      for (const entry of stored) this.entries.set(entry.id, entry);
    }
    this.guard = this.projection.captureRequestGuard();
    this.guard();
    return result?.messages.map(toModelMessage) ?? messages;
  }

  validate(): void { this.guard?.(); }
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
