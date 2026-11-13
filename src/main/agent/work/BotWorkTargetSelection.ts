/**
 * Pure target resolution for interrupt/redirect controls (issue #27 §5).
 *
 * The caller supplies already-authoritative facts (persisted user message text,
 * request receipt links, open works it may read), so the policy stays testable
 * without a database, a model, or a second Work truth store. Priority mirrors
 * the historical foreground contract:
 *   explicit workId > replied/referenced message > UI-selected card
 *   > unique title or substantive task fragment in the user message > sole open Work.
 *
 * Same-request links keep their replay rescue (a Work created earlier in this
 * same request), but only when no explicit ID and no deterministic title
 * resolution contradict the model's argument.
 */

export type WorkTargetBasis =
  | "explicit_work_id"
  | "reference_message"
  | "selected_card"
  | "unique_title"
  | "unique_task_fragment"
  | "sole_open_work"
  | "request_link";

export interface WorkTargetFacts {
  /** The actual control being invoked, used to separate explicit multi-item instructions. */
  requestedAction?: "pause" | "resume" | "cancel" | "amend";
  /** Actual persisted user message text, never model arguments. */
  userText: string;
  /** workIds literally present in userText (deduped by the caller). */
  explicitWorkIds: readonly string[];
  /** workIds linked to the assistant message this request replies to. */
  referencedWorkIds: readonly string[];
  /** Work card selected in the UI when the request was accepted. */
  selectedWorkId?: string;
  /** workIds linked to this request's own user/assistant messages. */
  linkedWorkIds: readonly string[];
  /** Open works the current actor may read; the only material for title matching. */
  openWorks: ReadonlyArray<{ workId: string; title: string }>;
  /** `catalogue.soleOpenWorkId()`-style fact; undefined when ambiguous or empty. */
  soleOpenWorkId?: string;
  /** A bounded catalogue page must not claim uniqueness across unseen Works. */
  openWorksComplete?: boolean;
  /** The workId the model asked to control. */
  requestedWorkId: string;
}

export type WorkTargetResolution =
  | { ok: true; workId: string; basis: WorkTargetBasis }
  | { ok: false; code: "ambiguous_target"; message: string };

/** Same wording the foreground controls already return; do not fork it. */
export const WORK_TARGET_ERROR = "请明确要控制的 Work 卡片或 workId；多个事项不能按模糊消息全局控制";
/** Short titles ("周报", "报告") are not safe deterministic anchors. */
export const WORK_TARGET_TITLE_MIN_LENGTH = 4;

const normalize = (value: string) => value.normalize("NFKC").toLowerCase();

function namedTitles(facts: WorkTargetFacts): string[] {
  const text = normalize(facts.userText);
  const matched: string[] = [];
  for (const work of facts.openWorks) {
    const title = work.title.trim();
    // Literal substring of the actual user message, never a fuzzy/keyword match.
    if (title.length < WORK_TARGET_TITLE_MIN_LENGTH || !text.includes(normalize(title))) continue;
    matched.push(work.workId);
  }
  return [...new Set(matched)];
}

/** Conservative literal task anchors from persisted titles, not model-provided
 * aliases or fuzzy similarity. Generic control phrasing cannot identify a task.
 * Han anchors require four contiguous substantive characters; Latin anchors are
 * whole words (six characters) or a pair of whole substantive words. */
