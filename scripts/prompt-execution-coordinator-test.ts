import assert from "node:assert/strict";
import type { AgentPromptRequest, AgentPromptResult } from "../src/shared/agent-ipc";
import { PromptExecutionCoordinator } from "../src/main/agent/PromptExecutionCoordinator";
import type { PromptRunState } from "../src/main/agent/PromptRunRegistry";

function request(id: string, streamingBehavior?: "steer" | "followUp"): AgentPromptRequest {
  return {
    taskId: "task-1",
    text: `prompt-${id}`,
    assistantMessageId: `assistant-${id}`,
    userMessageId: `user-${id}`,
    streamingBehavior,
  };
}

function immediate(): Promise<AgentPromptResult> {
  return Promise.resolve({ queued: false });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function main(): Promise<void> {
  // 1. announce + retry retention live in the outer coordinator; retry keeps a structured clone.
  {
    const coordinator = new PromptExecutionCoordinator();
    const announced: string[] = [];
    const req = request("retry");
    const result = await coordinator.execute(req, {
      announceUserMessage: (current) => announced.push(current.userMessageId),
      settleCancelled: () => assert.fail("request should not be cancelled"),
      execute: () => immediate(),
    });
    assert.deepEqual(result, { queued: false });
    assert.deepEqual(announced, ["user-retry"]);
    req.text = "mutated-after-submit";
    assert.equal(coordinator.retryRequest("assistant-retry")?.text, "prompt-retry");
    coordinator.forgetRetry("assistant-retry");
    assert.equal(coordinator.retryRequest("assistant-retry"), undefined);

    const silent = request("silent");
    silent.announceUserMessage = false;
    await coordinator.execute(silent, {
      announceUserMessage: () => assert.fail("announceUserMessage=false must suppress patch callback"),
      settleCancelled: () => assert.fail("request should not be cancelled"),
      execute: () => immediate(),
    });
  }

  // 2. followUp is admitted to Pi once the session is ready, not after the model completes.
  {
    const coordinator = new PromptExecutionCoordinator();
    let resolveFirst!: () => void;
    let firstReady!: () => void;
    let firstStarted = false;
    const firstPromise = coordinator.execute(request("first"), {
      announceUserMessage: () => {},
      settleCancelled: () => {},
      execute: async (_req, _run, markReady) => {
        firstStarted = true;
        firstReady = markReady;
        await new Promise<void>((resolve) => { resolveFirst = resolve; });
        return { queued: false };
      },
    });
    await flush();
    assert(firstStarted);

    let followUpStarted = false;
    const followUpPromise = coordinator.execute(request("follow", "followUp"), {
      announceUserMessage: () => {},
      settleCancelled: () => assert.fail("followUp should not be cancelled"),
      execute: async () => {
        followUpStarted = true;
        return { queued: false };
      },
    });
    await flush();
    assert.equal(followUpStarted, false);
    firstReady();
    await flush();
    assert.equal(followUpStarted, true, "followUp must reach Pi while the previous run is still active");
    resolveFirst();
    await firstPromise;
    await followUpPromise;
    assert.equal(followUpStarted, true);
    assert.equal(coordinator.isBusy("task-1"), false);
  }

  // 3. Every explicit message reaches Pi in admission order; Pi owns steering priority.
  {
    const coordinator = new PromptExecutionCoordinator();
    let activeRun!: PromptRunState;
    let markActiveReady!: () => void;
    let resolveActive!: () => void;
    const activePromise = coordinator.execute(request("active"), {
      announceUserMessage: () => {},
      settleCancelled: () => {},
      execute: async (_req, run, markReady) => {
        activeRun = run;
        markActiveReady = markReady;
        await new Promise<void>((resolve) => { resolveActive = resolve; });
        return { queued: false };
      },
    });
    await flush();
    assert(activeRun);

    let followUpStarted = false;
    const followUpPromise = coordinator.execute(request("queued-follow", "followUp"), {
      announceUserMessage: () => {},
      settleCancelled: () => {},
      execute: async () => {
        followUpStarted = true;
        return { queued: false };
      },
    });
    await flush();
    assert.equal(followUpStarted, false);

    let steerStarted = false;
    const steerPromise = coordinator.execute(request("steer", "steer"), {
      announceUserMessage: () => {},
      settleCancelled: () => {},
      execute: async () => {
        steerStarted = true;
        return { queued: true };
      },
    });
    await flush();
    assert.equal(steerStarted, false, "steer must not pass active predecessor before ready boundary");
    markActiveReady();
    await steerPromise;
    assert.equal(steerStarted, true, "steer should pass once active predecessor is SDK-ready");
    assert.equal(followUpStarted, true, "the preceding followUp must also have been admitted to Pi");

    resolveActive();
    await activePromise;
    await followUpPromise;
    assert.equal(followUpStarted, true);
  }

  // 4. cancel with preservedRun leaves the current internal execution alive but cancels queued followUp before it starts.
  {
    const coordinator = new PromptExecutionCoordinator();
    let currentRun!: PromptRunState;
    let resolveCurrent!: () => void;
    const currentPromise = coordinator.execute(request("preserved"), {
      announceUserMessage: () => {},
      settleCancelled: () => assert.fail("preserved current run must not be cancelled"),
      execute: async (_req, run) => {
        currentRun = run;
        await new Promise<void>((resolve) => { resolveCurrent = resolve; });
        return { queued: false };
      },
    });
    await flush();

    let queuedExecuted = false;
    const cancelled: string[] = [];
    const queuedPromise = coordinator.execute(request("cancel-me", "followUp"), {
      announceUserMessage: () => {},
      settleCancelled: (current) => cancelled.push(current.assistantMessageId),
      execute: async () => {
        queuedExecuted = true;
        return { queued: false };
      },
    });
    await flush();
    coordinator.cancel("task-1", currentRun);
    resolveCurrent();
    await currentPromise;
    assert.deepEqual(await queuedPromise, { queued: false });
    assert.equal(queuedExecuted, false);
    assert.deepEqual(cancelled, ["assistant-cancel-me"]);
  }

  // 5. thrown promptInternal still resolves ready/done barriers and releases busy state.
  {
    const coordinator = new PromptExecutionCoordinator();
    await assert.rejects(
      coordinator.execute(request("throw"), {
        announceUserMessage: () => {},
        settleCancelled: () => {},
        execute: async () => { throw new Error("fixture failure"); },
      }),
      /fixture failure/,
    );
    assert.equal(coordinator.isBusy("task-1"), false);
    const next = await coordinator.execute(request("after-throw", "followUp"), {
      announceUserMessage: () => {},
      settleCancelled: () => assert.fail("barrier should be released after failure"),
      execute: () => immediate(),
    });
    assert.deepEqual(next, { queued: false });
  }

  console.log("prompt execution coordinator: PASS");
}

void main();