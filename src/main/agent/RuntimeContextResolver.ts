import type { ResolvedProjectContext } from "../../shared/project-domain";
import {
  resolveEffectiveModePolicy,
  withEffectiveModePolicy,
  type ModePresetDto,
  type ModeProfileDto,
  type WelcomeMode,
} from "../../shared/mode-profile";
import {
  resolveRuntimePolicy,
  resolveSelectionCapability,
  type ResolvedCapabilityDto,
  type ResolvedRuntimePolicy,
  type SourcedMcpPolicy,
  type SourcedSkillPolicy,
} from "../../shared/runtime-policy";

export interface RuntimeContextPolicyInput {
  welcomeMode: WelcomeMode;
  profile: ModeProfileDto;
  projectContext?: ResolvedProjectContext | null;
  preset?: ModePresetDto | null;
  expertId?: string | null;
  connectorIds?: string[];
  expertGloballyEnabled?: boolean;
  connectorGloballyEnabled?: Record<string, boolean>;
}

/**
 * Authoritative, side-effect-free Mode -> Project -> Tag policy resolution.
 *
 * This is the only orchestration point used by preview, prompt gating,
 * session assembly and Runtime Context Inspector. Skill and MCP decisions are
 * still produced by their real filters from the source lists returned here.
 */
export interface ResolvedRuntimeContextPolicy {
  runtimePolicy: ResolvedRuntimePolicy;
  effectiveProfile: ModeProfileDto;
  expertDecision: ResolvedCapabilityDto | null;
  connectorDecisions: ResolvedCapabilityDto[];
  skillPolicySources: SourcedSkillPolicy[];
  mcpPolicySources: SourcedMcpPolicy[];
}

export function resolveRuntimeContextPolicy(
  input: RuntimeContextPolicyInput,
): ResolvedRuntimeContextPolicy {
  const runtimePolicy = resolveRuntimePolicy({
    mode: input.profile.policy,
    project: input.projectContext?.policies,
    tag: input.preset,
  });
  const effective = resolveEffectiveModePolicy(input.profile.policy, input.preset);
  effective.skillPolicy = runtimePolicy.skillPolicy;
  effective.mcpPolicy = runtimePolicy.mcpPolicy;

  const expertDecision = input.expertId
    ? resolveSelectionCapability(input.expertId, "expert", [
        { source: "mode", sourceId: input.welcomeMode, policy: input.profile.policy.expertPolicy },
        { source: "project", sourceId: input.projectContext?.sourceId, policy: input.projectContext?.policies.expert },
        { source: "tag", sourceId: input.preset?.id, policy: input.preset?.expertPolicy },
      ], { globallyEnabled: input.expertGloballyEnabled })
    : null;
  const connectorDecisions = (input.connectorIds ?? []).map((id) =>
    resolveSelectionCapability(id, "connector", [
      { source: "mode", sourceId: input.welcomeMode, policy: input.profile.policy.connectorPolicy },
      { source: "project", sourceId: input.projectContext?.sourceId, policy: input.projectContext?.policies.connector },
      { source: "tag", sourceId: input.preset?.id, policy: input.preset?.connectorPolicy },
    ], { globallyEnabled: input.connectorGloballyEnabled?.[id] }),
  );

  return {
    runtimePolicy,
    effectiveProfile: withEffectiveModePolicy(input.profile, effective),
    expertDecision,
    connectorDecisions,
    skillPolicySources: [
      { source: "mode", sourceId: input.welcomeMode, policy: input.profile.policy.skillPolicy },
      { source: "project", sourceId: input.projectContext?.sourceId, policy: input.projectContext?.policies.skill },
      { source: "tag", sourceId: input.preset?.id, policy: input.preset?.skillPolicy },
    ],
    mcpPolicySources: [
      { source: "mode", sourceId: input.welcomeMode, policy: input.profile.policy.mcpPolicy },
      { source: "project", sourceId: input.projectContext?.sourceId, policy: input.projectContext?.policies.mcp },
      { source: "tag", sourceId: input.preset?.id, policy: input.preset?.mcpPolicy },
    ],
  };
}
