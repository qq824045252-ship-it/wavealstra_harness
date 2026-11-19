import { z } from "zod";
import type { ReviewInspection } from "./PstackReviewEvidence";

const detail = z.union([z.string().trim().min(1), z.record(z.string(), z.json()).refine(value =>
  Object.values(value).some(item => typeof item === "string" && item.trim().length > 0))]);
const verdict = z.object({ verdict: z.enum(["pass", "revise"]), findings: z.array(detail), notes: z.array(detail).optional(), checks: z.record(z.string(), detail) });
export type ThermosMember = { child: string; model: string; answer: string; inspection: ReviewInspection; passed: boolean; error?: string };

// A review may put human-readable findings before its machine-readable
// decision. Only one unambiguous verdict, at the end of the answer, counts.
function finalObject(answer: string) {
  let depth = 0, begin = 0, quoted = false, escaped = false;
  const objects: { end: number; value: unknown }[] = [];
  for (let i = 0; i < answer.length; i++) {
    const c = answer[i];
    if (!depth && c !== "{") continue;
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") { if (!depth) begin = i; depth++; }
    else if (c === "}" && --depth === 0) {
      try {
        const obj = JSON.parse(answer.slice(begin, i + 1));
        if (obj && ["verdict", "findings", "checks"].some(k => Object.hasOwn(obj, k))) objects.push({ end: i + 1, value: obj });
      } catch { /* Prose and code examples may contain braces. */ }
    }
  }
  if (objects.length !== 1 || !/^\s*(?:\x60{3}\s*)?$/.test(answer.slice(objects[0].end)))
    throw new Error("Provide exactly one final JSON verdict. No conflicting verdicts or trailing explanations.");
  return objects[0].value;
}
export function parseThermosVerdict(answer: string, ids: string[]) {
  try {
    const result = verdict.parse(finalObject(answer));
    const missing = ids.filter(id => !Object.hasOwn(result.checks, id));
    if (missing.length) throw new Error("Missing criteria: " + missing.join(", "));
    return result.verdict === "pass" && result.findings.length === 0;
  } catch (e) {
    const problem = e instanceof z.ZodError ? e.issues.map(i => i.path.join(".") + ": " + i.message).join("; ") : (e as Error).message;
    throw new Error("Reviewer must return verdict='pass' or 'revise', findings for unresolved material blockers, optional notes for nonblocking suggestions, and checks keyed by " + ids.join(", ") + ". " + problem);
  }
}
