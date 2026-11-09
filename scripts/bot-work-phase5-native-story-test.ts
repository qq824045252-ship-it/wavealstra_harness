import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { WorkNotificationHost } from "../src/main/agent/work/WorkNotificationHost";
import { reviewWork } from "../src/main/agent/work/WorkReviewControl";
import { RemoteAccessServer } from "../src/main/remote/RemoteAccessServer";
import { RemoteAccessPairing } from "../src/main/remote/RemoteAccessPairing";
import { RemoteDeviceStore } from "../src/main/remote/RemoteDeviceStore";
import { RemoteEventBus } from "../src/main/remote/RemoteEventBus";
import { createRemoteWorkBridge } from "../src/main/remote/work-mapper";
import { mergeWorkList } from "../src/renderer/src/store/app/slices/botWorkSync";
import { RemoteApiError, RemoteClient } from "../app/remote/src/api/RemoteClient";
import { useRemoteWorkStore } from "../app/remote/src/store/remoteWork";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkDto, type WorkNotificationChannel, type WorkExecutionBindingDto } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import type { WorkListUpdate } from "../src/shared/bot-conversation";
import { verifyNativeInputProvenance } from "./bot-work-phase5-native-provenance";
import { HOST_LEASE_TTL_MS, grants, guard, hash, openNativeHost, unwrap, user, waitFor, type NativeHost } from "./bot-work-phase5-native-fixture";

/**
 * Frozen acceptance §9, one continuous production Pi Durable story on one SQLite and
 * one native store. The only injected pieces are deterministic model answers and
 * isolated filesystem/notification effects. There is no fabricated native terminal
 * observation, business terminal SQL, replaced executor, graceful "crash", or real
 * Omarchy/Windows/physical-phone claim. Actual SIGKILL owners are verified below.
 */
type Story = { workA: string; workB: string; subA: string; subB: string; r1Binding: string; r2Binding: string;
  r2Receipt: AgentSubmissionReceipt; identities: unknown; beforeRecovery: ReturnType<NativeHost["counts"]>;
  beforeDelivery?: ReturnType<NativeHost["counts"]>; beforeDeliveryIdentities?: unknown;
  beforeDeliveryWorkState?: { a: ReturnType<typeof workControlState>; b: ReturnType<typeof workControlState> };
  phoneToken?: string; desktopBeforeClose?: WorkListUpdate; finalCardKey?: string; preservedHash?: string; pendingNotificationIds?: string[] };
const workControlState = (work: WorkDto) => ({ workId: work.workId, lifecycle: work.lifecycle,
  intentRevision: work.intentRevision, ownerEpoch: work.ownerEpoch, inputSnapshotId: work.inputSnapshotId,
  authorization: work.authorization });
const readStory = (root: string) => JSON.parse(readFileSync(join(root, "story.json"), "utf8")) as Story;
const saveStory = (root: string, story: Story) => writeFileSync(join(root, "story.json"), JSON.stringify(story, null, 2));
const identity = (binding: WorkExecutionBindingDto) => ({ bindingId: binding.bindingId, taskId: binding.taskId,
  durableStoreKey: binding.durableStoreKey, conversationId: binding.conversationId, workspaceBinding: binding.workspaceBinding,
  operationId: binding.operationId, inputSnapshotId: binding.inputSnapshotId, intentRevision: binding.intentRevision });
const identities = (host: NativeHost) => host.works.listWorks(LOCAL_USER_ID, { includeClosed: true })
  .flatMap(work => host.works.repo.listBindings(work.workId).map(identity)).sort((a, b) => a.bindingId.localeCompare(b.bindingId));
function checkpoint(root: string, stage: number, label: string): never {
  const temporary = join(root, `checkpoint-${process.pid}.json`);
  writeFileSync(temporary, JSON.stringify({ stage, label, pid: process.pid }));
  renameSync(temporary, join(root, `checkpoint-${stage}.json`));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw Error("unreachable checkpoint");
}
async function openPhone(host: NativeHost, priorToken?: string) {
  const devices = new RemoteDeviceStore(join(host.root, "devices.json")), pairing = new RemoteAccessPairing(devices);
  const server = new RemoteAccessServer({ port: 0, devices, pairing, events: new RemoteEventBus(),
    work: createRemoteWorkBridge({ db: host.db.connection, works: host.works, userId: LOCAL_USER_ID }),
    service: { bootstrap: async () => ({ server: { apiVersion: "1" }, spaces: [], tasks: [], models: [] }),
      listNotifications: () => [], markNotificationRead: () => undefined, markAllNotificationsRead: () => undefined,
      clearAllNotifications: () => undefined, history: async () => undefined, runtime: () => undefined,
      image: async () => { throw Error("unused"); }, serverInfo: () => ({ apiVersion: "1" }) } as never, commands: {} as never });
  const address = await server.start(), baseUrl = `http://127.0.0.1:${address.port}`;
  let token = priorToken;
  if (!token) {
    const session = pairing.create(baseUrl);
    token = (await RemoteClient.pair(baseUrl, { pairingId: session.pairingId, secret: session.secret,
      deviceName: "Phase5 protocol fixture phone", installationId: randomUUID() })).deviceToken;
  }
  const client = new RemoteClient(baseUrl, token);
  useRemoteWorkStore.getState().setClient(client);
  useRemoteWorkStore.getState().setIncludeClosed(true);
  await useRemoteWorkStore.getState().refresh(client);
  assert.equal(useRemoteWorkStore.getState().error, null);
  return { client, token, server, close: async () => { useRemoteWorkStore.getState().setClient(null); await server.stop(); } };
}

