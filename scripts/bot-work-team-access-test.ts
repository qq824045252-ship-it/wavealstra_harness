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
    botWorkspace: () => root, schedule: () => { throw Error("A member must not schedule owner work"); }, wake: () => {}, memorySearch: () => [] });
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

  assert(bots.getBot("owner")?.foregroundAllowedTools.includes("work_team_create"), "existing create-Work capability exposes team tools without editing stored grants");
  // Real foreground tools reuse a saved owner template, preserving user input and
  // the existing team engine. No synthetic user actor or ordinary dispatch.
  const template = works.teams.handle(user, { kind: "save_template", request: { operationId: "saved-team", name: "只读盘点团队",
    plan: { ownerBotId: "owner", ownerResponsibility: "汇总事实", members: [{ botId: "member", responsibility: "检查文件", delegatedScope: ["workspace:read"] }] } } });
  assert(template.ok && template.template);
  const ownerInput = messages.accept(LOCAL_USER_ID, { botId: "owner", requestId: "owner-team", text: "请用盘点团队核对两个文件，保留我这句话" });
  const ownerTools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: "owner",
    conversationId: ownerInput.conversationId, bots, messages, works, isAuthority: () => true,
    botWorkspace: () => root, schedule: () => { throw Error("Team must use WorkTeamService, not an ordinary dispatch"); },
    wake: () => {}, memorySearch: () => [] });
  const invokeOwner = async (name: string, args: unknown, taskId = "saved-team-create") => {
    const api = { callId: `owner-${++call}`, taskId, memo: async () => ownerInput.requestId } as unknown as ToolExecutionApi;
    const result = await ownerTools.find(tool => tool.name === name)!.execute(args as never, api, BACKGROUND_CONTEXT);
    const content = result.output?.find(item => item.type === "text"); assert(content?.type === "text"); return JSON.parse(content.text);
  };
  const catalogue = await invokeOwner("work_team_templates", {});
  assert.equal(catalogue.templates.length, 1);
  assert.equal(catalogue.templates[0].members[0].displayName, "member");
  assert.equal((await invoke("work_team_templates", {})).templates.length, 0, "members cannot adopt owner's templates");
  const request = { templateId: template.template.templateId, title: "团队盘点", goalDescription: "模型规划", criteria: ["核对文件"] };
  const started = await invokeOwner("work_team_create", request);
  assert(started.ok, JSON.stringify(started));
  assert.equal(started.work.ownerBotId, "owner");
  assert.equal(started.team.executions.length, 2);
  assert.equal(started.work.criteria[0].origin, "assistant_proposal");
  assert.equal(started.work.sourceMessageId, ownerInput.userMessageId);
  assert.equal(started.work.workspacePath, root);
  assert(db.connection.prepare("SELECT messages_json FROM bot_work_user_inputs WHERE work_id=?").get(started.work.workId));
  assert(messages.message(ownerInput.userMessageId)?.workIds.includes(started.work.workId));
  assert.equal((await invokeOwner("work_team_create", request)).work.workId, started.work.workId, "native replay does not create a second team");
  assert.deepEqual(bots.getBot("owner")?.authorization, minimumAuthorization(), "no permanent grant expansion");
  assert.equal((await invoke("work_team_create", request)).ok, false);
  await assert.rejects(invokeOwner("work_team_create", { ...request, workspacePath: "/" }), /unrecognized|Unrecognized/);
  const taskAssignment = { ownerResponsibility: "汇总本次盘点并核验总数", members: [
    { botId: "member", responsibility: "只读取本次文件甲，报告标记和字节数", dependsOnBotIds: [] }] };
  const assigned = await invokeOwner("work_team_create", { ...request, taskAssignment }, "assigned-team");
  assert(assigned.ok, JSON.stringify(assigned));
  assert.equal(assigned.team.ownerResponsibility, taskAssignment.ownerResponsibility);
  assert.equal(assigned.team.members[0].responsibility, taskAssignment.members[0].responsibility);
  assert.deepEqual(assigned.team.members[0].delegatedScope, ["workspace:read"]);
  assert.equal((await invokeOwner("work_team_create", { ...request, taskAssignment }, "assigned-team")).work.workId, assigned.work.workId);
  assert.equal((await invokeOwner("work_team_templates", {})).templates[0].members[0].responsibility, "检查文件", "task plan never mutates saved template");
  const flexibleTemplate = works.teams.handle(user, { kind: "save_template", request: { operationId: "flexible-team", name: "多人目录团队",
    plan: { ownerBotId: "owner", ownerResponsibility: "汇总", executionPolicy: "parallel", maxConcurrency: 2,
      members: [{ botId: "member", responsibility: "通用读取", delegatedScope: ["workspace:read"] },
        { botId: "outsider", responsibility: "通用核对", delegatedScope: ["workspace:read"] }] } } });
  assert(flexibleTemplate.ok && flexibleTemplate.template);
  const flexibleRequest = { ...request, templateId: flexibleTemplate.template.templateId };
  const subset = await invokeOwner("work_team_create", { ...flexibleRequest, taskAssignment }, "subset-team");
  assert(subset.ok && subset.team.members.length === 1);
  assert.equal(subset.team.executionPolicy, "parallel");
  assert.equal(subset.team.maxConcurrency, 2);
  const ordered = await invokeOwner("work_team_create", { ...flexibleRequest, taskAssignment: {
    ownerResponsibility: "核验并汇总", members: [
      { botId: "outsider", responsibility: "先读取乙文件" },
      { botId: "member", responsibility: "再核验乙文件", dependsOnBotIds: ["outsider"] }] } }, "ordered-team");
  assert(ordered.ok, JSON.stringify(ordered));
  assert.deepEqual(ordered.team.members.map((member: { botId: string }) => member.botId), ["outsider", "member"]);
  assert.deepEqual(ordered.team.members[1].dependsOnBotIds, ["outsider"]);
  const countBeforeInvalid = db.connection.prepare("SELECT COUNT(*) AS n FROM work_teams").get();
  for (const members of [
    [{ botId: "outsider", responsibility: "读取" }],
    [{ botId: "member", responsibility: "读取", dependsOnBotIds: ["member"] }],
    [{ botId: "member", responsibility: "读取", dependsOnBotIds: ["outsider"] }],
    [{ botId: "member", responsibility: "读取" }, { botId: "member", responsibility: "重复" }],
  ]) assert.equal((await invokeOwner("work_team_create", { ...request, taskAssignment: { ...taskAssignment, members } }, `invalid-${++call}`)).ok, false);
  await assert.rejects(invokeOwner("work_team_create", { ...request, taskAssignment: { ...taskAssignment,
    members: [{ ...taskAssignment.members[0], delegatedScope: ["workspace:write"] }] } }, "expanded-scope"), /unrecognized|Unrecognized/);
  assert.deepEqual(db.connection.prepare("SELECT COUNT(*) AS n FROM work_teams").get(), countBeforeInvalid);
  assert.deepEqual(bots.getBot("owner")?.authorization, minimumAuthorization());
  const details = await invokeOwner("work_query_status", { workId: started.work.workId });
  assert.equal(details[0].team.executions.length, 2);
  const paused = await invokeOwner("work_pause", { workId: started.work.workId, versionGuard: details[0].versionGuard }, "pause-team");
  assert(paused.ok && paused.work.lifecycle === "paused");
  const pausedFacts = await invokeOwner("work_query_status", { workId: started.work.workId });
  assert((await invokeOwner("work_resume", { workId: started.work.workId, versionGuard: pausedFacts[0].versionGuard }, "resume-team")).ok);
  assert.equal(works.teams.get(started.work.workId)?.executions.length, 2, "resume preserves member identities");

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
