import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { GatewayInboundHandler } from "../src/main/gateway/channels";

const root = mkdtempSync(join(tmpdir(), "mybuddy-gateway-conversation-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, ".mybuddy");

const agentsMarker = "PRIVATE_AGENTS_GATEWAY_FIXTURE";
writeFileSync(join(root, "AGENTS.md"), agentsMarker);
const skillMarker = "PRIVATE_SKILL_GATEWAY_FIXTURE";
const { getSkillsDir } = await import("../src/main/paths");
const skills = join(getSkillsDir(), "gateway-private-fixture");
mkdirSync(skills, { recursive: true });
writeFileSync(join(skills, "SKILL.md"), "---\nname: gateway-private-fixture\ndescription: " + skillMarker + "\n---\n" + skillMarker);
const { AppSettingsStore } = await import("../src/main/AppSettingsStore");
new AppSettingsStore().write({ memoryEnabled: false });
const { getCurrentSystemPrompt, getCurrentTools } = await import("@earendil-works/pi-ai");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { GatewayService } = await import("../src/main/gateway/GatewayService");
const { gatewayConversationId } = await import("../src/main/gateway/GatewayConversation");
const { gatewayInboundIdentity } = await import("../src/main/gateway/gateway-inbound-identity");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");

const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { TaskExecutionWorkspaceLifecycle } = await import("../src/main/task/TaskExecutionWorkspaceLifecycle");
const { runTaskIsolationAudit } = await import("../src/main/task/TaskIsolationAudit");
const { ensureQQTaskWorkspace, qqTaskWorkspace } = await import("../src/main/task/QQTaskWorkspace");
const dbPath = join(root, "app.db");
let db = new AppDatabase(dbPath);
const channelId = "qq-default", chatId = "group-fixture", connectionKey = "a".repeat(64);
const origin = (senderId: string) => ({ channelId, chatId, connectionKey, senderId, messageId: "origin", audience: "shared" as const });
const old = gatewayInboundIdentity(channelId, connectionKey, chatId).taskId;
const alice = gatewayConversationId(origin("alice")), bob = gatewayConversationId(origin("bob"));
const workspace = new TaskExecutionWorkspace(join(root, "task-workspaces"));
const flatAlice = workspace.resolveTaskExecutionWorkspaceDir(alice);
const qqAlice = qqTaskWorkspace(workspace, alice), qqBob = qqTaskWorkspace(workspace, bob);
const binding = (id: string) => db.connection.prepare("SELECT directory,cwd FROM durable_bot_bindings WHERE task_id=?").get(id) as {directory:string;cwd:string};
const move = (id: string) => db.connection.prepare("SELECT from_cwd,to_cwd FROM durable_bot_workspace_moves WHERE task_id=?").get(id);
const lifecycle = (actual: Awaited<ReturnType<typeof start>>) => new TaskExecutionWorkspaceLifecycle({
  db, workspace, trashRoot: join(root, "workspace-trash"),
  beforeTrash: id => actual.agent.releaseTaskForDeletion(id),
  prepareQQWorkspaceRestore: (id, legacy, dest) => actual.agent.prepareQQTrashRestore(id, legacy, dest),
  onPurge: id => actual.agent.purgeDurableTask(id),
});
const privateMarker = "PRIVATE_DESKTOP_TRANSCRIPT_FIXTURE";
const requests: Array<{ latest: string; transcript: string; tools: string[]; prompt: string }> = [];
const text = (message: TranscriptContext["messages"][number]): string =>
  typeof message.content === "string" ? message.content :
    message.content.filter(part => part.type === "text").map(part => part.text).join("");
let providerFailures = 0;
let duringModel: (() => void) | undefined;
const toolTries = new Map<string, number>();
const markerFile = join(root, "tool-side-effect.txt");
const start = () => createAgentDurableFixture(root, db, input => {
  const latest = text(input.messages.findLast(message => message.role === "user")!);
  requests.push({ latest, transcript: JSON.stringify(input.messages),
    tools: getCurrentTools(input.messages).map(tool => tool.name), prompt: getCurrentSystemPrompt(input.messages) });
  if (latest === "REVOKE_IN_FLIGHT") duringModel?.();
  if (latest === "EMPTY_PROVIDER") return [];
  if (latest === "FAIL_PROVIDER") {
    providerFailures++;
    return { content: [{ type: "text", text: "PARTIAL_NOT_SUCCESS" }], errorMessage: "synthetic provider rejection" };
  }
  if (latest === "ADVERSARIAL_TOOL") {
    const tries = (toolTries.get(latest) ?? 0) + 1;
    toolTries.set(latest, tries);
    if (tries === 1) return [{ type: "toolCall", id: "forbidden-write", name: "write",
      arguments: { path: markerFile, content: "UNEXPECTED TOOL WRITE" } }];
    return [{ type: "text", text: "NO TOOL EXECUTED" }];
  }
  return [{ type: "text", text: "REPLY " + latest }];
});

function openGateway(fixture: Awaited<ReturnType<typeof start>>) {
  const gateway = new GatewayService(db, fixture.agent);
  const internal = gateway as unknown as {
    settingsStore: { read(): { defaultModelId: string } };
    adapters: Map<string, { workConnectionKey(): string }>;
    channelPolicies: Map<string, { allowUsers: string[] }>;
    createInboundHandler(): GatewayInboundHandler;
  };
  internal.settingsStore = { read: () => ({ defaultModelId: "fixture/model" }) };
  internal.adapters.get(channelId)!.workConnectionKey = () => connectionKey;
  internal.adapters.get("telegram-default")!.workConnectionKey = () => connectionKey;
  internal.channelPolicies.set("telegram-default", { allowUsers: ["alice"] });
  const allow = (allowUsers: string[]) => internal.channelPolicies.set(channelId, { allowUsers });
  allow(["alice", "bob"]);
  const inbound = internal.createInboundHandler();
  const send = async (sender: string, messageId: string, message: string, replies: string[] = [], channel = channelId): Promise<string[]> => {
    await inbound({ channelId: channel, chatId, sender: { id: sender }, messageId, text: message,
      reply: async reply => { replies.push(reply); } });
    return replies;
  };
  return { gateway, allow, send };
}

let fixture: Awaited<ReturnType<typeof start>> | undefined;
let bridge: ReturnType<typeof openGateway> | undefined;
try {
  fixture = await start();
  const currentResolve = fixture.agent.resolveTaskExecutionWorkspaceCwd.bind(fixture.agent);
  // Seed a real previous-version native journal with exactly the old flat cwd.
  fixture.agent.resolveTaskExecutionWorkspaceCwd = id => id === alice ? workspace.ensureTaskExecutionWorkspace(id) : currentResolve(id);
  db.upsertTask({ id: old, title: privateMarker, updatedAt: 1 });
  assert.match(alice, /^gateway-chat-[a-f0-9]{64}$/);
  assert.equal(alice, gatewayConversationId({ ...origin("alice"), messageId: "later" }));
  for (const different of [bob, old, gatewayConversationId({ ...origin("alice"), connectionKey: "b".repeat(64) }),
    gatewayConversationId({ ...origin("alice"), channelId: "telegram-default" }),
    gatewayConversationId({ ...origin("alice"), chatId: "other-chat" })]) assert.notEqual(alice, different);
  await assert.rejects(fixture.agent.runGatewayTurn({ taskId: old, text: "LEGACY DENIED",
    modelId: "fixture/model", userMessageId: "legacy-user", assistantMessageId: "legacy-assistant", gatewayOrigin: origin("alice") }));
  bridge = openGateway(fixture);
  await fixture.prompt({ taskId: "desktop-gateway-fixture", text: privateMarker, userMessageId: "desktop-user", assistantMessageId: "desktop-assistant" });
  const desktop = requests.at(-1)!;
  assert(desktop.tools.length, "control requests on desktop must actually expose tools");
  assert(desktop.prompt.includes(skillMarker), "desktop positive control must actually receive the local skill");
  assert(desktop.transcript.includes(privateMarker), "desktop-only transcript exists before any gateway message");
  const first = requests.length;
  assert.deepEqual(await bridge.send("alice", "a1", "ALICE_FIRST"), ["REPLY ALICE_FIRST"]);
  assert.deepEqual(await bridge.send("alice", "a1", "DUPLICATE"), []);
  const [aliceReplies, bobReplies] = await Promise.all([
    bridge.send("alice", "a2", "ALICE_CONTINUE"), bridge.send("bob", "b1", "BOB_FIRST"),
  ]);
  assert.deepEqual(aliceReplies, ["REPLY ALICE_CONTINUE"]);
  assert.deepEqual(bobReplies, ["REPLY BOB_FIRST"]);
  const live = requests.slice(first);
  assert.equal(live.length, 3);
  const aliceContinue = live.find(request => request.latest === "ALICE_CONTINUE")!;
  assert(aliceContinue.transcript.includes("ALICE_FIRST"), "own history is available");
  assert(!live.find(request => request.latest === "BOB_FIRST")!.transcript.includes("ALICE_FIRST"));
  assert(db.getTask(alice) && db.getTask(bob));
  assert.equal(db.getTask(old)?.title, privateMarker, "legacy task must not be adopted or rewritten");
  bridge.allow([]);
  assert.deepEqual(await bridge.send("alice", "a3", "DENIED_EMPTY"), []);
  bridge.allow(["alice", "bob"]);
  assert.deepEqual(await bridge.send("unknown", "a4", "DENIED_STRANGER"), []);
  assert.equal(requests.length, first + 3);
  assert.deepEqual(await bridge.send("alice", "tg1", "TELEGRAM_FIRST", [], "telegram-default"), ["REPLY TELEGRAM_FIRST"]);
  const telegram = gatewayConversationId({ ...origin("alice"), channelId: "telegram-default" });
  const expectedGroups = new Map([[alice, "qq-default"], [bob, "qq-default"], [telegram, "telegram-default"]]);
  const assertSidebar = (database: InstanceType<typeof AppDatabase>) => {
    const list = database.listNonTrashedTasks();
    assert.equal(list.filter(task => task.gatewaySidebarChannelId).length, 3);
    for (const [taskId, channel] of expectedGroups) {
      const row = list.find(task => task.id === taskId);
      assert.equal(row?.gatewaySidebarChannelId, channel);
      assert.equal(row?.spaceId, undefined, "display grouping is never a real workspace");
      assert.equal(row?.projectId, undefined);
    }
    assert.equal(list.find(task => task.id === old)?.gatewaySidebarChannelId, undefined);
  };
  const impostor = gatewayConversationId(origin("not-authorized"));
  db.upsertTask({ id: impostor, title: "A carried DTO cannot create a trusted group", updatedAt: Date.now(), gatewaySidebarChannelId: "qq-default" });
  assert.equal(db.getTask(impostor)?.gatewaySidebarChannelId, undefined);
  db.createSpace({ id: "normal-workspace", name: "Ordinary workspace" });
  assert.throws(() => db.moveTaskInWorkspaceTree({ taskId: alice, targetSpaceId: "normal-workspace" }), /不能移入/);
  assert.throws(() => db.upsertTask({ id: alice, title: "scope spoof", updatedAt: Date.now(), spaceId: "normal-workspace" }), /不能绑定/);
  assert.throws(() => db.upsertTask({ id: alice, title: "scope spoof", updatedAt: Date.now(), projectId: "not-a-project" }), /不能绑定/);
  assertSidebar(db);
  assert.equal(db.getTask(alice)?.cwd, flatAlice);
  assert.equal(db.getTask(bob)?.cwd, qqBob, "fresh QQ uses the nested physical cwd");
  assert.equal(binding(bob).cwd, qqBob);
  assert.equal(db.getTask(telegram)?.cwd, workspace.resolveTaskExecutionWorkspaceDir(telegram));
  assert.equal(db.getTask("desktop-gateway-fixture")?.cwd, workspace.resolveTaskExecutionWorkspaceDir("desktop-gateway-fixture"));
  const forbidden = new TaskExecutionWorkspace(join(root, "symlink-check"));
  const outside = join(root, "not-the-qq-parent");
  mkdirSync(forbidden.getTaskExecutionWorkspacesRoot());
  mkdirSync(outside);
  symlinkSync(outside, join(forbidden.getTaskExecutionWorkspacesRoot(), "gateway"), "junction");
  assert.throws(() => ensureQQTaskWorkspace(forbidden, alice), /普通目录/);
  assert(!existsSync(join(outside, "qq")), "must not write through a symlink/junction");
  assert.equal(bridge.gateway.listMessages({ channelId }).filter(event =>
    event.direction === "system" && event.text.includes("发送者")).length, 2);

  const trash = lifecycle(fixture);
  assert(!trash.scanOrphans().some(row => row.directoryName === "gateway"));
  assert.throws(() => trash.moveOrphanToTrash("gateway"), /托管容器/);
  assert.throws(() => trash.adoptOrphan("gateway", "ordinary-fixture"), /托管容器/);
  const originalBinding = binding(alice);
  const callsBeforeArchive = requests.length;
  trash.archive(alice);
  assert.match((await bridge.send("alice", "a-archived", "ARCHIVED_NO_RUN"))[0]!, /先在本地恢复/);
  assert.equal(requests.length, callsBeforeArchive);
  assert(existsSync(flatAlice), "archive never moves files");
  trash.unarchive(alice);
  writeFileSync(join(flatAlice, "keep.txt"), "recover the exact original files");
  const archived = await trash.trash(alice);
  assert(!existsSync(flatAlice) && !!archived.trashPath && existsSync(archived.trashPath));
  assert.match((await bridge.send("alice", "a-trashed", "TRASHED_NO_RUN"))[0]!, /先在本地恢复/);
  assert.equal(db.getTaskExecutionWorkspaceState(alice)?.state, "trashed");
  assert.equal(requests.length, callsBeforeArchive);
  assert(!existsSync(qqAlice), "inbound must not create a new directory while trashed");

  ensureQQTaskWorkspace(workspace, alice);
  writeFileSync(join(qqAlice, "independent-copy.txt"), "never discard either side of a collision");
  assert.throws(() => trash.restore(alice), /不覆盖/);
  await assert.rejects(trash.purge(alice, { force: true }), /仍有原位数据/);
  assert(existsSync(join(qqAlice, "independent-copy.txt")) && existsSync(join(archived.trashPath!, "keep.txt")));
  rmSync(qqAlice, { recursive: true });
  const originalWrite = db.upsertTaskExecutionWorkspaceState.bind(db);
  db.upsertTaskExecutionWorkspaceState = row => { if (row.taskId === alice && row.state === "active") throw Error("fixture SQLite failure"); originalWrite(row); };
  try { assert.throws(() => trash.restore(alice), /fixture SQLite failure/); }
  finally { db.upsertTaskExecutionWorkspaceState = originalWrite; }
  assert.equal(move(alice), undefined, "failed DB transaction rolled back its native cwd intent");
  assert(!existsSync(qqAlice) && existsSync(join(archived.trashPath!, "keep.txt")), "failed transaction restores the original path");

  assert.equal(trash.restore(alice).workspaceDir, qqAlice);
  assert.equal(readFileSync(join(qqAlice, "keep.txt"), "utf8"), "recover the exact original files");
  assert(!existsSync(flatAlice) && !existsSync(archived.trashPath!));
  assert.deepEqual(move(alice), { from_cwd: flatAlice, to_cwd: qqAlice });
  assert.deepEqual(binding(alice), originalBinding, "native journal has not been swapped or replaced");

  await bridge.gateway.stop(); bridge = undefined;
  await fixture.close(); fixture = undefined;
  // Reopen SQLite itself (not only the agent object), ensuring groups are persisted.
  db.close();
  db = new AppDatabase(dbPath);
  assertSidebar(db);
  fixture = await start(); bridge = openGateway(fixture);
  assert.deepEqual(await bridge.send("alice", "a5", "ALICE_REOPEN"), ["REPLY ALICE_REOPEN"]);
  assert.equal(db.getTask(alice)?.cwd, qqAlice);
  assert.deepEqual(binding(alice), { directory: originalBinding.directory, cwd: qqAlice });
  assert.equal(move(alice), undefined, "cold recovery committed the native binding and task cwd together");
  const audit = runTaskIsolationAudit({ db, dbPath, workspacesRoot: workspace.getTaskExecutionWorkspacesRoot(), taskId: alice });
  assert.equal(audit.tasks[0]?.expectedCwd, qqAlice);
  assert.deepEqual(audit.tasks[0]?.codes, ["TASK_CANONICAL"]);
  const qqManifest = join(qqAlice, ".mybuddy-task.json");
  const manifestBytes = readFileSync(qqManifest);
  writeFileSync(qqManifest, JSON.stringify({ version: 1, taskId: bob, createdAt: 1 }));
  try {
    const wrongOwner = runTaskIsolationAudit({ db, dbPath, workspacesRoot: workspace.getTaskExecutionWorkspacesRoot(), taskId: alice });
    assert(wrongOwner.tasks[0]?.codes.includes("MANIFEST_TASK_MISMATCH"));
    assert(!wrongOwner.tasks[0]?.codes.includes("TASK_CANONICAL"));
  } finally { writeFileSync(qqManifest, manifestBytes); }
  const flatBob = workspace.resolveTaskExecutionWorkspaceDir(bob);
  db.bindTaskExecutionWorkspaceCwd(bob, flatBob); // model an inconsistent projection without moving bytes
  runTaskIsolationAudit({ db, dbPath, workspacesRoot: workspace.getTaskExecutionWorkspacesRoot(), taskId: bob, repairSafeMetadata: true });
  assert(!existsSync(flatBob), "generic metadata repair cannot create a shadow QQ directory");
  db.bindTaskExecutionWorkspaceCwd(bob, qqBob);

  const reopened = requests.at(-1)!;
  assert(reopened.transcript.includes("ALICE_FIRST") && !reopened.transcript.includes("BOB_FIRST"));
  const malicious = await bridge.send("alice", "a6", "ADVERSARIAL_TOOL");
  assert.equal(malicious.length, 1);
  assert(!existsSync(markerFile), "provider cannot invoke local write even if it emits a tool call");
  const maliciousRequests = requests.filter(request => request.latest === "ADVERSARIAL_TOOL");
  assert(maliciousRequests.length >= 1);
  const maliciousTranscript = maliciousRequests.at(-1)!.transcript;
  assert(!maliciousTranscript.includes("Successfully wrote"), "tool execution cannot masquerade as successful");
  for (const request of requests.slice(first)) {
    assert.deepEqual(request.tools, [], "all provider requests, including reopened ones, must have zero tools");
    assert(!request.prompt.includes(skillMarker) && !request.transcript.includes(skillMarker));
    assert(!request.prompt.includes(privateMarker) && !request.transcript.includes(privateMarker));
    assert(!request.prompt.includes(agentsMarker) && !request.transcript.includes(agentsMarker));
  }
  const inFlightReplies: string[] = [];
  let revokedAfterAdmission = false;
  duringModel = () => { revokedAfterAdmission = true; bridge!.allow(["bob"]); };
  await assert.rejects(bridge.send("alice", "a7", "REVOKE_IN_FLIGHT", inFlightReplies), /未发送/);
  duringModel = undefined;
  assert(revokedAfterAdmission, "the freshly revoked sender reached the provider while authorized");
  assert.deepEqual(inFlightReplies, [], "no response may be delivered after mid-turn revocation");
  assert.deepEqual(requests.at(-1)?.tools, []);
  const failure = await bridge.send("bob", "b2", "FAIL_PROVIDER");
  assert(providerFailures > 0, "the deterministic provider failure was actually exercised");
  assert.equal(failure.length, 1);
  assert.match(failure[0]!, /^处理失败：/);
  assert(!failure[0]!.includes("PARTIAL_NOT_SUCCESS"), "partial assistant text from a failed provider is not a successful reply");
  assert.deepEqual(requests.at(-1)?.tools, []);
  const empty = await bridge.send("bob", "b3", "EMPTY_PROVIDER");
  assert.equal(requests.at(-1)?.latest, "EMPTY_PROVIDER", "the fixture actually produced an empty model result");
  assert.equal(empty.length, 1);
  assert.match(empty[0]!, /^处理失败：/);
  assert(!empty[0]!.includes("任务已处理"), "empty provider results cannot become synthetic success");
  const nestedLifecycle = lifecycle(fixture);
  const bobTrash = await nestedLifecycle.trash(bob);
  assert(!existsSync(qqBob) && !!bobTrash.trashPath && existsSync(bobTrash.trashPath));
  assert.equal(nestedLifecycle.restore(bob).workspaceDir, qqBob);
  assert.equal(move(bob), undefined, "already-canonical restore does not create a second migration");
  const bobFinal = await nestedLifecycle.trash(bob);
  const purged = await nestedLifecycle.purge(bob, { force: true });
  assert(purged.removedTrashDir && !existsSync(bobFinal.trashPath!));
  assert.equal(db.getTask(bob), undefined);
  assert(existsSync(join(qqAlice, "keep.txt")), "another QQ task's purge cannot touch Alice");
  console.log("PASS QQ managed cwd, no inbound resurrection, collision/rollback, same native history on cold reopen, archive/trash/repeat restore/purge and symlink rejection");
  console.log("PASS Gateway text-only real AgentService, sender isolation, allowlist, duplicate delivery, two channel sidebar groups and cold reopen");
} finally {
  await bridge?.gateway.stop();
  await fixture?.close();
  db.close();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
