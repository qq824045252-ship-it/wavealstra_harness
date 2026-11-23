export type DotsWorkerOutcome =
  | { dotsState: "complete"; result: string; delivery?: { text: string } }
  | { dotsState: "blocked"; result: string }
  | { dotsState: "progress"; result: string; remainingQuote: string };

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
    if (outcome) return outcome;
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
    if (value.dotsState === "blocked" && value.result.trim() && (!exact || Object.keys(value).length === 2)) {
      return { dotsState: value.dotsState, result: value.result };
    }
    if (value.dotsState === "complete") {
      if ("delivery" in value) {
        if (typeof value.delivery?.text !== "string") return;
        if (exact && (Object.keys(value).length !== 3 || Object.keys(value.delivery).length !== 1)) return;
        return { dotsState: value.dotsState, result: value.result, delivery: { text: value.delivery.text } };
      }
      if (exact && Object.keys(value).length !== 2) return;
      return { dotsState: value.dotsState, result: value.result };
    }
    if (value.dotsState === "progress" && typeof value.remainingQuote === "string" && (!exact || Object.keys(value).length === 3)) {
      return { dotsState: value.dotsState, result: value.result, remainingQuote: value.remainingQuote.trim() };
    }
  } catch {
    // Ordinary model prose does not declare an outcome.
  }
}

export function dotsDeliveryText(outcome: DotsWorkerOutcome): string {
  return (outcome.dotsState === "complete" ? outcome.delivery?.text : undefined) ?? outcome.result;
}

/** Some workers put a request for missing input in a complete envelope. Require both an
 * explicit absence of a deliverable and a request to supply the missing input. */
export function dotsMissingInputConclusion(text: string): boolean {
  const conclusion = text.trimStart().replace(/^(?:#{1,6}\s+|\*\*)/u, "");
  const firstParagraph = conclusion.split(/\r?\n\s*\r?\n/u, 1)[0] ?? "";
  const noResult = /^(?:结论[：:]\s*)?(?:未|没有|尚未|无法|不能|没能)(?:能)?(?:交付|完成|给出|核算|计算|读取|读到|找到)/u;
  const needInput = /请(?:你|您)?\s*(?:把|提供|上传|补发|补充|发给|放入|放进|告诉|给出|确认|选择|贴出)/u;
  return noResult.test(firstParagraph) && /(?:文件|资料|数据源|源表|原表|这份表|明细|台账)/u.test(firstParagraph) && needInput.test(conclusion);
}

/** A worker can finish with a bare report or value. Only accept it when the user's
 * quoted delivery instruction describes a format we can check without guessing. */
export function matchesDotsDeliveryFormat(text: string, instruction: string | undefined): boolean {
  if (!instruction || !text.trim()) return false;
  if (/只(?:要|给|交|回|回复)\s*(?:一个)?\s*(?:整数|数字)/u.test(instruction)) return /^-?\d+$/u.test(text);
  if (/只(?:要|给|交|回|回复)\s*(?:单行(?:的)?\s*)?JSON\b/iu.test(instruction)) {
    if (!text.startsWith("{") || /\r|\n/u.test(text)) return false;
    const keys = /键名(?:依次)?(?:是|为)\s*([a-z0-9_]+(?:\s*、\s*[a-z0-9_]+)*)/iu.exec(instruction)?.[1]?.split(/\s*、\s*/u);
    if (!keys) return false;
    try { return JSON.stringify(Object.keys(JSON.parse(text))) === JSON.stringify(keys); }
    catch { return false; }
  }
  const hashHeadings = [...instruction.matchAll(/##[ \t]+([^、，。；！？「」“”\r\n]+)/gu)].map(([, heading]) => heading.trim());
  const required = hashHeadings.length ? hashHeadings : [...(instruction.split(/二级标题/u)[1] ?? "")
    .split(/[。；！？\r\n]/u, 1)[0].matchAll(/「([^」]+)」/gu)].map(([, heading]) => heading.trim());
  if (required.length < 2 || !text.startsWith("## ")) return false;
  const matches = [...text.replace(/^ {0,3}(?:```|~~~)[^\r\n]*\r?\n[\s\S]*?^ {0,3}(?:```|~~~)[ \t]*$/gmu, "")
    .matchAll(/^##[ \t]+([^\r\n]+)\r?\n([\s\S]*?)(?=^##[ \t]|$(?![\s\S]))/gmu)];
  return matches.length === required.length && matches.every(([, heading, body], index) =>
    heading.trim() === required[index] && Boolean(body.trim()));
}

export function onlyDeliveryFilename(instruction: string | undefined): string | undefined {
  const requested = /^(?:完成后[，,\s]*)?(?:请\s*)?只(?:给我?|交付?|发(?:给我?)?|要)\s*(.+?)[。！!]?$/u
    .exec(instruction?.trim() ?? "")?.[1]?.trim();
  if (!requested) return;
  const filename = requested.replace(/^「([^」]+)」$|^“([^”]+)”$|^"([^"]+)"$/u, "$1$2$3");
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
