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
function targetClauses(text: string): { positive: string; excluded: string } {
  const positive: string[] = [], excluded: string[] = [];
  const negative = /不(?:改|动)|别动|不要(?:改|动|修|处理|操作|暂停|恢复|取消|停止)|别(?:改|修|处理|操作|暂停|恢复|取消|停止)|不是/;
  const clauses = text.split(/[，,。；;！？!?\n]+|但是|但|而是/);
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
  return { positive: positive.join("\n").trim(), excluded: excluded.join("\n").trim() };
}

const ambiguous = (): WorkTargetResolution => ({ ok: false, code: "ambiguous_target", message: WORK_TARGET_ERROR });

export function resolveWorkTarget(facts: WorkTargetFacts): WorkTargetResolution {
  const clauses = targetClauses(facts.userText);
  if (!clauses.positive) return ambiguous();
  const excludedFacts = { ...facts, userText: clauses.excluded };
  const excluded = new Set([...namedTargets(excludedFacts).matches,
    ...facts.explicitWorkIds.filter(id => normalize(clauses.excluded).includes(normalize(id)))]);
  if (excluded.has(facts.requestedWorkId)) return ambiguous();
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
