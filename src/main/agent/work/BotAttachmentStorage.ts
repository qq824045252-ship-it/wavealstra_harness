import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { BotAttachmentDto } from "../../../shared/bot-conversation";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".heic"]);
/** Snapshot selected bytes, not a mutable reference to the original file. Call only for a new request. */
export function snapshotBotAttachments(directory: string, requestKey: string, attachments: readonly BotAttachmentDto[]): BotAttachmentDto[] {
  if (attachments.length > 10) throw new Error("每条消息最多添加 10 个附件");
  let total = 0;
  const snapshots = attachments.map(attachment => {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(attachment.path, constants.O_RDONLY | constants.O_NONBLOCK);
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) throw new Error("不是普通文件");
      const limit = IMAGE_EXTENSIONS.has(extname(attachment.path).toLowerCase()) ? 12 * 1024 * 1024 : 25 * 1024 * 1024;
      if (stat.size > limit) throw new Error(`超过 ${limit / 1024 / 1024} MB 限制`);
      total += stat.size;
      if (total > 50 * 1024 * 1024) throw new Error("本条消息附件合计超过 50 MB");
      const bytes = readFileSync(descriptor);
      if (bytes.length !== stat.size || bytes.length > limit) throw new Error("读取时文件发生变化，请重新添加");
      return { attachment, bytes, digest: createHash("sha256").update(bytes).digest("hex") };
    } catch (error) {
      throw new Error(`附件“${attachment.name}”不可用：${error instanceof Error ? error.message : String(error)}`);
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  });
  const root = join(directory, "attachments", createHash("sha256").update(requestKey).digest("hex"));
  if (snapshots.length) mkdirSync(root, { recursive: true });
  return snapshots.map(({ attachment, bytes, digest }) => {
    const name = basename(attachment.name).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-160) || "attachment";
    const path = join(root, `${digest}-${name}`);
    // Content-addressed filenames make retries stable, even if the source is later removed.
    writeFileSync(path, bytes, { mode: 0o600 });
    return { name: attachment.name, path };
  });
}
