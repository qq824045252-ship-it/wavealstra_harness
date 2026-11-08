import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { createWorkTeamIpcHandler } from "../src/main/agent/work/WorkTeamIpc";
import { LOCAL_USER_ID, minimumAuthorization, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-team-access-"));
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
for (const botId of ["owner", "member", "outsider"]) bots.registerBot({ botId, userId: LOCAL_USER_ID,
  displayName: botId, authorization: minimumAuthorization() });
const works = new WorkService(db.connection, { bots });
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const unwrap = (result: WorkControlResult) => { assert(result.ok, JSON.stringify(result)); return result.work; };
const messages = new BotConversationRepository(db.connection);
try {
  let work = unwrap(works.createWork(user, { operationId: "create", title: "Shared team facts", ownerBotId: "owner", authorization: grants }));
  work = unwrap(works.addParticipant(user, { operationId: "add-member", workId: work.workId, botId: "member", delegatedScope: ["workspace:read"] }));
  const other = unwrap(works.createWork(user, { operationId: "other", title: "Private outsider work", ownerBotId: "outsider" }));
  const receipt = messages.accept(LOCAL_USER_ID, { botId: "member", requestId: "member-query", text: "查看所选团队事项", selectedWorkId: work.workId });
  const tools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: "member",
    conversationId: receipt.conversationId, bots, messages, works, isAuthority: () => true,
    schedule: () => { throw Error("A member must not schedule owner work"); }, wake: () => {}, memorySearch: () => [] });
  let call = 0;
  const invoke = async (name: string, args: unknown) => {
    const api = { callId: `call-${++call}`, taskId: `tool-${call}`, memo: async () => receipt.requestId } as unknown as ToolExecutionApi;
    const result = await tools.find(tool => tool.name === name)!.execute(args as never, api, BACKGROUND_CONTEXT);
    const content = result.output?.find(item => item.type === "text"); assert(content?.type === "text"); return JSON.parse(content.text);
  };
  const facts = await invoke("work_query_status", {});
  assert.deepEqual(facts.map((value: { workId: string }) => value.workId), [work.workId]);
  assert.deepEqual(await invoke("work_query_status", { workId: other.workId }), []);
  const before = works.getWork(work.workId);
  for (const action of ["work_pause", "work_resume", "work_cancel", "work_amend"]) {
    await assert.rejects(invoke(action, { workId: work.workId, versionGuard: facts[0].versionGuard }), /团队成员只能查看和讨论/);
  }
  assert.deepEqual(works.getWork(work.workId), before);
  assert.equal(db.listTasks().length, 0);
  assert.deepEqual(bots.getBot("member")?.authorization, minimumAuthorization());

  let calls = 0;
  const frame = { url: "file:///app/renderer/index.html?language=zh#bot" };
  const sender = { mainFrame: frame, isDestroyed: () => false };
  let window: { webContents: typeof sender; isDestroyed: () => boolean } | null = { webContents: sender, isDestroyed: () => false };
  const control = createWorkTeamIpcHandler({ getMainWindow: () => window,
    rendererUrl: "file:///app/renderer/index.html", control: () => { calls++; return { ok: true }; } });
  assert(control({ sender, senderFrame: frame }, {}).ok);
  const rejected = [
    { sender, senderFrame: null },
    { sender, senderFrame: { ...frame } },
    { sender: { ...sender }, senderFrame: frame },
    { sender: { ...sender, isDestroyed: () => true }, senderFrame: frame },
  ];
  for (const event of rejected) assert.equal(control(event, {}).ok, false);
  frame.url = "https://example.com/renderer/index.html";
  assert.equal(control({ sender, senderFrame: frame }, {}).ok, false);
  frame.url = "file:///app/renderer/index.html";
  window = null;
  assert.equal(control({ sender, senderFrame: frame }, {}).ok, false);
  assert.equal(calls, 1);
  console.log("PASS team foreground facts, owner-control isolation, unchanged grants and trusted top-level IPC");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
