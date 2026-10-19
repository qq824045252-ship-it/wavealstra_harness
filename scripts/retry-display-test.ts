import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { GenerationSpeedTracker } from "../src/main/usage/GenerationSpeedTracker";
import { nativeRunPhaseLabel } from "../src/shared/generation-stats";
import { generationSpeedView } from "../src/renderer/src/lib/generationSpeed";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }
const event = (value: object) => value as AgentSessionEvent;
const turn = event({ type: "turn_start" });
const delta = (text: string) => event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
const end = (stopReason: string, errorMessage?: string) => event({
  type: "message_end",
  message: { role: "assistant", stopReason, ...(errorMessage ? { errorMessage } : {}), usage: { output: 10 } },
});
const retryStart = (attempt: number) => event({
  type: "auto_retry_start", attempt, maxAttempts: 3, delayMs: 2000, errorMessage: "terminated",
});
const agentStart = event({ type: "agent_start" });

test("a failed attempt exposes its error before Pi schedules the retry", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.onEvent(turn, "r1", 1000);
  tracker.onEvent(delta("写文件"), "r1", 1200);
  const failed = tracker.onEvent(end("error", "terminated"), "r1", 2000)!;
  assert.equal(failed.attempts, 1);
  assert.equal(failed.retry?.error, "terminated");
});

test("auto_retry_start publishes the retry counter, budget and error", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.onEvent(turn, "r1", 1000);
  tracker.onEvent(delta("写文件"), "r1", 1200);
  tracker.onEvent(end("error", "terminated"), "r1", 2000);
  const stats = tracker.onEvent(retryStart(1), "r1", 2100)!;
  assert.equal(stats.phase, "retrying");
  assert.equal(stats.attempts, 2);
  assert.deepEqual(stats.retry, { attempt: 1, maxAttempts: 3, delayMs: 2000, error: "terminated" });
});

test("the retried attempt keeps saying which attempt it is", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.onEvent(turn, "r1", 1000);
  tracker.onEvent(end("error", "terminated"), "r1", 2000);
  tracker.onEvent(retryStart(1), "r1", 2100);
  // Pi restarts the loop for the retry: agent_start resets the phase but must not hide the retry.
  const resumed = tracker.onEvent(agentStart, "r1", 4100)!;
  assert.equal(resumed.phase, "waiting");
  assert.equal(resumed.attempts, 2);
  assert.equal(resumed.retry?.error, "terminated");
  const label = nativeRunPhaseLabel(resumed.phase, [], false, resumed.retry, resumed.attempts);
  assert.match(label, /第 2 次尝试/);
  assert.match(label, /terminated/);
});

test("a successful request clears the retry state", () => {
  const tracker = new GenerationSpeedTracker();
  tracker.onEvent(turn, "r1", 1000);
  tracker.onEvent(end("error", "terminated"), "r1", 2000);
  tracker.onEvent(retryStart(1), "r1", 2100);
  tracker.onEvent(agentStart, "r1", 4100);
  const ok = tracker.onEvent(end("stop"), "r1", 9000)!;
  assert.equal(ok.retry, undefined);
  assert.equal(ok.attempts, 2);
});

test("the retry label names the counter, budget and provider error", () => {
  const label = nativeRunPhaseLabel("retrying", [], false, { attempt: 2, maxAttempts: 3, error: "Stream ended without finish_reason" });
  assert.match(label, /连接重试中/);
  assert.match(label, /重试 2\/3/);
  assert.match(label, /Stream ended without finish_reason/);
});

test("a long provider error is truncated so the label stays readable", () => {
  const long = '503: {"type":"server_error","message":"Error from provider (DeepSeek): upstream request timed out"}';
  const label = nativeRunPhaseLabel("retrying", [], false, { attempt: 1, maxAttempts: 3, error: long });
  assert.match(label, /重试 1\/3/);
  assert.ok(label.endsWith("…"), "长错误应以省略号结尾");
  assert.ok(label.length < 70, `标签过长：${label.length}`);
});

test("retry without host detail still says it is retrying", () => {
  assert.equal(nativeRunPhaseLabel("retrying", []), "连接重试中…");
});

test("the speed chip shows the retry counter and the last error", () => {
  const view = generationSpeedView({
    stats: { phase: "retrying", startedAt: 1000, updatedAt: 2000, attempts: 2, retry: { attempt: 1, maxAttempts: 3, delayMs: 2000, error: "terminated" },
      tps: null, estimated: false, outputTokens: null, ttftMs: null },
    streaming: true, approval: false, createdAt: 1000,
  }, 2100)!;
  assert.match(view.label, /正在重试 1\/3/);
  assert.match(view.detail, /terminated/);
});

console.log(`\n${passed} retry-display checks passed`);
