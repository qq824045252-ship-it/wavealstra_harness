/**
 * RuntimePrewarmService — 策略驱动声明式 runtime requirement 的 AutoStart / preflight gate。
 *
 * 解决的问题：选择 mechanical-cad / 3d-blender 等 preset/Tag 后，agent 跑到一半才发现外部
 * 软件（FreeCAD / Blender / Ardot / Penpot Docker / OpenDesign daemon 等 managed runtime）
 * 没开。本服务提供：
 *
 * - prewarm(requirement)：Tag/preset 激活时 best-effort 异步启动。按 launchPolicy：
 *   - "gui"：spawn 桌面软件 + 等待其 MCP bridge ready；
 *   - "backend"：只启动服务/daemon/Docker（不弹 GUI）；
 *   - "none"：adapter-managed（进程由会话内 MCP adapter 托管），不 spawn，只做无副作用
 *     状态探测（如 drawio-ai）。只做 readiness handshake（TCP/HTTP/归属探测），绝不调用
 *     业务 MCP tool。
 * - ensureReady(requirement)：用户真正发送任务前的 required-runtime preflight gate。
 *   未 ready → 先等 prewarm 完成 / 发起启动并等待；失败 → 明确失败（任务不开始）。
 *   "none" 策略永不因未 ready 抛错（adapter-managed 由会话自动拉起，不视为失败）。
 * - ensureMany(requirements)：send hard gate 用，所有 required runtime **并行**等待，
 *   任一失败即聚合报错（不做 N×90s 串行）。
 * - 首次 MCP tool call 仍可调 ensureReady 兜底（防 race / Tag 切换 / runtime crash）。
 * - 状态机 per provider：idle → starting → waiting-backend → ready | failed
 *   （+ detail + launch 策略），供轻量可见状态与 push 事件。
 * - 用户手动操作（运行上下文面板）：start = prewarm；stop 取消 in-flight 并停进程；
 *   restart = stop 后再 prewarm。迟到的 start() 结果不得覆盖已停止状态。
 *
 * 幂等/去重：同一 provider 并发 prewarm 只启动一次（inflight promise）；ready 后不重复
 * 启动；重复选择 / 并发 Tag 切换天然安全（状态以 provider 为键，与任务解耦）。
 * 机制与具体业务解耦：任何 RuntimeRequirement 都可声明，provider 细节留在
 * shared/runtime-requirement 默认策略表与各 Runtime 类。
 */
import type {
  ManagedToolProviderId,
  ProfessionalToolStatusDto,
} from "../../shared/professional-tools";
import {
  resolveRuntimeRequirement,
  type RuntimeLaunchPolicy,
  type RuntimeRequirement,
} from "../../shared/runtime-requirement";

/** RuntimePrewarmService 只依赖受管 runtime 的 status/start（无业务副作用探测）；stop 供用户手动停止。 */
export interface RuntimeStartable {
  status(providerId: ManagedToolProviderId): Promise<ProfessionalToolStatusDto>;
  start(providerId: ManagedToolProviderId): Promise<ProfessionalToolStatusDto>;
  stop?(providerId: ManagedToolProviderId): Promise<ProfessionalToolStatusDto>;
}

export type RuntimeRequirementPhase =
  | "idle"
  | "starting"
  | "waiting-backend"
  | "ready"
  | "failed";

export interface RuntimeRequirementState {
  providerId: string;
  phase: RuntimeRequirementPhase;
  /** 解析后的 launch 策略（gui/backend/none；UI 展示与判定用） */
  launch: RuntimeLaunchPolicy;
  /** 最近一次状态详情（如 "127.0.0.1:9876 Ready" / 启动失败原因） */
  detail: string | null;
  /** 最近一次 ready 探测时间（ms；null = 从未 ready） */
  lastReadyAt: number | null;
  lastAttemptAt: number | null;
}

export type RuntimeStateListener = (state: RuntimeRequirementState) => void;

