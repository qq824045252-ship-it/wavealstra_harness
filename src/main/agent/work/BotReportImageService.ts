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
function imageMime(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

/** Snapshot only references in an authenticated host feedback message. The
 * durable execution binding owns the filesystem scope, never the active Task,
 * mutable Work owner, model-supplied root, or a filename match in another task.
 * Existing reports recover lazily; fresh feedback captures before UI navigation.
 */
export class BotReportImageService {
  private readonly messages: BotConversationRepository;
  private readonly pending = new Map<string, Promise<BotReportImages | undefined>>();
  constructor(private readonly db: Database.Database, private readonly userId: string,
    private readonly works: WorkService, private readonly artifacts: () => ArtifactService | null) {
    this.messages = new BotConversationRepository(db);
  }

  async captureWork(workId: string): Promise<void> {
    const origin = this.messages.workOrigin(this.userId, workId);
    if (!origin) return;
    const rows = this.db.prepare(`SELECT m.message_id FROM bot_messages m JOIN bot_work_feedback f ON f.message_id=m.message_id
      WHERE m.conversation_id=? AND m.bot_id=? AND json_extract(f.metadata_json,'$.workId')=?`)
      .all(origin.conversation_id, origin.bot_id, workId) as { message_id: string }[];
    for (const row of rows) await this.capture(row.message_id);
  }

  async hydrateHistory(history: BotHistoryDto): Promise<BotHistoryDto> {
    const messages: BotMessageDto[] = [];
    for (const message of history.messages) {
      const reportImages = await this.capture(message.messageId);
      messages.push(reportImages ? { ...message, reportImages } : message);
    }
    return { ...history, messages };
  }

  private capture(messageId: string): Promise<BotReportImages | undefined> {
    const active = this.pending.get(messageId);
    if (active) return active;
    const operation = this.captureMessage(messageId).catch(error => {
      console.warn("[Bot] 报告图片待恢复", messageId, error);
      return undefined;
    }).finally(() => this.pending.delete(messageId));
    this.pending.set(messageId, operation);
    return operation;
  }

  private async captureMessage(messageId: string): Promise<BotReportImages | undefined> {
    const service = this.artifacts();
    if (!service) return undefined;
    if (this.db.inTransaction) throw new Error("报告图片读取必须在 Work 事务外执行");
    // Always reload host-authored metadata. Renderer input cannot supply binding/root.
    const message = this.messages.messageWithWorkFeedback(messageId);
    const feedback = message?.workFeedback;
    if (!message || message.role !== "assistant" || !feedback?.executionId
      || !["binding", "result"].includes(feedback.kind) || !message.workIds.includes(feedback.workId)) return undefined;
    const work = this.works.getWork(feedback.workId);
    const origin = this.messages.workOrigin(this.userId, feedback.workId);
    const binding = this.works.repo.getBinding(feedback.executionId);
    if (!work || work.userId !== this.userId || !origin || origin.bot_id !== message.botId
      || origin.conversation_id !== message.conversationId || !binding || binding.workId !== work.workId
      || binding.intentRevision !== feedback.intentRevision || binding.inputSnapshotId !== feedback.inputSnapshotId
      || !isAbsolute(binding.workspaceBinding)) return undefined;
    const scope: BotReportImages = { taskId: binding.taskId, artifacts: [], sources: Object.create(null) };
    for (const source of [...new Set(markdownImageSources(message.text))].slice(0, MAX_REPORT_IMAGES)) {
      try {
        if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^(?:file:|[a-z]:[\\/])/i.test(source)) continue;
        const path = /^file:/i.test(source) ? fileURLToPath(source) : decodeURIComponent(source);
        if (!path || /[\0\r\n]/.test(path) || /^[/\\]{2}/.test(path)) continue;
        const target = resolve(binding.workspaceBinding, path);
        if (!isPathInsideOrEqual(binding.workspaceBinding, target)) continue;
        // IDs deliberately include the message: later reports at the same path
        // must not replace bytes already displayed by historical reports.
        const id = `bot-report-${createHash("sha256").update(JSON.stringify([messageId, binding.bindingId, target])).digest("hex")}`;
        let descriptor = service.get(id);
        if (!descriptor) {
          const canonical = realpathSync.native(target);
          assertPathInsideTask(binding.workspaceBinding, canonical);
          const prior = lstatSync(canonical);
          if (!prior.isFile()) continue;
          const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          let bytes: Buffer;
          try {
            const before = fstatSync(fd);
            if (!before.isFile() || before.dev !== prior.dev || before.ino !== prior.ino || before.size <= 0 || before.size > MAX_IMAGE_BYTES) continue;
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
              || realpathSync.native(target) !== canonical) continue;
            assertPathInsideTask(binding.workspaceBinding, target);
          } finally { closeSync(fd); }
          const mimeType = imageMime(bytes);
          if (!mimeType) continue;
          descriptor = await service.register({ id, taskId: binding.taskId, kind: "image", mimeType,
            title: basename(target), producerMessageId: messageId,
            capabilities: { botReportExecutionId: binding.bindingId, botReportSourcePath: target },
            content: `data:${mimeType};base64,${bytes.toString("base64")}` });
        }
        if (descriptor.taskId !== binding.taskId || descriptor.createdByMessageId !== messageId
          || descriptor.capabilities.botReportExecutionId !== binding.bindingId) continue;
        if (!scope.artifacts.some(item => item.id === descriptor.id)) scope.artifacts.push(descriptor);
        scope.sources[source] = descriptor.id;
      } catch { /* A missing/unsafe image must not hide the rest of a report. Retry on the next read. */ }
    }
    return scope;
  }
}