async function stageOne(host: NativeHost) {
  const { works, cwd, root } = host;
  const sourceRef = join(cwd, "source-version.txt"); writeFileSync(sourceRef, "before-commit-A\n");
  const source = { sourceType: "file" as const, sourceRef, inputSnapshotId: `sha256:${hash(readFileSync(sourceRef))}`, observedAt: Date.now() };
  const create = (operationId: string, title: string, realCheck: boolean) => unwrap(works.createWork(user, { operationId, title,
    mode: "watch", authorization: grants, workspacePath: cwd, inputSnapshotId: source.inputSnapshotId, goalSources: [source],
    criteria: [{ text: "自动检查通过" }, ...(realCheck ? [{ text: "Omarchy 实测通过", requiresRealEnvironmentCheck: true, requiredEnvironment: "omarchy" }] : [])],
    watchRule: { catchUpPolicy: "latest", maxMergeWaitMs: 1000, maxQueueDepth: 8,
      stopConditionText: realCheck ? "Omarchy 实测通过且无回归，由用户确认结束" : "B 独立停止条件，由用户确认结束" } }));
  const a = create("story-create-a", "Watch A: Linux 检查与有限实测职责", true), b = create("story-create-b", "Watch B: 同来源独立职责", false);
  const subscribe = (workId: string, targetKey: string) => {
    const result = works.phase4Control(user, { kind: "configure-subscription", operationId: `subscribe:${targetKey}`, workId,
      source: "hook", catchUpPolicy: "latest", maxMergeWaitMs: 1000, maxQueueDepth: 8, versionMode: "monotonic", targetKey,
      stopConditionText: works.getWork(workId)!.watchRule!.stopConditionText, versionGuard: guard(works.getWork(workId)!) });
    assert(result.ok); assert(result.subscriptionId); return result.subscriptionId;
  };
  const subA = subscribe(a.workId, "A"), subB = subscribe(b.workId, "B");
  assert.notEqual(a.workId, b.workId); assert.notEqual(subA, subB);
  assert.equal("budget" in a, false); assert.equal("budget" in b, false);
  assert.equal(works.getWork(a.workId)!.criteria[1].status, "pending");
  host.step(1, "同一持久库立项 A 与同宿主同来源 B，冻结有限职责、授权、验收和停止条件", { a: a.workId, b: b.workId, subA, subB, source });

  writeFileSync(sourceRef, "commit-A\n");
  const emit = (sourceEventId: string, sourceVersion: string) => works.ingestSourceEvent({ source: "hook", sourceEventId, sourceVersion,
    eventType: "changed", workId: a.workId, payload: { target: "A", commit: "A" } });
  assert(emit("commit-A", "2").acknowledged);
  assert.equal(emit("commit-A", "2").sourceNew, false);
  emit("delayed-before-A", "1");
  await host.flushUntil(() => host.effectCount("r1-historical") === 1, "actual first hook root and file effect");
  const oldBinding = works.repo.listBindings(a.workId)[0]; assert(oldBinding); assert.equal(oldBinding.intentRevision, 1);
  assert.equal(works.repo.listBindings(a.workId).length, 1, "duplicate and delayed hook share one latest obligation");
  assert.equal(works.repo.listBindings(b.workId).length, 0, "A route cannot dispatch B");
  const foreground = new BotConversationService({ db: host.db.connection, userId: LOCAL_USER_ID, bots: host.bots, works,
    models: host.models, directory: join(root, "foreground"), defaultModel: () => "phase5/front", isAuthority: () => host.lease.isAuthority(),
    memorySearch: () => [], schedule: () => assert.fail("ordinary foreground status must not schedule a background task"), wake: () => {} });
  const beforeForeground = identities(host);
  const sent = foreground.send({ botId: DEFAULT_BOT_ID, requestId: "foreground-status", text: "进展怎样？先聊一下 Linux 验收步骤。", selectedWorkId: a.workId });
  await waitFor(() => foreground.history({ botId: DEFAULT_BOT_ID }).messages.some(message => message.requestId === "foreground-status" && message.role === "assistant" && message.status === "completed"), "foreground actual native reply while root is waiting");
  assert.deepEqual(identities(host), beforeForeground);
  await foreground.close();
  host.step(2, "真实 Hook 单次派发，前台原生讨论及时完成且不新建后台 Task", { original: identity(oldBinding), foregroundRequest: sent.requestId, calls: host.counts() });

  const amended = unwrap(works.amendWork(user, { operationId: "amend-linux-only", workId: a.workId,
    constraints: ["只检查 Linux，先别发布"], inputSnapshotId: "input:story-r2", invalidateExecutionIds: [oldBinding.bindingId],
    versionGuard: guard(works.getWork(a.workId)!) }));
  assert.equal(amended.intentRevision, 2); assert(works.repo.getBinding(oldBinding.bindingId)!.invalidatedAt);
  host.step(3, "正式改要求为 r2，旧命令与执行失效，在途效果仍须结算", { intentRevision: amended.intentRevision, snapshots: works.repo.listIntentSnapshots(a.workId) });
  // Finish r1 in the actual native log, but deliberately do not deliver it to Work until after restart.
  host.oldGate.release();
  const oldReceipt = await host.port.find(oldBinding); assert(oldReceipt);
  await host.native.submissionStatus(oldReceipt, true);
  assert.equal(works.repo.listDeliverables(a.workId).length, 0, "r1 native result is still late at the business boundary");
  const { binding, receipt } = await host.queuedSubmissionWithoutReceipt(a.workId, "story-original-r2", "phase5/root");
  await host.native.submissionStatus(receipt, true);
  const observation = await host.port.inspect(binding, receipt);
  assert(observation.status === "completed");
  assert.equal(observation.usageTokens, 30, "dedicated native accounting includes both children and their parent");
  assert.equal(host.effectCount("retain-one"), 1); assert.equal(host.effectCount("must-not-write"), 0);
  assert.equal(works.repo.getBinding(binding.bindingId)!.submissionReceipt, undefined, "lost business receipt is the exact crash window");
  const story: Story = { workA: a.workId, workB: b.workId, subA, subB, r1Binding: oldBinding.bindingId, r2Binding: binding.bindingId,
    r2Receipt: receipt, identities: identities(host), beforeRecovery: host.counts(), preservedHash: hash(readFileSync(join(cwd, "shared-result.txt"))) };
  saveStory(root, story);
  host.step(4, "真实 Pi Durable 已落盘原 submission，业务回执未写入，进入外部 SIGKILL 窗口", { identity: identity(binding), receipt, observation, counts: story.beforeRecovery });
  checkpoint(root, 1, "native-accepted-before-business-receipt");
}

