import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import type { BotHistoryDto, BotMessageDto, BotReportImages } from "../../../shared/bot-conversation";
import { markdownImageSources } from "../../../shared/markdown-images";
import type { ArtifactService } from "../../artifact/ArtifactService";
import { assertPathInsideTask, isPathInsideOrEqual } from "../../task/TaskExecutionWorkspace";
import { BotConversationRepository } from "./BotConversationRepository";
import type { WorkService } from "./WorkService";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_REPORT_IMAGES = 32;
export type BotReportImagePreparation = "complete" | "retry";
type ImageCapture = { preparation: BotReportImagePreparation; images: BotReportImages | undefined };
type ReportImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
function imageMime(bytes: Buffer): ReportImageMime | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/** Do not freeze a writer's truncated file into an immutable report snapshot. */
function completeImage(bytes: Buffer, mimeType: ReportImageMime): boolean {
  if (mimeType === "image/png") {
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const end = offset + 12 + bytes.readUInt32BE(offset);
      if (end > bytes.length) return false;
      if (bytes.toString("ascii", offset + 4, offset + 8) === "IEND") return true;
      offset = end;
    }
    return false;
  }
  if (mimeType === "image/jpeg") return bytes.indexOf(Buffer.from([255, 217]), 2) !== -1;
  if (mimeType === "image/gif") return bytes.at(-1) === 0x3b;
  if (mimeType === "image/webp") return bytes.length >= bytes.readUInt32LE(4) + 8;
  const unhandled: never = mimeType;
  return unhandled;
}

/** Snapshot only references in an authenticated host feedback message. The
 * durable execution binding owns the filesystem scope, never the active Task,
 * mutable Work owner, model-supplied root, or a filename match in another task.
 * Existing reports recover lazily; fresh feedback captures before UI navigation.
 */
export class BotReportImageService {
  private readonly messages: BotConversationRepository;
  private readonly pending = new Map<string, Promise<ImageCapture>>();
  constructor(private readonly db: Database.Database, private readonly userId: string,
    private readonly works: WorkService, private readonly artifacts: () => ArtifactService | null) {
    this.messages = new BotConversationRepository(db);
  }

  async captureWork(workId: string): Promise<BotReportImagePreparation> {
    const origin = this.messages.workOrigin(this.userId, workId);
    if (!origin) return "complete";
    const rows = this.db.prepare(`SELECT m.message_id FROM bot_messages m JOIN bot_work_feedback f ON f.message_id=m.message_id
      WHERE m.conversation_id=? AND m.bot_id=? AND json_extract(f.metadata_json,'$.workId')=?`)
      .all(origin.conversation_id, origin.bot_id, workId) as { message_id: string }[];
    let preparation: BotReportImagePreparation = "complete";
    for (const row of rows) if ((await this.capture(row.message_id)).preparation === "retry") preparation = "retry";
    return preparation;
  }

  async hydrateHistory(history: BotHistoryDto): Promise<BotHistoryDto> {
    const messages: BotMessageDto[] = [];
    for (const message of history.messages) {
      const { images: reportImages } = await this.capture(message.messageId);
      messages.push(reportImages ? { ...message, reportImages } : message);
    }
    return { ...history, messages };
  }

  private capture(messageId: string): Promise<ImageCapture> {
    const active = this.pending.get(messageId);
    if (active) return active;
    const operation = this.captureMessage(messageId).catch((error): ImageCapture => {
      console.warn("[Bot] 报告图片待恢复", messageId, error);
      return { preparation: "retry", images: undefined };
    }).finally(() => this.pending.delete(messageId));
    this.pending.set(messageId, operation);
    return operation;
  }