function taskAnchors(value: string): Set<string> {
  const anchors = new Set<string>();
  const controlWords = /这轮|本轮|这次|本次|这个|那个|一下|帮我|请你|请|只要|只|继续|暂停|恢复|取消|停止|修复|修改|优化|处理|完成|检查|任务|工作|事项|功能|问题|相关|进行|现在|之后|然后|把|的|修/g;
  for (const run of normalize(value).match(/\p{Script=Han}+/gu) ?? []) {
    for (const part of run.split(controlWords)) for (let index = 0; index + 4 <= part.length; index++) anchors.add(part.slice(index,index+4));
  }
  const generic = new Set(["please","continue","pause","resume","cancel","stop","repair","change","update","improve","process","complete","check","review","task","work","item","this","that","current","the","only"]);
  for (const run of normalize(value).match(/[a-z0-9]+(?:[ \t]+[a-z0-9]+)*/g) ?? []) {
    const words = run.split(/\s+/);
    for (let index = 0; index < words.length; index++) {
      const word = words[index]; if (generic.has(word)) continue;
      if (word.length >= 6) anchors.add(word);
      const next = words[index+1];
      if (next && !generic.has(next) && word.length >= 3 && next.length >= 3) anchors.add(`${word} ${next}`);
    }
  }
  return anchors;
}
function namedTaskFragments(facts: WorkTargetFacts): string[] {
  const userAnchors = taskAnchors(facts.userText);
  return [...new Set(facts.openWorks.filter(work => [...taskAnchors(work.title)].some(anchor => userAnchors.has(anchor))).map(work => work.workId))];
}

/** A complete title is one mention, not an additional mention of every Work
 * sharing its words. Still inspect text outside complete titles so a second
 * actual target (including a partial title) remains ambiguous. */
function namedTargets(facts: WorkTargetFacts): { fullTitles: string[]; matches: string[] } {
  const fullTitles = namedTitles(facts);
  let remainder = normalize(facts.userText);
  const titles = facts.openWorks.filter(work => fullTitles.includes(work.workId))
    .map(work => normalize(work.title.trim())).sort((a, b) => b.length - a.length);
  for (const title of titles) remainder = remainder.split(title).join("\n");
  return { fullTitles, matches: [...new Set([...fullTitles,
    ...namedTaskFragments({ ...facts, userText: remainder })])] };
}

/** Explicit exclusions only narrow targeting. A negative clause never supplies
 * authorization, even when it names the sole Work or a selected/replied card.
 * Keep ambiguous mixed clauses conservative instead of inferring intent. */
