import { createHash } from "node:crypto";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { canonicalJson, type WorkOutcomePayload, type WorkOwnerSummaryItem, type WorkOwnerSummaryPayload } from "../../../shared/bot-work-phase5";
import { WorkResultCards, pendingDecisionBlockers } from "./WorkResultCards";
import type { WorkService } from "./WorkService";

const sorted = (values: readonly string[]): string[] => [...new Set(values)].sort();
const text = (value: string): string => value.trim().replace(/\s+/gu, " ");
const terminal = (binding: WorkExecutionBindingDto): boolean => ["completed", "failed", "stopped"].includes(binding.status);

export interface WorkOwnerSummaryFacts {
  managed: boolean;
  hasSubstance: boolean;
  ready: boolean;
  outcome: WorkOutcomePayload;
  digest: string;
  payload: WorkOwnerSummaryPayload;
  provenanceRefs: string[];
  firstFactAt: number;
  urgentDecisionKeys: string[];
  handledKeys: string[];
}

/** Reads only existing Work/worker facts. It never accepts a report or starts an execution. */
export function collectOwnerSummaryFacts(works: WorkService, work: WorkDto, now: number): WorkOwnerSummaryFacts {
  const bindings = works.repo.listBindings(work.workId)
    .filter(binding => works.collaboration.isDelegationAdopted(binding, work));
  const byBinding = new Map(bindings.map(binding => [binding.bindingId, binding]));
  const deliverables = works.repo.listDeliverables(work.workId).filter(item => item.intentRevision === work.intentRevision
    && item.inputSnapshotId === work.inputSnapshotId && item.status !== "superseded" && byBinding.has(item.executionId));
  const subitems = works.partialResults.list(work.workId).filter(item => byBinding.has(item.bindingId)
    && item.intentRevision === work.intentRevision && item.inputSnapshotId === work.inputSnapshotId);
  const gaps = new Set(works.partialResults.gaps(work.workId).map(item => item.factId));
  const messages = works.collaboration.history(work.workId).filter(message => message.intentRevision === work.intentRevision
    && message.inputSnapshotId === work.inputSnapshotId
    && message.executionRefs.every(ref => byBinding.has(ref.bindingId)));
  const owners = new Map<number, string>([[work.ownerEpoch, work.ownerBotId]]);
  // Only the host's committed handoff has a previous-epoch guard. Ordinary messages
  // must carry the current epoch, so they cannot manufacture this ownership history.
  for (const message of messages) if (message.kind === "handoff" && message.senderBotId
    && message.versionGuard.expectedOwnerEpoch === message.ownerEpoch - 1) owners.set(message.ownerEpoch - 1, message.senderBotId);
  const members = sorted([
    ...work.participants.filter(member => member.botId !== work.ownerBotId && member.role !== "watcher").map(member => member.botId),
    ...bindings.map(binding => binding.botId),
    ...messages.filter(message => message.kind === "delegate").flatMap(message => message.recipientBotIds),
  ]);
  const managed = members.some(botId => botId !== work.ownerBotId) || subitems.length > 1;
  const items = new Map<string, WorkOwnerSummaryItem>();
  const reported = new Set<string>();
  const decisions = new Set<string>();
  const urgent = new Set<string>();
  const provenance = new Set<string>();
  const times: number[] = [];
  let awaitingReview = false;
  const add = (input: Omit<WorkOwnerSummaryItem, "key">, sourceRefs: string[], at: number,
    pending = false, immediate = false): void => {
    const item = { ...input, text: text(input.text), artifactRefs: sorted(input.artifactRefs),
      criterionIds: sorted(input.criterionIds), writeConflicts: sorted(input.writeConflicts) };
    const key = createHash("sha256").update(canonicalJson(item)).digest("hex");
    items.set(key, { key, ...item });
    if (input.botId) reported.add(input.botId);
    for (const ref of sourceRefs) provenance.add(ref);
    times.push(at);
    if (pending) decisions.add(key);
    if (immediate) urgent.add(key);
  };
  const empty = { artifactRefs: [] as string[], criterionIds: [] as string[], writeConflicts: [] as string[], isError: false };

  for (const deliverable of deliverables) {
    const accepted = deliverable.status === "accepted" && work.acceptedDeliverableIds.includes(deliverable.deliverableId);
    const rejected = deliverable.status === "rejected";
    const uncovered = sorted([...deliverable.uncoveredScope, ...work.criteria.filter(criterion =>
      deliverable.uncoveredCriterionIds.includes(criterion.id) && !["satisfied", "waived"].includes(criterion.status)).map(criterion => criterion.text)]);
    awaitingReview ||= !accepted && !rejected;
    add({ ...empty, kind: accepted ? "accepted" : rejected ? "rejected" : "awaiting_review",
      botId: deliverable.producerBotId, text: rejected ? deliverable.rejectedReason ?? deliverable.summary
        : `${deliverable.summary}${uncovered.length ? `（仍未覆盖：${uncovered.join("；")}）` : ""}`,
      artifactRefs: deliverable.artifactRefs, criterionIds: deliverable.uncoveredCriterionIds,
      writeConflicts: deliverable.hasWriteConflicts ? ["required-write-conflict"] : [],
      isError: rejected || deliverable.hasWriteConflicts },
    [`deliverable:${deliverable.deliverableId}`, `binding:${deliverable.executionId}`, ...deliverable.evidenceRefs.map(id => `evidence:${id}`)],
    deliverable.reviewedAt ?? deliverable.createdAt, !accepted || deliverable.hasWriteConflicts || uncovered.length > 0);
  }

  for (const item of subitems) {
    // Resolved continuation gaps remain in the ledger, not as a permanent current failure.
    if (item.outcome !== "completed" && item.required && !gaps.has(item.factId)) continue;
    if (item.outcome === "unknown" || item.outcome === "not_started") continue;
    if (item.outcome === "completed" && !item.writeConflicts.length && item.deliverableId
      && deliverables.some(value => value.deliverableId === item.deliverableId)) continue;
    const failed = item.outcome === "failed" || item.outcome === "stopped";
    const kind = item.outcome === "rejected" ? "rejected" : item.outcome === "blocked" ? "blocked" : failed ? "error" : "reported";
    awaitingReview ||= item.outcome === "completed";
    add({ ...empty, kind, botId: byBinding.get(item.bindingId)!.botId, text: item.summary || item.task,
      artifactRefs: item.artifactRefs, criterionIds: item.criterionIds, writeConflicts: item.writeConflicts,
      isError: item.outcome !== "completed" || item.writeConflicts.length > 0 },
    [`subitem:${item.factId}`, `binding:${item.bindingId}`], item.createdAt,
    item.required && (item.outcome !== "completed" || item.writeConflicts.length > 0));
  }

  const messageKey = (message: typeof messages[number]) => canonicalJson([
    message.kind, message.senderBotId, text(message.body), sorted(message.artifactRefs),
  ]);
  const resolvedMessages = new Set(messages.filter(message => ["blocked", "question"].includes(message.kind)
    && messages.some(reply => reply.replyToMessageId === message.messageId && reply.kind === "accepted"
      && reply.senderKind === "bot" && reply.senderBotId === owners.get(reply.ownerEpoch))).map(messageKey));
  for (const message of messages) {
    if (!["result", "blocked", "question"].includes(message.kind)) continue;
    if (resolvedMessages.has(messageKey(message))) continue;
    // Acceptance is the proof for these reports; a replay with another message ID is not a new result.
    const covered = message.executionRefs.length > 0 && message.executionRefs.every(ref =>
      deliverables.some(item => item.executionId === ref.bindingId && item.status === "accepted"));
    if (message.kind === "result" && covered) {
      provenance.add(`message:${message.messageId}`);
      continue;
    }
    const kind = message.kind === "result" ? "reported" : message.kind as "blocked" | "question";
    awaitingReview ||= kind === "reported";
    add({ ...empty, kind, botId: message.senderBotId ?? undefined, text: message.body,
      artifactRefs: message.artifactRefs, isError: kind === "blocked" },
    [`message:${message.messageId}`, ...message.executionRefs.map(ref => `binding:${ref.bindingId}`)], message.createdAt,
    kind === "blocked" || kind === "question");
  }

  for (const binding of bindings) {
    if (!terminal(binding) || deliverables.some(item => item.executionId === binding.bindingId)
      || subitems.some(item => item.bindingId === binding.bindingId)
      || messages.some(message => ["result", "blocked"].includes(message.kind) && message.executionRefs.some(ref => ref.bindingId === binding.bindingId))) continue;
    const failed = binding.status !== "completed";
    awaitingReview ||= !failed;
    add({ ...empty, kind: failed ? "error" : "awaiting_review", botId: binding.botId,
      text: binding.settlementNote || (failed ? "成员执行未产出可验收成果" : "成员执行已结束，等待负责人核验成果"), isError: failed },
    [`binding:${binding.bindingId}`], binding.settledAt ?? binding.admittedAt, true);
  }

  for (const blocker of pendingDecisionBlockers(works.repo.listBlockers(work.workId))) {
    add({ ...empty, kind: "blocked", text: blocker.reason, isError: true },
      [`blocker:${blocker.blockerId}`], blocker.createdAt, true, true);
  }
  const hasResults = items.size > 0;
  if (hasResults) for (const criterion of work.criteria.filter(item => item.requiresRealEnvironmentCheck && !["satisfied", "waived"].includes(item.status))) {
    add({ ...empty, kind: "awaiting_environment", text: `待实测：${criterion.text}${criterion.requiredEnvironment ? `（${criterion.requiredEnvironment}）` : ""}`,
      criterionIds: [criterion.id] }, [`criterion:${criterion.id}`], Math.min(...times), true);
  }
  if (work.authorization.expiresAt !== undefined && work.authorization.expiresAt <= now && work.lifecycle !== "closed") {
    add({ ...empty, kind: "authorization", text: "事项授权已到期，等待用户确认后续范围" },
      [`authorization:${work.workId}:${work.authorization.expiresAt}`], work.authorization.expiresAt, true, true);
  }
  const waitingForBotIds = members.filter(botId => !reported.has(botId));
  const payload: WorkOwnerSummaryPayload = { version: 1, items: [...items.values()].sort((a, b) => a.key.localeCompare(b.key)),
    waitingForBotIds, pendingDecisionKeys: [...decisions].sort() };
  const outcome: WorkOutcomePayload = {
    ...WorkResultCards.acceptedOutcome(work, deliverables, "owner_summary"), ownerSummary: payload,
    pendingBlockerCodes: payload.pendingDecisionKeys,
    artifactRefs: sorted([...deliverables.flatMap(item => item.artifactRefs), ...payload.items.flatMap(item => item.artifactRefs)]),
  };
  // The canonical JSON includes structured evidence only; order, clocks and physical
  // replay IDs live in provenance/watermarks rather than the semantic identity.
  return { managed, hasSubstance: items.size > 0, ready: waitingForBotIds.length === 0 && !awaitingReview
      && bindings.every(terminal), outcome, digest: WorkResultCards.computeOutcomeHash(outcome), payload,
    provenanceRefs: [...provenance].sort(), firstFactAt: times.length ? Math.min(...times) : now,
    urgentDecisionKeys: [...urgent].sort(), handledKeys: payload.items.map(item => item.key) };
}

export function renderOwnerSummary(payload: WorkOwnerSummaryPayload, name: (botId: string) => string): string {
  const labels: Record<WorkOwnerSummaryItem["kind"], string> = { accepted: "已验收", reported: "成员报告（待核验）",
    awaiting_review: "待负责人核验", blocked: "阻碍", question: "待决问题", rejected: "已拒绝", error: "执行缺口",
    awaiting_environment: "实测等待", authorization: "授权等待" };
  const lines = payload.items.map(item => `${labels[item.kind]}${item.botId ? ` · ${name(item.botId)}` : ""}：${item.text}`);
  if (payload.waitingForBotIds.length) lines.push(`尚待成员：${payload.waitingForBotIds.map(name).join("、")}`);
  return lines.join("\n").slice(0, 12_000);
}