export interface RuntimePrewarmOptions {
  /** 单次 ensureReady 等待上限（默认 90s） */
  ensureTimeoutMs?: number;
  /** prewarm 启动后等待 ready 的上限（默认 90s；超时标记 failed 但不阻塞调用方） */
  prewarmTimeoutMs?: number;
}

const DEFAULT_ENSURE_TIMEOUT_MS = 90_000;
const DEFAULT_PREWARM_TIMEOUT_MS = 90_000;

export class RuntimePrewarmService {
  private readonly states = new Map<string, RuntimeRequirementState>();
  private readonly inflight = new Map<string, Promise<void>>();
  /** 每次 start/stop 递增；迟到的 start() 结果若 generation 已变则丢弃。 */
  private readonly startGen = new Map<string, number>();
  private readonly options: Required<RuntimePrewarmOptions>;
  private stateListener: RuntimeStateListener | null = null;

  constructor(
    private readonly runtime: RuntimeStartable,
    options: RuntimePrewarmOptions = {},
  ) {
    this.options = {
      ensureTimeoutMs: options.ensureTimeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS,
      prewarmTimeoutMs: options.prewarmTimeoutMs ?? DEFAULT_PREWARM_TIMEOUT_MS,
    };
  }

  /** 状态变更监听（phase/detail/launch 变化时触发；UI push 事件用）。 */
  setStateChangeListener(listener: RuntimeStateListener | null): void {
    this.stateListener = listener;
  }

  getState(providerId: ManagedToolProviderId): RuntimeRequirementState {
    return {
      ...(this.states.get(providerId) ?? {
        providerId,
        phase: "idle",
        launch: "none",
        detail: null,
        lastReadyAt: null,
        lastAttemptAt: null,
      }),
    };
  }

  /** 当前是否已 ready（含状态缓存命中；不发起任何启动） */
  isReady(providerId: ManagedToolProviderId): boolean {
    return this.states.get(providerId)?.phase === "ready";
  }

  private bumpGen(providerId: string): number {
    const next = (this.startGen.get(providerId) ?? 0) + 1;
    this.startGen.set(providerId, next);
    return next;
  }

  private currentGen(providerId: string): number {
    return this.startGen.get(providerId) ?? 0;
  }

  private trackInflight(providerId: string, task: Promise<void>): Promise<void> {
    this.inflight.set(providerId, task);
    return task.finally(() => {
      if (this.inflight.get(providerId) === task) this.inflight.delete(providerId);
    });
  }

  private emit(state: RuntimeRequirementState): void {
    this.stateListener?.({ ...state });
  }

  private setState(providerId: string, patch: Partial<RuntimeRequirementState>): void {
    const prev = this.states.get(providerId);
    const next: RuntimeRequirementState = {
      providerId,
      phase: prev?.phase ?? "idle",
      launch: prev?.launch ?? "none",
      detail: prev?.detail ?? null,
      lastReadyAt: prev?.lastReadyAt ?? null,
      lastAttemptAt: prev?.lastAttemptAt ?? null,
      ...patch,
    };
    this.states.set(providerId, next);
    if (
      !prev ||
      prev.phase !== next.phase ||
      prev.detail !== next.detail ||
      prev.launch !== next.launch
    ) {
      this.emit(next);
    }
  }

