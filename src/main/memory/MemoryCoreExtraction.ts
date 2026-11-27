import { DOTS_TASK_ID } from "../../shared/dots";
import { isGatewayConversation } from "../../shared/gateway-task";
import { groundDotsClaim, isDotsSingleUse } from "./DotsRevisionSource";
import type { AgentSession, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { withModelInvocationSettings } from "../agent/ModelInvocationAdmission";
import { botMemoryConversationOnly, botMemoryTextEligible, botMemoryWriteEvidenceAllowed } from "./BotMemorySource";
import { EXTRACTION_SYSTEM_PROMPT, MAX_INPUT_CHARS, extractCandidates, hashContent, isSensitive, responseText, type ExtractedCandidate } from "./MemoryCandidateExtraction";
import type { CoreMemoryExtractionCandidate, CoreMemoryExtractionPlan, CoreMemoryExtractionReadyBasis, CoreMemoryExtractionRecord, CoreMemoryExtractionScope } from "./MemoryCoreExtractionWire";
import { MemoryInstructionDocument } from "./MemoryIntent";
import { tokenSimilarity } from "./MemoryRecallRanking";

export class CoreMemoryExtractionUnavailable extends Error {
  override name = "CoreMemoryExtractionUnavailable";
}

export interface CoreMemoryExtractionInput {
  taskId: string;
  basis: CoreMemoryExtractionReadyBasis;
  model: NonNullable<AgentSession["model"]>;
  modelRuntime: ModelRuntime;
  settings: SettingsManager;
  isEnabled: () => boolean;
  assertCurrent: () => Promise<void>;
  signal?: AbortSignal;
}

type Source = { id: string; user: string; capturedAt: number; original: string };

function existingMemories(records: readonly CoreMemoryExtractionRecord[], sources: readonly Source[]) {
  const query = sources.map(source => source.user).join("\n").slice(-2000);
  const byId = new Map<string, Pick<CoreMemoryExtractionRecord, "id" | "kind" | "title" | "content" | "status"> & {
    score: number;
    scopes: CoreMemoryExtractionScope[];
  }>();
  for (const { id, kind, title, content, status, scopeType, scopeId } of records) {
    if (isSensitive(`${title}\n${content}`)) continue;
    const scope = { scopeType, scopeId };
    const existing = byId.get(id);
    const scopeScore = scopeType === "task" ? 0.12 : scopeType === "global" ? 0 : 0.08;
    const relevance = Math.max(tokenSimilarity(query, title) * 1.15, tokenSimilarity(query, content)) + scopeScore;
    if (existing) {
      existing.score = Math.max(existing.score, relevance);
      existing.scopes.push(scope);
    } else {
      byId.set(id, { id, kind, title, content, status, score: relevance, scopes: [scope] });
    }
  }
  return [...byId.values()].sort((left, right) => right.score - left.score).slice(0, 40)
    .map(({ id, kind, title, content, status, scopes }) => ({ id, kind, title, content, status, scopes }));
}

function findEvidence(candidate: ExtractedCandidate, sources: readonly Source[]): CoreMemoryExtractionCandidate["evidence"] {
  const quote = candidate.userEvidence;
  if (!quote || quote.length < 2 || isSensitive(quote) || candidate.executionEvidence) return;
  const matches = sources.filter(source => {
    if (!source.user.includes(quote) || (candidate.sourceTurnId && candidate.sourceTurnId !== source.id)) return false;
    // An occurrence in a clipped prefix cannot authorize a quoted/example occurrence in the displayed suffix.
    if (source.original.indexOf(quote) < source.original.length - source.user.length) return false;
    if (candidate.operationHint !== "forget") return botMemoryWriteEvidenceAllowed(source.original, quote);
    return MemoryInstructionDocument.parse(source.original).removalIntents().some(intent => intent.kind === "forget"
      && intent.clause.includes(quote) && intent.document.allowsEvidence(quote));
  });
  if (matches.length === 1) return { turnId: matches[0].id, quote };
}

function targetAction(kind: "duplicate" | "update" | "resolve", record: CoreMemoryExtractionRecord): CoreMemoryExtractionCandidate["action"] {
  return record.mutationAllowed
    ? { kind, targetId: record.id, expectedRevision: record.revision }
    : { kind: "review" };
}

function candidateAction(candidate: ExtractedCandidate, records: readonly CoreMemoryExtractionRecord[], evidence?: CoreMemoryExtractionCandidate["evidence"]): CoreMemoryExtractionCandidate["action"] {
  if (!evidence || (!candidate.explicit && candidate.confidence < 0.68)
      || candidate.operationHint === "forget" || candidate.operationHint === "supersede") return { kind: "review" };
  const hash = hashContent(candidate.kind, candidate.title, candidate.content);
  const duplicate = records.find(record => record.kind === candidate.kind && (record.contentHash === hash || record.content === candidate.content));
  if (duplicate) return targetAction("duplicate", duplicate);
  const targetText = candidate.replaces ?? candidate.title;
  if (candidate.operationHint === "update" || candidate.operationHint === "resolve") {
    const kind = candidate.operationHint === "resolve" ? "open_question" : candidate.kind;
    const exact = records.filter(record => record.kind === kind && (record.title === targetText || record.content === targetText));
    return exact.length === 1 ? targetAction(candidate.operationHint, exact[0]) : { kind: "review" };
  }
  const overlap = records.some(record => Math.max(
    tokenSimilarity(targetText, record.title), tokenSimilarity(targetText, record.content), tokenSimilarity(candidate.title, record.title),
  ) >= 0.72);
  return overlap && !candidate.explicit ? { kind: "review" } : { kind: "create" };
}

function planCandidates(candidates: readonly ExtractedCandidate[], basis: CoreMemoryExtractionReadyBasis, sources: readonly Source[], task: CoreMemoryExtractionScope): CoreMemoryExtractionCandidate[] {
  const active = basis.records.filter(record => record.status === "active");
  const findScope = (type: CoreMemoryExtractionScope["scopeType"]) => basis.scopes.find(scope => scope.scopeType === type);
  const bound = findScope("project") ?? findScope("workspace") ?? task;
  const plannedTargets = new Set<string>();
  const plannedCreations = new Set<string>();
  return candidates.flatMap(candidate => {
    if (candidate.sensitivity && candidate.sensitivity !== "none") return [];
    if (!candidate.content && candidate.operationHint !== "forget") return [];
    const evidence = findEvidence(candidate, sources);
    const source = evidence && sources.find(item => item.id === evidence.turnId);
    const local = candidate.retention === "temporary" || (source && botMemoryConversationOnly(source.original));
    if (task.scopeId === DOTS_TASK_ID) {
      if (!source || !evidence || local || !["identity","preference","constraint"].includes(candidate.kind)
        || candidate.operationHint !== "create" || isDotsSingleUse(evidence.quote,source.original)
        || (candidate.applicability && candidate.applicability.kind !== "general")) return [];
      const grounded = groundDotsClaim(candidate, {messageId:source.id,text:source.original,createdAt:source.capturedAt},
        evidence.quote,{declaration:candidate.applicability});
      if (!grounded || grounded.stance !== "statement" || grounded.applicability || grounded.quote !== evidence.quote) return [];
      return [{...task, kind:candidate.kind, title:evidence.quote.slice(0,240), content:evidence.quote, confidence:candidate.confidence,
        importance:candidate.importance, explicit:candidate.explicit, operationHint:"create",evidence,action:{kind:"create" as const}}];
    }
    const scope = local ? task : candidate.scopeType === "global" ? findScope("global")
      : candidate.scopeType === "workspace" || candidate.scopeType === "project" ? bound : task;
    if (!scope) throw new CoreMemoryExtractionUnavailable("Core 未授权候选记忆的全局范围");
    const records = active.filter(record => record.scopeType === scope.scopeType && record.scopeId === scope.scopeId);
    let action = candidateAction(candidate, records, evidence);
    if ("targetId" in action) {
      if (plannedTargets.has(action.targetId)) action = { kind: "review" };
      else plannedTargets.add(action.targetId);
    }
    if (action.kind === "create") {
      const key = JSON.stringify([scope.scopeType, scope.scopeId, candidate.kind, candidate.content]);
      if (plannedCreations.has(key)) return [];
      plannedCreations.add(key);
    }
    const explicit = Boolean(evidence && candidate.explicit);
    return [{ ...scope, kind: candidate.kind, title: candidate.title, content: candidate.content,
      operationHint: candidate.operationHint, ...(candidate.replaces && !isSensitive(candidate.replaces) && { replaces: candidate.replaces }),
      confidence: explicit ? Math.max(0.98, candidate.confidence) : candidate.confidence, importance: candidate.importance,
      explicit, evidence, action }];
  });
}

export async function extractCoreMemoryPlan(input: CoreMemoryExtractionInput): Promise<CoreMemoryExtractionPlan> {
  const { basis, taskId, signal } = input;
  const assertCurrent = async () => {
    const checkEnabled = () => {
      signal?.throwIfAborted();
      if (!input.isEnabled()) throw new CoreMemoryExtractionUnavailable("记忆提炼已关闭");
    };
    checkEnabled();
    await input.assertCurrent();
    checkEnabled();
  };
  const task = basis.scopes.find(scope => scope.scopeType === "task" && scope.scopeId === (isGatewayConversation(taskId) ? DOTS_TASK_ID : taskId));
  if (!task || !basis.basisStamp || (!basis.turns.length && !(basis.withheldSourceCount > 0))
      || basis.turns.some(turn => turn.taskId !== taskId)) {
    throw new CoreMemoryExtractionUnavailable("Core 未返回当前任务的提炼来源或授权范围");
  }
  const sources = basis.turns.filter(turn => botMemoryTextEligible(turn.userText)).map(turn => {
    const original = turn.userText.trim();
    return { id: turn.id, user: original.slice(-MAX_INPUT_CHARS), capturedAt: turn.capturedAt, original };
  });
  await assertCurrent();
  if (!sources.length) return { basisStamp: basis.basisStamp, candidates: [] };
  const payload = {
    task: { id: taskId, projectId: basis.scopes.find(scope => scope.scopeType === "project")?.scopeId ?? null,
      workspaceId: basis.scopes.find(scope => scope.scopeType === "workspace")?.scopeId ?? null },
    existingMemories: existingMemories(basis.records, sources),
    conversationTurns: sources.map(({ id, user, capturedAt }) => ({ id, user, capturedAt })),
  };
  const response = await withModelInvocationSettings(input.settings, () => input.modelRuntime.completeSimple(input.model, {
    systemPrompt: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }],
  }, { maxRetries: 0, maxTokens: Math.min(input.model.maxTokens || 8192, input.model.reasoning ? 8192 : 4096),
    reasoning: "low", cacheRetention: "none", signal,
    // SSE keeps the last authorization check on Pi's HTTP send, after any transport setup.
    ...(input.model.api === "openai-codex-responses" && { transport: "sse" as const }),
  }), assertCurrent);
  await assertCurrent();
  if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "记忆提炼失败");
  if (response.stopReason === "length") throw new Error("记忆提炼输出被截断，请重试或减少本批对话");
  const candidates = planCandidates(extractCandidates(responseText(response)), basis, sources, task);
  return { basisStamp: basis.basisStamp, candidates };
}
