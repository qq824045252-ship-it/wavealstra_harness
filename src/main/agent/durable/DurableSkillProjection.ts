import { resolve } from "node:path";
import { z } from "zod";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { AgentLoadoutObservationService } from "../AgentLoadoutObservationService";
import type { MemorySkillEffectivenessService } from "../../memory/MemorySkillEffectivenessService";
import { resolvedPathKey } from "../../platform/paths";

const strings = z.array(z.string());
const learned = z.object({ skillId: z.string(), candidateId: z.string().optional(), sourceMemoryIds: strings });
export const durableInputAuditSchema = z.object({
  userMessageId: z.string(), assistantMessageId: z.string(), cwd: z.string(),
  skills: z.array(z.object({ id: z.string(), name: z.string(), path: z.string(), learned: learned.optional() })),
  recommendation: z.object({
    query: z.string(), mode: z.enum(["coding", "working", "general", "bot"]).transform(mode => mode === "bot" ? "general" : mode),
    projectId: z.string().optional(), workspaceId: z.string().optional(), tagId: z.string().optional(),
    context: z.object({ memoryIds: strings, scenarioIds: strings, profileIds: strings }),
    capabilities: z.array(z.object({ kind: z.enum(["expert", "skill", "connector", "mcp"]), id: z.string(), label: z.string(),
      score: z.number(), recommended: z.boolean(), actual: z.boolean(), blocked: z.boolean(), blockReason: z.string().optional(),
      evidence: z.array(z.object({ source: z.enum(["query", "mode", "project", "tag", "memory", "effectiveness", "current", "policy"]),
        label: z.string(), sourceId: z.string().optional(), weight: z.number().optional() })) })),
  }),
});
export type DurableInputAudit = z.infer<typeof durableInputAuditSchema>;
const userData = z.object({ mybuddyInput: z.object({ audit: durableInputAuditSchema }) });
const readArgs = z.object({ path: z.string() });
const successfulRead = z.object({ callId: z.string(), path: z.string(), userMessageIds: strings, at: z.number() });
const inputOutcome = z.object({ userMessageId: z.string(), assistantMessageId: z.string(), outcome: z.enum(["completed", "failed", "aborted"]), at: z.number() });
interface Turn { audits: DurableInputAudit[] }

/** Observes committed native entries. Persisted input facts make replays independent of today's skill policy. */
export class DurableSkillProjection {
  private readonly turns = new Map<string, Turn>();
  constructor(private readonly loadouts: AgentLoadoutObservationService, private readonly effectiveness: MemorySkillEffectivenessService) {}

  started(taskId: string, conversationId: string): void {
    const turn = this.turns.get(`${taskId}:${conversationId}`);
    if (!turn) return;
    for (const audit of turn.audits) {
      if (!this.loadouts.getByTurn(taskId, audit.assistantMessageId)) this.loadouts.recordAcceptedTurn({ taskId, ...audit });
      this.effectiveness.recordExposure({ taskId, assistantMessageId: audit.assistantMessageId, skills: audit.skills.flatMap(skill => skill.learned ? [skill.learned] : []) });
      const explicit = /^\/skill:([^\s]+)(?:\s|$)/.exec(audit.recommendation.query)?.[1];
      const skill = audit.skills.find(item => item.id === explicit || item.name === explicit);
      if (skill) {
        this.loadouts.markSkillUsed(taskId, audit.assistantMessageId, skill.id);
        if (skill.learned) this.effectiveness.markInvoked({ taskId, assistantMessageId: audit.assistantMessageId, skill: skill.learned, kind: "command" });
      }
    }
  }

  entries(taskId: string, conversationId: string, entries: readonly EntryRecord[]): void {
    const key = `${taskId}:${conversationId}`;
    let turn: Turn = this.turns.get(key) ?? { audits: [] };
    this.turns.set(key, turn);
    const read = (callId: string, args: unknown, users: readonly string[]) => {
      const parsed = readArgs.safeParse(args);
      if (!parsed.success) return;
      for (const audit of turn.audits.filter(item => users.includes(item.userMessageId))) {
        const path = resolvedPathKey(resolve(audit.cwd, parsed.data.path));
        const skill = audit.skills.find(item => resolvedPathKey(resolve(audit.cwd, item.path)) === path);
        if (!skill) continue;
        this.loadouts.markSkillUsed(taskId, audit.assistantMessageId, skill.id);
        if (skill.learned) this.effectiveness.markInvoked({ taskId, assistantMessageId: audit.assistantMessageId, skill: skill.learned, kind: "read", toolCallId: callId });
      }
    };
    for (const entry of entries) {
      if (entry.kind === "pi.reset") { turn = { audits: [] }; this.turns.set(key, turn); }
      if (entry.kind === "mybuddy.user" || entry.kind === "pi.user") {
        const parsed = userData.safeParse(entry.data);
        if (parsed.success && !turn.audits.some(audit => audit.userMessageId === parsed.data.mybuddyInput.audit.userMessageId)) turn.audits.push(parsed.data.mybuddyInput.audit);
      }
      if (entry.kind === "mybuddy.skill-read") {
        const result = successfulRead.safeParse(entry.data);
        if (result.success) { this.started(taskId, conversationId); read(result.data.callId, { path: result.data.path }, result.data.userMessageIds); }
      }
      if (entry.kind === "mybuddy.input-outcome") {
        const result = inputOutcome.safeParse(entry.data);
        if (result.success) {
          const { assistantMessageId, userMessageId, outcome, at } = result.data;
          this.effectiveness.markTurnOutcome(taskId, assistantMessageId, outcome, at);
          this.loadouts.markOutcome(taskId, assistantMessageId, outcome, at);
          turn.audits = turn.audits.filter(audit => audit.userMessageId !== userMessageId);
        }
      }
      for (const message of entry.model ?? []) {
        if (message.role === "assistant") {
          this.started(taskId, conversationId);
        }
      }
    }
  }

  release(taskId: string): void { for (const key of this.turns.keys()) if (key.startsWith(`${taskId}:`)) this.turns.delete(key); }
}