  private async captureMessage(messageId: string): Promise<ImageCapture> {
    if (this.db.inTransaction) throw new Error("报告图片读取必须在 Work 事务外执行");
    // Always reload host-authored metadata. Renderer input cannot supply binding/root.
    const message = this.messages.messageWithWorkFeedback(messageId);
    const feedback = message?.workFeedback;
    if (!message || message.role !== "assistant" || !feedback?.executionId
      || !["binding", "result"].includes(feedback.kind) || !message.workIds.includes(feedback.workId)) return { preparation: "complete", images: undefined };
    const work = this.works.getWork(feedback.workId);
    const origin = this.messages.workOrigin(this.userId, feedback.workId);
    const binding = this.works.repo.getBinding(feedback.executionId);
    if (!work || work.userId !== this.userId || !origin || origin.bot_id !== message.botId
      || origin.conversation_id !== message.conversationId || !binding || binding.workId !== work.workId
      || binding.intentRevision !== feedback.intentRevision || binding.inputSnapshotId !== feedback.inputSnapshotId
      || !isAbsolute(binding.workspaceBinding)) return { preparation: "complete", images: undefined };
    const scope: BotReportImages = { taskId: binding.taskId, artifacts: [], sources: Object.create(null) };
    let preparation: BotReportImagePreparation = "complete";
    for (const source of [...new Set(markdownImageSources(message.text))].slice(0, MAX_REPORT_IMAGES)) {
      let path: string;
      try { path = /^file:/i.test(source) ? fileURLToPath(source) : decodeURIComponent(source); }
      catch { continue; }
      if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) continue;
      if (!path || /[\0\r\n]/.test(path) || /^[/\\]{2}/.test(path)) continue;
      const target = resolve(binding.workspaceBinding, path);
      if (!isPathInsideOrEqual(binding.workspaceBinding, target)) continue;
      try {
        const service = this.artifacts();
        if (!service) { preparation = "retry"; continue; }
        // IDs deliberately include the message: later reports at the same path
        // must not replace bytes already displayed by historical reports.
        const id = `bot-report-${createHash("sha256").update(JSON.stringify([messageId, binding.bindingId, target])).digest("hex")}`;
        let descriptor = service.get(id);
        if (!descriptor) {
          const canonical = realpathSync.native(target);
          try { assertPathInsideTask(binding.workspaceBinding, canonical); }
          catch { continue; }
          const prior = lstatSync(canonical);
          if (!prior.isFile()) continue;
          const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes: Buffer;
          try {
            const before = fstatSync(fd);
            if (!before.isFile() || before.size > MAX_IMAGE_BYTES) continue;
            if (before.dev !== prior.dev || before.ino !== prior.ino || before.size <= 0) { preparation = "retry"; continue; }
            bytes = Buffer.alloc(before.size);
            let offset = 0;
            while (offset < bytes.length) {
              const size = readSync(fd, bytes, offset, bytes.length - offset, offset);
              if (!size) break;
              offset += size;
            }
            const after = fstatSync(fd);
            const current = lstatSync(canonical);
            if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs
              || before.ctimeMs !== after.ctimeMs || !current.isFile() || current.dev !== before.dev || current.ino !== before.ino
              || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs
              || realpathSync.native(target) !== canonical) { preparation = "retry"; continue; }
            try { assertPathInsideTask(binding.workspaceBinding, target); }
            catch { continue; }
          } finally { closeSync(fd); }
          const mimeType = imageMime(bytes);
          if (!mimeType) {
            // A writer may have published only a prefix of a known image header.
            if ([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from([255, 216, 255]),
              Buffer.from("GIF87a"), Buffer.from("GIF89a")]
              .some(header => bytes.length < header.length && bytes.equals(header.subarray(0, bytes.length)))
              || bytes.length < 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF").subarray(0, Math.min(4, bytes.length)))) preparation = "retry";
            continue;
          }
          if (!completeImage(bytes, mimeType)) { preparation = "retry"; continue; }
          descriptor = await service.register({ id, taskId: binding.taskId, kind: "image", mimeType,
            title: basename(target), producerMessageId: messageId,
            capabilities: { botReportExecutionId: binding.bindingId, botReportSourcePath: target },
            content: `data:${mimeType};base64,${bytes.toString("base64")}` });
        }
        if (descriptor.taskId !== binding.taskId || descriptor.createdByMessageId !== messageId
          || descriptor.capabilities.botReportExecutionId !== binding.bindingId) continue;
        if (!scope.artifacts.some(item => item.id === descriptor.id)) scope.artifacts.push(descriptor);
        scope.sources[source] = descriptor.id;
      } catch { preparation = "retry"; }
    }
    return { preparation, images: scope };
  }
}
