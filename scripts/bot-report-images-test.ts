import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { mock } from "node:test";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { BotReportImageService } from "../src/main/agent/work/BotReportImageService";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-report-images-"));
const cwd = join(root, "workspace 中文"); mkdirSync(cwd);
const imagePath = join(cwd, "报告 截图.png");
const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH7sAAAAASUVORK5CYII=", "base64");
writeFileSync(imagePath, bytes);
writeFileSync(join(cwd, "capture(1).png"), bytes);
writeFileSync(join(root, "outside.png"), bytes);
writeFileSync(join(cwd, "invalid.png"), "not an image");
const db = new AppDatabase(join(root, "test.db"));
try {
  const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots, isAuthority: () => true });
  const messages = new BotConversationRepository(db.connection);
  let artifacts = new ArtifactService(new ArtifactStorage(join(root, "artifacts")), new ArtifactRepository(db.connection), new ArtifactRegistry());
  let images = new BotReportImageService(db.connection, LOCAL_USER_ID, works, () => artifacts);
  const send = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "origin", text: "report" });
  messages.update(send.assistantMessageId, "completed", "accepted");
  const result = works.createWork({ kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS }, {
    operationId: "create", title: "report", ownerBotId: DEFAULT_BOT_ID, inputSnapshotId: "input",
    authorization: DESKTOP_USER_GRANTS, criteria: [{ id: "criterion", text: "review" }],
    conversationId: send.conversationId, sourceMessageId: send.userMessageId,
  });
  assert(result.ok); const work = result.work;
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, "origin")!, work.workId);
  const binding = { bindingId: "binding", workId: work.workId, operationId: "execute", botId: DEFAULT_BOT_ID,
    taskId: "report-task", durableStoreKey: "store", conversationId: "native", intentRevision: work.intentRevision,
    ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
    delegatedScope: [], workspaceBinding: cwd, status: "completed" as const, admittedAt: 1, settledAt: 2 };
  // URI destinations use forward separators; encoding Windows backslashes
  // produces C:%5C..., which is not a canonical absolute Markdown destination.
  const absolute = encodeURI(imagePath.split(sep).join("/")); const file = pathToFileURL(imagePath).href;
  const body = `![relative](<报告 截图.png>)\n![absolute](${absolute})\n![url](${file})\n![outside](../outside.png)\n![bad](invalid.png)\n![missing](missing.png)\n![parens](capture(1).png)\n![reference][proof]\n\n[proof]: capture(1).png`;
  works.repo.insertBinding({ ...binding, settlementNote: body });
  const feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => true });
  assert.equal(feedback.drain(), 1);
  const history = () => messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID });
  const report = history().messages.at(-1)!;
  assert.equal(artifacts.listByTask(binding.taskId).length, 0, "legacy report begins without artifacts");
  // Existing host messages gain metadata on recovery, without a schema reset or body rewrite.
  db.connection.exec("DELETE FROM bot_work_feedback");
  assert.equal(feedback.recover(), 0);
  assert.equal(history().messages.at(-1)?.text, report.text);
  const first = await images.hydrateHistory(history());
  const scope = first.messages.at(-1)!.reportImages!;
  assert.equal(scope.taskId, binding.taskId);
  assert.equal(scope.artifacts.length, 2, "relative/absolute/file URI aliases share one message snapshot");
  assert.equal(Object.keys(scope.sources).length, 4);
  assert.deepEqual(Object.keys(scope.sources).sort(), ["报告 截图.png", absolute, file, "capture(1).png"].sort(),
    "all four valid source aliases are retained while unsafe and missing paths are excluded");
  assert.equal(scope.sources[absolute], scope.sources["报告 截图.png"], "absolute alias resolves to the relative image snapshot");
  assert.equal(scope.sources[file], scope.sources["报告 截图.png"], "file URI resolves to the same image snapshot");
  assert.notEqual(scope.sources["capture(1).png"], scope.sources["报告 截图.png"], "parenthesized image retains its own snapshot");
  const descriptor = scope.artifacts[0]!;
  assert.equal(descriptor.source.type, "managed-content");
  assert.equal(descriptor.createdByMessageId, report.messageId);
  assert.deepEqual((await artifacts.readImageVariant(descriptor.id, "full"))?.data, bytes);
  assert((await artifacts.readContent(descriptor.id, { inline: true }))?.content.startsWith("mybuddy-artifact://"), "IPC never sends image base64");
  assert.equal(history().messages[1]!.reportImages, undefined);
  // Content persists independently of the original file and of registry/process caches.
  rmSync(imagePath);
  artifacts = new ArtifactService(new ArtifactStorage(join(root, "artifacts")), new ArtifactRepository(db.connection), new ArtifactRegistry());
  images = new BotReportImageService(db.connection, LOCAL_USER_ID, works, () => artifacts);
  const restored = (await images.hydrateHistory(history())).messages.at(-1)!.reportImages!;
  assert.equal(restored.artifacts[0]?.id, descriptor.id);
  assert.deepEqual((await artifacts.readImageVariant(descriptor.id, "full"))?.data, bytes);
  // A subsequent report at the same filename captures new bytes, never rewrites history.
  const changed = Buffer.concat([bytes, Buffer.from("new image version")]); writeFileSync(imagePath, changed);
  works.repo.insertBinding({ ...binding, bindingId: "binding-new", operationId: "execute-new", taskId: "new-task", settlementNote: body });
  const capturing = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => true,
    prepareImages: id => images.captureWork(id) });
  assert.equal(capturing.drain(), 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(artifacts.listByTask("new-task").length, 2, "new report snapshots without visiting the UI");
  const next = (await images.hydrateHistory(history())).messages.at(-1)!.reportImages!;
  assert.notEqual(next.artifacts[0]!.id, descriptor.id);
  assert.deepEqual((await artifacts.readImageVariant(next.artifacts[0]!.id, "full"))?.data, changed);
  assert.deepEqual((await artifacts.readImageVariant(descriptor.id, "full"))?.data, bytes);
  // Metadata cannot switch this Work report into another Work's binding.
  works.repo.insertBinding({ ...binding, bindingId: "mismatched", operationId: "mismatched", intentRevision: work.intentRevision + 1 });
  const origin = messages.workOrigin(LOCAL_USER_ID, work.workId)!;
  messages.appendWorkFeedback(origin, work.workId, "fake", "1", body, { workId: work.workId, eventId: "fake", kind: "binding",
    category: "result", executionId: "mismatched", intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId });
  assert.equal((await images.hydrateHistory(history())).messages.at(-1)!.reportImages, undefined);
  // Symlink/junction escape is denied on real filesystem paths. Windows directory junctions do not need symlink privileges.
  const escape = join(cwd, "escape");
  symlinkSync(root, escape, "junction");
  works.repo.insertBinding({ ...binding, bindingId: "escape", operationId: "escape", taskId: "escape-task", settlementNote: "![escaped](escape/outside.png)" });
  capturing.drain(); await images.captureWork(work.workId);
  assert.equal(artifacts.listByTask("escape-task").length, 0);
  if (process.platform !== "win32") {
    execFileSync("mkfifo", [join(cwd, "blocked.png")]);
    works.repo.insertBinding({ ...binding, bindingId: "fifo", operationId: "fifo", taskId: "fifo-task", settlementNote: "![fifo](blocked.png)" });
    feedback.drain();
    await images.captureWork(work.workId);
    assert.equal(artifacts.listByTask("fifo-task").length, 0, "nonregular files cannot block main-thread open");
  }
  // Concurrent history reads stay idempotent and do not mutate Work acceptance/version.
  const before = works.getWork(work.workId);
  await Promise.all([images.hydrateHistory(history()), images.hydrateHistory(history())]);
  assert.deepEqual(works.getWork(work.workId), before);
  assert.equal(artifacts.listByTask(binding.taskId).length, 2);
  // Hydration must consult fresh host state, not skip based on a stale DTO.
  const ordinary = messages.message(send.assistantMessageId)!;
  assert.equal(ordinary.workFeedback, undefined);
  const stale = { ...history(), messages: [ordinary] };
  const metadata = { workId: work.workId, eventId: "backfill", kind: "binding", category: "result",
    executionId: binding.bindingId, intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId };
  db.connection.prepare("INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)").run(ordinary.messageId, JSON.stringify(metadata));
  const emptyScope = (await images.hydrateHistory(stale)).messages[0].reportImages!;
  assert.equal(emptyScope.taskId, binding.taskId, "valid feedback without an image still returns its scope");
  assert.equal(emptyScope.artifacts.length, 0);
  messages.update(ordinary.messageId, "completed", body);
  const backfilled = (await images.hydrateHistory(stale)).messages[0];
  assert.equal(backfilled.text, ordinary.text, "hydration must not rewrite the supplied history body");
  assert.equal(backfilled.reportImages?.artifacts.length, 2, "fresh DB text/feedback wins over stale DTO metadata");
  const originalGetWork = works.getWork;
  works.getWork = id => { const value = originalGetWork.call(works, id); return value ? { ...value, userId: "other-user" } : value; };
  try { assert.equal((await images.hydrateHistory(stale)).messages[0].reportImages, undefined, "cached images do not bypass current Work ownership"); }
  finally { works.getWork = originalGetWork; }
  writeFileSync(join(cwd, "missing.png"), bytes);
  assert.equal((await images.hydrateHistory(stale)).messages[0].reportImages?.artifacts.length, 3, "missing images are retried, not negatively cached");
  const advertised = { ...stale, messages: [messages.message(ordinary.messageId)!] };
  db.connection.prepare("DELETE FROM bot_work_feedback WHERE message_id=?").run(ordinary.messageId);
  assert.equal((await images.hydrateHistory(advertised)).messages[0].reportImages, undefined, "stale advertised feedback cannot restore removed authorization");
  // The specialized reader is exactly the ordinary mapper on eligible rows.
  const rows = db.connection.prepare(`SELECT m.message_id,m.role,EXISTS(SELECT 1 FROM bot_work_feedback f WHERE f.message_id=m.message_id) AS feedback
    FROM bot_messages m`).all() as { message_id: string; role: string; feedback: number }[];
  for (const row of rows) assert.deepEqual(messages.messageWithWorkFeedback(row.message_id),
    row.role === "assistant" && row.feedback ? messages.message(row.message_id) : undefined);
  assert.equal(messages.messageWithWorkFeedback("missing-message"), undefined);
  console.log("PASS bot report images: old/new reports, exact binding, aliases, immutable recovery, boundaries, stale DTO/backfill, fresh scope and IPC");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }

