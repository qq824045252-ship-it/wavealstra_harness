/**
 * SelectionStore — V3.5 Wave 4D（§80）
 *
 * Selection 唯一真相源（main 侧）：
 *
 *   PageInspectionService → SelectionDescriptor → SelectionStore → active/stale/empty
 *
 * 当前高亮 selection 仍是单值；另外保留同一 surface 代次内的可信抓取记录，
 * 供一条聊天消息引用多个元素。surface/version 变化会使整组记录一起失效。
 *
 * 三个 action + validateAgainst：
 * - setSelection(descriptor)：更新当前选择，并累计同 surface 的可信抓取记录
 * - markStale(reason)：幂等（已 stale 不重复；empty 无操作）；不删除 descriptor
 * - clearSelection()：删除 descriptor → empty
 * - validateAgainst(...)：统一失效判断入口（事件方法内部调用）
 *
 * 事件接线（装配处调用）：
 * - onArtifactUpdated：artifact:updated → version 变化 → stale(artifact-version-changed)；
 *   只处理 selection 的 artifactId（旧 artifact 事件不误伤，§4D 边界）
 * - onArtifactRemoved：artifact 删除 → clear（其他 artifact 删除不影响）
 * - onSurfaceChanged：Coordinator generation 推进 → stale
 *   （load 换 artifact → artifact-changed；同 artifact 重载/reload →
 *   surface-generation-changed；close → surface-closed）
 *
 * 纯数据 store：绝不保存 webContents/debugger/CDP 对象/DOM handle（R16 机器锁）。
 * stale 判断只在本模块（R15 机器锁）；Capture Mode 退出不清 selection（4E 依赖）。
 */
import type { ArtifactRemovedEvent, ArtifactUpdatedEvent } from "../../shared/artifact-types";
import type { SelectionDescriptor } from "../../shared/capture-mode";
import {
  EMPTY_SELECTION,
  selectionFingerprintMatches,
  type ChatSelectionRef,
  type SelectionStaleReason,
  type SelectionState,
} from "../../shared/selection";
import type { SurfaceChangeInfo } from "./NativeSurfaceCoordinator";

export class SelectionStore {
  private state: SelectionState = { ...EMPTY_SELECTION };

  /** 仅保留当前 artifact/version/surface 代次内的可信 descriptor。 */
  private readonly capturedSelections = new Map<string, SelectionDescriptor>();

  private listeners = new Set<(state: SelectionState) => void>();

  /** 订阅状态变化（装配处 → IPC 广播 / 测试断言） */
  onChange(listener: (state: SelectionState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): SelectionState {
    return this.state;
  }

  /** 解析 renderer 传回的轻量引用；正文仍只取 main 侧抓取记录。 */
  resolveSelection(ref: ChatSelectionRef): SelectionDescriptor | null {
    const descriptor = this.capturedSelections.get(this.selectionKey(ref));
    return descriptor && selectionFingerprintMatches(descriptor, ref) ? descriptor : null;
  }

  // ---------- Actions ----------

  /** 新选择：同一 surface 累计；页面/产物/代次不同则先淘汰旧记录。 */
  setSelection(descriptor: SelectionDescriptor): void {
    const previous = this.state.descriptor;
    if (
      previous &&
      (previous.artifactId !== descriptor.artifactId ||
        previous.artifactVersion !== descriptor.artifactVersion ||
        previous.surfaceGeneration !== descriptor.surfaceGeneration)
    ) {
      this.capturedSelections.clear();
    }
    this.capturedSelections.set(this.selectionKey(descriptor), descriptor);
    this.state = {
      descriptor,
      status: "active",
      updatedAt: Date.now(),
    };
    this.emit();
  }

  /** 幂等失效：已 stale 不重复；empty 无操作；保留 descriptor（可解释的 stale，不自动删） */
  markStale(reason: SelectionStaleReason): void {
    if (this.state.status === "empty" || this.state.status === "stale") return;
    this.capturedSelections.clear();
    this.state = {
      ...this.state,
      status: "stale",
      staleReason: reason,
      updatedAt: Date.now(),
    };
    this.emit();
  }

  /** 清除：删除 descriptor → empty */
  clearSelection(): void {
    if (this.state.status === "empty") return;
    this.capturedSelections.clear();
    this.state = { ...EMPTY_SELECTION, updatedAt: Date.now() };
    this.emit();
  }

  /**
   * 统一失效判断（事件方法内部调用；stale 逻辑只在本模块，R15）：
   * - surfaceGeneration 不一致 → stale（覆盖 reload/新 preview/WCV 替换）
   * - artifactId 与当前 surface 不一致 → stale(artifact-changed)（不 clear）
   * - artifactVersion 不一致 → stale(artifact-version-changed)
   */
  validateAgainst(input: {
    artifactId: string | null;
    artifactVersion?: number;
    surfaceGeneration: number;
    surfaceClosed?: boolean;
  }): void {
    const { descriptor } = this.state;
    if (this.state.status !== "active" || !descriptor) return;
    if (input.surfaceClosed) {
      this.markStale("surface-closed");
      return;
    }
    if (descriptor.surfaceGeneration !== input.surfaceGeneration) {
      this.markStale("surface-generation-changed");
      return;
    }
    if (input.artifactId !== null && descriptor.artifactId !== input.artifactId) {
      this.markStale("artifact-changed");
      return;
    }
    if (input.artifactVersion !== undefined && descriptor.artifactVersion !== input.artifactVersion) {
      this.markStale("artifact-version-changed");
      return;
    }
  }

  // ---------- 领域事件入口（装配处接线） ----------

  /** artifact:updated → 仅 selection 对应 artifact 的 version 变化才 stale（旧 artifact 不误伤） */
  onArtifactUpdated(event: ArtifactUpdatedEvent): void {
    const { descriptor } = this.state;
    if (this.state.status !== "active" || !descriptor) return;
    if (descriptor.artifactId !== event.artifactId) return; // 旧 artifact event 不误伤
    if (descriptor.artifactVersion !== event.version) {
      this.markStale("artifact-version-changed");
    }
  }

  /** artifact 删除 → 仅 selection 对应 artifact 删除才 clear */
  onArtifactRemoved(event: ArtifactRemovedEvent): void {
    const { descriptor } = this.state;
    if (this.state.status === "empty" || !descriptor) return;
    if (descriptor.artifactId === event.artifactId) {
      this.clearSelection();
    }
  }

  /** Coordinator generation 推进（load/reload/close）→ 按原因失效 */
  onSurfaceChanged(info: SurfaceChangeInfo): void {
    const { descriptor } = this.state;
    if (this.state.status !== "active" || !descriptor) return;
    if (info.reason === "close" || info.reason === "dispose") {
      this.markStale("surface-closed");
      return;
    }
    if (info.artifactId !== null && descriptor.artifactId !== info.artifactId) {
      this.markStale("artifact-changed");
      return;
    }
    if (descriptor.surfaceGeneration !== info.generation) {
      this.markStale("surface-generation-changed");
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(this.state);
      } catch (error) {
        console.error("[SelectionStore] listener 异常:", error);
      }
    }
  }

  private selectionKey(ref: ChatSelectionRef | SelectionDescriptor): string {
    return [
      ref.artifactId,
      ref.artifactVersion,
      ref.surfaceGeneration,
      ref.backendNodeId ?? "none",
    ].join(":");
  }
}

