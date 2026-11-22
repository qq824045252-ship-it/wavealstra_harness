import { userPromptDisplayText } from "./user-prompt-display";
import type { LibraryItemDto } from "./library-ipc";

export const maxAnswerEvidenceBytes = 16_384;

export function eligibleAnswerEvidenceItem(item: Pick<LibraryItemDto, "kind" | "filename" | "sizeBytes" | "trashedAt">): boolean {
  return !item.trashedAt && item.sizeBytes > 0 && item.sizeBytes <= maxAnswerEvidenceBytes
    && (["markdown", "html", "csv"].includes(item.kind) || (item.kind === "file" && /\.(?:txt|json)$/iu.test(item.filename)));
}

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
  evidenceLibraryItemId?: string | null;
  evidenceFailure?: "verify" | "mark-unverified";
  projectId: string | null;
  sourceMemoryId: string | null;
  sourceHash?: string;
  /** Length of the accepted memory paragraph before the newline and rule-specific instructions. */
  sourcePrefixLength?: number;
  enabled: boolean;
}
export interface AnswerRule extends AnswerRuleDraft {
  id: string;
  revision: number;
  sourceUnavailable?: boolean;
}
export interface AnswerRuleMatch {
  rule: AnswerRule;
  phrase: string;
  candidates?: Array<{ ruleId: string; title: string; phrase: string; projectId: string | null }>;
}
export interface AnswerRuleEvidence {
  kind: "task-file" | "project-material";
  reference: string;
  label?: string;
  status: "read" | "skipped" | "not-found" | "denied" | "failed" | "revoked";
  path?: string;
  contentHash?: string;
  reason?: string;
  readAt?: number;
}
export interface AnswerRuleUse {
  taskId: string;
  taskTitle: string;
  inputId: string;
  title: string;
  revision: number;
  at: number;
  detail: string;
  ruleId?: string;
  phrase?: string;
  evidence?: AnswerRuleEvidence;
  routeStatus?: "applied" | "revoked";
}
export type AnswerRoutingHistoryQuery = { taskId: string } & ({ inputId: string } | { inputIds: string[] });
export interface AnswerRoutingApi {
  list(): Promise<AnswerRule[]>;
  save(draft: AnswerRuleDraft, version?: { id: string; revision: number }): Promise<AnswerRule>;
  remove(id: string, revision: number): Promise<void>;
  preview(query: string, projectId: string | null): Promise<AnswerRuleMatch | null>;
  history(turn?: AnswerRoutingHistoryQuery): Promise<AnswerRuleUse[]>;
  suggest(teaching: string, question?: string, answer?: string): Promise<Pick<AnswerRuleDraft, "title" | "include" | "exclude" | "instruction">>;
}
export const newAnswerRule = (): AnswerRuleDraft => ({
  title: "", include: [], exclude: [], instruction: "", evidenceFile: "",
  enabled: true, projectId: null, sourceMemoryId: null,
});

export const answerRuleExamples: (AnswerRuleDraft & { chooseSource?: boolean })[] = [
  { ...newAnswerRule(), title: "查询出行天气", include: ["天气", "会下雨吗", "要带伞吗", "要不要带伞", "降雨预报"],
    exclude: ["翻译", "译成", "润色", "改写", "英文怎么说"],
    instruction: "优先用本轮指定的地点和时段，其次用已明确的行程或默认城市。直接查可用天气来源的逐小时预报。数据覆盖所问时段后给出结论和来源；只有全天数据时说明精度。"},
  { ...newAnswerRule(), chooseSource: true, title: "周报核对发布记录", include: ["项目周报", "写周报", "整理周报", "本周周报"],
    exclude: ["翻译", "润色模板"],
    instruction: "写项目周报时逐项核对发布记录。已确认发布的事项可写已上线并注明依据。只有提测记录时写已提测，缺少记录时标注待核实。"},
];

const normalized = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
function editsAnswerRule(input: string): boolean {
  const request = input.replace(/^(?:请帮我|帮我|请)\s*/u, "").split(/[。！？!?\n]/u, 1)[0];
  if (/^(?:把|将)/u.test(request) && /规则.{0,24}?(?:改成|改为|修改|停用|启用|去重|提炼|合并|保存)/u.test(request)) return true;
  if (/^(?:查看|编辑|修改|停用|启用|创建|新增|提炼|合并|测试)/u.test(request) && /(?:回答|调度)规则/u.test(request)) return true;
  if (/(?:去重|提炼|保存|整理|合并)(?:并提炼)?(?:成|为)(?:一条)?(?:全局|项目)?(?:回答|调度)规则/u.test(request)) return true;
  return /^(?:please\s+)?(?:edit|update|disable|enable|create|distill|test|list)\b.{0,80}\b(?:answer|routing) rule/iu.test(request);
}
/** Within a project the most specific phrase wins. The stable id resolves exact ties. */
export function matchAnswerRule(query: string, projectId: string | null, rules: readonly AnswerRule[],
  visible: (rule: AnswerRule) => boolean = () => true, explain = false): AnswerRuleMatch | null {
  if (query.trimStart().startsWith("/")) return null;
  const input = normalized(userPromptDisplayText(query));
  // Editing a rule may quote its own trigger as an example. The edit itself needs no pre-read.
  if (editsAnswerRule(input)) return null;
  // An excluded action and object may be separated by a demonstrative, as in “翻译这份周报”.
  const exclusionInput = input.replace(/(翻译|润色|改写|校对|转发|整理)[这那](?:一)?[份段篇个条封张本]/gu, "$1");
  const matches: AnswerRuleMatch[] = [];
  for (const rule of rules) {
    if (!rule.enabled || (rule.projectId !== null && rule.projectId !== projectId)
      || rule.exclude.some(term => {
        const phrase = normalized(term);
        return input.includes(phrase) || exclusionInput.includes(phrase);
      })) continue;
    const phrase = rule.include.filter(term => input.includes(normalized(term))).sort((a, b) => b.length - a.length)[0];
    if (!phrase || !visible(rule)) continue;
    matches.push({ rule, phrase });
  }
  matches.sort((a, b) => Number(!!b.rule.projectId) - Number(!!a.rule.projectId)
    || b.phrase.length - a.phrase.length || (a.rule.id < b.rule.id ? -1 : Number(a.rule.id > b.rule.id)));
  const winner = matches[0];
  if (!winner) return null;
  return explain ? { ...winner, candidates: matches.map(({rule, phrase}) => ({
    ruleId: rule.id, title: rule.title, phrase, projectId: rule.projectId,
  })) } : winner;
}
