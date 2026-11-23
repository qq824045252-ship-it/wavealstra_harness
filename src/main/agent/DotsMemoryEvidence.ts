import type { MemoryRecordDto } from "../../shared/memory-kernel";
import { defaultDotsMemoryLimits } from "../../shared/dots-limits";
import { createHash } from "node:crypto";
import { isSensitive } from "../memory/MemoryCandidateExtraction";
import type { MemoryService } from "../memory/MemoryService";

export interface EvidenceRange { start: number; end: number }

const stop = new Set("a an and are as at be by can could did do does for from had has have how i in is it me my of on or that the this to was were what when where which who with you your".split(" "));

export function dotsQueryTerms(query: string): string[] {
  const words = query.normalize("NFKC").toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) ?? [];
  const terms = new Set<string>();
  for (const word of words) {
    if (/\p{Script=Han}/u.test(word)) {
      for(let i=0;i<word.length-1 && terms.size<48;i++) terms.add(word.slice(i,i+2));
    } else if(word.length>1 && !stop.has(word)) terms.add(word);
    if(terms.size>=48)break;
  }
  return [...terms];
}

// Choose a verbatim window. The ledger stores UTF-16 offsets to this exact revision;
// it never re-runs query matching when a historical request is restored.
export function dotsEvidenceRange(content: string, terms: string[], maxBytes: number): EvidenceRange {
  if(Buffer.byteLength(content)<=maxBytes) return {start:0,end:content.length};
  const units=Array.from(content);
  const offsets=[0], bytes=[0];
  for(const unit of units) {
    offsets.push(offsets.at(-1)!+unit.length);
    bytes.push(bytes.at(-1)!+Buffer.byteLength(unit));
  }
  const candidates=[0];
  // Include overlapping windows even in unpunctuated imports (logs, OCR, transcripts).
  let last=0;
  for(let i=1;i<units.length;i++){
    const distance=bytes[i]!-bytes[last]!;
    if(distance>=maxBytes/2 || (distance>=maxBytes/6 && /[。！？.!?\n]/u.test(units[i-1]!))) {
      candidates.push(i);last=i;
    }
  }
  let best={start:0,end:0},bestScore=-1,end=0;
  for(const start of candidates){
    end=Math.max(end,start);
    while(end<units.length && bytes[end+1]!-bytes[start]!<=maxBytes)end++;
    const excerpt=content.slice(offsets[start],offsets[end]).normalize("NFKC").toLowerCase();
    const score=terms.reduce((sum,term)=>sum+(excerpt.includes(term)?1:0),0);
    if(score>bestScore){best={start:offsets[start]!,end:offsets[end]!}; bestScore=score;}
    if(end===units.length) break;
  }
  return best;
}

export interface DotsUserQuote {
  messageId: string;
  turnId?: string;
  revision: number;
  hash: string;
}

function quoteHash(value: string) { return createHash("sha256").update(value).digest("hex"); }

const stanceLabels = {
  statement: "陈述",
  reported: "转述，未确认本人采纳",
  uncertain: "尚未确定",
  source_note: "来源说明",
} as const;

export function dotsPreferenceQuote(memory: MemoryService, record: Pick<MemoryRecordDto, "id">, revision: number,
  maxBytes = defaultDotsMemoryLimits.quoteBytes) {
  const source = memory.getDotsRevisionSource(record.id, revision);
  if (!source || !source.quote.trim() || isSensitive(source.quote)) return;
  // Keep the original sentence together: a partial quote can omit a negation.
  // Overlong evidence remains accessible through the scoped read tool.
  if (Buffer.byteLength(source.quote) > maxBytes) return;
  const text = `用户原话摘录（${stanceLabels[source.stance]}；${new Date(source.capturedAt).toISOString()}；消息 ${source.messageId}）：${source.quote}`;
  return { text, ref: { messageId: source.messageId, turnId: source.turnId, revision, hash: quoteHash(text) } };
}

export function restoreDotsPreferenceQuote(memory: MemoryService, id: string, ref: DotsUserQuote, revision: number): string | undefined {
  if (ref.revision !== revision) return;
  // A new selection budget must not invalidate a previously supplied quote.
  const quote = dotsPreferenceQuote(memory, { id }, revision, Infinity);
  if (quote && quote.ref.turnId === ref.turnId && quote.ref.messageId === ref.messageId && quote.ref.hash === ref.hash) return quote.text;
}