async function stageTwo(host: NativeHost) {
  const story = readStory(host.root), { works } = host;
  const original = works.repo.getBinding(story.r2Binding)!;
  assert.deepEqual(identities(host), story.identities);
  assert.equal(original.submissionReceipt, undefined);
  const found = await host.port.find(original); assert(found);
  assert.equal(found.taskId, story.r2Receipt.taskId);
  assert.equal(found.operationId, story.r2Receipt.operationId);
  assert.equal(found.submissionId, story.r2Receipt.submissionId, "recovery must locate the exact original native submission");
  assert.equal(found.status, "done", "the original receipt progresses from placed to done without changing identity");
  await host.native.resumePersisted();
  await host.flushUntil(() => works.repo.getBinding(story.r2Binding)?.status === "completed", "recover original terminal native facts");
  await host.adapter.flush();
  assert.deepEqual(identities(host), story.identities, "lost receipt recovery cannot create another binding/root");
  assert.deepEqual(host.counts(), story.beforeRecovery, "recovery reads native history without rerunning tools or models");
  assert.equal("budget" in works.getWork(story.workA)!, false, "receipt recovery cannot restore retired quota state");
  const late = works.repo.listDeliverables(story.workA).find(item => item.executionId === story.r1Binding)!; assert(late);
  assert.equal(late.status, "superseded");
  const refuseLate = reviewWork(works, user, { kind: "accept_deliverable", request: { operationId: "refuse-late-r1", workId: story.workA,
    deliverableId: late.deliverableId, versionGuard: guard(works.getWork(story.workA)!) } });
  assert(!refuseLate.ok && refuseLate.code === "version_conflict");
  assert.deepEqual(works.getWork(story.workA)!.acceptedDeliverableIds, []);
  assert.equal(works.cards.list(works.getWork(story.workA)!).filter(card => card.currency === "current").length, 0);
  assert.equal(works.repo.listNotifications(story.workA).filter(item => item.kind === "result").length, 0);
  host.step(5, "r1 真实原生日志晚到后仅归档历史，r2 当前成果与完成通知保持隔离", { late, recoveredIdentity: identity(works.repo.getBinding(story.r2Binding)!), counts: host.counts() });

  const conflicting = works.repo.listDeliverables(story.workA).find(item => item.executionId === story.r2Binding && !item.deliverableId.startsWith("partial:"))!;
  assert(conflicting?.hasWriteConflicts);
  const observation = await host.port.inspect(original, found);
  assert(observation.status !== "running" && observation.hasWriteConflicts);
  const items = works.partialResults.list(story.workA), gaps = works.partialResults.gaps(story.workA);
  const retained = items.find(item => item.bindingId === story.r2Binding && item.outcome === "completed")!;
  const blocked = items.find(item => item.bindingId === story.r2Binding && item.outcome === "blocked")!;
  assert(retained?.deliverableId); assert(blocked?.writeConflicts.length); assert.equal(gaps.length, 1);
  assert.equal(gaps[0].itemId, blocked.itemId);
  assert((host.ledger.prepare("SELECT COUNT(*) AS count FROM model_calls WHERE model='blocked' AND last_error=1").get() as { count: number }).count > 0,
    "the blocked real child must actually see a toolResult isError");
  const refused = reviewWork(works, user, { kind: "accept_deliverable", request: { operationId: "refuse-conflicting-root", workId: story.workA,
    deliverableId: conflicting.deliverableId, versionGuard: guard(works.getWork(story.workA)!) } });
  assert(!refused.ok && refused.code === "unmet_acceptance_criteria");
  unwrap(reviewWork(works, user, { kind: "reject_deliverable", request: { operationId: "review-conflicting-root", workId: story.workA,
    deliverableId: conflicting.deliverableId, reason: "原汇总含被阻止的必要写入；只保留已核验子项并对缺口单独补跑",
    versionGuard: guard(works.getWork(story.workA)!) } }));
  assert.equal(works.getWork(story.workA)!.lifecycle, "active");
  host.setDispatchModel("phase5/root");
  unwrap(works.continueWork(user, { operationId: "only-blocked-gap", workId: story.workA, sourceBindingId: story.r2Binding,
    gapItemIds: [blocked.itemId], reason: "仅补齐被实际并行写冲突阻止的 gap-two，保留 retain-one", versionGuard: guard(works.getWork(story.workA)!) }));
  await host.flushUntil(() => works.partialResults.gaps(story.workA).length === 0 && host.effectCount("gap-two") === 1, "native continuation for only the necessary gap");
  const continuation = works.repo.listBindings(story.workA).find(binding => ![story.r1Binding, story.r2Binding].includes(binding.bindingId))!; assert(continuation);
  assert.equal(works.partialResults.plans(story.workA).length, 1);
  assert.equal(host.effectCount("retain-one"), 1); assert.equal(host.effectCount("must-not-write"), 0); assert.equal(host.effectCount("gap-two"), 1);
  assert.equal(hash(readFileSync(join(host.cwd, "shared-result.txt"))), story.preservedHash);
  assert.equal(works.getWork(story.workA)!.lifecycle, "active");
  host.step(6, "真实并行 child 写入冲突，isError/blocked 保留，仅原生补跑缺口且成功分支零重跑", { retained, blocked,
    continuation: identity(continuation), plans: works.partialResults.plans(story.workA), counts: host.counts() });

  const current = works.getWork(story.workA)!;
  unwrap(works.attestCriteria(user, { operationId: "automatic-checks", workId: story.workA,
    criterionUpdates: [{ criterionId: current.criteria[0].id, status: "met", evidence: "隔离文件校验与原生子项检查通过，sha256 " + story.preservedHash }], versionGuard: guard(current) }));
  const completedChild = works.partialResults.list(story.workA).find(item => item.bindingId === continuation.bindingId && item.outcome === "completed")!;
  assert(completedChild.deliverableId);
  for (const deliverableId of [retained.deliverableId!, completedChild.deliverableId, `result:${continuation.bindingId}`]) unwrap(reviewWork(works, user, { kind: "accept_deliverable", request: {
    operationId: `review:${deliverableId}`, workId: story.workA, deliverableId, versionGuard: guard(works.getWork(story.workA)!) } }));
  const pending = works.getWorkSummary(LOCAL_USER_ID, story.workA)!;
  assert.equal(pending.lifecycle, "active"); assert(pending.artifactSnapshotId);
  assert(pending.unverifiedScope.some(item => item.requiredEnvironment === "omarchy"));
  assert(pending.nextSteps.some(text => /实测|验收/.test(text)));
  assert(works.artifacts.capture(story.workA).observed.length >= 2, "actual native artifact refs must have durable fingerprints");
  const earlyClose = reviewWork(works, user, { kind: "close", request: { operationId: "refuse-premature-close", workId: story.workA,
    conclusion: "succeeded", confirmed: true, closureSummary: "自动检查结束", versionGuard: guard(works.getWork(story.workA)!) } });
  assert(!earlyClose.ok && earlyClose.code === "unmet_acceptance_criteria");
  host.step(7, "代码和自动检查通过，受信任评审采纳真实产物，明确等待 Omarchy 实测且不能提前关闭", pending);

  const phone = await openPhone(host);
  try {
    story.phoneToken = phone.token;
    const initialPhone = useRemoteWorkStore.getState().works.find(work => work.workId === story.workA)!; assert(initialPhone);
    assert.equal(initialPhone.artifactSnapshotId, pending.artifactSnapshotId);
    const environmentCriterion = works.getWork(story.workA)!.criteria[1].id;
    const fail = await phone.client.workFeedback(story.workA, { operationId: "paired-phone-step2-failed", criterionIds: [environmentCriterion],
      environment: "omarchy", sourceRef: "protocol-fixture:current-r2", inputSnapshotId: initialPhone.inputSnapshotId,
      artifactSnapshotId: initialPhone.artifactSnapshotId, versionGuard: guard(works.getWork(story.workA)!), failed: true,
      detail: "第二步失败（隔离协议夹具用户反馈，不是物理 Omarchy 实测声明）" });
    assert.equal(fail.ok, true); assert.equal(works.getWork(story.workA)!.criteria[1].status, "failed");
    unwrap(works.addParticipant(user, { operationId: "add-repair-collaborator", workId: story.workA, botId: "phase5-collaborator", role: "collaborator",
      delegatedScope: ["workspace:read", "workspace:write", "delegate"], versionGuard: guard(works.getWork(story.workA)!) }));
    const repair = await host.directSubmission(story.workA, "phase5-collaborator-repair", "phase5/repair", "phase5-collaborator");
    await waitFor(() => host.effectCount("repair-v2") === 1, "actual collaborator repair artifact before handoff");
    assert.equal((await host.port.inspect(repair.binding, repair.receipt)).status, "running");
    const handoff = unwrap(works.handoffOwner(user, { operationId: "handoff-during-repair", workId: story.workA,
      targetBotId: "phase5-next-owner", versionGuard: guard(works.getWork(story.workA)!) }));
    assert.equal(handoff.ownerEpoch, 2);
    const oldOwner = works.closeWork({ kind: "bot", host: "foreground", botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, grants }, {
      operationId: "old-owner-cannot-close", workId: story.workA, conclusion: "cancelled", closureSummary: "stale owner",
      versionGuard: { ...guard(handoff), expectedOwnerEpoch: 1 } });
    assert(!oldOwner.ok && ["epoch_mismatch", "unauthorized_actor"].includes(oldOwner.code));
    host.repairGate.release(); await host.native.submissionStatus(repair.receipt, true);
    await host.flushUntil(() => works.repo.getBinding(repair.binding.bindingId)?.status === "completed", "handoff adoption and actual repair settlement");
    assert(works.collaboration.isDelegationAdopted(works.repo.getBinding(repair.binding.bindingId)!, works.getWork(story.workA)!));
    unwrap(reviewWork(works, user, { kind: "accept_deliverable", request: { operationId: "review-repair", workId: story.workA,
      deliverableId: `result:${repair.binding.bindingId}`, versionGuard: guard(works.getWork(story.workA)!) } }));
    const repaired = works.getWorkSummary(LOCAL_USER_ID, story.workA)!;
    assert.notEqual(repaired.artifactSnapshotId, initialPhone.artifactSnapshotId, "new repair produces a new tested artifact set");
    assert.equal(works.getWork(story.workA)!.criteria[1].status, "pending", "new artifacts invalidate the old environment outcome");
    await assert.rejects(phone.client.workFeedback(story.workA, { operationId: "old-phone-cannot-certify-repair", criterionIds: [environmentCriterion],
      environment: "omarchy", sourceRef: "protocol-fixture:old-artifacts", inputSnapshotId: initialPhone.inputSnapshotId,
      artifactSnapshotId: initialPhone.artifactSnapshotId, versionGuard: guard(works.getWork(story.workA)!), failed: false }),
    error => error instanceof RemoteApiError && error.status === 409 && error.code === "version_conflict");
    assert.equal(works.getWork(story.workA)!.criteria[1].status, "pending", "stale phone evidence cannot certify repaired artifacts");
    assert.equal(readFileSync(join(host.cwd, "repair-v2.txt"), "utf8"), "repair-v2\n");
    assert.equal(hash(readFileSync(join(host.cwd, "shared-result.txt"))), story.preservedHash);
    unwrap(works.attestCriteria(user, { operationId: "automatic-checks-after-repair", workId: story.workA,
      criterionUpdates: [{ criterionId: works.getWork(story.workA)!.criteria[0].id, status: "met",
        evidence: "修复后重新核验当前产物及保留成功分支，sha256 " + hash(readFileSync(join(host.cwd, "repair-v2.txt"))) }],
      versionGuard: guard(works.getWork(story.workA)!) }));
    await useRemoteWorkStore.getState().refresh(phone.client);
    host.step(8, "真实配对 Remote 反馈失败、原生协作者修复期间交接，旧负责人和旧手机产物版本均被拒绝", {
      beforeArtifact: initialPhone.artifactSnapshotId, afterArtifact: repaired.artifactSnapshotId, repair: identity(repair.binding), ownerEpoch: handoff.ownerEpoch });

    const bBefore = works.getWork(story.workB)!, cursorBefore = works.ingress.cursor(story.subB, "hook", "B");
    const reviewed = useRemoteWorkStore.getState().works.find(work => work.workId === story.workA)!;
    const passed = await phone.client.workFeedback(story.workA, { operationId: "paired-phone-current-passed", criterionIds: [environmentCriterion],
      environment: "omarchy", sourceRef: "protocol-fixture:repaired-r2", inputSnapshotId: reviewed.inputSnapshotId,
      artifactSnapshotId: reviewed.artifactSnapshotId, versionGuard: guard(works.getWork(story.workA)!), failed: false,
      detail: "当前版本步骤通过（仅测试受信任反馈协议；物理设备实测另行取证）" });
    assert(passed.ok);
    story.desktopBeforeClose = host.journal.sync(LOCAL_USER_ID, { includeClosed: true });
    const cardsBefore = works.cards.list(works.getWork(story.workA)!).map(card => card.semanticCardKey).sort();
    unwrap(reviewWork(works, user, { kind: "close", request: { operationId: "user-close-finite-watch", workId: story.workA, conclusion: "succeeded", confirmed: true,
      closureSummary: "有限职责停止条件已有当前版本受信任反馈，用户确认结束（协议验收夹具）", versionGuard: guard(works.getWork(story.workA)!) } }));
    const closed = works.getWork(story.workA)!;
    assert.equal(closed.lifecycle, "closed"); assert.equal(closed.closureConclusion, "succeeded");
    assert.deepEqual(works.cards.list(closed).map(card => card.semanticCardKey).sort(), cardsBefore, "closing after acceptance reuses its semantic card");
    assert(works.repo.listSubscriptions(story.workA, { includeStopped: true }).every(subscription => subscription.stoppedAt !== undefined));
    assert.deepEqual(works.ingress.cursor(story.subB, "hook", "B"), cursorBefore);
    assert.deepEqual(workControlState(works.getWork(story.workB)!), workControlState(bBefore));
    assert.equal(works.getWork(story.workB)!.lifecycle, "active");
    const aBindings = works.repo.listBindings(story.workA).map(identity), aEffects = host.counts();
    works.ingestSourceEvent({ source: "hook", sourceEventId: "closed-A-late-hook", sourceVersion: "3", eventType: "changed", payload: { target: "A" } });
    works.tick(Date.now() + 5000); await host.queue.flush();
    assert.deepEqual(works.repo.listBindings(story.workA).map(identity), aBindings);
    assert.deepEqual(host.counts(), aEffects, "closed finite watch cannot be resurrected by future source/tick");
    host.setDispatchModel("phase5/watch");
    works.ingestSourceEvent({ source: "hook", sourceEventId: "B-still-watching", sourceVersion: "3", eventType: "changed", payload: { target: "B" } });
    await host.flushUntil(() => host.effectCount("watch-b") === 1 && works.repo.listBindings(story.workB).some(binding => binding.status === "completed"), "B continues independently after A closed");
    assert.equal(works.getWork(story.workB)!.lifecycle, "active");
    assert.deepEqual(works.repo.listBindings(story.workA).map(identity), aBindings);
    assert.equal(works.ingress.cursor(story.subB, "hook", "B")?.highestConsumedVersion, "3");
    assert.equal("budget" in works.getWork(story.workA)!, false);
    assert.equal("budget" in works.getWork(story.workB)!, false);
    story.finalCardKey = works.cards.list(closed).filter(card => card.currency === "current").at(-1)!.semanticCardKey;
    host.step(9, "当前版本反馈后用户关闭有限 Watch A；A 停止唤醒，B 的原授权/游标不受清理影响并继续真实执行", {
      conclusion: closed.closureConclusion, subscriptions: works.repo.listSubscriptions(story.workA, { includeStopped: true }),
      bBinding: works.repo.listBindings(story.workB).map(identity), counts: host.counts() });
  } finally { await phone.close(); }
  assert(works.phase5.flushOwnerSummaries() > 0, "the production summary pump persists the accepted team's delivery obligation before the kill");
  assert(works.repo.listNotifications(story.workA).some(notification => notification.delivery !== "sent"));
  story.pendingNotificationIds = works.repo.listNotifications(story.workA).map(notification => notification.notificationId).sort();
  assert.equal((host.ledger.prepare("SELECT COUNT(*) AS count FROM notifications").get() as { count: number }).count, 0);
  story.beforeDelivery = host.counts(); story.beforeDeliveryIdentities = identities(host);
  story.beforeDeliveryWorkState = { a: workControlState(works.getWork(story.workA)!), b: workControlState(works.getWork(story.workB)!) }; saveStory(host.root, story);
  checkpoint(host.root, 2, "accepted-and-closed-before-notification");
}

