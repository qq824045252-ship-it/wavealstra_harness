/**
 * 场景模式 · 技能 / MCP 名单匹配（纯函数，主进程与渲染层共用）。
 * 与 SkillPolicy / McpModeFilter 规则对齐，供 UI「+」菜单等按 welcomeMode 收窄列表。
 * 硬名单（hide / allow）走 runtime-policy 的 matchesSkillIdentityNeedles；
 * 排序（prefer / demote）走 matchesSkillPolicyNeedles。
 */
import type { ModeMcpPolicy, ModeSkillPolicy, WelcomeMode } from "./mode-profile";
import {
  matchesPolicyKeyword,
  matchesSkillIdentityNeedles,
  matchesSkillPolicyNeedles,
} from "./runtime-policy";

/** 名称子串/精确匹配（大小写不敏感） */
export function nameMatchesPolicy(hay: string, needles: string[]): boolean {
  return matchesPolicyKeyword(hay, needles);
}

export interface SkillAccessRef {
  id: string;
  name: string;
  description?: string;
  /** frontmatter modes；缺省=全模式 */
  modes?: WelcomeMode[];
  enabled?: boolean;
  command?: string;
}

/**
 * 硬名单匹配（hide / allow）：与主进程 resolveSkillCapability 语义一致。
 * 列表勾选写入的是技能 id；裸 keyword 只允许精确身份，子串需显式 `keyword:`。
 */
export function skillMatchesPolicy(skill: SkillAccessRef, needles: string[]): boolean {
  return matchesSkillIdentityNeedles(skill, needles);
}

/** 排序/推荐匹配（prefer / demote）：保留精确 + 子串语义。 */
export function skillMatchesRankingPolicy(skill: SkillAccessRef, needles: string[]): boolean {
  return matchesSkillPolicyNeedles(skill, needles);
}

/**
 * 当前场景下技能是否应对用户可见（+ 菜单 / slash）。
 * hide > allow 白名单 > modes 限制。
 * allow 非空：仅保留命中项；空 allow = 不启用白名单。
 */
export function isSkillVisibleForMode(
  skill: SkillAccessRef,
  welcomeMode: WelcomeMode,
  policy: ModeSkillPolicy | null | undefined,
  options?: { disableFilter?: boolean },
): boolean {
  if (options?.disableFilter) return skill.enabled !== false;
  if (skill.enabled === false) return false;
  const hide = policy?.hide ?? [];
  const allow = policy?.allow ?? [];
  if (skillMatchesPolicy(skill, hide)) return false;
  if (skill.modes && skill.modes.length > 0 && !skill.modes.includes(welcomeMode)) {
    return false;
  }
  if (allow.length > 0 && !skillMatchesPolicy(skill, allow)) return false;
  return true;
}

/**
 * 当前场景下 MCP 是否应对用户可见（+ 菜单）。
 * hard：deny 黑名单 + allow 白名单（空 allow = 不启用）+ entry.modes。
 * soft：仍按名单提示隐藏（与会话 hard 隔离对齐，避免挂上本场景不会加载的服务）。
 */
export function isMcpVisibleForMode(
  name: string,
  welcomeMode: WelcomeMode,
  policy: ModeMcpPolicy | null | undefined,
  options?: { modes?: WelcomeMode[] | null; disabled?: boolean },
): boolean {
  if (options?.disabled === true) return false;
  const modes = options?.modes;
  if (modes && modes.length > 0 && !modes.includes(welcomeMode)) return false;
  const deny = policy?.deny ?? [];
  const allow = policy?.allow ?? [];
  if (deny.length && nameMatchesPolicy(name, deny)) return false;
  if (allow.length > 0 && !nameMatchesPolicy(name, allow)) return false;
  return true;
}

/** prefer 命中靠前、demote 靠后；其余保持相对顺序 */
export function sortSkillsByModePolicy<T extends SkillAccessRef>(
  skills: T[],
  policy: ModeSkillPolicy | null | undefined,
): T[] {
  const prefer = policy?.prefer ?? [];
  const demote = policy?.demote ?? [];
  if (!prefer.length && !demote.length) return skills;
  const preferred: T[] = [];
  const rest: T[] = [];
  const demoted: T[] = [];
  for (const s of skills) {
    if (skillMatchesRankingPolicy(s, prefer)) preferred.push(s);
    else if (skillMatchesRankingPolicy(s, demote)) demoted.push(s);
    else rest.push(s);
  }
  return [...preferred, ...rest, ...demoted];
}
