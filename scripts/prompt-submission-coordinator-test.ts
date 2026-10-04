import assert from "node:assert/strict";
import { PromptSubmissionCoordinator } from "../src/main/agent/PromptSubmissionCoordinator";
import type { SessionEntry } from "../src/main/agent/SessionRegistry";

interface FakeSdkSession {
  isStreaming: boolean;
  clearQueueCalls: number;
  restoredFollowUps: string[];
  clearQueue(): { steering: string[]; followUp: string[] };
  followUp(text: string): Promise<void>;
  dispose(): void;
}

function makeEntry(opts: {
  streaming?: boolean;
  sdkFollowUps?: string[];
  pendingTurns?: SessionEntry["pendingAssistantTurns"];
} = {}): { entry: SessionEntry; sdk: FakeSdkSession } {
  const sdk: FakeSdkSession = {
    isStreaming: Boolean(opts.streaming),
    clearQueueCalls: 0,
    restoredFollowUps: [],
    clearQueue() {
      this.clearQueueCalls += 1;
      return { steering: ["sdk-old-steer"], followUp: [...(opts.sdkFollowUps ?? [])] };
    },
    async followUp(text: string) {
      this.restoredFollowUps.push(text);
    },
    dispose() {},
  };
  const entry: SessionEntry = {
    taskId: "task-1",
    session: sdk as unknown as SessionEntry["session"],
    unsubscribe() {},
    cwd: "C:/tmp/task-1",
    permissionMode: "default",
    assistantMessageId: "assistant-current",
    executionId: "execution-current",
    startedAt: 100,
    pendingAssistantTurns: opts.pendingTurns ? [...opts.pendingTurns] : [],
    promptSubmissionTail: Promise.resolve(),
    promptQueueEpoch: 0,
    pendingApprovals: new Map(),
    pendingExternalWrites: new Map(),
    grantedExternalWriteToolCalls: new Set(),
  };
  return { entry, sdk };
}