// Run the actual image service behind Work feedback. Its best-effort history
// reader must not silently acknowledge a transient background snapshot failure.
for (const fault of ["registration", "missing", "partial", "partial-header", "partial-body", "service-unavailable"]) {
  const retryRoot = mkdtempSync(join(tmpdir(), "bot-report-image-retry-"));
  const retryDb = new AppDatabase(join(retryRoot, "test.db"));
  let feedback: WorkConversationFeedback | undefined;
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const bots = new BotRegistry(retryDb.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
    const works = new WorkService(retryDb.connection, { bots });
    const messages = new BotConversationRepository(retryDb.connection);
    const storage = new ArtifactStorage(join(retryRoot, "artifacts"));
    const artifacts = new ArtifactService(storage, new ArtifactRepository(retryDb.connection), new ArtifactRegistry());
    let serviceUnavailable = fault === "service-unavailable";
    const images = new BotReportImageService(retryDb.connection, LOCAL_USER_ID, works, () => serviceUnavailable ? null : artifacts);
    const source = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "retry-source", text: "截图成果" });
    messages.update(source.assistantMessageId, "completed", "已受理");
    const created = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS },
      { operationId: "retry-work", title: "截图成果", conversationId: source.conversationId, sourceMessageId: source.userMessageId });
    assert(created.ok); const work = created.work;
    const imagePath = join(retryRoot, "retry.png");
    if (fault !== "missing") writeFileSync(imagePath, fault === "partial" ? Buffer.alloc(0)
      : fault === "partial-header" ? bytes.subarray(0, 4) : fault === "partial-body" ? bytes.subarray(0, bytes.length - 6) : bytes);
    let failRegistration = fault === "registration";
    const materialize = storage.materialize.bind(storage);
    mock.method(storage, "materialize", (...args: Parameters<ArtifactStorage["materialize"]>) => {
      if (failRegistration) throw Error("fixture artifact storage unavailable");
      return materialize(...args);
    });
    works.repo.insertBinding({ bindingId: "retry-binding", workId: work.workId, operationId: "retry-execution", botId: DEFAULT_BOT_ID,
      taskId: "retry-task", durableStoreKey: "store", conversationId: "native", intentRevision: work.intentRevision,
      ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, expertSnapshot: bots.activeSnapshot(DEFAULT_BOT_ID)!,
      delegatedScope: [], workspaceBinding: retryRoot, status: "completed", admittedAt: 1, settledAt: 2,
      settlementNote: "真实截图成果\n![proof](retry.png)" });
    feedback = new WorkConversationFeedback({ db: retryDb.connection, userId: LOCAL_USER_ID, works,
      isAuthority: () => true, prepareImages: id => images.captureWork(id) });
    assert.equal(feedback.drain(), 1);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(artifacts.listByTask("retry-task").length, 0);
    const history = () => messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId });
    const before = history().messages.map(message => [message.messageId, message.text]);
    const unchangedWork = works.getWork(work.workId);
    failRegistration = false;
    serviceUnavailable = false;
    writeFileSync(imagePath, bytes);
    mock.timers.tick(2_001);
    assert.equal(feedback.drain(), 0, "retry does not add a duplicate result message");
    await new Promise<void>(resolve => setImmediate(resolve));
    const saved = artifacts.listByTask("retry-task");
    assert.equal(saved.length, 1, `${fault} recovers through real image preparation without Work changes or a UI read`);
    assert.deepEqual((await artifacts.readImageVariant(saved[0]!.id, "full"))?.data, bytes);
    assert.deepEqual(history().messages.map(message => [message.messageId, message.text]), before);
    assert.deepEqual(works.getWork(work.workId), unchangedWork);
    const idle = mock.method(images, "captureWork");
    mock.timers.tick(2_001); feedback.drain();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(idle.mock.callCount(), 0, "successful image completion removes the retry candidate");
    idle.mock.restore();
    console.log(`PASS #34 real image service ${fault} failure recovers while Work remains unchanged`);
  } finally {
    feedback?.close(); mock.timers.reset(); mock.restoreAll();
    retryDb.close(); rmSync(retryRoot, { recursive: true, force: true });
  }
}
