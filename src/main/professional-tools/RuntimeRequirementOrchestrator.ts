import type { RuntimeRequirementStateDto } from "../../shared/agent-ipc";
import type { ModePresetDto, ModeProfileDto, WelcomeMode } from "../../shared/mode-profile";
import {
  isManagedToolProvider,
  isRetiredManagedProvider,
  type ManagedToolProviderId,
} from "../../shared/professional-tools";
import {
  resolveRuntimeRequirement,
  resolveRuntimeRequirementList,
  type RuntimeRequirement,
} from "../../shared/runtime-requirement";
import { resolveModePreset } from "../../shared/mode-profile";
import type { ProfessionalToolRuntimeService } from "./ProfessionalToolRuntime";
import {
  RuntimePrewarmService,
  type RuntimeRequirementState,
  type RuntimeStartable,
} from "./RuntimePrewarmService";

export type ProfessionalToolRuntimeFacade = Pick<ProfessionalToolRuntimeService, "prepareForProvider"> & Partial<RuntimeStartable>;

/**
 * Owns declarative runtime requirements and managed professional-tool gating.
 * AgentService delegates here instead of knowing status/start/stop/prewarm details.
 */
export interface RuntimeRequirementProfileSource {
  getProfile(mode: WelcomeMode): ModeProfileDto;
}

export class RuntimeRequirementOrchestrator {
  private runtime: ProfessionalToolRuntimeFacade | null = null;
  private prewarm: RuntimePrewarmService | null = null;
  private stateListener: ((state: RuntimeRequirementState) => void) | null = null;

  constructor(private readonly modeProfiles: RuntimeRequirementProfileSource) {}

  setRuntime(runtime: ProfessionalToolRuntimeFacade | null): void {
    this.runtime = runtime;
    this.prewarm = runtime && typeof runtime.status === "function" && typeof runtime.start === "function"
      ? new RuntimePrewarmService(runtime as RuntimeStartable)
      : null;
    this.prewarm?.setStateChangeListener(this.stateListener);
  }

  setStateChangeListener(listener: ((state: RuntimeRequirementState) => void) | null): void {
    this.stateListener = listener;
    this.prewarm?.setStateChangeListener(listener);
  }

  prewarmPreset(preset?: ModePresetDto | null): void {
    const requirements = resolveRuntimeRequirementList(preset?.requiredRuntimes);
    if (!this.prewarm) return;
    for (const requirement of requirements) this.prewarm.prewarm(requirement);
  }

