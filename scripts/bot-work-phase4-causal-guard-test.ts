import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

const root = await mkdtemp(join(tmpdir(), "phase4-causal-"));
const path = join(root, "business.db");
let db = new AppDatabase(path);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "owner", authorization: DESKTOP_USER_GRANTS });
bots.registerBot({ userId: LOCAL_USER_ID, botId: "bot-expert", displayName: "expert", authorization: DESKTOP_USER_GRANTS });
let works = new WorkService(db.connection, { bots });
const granting = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: granting };
const unwrap = (result: WorkControlResult) => { if (!result.ok) throw Error(`${result.code}: ${result.message}`); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const create = (id: string) => unwrap(works.createWork(user, { operationId: id, title: id, inputSnapshotId: `input:${id}`,
  authorization: granting, workspacePath: root }));
const admission = (work: WorkDto, operationId: string, extra: Partial<Parameters<WorkService["causal"]["admit"]>[0]> = {}) =>
  works.causal.admit({ workId: work.workId, source: "hook", sourceEventId: `source:${operationId}`,
    inputSnapshotId: work.inputSnapshotId, actionKind: "test-action", operationId, trustedRoot: true, ...extra });

try {
  const a = create("causal-a");
  const rootChain = admission(a, "root");
  assert.equal(rootChain.allowed, true); assert.equal(rootChain.depth, 0); assert.equal(rootChain.hops, 0);

  // A necessary downstream state change is allowed and stays in the same chain.
  const advanced = { step: 1, progress: "advanced" };
  const child = admission(a, "child-state-advanced", { parentChainId: rootChain.chainId, targetState: advanced });
  assert.equal(child.allowed, true); assert.equal(child.depth, 1); assert.equal(child.hops, 1);

  // Same business state with a new operation/message id is still a loop.
  const loop = admission(a, "child-same-state-new-id", { parentChainId: rootChain.chainId, targetState: advanced });
  assert.equal(loop.allowed, false); assert.equal(loop.reasonCode, "causal-loop-guard");
  assert(works.repo.listOpenBlockers(a.workId).some(item => item.reasonCode === "causal-loop-guard"));
  const loopAgain = admission(a, "child-same-state-third-id", { parentChainId: rootChain.chainId, targetState: advanced });
  assert.equal(loopAgain.allowed, false);
  assert.equal(works.repo.listOpenBlockers(a.workId).filter(item => item.reasonCode === "causal-loop-guard").length, 1,
    "a continuing loop updates one blocker instead of spamming one per event");

  // Legitimate fan-out to another Work and another subscription is not globally deduped.
  const b = create("causal-b");
  const otherWork = admission(b, "fanout-other-work", { parentChainId: rootChain.chainId, targetState: advanced });
  assert.equal(otherWork.allowed, true, "the same state on another Work is a separate business target");
  const subOne = admission(a, "sub-one", { subscriptionId: "sub-1", targetState: advanced });
  const subTwo = admission(a, "sub-two", { subscriptionId: "sub-2", targetState: advanced });
  assert.equal(subOne.allowed, true); assert.equal(subTwo.allowed, true);

  // Expert ping-pong is bounded by saved hops; each state change is legal until the limit.
  let parent = rootChain;
  const states = [1, 2, 3, 4, 5].map(step => ({ step }));
  const chain = [a, b, a, b, a];
  const results = states.map((state, index) => {
    const result = admission(chain[index], `ping-${index}`, { parentChainId: parent.chainId, targetState: state });
    parent = result;
    return result;
  });
  for (const result of results.slice(0, 4)) assert.equal(result.allowed, true);
  assert.equal(results[4].allowed, false, "results[4] should be blocked"); assert.equal(results[4].reasonCode, "causal-hops");
  assert(results[4].hops > 4);

  // A forged or deleted reference is attribution-unknown, not a brand-new unlimited root.
  const forged = admission(a, "forged-ref", { causalEventId: "chain-does-not-exist" });
  assert.equal(forged.allowed, false, "forged should be blocked"); assert.equal(forged.reasonCode, "causal-attribution-unknown");

  // A dispatch carrying a blocked chain never starts, while a fresh trusted root still can.
  const deniedDispatch = works.dispatchExecution(user, { operationId: "dispatch-blocked", workId: a.workId, botId: DEFAULT_BOT_ID,
    taskId: "blocked-task", durableStoreKey: "store:blocked", conversationId: "1", workspaceBinding: root,
    causal: { source: "hook", sourceEventId: "blocked-source", causalEventId: rootChain.chainId, trustedRoot: true } });
  assert.equal(deniedDispatch.ok, false);
  if (!deniedDispatch.ok) assert.equal(deniedDispatch.code, "causal_guard");
  assert.equal(works.repo.bindingForTask("blocked-task"), undefined);
  unwrap(works.dispatchExecution(user, { operationId: "dispatch-fresh", workId: b.workId, botId: DEFAULT_BOT_ID,
    taskId: "fresh-task", durableStoreKey: "store:fresh", conversationId: "1", workspaceBinding: root,
    causal: { source: "hook", sourceEventId: "fresh-source", trustedRoot: true } }));

  // Handoff does not reset the chain.
  unwrap(works.handoffOwner(user, { operationId: "handoff", workId: a.workId, targetBotId: "bot-expert",
    versionGuard: guard(works.getWork(a.workId)!) }));
  const afterHandoff = admission(a, "same-state-after-handoff", { parentChainId: rootChain.chainId, targetState: advanced });
  assert.equal(afterHandoff.allowed, false, "afterHandoff should be blocked"); assert.equal(afterHandoff.reasonCode, "causal-loop-guard");

  // Restart keeps the admission ledger and blocker facts.
  db.close(); db = new AppDatabase(path); bots = new BotRegistry(db.connection);
  bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "owner", authorization: DESKTOP_USER_GRANTS });
  bots.registerBot({ userId: LOCAL_USER_ID, botId: "bot-expert", displayName: "expert", authorization: DESKTOP_USER_GRANTS });
  works = new WorkService(db.connection, { bots });
  const afterRestart = admission(a, "same-state-after-restart", { parentChainId: rootChain.chainId, targetState: advanced });
  assert.equal(afterRestart.allowed, false, "afterRestart should be blocked");
  assert.equal(works.causal.list(a.workId).some(item => item.decision === "blocked-loop"), true);
  console.log("Phase 4 BW-A39 causal: trusted chain identity, same-state loop guard, cross-work fan-out, bounded ping-pong, unknown attribution, settlement and restart/handoff persistence passed");
} finally {
  db.close(); await rm(root, { recursive: true, force: true });
}
