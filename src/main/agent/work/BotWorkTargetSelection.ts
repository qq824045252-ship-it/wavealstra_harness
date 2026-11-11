/**
 * Pure target resolution for interrupt/redirect controls (issue #27 §5).
 *
 * The caller supplies already-authoritative facts (persisted user message text,
 * request receipt links, open works it may read), so the policy stays testable
 * without a database, a model, or a second Work truth store. Priority mirrors
 * the historical foreground contract:
 *   explicit workId > replied/referenced message > UI-selected card
 *   > unique open-Work title literally named in the user message > sole open Work.
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

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();

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

const ambiguous = (): WorkTargetResolution => ({ ok: false, code: "ambiguous_target", message: WORK_TARGET_ERROR });

export function resolveWorkTarget(facts: WorkTargetFacts): WorkTargetResolution {
  const explicit = [...new Set(facts.explicitWorkIds)];
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
    const matches = namedTitles(facts);
    if (matches.length > 1) titleAmbiguous = true;
    else if (matches.length === 1) resolved = { workId: matches[0]!, basis: "unique_title" };
    else if (facts.soleOpenWorkId) resolved = { workId: facts.soleOpenWorkId, basis: "sole_open_work" };
  }

  if (resolved && resolved.workId === facts.requestedWorkId) return { ok: true, ...resolved };
  // A work created in this same request stays controllable within it (existing
  // replay contract), but an explicit ID or two named titles cannot be overridden.
  if (explicit.length === 0 && !titleAmbiguous && facts.linkedWorkIds.includes(facts.requestedWorkId))
    return { ok: true, workId: facts.requestedWorkId, basis: "request_link" };
  return ambiguous();
}