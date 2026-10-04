/**
 * NativeSurfaceCoordinator — V3.5 Wave 4A（§75-77）
 *
 * 唯一 visibility/bounds 决策层：
 *
 *   Renderer intent
 *     ↓ requestBounds / requestVisible / addBlocker / removeBlocker
 *   NativeSurfaceCoordinator
 *     ↓ show / hide / setBounds / preview / close / reload
 *   ArtifactPreviewHost
 *     ↓ setBounds / setVisible / loadURL / destroy
 *   WebContentsView
 *
 * 业务组件不再直接调用 artifact.hide/show/setRect（§75）；WCV 的
 * setBounds/setVisible 只有 Coordinator → PreviewHost 这一条链能触发。
 *
 * 核心语义：
 * - desiredVisible × blockers（token 集合，§76）共同合成 effective visible；
 *   只有 blockers.size === 0 && desiredVisible === true && bounds 有效 才 setVisible(true)。
 *   blocker 用 token/reason 集合而非 boolean —— 多源同时要求隐藏时，
 *   删掉一个不能误显示其他源仍需要的 surface。
 * - generation：loadArtifact 每次 +1；在途加载完成时若 generation 已被
 *   更新的请求取代（或 surface 已 close/dispose），不得恢复显示
 *   （stale 请求不能复活 surface，§77 丢弃 stale generation）。
 * - close() 是面板级关闭：清 blockers、置 closed 标记，之后迟到的
 *   requestVisible(true)/requestBounds 不会让空 surface 复活；
 *   下一次 loadArtifact 显式重新激活。
 * - dispose() 是进程级销毁：之后一切请求被忽略。
 *
 * PreviewHost 保持哑 host：不持有 desiredVisible/blockers/任何业务状态。
 */
import type { Rectangle } from "electron";

import { ArtifactProtocol } from "./ArtifactProtocol";

/** 默认主产物 surface（多 surface 预留：surfaceId 走全链路参数） */
export const SURFACE_MAIN = "artifact-main";

/** blocker token 集合（§76 示例：modal/flyout/context-menu/command-palette/approval-dialog/transition/route） */
export const SurfaceBlockerToken = {
  routeTransition: "route-transition",
  modal: "modal",
  artifactSwitch: "artifact-switch",
  captureModeTransition: "capture-mode-transition",
} as const;
export type SurfaceBlockerToken = (typeof SurfaceBlockerToken)[keyof typeof SurfaceBlockerToken];

/** Coordinator 对 host 的最小依赖（测试可注入 mock，无需真实 Electron） */
export interface NativeSurfaceHost {
  load(url: string): Promise<void>;
  setBounds(rect: Rectangle): void;
  show(): void;
  hide(): void;
  reload(): void;
  /** 可选：旧 mock/旧 host 未实现时 Coordinator 回退到 reload() */
  hardReload?(): void;
  close(): void;
  dispose(): void;
}

export interface SurfaceRecord {
  surfaceId: string;
  artifactId: string | null;
  generation: number;
  requestedBounds: Rectangle | null;
  desiredVisible: boolean;
  blockers: Set<string>;
  actualVisible: boolean;
  /** close() 后置位：面板级关闭，迟到请求不复活；loadArtifact 重新激活 */
  closed: boolean;
  /** dispose() 后置位：进程级销毁，一切请求忽略 */
  destroyed: boolean;
}

/** surface 变化通知（4D SelectionStore 的 stale 事件源） */
export interface SurfaceChangeInfo {
  surfaceId: string;
  generation: number;
  artifactId: string | null;
  reason: "load" | "reload" | "close" | "dispose";
}

const MIN_DIMENSION = 8; // 与 PreviewHost.setBounds 防御一致：过小视为隐藏

export class NativeSurfaceCoordinator {
  private host: NativeSurfaceHost | null = null;
  private surfaces = new Map<string, SurfaceRecord>();
  private changeListeners = new Set<(info: SurfaceChangeInfo) => void>();

  constructor(host: NativeSurfaceHost | null = null) {
    this.host = host;
  }

  setHost(host: NativeSurfaceHost): void {
    this.host = host;
  }

  private get(surfaceId: string): SurfaceRecord {
    let s = this.surfaces.get(surfaceId);
    if (!s) {
      s = {
        surfaceId,
        artifactId: null,
        generation: 0,
        requestedBounds: null,
        desiredVisible: false,
        blockers: new Set(),
        actualVisible: false,
        closed: false,
        destroyed: false,
      };
      this.surfaces.set(surfaceId, s);
    }
    return s;
  }

  // ---------- Renderer intent（§75 API） ----------

