/**
 * Capture Mode 契约 — V3.5 Wave 4C（§78-82）/ 4D SelectionStore 前置
 *
 * SelectionDescriptor 是 4C 输出的稳定数据结构（4D stale 判断的输入）：
 * - artifactId + artifactVersion：Domain 侧身份；version 变化 → selection stale（§80）
 * - surfaceGeneration：NativeSurface 代次；loadArtifact 后变化 → selection stale
 * - backendNodeId：当前 CDP session 内的可信身份（MVP canonical identity）
 * - selector 仅辅助描述（§80：不追求永久稳定 CSS selector）
 */

export const CaptureModeIpc = {
  /** renderer → main：进入 Capture Mode（invoke；重复进入会先完整退出旧 session） */
  enter: "captureMode:enter",
  /** renderer → main：退出 Capture Mode（幂等） */
  exit: "captureMode:exit",
  /** renderer → main：开启元素检查模式（进入后自动开启；取消后可重新开启） */
  startInspect: "captureMode:startInspect",
  /** renderer → main：关闭元素检查模式（保持 attach，仅停止 hover/click 选取） */
  stopInspect: "captureMode:stopInspect",
} as const;

export type CaptureModeEnterRequest =
  | { target?: "artifact"; artifactId: string }
  | { target: "browser" };

export interface SelectionDescriptor {
  /** Domain 身份（4D stale 判断：version 变化 → stale） */
  artifactId: string;
  artifactVersion: number;
  /** NativeSurface 代次（4D stale 判断：generation 变化 → stale） */
  surfaceGeneration: number;

  /** 当前 CDP session 内可信身份（MVP canonical identity，§80） */
  nodeId?: number;
  backendNodeId?: number;

  /** DOM 描述（辅助，不作身份） */
  tagName: string;
  id?: string;
  classNames: string[];

  /** 辅助 selector：tag#id.class（不保证唯一/永久稳定，§80） */
  selector?: string;
  /** 元素文本（截断上限 TEXT_MAX，防点中 body 塞满页面） */
  text?: string;

  /** CSS 像素边界（DOM.getBoxModel 语义，§37 不乘 devicePixelRatio） */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

/** text 截断上限（§4C：2-4KB 建议 → 取 2048） */
export const SELECTION_TEXT_MAX = 2048;

export type CaptureModeState =
  | "idle" // 未进入
  | "entering" // attach/enable 进行中（transition blocker 生效）
  | "active" // 已进入，inspect 可用
  | "exited" // 已退出（事件通知用）
  | "error"; // 进入失败（Capture Mode unavailable，非致命，§36）

export interface CaptureModeStateEvent {
  state: CaptureModeState;
  artifactId?: string;
  error?: string;
}

/** main → renderer 事件通道名 */
export const CaptureModeEvent = {
  state: "captureMode:state",
} as const;
