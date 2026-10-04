/**
 * Code TS fixture — 语法高亮质量基线（V3.5 §28）。
 * 覆盖：接口、泛型、字面量类型、装饰器风格 JSDoc、async/await、模板字符串。
 */

import { EventEmitter } from "node:events";

export type ArtifactKind = "markdown" | "code" | "html" | "svg" | "image" | "pdf" | "office";
export type ArtifactSource =
  | { type: "workspace-file"; entryFile: string; rootDir: string }
  | { type: "managed-content"; storagePath: string; rootDir: string };

export interface ArtifactDescriptor<T extends object = Record<string, never>> {
  readonly id: string;
  readonly taskId: string;
  kind: ArtifactKind;
  source: ArtifactSource;
  version: number;
  metadata?: T;
}

export class ArtifactRegistry<T extends object = Record<string, never>> extends EventEmitter {
  private cache = new Map<string, ArtifactDescriptor<T>>();

  /** 注册运行时缓存；Registry 丢失必须可从 Repository 完全重建（V3.5 §7）。 */
  set(descriptor: ArtifactDescriptor<T>): void {
    this.cache.set(descriptor.id, { ...descriptor, version: descriptor.version + 1 });
    this.emit("artifact:updated", { artifactId: descriptor.id, version: descriptor.version + 1 });
  }

  async get(id: string): Promise<ArtifactDescriptor<T> | undefined> {
    return this.cache.get(id);
  }
}

const registry = new ArtifactRegistry<{ entryFile: string }>();

for (const [key, value] of Object.entries({ a: 1, b: 2 })) {
  if (value > 1) console.log(key);
}

const ids = new Set<string>();
const first: ArtifactDescriptor | undefined = [...registry.cache.values()][0];
if (first) ids.add(first.id);

async function main(): Promise<void> {
  const taskId = process.env.TASK_ID ?? "task-default";
  const results = await Promise.allSettled([
    registry.get(taskId),
    registry.get(`${taskId}-2`),
  ]);
  const ok = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled");
  console.log(`resolved ${ok.length}/${results.length}`, `template ${taskId}`);
}

void main();
