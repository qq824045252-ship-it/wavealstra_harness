import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, open, readFile, link, unlink, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { extractMessageHtml } from '../../shared/bot-message-html';
import type { BotMessageDto } from '../../shared/bot-conversation';
import type { MessageHtmlRequest, MessageHtmlArtifact } from '../../shared/saved-artifact';

export const messageHtmlRequestSchema = z.object({
  botId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200),
  messageId: z.string().min(1).max(200), index: z.number().int().min(0).max(31),
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();

/** Explicit user export only. The renderer supplies identity, never file content or paths. */
export class BotMessageHtmlService {
  constructor(private readonly storageRoot: string,
    private readonly load: (request: MessageHtmlRequest) => BotMessageDto) {}

  protected async writePending(handle: FileHandle, bytes: Buffer): Promise<void> {
    await handle.writeFile(bytes); await handle.sync();
  }

  async save(input: unknown): Promise<MessageHtmlArtifact> {
    const request = messageHtmlRequestSchema.parse(input);
    const message = this.load(request);
    if (message.botId !== request.botId || message.conversationId !== request.conversationId
      || message.messageId !== request.messageId || message.role !== 'assistant' || message.status !== 'completed'
      || (request.expectedRevision !== undefined && message.messageRevision !== request.expectedRevision))
      throw new Error('消息身份或版本已变化，请刷新后重试');
    const document = extractMessageHtml(message.text)[request.index];
    if (!document) throw new Error('该消息没有完整可保存的 HTML，不能从截断文本生成文件');
    const bytes = Buffer.from(document.source, 'utf8');
    if (bytes.length > 8 * 1024 * 1024) throw new Error('HTML 超过 8 MiB 安全预览上限，请缩小文件后重试');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const identity = createHash('sha256').update(JSON.stringify(['bot-message-html', request.botId,
      request.conversationId, request.messageId])).digest('hex');
    const root = await realpath(this.storageRoot);
    let directory = root;
    for (const part of ['durable', identity, 'artifacts']) {
      directory = join(directory, part);
      await mkdir(directory).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== directory)
        throw new Error('消息保存目录不是独立应用目录');
    }
    const snapshotPath = join(directory, `${digest}.html`);
    // Never publish partial bytes under the immutable digest name. A crash may
    // leave only an unreferenced pending file; retry creates a fresh pending file.
    const pending = join(directory, `.pending-${randomUUID()}`);
    try {
      const handle = await open(pending, 'wx', 0o600);
      try { await this.writePending(handle, bytes); } finally { await handle.close(); }
      // link is exclusive (unlike rename, it cannot replace an existing snapshot).
      try { await link(pending, snapshotPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    let stat = await lstat(snapshotPath);
    if (!stat.isFile() || stat.isSymbolicLink() || await realpath(snapshotPath) !== snapshotPath
      || createHash('sha256').update(await readFile(snapshotPath)).digest('hex') !== digest)
      throw new Error('消息保存版本完整性校验失败');
    // Recover only our exact pending-name links after a crash between publication
    // and cleanup. Unknown hard links remain a rejection, never a blanket bypass.
    if (stat.nlink > 1) {
      const leftovers: string[] = [];
      for (const name of await readdir(directory)) {
        if (!/^\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name)) continue;
        const path = join(directory, name), item = await lstat(path);
        if (item.isFile() && !item.isSymbolicLink() && item.ino === stat.ino && item.dev === stat.dev) leftovers.push(path);
      }
      if (stat.nlink !== leftovers.length + 1) throw new Error('保存版本存在未知硬链接');
      for (const path of leftovers) await unlink(path);
      stat = await lstat(snapshotPath);
    }
    if (stat.nlink !== 1) throw new Error('保存版本存在未知硬链接');
    const current = this.load(request);
    if (current.text !== message.text || current.messageRevision !== message.messageRevision || current.status !== 'completed')
      throw new Error('保存期间消息已变化，请刷新重试');
    return { snapshotPath, name: `message-html-${request.index + 1}.html`, digest, sizeBytes: bytes.length };
  }
}