async function stageThree(host: NativeHost) {
  const story = readStory(host.root), { works } = host;
  assert.equal(works.getWork(story.workA)!.lifecycle, "closed");
  await host.native.resumePersisted(); await host.queue.flush(); await host.adapter.flush();
  assert.deepEqual(host.counts(), story.beforeDelivery, "second restart may only recover delivery, never models or business tools");
  assert.deepEqual(identities(host), story.beforeDeliveryIdentities);
  assert.deepEqual({ a: workControlState(works.getWork(story.workA)!), b: workControlState(works.getWork(story.workB)!) }, story.beforeDeliveryWorkState);
  let failFirst = true;
  const channel: WorkNotificationChannel = { channel: "fixture-desktop", deliveryGuarantee: "idempotent-queryable", supportsIdempotencyKey: true, supportsReceiptQuery: true,
    lookup: ({ idempotencyKey }) => host.ledger.prepare("SELECT 1 FROM notifications WHERE effect_key=?").get(idempotencyKey) ? "delivered" : "missing",
    send: ({ idempotencyKey }) => {
      if (failFirst) { failFirst = false; return { ok: false, retryable: true, responseLost: false, error: "known isolated channel outage" }; }
      const receipt = `fixture-receipt:${idempotencyKey}`;
      assert(!host.ledger.prepare("SELECT 1 FROM notifications WHERE effect_key=?").get(idempotencyKey), "queryable recovery may not repeat a delivered effect");
      host.ledger.prepare("INSERT INTO notifications(effect_key,receipt) VALUES (?,?)").run(idempotencyKey, receipt);
      return { ok: true, receipt };
    } };
  const notifications = new WorkNotificationHost(works, { isAuthority: () => host.lease.isAuthority(), channels: () => [channel], onError: error => { throw error; } });
  notifications.drain(story.workA); notifications.drain(story.workA); notifications.drain(story.workA);
  const actual = works.repo.listNotifications(story.workA);
  assert.deepEqual(actual.map(notification => notification.notificationId).sort(), story.pendingNotificationIds, "notification identity must survive recovery unchanged");
  assert.equal(actual.length, 1, "the team's accepted outcome has one owner summary notification");
  assert.equal(actual[0].kind, "summary"); assert.equal(actual[0].delivery, "sent");
  const attempts = works.notifications.attempts(actual[0].notificationId);
  assert.deepEqual(attempts.map(attempt => attempt.status), ["failed", "sent"]);
  assert(attempts[0].providerEffectKey);
  assert.equal(attempts[0].providerEffectKey, attempts[1].providerEffectKey);
  assert.equal(attempts[0].payloadHash, attempts[1].payloadHash);
  assert.deepEqual(host.counts(), story.beforeDelivery);
  const externalCount = (host.ledger.prepare("SELECT COUNT(*) AS count FROM notifications").get() as { count: number }).count;
  notifications.drain(story.workA);
  assert.equal((host.ledger.prepare("SELECT COUNT(*) AS count FROM notifications").get() as { count: number }).count, externalCount);

  const phone = await openPhone(host, story.phoneToken);
  try {
    assert(story.desktopBeforeClose?.kind === "snapshot");
    let desktop = mergeWorkList([], null, story.desktopBeforeClose)!;
    const applyJournal = () => {
      for (let page = 0; page < 50; page++) {
        const update = host.journal.sync(LOCAL_USER_ID, { includeClosed: true, cursor: desktop.cursor });
        const applied = mergeWorkList(desktop.works, desktop.cursor, update); assert(applied); desktop = applied;
        if (update.kind !== "delta" || !update.hasMore) return;
      }
      assert.fail("bounded journal paging did not converge");
    };
    applyJournal();
    const beforeRead = works.getWork(story.workA)!;
    assert(story.finalCardKey);
    const read = await useRemoteWorkStore.getState().markCardRead(phone.client, story.workA, story.finalCardKey);
    assert(read.ok); assert.equal(works.getWork(story.workA)!.stateVersion, beforeRead.stateVersion);
    applyJournal(); await useRemoteWorkStore.getState().refresh(phone.client);
    const desktopA = desktop.works.find(work => work.workId === story.workA)!;
    const mobileA = useRemoteWorkStore.getState().works.find(work => work.workId === story.workA)!;
    assert.equal(desktopA.lifecycle, "closed"); assert.equal(mobileA.closureConclusion, "succeeded");
    assert.equal(desktopA.intentRevision, mobileA.intentRevision); assert.equal(desktopA.ownerEpoch, mobileA.ownerEpoch);
    assert.deepEqual((desktopA.cards ?? []).map(card => [card.semanticCardKey, card.readAt]), mobileA.cards.map(card => [card.semanticCardKey, card.readAt]));
    const allKeys = useRemoteWorkStore.getState().works.map(work => work.workId).sort();
    useRemoteWorkStore.getState().setIncludeClosed(false); await useRemoteWorkStore.getState().refresh(phone.client);
    assert(!useRemoteWorkStore.getState().works.some(work => work.workId === story.workA));
    assert(useRemoteWorkStore.getState().works.some(work => work.workId === story.workB));
    useRemoteWorkStore.getState().setIncludeClosed(true); await useRemoteWorkStore.getState().refresh(phone.client);
    assert.deepEqual(useRemoteWorkStore.getState().works.map(work => work.workId).sort(), allKeys);
    const obsolete = { ...desktop.cursor, epoch: "obsolete-client-epoch" };
    assert.equal(host.journal.sync(LOCAL_USER_ID, { includeClosed: true, cursor: obsolete }).kind, "resync_required");
    desktop = mergeWorkList(desktop.works, obsolete, host.journal.sync(LOCAL_USER_ID, { includeClosed: true }))!;
    assert.equal(desktop.cursor.epoch, useRemoteWorkStore.getState().cursor!.epoch);
    const diagnostics = await phone.client.workDiagnostics(story.workA, { limit: 100 });
    const evidence = JSON.stringify(diagnostics);
    assert(evidence.includes("phase5-next-owner") || evidence.includes('"ownerEpoch":2'));
    assert(evidence.includes("gap") || evidence.includes("continuation") || evidence.includes("subitem"));
    assert(!evidence.includes('"budget"') && !evidence.includes('"usedTokens"'), "expanded diagnostics do not restore retired quota state");
    assert.deepEqual(host.counts(), story.beforeDelivery);
    assert.deepEqual(identities(host), story.beforeDeliveryIdentities);
    host.step(10, "第二次真实强杀后仅补通知，已投递效果不重复；真实桌面 reducer 与配对 Remote 增量/快照/只读事实收敛", {
      counts: host.counts(), notifications: actual, attempts, workState: story.beforeDeliveryWorkState, physicalNotificationEffects: externalCount,
      cursor: desktop.cursor, desktop: { workId: desktopA.workId, lifecycle: desktopA.lifecycle, intentRevision: desktopA.intentRevision, ownerEpoch: desktopA.ownerEpoch },
      mobile: { workId: mobileA.workId, lifecycle: mobileA.lifecycle, intentRevision: mobileA.intentRevision, ownerEpoch: mobileA.ownerEpoch }, diagnostics });
  } finally { await phone.close(); notifications.stop(); }
  const steps = (host.ledger.prepare("SELECT number,name,evidence_json FROM steps ORDER BY number").all() as Array<{ number: number; name: string; evidence_json: string }>)
    .map(({ evidence_json, ...step }) => ({ ...step, evidence: JSON.parse(evidence_json) }));
  assert.equal(steps.length, 10);
  const storyCounts = host.counts();
  const provenance = await verifyNativeInputProvenance(host);
  const report = { provenance, environment: "headless production Pi Durable native processes; isolated model and effect fixtures",
    physicalDevicesVerified: false, database: join(host.root, "business.db"), nativeDirectory: join(host.root, "native"),
    processId: process.pid, storyCounts, counts: host.counts(), identities: identities(host), steps,
    modelCalls: host.ledger.prepare("SELECT * FROM model_calls ORDER BY id").all(),
    writeEffects: host.ledger.prepare("SELECT * FROM effects ORDER BY id").all() };
  writeFileSync(join(host.root, "result.json"), JSON.stringify(report, null, 2));
  console.log("PASS Phase5 continuous native story: 10 steps, same durable stores, actual model/tool counts, two parent-issued SIGKILL boundaries, no business replay on recovery");
}