function targetClauses(facts: WorkTargetFacts): { positive: string; excluded: string; excludedInstructions: string[] } {
  // Names are opaque data, not grammar: a title may itself contain "but", "not",
  // punctuation or a control verb. Protect complete known labels before parsing.
  let text = normalize(facts.userText);
  const protectedLabels: string[] = [];
  const labels = [...new Set([...facts.explicitWorkIds, ...facts.openWorks.map(work => work.title.trim())
    .filter(title => title.length >= WORK_TARGET_TITLE_MIN_LENGTH)].map(normalize))].sort((a, b) => b.length - a.length);
  for (const label of labels) {
    if (!label || !text.includes(label)) continue;
    const token = `\uE000${protectedLabels.length}\uE001`;
    protectedLabels.push(label);
    // Protect only a complete object immediately following an explicit control.
    // Merely having another Work named "don't ever" must not erase negation.
    let cursor = 0;
    while (cursor < text.length) {
      const at = text.indexOf(label, cursor); if (at < 0) break;
      const before = text.slice(0, at), after = text.slice(at + label.length);
      const objectPosition = /(?:\b(?:pause|suspend|resume|cancel|stop|amend|change)\s+|(?:只修|仅修|只改|仅改|暂停|挂起|恢复|解除暂停|取消|终止|停止|修改|调整|修复)\s*)$/i.test(before);
      const objectEnd = /^\s*(?:$|[，,。.;；！？!?\n]|\b(?:and|or|but|instead)\b)/i.test(after);
      if (objectPosition && objectEnd) {text = before + token + after; cursor = at + token.length;}
      else cursor = at + label.length;
    }
  }
  const restore = (value: string) => value.replace(/\uE000(\d+)\uE001/g, (_, index: string) => protectedLabels[Number(index)] ?? "");
  const positive: string[] = [], excluded: string[] = [];
  const negative = /(?:不|非)(?:只|仅)|(?:不要|别|不必|不用|无需|不能|不应|不该|禁止|不许|不得)[^，,。；;！？!?\n]*(?:只|仅)(?:修|改)|不(?:改|动)|别动|不要(?:改|动|修|处理|操作|暂停|恢复|取消|停止)|别(?:改|修|处理|操作|暂停|恢复|取消|停止)|不是/;
  // English negation scopes over a coordinated phrase (including commas and
  // and/or). Only a sentence/semicolon or explicit contrast starts a new scope.
  // Do this before comma splitting, otherwise "do not pause A, resume B"
  // could silently turn its second forbidden action into authorization.
  // A negation token makes its scope non-authorizing regardless of intervening
  // adverbs or request wording. This is a conservative gate, not intent inference.
  const englishNegative = /\b(?:[a-z]+n['’]t|never|not|cannot)\b|禁止|不许|不得/i;
  const positiveSegments: string[] = [];
  let prohibitionHeader = false;
  for (const segment of text.split(/[;；。.!?！？\n]+|\b(?:but|instead)\b|,\s*(?=(?:not|never|don['’]t|do\s+not)\b)/i)) {
    // A heading such as "Do not:" governs following list items. Missing
    // attachment is not permission: keep it closed until an explicit new-now
    // instruction, rather than guessing a scope from line breaks.
    if (/^\s*(?:now\b|现在|立即)/i.test(segment)) prohibitionHeader = false;
    const negated = englishNegative.test(segment);
    if (negated && !deferredControl.test(segment)
      && (!new RegExp(controlVerbs.source, "i").test(segment) || /[:：]\s*$/.test(segment))) prohibitionHeader = true;
    if (negated || prohibitionHeader) {
      excluded.push(segment);
      // Excluding a forbidden action must not erase a condition that governs
      // later clauses. Retain its syntax for the existing deferred-control gate.
      if (deferredControl.test(segment)) positiveSegments.push(segment);
    }
    else positiveSegments.push(segment);
  }
  const clauses = positiveSegments.join("\n").split(/[，,。；;！？!?\n]+|但是|但|而是/);
  const exclusive = /(?:只|仅)(?:修复|修改|调整|处理|修|改)/;
  const hasExclusiveChange = clauses.some(clause => exclusive.test(clause) && !negative.test(clause)
    && !/不只|不仅|并非只|并非仅/.test(clause));
  for (let index = 0; index < clauses.length; index++) {
    const clause = clauses[index];
    const next = clauses[index + 1] ?? "";
    // With an explicit "only change B", keeping A/C as they are is not another
    // control request. "Continue A" alone may resume a paused Work, so it is
    // never discarded without an adjacent explicit keep-unchanged instruction.
    const unchangedReference = negative.test(next) && /(?:它们|它|这些事项|这些任务)/.test(next)
      && /(?:取消|改变|更改|改动|修改|改|动)/.test(next);
    const preserve = hasExclusiveChange && !exclusive.test(clause)
      && !/(?:恢复|重启|重新启动|启动|解除暂停|修复|修改|调整|暂停|取消|停止|更改)/.test(clause)
      && (/保持(?:不变|原样|现状)|照常/.test(clause) || /继续/.test(clause) && unchangedReference);
    (negative.test(clause) || preserve ? excluded : positive).push(clause);
  }
  return { positive: restore(positive.join("\n").trim()), excluded: restore(excluded.join("\n").trim()),
    excludedInstructions: excluded };
}

const ambiguous = (): WorkTargetResolution => ({ ok: false, code: "ambiguous_target", message: WORK_TARGET_ERROR });

const controlVerbs = /只修|仅修|只改|仅改|暂停|挂起|恢复|解除暂停|取消|终止|停止|修改|调整|修复|改为|改成|\bpause\b|\bsuspend\b|\bresume\b|\bcancel\b|\bstop\b|\bamend\b|\bchange\b/gi;
const deferredControl = /如果|若|等到|等[^\n]*(?:完成|结束|之后)|之后再|以后再|\b(if|when|after|until)\b/i;
function actionOf(verb: string, instruction = ""): WorkTargetFacts["requestedAction"] {
  if (/^(暂停|挂起|pause|suspend)$/i.test(verb)) return "pause";
  if (/^(恢复|解除暂停|resume)$/i.test(verb)) return "resume";
  if (/^(取消|终止|停止|cancel|stop)$/i.test(verb)) {
    const retainsWork = /保留(?:这[个项])?(?:事项|任务|work)|(?:事项|任务|work)[^\n]*(?:保留|照常)/i.test(instruction);
    if (retainsWork && /跟踪|跟进|观察|监听|定时|订阅|检查/.test(instruction)) return "amend";
    return "cancel";
  }
  return "amend";
}

/** Narrow explicit batches by their original action clauses. Never turn a
 * conditional future instruction, exclusion, or duplicate title into a target. */
function explicitActionTarget(facts: WorkTargetFacts, positive: string): WorkTargetResolution | undefined {
  if (!facts.requestedAction) return undefined;
  const named = namedTargets({ ...facts, userText: positive });
  const allIds = facts.explicitWorkIds.filter(id => normalize(positive).includes(normalize(id)));
  const actionText = (value: string) => {
    let result = normalize(value);
    const labels = [...facts.explicitWorkIds, ...facts.openWorks.map(work => work.title.trim()).filter(title => title.length >= WORK_TARGET_TITLE_MIN_LENGTH)]
      .sort((a, b) => b.length - a.length);
    for (const label of labels) result = result.split(normalize(label)).join(" ");
    return result;
  };
  const verbs = [...actionText(positive).matchAll(controlVerbs)];
  if (allIds.length <= 1 && named.matches.length <= 1 && verbs.length <= 1) {
    if (deferredControl.test(actionText(positive)) || verbs.length === 1 && actionOf(verbs[0][0], actionText(positive)) !== facts.requestedAction) return ambiguous();
    return undefined;
  }
  const clauses = positive.split(/[，,。；;！？!?\n]+|(?:、|并且|同时|然后|\band\b)\s*(?=暂停|挂起|恢复|解除暂停|取消|终止|停止|修改|调整|修复|改为|改成|pause\b|resume\b|cancel\b|stop\b|amend\b|change\b)/i);
  const matching = new Set<NonNullable<WorkTargetFacts["requestedAction"]>>();
  let basis: WorkTargetBasis = "explicit_work_id";
  let deferred = false;
  for (const clause of clauses) {
    const instruction = actionText(clause);
    // A condition can be in the preceding clause: "如果成功，再恢复 B".
    if (deferredControl.test(instruction)) deferred = true;
    else if (/^\s*(?:现在|立即|先|now\b)/i.test(instruction)) deferred = false;
    if (deferred) continue;
    const actions = [...new Set([...instruction.matchAll(controlVerbs)].map(match => actionOf(match[0], instruction)))];
    if (actions.length !== 1 || !actions[0]) continue;
    const explicit = allIds.filter(id => normalize(clause).includes(normalize(id)));
    if (explicit.length) {
      if (explicit.includes(facts.requestedWorkId)) matching.add(actions[0]);
      continue;
    }
    if (facts.openWorksComplete === false) continue;
    const titles = namedTitles({ ...facts, userText: clause });
    const target = facts.openWorks.find(work => work.workId === facts.requestedWorkId);
    if (!target || !titles.includes(target.workId)) continue;
    if (facts.openWorks.filter(work => normalize(work.title.trim()) === normalize(target.title.trim())).length !== 1) continue;
    matching.add(actions[0]); basis = "unique_title";
  }
  return matching.size === 1 && matching.has(facts.requestedAction)
    ? { ok: true, workId: facts.requestedWorkId, basis } : ambiguous();
}

export function resolveWorkTarget(facts: WorkTargetFacts): WorkTargetResolution {
  const clauses = targetClauses(facts);
  if (!clauses.positive) return ambiguous();
  // Removing a prohibition must not turn courtesy text into authorization via
  // the selected/replied card. Require a surviving control instruction before
  // using any contextual target after an exclusion. Labels are opaque data:
  // a task named "Pause report" is not itself a fresh instruction.
  if (clauses.excluded) {
    let instruction = normalize(clauses.positive);
    const labels = [...facts.explicitWorkIds, ...facts.openWorks.map(work => work.title.trim())
      .filter(title => title.length >= WORK_TARGET_TITLE_MIN_LENGTH)].sort((a, b) => b.length - a.length);
    for (const label of labels) instruction = instruction.split(normalize(label)).join(" ");
    if (!new RegExp(controlVerbs.source, "i").test(instruction)) return ambiguous();
  }
  const excludedFacts = { ...facts, userText: clauses.excluded };
  const excluded = new Set([...namedTargets(excludedFacts).matches,
    ...facts.explicitWorkIds.filter(id => normalize(clauses.excluded).includes(normalize(id)))]);
  // A pronoun prohibition refers to the same contextual target the fallback
  // would use. Keep it excluded for that action even if later text contains
  // another control verb; an unresolved contradiction is not permission.
  const contextualTargets = facts.referencedWorkIds.length ? facts.referencedWorkIds
    : facts.selectedWorkId ? [facts.selectedWorkId] : facts.soleOpenWorkId ? [facts.soleOpenWorkId] : [];
  // Use the still-tokenized clauses, not restored titles: "This report" is
  // an opaque Work name, not the selected card's pronoun. Keep action/pronoun
  // association within one clause so a separate exclusion cannot lend a verb.
  const pronounExclusion = clauses.excludedInstructions.some(instruction =>
    /\b(?:it|this|that|these|those)\b|它|这个|这项|该任务|该事项/.test(instruction)
    && [...instruction.matchAll(controlVerbs)].some(match => actionOf(match[0], instruction) === facts.requestedAction));
  if (pronounExclusion && facts.requestedAction
    && contextualTargets.includes(facts.requestedWorkId)) return ambiguous();
  if (excluded.has(facts.requestedWorkId)) return ambiguous();
  const batch = explicitActionTarget(facts, clauses.positive);
  if (batch) return batch;
  const positiveFacts = { ...facts, userText: clauses.positive };
  const explicit = [...new Set(facts.explicitWorkIds.filter(id => !excluded.has(id)))];
  const referenced = [...new Set(facts.referencedWorkIds)];
  let resolved: { workId: string; basis: WorkTargetBasis } | undefined;
  // Ambiguity here only means "this priority level yields no single target"; the
  // same-request link rescue is still decided below exactly like the old select().
  let titleAmbiguous = false;

  if (explicit.length > 1) resolved = undefined;
  else if (explicit.length === 1) resolved = { workId: explicit[0]!, basis: "explicit_work_id" };
  else if (referenced.length > 1) resolved = undefined;
  else if (referenced.length === 1) resolved = { workId: referenced[0]!, basis: "reference_message" };
  else if (facts.selectedWorkId) resolved = { workId: facts.selectedWorkId, basis: "selected_card" };
  else {
    const named = namedTargets(positiveFacts);
    const fullTitles = named.fullTitles.filter(id => !excluded.has(id));
    const matches = named.matches.filter(id => !excluded.has(id));
    if (facts.openWorksComplete === false || matches.length > 1) titleAmbiguous = true;
    else if (matches.length === 1) resolved = { workId: matches[0]!, basis: fullTitles.length ? "unique_title" : "unique_task_fragment" };
    else if (!clauses.excluded && facts.soleOpenWorkId) resolved = { workId: facts.soleOpenWorkId, basis: "sole_open_work" };
  }

  if (resolved) return resolved.workId === facts.requestedWorkId ? { ok: true, ...resolved } : ambiguous();
  // A work created in this same request stays controllable within it (existing
  // replay contract), but an explicit ID or two named titles cannot be overridden.
  if (!clauses.excluded && explicit.length === 0 && referenced.length === 0 && !facts.selectedWorkId && !titleAmbiguous && facts.linkedWorkIds.includes(facts.requestedWorkId))
    return { ok: true, workId: facts.requestedWorkId, basis: "request_link" };
  return ambiguous();
}
