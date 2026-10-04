/**
 * CaptureModeController — V3.5 Wave 4C（§78-82）
 *
 * Capture Mode 状态机：enter / exit / startInspect / stopInspect / dispose。
 * 只管生命周期与状态；CDP 细节统一在 PageInspectionService（唯一底层，WebAccess/Browser 收敛 A）。
 *
 * 生命周期（§4C 固定路径）：
 *   enter(artifactId)
 *     → addBlocker("capture-mode-transition")   （过渡期隐藏 WCV）
 *     → PageInspectionService.acquire + attach + enableDomains
 *     → removeBlocker                           （就绪后恢复显示）
 *     → setInspectMode
 *     → state: active
 *   hover / click → Overlay（Native 高亮）→ inspectNodeRequested
 *     → resolveSelection → SelectionDescriptor（补 artifactId/version/generation）→ onSelection
 *   exit()
 *     → clearInspectMode → release → removeBlocker → state: exited
 *
 * 生命周期事故处理（§4C 五项，语义保持）：
 *   1. 重复 enter：先完整退出旧 session 再进入
 *   2. Artifact 切换：enter 时记录 surfaceGeneration；selection/检查前对比
 *      Coordinator 当前 generation，变化 → 静默退出（绝不 inspect 旧 WCV）
 *   3. WCV destroy：debugger 'detach'（target closed）→ 静默清理，不抛异常
 *   4. DevTools 冲突：attach 失败 → error state（Capture Mode unavailable，
 *      非致命 §36）+ 解除 transition blocker（WCV 不被永久隐藏）
 *   5. 迟到 CDP 事件：session token 过滤（event 属于旧 session → ignore，
 *      与 4A generation 语义一致）
 *
 * 不做（明确禁止）：SelectionStore / PromptContext / 改 HTML / AI 接入。
 */
import type { SelectionDescriptor } from "../../shared/capture-mode";

import {
  pageInspectionService,
  type PageInspectionSession,
  type PageWebContentsLike,
  type SelectionEventPayload,
} from "./PageInspectionService";

/** Controller 外部依赖（装配处注入；测试可全 mock） */
export interface CaptureModeDeps {
  /** NativeSurface blocker（capture-mode-transition，§76 token） */
  addBlocker(token: string): void;
  removeBlocker(token: string): void;
  /** 当前 WCV 的 webContents（PageInspectionService 统一底层；null = 无 WCV） */
  getWebContents(): PageWebContentsLike | null;
  /** Domain 版本（ArtifactService.get(id).version） */
  getArtifactVersion(artifactId: string): number | null;
  /** 当前 surface generation（NativeSurfaceCoordinator） */
  getSurfaceGeneration(): number;
  /**
   * surface 变化订阅（4C 主动退出防御）：装配处传 coordinator.onSurfaceChanged。
   * artifact 切换/重载/close 时立即退出 Capture Mode（绝不继续 inspect 旧 WCV）。
   */
  onSurfaceChanged?(listener: (info: { generation: number; artifactId: string | null; reason: string }) => void): () => void;
}

export type CaptureModeState =
  | "idle"
  | "entering"
  | "active"
  | "exited"
  | "error";

export interface CaptureModeControllerCallbacks {
  onStateChange(state: CaptureModeState, artifactId?: string, error?: string): void;
  onSelection(descriptor: SelectionDescriptor): void;
}

const BLOCKER_CAPTURE_MODE = "capture-mode-transition";

export class CaptureModeController {
  private state: CaptureModeState = "idle";
  private sessionSeq = 0;
  private unsubSurface: (() => void) | null = null;
  /** 当前激活的 inspector session（PageInspectionService 唯一底层；null = 未激活） */
  private inspector: PageInspectionSession | null = null;
  private sessionId: number | null = null;
  private sessionArtifactId = "";
  private sessionArtifactVersion = -1;
  private sessionSurfaceGeneration = 0;

  constructor(
    private readonly deps: CaptureModeDeps,
    private readonly callbacks: CaptureModeControllerCallbacks,
  ) {}

  get currentState(): CaptureModeState {
    return this.state;
  }

  /** 是否处于 Capture Mode（entering/active 都算） */
  get isActive(): boolean {
    return this.state === "entering" || this.state === "active";
  }

  /**
   * 进入 Capture Mode（§4C 路径）。重复进入：先完整退出旧 session（幂等安全）。
   * attach 失败（DevTools 冲突等）→ error state + 解除 blocker（§36 非致命）。
   */
  async enter(artifactId: string): Promise<void> {
    if (this.state === "entering") return; // 已在途
    if (this.state === "active" && this.sessionId != null && this.sessionArtifactId === artifactId) {
      return; // 幂等
    }

    // 事故 1：重复进入 → 先完整退出旧 session
    this.exitInternal();

    const wc = this.deps.getWebContents();
    if (!wc) {
      this.setState("error", artifactId, "无可用 WebContentsView（未打开 HTML 产物）");
      return;
    }

    this.deps.addBlocker(BLOCKER_CAPTURE_MODE);
    this.setState("entering", artifactId);

    const sessionId = ++this.sessionSeq;
    this.sessionId = sessionId;
    this.sessionArtifactId = artifactId;
    this.sessionArtifactVersion = this.deps.getArtifactVersion(artifactId) ?? -1;
    this.sessionSurfaceGeneration = this.deps.getSurfaceGeneration();

    // 唯一底层：PageInspectionService.acquire（同 wc 幂等复用；防双 attach）
    const inspector = pageInspectionService.acquire(wc, "capture-mode");
    inspector.onSelection = (payload) => this.handleSelection(payload);
    inspector.onInspectModeCanceled = () => this.handleInspectModeCanceled();
    inspector.onDetached = (reason) => this.handleDetached(reason);
    this.inspector = inspector;

    try {
      await inspector.attach(wc.debugger);
      await inspector.setInspectMode();
    } catch (error) {
      // 事故 4：attach 失败（DevTools 冲突 / target 异常）→ 非致命 error
      pageInspectionService.release(wc, "capture-mode");
      this.inspector = null;
      this.deps.removeBlocker(BLOCKER_CAPTURE_MODE);
      if (this.sessionId === sessionId) this.sessionId = null;
      this.setState(
        "error",
        artifactId,
        error instanceof Error ? error.message : "CDP attach 失败（DevTools 可能已打开）",
      );
      return;
    }

    // 就绪：解除过渡 blocker，恢复 WCV 显示
    this.deps.removeBlocker(BLOCKER_CAPTURE_MODE);
    // 主动退出防御：surface 变化（artifact 切换/重载/close）→ 立即退出（不继续 inspect 旧 WCV）
    this.unsubSurface = this.deps.onSurfaceChanged?.((info) => this.handleSurfaceChange(info)) ?? null;
    this.setState("active", artifactId);
  }

