/**
 * R3.2 SemanticRouter — lexical-first heuristic + Quality Gate
 * Trigger A: 0-hit → semantic
 * Trigger B: weak lexical (score 弱 / top-N 无区分) → semantic
 * Trigger C: cross/semantic-description/long query → lexical+semantic (Router 判定为 semantic-eligible 时)
 * Trigger D: Agent retry (mode=semantic) 强制走 semantic
 * Lexical-only 熔断：filename/path/ID/serial/quoted/strong hit → 不触发 semantic
 */
import type { WorkspaceResourceHit } from "../../shared/workspace-resource-locator";

export type SemanticTrigger = "A_zero_hit" | "B_weak_lexical" | "C_eligible_query" | "D_agent_retry" | null;

export interface ShouldFallbackInput {
  lexicalHits: WorkspaceResourceHit[];
  query: string;
  mode?: "auto" | "lexical" | "semantic";
}

export interface ShouldFallbackResult {
  trigger: SemanticTrigger;
  reason: string;
  shouldFallback: boolean;
}

function looksLikeFilenameOrPath(q: string): boolean {
  const s = q.trim();
  if (s.includes("/") || s.includes("\\")) return true;
  if (/\.(md|html|csv|pdf|docx?|xlsx?|pptx?|ts|js|json|txt)\b/i.test(s)) return true;
  return false;
}
function looksLikeIdOrSerial(q: string): boolean {
  const s = q.trim();
  if (/^(AD|VDS|DS)\d+/i.test(s)) return true;
  if (/^[\w-]+=.*\d/.test(s)) return true; // Zero=-9.5959
  if (/^FW\s*V?\d/i.test(s)) return true;
  if (/^[A-Z]{2,}[-_]\d+$/i.test(s)) return true;
  if (/^[A-Z0-9]{3,}[-_][A-Z0-9]{2,}$/i.test(s)) return true;
  return false;
}
function isQuoted(q: string): boolean {
  const s = q.trim();
  return (s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2);
}
function isStrongLexicalHit(h: WorkspaceResourceHit): boolean {
  return h.matchedBy === "title" || h.matchedBy === "filename" || (h.matchedBy === "fts" && h.score < -1);
}
function isSemanticEligibleQuery(q: string): boolean {
  const s = q.trim();
  if (s.length >= 18) return true;
  if (/[\u4e00-\u9fff]/.test(s) && /[a-zA-Z]/.test(s)) return false;
  if (/为什么|如何|哪些|怎么/.test(s)) return true;
  if (s.split(/\s+/).length >= 4) return true;
  // Short pure-CJK (4-18 chars) without strong lexical signal is eligible for cross-language fusion
  // Allows case-013 温度补偿算法 (6 chars) to trigger semantic when title hit blocks
  if (s.length >= 4 && s.length < 18 && !looksLikeIdOrSerial(s) && !looksLikeFilenameOrPath(s) && !isQuoted(s)) {
    if (/^[\u4e00-\u9fff]+$/.test(s)) return true;
  }
  if (s.length >= 12 && !looksLikeIdOrSerial(s) && !looksLikeFilenameOrPath(s) && !isQuoted(s)) {
    if (/[\u4e00-\u9fff]/.test(s)) return true;
  }
  return false;
}

export class SemanticRouter {
  private total = 0;
  private fallback = 0;

  shouldFallback(input: ShouldFallbackInput): ShouldFallbackResult {
    this.total++;
    const q = (input.query ?? "").trim();
    const mode = input.mode ?? "auto";
    if (mode === "lexical") return { trigger: null, reason: "mode=lexical 熔断", shouldFallback: false };
    if (mode === "semantic") {
      this.fallback++;
      return { trigger: "D_agent_retry", reason: "mode=semantic Agent retry", shouldFallback: true };
    }

    // lexical-only 熔断
    if (looksLikeFilenameOrPath(q)) return { trigger: null, reason: "lexical-only: filename/path", shouldFallback: false };
    if (isQuoted(q)) return { trigger: null, reason: "lexical-only: quoted phrase", shouldFallback: false };
    if (looksLikeIdOrSerial(q)) return { trigger: null, reason: "lexical-only: ID/serial", shouldFallback: false };
    if (input.lexicalHits.some((h) => h.matchedBy === "title" || h.matchedBy === "filename")) {
      // Cross-language: short CJK query may hit same-language title but miss cross-language target; allow semantic when eligible-ish
      const sq = q.trim();
      const shortCjk = sq.length >= 4 && sq.length < 18 && /[\u4e00-\u9fff]/.test(sq) && !looksLikeFilenameOrPath(sq);
      if (shortCjk) {
        // defer: check C eligibility after strong-hit gate, but do not block here
      } else {
        return { trigger: null, reason: "lexical-only: strong title/filename hit", shouldFallback: false };
      }
    }
    // strong fts top-1 熔断
    if (input.lexicalHits.length > 0 && isStrongLexicalHit(input.lexicalHits[0]!)) {
      // 但如果是 eligible 长查询，仍允许 C（lexical+semantic 融合），不熔断
      if (!isSemanticEligibleQuery(q)) return { trigger: null, reason: "lexical-only: strong lexical hit", shouldFallback: false };
    }

    // Trigger A: 0-hit
    if (input.lexicalHits.length === 0) {
      this.fallback++;
      return { trigger: "A_zero_hit", reason: "0 lexical hits", shouldFallback: true };
    }

    // Trigger C: eligible query → lexical+semantic (fusion)
    if (isSemanticEligibleQuery(q)) {
      this.fallback++;
      return { trigger: "C_eligible_query", reason: "eligible semantic query (cross/description/long)", shouldFallback: true };
    }

    // Trigger B: weak lexical (仅弱 chunk/fallback，或 FTS score 弱)
    const weakOnly = input.lexicalHits.every((h) => h.matchedBy === "chunk" || h.matchedBy === "fallback" || h.matchedBy === "body");
    if (weakOnly) {
      this.fallback++;
      return { trigger: "B_weak_lexical", reason: "weak lexical only (chunk/fallback/body)", shouldFallback: true };
    }
    // weak FTS score heuristic: best score is fallback-ish (score >=2 and not title/filename)
    const best = input.lexicalHits[0]!;
    if (best.score >= 2 && best.matchedBy !== "title" && best.matchedBy !== "filename") {
      // tie check: top-2 scores equal → no discrimination
      if (input.lexicalHits.length >= 2 && input.lexicalHits[0]!.score === input.lexicalHits[1]!.score) {
        this.fallback++;
        return { trigger: "B_weak_lexical", reason: "weak lexical (no discrimination)", shouldFallback: true };
      }
    }

    return { trigger: null, reason: "lexical sufficient", shouldFallback: false };
  }

  getFallbackRate(): number {
    if (this.total === 0) return 0;
    return this.fallback / this.total;
  }

  getStats(): { total: number; fallback: number; rate: number } {
    return { total: this.total, fallback: this.fallback, rate: this.getFallbackRate() };
  }
}
