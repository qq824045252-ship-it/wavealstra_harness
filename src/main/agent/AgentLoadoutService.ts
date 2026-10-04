import { DEFAULT_WELCOME_MODE } from "../../shared/mode-profile";
import type { AssemblyTraceDto } from "../../shared/mode-profile";
import type { AgentLoadoutRecommendationDto } from "../../shared/agent-loadout";
import { isRemovedExpertTeamId, normalizeSingleExpertId } from "../../shared/expert-id";
import {
  matchesSkillPolicyNeedles,
  resolveSelectionCapability,
  resolveSkillCapability,
} from "../../shared/runtime-policy";
import type { AppDatabase } from "../db/AppDatabase";
import type { ExpertService } from "../experts/ExpertService";
import type { ConnectorService } from "../connectors/ConnectorService";
import type { SkillsService, RuntimeSkillSelection } from "../skills/SkillsService";
import type { MemoryService } from "../memory/MemoryService";
import type { MemorySkillEffectivenessService } from "../memory/MemorySkillEffectivenessService";
import type { McpRuntimeService } from "../mcp/McpRuntimeService";
import type { TaskExecutionWorkspace } from "../task/TaskExecutionWorkspace";
import type { ModeProfileStore } from "./ModeProfileStore";
import type { ProjectContextResolver } from "../project/ProjectContextResolver";
import { resolveModePreset } from "../../shared/mode-profile";
import { resolveRuntimeContextPolicy } from "./RuntimeContextResolver";
import { collectSessionSkillPaths } from "./sessionSkillPaths";
import { resolveAgentLoadout, type LoadoutCandidate } from "./AgentLoadoutResolver";

export interface AgentLoadoutServiceDeps {
  db: AppDatabase;
  modeProfiles: ModeProfileStore;
  projectContextResolver: ProjectContextResolver;
  expertsService: ExpertService;
  connectorsService: ConnectorService;
  skillsService: SkillsService;
  memoryService: MemoryService;
  skillEffectiveness: MemorySkillEffectivenessService;
  mcpRuntime: McpRuntimeService;
  taskWorkspace: TaskExecutionWorkspace;
  memoryEnabled: () => boolean;
  resolveSkillsForContext: (
    cwd: string | undefined,
    extraSkillPaths: string[],
    context: { projectId?: string | null; workspaceId?: string | null },
  ) => RuntimeSkillSelection;
}

/**
 * Builds the capability candidate set and recommendation/effective-selection evidence.
 * It is intentionally side-effect free: actual capability mutation belongs to session assembly.
 */
export class AgentLoadoutService {
  constructor(private readonly deps: AgentLoadoutServiceDeps) {}