  /** 退出（严格幂等）：非激活状态不重复事件；关 inspect → release → 解除 blocker → exited */
  exit(): void {
    if (this.state !== "entering" && this.state !== "active") return;
    this.exitInternal();
    this.setState("exited");
  }

  /** 重新开启元素检查（用户取消后 / renderer 主动） */
  async startInspect(): Promise<void> {
    if (this.state !== "active" || !this.inspector) return;
    try {
      await this.inspector.setInspectMode();
    } catch {
      /* target 异常 → 由 detached 路径清理 */
    }
  }

  /** 停止元素检查（保持 attach，仅停止选取） */
  async stopInspect(): Promise<void> {
    if (this.state !== "active" || !this.inspector) return;
    await this.inspector.clearInspectMode();
  }

  /** 进程级销毁：一切清理，之后迟到事件忽略 */
  dispose(): void {
    this.exitInternal();
    this.sessionId = null;
    this.state = "idle";
  }

  // ---------- 内部 ----------

  private exitInternal(): void {
    const hadSession = this.sessionId != null || this.inspector != null;
    const wc = this.deps.getWebContents();
    if (this.inspector) {
      this.inspector.clearInspectMode().catch(() => undefined);
      this.inspector.detach();
      if (wc) pageInspectionService.release(wc, "capture-mode");
      this.inspector = null;
    }
    if (this.unsubSurface) {
      this.unsubSurface();
      this.unsubSurface = null;
    }
    if (hadSession) this.deps.removeBlocker(BLOCKER_CAPTURE_MODE);
    this.sessionId = null;
    this.sessionSeq += 1; // 使迟到事件的 session 校验失败
  }

  private setState(state: CaptureModeState, artifactId?: string, error?: string): void {
    this.state = state;
    this.callbacks.onStateChange(state, artifactId, error);
  }

  private async handleSelection(payload: SelectionEventPayload): Promise<void> {
    const sessionId = this.sessionId;
    if (sessionId == null) return; // 事故 5：已退出后的迟到事件
    // 事故 2：surface generation 变了（artifact 已切换）→ 静默退出，丢弃 selection
    if (this.deps.getSurfaceGeneration() !== this.sessionSurfaceGeneration) {
      this.exitInternal();
      this.setState("exited");
      return;
    }
    const descriptor: SelectionDescriptor = {
      artifactId: this.sessionArtifactId,
      artifactVersion: this.sessionArtifactVersion,
      surfaceGeneration: this.sessionSurfaceGeneration,
      nodeId: payload.nodeId,
      backendNodeId: payload.backendNodeId,
      tagName: payload.tagName,
      id: payload.id,
      classNames: payload.classNames,
      selector: payload.selector,
      text: payload.text,
      bounds: payload.bounds,
    };
    const inspector = this.inspector;
    await inspector?.clearInspectMode();
    if (sessionId !== this.sessionId || this.state !== "active") return;
    if (payload.backendNodeId != null) await inspector?.highlightNode(payload.backendNodeId).catch(() => undefined);
    if (sessionId !== this.sessionId || this.state !== "active") return;
    this.callbacks.onSelection(descriptor);
  }

  private handleInspectModeCanceled(): void {
    // 用户 Esc 取消：仍在 Capture Mode，保持 attach；MVP 不自动重启（renderer 可 startInspect）
    this.setState("active");
  }

  private handleDetached(reason: string): void {
    // 事故 3：WCV destroy / DevTools 打开 → 静默清理，不抛异常
    const wasActive = this.state === "active" || this.state === "entering";
    this.exitInternal();
    if (wasActive) {
      this.setState("exited", undefined, reason === "target_closed" ? undefined : `Capture Mode 已退出（${reason}）`);
    }
  }

  /** surface 变化主动退出（artifact 切换/重载/close 时立即 detach，4C 防御） */
  private handleSurfaceChange(info: { generation: number; artifactId: string | null; reason: string }): void {
    if (this.state !== "active" || this.sessionId == null) return;
    if (info.reason === "close" || info.reason === "dispose") {
      this.exitInternal();
      this.setState("exited");
      return;
    }
    if (info.artifactId !== null && info.artifactId !== this.sessionArtifactId) {
      this.exitInternal();
      this.setState("exited");
      return;
    }
    if (info.generation !== this.sessionSurfaceGeneration) {
      this.exitInternal();
      this.setState("exited");
    }
  }
}

