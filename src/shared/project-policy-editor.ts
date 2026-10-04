import type { ModeMcpPolicy, ModeSkillPolicy } from "./mode-profile";
import type { ProjectSelectionPolicyDto } from "./project-domain";

export type ProjectSelectionPolicyState = "inherit" | "allow" | "deny" | "recommended";
export type ProjectSkillPolicyState = "inherit" | "allow" | "prefer" | "demote" | "hide";
export type ProjectMcpPolicyState = "inherit" | "allow" | "deny";

function withoutId(values: readonly string[], id: string): string[] {
  return values.filter((value) => value !== id);
}

function withId(values: readonly string[], id: string): string[] {
  return values.includes(id) ? [...values] : [...values, id];
}

export function getProjectSelectionPolicyState(
  policy: ProjectSelectionPolicyDto,
  id: string,
): ProjectSelectionPolicyState {
  if (policy.deny.includes(id)) return "deny";
  if (policy.allow.includes(id)) return "allow";
  if (policy.recommended.includes(id)) return "recommended";
  return "inherit";
}

export function setProjectSelectionPolicyState(
  policy: ProjectSelectionPolicyDto,
  id: string,
  state: ProjectSelectionPolicyState,
): ProjectSelectionPolicyDto {
  const next: ProjectSelectionPolicyDto = {
    allow: withoutId(policy.allow, id),
    deny: withoutId(policy.deny, id),
    recommended: withoutId(policy.recommended, id),
  };
  if (state !== "inherit") next[state] = withId(next[state], id);
  return next;
}

export function getProjectSkillPolicyState(
  policy: ModeSkillPolicy,
  id: string,
): ProjectSkillPolicyState {
  if (policy.hide.includes(id)) return "hide";
  if (policy.allow.includes(id)) return "allow";
  if (policy.prefer.includes(id)) return "prefer";
  if (policy.demote.includes(id)) return "demote";
  return "inherit";
}

export function setProjectSkillPolicyState(
  policy: ModeSkillPolicy,
  id: string,
  state: ProjectSkillPolicyState,
): ModeSkillPolicy {
  const next: ModeSkillPolicy = {
    allow: withoutId(policy.allow, id),
    prefer: withoutId(policy.prefer, id),
    demote: withoutId(policy.demote, id),
    hide: withoutId(policy.hide, id),
  };
  if (state !== "inherit") next[state] = withId(next[state], id);
  return next;
}

export function getProjectMcpPolicyState(
  policy: ModeMcpPolicy,
  id: string,
): ProjectMcpPolicyState {
  if (policy.deny.includes(id)) return "deny";
  if (policy.allow.includes(id)) return "allow";
  return "inherit";
}

export function setProjectMcpPolicyState(
  policy: ModeMcpPolicy,
  id: string,
  state: ProjectMcpPolicyState,
): ModeMcpPolicy {
  const next: ModeMcpPolicy = {
    ...policy,
    allow: withoutId(policy.allow, id),
    deny: withoutId(policy.deny, id),
  };
  if (state !== "inherit") next[state] = withId(next[state], id);
  return next;
}

export function mergeProjectCapabilityOptions<T extends { id: string; name: string }>(
  options: readonly T[],
  configuredIds: readonly string[],
): Array<T | { id: string; name: string; description: string }> {
  const known = new Set(options.map((option) => option.id));
  return [
    ...options,
    ...configuredIds
      .filter((id) => !known.has(id))
      .map((id) => ({ id, name: id, description: "当前不可用；保留已保存的策略配置" })),
  ];
}