  async ensurePresetReady(preset?: ModePresetDto | null): Promise<void> {
    const requirements = resolveRuntimeRequirementList(preset?.requiredRuntimes);
    if (requirements.length === 0 || !this.prewarm) return;
    for (const requirement of requirements) this.prewarm.prewarm(requirement);
    try {
      await this.prewarm.ensureMany(requirements);
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : `Required runtime not ready: ${requirements.map((item) => item.providerId).join(", ")}`,
      );
    }
  }

  onModePresetSelected(welcomeMode: WelcomeMode, modePresetId: string | null): void {
    try {
      const profile = this.modeProfiles.getProfile(welcomeMode);
      const preset = resolveModePreset(profile.policy, modePresetId);
      this.prewarmPreset(preset);
    } catch {
      // Selection prewarm is best-effort; send-time ensurePresetReady remains authoritative.
    }
  }

  listStates(): RuntimeRequirementStateDto[] {
    if (!this.prewarm) return [];
    const requiredBy = new Map<string, string[]>();
    for (const mode of ["working", "coding", "general"] as WelcomeMode[]) {
      const profile = this.modeProfiles.getProfile(mode);
      for (const preset of profile.policy.presets ?? []) {
        for (const entry of preset.requiredRuntimes ?? []) {
          const resolved = resolveRuntimeRequirement(entry);
          if (!resolved || isRetiredManagedProvider(resolved.providerId)) continue;
          const list = requiredBy.get(resolved.providerId) ?? [];
          if (!list.includes(preset.id)) list.push(preset.id);
          requiredBy.set(resolved.providerId, list);
        }
      }
    }
    return [...requiredBy.keys()].map((providerId) => {
      const state = this.prewarm?.getState(providerId as ManagedToolProviderId);
      const defaults = resolveRuntimeRequirement(providerId);
      const launch = state && !(state.phase === "idle" && state.launch === "none" && defaults?.launchPolicy)
        ? state.launch
        : (defaults?.launchPolicy ?? state?.launch ?? "none");
      return {
        providerId,
        phase: state?.phase ?? "idle",
        launch,
        detail: state?.detail ?? null,
        lastReadyAt: state?.lastReadyAt ?? null,
        lastAttemptAt: state?.lastAttemptAt ?? null,
        requiredBy: requiredBy.get(providerId) ?? [],
      };
    });
  }

  start(providerId: string): void {
    const prewarm = this.requirePrewarm();
    prewarm.prewarm(this.resolveManagedRequirement(providerId));
  }

  stop(providerId: string): Promise<void> {
    const prewarm = this.requirePrewarm();
    const requirement = this.resolveManagedRequirement(providerId);
    return prewarm.stop(requirement.providerId);
  }

  restart(providerId: string): Promise<void> {
    const prewarm = this.requirePrewarm();
    return prewarm.restart(this.resolveManagedRequirement(providerId));
  }

  async ensureProviderReady(providerId: string): Promise<void> {
    if (!this.prewarm || !isManagedToolProvider(providerId)) return;
    const requirement = resolveRuntimeRequirement(providerId);
    if (!requirement) return;
    try {
      await this.prewarm.ensureReady(requirement);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : `Required runtime not ready: ${providerId}`);
    }
  }

  previewManagedProviderWarnings(
    preset: ModePresetDto | undefined,
    fallbackLabel: string | null | undefined,
    allowedProviderIds: readonly string[],
  ): string[] {
    const providers = this.managedProviders(preset);
    if (providers.length === 0) return [];
    const allowed = new Set(allowedProviderIds);
    const warnings: string[] = [];
    for (const providerId of providers) {
      const label = preset?.label ?? fallbackLabel ?? providerId;
      if (!allowed.has(providerId)) {
        warnings.push(
          `场景预设「${label}」需要受管 provider ${providerId}，但当前 Mode MCP 策略未放行该 provider；真实会话创建会被拒绝。`,
        );
      } else if (!this.runtime) {
        warnings.push(
          `场景预设「${label}」需要受管 provider ${providerId}，但专业工具 Runtime 尚未初始化；真实会话创建会被拒绝。`,
        );
      }
    }
    return warnings;
  }

  async prepareManagedProviders(
    preset: ModePresetDto | undefined,
    fallbackLabel: string | null | undefined,
    allowedProviderIds: readonly string[],
  ): Promise<void> {
    const providers = this.managedProviders(preset);
    if (providers.length === 0) return;
    const allowed = new Set(allowedProviderIds);
    for (const providerId of providers) {
      const label = preset?.label ?? fallbackLabel ?? providerId;
      if (!allowed.has(providerId)) {
        throw new Error(
          `场景预设「${label}」需要 ${providerId}，但当前统一 MCP 策略没有放行该 provider；请检查 Mode、Project 与 Tag 设置。`,
        );
      }
      if (!this.runtime) throw new Error(`专业工具 Runtime 尚未初始化：${providerId}`);
      const prepared = await this.runtime.prepareForProvider(providerId);
      if (!prepared.ok) {
        throw new Error(`专业工具 ${providerId} 准备失败：${prepared.error ?? prepared.status.detail ?? "未知错误"}`);
      }
    }
  }

  private managedProviders(preset?: ModePresetDto | null): ManagedToolProviderId[] {
    return (preset?.providerMcpIds ?? []).filter(
      (id): id is ManagedToolProviderId => isManagedToolProvider(id) && !isRetiredManagedProvider(id),
    );
  }

  private requirePrewarm(): RuntimePrewarmService {
    if (!this.prewarm) throw new Error("Runtime 服务未就绪");
    return this.prewarm;
  }

  private resolveManagedRequirement(providerId: string): RuntimeRequirement {
    const resolved = resolveRuntimeRequirement(providerId);
    if (!resolved) throw new Error(`未知运行环境：${providerId}`);
    return resolved;
  }
}