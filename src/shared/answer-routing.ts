import { userPromptDisplayText } from "./user-prompt-display";

export const AnswerRoutingIpc = {
  list: "answer-routing:list",
  save: "answer-routing:save",
  remove: "answer-routing:remove",
  preview: "answer-routing:preview",
  history: "answer-routing:history",
  suggest: "answer-routing:suggest",
} as const;

export interface AnswerRuleDraft {
  title: string;
  include: string[];
  exclude: string[];
  instruction: string;
  evidenceFile: string;
  projectId: string | null;
  sourceMemoryId: string | null;
  sourceHash?: string;
  enabled: boolean;
}
export interface AnswerRule extends AnswerRuleDraft {
  id: string;
  revision: number;
  sourceNeedsReview?: boolean;
}
export interface AnswerRuleMatch { rule: AnswerRule; phrase: string }
export interface AnswerRuleUse {
  taskId: string;
  taskTitle: string;
  inputId: string;
  title: string;
  revision: number;
  at: number;
  detail: string;
}
export interface AnswerRoutingApi {
  list(): Promise<AnswerRule[]>;
  save(draft: AnswerRuleDraft, version?: { id: string; revision: number }): Promise<AnswerRule>;
  remove(id: string, revision: number): Promise<void>;
  preview(query: string, projectId: string | null): Promise<AnswerRuleMatch | null>;
  history(turn?: { taskId: string; inputId: string }): Promise<AnswerRuleUse[]>;
  suggest(teaching: string, question?: string, answer?: string): Promise<Pick<AnswerRuleDraft, "title" | "include" | "exclude" | "instruction">>;
}
export const newAnswerRule = (): AnswerRuleDraft => ({
  title: "", include: [], exclude: [], instruction: "", evidenceFile: "",
  enabled: true, projectId: null, sourceMemoryId: null,
});

export const answerRuleExamples: AnswerRuleDraft[] = [
  { ...newAnswerRule(), title: "查询出行天气", include: ["天气", "会下雨吗", "要带伞吗", "要不要带伞", "降雨预报"],
    exclude: ["翻译", "译成", "润色", "改写", "英文怎么说"],
    instruction: "优先用本轮指定的地点和时段，其次用已明确的行程或默认城市。直接查可用天气来源的逐小时预报。数据覆盖所问时段后给出结论和来源；只有全天数据时说明精度。"},
  { ...newAnswerRule(), title: "周报核对发布记录", include: ["项目周报", "写周报", "整理周报", "本周周报"],
    exclude: ["翻译", "润色模板"],
    instruction: "写项目周报时逐项核对发布记录。已确认发布的事项可写已上线并注明依据。只有提测记录时写已提测，缺少记录时标注待核实。"},
];

const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
/** Within a project the most specific phrase wins. The stable id resolves exact ties. */
export function matchAnswerRule(query: string, projectId: string | null, rules: readonly AnswerRule[],
  visible: (rule: AnswerRule) => boolean = () => true): AnswerRuleMatch | null {
  if (query.trimStart().startsWith("/")) return null;
  const input = normalized(userPromptDisplayText(query));
  let best: AnswerRuleMatch | null = null;
  for (const rule of rules) {
    if (!rule.enabled || (rule.projectId !== null && rule.projectId !== projectId)
      || rule.exclude.some(term => input.includes(normalized(term)))) continue;
    const phrase = rule.include.filter(term => input.includes(normalized(term))).sort((a, b) => b.length - a.length)[0];
    if (!phrase || !visible(rule)) continue;
    if (!best || Number(!!rule.projectId) > Number(!!best.rule.projectId)
      || (rule.projectId === best.rule.projectId && (phrase.length > best.phrase.length
        || (phrase.length === best.phrase.length && rule.id < best.rule.id)))) best = { rule, phrase };
  }
  return best;
}
