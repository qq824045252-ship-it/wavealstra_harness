/** Synthetic, disk-backed host fixture. No live profile, model, scheduler or network. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotReportImageService } from "../src/main/agent/work/BotReportImageService";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
export { ArtifactProtocol } from "../src/main/artifact/ArtifactProtocol";
import type { BotHistoryRequest } from "../src/shared/bot-conversation";

type ImageReader = Pick<BotReportImageService, "hydrateHistory">;
type ImageConstructor = new (...args: ConstructorParameters<typeof BotReportImageService>) => ImageReader;
export function fixture(root: string, mixed: boolean, BaselineImages: ImageConstructor) {
  mkdirSync(root, { recursive: true });
  const app = new AppDatabase(join(root, "history.db")), db = app.connection;
  const bots = new BotRegistry(db);
  bots.registerBot({ botId: "bot", userId: "user", displayName: "History fixture" });
  const works = new WorkService(db, { bots, isAuthority: () => true });
  const messages = new BotConversationRepository(db);
  const receipt = messages.accept("user", { botId: "bot", requestId: "origin", text: "Synthetic work origin" });
  messages.update(receipt.assistantMessageId, "completed", "Accepted");
  const result = works.createWork({ kind: "user", userId: "user", entry: "desktop", grants: DESKTOP_USER_GRANTS }, {
    operationId: "create", title: "Synthetic report", ownerBotId: "bot", inputSnapshotId: "input",
    authorization: DESKTOP_USER_GRANTS, criteria: [{ id: "criterion", text: "review" }],
    conversationId: receipt.conversationId, sourceMessageId: receipt.userMessageId,
  });
  assert(result.ok);
  const work = result.work;
  messages.linkWork(messages.receipt("user", "bot", "origin")!, work.workId);
  const workspace = join(root, "workspace"); mkdirSync(workspace);
  // A real, decodable PNG, captured by the actual ArtifactService.
  writeFileSync(join(workspace, "proof.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH7sAAAAASUVORK5CYII=", "base64"));
  works.repo.insertBinding({ bindingId: "binding", workId: work.workId, operationId: "execute", botId: "bot",
    taskId: "report-task", durableStoreKey: "store", conversationId: "native", intentRevision: work.intentRevision,
    ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId, expertSnapshot: bots.activeSnapshot("bot")!,
    delegatedScope: [], workspaceBinding: workspace, status: "completed", admittedAt: 1, settledAt: 2 });
  const metadata = JSON.stringify({ workId: work.workId, eventId: "fixture", kind: "binding", category: "result",
    executionId: "binding", intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId });
  const put = db.prepare(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at,work_ids_json)
    VALUES (?,?,'bot',?,?,?,'completed',?,?,?)`);
  const feedback = db.prepare("INSERT INTO bot_work_feedback(message_id,metadata_json) VALUES (?,?)");
  db.transaction(() => {
    // Including the two origin rows: exactly 10,000 messages. Last page is 50 user/50 assistant.
    for (let i = 2; i < 10000; i++) {
      const assistant = i % 2 === 1;
      const rank = Math.floor((i - 9900) / 2);
      const report = mixed && assistant && rank >= 0 && rank < 25;
      const image = report && rank >= 15;
      const text = assistant ? (`## Answer ${i}\n\nA paragraph with **bold**, _emphasis_, and inline code. 中文内容用于验证真实排版。\n\n- First item\n- Second item\n\n`).repeat(4)
        + (image ? "\n![synthetic proof](proof.png)" : "") : `Question ${i}`;
      put.run(`message-${i}`, receipt.conversationId, `req-${Math.floor(i / 2)}`, assistant ? "assistant" : "user", text,
        1700000000000 + i, 1700000000000 + i, JSON.stringify(report ? [work.workId] : []));
      if (report) feedback.run(`message-${i}`, metadata);
    }
  })();
  const conversations = new BotConversationService({ db, userId: "user", bots, works, models: {} as never,
    directory: root, defaultModel: () => undefined, isAuthority: () => true, memorySearch: () => [], schedule: () => {}, wake: () => {} });
  const artifacts = new ArtifactService(new ArtifactStorage(join(root, "artifacts")), new ArtifactRepository(db), new ArtifactRegistry());
  const readers: Record<string, ImageReader> = {
    baseline: new BaselineImages(db, "user", works, () => artifacts),
    candidate: new BotReportImageService(db, "user", works, () => artifacts),
  };
  // Both variants share the same DB, Work, execution binding, artifact service and source paths.
  // Count executed prepared statements, not merely prepare() calls. This instrumentation has overhead.
  const prepare = db.prepare.bind(db);
  let sql = 0, prepares = 0;
  db.prepare = ((source: string) => {
    prepares++;
    const statement = prepare(source);
    return new Proxy(statement, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (["get", "all", "run", "iterate"].includes(String(key))) sql++;
        return value.apply(target, args);
      };
    } });
  }) as typeof db.prepare;
  async function history(variant: string, request: BotHistoryRequest = { botId: "bot" }) {
    assert(readers[variant], `Unknown variant ${variant}`);
    sql = 0; prepares = 0;
    const cpuStart = process.cpuUsage(), start = performance.now();
    const dto = conversations.history(request), historyMs = performance.now() - start;
    const historyCpu = process.cpuUsage(cpuStart), hydrationCpuStart = process.cpuUsage();
    const historySql = sql, historyPrepares = prepares, hydrationStart = performance.now();
    const hydrated = await readers[variant].hydrateHistory(dto), end = performance.now();
    const hydrationCpu = process.cpuUsage(hydrationCpuStart), mainCpu = process.cpuUsage(cpuStart);
    return { history: hydrated, timing: { historyMs, hydrationMs: end - hydrationStart, mainMs: end - start,
      historyCpuMs: (historyCpu.user + historyCpu.system) / 1000, hydrationCpuMs: (hydrationCpu.user + hydrationCpu.system) / 1000,
      mainCpuMs: (mainCpu.user + mainCpu.system) / 1000,
      historySql, hydrationSql: sql - historySql, historyPrepares, hydrationPrepares: prepares - historyPrepares,
      messages: hydrated.messages.length, bytes: Buffer.byteLength(JSON.stringify(hydrated)) } };
  }
  return { app, artifacts, history };
}