async function main(): Promise<void> {
  const coordinator = new PromptSubmissionCoordinator();

  // 1. Streaming session must declare intent; no silent followUp fallback.
  {
    const { entry } = makeEntry({ streaming: true });
    const result = coordinator.begin(entry, {
      assistantMessageId: "assistant-missing-behavior",
      executionId: "execution-missing-behavior",
      startedAt: 110,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "STREAMING_BEHAVIOR_REQUIRED");
    assert.equal(entry.pendingAssistantTurns.length, 0);
  }

  // 2. Idle prompt ignores queue semantics and becomes the current assistant target.
  {
    const { entry } = makeEntry({ streaming: false });
    const result = coordinator.begin(entry, {
      assistantMessageId: "assistant-idle",
      executionId: "execution-idle",
      startedAt: 120,
    });
    assert(result.ok);
    assert.equal(result.context.wasStreaming, false);
    assert.equal(result.context.behavior, "followUp");
    assert.equal(entry.assistantMessageId, "assistant-idle");
    assert.equal(entry.executionId, "execution-idle");
    assert.equal(entry.startedAt, 120);
    assert.equal(coordinator.enqueue(entry, result.context), "ready");
    assert.equal(entry.pendingAssistantTurns.length, 0, "idle prompt is current, not queued");
  }

  // 3. followUp preserves existing order and never clears the SDK queue.
  {
    const { entry, sdk } = makeEntry({
      streaming: true,
      pendingTurns: [{
        messageId: "assistant-existing-followup",
        executionId: "execution-existing-followup",
        queuedAt: 130,
        behavior: "followUp",
      }],
    });
    const result = coordinator.begin(entry, {
      streamingBehavior: "followUp",
      assistantMessageId: "assistant-followup",
      executionId: "execution-followup",
      startedAt: 140,
    });
    assert(result.ok);
    assert.equal(coordinator.enqueue(entry, result.context), "ready");
    assert.deepEqual(
      entry.pendingAssistantTurns.map((turn) => turn.messageId),
      ["assistant-existing-followup", "assistant-followup"],
    );
    assert.equal(sdk.clearQueueCalls, 0);
  }

  // 4. New steer preserves older steers and never mutates native Pi queues.
  {
    const { entry, sdk } = makeEntry({
      streaming: true,
      sdkFollowUps: ["sdk-followup-1", "sdk-followup-2"],
      pendingTurns: [
        {
          messageId: "assistant-old-steer",
          executionId: "execution-old-steer",
          queuedAt: 145,
          behavior: "steer",
        },
        {
          messageId: "assistant-old-followup",
          executionId: "execution-old-followup",
          queuedAt: 146,
          behavior: "followUp",
        },
      ],
    });
    const cancelledExecutions: string[] = [];
    const superseded: string[] = [];
    const result = coordinator.begin(
      entry,
      {
        streamingBehavior: "steer",
        assistantMessageId: "assistant-new-steer",
        executionId: "execution-new-steer",
        startedAt: 150,
      },
    );
    assert(result.ok);
    assert.deepEqual(cancelledExecutions, []);
    assert.equal(
      coordinator.enqueue(entry, result.context),
      "ready",
    );
    assert.equal(sdk.clearQueueCalls, 0);
    assert.deepEqual(sdk.restoredFollowUps, []);
    assert.deepEqual(superseded, []);
    assert.deepEqual(
      entry.pendingAssistantTurns.map((turn) => `${turn.behavior}:${turn.messageId}`),
      ["steer:assistant-old-steer", "steer:assistant-new-steer", "followUp:assistant-old-followup"],
      "steer must be inserted before queued followUps",
    );
  }

  // 5. Abort/stop epoch invalidates async preprocessing before it can enqueue.
  {
    const { entry } = makeEntry({ streaming: true });
    const cancelled: string[] = [];
    const result = coordinator.begin(entry, {
      streamingBehavior: "followUp",
      assistantMessageId: "assistant-stale-epoch",
      executionId: "execution-stale-epoch",
      startedAt: 160,
    });
    assert(result.ok);
    entry.promptQueueEpoch += 1;
    assert.equal(
      coordinator.enqueue(entry, result.context, { onCancelledTurn: (messageId) => cancelled.push(messageId) }),
      "cancelled",
    );
    assert.deepEqual(cancelled, ["assistant-stale-epoch"]);
    assert.equal(entry.pendingAssistantTurns.length, 0);
  }

  // 6. Both explicitly submitted steers survive; Pi decides when to consume them.
  {
    const { entry, sdk } = makeEntry({ streaming: true });
    const first = coordinator.begin(entry, {
      streamingBehavior: "steer",
      assistantMessageId: "assistant-steer-1",
      executionId: "execution-steer-1",
      startedAt: 170,
    });
    const second = coordinator.begin(entry, {
      streamingBehavior: "steer",
      assistantMessageId: "assistant-steer-2",
      executionId: "execution-steer-2",
      startedAt: 171,
    });
    assert(first.ok && second.ok);
    const superseded: string[] = [];
    assert.equal(
      coordinator.enqueue(entry, first.context),
      "ready",
    );
    assert.deepEqual(superseded, []);
    assert.equal(sdk.clearQueueCalls, 0, "stale steer must not touch SDK queue");
    assert.equal(coordinator.enqueue(entry, second.context), "ready");
    assert.equal(sdk.clearQueueCalls, 0);
    assert.deepEqual(entry.pendingAssistantTurns.map((turn) => turn.messageId), ["assistant-steer-1", "assistant-steer-2"]);
  }

  // 7. Submission lock serializes queue mutation for streaming requests.
  {
    const { entry } = makeEntry({ streaming: true });
    const first = coordinator.begin(entry, {
      streamingBehavior: "followUp",
      assistantMessageId: "assistant-lock-1",
      executionId: "execution-lock-1",
      startedAt: 180,
    });
    const second = coordinator.begin(entry, {
      streamingBehavior: "followUp",
      assistantMessageId: "assistant-lock-2",
      executionId: "execution-lock-2",
      startedAt: 181,
    });
    assert(first.ok && second.ok);
    const releaseFirst = await coordinator.acquire(entry, first.context);
    assert(releaseFirst);
    let secondAcquired = false;
    const secondAcquire = coordinator.acquire(entry, second.context).then((release) => {
      secondAcquired = true;
      return release;
    });
    await Promise.resolve();
    assert.equal(secondAcquired, false, "second mutation waits for first submission lock");
    releaseFirst();
    const releaseSecond = await secondAcquire;
    assert.equal(secondAcquired, true);
    releaseSecond?.();
  }

  // 8. Failed queued prompt cleanup removes only its own pending turn.
  {
    const { entry } = makeEntry({
      streaming: true,
      pendingTurns: [
        { messageId: "keep", executionId: "exec-keep", queuedAt: 190, behavior: "followUp" },
        { messageId: "remove", executionId: "exec-remove", queuedAt: 191, behavior: "followUp" },
      ],
    });
    coordinator.removeQueuedTurn(entry, "remove");
    assert.deepEqual(entry.pendingAssistantTurns.map((turn) => turn.messageId), ["keep"]);
  }

  console.log("prompt submission coordinator: PASS");
}

void main();