  /**
   * Tag/preset 激活时的 best-effort prewarm（fire-and-forget，不阻塞 UI/调用方）。
   * - starting / waiting-backend → 直接短路（不重复启动）；
   * - ready + 非 GUI → 短路；ready + GUI → 复核窗口，sidecar-only 则补 spawn；
   * - launchPolicy "none" → 不 spawn，只做一次无副作用状态探测（adapter-managed）；
   * - failed → 重新尝试（更新 attempt 时间，允许用户重试或修复后自动恢复）。
   */
  prewarm(requirement: RuntimeRequirement): void {
    const id = requirement.providerId;
    requirement = this.normalize(requirement);
    const cur = this.states.get(id);
    if (cur?.phase === "starting" || cur?.phase === "waiting-backend") {
      if (cur.launch !== requirement.launchPolicy) {
        this.setState(id, { launch: requirement.launchPolicy });
      }
      return;
    }
    if (cur?.phase === "ready") {
      if (requirement.launchPolicy !== "gui") return;
      // GUI ready 缓存可能只是 sidecar 在听：复核窗口，未打开则补启动。
      if (this.inflight.has(id)) return;
      const gen = this.bumpGen(id);
      const task = this.trackInflight(id, this.reverifyGuiReady(id, requirement, gen));
      void task.catch(() => undefined);
      return;
    }
    if (this.inflight.has(id)) return;
    if (requirement.launchPolicy === "none") {
      // adapter-managed（drawio-ai 等）：进程由会话内 MCP adapter 托管，绝不 spawn
      const gen = this.bumpGen(id);
      this.setState(id, {
        launch: "none",
        detail: "adapter-managed：进程由会话 MCP 托管，不自动启动",
        lastAttemptAt: Date.now(),
      });
      const task = this.trackInflight(id, this.probeOnly(id, gen));
      // fire-and-forget：拒绝不影响调用方（状态已记录）
      void task.catch(() => undefined);
      return;
    }
    const gen = this.bumpGen(id);
    this.setState(id, {
      phase: "starting",
      launch: requirement.launchPolicy,
      detail: requirement.launchPolicy === "gui" ? "启动应用（prewarm）…" : "启动服务（prewarm）…",
      lastReadyAt: cur?.lastReadyAt ?? null,
      lastAttemptAt: Date.now(),
    });
    const task = this.trackInflight(id, this.runStart(id, this.options.prewarmTimeoutMs, gen));
    // fire-and-forget：拒绝不影响调用方（状态已记录 failed）
    void task.catch(() => undefined);
  }

  /**
   * 用户手动停止：作废 in-flight start，尽力停进程，状态回到 idle。
   * 无 stop 实现时仍作废 generation，避免迟到的 start() 把状态改回 ready。
   */
  async stop(providerId: ManagedToolProviderId): Promise<void> {
    this.bumpGen(providerId);
    this.inflight.delete(providerId);
    const launch =
      this.states.get(providerId)?.launch ??
      resolveRuntimeRequirement(providerId)?.launchPolicy ??
      "none";
    try {
      const status = this.runtime.stop ? await this.runtime.stop(providerId) : undefined;
      this.setState(providerId, {
        phase: "idle",
        launch,
        detail: status?.detail ?? "已停止",
        lastReadyAt: null,
        lastAttemptAt: Date.now(),
      });
    } catch (error) {
      this.setState(providerId, {
        phase: "failed",
        launch,
        detail: error instanceof Error ? error.message : String(error),
        lastAttemptAt: Date.now(),
      });
      throw error;
    }
  }

  /** 用户手动重启：先停再按声明策略 prewarm。 */
  async restart(requirement: RuntimeRequirement): Promise<void> {
    requirement = this.normalize(requirement);
    await this.stop(requirement.providerId);
    this.prewarm(requirement);
  }

  /** GUI 已标 ready 时再探测一次：窗口真在则保持；sidecar-only 则补 spawn。 */
  private async reverifyGuiReady(
    providerId: ManagedToolProviderId,
    requirement: RuntimeRequirement,
    gen: number,
  ): Promise<void> {
    try {
      const fresh = await this.runtime.status(providerId);
      if (this.currentGen(providerId) !== gen) return;
      if (fresh.ready === true) return;
      this.setState(providerId, {
        phase: "starting",
        launch: requirement.launchPolicy,
        detail: "启动应用（prewarm）…",
        lastReadyAt: this.states.get(providerId)?.lastReadyAt ?? null,
        lastAttemptAt: Date.now(),
      });
      await this.runStart(providerId, this.options.prewarmTimeoutMs, gen);
    } catch (error) {
      if (this.currentGen(providerId) !== gen) return;
      this.setState(providerId, {
        phase: "failed",
        launch: requirement.launchPolicy,
        detail: error instanceof Error ? error.message : String(error),
        lastAttemptAt: Date.now(),
      });
    }
  }

