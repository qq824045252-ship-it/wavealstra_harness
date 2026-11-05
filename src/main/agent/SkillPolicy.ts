import type { ModeSkillPolicy, WelcomeMode } from "../../shared/mode-profile";
import {
  matchesSkillPolicyNeedles,
  resolveSkillCapability,
  type ResolvedCapabilityDto,
  type SourcedSkillPolicy,
} from "../../shared/runtime-policy";

export interface SkillRef {
  id: string;
  name: string;
  description: string;
  /** frontmatter modes；缺省=全模式 */
  modes?: WelcomeMode[];
  enabled?: boolean;
}

export interface SkillFilterResult {
  visible: SkillRef[];
  demoted: SkillRef[];
  hidden: SkillRef[];
  prefer: string[];
  demote: string[];
  hide: string[];
  allow: string[];
  capabilities: ResolvedCapabilityDto[];
}

/**
 * 按 ModeProfile.skillPolicy 过滤/排序技能目录。
 * hide（限制）> allow 白名单 > modes 限制 > demote 排序靠后 > prefer 靠前。
 * allow 非空：仅保留命中项；空 allow = 不启用白名单。
 * prefer / demote 是关键词语义（允许 description 子串）；hide / allow 是身份语义。
 */
export function filterSkillsForMode(
  skills: SkillRef[],
  welcomeMode: WelcomeMode,
  policy: ModeSkillPolicy,
  options?: { disableFilter?: boolean; policySources?: SourcedSkillPolicy[] },
): SkillFilterResult {
  const prefer = policy.prefer ?? [];
  const demote = policy.demote ?? [];
  const hide = policy.hide ?? [];
  const allow = policy.allow ?? [];

  if (options?.disableFilter) {
    return {
      visible: [...skills],
      demoted: [],
      hidden: [],
      prefer,
      demote,
      hide,
      allow,
      capabilities: skills.map((skill) => ({
        id: skill.id,
        kind: "skill",
        enabled: true,
        sources: [],
      })),
    };
  }

  const hidden: SkillRef[] = [];
  const kept: SkillRef[] = [];
  const capabilities: ResolvedCapabilityDto[] = [];

  for (const s of skills) {
    const decision = resolveSkillCapability(
      s,
      options?.policySources ?? [{ source: "mode", sourceId: welcomeMode, policy }],
      { welcomeMode },
    );
    capabilities.push(decision);
    if (!decision.enabled) {
      if (s.enabled !== false) hidden.push(s);
      continue;
    }
    kept.push(s);
  }

  const demoted = kept.filter((s) => matchesSkillPolicyNeedles(s, demote));
  const preferred = kept.filter((s) => matchesSkillPolicyNeedles(s, prefer));
  const rest = kept.filter((s) => !preferred.includes(s) && !demoted.includes(s));

  const visible = [...preferred, ...rest, ...demoted];

  return {
    visible,
    demoted,
    hidden,
    prefer,
    demote,
    hide,
    allow,
    capabilities,
  };
}

/**
 * Pi SDK 边界硬门禁：ResourceLoader 只能保留 RuntimePolicy 最终允许的技能。
 * 由 createSession 把 assembly.skillFilter.visible（唯一允许集）传到这里；
 * SDK 默认 discovery / additionalSkillPaths 的结果一律经此收敛，
 * 保证 loader.getSkills() === Final Allowed Skill Set（不变量 1/2）。
 */
export function filterLoaderSkills<T extends { name: string }, D>(
  result: { skills: T[]; diagnostics: D },
  allowedNames: ReadonlySet<string>,
): { skills: T[]; diagnostics: D } {
  return {
    ...result,
    skills: result.skills.filter((skill) => allowedNames.has(skill.name)),
  };
}

export function formatSkillCatalogSection(
  welcomeMode: WelcomeMode,
  filter: SkillFilterResult,
): string | null {
  if (filter.visible.length === 0 && filter.hidden.length === 0) return null;
  const lines = [
    `## 本模式可用技能目录（${welcomeMode}）`,
    "以下为当前场景下可见技能（名称 + 简述）。需要时再按技能全文加载。",
  ];
  if (filter.allow.length > 0) {
    lines.push(`白名单：${filter.allow.join(", ")}（仅匹配项可见）`);
  }
  if (filter.hide.length > 0) {
    lines.push(`限制/隐藏：${filter.hide.join(", ")}`);
  }
  if (filter.visible.length === 0) {
    lines.push("（当前无已安装且可见的技能）");
  } else {
    for (const s of filter.visible) {
      const tag = filter.demoted.includes(s)
        ? " 〔降权〕"
        : matchesSkillPolicyNeedles(s, filter.prefer)
          ? " 〔推荐〕"
          : "";
      lines.push(`- **${s.name}**${tag}：${s.description || "无描述"}`);
    }
  }
  if (filter.hidden.length > 0) {
    lines.push(
      `\n（已按场景隐藏 ${filter.hidden.length} 项技能，可在设置中关闭「技能按场景过滤」）`,
    );
  }
  return lines.join("\n");
}
