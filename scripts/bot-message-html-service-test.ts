import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, link, unlink, access, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { BotConversationRepository } from '../src/main/agent/work/BotConversationRepository';
import { BotConversationService } from '../src/main/agent/work/BotConversationService';
import { BotMessageHtmlService } from '../src/main/artifact/BotMessageHtmlService';
import { SavedArtifactActions } from '../src/main/artifact/SavedArtifactActions';
import { DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { LOCAL_USER_ID } from '../src/shared/bot-work';

const root = await mkdtemp(join(tmpdir(), 'message-html-test-'));
const app = new AppDatabase(join(root, 'app.db'));
try {
  const db = app.connection, bots = new BotRegistry(db), messages = new BotConversationRepository(db);
  bots.registerBot({ botId: 'a', userId: LOCAL_USER_ID, displayName: 'A', authorization: DESKTOP_USER_GRANTS });
  bots.registerBot({ botId: 'foreign', userId: 'another-user', displayName: 'Foreign', authorization: DESKTOP_USER_GRANTS });
  // Exercise the production authorization method with real repositories, no model/session side effects.
  const conversations = Object.assign(Object.create(BotConversationService.prototype),
    { options: { db, bots, userId: LOCAL_USER_ID, works: { teams: { foregroundTemplates: () => [] } } }, messages }) as BotConversationService;
  const receipt = messages.accept(LOCAL_USER_ID, { botId: 'a', requestId: 'html', text: 'Make HTML' });
  const html = '<!doctype html>\r\n<html><body>' + '真实原文'.repeat(10000) + '</body></html>\r\n';
  const original = '说明\r\n```html\r\n' + html + '```\r\n结束';
  messages.update(receipt.assistantMessageId, 'completed', original);
  const message = messages.message(receipt.assistantMessageId)!;
  const request = { botId: 'a', conversationId: receipt.conversationId, messageId: receipt.assistantMessageId, index: 0, expectedRevision: message.messageRevision };
  const service = new BotMessageHtmlService(root, input => conversations.messageForHtmlExport(input));
  const saved = await service.save(request);
  assert.equal(await readFile(saved.snapshotPath, 'utf8'), html);
  assert.equal(saved.sizeBytes, Buffer.byteLength(html));
  assert.equal((await service.save(request)).snapshotPath, saved.snapshotPath);
  assert.equal(messages.message(receipt.assistantMessageId)!.text, original);
  for (const change of [{ botId: 'foreign' }, { conversationId: 'other' }, { messageId: receipt.userMessageId },
    { index: 1 }, { expectedRevision: (message.messageRevision ?? 0) + 1 }, { text: '<html>spoof</html>' }]) {
    await assert.rejects(service.save({ ...request, ...change }));
  }
  const actions = new SavedArtifactActions({ storageRoot: root, exportRoot: join(root, 'exports'),
    chooseDestination: async () => join(root, '..', 'not-used'), openPath: async () => '' });
  // Validated existing action accepts the generated immutable snapshot. No external application is launched.
  await actions.openSystem(saved);
  const huge = '<html>' + '汉'.repeat(3 * 1024 * 1024) + '</html>';
  messages.update(receipt.assistantMessageId, 'completed', huge);
  await assert.rejects(service.save({ ...request, expectedRevision: undefined }), /8 MiB/);
  const retryHtml = '<html>interrupted publication</html>';
  messages.update(receipt.assistantMessageId, 'completed', retryHtml);
  let interrupt = true;
  class Interrupted extends BotMessageHtmlService {
    protected override async writePending(handle: FileHandle, bytes: Buffer) {
      if (interrupt) { await handle.writeFile(bytes.subarray(0, 10)); throw new Error('injected write interruption'); }
      await super.writePending(handle, bytes);
    }
  }
  const interrupted = new Interrupted(root, input => conversations.messageForHtmlExport(input));
  await assert.rejects(interrupted.save({ ...request, expectedRevision: undefined }), /injected/);
  interrupt = false;
  const retried = await interrupted.save({ ...request, expectedRevision: undefined });
  assert.equal(await readFile(retried.snapshotPath, 'utf8'), retryHtml);
  const crashLink = join(dirname(retried.snapshotPath), '.pending-11111111-1111-4111-8111-111111111111');
  await link(retried.snapshotPath, crashLink);
  assert.equal((await interrupted.save({ ...request, expectedRevision: undefined })).snapshotPath, retried.snapshotPath);
  await assert.rejects(access(crashLink));
  const unknownLink = join(root, 'unknown-link.html');
  await link(retried.snapshotPath, unknownLink);
  await assert.rejects(interrupted.save({ ...request, expectedRevision: undefined }), /未知硬链接/);
  await access(unknownLink);
  await unlink(unknownLink);
  messages.update(receipt.assistantMessageId, 'completed', original);
  db.prepare("UPDATE bot_conversations SET source_kind='peer' WHERE conversation_id=?").run(receipt.conversationId);
  await assert.rejects(service.save({ ...request, expectedRevision: undefined }));
  db.prepare("UPDATE bot_conversations SET source_kind='user' WHERE conversation_id=?").run(receipt.conversationId);
  messages.update(receipt.assistantMessageId, 'running', original);
  await assert.rejects(service.save({ ...request, expectedRevision: undefined }));
  messages.update(receipt.assistantMessageId, 'completed', original);
  await writeFile(saved.snapshotPath, 'tampered');
  await assert.rejects(service.save({ ...request, expectedRevision: undefined }), /完整性/);
  assert.equal(await readFile(saved.snapshotPath, 'utf8'), 'tampered', 'never overwrite existing data');
  console.log('PASS message HTML: persisted identity, full >16K CRLF bytes, original unchanged, revision/scope/role/state fences, retry, immutable snapshot, existing action integration and tamper rejection');
} finally { app.close(); await rm(root, { recursive: true, force: true }); }
