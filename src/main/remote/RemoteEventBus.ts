import type { ServerResponse } from "node:http";
import {
  REMOTE_API_VERSION,
  type RemoteEventEnvelope,
  type RemoteEventType,
} from "../../../shared/src/remote-contract";
import type { AgentUiPatch } from "../../shared/agent-ipc";

const MAX_EVENTS = 1000;
const MAX_AGE_MS = 5 * 60_000;

export function mapAgentPatchToRemoteEvent(patch: AgentUiPatch): Record<string, unknown> {
  switch (patch.type) {
    case "user_message":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, text: patch.text, createdAt: patch.createdAt };
    case "assistant_start":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, executionId: patch.executionId, modelName: patch.modelName };
    case "assistant_message_start":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId };
    case "text_delta":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, delta: patch.delta, final: patch.final };
    case "thinking_delta":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, delta: patch.delta };
    case "tool_start":
      return {
        type: patch.type, taskId: patch.taskId, messageId: patch.messageId,
        toolCallId: patch.toolCallId, tool: patch.tool, summary: patch.summary,
        detail: patch.detail, dangerous: patch.dangerous, status: patch.status,
        approvalKind: patch.approvalKind,
        ...(patch.approvalKind === "external-write" ? {
          targetPath: patch.targetPath, taskRoot: patch.taskRoot, canonicalDir: patch.canonicalDir,
        } : {}),
      };
    case "tool_update":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, toolCallId: patch.toolCallId, status: patch.status, summary: patch.summary, output: patch.output, consult: patch.consult };
    case "artifact_ref":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, artifactId: patch.artifactId, name: patch.name, kind: patch.kind, change: patch.change };
    case "assistant_end":
      return { type: patch.type, taskId: patch.taskId, messageId: patch.messageId, durationMs: patch.durationMs, error: patch.error };
    case "compaction_status":
    case "context_usage":
      return { ...patch };
    case "generation_stats":
      return { ...patch };
    case "capability_notices":
      return { type: patch.type, taskId: patch.taskId, notices: patch.notices };
    case "conversation_interaction_snapshot":
    case "conversation_goal_snapshot":
      return { ...patch };
  }
}

export class RemoteEventBus {
  private nextId = 1;
  private readonly events: RemoteEventEnvelope[] = [];
  private readonly subscribers = new Set<(event: RemoteEventEnvelope) => void>();

  publish<T>(type: RemoteEventType, payload: T): RemoteEventEnvelope<T> {
    const event: RemoteEventEnvelope<T> = { apiVersion: REMOTE_API_VERSION, id: this.nextId++, at: Date.now(), type, payload };
    this.events.push(event);
    this.prune(event.at);
    for (const subscriber of this.subscribers) subscriber(event);
    return event;
  }

  subscribe(listener: (event: RemoteEventEnvelope) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  replayAfter(lastEventId: number): RemoteEventEnvelope[] | null {
    this.prune(Date.now());
    if (!Number.isSafeInteger(lastEventId) || lastEventId < 0) return null;
    if (lastEventId === 0) return [];
    const oldest = this.events[0]?.id;
    const newest = this.events.at(-1)?.id ?? 0;
    if (oldest !== undefined && lastEventId < oldest - 1) return null;
    if (lastEventId > newest) return null;
    return this.events.filter((event) => event.id > lastEventId);
  }

  get subscriberCount(): number { return this.subscribers.size; }

  private prune(now: number): void {
    while (this.events.length > MAX_EVENTS || (this.events[0] && now - this.events[0].at > MAX_AGE_MS)) this.events.shift();
  }
}

export function writeSseEvent(response: ServerResponse, event: RemoteEventEnvelope): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}
