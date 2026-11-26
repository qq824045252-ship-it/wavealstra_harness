import { lstatSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import { assertManagedWritePathSafe, atomicWriteFileSync, sha256File } from "./library-file-io";

export const NATIVE_LIBRARY_SAVE_MAX_BYTES = 4 * 1024 * 1024;

type Intent = {
  item_id: string;
  operation_id: string;
  path: string;
  old_content: Buffer | null;
  old_hash: string | null;
  new_hash: string;
  committed: number;
};

type Coordinator = {
  pending: Map<string, Promise<void>>;
};

const coordinators = new WeakMap<AppDatabase, Map<string, Coordinator>>();

export class LibraryTextSaves {
  readonly root: string;
  private readonly coordinator: Coordinator;

  constructor(private readonly db: AppDatabase, root: string) {
    this.root = resolve(root);
    const roots = coordinators.get(db) ?? new Map<string, Coordinator>();
    coordinators.set(db, roots);
    const existing = roots.get(this.root);
    this.coordinator = existing ?? { pending: new Map() };
    if (!existing) {
      roots.set(this.root, this.coordinator);
      this.recoverInterruptedSaves();
    }
  }

  enqueue<T>(id: string, save: () => Promise<T>): Promise<T> {
    const pending = this.coordinator.pending;
    const job = (pending.get(id) ?? Promise.resolve()).then(save);
    const settled = job.then(() => undefined, () => undefined).finally(() => {
      if (pending.get(id) === settled) pending.delete(id);
    });
    pending.set(id, settled);
    return job;
  }

  waitFor(id: string): Promise<void> | undefined {
    return this.coordinator.pending.get(id);
  }

  async flush(): Promise<void> {
    const pending = this.coordinator.pending;
    while (pending.size) await Promise.all(pending.values());
  }

  wasCommitted(id: string, operationId: string): boolean {
    return Boolean(this.db.connection.prepare(
      "SELECT 1 FROM library_text_saves WHERE item_id=? AND operation_id=? AND committed=1",
    ).get(id, operationId));
  }

  recoverItem(id: string): void {
    if (this.db.connection.readonly || this.db.runtimeAuditReader?.supervised) {
      const intent = this.db.connection.prepare(
        "SELECT * FROM library_text_saves WHERE item_id=? AND root=? AND committed=0",
      ).get(id, this.root) as Intent | undefined;
      if (intent) this.restore(intent);
      return;
    }
    this.db.connection.transaction(() => {
      const intent = this.db.connection.prepare(
        "SELECT * FROM library_text_saves WHERE item_id=? AND root=? AND committed=0",
      ).get(id, this.root) as Intent | undefined;
      if (intent) this.restore(intent);
    }).immediate();
  }

  private recoverInterruptedSaves(): void {
    const pending = this.db.connection.prepare(
      "SELECT item_id FROM library_text_saves WHERE root=? AND committed=0",
    ).all(this.root) as { item_id: string }[];
    for (const { item_id } of pending) {
      try { this.recoverItem(item_id); }
      catch (error) { console.warn("[Library] 无法恢复中断的笔记保存", item_id, error); }
    }
  }

  private restore(intent: Intent): void {
    const { path, old_content, old_hash, new_hash, operation_id, item_id } = intent;
    if (!/^[0-9a-f-]{36}$/i.test(operation_id)
      || (old_content && createHash("sha256").update(old_content).digest("hex")) !== old_hash) {
      throw new Error("笔记保存记录无效");
    }
    assertManagedWritePathSafe(this.root, path);
    let current: string | null;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > NATIVE_LIBRARY_SAVE_MAX_BYTES) throw new Error("当前笔记文件无法安全恢复");
      current = sha256File(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = null;
    }
    if (current !== old_hash) {
      if (current !== null && current !== new_hash) throw new Error("笔记文件在保存中断后已被修改");
      if (old_content === null) rmSync(path, { force: true });
      else atomicWriteFileSync(path, old_content);
    }
    rmSync(join(dirname(path), `.mybuddy-note-${operation_id}.tmp`), { force: true });
    if (this.db.connection.readonly || this.db.runtimeAuditReader?.supervised) {
      void this.db.runtimeAuditReader?.batch3Write({
        kind: "libraryDeleteTextSaveIntent",
        itemId: item_id,
        operationId: operation_id,
      }).catch((err) => console.warn("[Library] 清理笔记保存记录失败", err));
      return;
    }
    this.db.connection.prepare(
      "DELETE FROM library_text_saves WHERE item_id=? AND operation_id=? AND committed=0",
    ).run(item_id, operation_id);
  }
}