async function waitForKilledOwner(root: string, pid: number) {
  const database = new Database(join(root, "business.db"), { readonly: true, fileMustExist: true });
  const lease = database.prepare("SELECT authority_id,heartbeat_at,released_at FROM work_host_lease WHERE lease_id='singleton'").get() as { authority_id: string; heartbeat_at: number; released_at: number | null };
  database.close();
  assert.equal(lease.authority_id, `host-${pid}`); assert.equal(lease.released_at, null, "the kill must not invoke graceful lease release");
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    return Date.now() - lease.heartbeat_at > HOST_LEASE_TTL_MS;
  }, "OS process absent and persisted authority lease expired");
  return lease;
}
async function runParent() {
  const root = await mkdtemp(join(tmpdir(), "phase5-native-story-")), kills: unknown[] = [];
  const outputDir = join(process.cwd(), "out", "diagnostics", "bot-work-phase5-native-story"); mkdirSync(outputDir, { recursive: true });
  let complete = false;
  try {
    for (const stage of [1, 2, 3]) {
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--host", String(stage), root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = ""; child.stdout.on("data", value => { output += String(value); process.stdout.write(value); }); child.stderr.on("data", value => { output += String(value); process.stderr.write(value); });
      const exited = new Promise<void>(done => child.once("close", () => done()));
      try {
        if (stage < 3) {
          await waitFor(() => {
            if (child.exitCode !== null || child.signalCode !== null) throw Error(`host stage ${stage} exited unexpectedly\n${output}`);
            return existsSync(join(root, `checkpoint-${stage}.json`));
          }, `native story stage ${stage} checkpoint`, 75000);
          const marker = JSON.parse(readFileSync(join(root, `checkpoint-${stage}.json`), "utf8"));
          assert.equal(marker.pid, child.pid); assert.equal(marker.stage, stage);
          assert(child.kill("SIGKILL")); await exited;
          const lease = await waitForKilledOwner(root, child.pid!); kills.push({ ...marker, requestedSignal: "SIGKILL", exitCode: child.exitCode, signalCode: child.signalCode, lease });
          console.log(`PASS actual SIGKILL ${stage}: ${marker.label}; original owner absent, lease unreleased and expired`);
        } else {
          await waitFor(() => child.exitCode !== null || child.signalCode !== null, "final story host exit", 75000); await exited;
          assert.equal(child.exitCode, 0, `final story host failed\n${output}`);
        }
      } finally { writeFileSync(join(outputDir, `stage-${stage}.log`), output); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; } }
    }
    const report = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
    writeFileSync(join(outputDir, "evidence.json"), JSON.stringify({ ...report, kills }, null, 2));
    assert.equal(kills.length, 2); complete = true;
    console.log(`Native story evidence: ${join(outputDir, "evidence.json")}`);
  } finally {
    if (complete) await rm(root, { recursive: true, force: true });
    else console.error(`Failed native story fixture retained for diagnosis: ${root}`);
  }
}
if (process.argv[2] === "--host") {
  const stage = Number(process.argv[3]), host = await openNativeHost(process.argv[4]!, stage);
  try { if (stage === 1) await stageOne(host); else if (stage === 2) await stageTwo(host); else await stageThree(host); }
  finally { await host.close(); }
} else await runParent();
