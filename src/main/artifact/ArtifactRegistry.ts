/**
 * ArtifactRegistry — V3.5 Wave 2（§7）
 *
 * 不是第四份真相，只是 active runtime cache：
 * - fast lookup / task hydrate cache / version cache / runtime invalidation
 * - 任何丢失后必须可以完全从 ArtifactRepository 重建（§7）
 */
import type { ArtifactDescriptor } from "../../shared/artifact-types";

export class ArtifactRegistry {
  private byId = new Map<string, ArtifactDescriptor>();
  private byTask = new Map<string, Set<string>>();

  upsert(descriptor: ArtifactDescriptor): void {
    this.byId.set(descriptor.id, descriptor);
    let ids = this.byTask.get(descriptor.taskId);
    if (!ids) {
      ids = new Set();
      this.byTask.set(descriptor.taskId, ids);
    }
    ids.add(descriptor.id);
  }

  get(id: string): ArtifactDescriptor | undefined {
    return this.byId.get(id);
  }

  listByTask(taskId: string): ArtifactDescriptor[] {
    const ids = this.byTask.get(taskId);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)).filter((d): d is ArtifactDescriptor => d !== undefined);
  }

  remove(id: string): void {
    const d = this.byId.get(id);
    this.byId.delete(id);
    if (d) {
      const ids = this.byTask.get(d.taskId);
      ids?.delete(id);
      if (ids?.size === 0) this.byTask.delete(d.taskId);
    }
  }

  /** task 级缓存失效（hydrate 重建用） */
  invalidateTask(taskId: string): void {
    const ids = this.byTask.get(taskId);
    if (ids) {
      for (const id of ids) this.byId.delete(id);
      this.byTask.delete(taskId);
    }
  }

  /** 从 Repository 全量重建（启动 / 灾难恢复） */
  rebuild(all: ArtifactDescriptor[]): void {
    this.byId.clear();
    this.byTask.clear();
    for (const d of all) this.upsert(d);
  }

  clear(): void {
    this.byId.clear();
    this.byTask.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
