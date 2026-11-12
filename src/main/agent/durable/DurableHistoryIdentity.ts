import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Storage } from "@earendil-works/pi-durable";
import { selectedDurableSqlite } from "./DurableStorageFormat";

const injectedIdentities = new WeakMap<Storage, string>();

/** A SQLite incarnation and branch survive viewer/runtime reopening, but not store replacement. */
export function durableHistoryIdentity(directory: string, conversationId: string, injectedStorage?: Storage): string {
  let store: string;
  if (injectedStorage) {
    store = injectedIdentities.get(injectedStorage) ?? randomUUID();
    injectedIdentities.set(injectedStorage, store);
  } else {
    const path = selectedDurableSqlite(directory);
    if (!path) throw new Error("历史存储不存在");
    const stat = statSync(path, { bigint: true });
    if (stat.ino === 0n) throw new Error("文件系统未提供可信的历史存储身份");
    store = `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
  }
  return createHash("sha256").update(JSON.stringify([store, conversationId])).digest("hex");
}
