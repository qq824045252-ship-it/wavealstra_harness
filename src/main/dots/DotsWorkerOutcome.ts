export const DOTS_WORK_ITEM_ID_PATTERN = "^work-[a-f0-9]{16}$";
export type DotsWorkEvidence = { id: string; evidence: string };

export type DotsWorkerOutcome =
  | { dotsState: "complete"; result: string; delivery?: { text: string }; executionRecord?: string;
      verifiedChecks?: string[]; verifiedCommit?: string; completedItems?: DotsWorkEvidence[] }
  | { dotsState: "blocked"; result: string; delivery?: { text: string } }
  | { dotsState: "progress"; result: string; remainingQuote: string; scopeQuote?: string };

/** An accepted native answer ends a model turn. The worker declares whether it ends the assignment. */
export function readDotsWorkerOutcome(text: string): DotsWorkerOutcome | undefined {
  const standalone = parseWorkerOutcome(outcomeJson(text));
  if (standalone) return standalone;

  // Some workers put an execution note before the receipt. Only a strict receipt at
  // the end of this worker's message can advance the assignment.
  const boundaries = [...text.matchAll(/\r?\n[ \t]*(?:```(?:json)?[ \t]*\r?\n[ \t]*)?(?=\{\s*"dotsState"\s*:)/giu)];
  for (const boundary of boundaries.reverse()) {
    const prose = text.slice(0, boundary.index);
    if (!prose.trim() || insideMarkdownFence(prose)) continue;
    const outcome = parseWorkerOutcome(outcomeJson(text.slice(boundary.index).trim()), true);
    if (outcome) return outcome.dotsState === "complete" ? { ...outcome, executionRecord: prose.trim() } : outcome;
  }
}

function insideMarkdownFence(text: string): boolean {
  let open = "";
  for (const [, marker, info] of text.matchAll(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)/gmu)) {
    if (!open) open = marker;
    else if (marker.startsWith(open) && !info.trim()) open = "";
  }
  return Boolean(open);
}

function outcomeJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.startsWith("```") ? /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed) : undefined;
  return fenced?.[1] ?? trimmed;
}

function parseWorkerOutcome(json: string, exact = false): DotsWorkerOutcome | undefined {
  if (!json.startsWith("{")) return;
  try {
    const value = JSON.parse(json);
    if (typeof value?.result !== "string") return;
    if (value.dotsState === "complete" || value.dotsState === "blocked") {
      if ("delivery" in value) {
        if (typeof value.delivery?.text !== "string") return;
        if (exact && (Object.keys(value).length !== 3 || Object.keys(value.delivery).length !== 1)) return;
        if (value.dotsState === "blocked" && !value.result.trim() && !value.delivery.text.trim()) return;
        return { dotsState: value.dotsState, result: value.result, delivery: { text: value.delivery.text } };
      }
      if (exact && Object.keys(value).length !== 2) return;
      if (value.dotsState === "blocked") return value.result.trim() ? { dotsState: "blocked", result: value.result } : undefined;
      // The native projector rebuilds this envelope using settled receipts.
      return { dotsState: "complete", result: value.result,
        ...(typeof value.executionRecord === "string" && { executionRecord: value.executionRecord }),
        ...(Array.isArray(value.verifiedChecks) && value.verifiedChecks.every((name: unknown) => typeof name === "string")
          && { verifiedChecks: value.verifiedChecks }),
        ...(typeof value.verifiedCommit === "string" && /^[a-f0-9]{40,64}$/.test(value.verifiedCommit)
          && { verifiedCommit: value.verifiedCommit }),
        ...(Array.isArray(value.completedItems) && value.completedItems.every(isWorkEvidence)
          && { completedItems: value.completedItems }),
      };
    }
    if (value.dotsState === "progress" && typeof value.remainingQuote === "string" && (!exact || Object.keys(value).length === (typeof value.scopeQuote === "string" ? 4 : 3))) {
      return { dotsState: "progress", result: value.result, remainingQuote: value.remainingQuote.trim(),
        ...(typeof value.scopeQuote === "string" && { scopeQuote: value.scopeQuote.trim() }) };
    }
  } catch {
    // Ordinary model prose does not declare an outcome.
  }
}

function isWorkEvidence(value: unknown): value is DotsWorkEvidence {
  if (!value || typeof value !== "object" || !("id" in value) || !("evidence" in value)) return false;
  return typeof value.id === "string" && new RegExp(DOTS_WORK_ITEM_ID_PATTERN).test(value.id) &&
    typeof value.evidence === "string" && Boolean(value.evidence.trim());
}

export function dotsDeliveryText(outcome: DotsWorkerOutcome): string {
  if (outcome.dotsState === "complete") return outcome.delivery?.text ?? outcome.result;
  if (outcome.dotsState === "blocked") return outcome.delivery?.text.trim() || outcome.result;
  return outcome.result;
}

/** A complete envelope can still describe an outstanding requirement and ask the
 * user to unblock it. Check both parts of the native answer before accepting it. */
export function dotsMissingInputQuestion(delivery: string, executionRecord: string): string | undefined {
  const sentences = (text: string) => text.replace(/^ {0,3}(?:```|~~~)[^\r\n]*\r?\n[\s\S]*?^ {0,3}(?:```|~~~)[ \t]*$/gmu, "")
    .replace(/^\s*>[^\r\n]*/gmu, "").match(/[^。！？!?\r\n]+[。！？!?]*/gu) ?? [];
  const publicSentences = sentences(delivery);
  const internalSentences = sentences(executionRecord);
  const outstanding = /(?:尚未|还未|还没(?:有)?|未能|无法|不能|没有|没能|未)(?:能)?(?:交付|完成|给出|核算|核对|计算|读取|读到|找到|验证|汇总)|(?:not yet|unable to|could not|still need to)\s+(?:complete|verify|check|read|find|calculate|deliver)/iu;
  const input = /文件|资料|数据|源表|原表|表格|明细|台账|附件|\b(?:file|spreadsheet|data|records?|attachment)s?\b/iu;
  const request = /请(?:你|您)?\s*(?:把|提供|上传|补发|补充|发给|放入|放进|告诉|给出|确认|选择|贴出)|\bplease\s+(?:provide|upload|attach|send|share|confirm|choose)\b/iu;
  const optional = /如需|如有需要|下次|另行|可选|if (?:you (?:need|wish|want)|needed)|optionally/iu;
  const asksForInput = (sentence: string) => request.test(sentence) && !optional.test(sentence);
  const evidence = [...publicSentences, ...internalSentences];
  const missing = evidence.filter(sentence => outstanding.test(sentence) && !optional.test(sentence));
  if (!missing.length) return;
  const publicRequest = publicSentences.find(asksForInput);
  const missingInput = missing.some(sentence => input.test(sentence));
  if (publicRequest && (missingInput || input.test(publicRequest))) return delivery;
  return internalSentences.find(sentence => asksForInput(sentence) && (missingInput || input.test(sentence)))?.trim();
}

/** A worker can finish with a bare report or value. Only accept it when the user's
 * quoted delivery instruction describes a format we can check without guessing. */
export function dotsDeliveryFormatCheck(text: string, instruction: string | undefined): boolean | undefined {
  if (!instruction) return;
  if (/只(?:要|给|交|回|回复)\s*(?:一个)?\s*(?:整数|数字)/u.test(instruction)) return /^-?\d+$/u.test(text);
  if (/只(?:要|给|交|回|回复)\s*(?:单行(?:的)?\s*)?JSON\b/iu.test(instruction)) {
    if (!text.startsWith("{") || /\r|\n/u.test(text)) return false;
    const keys = /键名(?:依次)?(?:是|为)\s*([a-z0-9_]+(?:\s*、\s*[a-z0-9_]+)*)/iu.exec(instruction)?.[1]?.split(/\s*、\s*/u);
    if (!keys) return;
    try { return JSON.stringify(Object.keys(JSON.parse(text))) === JSON.stringify(keys); }
    catch { return false; }
  }
  const hashHeadings = [...instruction.matchAll(/##[ \t]+([^、，。；！？「」“”\r\n]+)/gu)].map(([, heading]) => heading.trim());
  const required = hashHeadings.length ? hashHeadings : [...(instruction.split(/二级标题/u)[1] ?? "")
    .split(/[。；！？\r\n]/u, 1)[0].matchAll(/「([^」]+)」/gu)].map(([, heading]) => heading.trim());
  if (required.length < 2) return;
  if (!text.startsWith("## ")) return false;
  const matches = [...text.replace(/^ {0,3}(?:```|~~~)[^\r\n]*\r?\n[\s\S]*?^ {0,3}(?:```|~~~)[ \t]*$/gmu, "")
    .matchAll(/^##[ \t]+([^\r\n]+)\r?\n([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/gmu)];
  return matches.length === required.length && matches.every(([, heading, body], index) =>
    heading.trim() === required[index] && Boolean(body.trim()));
}

export function matchesDotsDeliveryFormat(text: string, instruction: string | undefined): boolean {
  return !!text.trim() && dotsDeliveryFormatCheck(text, instruction) === true;
}

export function onlyDeliveryFilename(instruction: string | undefined): string | undefined {
  const requested = /^(?:完成后[，,\s]*)?(?:请\s*)?只(?:给我?|交付?|发(?:给我?)?|要)\s*(.+?)[。！!]?$/u
    .exec(instruction?.trim() ?? "")?.[1]?.trim();
  if (!requested) return;
  const quoted = /^「([^」]+)」$|^“([^”]+)”$|^"([^"]+)"$/u.exec(requested);
  const filename = quoted?.[1] ?? quoted?.[2] ?? quoted?.[3] ?? requested;
  if (!quoted && /\.[a-z\d]+\s*(?:以及|和|与|及|and\b)\s*[^\s]+\.[a-z\d]+/iu.test(filename)) return;
  if (/^[^<>:"/\\|?*「」“”，、。！？；;,\r\n]+\.[a-z\d]+$/iu.test(filename)) return filename;
}

const outcomePrefix = /^\s*\{\s*"dotsState"\s*:/;

/** Presentation only. A manual follow-up can echo the wire envelope from a prior delegation. */
export function recoverDotsNarrativeReply(text: string, streaming = false): string | undefined {
  if (!text.includes('"dotsState"')) return;
  const standalone = parseWorkerOutcome(outcomeJson(text), true);
  if (standalone) return dotsDeliveryText(standalone);

  if (streaming) {
    const rest = text.trimStart().replace(/^```(?:json)?[ \t]*\r?\n/i, "");
    if (outcomePrefix.test(rest)) return "";
  }

  const opening = /\r?\n```json[ \t]*\r?\n/i.exec(text);
  if (!opening) return;
  const prose = text.slice(0, opening.index).trimEnd();
  if (!prose.trim() || /^ {0,3}(?:`{3,}|~{3,})/m.test(prose)) return;
  const rest = text.slice(opening.index + opening[0].length);
  const closing = /\r?\n```[ \t]*\s*$/.exec(rest);
  if (!closing) return streaming && outcomePrefix.test(rest) ? prose : undefined;
  const outcome = parseWorkerOutcome(rest.slice(0, closing.index).trim(), true);
  if (!outcome) return;
  return [prose, dotsDeliveryText(outcome)].filter(Boolean).join("\n\n");
}