  /** launchPolicy=none 的无副作用探测：更新真实状态（ready/idle），不 spawn、不失败。 */
  private async probeOnly(providerId: ManagedToolProviderId, gen: number): Promise<void> {
    try {
      const fresh = await this.runtime.status(providerId);
      if (this.currentGen(providerId) !== gen) return;
      if (fresh.ready === true) {
        this.setState(providerId, {
          phase: "ready",
          detail: fresh.detail ?? "Ready",
          lastReadyAt: Date.now(),
          lastAttemptAt: Date.now(),
        });
      } else {
        this.setState(providerId, {
          phase: "idle",
          detail: fresh.detail ?? "adapter-managed：进程由会话 MCP 托管，不自动启动",
          lastReadyAt: null,
          lastAttemptAt: Date.now(),
        });
      }
    } catch (error) {
      if (this.currentGen(providerId) !== gen) return;
      this.setState(providerId, {
        phase: "failed",
        detail: error instanceof Error ? error.message : String(error),
        lastReadyAt: null,
        lastAttemptAt: Date.now(),
      });
    }
  }

  /**
   * 发送任务前的 required-runtime preflight gate（单 provider）：
   * - ready → 立即通过（先做无副作用 fresh status 复核：runtime crash / 用户关闭后自动恢复）；
   * - starting / waiting-backend → 等当前 prewarm 完成；
   * - 其他 → 发起 start 并等待 ready；超时/失败 → reject（调用方必须在任务开始前失败）。
   * launchPolicy "none" → 永不 reject（adapter-managed，进程由会话自动拉起；只回真实状态）。
   */
  async ensureReady(
    requirement: RuntimeRequirement,
    timeoutMs?: number,
  ): Promise<ProfessionalToolStatusDto> {
    const id = requirement.providerId;
    requirement = this.normalize(requirement);
    const cur = this.states.get(id);

    if (requirement.launchPolicy === "none") {
      const fresh = await this.runtime.status(id);
      if (fresh.ready === true) {
        this.setState(id, {
          phase: "ready",
          launch: "none",
          detail: fresh.detail ?? "Ready",
          lastReadyAt: Date.now(),
          lastAttemptAt: Date.now(),
        });
        return fresh;
      }
      this.setState(id, {
        phase: "idle",
        launch: "none",
        detail: "adapter-managed：进程由会话 MCP 托管（未自动启动，不视为失败）",
        lastReadyAt: null,
        lastAttemptAt: Date.now(),
      });
      return {
        providerId: id,
        state: fresh.state,
        installed: fresh.installed,
        ready: false,
        detail: "adapter-managed：进程由会话 MCP 托管（未自动启动，不视为失败）",
      };
    }

    if (cur?.phase === "ready") {
      // ready 缓存需用无副作用探测确认（runtime crash / 用户关闭软件后自动恢复）
      const fresh = await this.runtime.status(id);
      if (fresh.ready === true) {
        return {
          providerId: id,
          state: "ready",
          installed: true,
          ready: true,
          detail: cur.detail ?? undefined,
        };
      }
      // 掉线：标记并走重新启动路径（不静默通过）
      this.setState(id, {
        phase: "failed",
        detail: "runtime 已掉线，正在重新启动…",
        lastReadyAt: cur.lastReadyAt,
        lastAttemptAt: Date.now(),
      });
    }
    const existing = this.inflight.get(id);
    if (existing) {
      await existing;
      const after = this.states.get(id);
      if (after?.phase === "ready") {
        return { providerId: id, state: "ready", installed: true, ready: true, detail: after.detail ?? undefined };
      }
      throw new Error(this.failureMessage(id, after?.detail));
    }
    const gen = this.bumpGen(id);
    this.setState(id, {
      phase: "starting",
      launch: requirement.launchPolicy,
      detail: requirement.launchPolicy === "gui" ? "启动应用（send preflight）…" : "启动服务（send preflight）…",
      lastReadyAt: cur?.lastReadyAt ?? null,
      lastAttemptAt: Date.now(),
    });
    const task = this.trackInflight(
      id,
      this.runStart(id, timeoutMs ?? requirement.timeoutMs ?? this.options.ensureTimeoutMs, gen),
    );
    await task;
    const after = this.states.get(id);
    if (after?.phase !== "ready") {
      throw new Error(this.failureMessage(id, after?.detail));
    }
    return { providerId: id, state: "ready", installed: true, ready: true, detail: after.detail ?? undefined };
  }