  /** 上报宿主区域（DIP）；仅更新位置，显示与否由合成状态决定 */
  requestBounds(surfaceId: string, rect: Rectangle): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    s.requestedBounds = rect;
    this.apply(s);
  }

  /** 显式显示意图（挂载/展开时 true；面板关闭由 close() 处理） */
  requestVisible(surfaceId: string, visible: boolean): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    s.desiredVisible = visible;
    this.apply(s);
  }

  /** 加 blocker：任何来源需要 WCV 隐藏时登记 token（幂等） */
  addBlocker(surfaceId: string, token: string): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    s.blockers.add(token);
    this.apply(s);
  }

  /** 移除 blocker：只移除自己的 token，不影响其他来源（§76 多 blocker 语义） */
  removeBlocker(surfaceId: string, token: string): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    s.blockers.delete(token);
    this.apply(s);
  }

  /** 订阅 surface 变化（generation 每次推进都会通知；返回退订） */
  onSurfaceChanged(listener: (info: SurfaceChangeInfo) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notifyChange(info: SurfaceChangeInfo): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener(info);
      } catch (error) {
        console.error("[NativeSurface] change listener 异常:", error);
      }
    }
  }

  // ---------- Artifact 生命周期 ----------

  /**
   * 加载产物：URL 由 ArtifactProtocol 构造（PreviewHost 不知道 artifactId 解析，4B）；
   * 加载期间强制隐藏（artifact-switch blocker，§Gate：切换不闪旧 surface），
   * 加载完成/失败后若 generation 未被取代则恢复合成状态。
   */
  async loadArtifact(surfaceId: string, artifactId: string): Promise<void> {
    const s = this.get(surfaceId);
    if (s.destroyed || !this.host) return;
    s.artifactId = artifactId;
    s.closed = false; // loadArtifact = 显式重新激活
    const gen = ++s.generation;
    s.blockers.add(SurfaceBlockerToken.artifactSwitch);
    this.apply(s); // 立即隐藏（若当前可见）
    this.notifyChange({ surfaceId, generation: gen, artifactId, reason: "load" });
    try {
      await this.host.load(ArtifactProtocol.urlFor(artifactId));
    } catch (error) {
      console.error(`[NativeSurface] loadArtifact 失败 ${artifactId}:`, error);
    } finally {
      // 只有自己仍是最新一代才恢复显示；被取代/已 close/dispose 的加载不操作
      if (!s.destroyed && gen === s.generation) {
        s.blockers.delete(SurfaceBlockerToken.artifactSwitch);
        this.apply(s);
      }
    }
  }

  /**
   * 纯导航动作（§102 host 职责），不涉及显示决策；
   * 4D：reload 后 DOM 全量重建，generation 也推进（Selection 失效事件源）。
   */
  reload(surfaceId: string): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    const gen = ++s.generation;
    this.notifyChange({ surfaceId, generation: gen, artifactId: s.artifactId, reason: "reload" });
    this.host?.reload();
  }

  /**
   * 硬刷新（忽略缓存）：与 reload 同样推进 generation（Selection 失效事件源，4D）；
   * host 未实现 hardReload（旧 mock）时回退到 reload()，不抛错。
   */
  hardReload(surfaceId: string): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    const gen = ++s.generation;
    this.notifyChange({ surfaceId, generation: gen, artifactId: s.artifactId, reason: "reload" });
    if (typeof this.host?.hardReload === "function") this.host.hardReload();
    else this.host?.reload();
  }

  /** 面板级关闭：清 blockers、置 closed、弃置在途 generation；可被 loadArtifact 重新激活 */
  close(surfaceId: string): void {
    const s = this.get(surfaceId);
    if (s.destroyed) return;
    s.closed = true;
    s.artifactId = null;
    s.desiredVisible = false;
    s.blockers.clear();
    s.generation += 1; // 在途 load 的 finally 因 gen 过期而不操作
    this.notifyChange({ surfaceId, generation: s.generation, artifactId: null, reason: "close" });
    if (s.actualVisible) {
      s.actualVisible = false;
      this.host?.hide();
    }
    this.host?.close();
  }

  /** 进程级销毁：之后一切请求忽略（迟到 IPC 事件不能重建状态） */
  dispose(): void {
    for (const s of this.surfaces.values()) {
      s.destroyed = true;
      s.closed = true;
      s.actualVisible = false;
    }
    this.host?.dispose();
    this.host = null;
  }

  /** 当前 surface 状态快照（测试/诊断用） */
  getState(surfaceId: string): Readonly<SurfaceRecord> | null {
    return this.surfaces.get(surfaceId) ?? null;
  }

  // ---------- 合成 ----------

  /**
   * 唯一 apply 入口：
   * effective visible = !destroyed && !closed && desiredVisible && blockers.size === 0 && bounds 有效
   * 只有 visible 状态翻转时才调 show/hide（幂等）；bounds 每次跟随。
   */
  private apply(s: SurfaceRecord): void {
    if (!this.host || s.destroyed) return;
    if (s.closed) {
      if (s.actualVisible) {
        s.actualVisible = false;
        this.host.hide();
      }
      return;
    }
    const bounds = s.requestedBounds;
    const boundsValid = !!bounds && bounds.width >= MIN_DIMENSION && bounds.height >= MIN_DIMENSION;
    const visible = s.desiredVisible && s.blockers.size === 0 && boundsValid;
    if (visible !== s.actualVisible) {
      s.actualVisible = visible;
      if (visible) this.host.show();
      else this.host.hide();
    }
    if (bounds) this.host.setBounds(bounds);
  }
}
