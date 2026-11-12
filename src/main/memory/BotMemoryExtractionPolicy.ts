import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryCandidateDto, MemoryTurnDto } from "../../shared/memory-kernel";
import { botMemorySource, botMemoryWriteEvidenceAllowed, botMemoryConversationOnly,
  botMemoryWorkForSource, botMemoryDurableEvidence, botMemoryTextEligible, botPeerMemoryInput } from "./BotMemorySource";

type ExtractionCandidate = Pick<MemoryCandidateDto, "kind" | "title" | "content" | "explicit" | "confidence" | "operationHint" | "replaces"> & {
  userEvidence?: string;
  retention?: string;
  sensitivity?: string;
  executionEvidence?: { turnId: string; toolCallId: string; quote: string };
};

/** Authorize each atom against its own real source before the extraction writer commits it. */
export function botExtractionPolicy(db: AppDatabase, taskId: string, candidate: ExtractionCandidate,
  sourceTurns: MemoryTurnDto[], botSource: ReturnType<typeof botMemorySource>) {
  const supportingTurns = sourceTurns.filter(turn => !botPeerMemoryInput(db, turn.userMessageId) && candidate.userEvidence && turn.userText.includes(candidate.userEvidence)
    && (!botSource || botMemoryWriteEvidenceAllowed(turn.userText, candidate.userEvidence)));
  // Scope follows the newest real user statement, not capture/completion order or old sharing instructions.
  const supportingSource = [...supportingTurns].sort((a, b) => b.capturedAt - a.capturedAt
    || Number(b.metadata.sourceUserOrdinal ?? 0) - Number(a.metadata.sourceUserOrdinal ?? 0))[0];
  const scopeWording = supportingSource?.userText ?? "";
  const durableEvidence = botMemoryDurableEvidence(scopeWording, candidate.userEvidence ?? "");
  const stablePersonal = ["identity", "preference"].includes(candidate.kind) && candidate.retention === "stable";
  const localFact = Boolean(botSource) && !durableEvidence && !stablePersonal;
  const sourceWork = botSource && supportingSource?.userMessageId && localFact
    ? botMemoryWorkForSource(db, taskId, supportingSource.userMessageId, botSource.user_id) : undefined;
  const temporary = Boolean(botSource) && botMemoryConversationOnly(scopeWording);
  const publicShared = Boolean(botSource) && !botSource?.shared && !temporary && !localFact
    && /(?:所有|全部|每个).{0,12}(?:bot|助理)|(?:公共|共享)记忆|(?:all|every)\s+(?:bots?|assistants?)|public\s+memor/i.test(scopeWording)
    && !/(?:不要|别|不必|不能|勿).{0,8}(?:共享|公开|所有|全部)|(?:do not|don['’]?t|never).{0,12}(?:share|public|all bots)/i.test(scopeWording);
  // Automatic learning has no approval queue. Local facts need a bounded scope;
  // stable personal preferences and every other candidate still require user quotes.
  const peerOnly = taskId.startsWith("bot-peer-") || sourceTurns.length > 0 && sourceTurns.every(turn => botPeerMemoryInput(db, turn.userMessageId));
  const rejected = peerOnly || Boolean(botSource) && (!candidate.userEvidence || candidate.userEvidence.trim().length < 2
    || !supportingTurns.length
    || (candidate.retention !== "stable" && !((temporary || localFact) && candidate.retention === "temporary"))
    || candidate.sensitivity !== "none"
    || !botMemoryTextEligible(`${candidate.title} ${candidate.content} ${candidate.userEvidence ?? ""} ${candidate.replaces ?? ""}`)
    || Boolean(candidate.executionEvidence) || ["progress", "open_question", "risk", "procedure"].includes(candidate.kind)
    // Foreground forget has an exact tool receipt. Never run the same deletion
    // again through fuzzy reconciliation after that reply. Other scopes retain their existing path.
    || candidate.operationHint === "forget"
    || (!candidate.explicit && candidate.confidence < 0.85));
  return { supportingTurns, durableEvidence, localFact, sourceWork, temporary, publicShared, rejected };
}
