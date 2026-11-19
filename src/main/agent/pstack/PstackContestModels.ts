import { resolvePstackRole, type PstackSettings } from "../../../shared/pstack";
import { observedModelFamily } from "./PstackAttention";
import { canonicalSubagentModelReference } from "../../capabilities/subagent/config";

export interface ContestScope { available: string[]; pools: Record<string, string[]>; parent?: string; defaultModel?: string;
  supportsEffort?: (id: string, effort: string) => boolean }

function eligible(model: string, effort: string, scope: ContestScope): string[] {
  const choices = model === "auto" || model === "inherit-parent" ? [scope.parent] : model === "default" ? [[scope.defaultModel, scope.parent].find(id => id && scope.available.includes(id))] :
    Object.hasOwn(scope.pools, model) ? scope.pools[model] : [model];
  const seen = new Set<string>();
  return choices.map(id => id && canonicalSubagentModelReference(id.trim())).filter((id): id is string => {
    if (!id || !scope.available.includes(id) || scope.supportsEffort?.(id,effort) === false) return false;
    const identity = id.split("/").at(-1)!.toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity); return true;
  });
}

export function chooseDecisionReviewers(settings: PstackSettings, scope: ContestScope, authors: string[]) {
  const writerFamilies = new Set(authors.map(observedModelFamily));
  if (!writerFamilies.size || writerFamilies.has(undefined)) throw Error("Cannot establish all decision author families from the execution receipts.");
  const role = resolvePstackRole(settings, "judgment");
  const pool = eligible(role.model, role.effort, scope);
  const independent = pool.filter(id => {
    const family = observedModelFamily(id);
    return family && !writerFamilies.has(family);
  });
  if (!independent.length || (role.model === "diverse" && independent.length < role.count)) {
    throw Error("Decision audit requires an independent model family. Authors: " + [...writerFamilies].join(", ") +
      ". Available configured judgment candidates: " + (pool.join(", ") || "none") + ". No reviewer was dispatched.");
  }
  return Array.from({length:role.count}, (_,i) => independent[i % independent.length]!);
}
/** A cross-judge pool supplies one juror. Reserve its family before picking authors. */
export function chooseContestModels(settings: PstackSettings, scope: ContestScope, isEval: boolean, previous?: string[]) {
  const authors = resolvePstackRole(settings, "arena-runners"), judge = resolvePstackRole(settings, "arena-cross-judge");
  const pool = eligible(authors.model, authors.effort, scope);
  const jurors = eligible(judge.model, judge.effort, scope).slice(0, judge.count);
  if (!isEval) {
    if (!jurors.length) throw Error("The configured cross-judge pool has no enabled and available model.");
    if (previous) {
      const family = scope.parent && observedModelFamily(scope.parent);
      return [jurors.find(id => family && observedModelFamily(id) && observedModelFamily(id) !== family) ?? jurors[0]];
    }
    if (pool.length >= authors.count) return pool.slice(0, authors.count);
    if (authors.model !== "diverse" && pool.length) return Array.from({ length: authors.count }, () => pool[0]);
    throw Error("The configured Arena author pool cannot supply the requested authors: " + pool.join(", "));
  }
  if (previous) {
    const writerFamilies = previous.map(observedModelFamily);
    const selected = jurors.find(id => observedModelFamily(id) && writerFamilies.every(f => f && f !== observedModelFamily(id)));
    if (!selected) throw Error("The configured cross-judge pool has no available model family independent of the observed authors: " + previous.join(", "));
    return [selected];
  }
  if (isEval && authors.count < 2) throw Error("A blind comparison requires at least two independent author models.");
  for (const juror of jurors) {
    const family = observedModelFamily(juror);
    if (!family) continue;
    const choices = pool.filter(id => observedModelFamily(id) && observedModelFamily(id) !== family);
    if (choices.length >= authors.count) return choices.slice(0, authors.count);
  }
  throw Error("The configured available author and cross-judge pools cannot provide the requested author count and an independent judge family. Eligible authors (" + authors.effort + "): " + pool.join(", ") + ". Eligible judges (" + judge.effort + "): " + jurors.join(", "));
}
