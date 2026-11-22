import { createHash } from "node:crypto";
import type { MemoryKind } from "../../shared/memory-kernel";
import { isSensitive } from "./MemoryCandidateExtraction";
import { MemoryInstructionDocument, memoryRememberClause } from "./MemoryIntent";

export interface DotsRevisionSource {
  messageId: string;
  turnId?: string;
  role: "user";
  capturedAt: number;
  quote: string;
  stance: "statement" | "reported" | "uncertain" | "source_note";
}

type Claim = { kind: MemoryKind; title: string; content?: string; explicit?: boolean; confidence?: number };
export type DotsSourceInput = { messageId: string; turnId?: string; text: string; originalText?: string; createdAt: number };
const prefix = "dots-source-v1 ";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

// A guess or attribution can downgrade authority. No keyword promotes an
// inferred proposition: the saved claim must preserve the speaker's words.
const uncertainty = /(?:也许|可能|猜测?|估计|推测|尚未|待定|不确定|未确认|没决定|还没|或许)|\b(?:guess|might|maybe|perhaps|uncertain|suspect|unconfirmed|not sure|undecided)\b/iu;
const reported = /(?:提议|转述|据说|建议称|[他她]说|认为|听说|引述)|\b(?:said|says|suggested|proposed|according to|reportedly|told me)\b/iu;
const singleUse = /(?:仅此一次|这次例外|此次例外|本次例外|只此一次|只限这次|只限此次|只限本次|(?:仅|只)(?:在|用于)?(?:这次|此次|本次|这一回)(?:有效|适用|使用))|\b(?:this time only|just this once|one[- ]time exception|for this (?:request|turn) only)\b/iu;

export function isDotsSingleUse(quote: string, input = quote): boolean {
  if (singleUse.test(quote)) return true;
  const quoteAt = input.indexOf(quote);
  if (quoteAt < 0) return false;
  const prefix = input.slice(0, quoteAt).trim().replace(/[。！!；;：:.]+$/u, "").trim();
  const directive = prefix.split(/[。！!；;\n.]/u).at(-1)?.trim() ?? "";
  return directive.length <= 24 && singleUse.test(directive);
}

// Applicability comes from the complete quoted clause. It grants no new scope access.
export function dotsScopeCondition(quote: string): string | undefined {
  const before = /(?:仅|只)(?:在|限于|用于)\s*([^，,。！？；\n]{1,55}?)(?:项目|工作区|空间)/iu.exec(quote)?.[1];
  const after = /(?:仅|只)(?:在|限于|用于)\s*(?:项目|工作区|空间)\s*([^，,。！？；\n]{1,55})/iu.exec(quote)?.[1];
  const english = /\bonly (?:for|in|on) (?:the )?(?:(?:project|workspace)\s+([^,.!?;\n]+)|([^,.!?;\n]+?)\s+(?:project|workspace)\b)/iu.exec(quote);
  return (before ?? after ?? english?.[1] ?? english?.[2])?.trim().normalize("NFKC").toLowerCase() || undefined;
}

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const wording = (value: string) => value.trim().replace(/[.!?。！？;；]+$/u, "").trim();

/** A short update ("switch to Tuesday") can retain its earlier attested
 * subject. Only reuse a substring present in both the proposed label and source. */
export function dotsSubject(title: string, source: string): string | undefined {
  const topic = title.trim().slice(0, 100);
  for (let size = topic.length; size >= 2; size--) {
    for (let start = 0; start + size <= topic.length; start++) {
      const part = topic.slice(start, start + size).trim();
      if (part.length === size && source.includes(part) && /\p{L}/u.test(part)
        && (size >= 4 || /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(part))) return part;
    }
  }
}

function sourcePassage(text: string, anchors: readonly (string | undefined)[]) {
  const passages = Array.from(sentences.segment(text), s => s.segment)
    .flatMap(sentence => sentence.split(/[\n；;]+/u)).map(s => s.trim()).filter(Boolean);
  for (const hint of anchors) {
    if (!hint?.trim()) continue;
    const found = passages.filter(s => s.includes(wording(hint)));
    if (found.length === 1) return found[0];
  }
  if (passages.length === 1) return passages[0];
}

export function groundDotsClaim(claim: Claim, input: DotsSourceInput, anchor?: string) {
  const text = input.text.trim();
  if (!input.messageId || !text || (anchor && !text.includes(anchor))) return;
  // Expand the anchor to its complete sentence so the speaker, condition and
  // negation on either side stay attached. Independent sentences stay apart.
  const quote = sourcePassage(text, [anchor, claim.content, claim.title]);
  if (!quote || quote.length > 1200 || isSensitive(quote) || text.indexOf(quote) !== text.lastIndexOf(quote)) return;
  const start = text.indexOf(quote);
  const original = input.originalText ?? input.text;
  const offset = original.indexOf(quote);
  if (offset < 0 || offset !== original.lastIndexOf(quote)) return;
  const document = MemoryInstructionDocument.parse(text);
  const clauses = document.clauses.filter(c => c.start < start + quote.length && c.end > start);
  const stance: DotsRevisionSource["stance"] = reported.test(quote) || clauses.some(c => c.kind === "reference") ? "reported"
    : uncertainty.test(quote) ? "uncertain"
    : clauses.some(c => c.kind !== "user") ? "source_note"
    : wording(claim.content ?? "") === wording(quote) ? "statement" : "source_note";
  // A complete exact quotation is safe in every language. A short fragment
  // cannot establish who owns the statement or whether the user endorsed it.
  const statement = stance === "statement";
  const content = quote;
  const title = dotsSubject(claim.title, quote) ?? dotsSubject(claim.title, text) ?? quote.slice(0, 76);
  // Classification describes the quoted passage. A paraphrase from the model
  // does not erase its topic, nor does the topic establish user endorsement.
  const typedNote = stance === "source_note" && clauses.every(c => c.kind === "user")
    && (claim.kind === "preference" || claim.kind === "constraint");
  const kind = statement || typedNote ? claim.kind : "fact";
  const explicitlySaved = clauses.some(c => c.kind === "user" && memoryRememberClause(c.text));
  const explicit = (statement && claim.explicit === true) || (statement || typedNote) && explicitlySaved;
  const confidence = explicit ? claim.confidence : Math.min(claim.confidence ?? 0.7, 0.7);
  const ref = { messageId: input.messageId, turnId: input.turnId, capturedAt: input.createdAt,
    stance, start: offset, length: quote.length, hash: hash(quote) };
  return { title, content, kind, explicit, confidence, stance, reason: prefix + JSON.stringify(ref), quote };
}

export function dotsSourcePointer(reason?: string) {
  if (!reason?.startsWith(prefix)) return;
  try {
    const ref = JSON.parse(reason.slice(prefix.length));
    if (typeof ref.messageId !== "string" || !ref.messageId
      || (ref.turnId !== undefined && typeof ref.turnId !== "string")
      || !Number.isFinite(ref.capturedAt) || !Number.isSafeInteger(ref.start) || ref.start < 0
      || !Number.isSafeInteger(ref.length) || ref.length < 1 || ref.length > 1200
      || typeof ref.hash !== "string" || !["statement","reported","uncertain","source_note"].includes(ref.stance)) return;
    return ref as { messageId: string; turnId?: string; capturedAt: number; stance: DotsRevisionSource["stance"]; start: number; length: number; hash: string };
  } catch { return; }
}

export function matchesDotsQuote(quote: string, digest: string) { return hash(quote) === digest; }