  /**
   * send hard gate：所有 required runtime **并行** ensureReady（不做 N×串行等待）。
   * 任一失败 → 聚合错误（列出每个失败 provider 与原因）；全部通过 → 返回各 status。
   */
  async ensureMany(requirements: RuntimeRequirement[], timeoutMs?: number): Promise<ProfessionalToolStatusDto[]> {
    if (requirements.length === 0) return [];
    const settled = await Promise.allSettled(
      requirements.map((requirement) => this.ensureReady(requirement, timeoutMs)),
    );
    const failures: string[] = [];
    const statuses: ProfessionalToolStatusDto[] = [];
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        statuses.push(result.value);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push(`${requirements[index].providerId}：${reason}`);
      }
    });
    if (failures.length > 0) {
      throw new Error(`必需运行环境未就绪：${failures.join("；")}。任务未开始，可修复后重试。`);
    }
    return statuses;
  }

  private async runStart(
    providerId: ManagedToolProviderId,
    timeoutMs: number,
    gen: number,
  ): Promise<void> {
    try {
      const status = await this.runtime.start(providerId);
      if (this.currentGen(providerId) !== gen) return;
      const ready = status.ready === true;
      this.setState(providerId, {
        phase: ready ? "ready" : "waiting-backend",
        detail: status.detail ?? (ready ? "Ready" : "等待 backend…"),
        lastReadyAt: ready ? Date.now() : null,
        lastAttemptAt: Date.now(),
      });
      // 兜底：start() 返回未 ready（如超时未判）时给一次显式探测
      if (!ready && timeoutMs > 0) {
        const late = await this.runtime.status(providerId);
        if (this.currentGen(providerId) !== gen) return;
        if (late.ready === true) {
          this.setState(providerId, {
            phase: "ready",
            detail: late.detail ?? "Ready",
            lastReadyAt: Date.now(),
            lastAttemptAt: Date.now(),
          });
        } else {
          this.setState(providerId, {
            phase: "failed",
            detail: late.detail ?? "启动后 backend 未 Ready",
            lastReadyAt: null,
            lastAttemptAt: Date.now(),
          });
        }
      }
    } catch (error) {
      if (this.currentGen(providerId) !== gen) return;
      const message = error instanceof Error ? error.message : String(error);
      this.setState(providerId, {
        phase: "failed",
        detail: message,
        lastReadyAt: null,
        lastAttemptAt: Date.now(),
      });
    }
  }

  private failureMessage(providerId: ManagedToolProviderId, detail: string | null | undefined): string {
    return (
      `必需运行环境未就绪：${providerId}。` +
      (detail ? `${detail}。` : "") +
      `请在任务开始前确认 ${providerId} 可启动（检查安装与 MCP 配置），修复后重新发送。`
    );
  }

  /** 防御性归一化：调用方可能传未解析的声明（缺 launch 等），统一经默认策略补齐。 */
  private normalize(requirement: RuntimeRequirement): RuntimeRequirement {
    return resolveRuntimeRequirement(requirement) ?? requirement;
  }
}
