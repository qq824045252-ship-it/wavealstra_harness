export type DotsRouteMode = "direct" | "delegate" | "auto";

export const routingFlowLimits = { branches: 16, checks: 12, phrases: 12, phraseLength: 100, titleLength: 80 } as const;

export interface AnswerFlowCheck {
  id: string;
  operator: "all" | "any" | "none";
  phrases: string[];
}

export interface AnswerFlowBranch {
  id: string;
  title: string;
  checks: AnswerFlowCheck[];
  ruleId: string | null;
  routeMode: DotsRouteMode | null;
}

export interface AnswerRoutingFlow {
  enabled: boolean;
  branches: AnswerFlowBranch[];
}

export interface AnswerFlowTrace {
  steps: Array<{
    branchId: string;
    title: string;
    outcome: "selected" | "unmatched" | "rule-unavailable";
    checks: Array<{ checkId: string; passed: boolean; phrases: Array<{ phrase: string; matched: boolean }> }>;
  }>;
  routeMode: DotsRouteMode;
}

export const normalizeAnswerText = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

export function evaluateAnswerFlow(text: string, flow: AnswerRoutingFlow, canSelect: (ruleId: string) => boolean) {
  const steps: AnswerFlowTrace["steps"] = [];
  for (const branch of flow.branches) {
    const checks: AnswerFlowTrace["steps"][number]["checks"] = [];
    for (const check of branch.checks) {
      const phrases = check.phrases.map(phrase => ({ phrase, matched: text.includes(normalizeAnswerText(phrase)) }));
      const passed = check.operator === "all" ? phrases.every(result => result.matched)
        : check.operator === "any" ? phrases.some(result => result.matched) : phrases.every(result => !result.matched);
      checks.push({ checkId: check.id, passed, phrases });
      if (!passed) break;
    }
    const outcome = checks.some(check => !check.passed) ? "unmatched"
      : branch.ruleId && !canSelect(branch.ruleId) ? "rule-unavailable" : "selected";
    steps.push({ branchId: branch.id, title: branch.title, outcome, checks });
    if (outcome === "selected") return { branch, steps };
  }
  return { branch: undefined, steps };
}
