import assert from "node:assert/strict";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { BotWorkApi } from "../src/shared/bot-work-ipc";
import { createAppStore } from "../src/renderer/src/store/app/createAppStore";

function work(workId: string, stateVersion = 1): WorkProjectionDto {
  return {
    workId, title: workId, ownerBotId: "bot-review", ownerEpoch: 1,
    mode: "once", lifecycle: "active", intentRevision: 1, sourceVersion: 1,
    stateVersion, inputSnapshotId: "input-review", inputSnapshotBound: true,
    goalSources: [], criteria: [], acceptedDeliverableIds: [], deliverables: [],
    blockers: [], executions: [], notifications: [], subscriptionIds: [],
    uncoveredScope: [], nextSteps: [], updatedAt: stateVersion,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(listWorks: BotWorkApi["listWorks"]) {
  const api = {
    botWork: {
      listBots: async () => [{ botId: "bot-review" }] as BotDto[],
      listWorks,
      hostStatus: async () => ({ online: true, isAuthority: true, authorityId: "review-host" }),
      markNotificationRead: async () => ({ ok: true }),
    },
  } as unknown as Window["api"];
  return createAppStore({ getApi: () => api }).useAppStore;
}

async function main(): Promise<void> {
  // An authoritative open-only refresh omits a Work closed while disconnected.
  const closed = fixture(async () => []);
  closed.setState({ botWorks: [work("closed-offline")], selectedWorkId: "closed-offline" });
  await closed.getState().refreshBotWork();
  assert.deepEqual(closed.getState().botWorks, [], "refresh must remove the stale active card for a Work no longer in the open list");
  assert.equal(closed.getState().selectedWorkId, null);

  // A response captured before a newer push must retain both that Work and its selection.
  const pending = deferred<WorkProjectionDto[]>();
  const pushed = fixture(() => pending.promise);
  pushed.setState({ botWorks: [work("was-open")], selectedWorkId: "was-open" });
  const refreshing = pushed.getState().refreshBotWork();
  pushed.getState().applyWorkProjection(work("created-during-refresh"));
  pushed.getState().setSelectedWorkId("created-during-refresh");
  pending.resolve([]);
  await refreshing;
  assert.deepEqual(pushed.getState().botWorks.map(item => item.workId), ["created-during-refresh"]);
  assert.equal(pushed.getState().selectedWorkId, "created-during-refresh", "resolve selection against the reconciled list");

  // Updated existing items also survive an older list snapshot.
  const changedPending = deferred<WorkProjectionDto[]>();
  const changed = fixture(() => changedPending.promise);
  changed.setState({ botWorks: [work("changed")] });
  const changing = changed.getState().refreshBotWork();
  changed.getState().applyWorkProjection({ ...work("changed", 2), lifecycle: "paused" });
  changedPending.resolve([]);
  await changing;
  assert.equal(changed.getState().botWorks[0]?.lifecycle, "paused");

  // Older overlapping refreshes cannot resurrect a Work omitted by the later refresh.
  const older = deferred<WorkProjectionDto[]>();
  const newer = deferred<WorkProjectionDto[]>();
  let calls = 0;
  const overlap = fixture(() => (++calls === 1 ? older.promise : newer.promise));
  overlap.setState({ botWorks: [work("closed-overlap")] });
  const first = overlap.getState().refreshBotWork();
  const second = overlap.getState().refreshBotWork();
  newer.resolve([]);
  await second;
  older.resolve([work("closed-overlap")]);
  await first;
  assert.deepEqual(overlap.getState().botWorks, [], "an older request cannot replace a newer authoritative refresh");

  // A delayed failure from an older refresh must not replace a newer success.
  const failed = deferred<WorkProjectionDto[]>();
  let errorCalls = 0;
  const recovered = fixture(() => (++errorCalls === 1 ? failed.promise : Promise.resolve([])));
  const failing = recovered.getState().refreshBotWork();
  await recovered.getState().refreshBotWork();
  failed.reject(new Error("obsolete refresh failure"));
  await failing;
  assert.equal(recovered.getState().botWorkError, null);

  // Reading a notification is monotonic even when it does not advance control stateVersion.
  const notificationPending = deferred<WorkProjectionDto[]>();
  const reading = fixture(() => notificationPending.promise);
  const unread: WorkProjectionDto = { ...work("notification"), notifications: [{
    notificationId: "notification-review", workId: "notification", semanticKey: "review-result",
    kind: "closed", title: "Review result", stateVersion: 1, intentRevision: 1,
    delivery: "sent", channel: "in_app", attemptCount: 0, createdAt: 1,
  }] };
  reading.setState({ botWorks: [unread] });
  const loading = reading.getState().refreshBotWork();
  await reading.getState().markBotNotificationRead("notification-review");
  const readAt = reading.getState().botWorks[0].notifications[0].readAt;
  assert(readAt);
  notificationPending.resolve([unread]);
  await loading;
  assert.equal(reading.getState().botWorks[0].notifications[0].readAt, readAt, "a stale list snapshot cannot mark an acknowledged notification unread");
  console.log("bot work review projection: 6 regression scenarios passed");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