  resolve(
    taskId: string,
    query: string,
    assembly?: AssemblyTraceDto | null,
    connectorIdsOverride: string[] = [],
    expertIdOverride?: string | null,
  ): AgentLoadoutRecommendationDto {
    const d = this.deps;
    const task = d.db.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const welcomeMode = task.welcomeMode ?? DEFAULT_WELCOME_MODE;
    const profile = d.modeProfiles.getProfile(welcomeMode);
    const preset = resolveModePreset(profile.policy, task.modePresetId);
    const projectContext = d.projectContextResolver.resolveTask(taskId);
    const connectorIds = connectorIdsOverride;
    const selectedExpertId = normalizeSingleExpertId(expertIdOverride === undefined ? task.expertId : expertIdOverride);
    const resolved = resolveRuntimeContextPolicy({ welcomeMode, profile, projectContext, preset });
    const effectiveProfile = resolved.effectiveProfile;
    const cwd = task.cwd
      ?? (task.spaceId ? d.db.getSpace(task.spaceId)?.path : undefined)
      ?? d.taskWorkspace.resolveTaskExecutionWorkspaceDir(taskId);
    const actualCapabilities = new Map(
      (assembly?.capabilities ?? []).map((item) => [`${item.kind}:${item.id.toLowerCase()}`, item]),
    );
    const actualSkillIds = new Set(
      (assembly?.capabilities ?? [])
        .filter((item) => item.kind === "skill" && item.enabled)
        .map((item) => item.id.toLowerCase()),
    );
    const actualMcpIds = new Set((assembly?.mcpFilter.enabled ?? []).map((id) => id.toLowerCase()));
    const actualConnectorIds = new Set(
      (assembly?.capabilities ?? [])
        .filter((item) => item.kind === "connector" && item.enabled)
        .map((item) => item.id.toLowerCase()),
    );
    const candidates: LoadoutCandidate[] = [];

    const singleExpertRecommendations = (ids: string[]): string[] =>
      ids.map((id) => id.toLowerCase()).filter((id) => !isRemovedExpertTeamId(id));
    const modeExpertRecommended = new Set(singleExpertRecommendations(profile.policy.recommendedExpertIds));
    const projectExpertRecommended = new Set(singleExpertRecommendations(projectContext?.policies.expert.recommended ?? []));
    const tagExpertRecommended = new Set(singleExpertRecommendations([
      ...(preset?.recommendedExpertIds ?? []),
      ...(preset?.expertPolicy?.recommended ?? []),
    ]));
    const expertById = new Map<string, {
      id: string; label: string; description: string; tags: string[]; enabled: boolean; installed: boolean;
    }>();
    for (const expert of d.expertsService.listMarket()) {
      expertById.set(expert.id.toLowerCase(), {
        id: expert.id, label: expert.name, description: expert.description, tags: expert.tags, enabled: false, installed: false,
      });
    }
    for (const expert of d.expertsService.listInstalled()) {
      expertById.set(expert.id.toLowerCase(), {
        id: expert.id, label: expert.name, description: expert.description, tags: expert.tags, enabled: expert.enabled, installed: true,
      });
    }
    const explicitlyRecommendedExperts = new Set([
      ...modeExpertRecommended,
      ...projectExpertRecommended,
      ...tagExpertRecommended,
    ]);
    for (const id of explicitlyRecommendedExperts) {
      if (!expertById.has(id)) {
        expertById.set(id, { id, label: id, description: "", tags: [], enabled: false, installed: false });
      }
    }
    for (const expert of expertById.values()) {
      if (!expert.installed && !explicitlyRecommendedExperts.has(expert.id.toLowerCase())) continue;
      const decision = expert.installed
        ? resolveSelectionCapability(expert.id, "expert", [
            { source: "mode", sourceId: welcomeMode, policy: profile.policy.expertPolicy },
            { source: "project", sourceId: projectContext?.sourceId, policy: projectContext?.policies.expert },
            { source: "tag", sourceId: preset?.id, policy: preset?.expertPolicy },
          ], { globallyEnabled: expert.enabled && d.expertsService.isRuntimeAvailable(expert.id) })
        : { id: expert.id, kind: "expert" as const, enabled: false, sources: [], reason: "not_installed" };
      candidates.push({
        kind: "expert",
        id: expert.id,
        label: expert.label,
        description: expert.description,
        tags: expert.tags,
        allowed: decision.enabled,
        blockReason: decision.reason,
        actual: Boolean(
          selectedExpertId
          && selectedExpertId.toLowerCase() === expert.id.toLowerCase()
          && actualCapabilities.get(`expert:${expert.id.toLowerCase()}`)?.enabled
        ),
        modeRecommended: modeExpertRecommended.has(expert.id.toLowerCase()),
        projectRecommended: projectExpertRecommended.has(expert.id.toLowerCase()),
        tagRecommended: tagExpertRecommended.has(expert.id.toLowerCase()),
      });
    }

    const connectorRecommended = new Set((profile.policy.connectorPolicy?.recommended ?? []).map((id) => id.toLowerCase()));
    const projectConnectorRecommended = new Set((projectContext?.policies.connector.recommended ?? []).map((id) => id.toLowerCase()));
    const tagConnectorRecommended = new Set((preset?.connectorPolicy?.recommended ?? []).map((id) => id.toLowerCase()));
    const knownConnectors = d.connectorsService.list();
    const connectorById = new Map(knownConnectors.map((connector) => [connector.id.toLowerCase(), connector]));
    const explicitlyRecommendedConnectors = new Set([
      ...connectorRecommended,
      ...projectConnectorRecommended,
      ...tagConnectorRecommended,
    ]);
    for (const id of explicitlyRecommendedConnectors) {
      if (!connectorById.has(id)) {
        connectorById.set(id, {
          id, name: id, description: "", sourcePath: "", installed: false, skillCount: 0, installedSkillNames: [],
        });
      }
    }
    for (const connector of connectorById.values()) {
      if (!connector.installed && !explicitlyRecommendedConnectors.has(connector.id.toLowerCase())) continue;
      const decision = connector.installed
        ? resolveSelectionCapability(connector.id, "connector", [
            { source: "mode", sourceId: welcomeMode, policy: profile.policy.connectorPolicy },
            { source: "project", sourceId: projectContext?.sourceId, policy: projectContext?.policies.connector },
            { source: "tag", sourceId: preset?.id, policy: preset?.connectorPolicy },
          ], { globallyEnabled: d.connectorsService.isActive(connector.id) })
        : { id: connector.id, kind: "connector" as const, enabled: false, sources: [], reason: "not_installed" };
      candidates.push({
        kind: "connector",
        id: connector.id,
        label: connector.name,
        description: connector.description,
        tags: connector.examples,
        allowed: decision.enabled,
        blockReason: decision.reason,
        actual: actualConnectorIds.has(connector.id.toLowerCase()),
        modeRecommended: connectorRecommended.has(connector.id.toLowerCase()),
        projectRecommended: projectConnectorRecommended.has(connector.id.toLowerCase()),
        tagRecommended: tagConnectorRecommended.has(connector.id.toLowerCase()),
      });
    }

    const effectiveExpertId = selectedExpertId
      && actualCapabilities.get(`expert:${selectedExpertId.toLowerCase()}`)?.enabled
      ? selectedExpertId
      : undefined;
    const effectiveConnectorIds = connectorIds.filter((id) => actualConnectorIds.has(id.toLowerCase()));
    const skillPaths = collectSessionSkillPaths(effectiveExpertId, effectiveConnectorIds, {
      expertSkillDir: (id) => d.expertsService.getPrivateSkillsDir(id),
      connectorSkillDirs: (ids) => d.connectorsService.getPrivateSkillDirs(ids),
    });
    const effectiveness = d.skillEffectiveness.summaries(500);
    const runtimeSkills = d.resolveSkillsForContext(
      cwd,
      skillPaths,
      { projectId: task.projectId, workspaceId: task.spaceId },
    );
    for (const skill of runtimeSkills.dtos) {
      const decision = resolveSkillCapability(
        { id: skill.id, name: skill.name, description: skill.description, command: skill.command, enabled: skill.enabled },
        resolved.skillPolicySources,
        { welcomeMode },
      );
      const learned = skill.filePath ? d.skillsService.getLearnedSkillMetadataForFile(skill.filePath) : undefined;
      const eff = learned?.candidateId
        ? effectiveness.find((item) => item.skillId.toLowerCase() === skill.id.toLowerCase() && item.candidateId === learned.candidateId)
        : undefined;
      candidates.push({
        kind: "skill",
        id: skill.id,
        label: skill.name,
        description: skill.description,
        allowed: decision.enabled,
        blockReason: decision.reason,
        actual: actualSkillIds.has(skill.id.toLowerCase()),
        modeRecommended: matchesSkillPolicyNeedles(
          { id: skill.id, name: skill.name, description: skill.description, command: skill.command },
          profile.policy.skillPolicy.prefer,
        ),
        projectRecommended: matchesSkillPolicyNeedles(
          { id: skill.id, name: skill.name, description: skill.description, command: skill.command },
          projectContext?.policies.skill.prefer ?? [],
        ),
        tagRecommended: matchesSkillPolicyNeedles(
          { id: skill.id, name: skill.name, description: skill.description, command: skill.command },
          preset?.skillPolicy?.prefer ?? [],
        ),
        sourceMemoryIds: learned?.sourceMemoryIds,
        effectiveness: eff ? {
          invocations: eff.invocations,
          completionRate: eff.completionRate,
          helpfulFeedback: eff.helpfulFeedback,
          needsRevisionFeedback: eff.needsRevisionFeedback,
          incorrectFeedback: eff.incorrectFeedback,
        } : undefined,
      });
    }

    const mcpPreview = d.mcpRuntime.previewMcpFilter(
      welcomeMode,
      effectiveProfile.policy.mcpPolicy,
      resolved.mcpPolicySources,
    );
    const requiredMcp = new Set((preset?.providerMcpIds ?? []).map((id) => id.toLowerCase()));
    for (const decision of mcpPreview.capabilities) {
      candidates.push({
        kind: "mcp",
        id: decision.id,
        label: decision.id,
        allowed: decision.enabled,
        blockReason: decision.reason,
        actual: actualMcpIds.has(decision.id.toLowerCase()),
        tagRecommended: requiredMcp.has(decision.id.toLowerCase()),
      });
    }

    const memoryScopeChain = d.memoryService.resolveScopeChain({ taskId, projectId: task.projectId ?? undefined,
      workspaceId: task.spaceId ?? undefined, includeInherited: true });
    const memoryContext = d.memoryEnabled()
      ? { items: d.memoryService.search({
          taskId,
          projectId: task.projectId ?? undefined,
          workspaceId: task.spaceId ?? undefined,
          query,
          includeInherited: true,
          statuses: ["active"],
          limit: 24,
        }).map((hit) => {
          const scope = d.memoryService.bestMatchedScope(hit.memory, memoryScopeChain);
          return { ...hit.memory, scopeType: scope.scopeType, scopeId: scope.scopeId,
            score: hit.score, reasons: hit.reasons };
        }) }
      : null;
    return resolveAgentLoadout({
      taskId,
      query,
      mode: welcomeMode,
      projectId: task.projectId ?? undefined,
      workspaceId: task.spaceId ?? undefined,
      tagId: preset?.id,
      candidates,
      modelSuggestion: effectiveProfile.policy.suggestedModelId,
      permissionSuggestion: effectiveProfile.policy.suggestedPermissionMode,
      memoryContext,
    });
  }
}
