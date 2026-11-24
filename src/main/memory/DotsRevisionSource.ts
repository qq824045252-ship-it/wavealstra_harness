import { createHash } from "node:crypto";
import type { MemoryKind, MemoryRecordDto } from "../../shared/memory-kernel";
import { isSensitive } from "./MemoryCandidateExtraction";
import { MemoryInstructionDocument, memoryRememberClause } from "./MemoryIntent";

export interface DotsRevisionSource {
  messageId: string;
  turnId?: string;
  role: "user";
  capturedAt: number;
  quote: string;
  stance: "statement" | "reported" | "uncertain" | "source_note";
  applicability?: DotsApplicability;
}

export interface DotsApplicability {
  kind: "project" | "workspace" | "unresolved";
  name: string;
  id?: string;
}

export interface DotsApplicabilityInput {
  kind: "general" | "project" | "workspace" | "unresolved";
  evidence: string;
  name?: string;
  id?: string;
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

function normalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().trim().replace(/^["“《'「]|["”》'」]$/gu, "").replace(/\s+/gu, " ");
}

// Derive applicability only from the user's complete quotation. Ownership stays with Dots.
export function dotsScopeCondition(quote: string): DotsApplicability | undefined {
  const before = /(?:仅|只)(?:在|限于|用于)\s*([^，,。！？；\n]{1,55}?)(项目|工作区|工作空间|空间)/iu.exec(quote);
  const after = /(?:仅|只)(?:在|限于|用于)\s*(项目|工作区|工作空间|空间)\s*([^，,。！？；：:\n]{1,55})/iu.exec(quote);
  const englishBefore = /\bonly (?:for|in|on) (?:the )?([^,.!?;:\n]{1,55}?)\s+(project|workspace)\b/iu.exec(quote);
  const englishAfter = /\bonly (?:for|in|on) (?:the )?(project|workspace)\s+([^,.!?;:\n]{1,55})/iu.exec(quote);
  const leadBefore = /^(?:对(?:于)?|在)\s*([^，,。！？；：:\n]{1,55}?)(项目|工作区|工作空间|空间)(?:中|里)?\s*[，,：:]/iu.exec(quote);
  const leadAfter = /^(?:对(?:于)?|在)\s*(项目|工作区|工作空间|空间)\s*([^，,。！？；：:\n]{1,55})\s*[，,：:]/iu.exec(quote);
  const leadEnglish = /^(?:for|in|on) (?:the )?(project|workspace)\s+([^,.!?;:\n]{1,55})\s*[,:]/iu.exec(quote);
  const name = normalizeName(before?.[1] ?? after?.[2] ?? englishBefore?.[1] ?? englishAfter?.[2]
    ?? leadBefore?.[1] ?? leadAfter?.[2] ?? leadEnglish?.[2] ?? "");
  const kind = before?.[2] ?? after?.[1] ?? englishBefore?.[2] ?? englishAfter?.[1]
    ?? leadBefore?.[2] ?? leadAfter?.[1] ?? leadEnglish?.[1];
  return name && kind ? { name, kind: /^(?:项目|project)$/iu.test(kind) ? "project" : "workspace" } : undefined;
}

export function dotsRecordApplicability(record: Pick<MemoryRecordDto, "metadata" | "content">): DotsApplicability | undefined {
  const value = record.metadata.dotsApplicability as Partial<DotsApplicability> | undefined;
  if (value?.kind === "unresolved") return { kind: "unresolved", name: "" };
  if (value?.name && (value.kind === "project" || value.kind === "workspace")) return { kind: value.kind, name: value.name, id: value.id };
  return dotsScopeCondition(record.content);
}

export function sameDotsApplicability(a?: DotsApplicability, b?: DotsApplicability): boolean {
  return a?.kind === b?.kind && (a?.id && b?.id ? a.id === b.id : a?.name === b?.name);
}

export function matchesDotsApplicability(rule: DotsApplicability, query: string): boolean {
  if (rule.kind === "unresolved") return false;
  const normalized = query.normalize("NFKC").toLowerCase().replace(/["“”《》'「」]/gu, "").replace(/\s+/gu, " ");
  const name = rule.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const type = rule.kind === "project" ? "(?:项目|\\bproject\\b)" : "(?:工作区|工作空间|空间|\\bworkspace\\b)";
  const startsWithLatin = /^[\p{Script=Latin}\d]/u.test(rule.name);
  const endsWithLatin = /[\p{Script=Latin}\d]$/u.test(rule.name);
  const start = startsWithLatin ? "(?<![\\p{Script=Latin}\\p{N}])"
    : "(?:^|[\\s，,:：；;。！？!?、]|(?:在|对|为|给|了|查|看|作为|关于|对于|以及|和|与))";
  const end = endsWithLatin ? "(?![\\p{Script=Latin}\\p{N}])" : "(?=$|[\\s，,:：；;。！？!?、]|的|中|里|和|与)";
  return new RegExp(`(?:${type}\\s*${name}${end}|${start}${name}\\s*${type})`, "u").test(normalized);
}

const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const wording = (value: string) => value.trim().replace(/[.!?。！？;；]+$/u, "").trim();
const scopeNoun = /项目|工作区|工作空间|空间|任务|客户|甲方|乙方|\b(?:project|workspace|workstream|client|customer|task)\b/iu;
const generalCue = /默认|通用|全局|所有|一律|一直|以后|今后|从今|长期|平时|通常|\b(?:default|general(?:ly)?|global(?:ly)?|always|every|normally|from now on|going forward)\b/iu;
const globalMemoryHeader = /^(?:(?:请你?|帮我|麻烦你?)\s*)?(?:(?:新增|增加|添加|写入|保存)(?:一条|一个)?\s*(?:全局|通用)(?:长期)?(?:记忆|偏好|规则)|(?:把(?:这条|下面这条|以下内容))?(?:记为|存为|保存为)\s*(?:全局|通用)(?:长期)?(?:记忆|偏好|规则)|(?:please\s+)?(?:add|save|store)\s+(?:a\s+|this\s+as\s+a\s+)?global\s+(?:memory|preference|rule))(?:\s*[，,:：]\s*[^，,:：]+)?$/iu;
const universalScope = /所有|全部|每个|各个|一律|\b(?:all|every|any)\b/iu;
const unresolved: DotsApplicability = { kind: "unresolved", name: "" };
type ResolveDotsScope = (kind: "project" | "workspace", name: string, id?: string) => { id?: string; name: string } | undefined;
const references = new Set("这个 这样 此 这 那样 上述 前述 this that it so".split(" "));
const policyWords = new Set((
  "以后 今后 从今 之后 一直 默认 永远 长期 继续 都 一律 总是 按 照 依 按照 沿用 遵循 用 做 办 来 执行 保持 " +
  "from now on going forward always default keep follow apply use do continue with as the way rule"
).split(" "));

function continuingPolicy(source: string, after: number): string | undefined {
  const tail = source.slice(after);
  const sentence = Array.from(sentences.segment(tail), part => part.segment.trim()).find(Boolean);
  if (!sentence || !generalCue.test(sentence)) return;
  const terms = Array.from(words.segment(sentence), token => token.isWordLike ? token.segment.toLowerCase() : "").filter(Boolean);
  // Only a reference to the immediately preceding rule can borrow its subject.
  // A new subject, value, or action beyond confirming the rule needs its own evidence.
  if (!terms.some(term => references.has(term)) || !terms.every(term => references.has(term) || policyWords.has(term))) return;
  const start = after + tail.indexOf(sentence);
  const clauses = MemoryInstructionDocument.parse(source).clauses.filter(clause => clause.start < start + sentence.length && clause.end > start);
  return clauses.length && clauses.every(clause => clause.kind === "user") ? sentence : undefined;
}

function bindApplicability(source: string, quote: string, changeDefault: boolean, explicitGlobalSave: boolean, value?: unknown,
  resolveName?: ResolveDotsScope)
  : { applicability?: DotsApplicability; quote: string } {
  const declared = value && typeof value === "object" ? value as Partial<DotsApplicabilityInput> : undefined;
  const quoteAt = source.indexOf(quote);
  const tailAt = quoteAt + quote.length;
  const ref = typeof declared?.evidence === "string" ? declared.evidence.trim() : "";
  const refAt = ref ? source.indexOf(ref) : -1;
  const uniqueRef = refAt >= 0 && refAt === source.lastIndexOf(ref);
  const refEnd = refAt + ref.length;
  const between = refEnd <= quoteAt ? source.slice(refEnd, quoteAt) : tailAt <= refAt ? source.slice(tailAt, refAt) : "";
  const sharesPassage = uniqueRef && /^[\s。.!?！？;；,:：]*$/u.test(between);
  const attached = sharesPassage ? source.slice(Math.min(quoteAt, refAt), Math.max(tailAt, refEnd)) : quote;
  // A preceding scope header applies to a terse correction, but does not bind a
  // later statement that explicitly gives its own default scope.
  const prior = Array.from(sentences.segment(source.slice(0, quoteAt).trim()), part => part.segment.trim()).at(-1) ?? "";
  if ((declared?.kind === "project" || declared?.kind === "workspace") && sharesPassage && !isSensitive(attached)) {
    const name = typeof declared.name === "string" ? normalizeName(declared.name) : "";
    const id = typeof declared.id === "string" ? declared.id.trim() : undefined;
    const groundedName = name && attached.normalize("NFKC").toLowerCase().includes(name);
    const groundedId = id && attached.includes(id);
    const resolved = (groundedName || groundedId) && resolveName?.(declared.kind, name, id);
    return { applicability: resolved ? { kind: declared.kind, ...resolved } : unresolved, quote: attached };
  }
  if (declared?.kind === "project" || declared?.kind === "workspace") return { applicability: unresolved, quote };
  const legacy = dotsScopeCondition(quote);
  if (legacy && legacy.kind !== "unresolved") {
    const resolved = resolveName?.(legacy.kind, legacy.name);
    return { applicability: resolved ? { kind: legacy.kind, ...resolved } : unresolved, quote };
  }
  const hasLocalReference = scopeNoun.test(quote) && !(uniqueRef && refAt >= quoteAt && refEnd <= tailAt
    && universalScope.test(ref) && !scopeNoun.test(quote.replace(ref, "")));
  if (declared?.kind === "unresolved" || hasLocalReference
    || !generalCue.test(quote) && scopeNoun.test(prior) && !generalCue.test(prior)) {
    return { applicability: unresolved, quote };
  }
  const continuation = !declared || declared.kind === "general" ? continuingPolicy(source, tailAt) : undefined;
  const general = explicitGlobalSave || (declared?.kind === "general" && uniqueRef && refAt >= quoteAt && refEnd <= tailAt
    && (generalCue.test(ref) || universalScope.test(ref)))
    || continuation && (!declared || uniqueRef && continuation.includes(ref) && refAt >= tailAt);
  return { applicability: changeDefault && !general ? unresolved : undefined, quote };
}

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

function sourcePassage(passages: readonly string[], anchors: readonly (string | undefined)[]) {
  for (const hint of anchors) {
    if (!hint?.trim()) continue;
    const found = passages.filter(s => s.includes(wording(hint)));
    if (found.length === 1) return found[0];
  }
  if (passages.length === 1) return passages[0];
}

export function groundDotsClaim(claim: Claim, input: DotsSourceInput, anchor?: string,
  scope?: { declaration?: unknown; changeDefault?: boolean; globalCreate?: boolean; resolveName?: ResolveDotsScope }) {
  const text = input.text.trim();
  if (!input.messageId || !text || (anchor && !text.includes(anchor))) return;
  const document = MemoryInstructionDocument.parse(text);
  const passages = Array.from(sentences.segment(text), s => s.segment)
    .flatMap(sentence => sentence.split(/[\n；;]+/u)).map(s => s.trim()).filter(Boolean);
  const [header, body] = passages;
  // A standalone save directive supplies scope for its sole following statement.
  // Keep the directive out of the stored content and its exact source excerpt.
  const hasGlobalHeader = scope?.globalCreate && passages.length === 2 && header && body
    && globalMemoryHeader.test(wording(header)) && !scopeNoun.test(header) && document.allowsEvidence(header);
  const explicitGlobalSave = Boolean(hasGlobalHeader && body
    && (!anchor || wording(anchor).includes(wording(body)) || body.includes(wording(anchor))));
  // Expand the anchor to its complete sentence so the speaker, condition and
  // negation on either side stay attached. Independent sentences stay apart.
  const passage = explicitGlobalSave ? body : sourcePassage(passages, [anchor, claim.content, claim.title]);
  if (!passage || hasGlobalHeader && passage === header) return;
  const { quote, applicability } = bindApplicability(text, passage, scope?.changeDefault ?? false, explicitGlobalSave, scope?.declaration, scope?.resolveName);
  if (!quote || quote.length > 1200 || isSensitive(quote) || text.indexOf(quote) !== text.lastIndexOf(quote)) return;
  const start = text.indexOf(quote);
  const original = input.originalText ?? input.text;
  const offset = original.indexOf(quote);
  if (offset < 0 || offset !== original.lastIndexOf(quote)) return;
  const clauses = document.clauses.filter(c => c.start < start + quote.length && c.end > start);
  const stance: DotsRevisionSource["stance"] = reported.test(quote) || clauses.some(c => c.kind === "reference") ? "reported"
    : uncertainty.test(quote) ? "uncertain"
    : clauses.some(c => c.kind !== "user") ? "source_note"
    : explicitGlobalSave || [passage, quote].some(value => wording(claim.content ?? "") === wording(value)) ? "statement" : "source_note";
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
  const explicitlySaved = explicitGlobalSave || clauses.some(c => c.kind === "user" && memoryRememberClause(c.text));
  const explicit = (statement && claim.explicit === true) || (statement || typedNote) && explicitlySaved;
  const confidence = explicit ? claim.confidence : Math.min(claim.confidence ?? 0.7, 0.7);
  const ref = { messageId: input.messageId, turnId: input.turnId, capturedAt: input.createdAt,
    stance, start: offset, length: quote.length, hash: hash(quote), applicability };
  return { title, content, kind, explicit, confidence, stance, reason: prefix + JSON.stringify(ref), quote,
    applicability };
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
    return ref as { messageId: string; turnId?: string; capturedAt: number; stance: DotsRevisionSource["stance"]; start: number; length: number; hash: string; applicability?: DotsApplicability };
  } catch { return; }
}

export function matchesDotsQuote(quote: string, digest: string) { return hash(quote) === digest; }
