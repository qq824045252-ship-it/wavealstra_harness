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
  private loadedTasks = new Set<string>();

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

  hasTask(taskId: string): boolean {
    return this.loadedTasks.has(taskId);
  }

  replaceTask(taskId: string, artifacts: ArtifactDescriptor[]): void {
    this.invalidateTask(taskId);
    for (const artifact of artifacts) this.upsert(artifact);
    this.loadedTasks.add(taskId);
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
    this.loadedTasks.delete(taskId);
    const ids = this.byTask.get(taskId);
    if (ids) {
      for (const id of ids) this.byId.delete(id);
      this.byTask.delete(taskId);
    }
  }

  /** 从 Repository 全量重建（启动 / 灾难恢复） */
  rebuild(all: ArtifactDescriptor[]): void {
    this.clear();
    for (const d of all) {
      this.upsert(d);
      this.loadedTasks.add(d.taskId);
    }
  }

  clear(): void {
    this.byId.clear();
    this.byTask.clear();
    this.loadedTasks.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
