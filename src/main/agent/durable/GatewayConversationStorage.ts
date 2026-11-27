import { lstatSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import type { AppDatabase } from "../../db/AppDatabase";
import { gatewayChannelDirectory } from "../../gateway/gateway-task-space";
import { claimDurableStorageLease } from "./DurableStorageLease";

/** Include archived and trashed conversations without opening them or changing their lifecycle. */
export function organizeGatewayConversationStores(db: AppDatabase, agentDir: string): void {
  const rows = db.connection.prepare(`SELECT b.task_id, b.directory, g.channel_id
    FROM durable_bot_bindings b JOIN gateway_sidebar_conversations g ON g.task_id = b.task_id`).all() as
    Array<{ task_id: string; directory: string; channel_id: string }>;
  for (const row of rows) {
    const digest = createHash("sha256").update(row.task_id).digest("hex");
    const original = resolve(agentDir, "durable", digest);
    if (resolve(row.directory) !== original) continue;
    try { gatewayConversationDirectory(db, row.task_id, row.channel_id, original, row.directory); }
    catch (error) { console.warn("[Gateway] 会话目录整理暂未完成，下次打开时重试", row.task_id, error); }
  }
}

/** A conversation's SQLite store lives inside its host-assigned channel space. */
export function gatewayConversationDirectory(db: AppDatabase, taskId: string, channelId: string,
  originalDirectory: string, previousDirectory?: string): string {
  const target = join(gatewayChannelDirectory(db, channelId, true), basename(originalDirectory));
  if (!previousDirectory || resolve(previousDirectory) === target) {
    const destination = lstatSync(target, { throwIfNoEntry: false });
    if (destination && !destination.isDirectory()) throw new Error("渠道会话目录无效");
    return target;
  }
  if (resolve(previousDirectory) !== resolve(originalDirectory)) throw new Error("渠道会话存储不属于原会话");
  if (db.connection.readonly) {
    throw new Error("渠道会话目录绑定需要通过主写入核心同步");
  }
  db.connection.transaction(() => {
    const destination = lstatSync(target, { throwIfNoEntry: false });
    if (destination && !destination.isDirectory()) throw new Error("渠道会话目录无效");
    const source = lstatSync(originalDirectory, { throwIfNoEntry: false });
    if (source) {
      if (!source.isDirectory() || destination) throw new Error("渠道会话目录冲突，保留原记录");
      // Serialize binding changes in app.db and verify the old native writer has released the store.
      claimDurableStorageLease(originalDirectory).release();
      renameSync(originalDirectory, target);
    } else if (!destination || !lstatSync(target, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("原渠道会话记录缺失");
    }
    // If the process exited after rename, only the destination exists. Finish that same move.
    db.connection.prepare("UPDATE durable_bot_bindings SET directory = ? WHERE task_id = ? AND directory = ?")
      .run(target, taskId, previousDirectory);
  }).immediate();
  return target;
}
