import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, SettingsManager, shouldCompact } from "@earendil-works/pi-coding-agent";
import { resolveCompactionPolicy, normalizeCompactionTriggerTokens, normalizeCompactionTriggerRatio } from "../src/shared/compaction-policy";
import { AppSettingsStore } from "../src/main/AppSettingsStore";
import { loadTaskHistoryFromSession } from "../src/main/agent/session-history";
import { getVisibleSessionUserMessages } from "../src/main/agent/session-user-messages";
import { PromptSubmissionCoordinator, resolvePromptCompactionBehavior } from "../src/main/agent/PromptSubmissionCoordinator";
import type { SessionEntry } from "../src/main/agent/SessionRegistry";
import { resolveContextTokenEstimate, isManualCompactionRunning } from "../src/shared/compaction";

const root = mkdtempSync(join(tmpdir(), "mybuddy-compaction-policy-history-"));
const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
let passed = 0;
const check = (name: string, body: () => void): void => { body(); passed++; console.log("PASS " + name); };
try {
  for (const [window, ratio, absolute, expected] of [
    [128_000, 0.8, 200_000, 102_400], [256_000, 0.8, 200_000, 200_000],
    [1_000_000, 0.8, 200_000, 200_000], [1_000_000, 0.8, null, 800_000],
    [128_000, 0.3, 96_000, 38_400], [128_000, 0.9, 64_000, 64_000],
  ] as const) {
    check(`dual threshold ${window} / ${ratio} / ${absolute}`, () => {
      const p = resolveCompactionPolicy(window, ratio, absolute)!;
      assert.equal(p.triggerTokens, expected);
      const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: p.reserveTokens } }).getCompactionSettings();
      assert.equal(shouldCompact(expected - 1, window, settings), false);
      // Pi's public comparator uses >, checked at the next safe boundary.
      assert.equal(shouldCompact(expected + 1, window, settings), true);
    });
  }
  check("invalid and disabled absolute threshold are distinct", () => {
    assert.equal(normalizeCompactionTriggerTokens(null), null);
    for (const invalid of [undefined, "200", 0, -1, NaN, Infinity]) assert.equal(normalizeCompactionTriggerTokens(invalid), 200_000);
    assert.equal(normalizeCompactionTriggerTokens(500), 1000);
    assert.equal(normalizeCompactionTriggerTokens(96000.5), 96001);
    assert.equal(normalizeCompactionTriggerRatio(2), 0.9);
    assert.equal(resolveCompactionPolicy(0), null);
  });
  check("model override precedence, explicit disable and retention preserved", () => {
    const model = { provider: "fixture", id: "model" };
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 16384,
      modelOverrides: { "fixture/model": { reserveTokens: 1, keepRecentTokens: 9000 } } } });
    const p = resolveCompactionPolicy(1_000_000, 0.8, 200_000)!;
    settings.applyOverrides({ compaction: { reserveTokens: p.reserveTokens,
      modelOverrides: { "fixture/model": { reserveTokens: p.reserveTokens } } } });
    const actual = settings.getCompactionSettings(model);
    assert.equal(actual.reserveTokens, 800_000); assert.equal(actual.keepRecentTokens, 9000); assert.equal(actual.enabled, false);
    assert.equal(shouldCompact(900_000, 1_000_000, actual), false);
  });
  check("post-compact usage is estimated, leaf-bound and replaced by native usage", () => {
    const estimate = { leafId: "compact-leaf", tokens: 9450 };
    assert.deepEqual(resolveContextTokenEstimate(null, "compact-leaf", estimate), { usedTokens: 9450, estimated: true });
    assert.deepEqual(resolveContextTokenEstimate(null, "new-user-leaf", estimate), { usedTokens: null, estimated: false });
    assert.deepEqual(resolveContextTokenEstimate(12345, "compact-leaf", estimate), { usedTokens: 12345, estimated: false });
  });
  check("only manual compaction blocks the composer; automatic queues remain available", () => {
    assert.equal(isManualCompactionRunning({ taskId: "t", status: "running", reason: "manual" }), true);
    assert.equal(isManualCompactionRunning({ taskId: "t", status: "running", reason: "threshold" }), false);
    assert.equal(isManualCompactionRunning({ taskId: "t", status: "running", reason: "overflow" }), false);
    assert.equal(isManualCompactionRunning({ taskId: "t", status: "cancelled", reason: "manual" }), false);
    assert.equal(isManualCompactionRunning(undefined), false);
  });
  check("new input during native auto compaction uses follow-up without relaxing normal busy checks", () => {
    assert.equal(resolvePromptCompactionBehavior(undefined, true), "followUp");
    assert.equal(resolvePromptCompactionBehavior("steer", true), "steer");
    assert.equal(resolvePromptCompactionBehavior(undefined, false), undefined);
    const entry = { session: { isStreaming: true, isCompacting: false },
      assistantMessageId: "previous", executionId: "previous-execution", pendingAssistantTurns: [],
      promptQueueEpoch: 0, latestSteerGeneration: 0 } as unknown as SessionEntry;
    const coordinator = new PromptSubmissionCoordinator();
    const input = { assistantMessageId: "next", executionId: "next-execution", startedAt: Date.now() };
    assert.equal(coordinator.begin(entry, input).ok, false, "ordinary streaming still requires explicit behavior");
    (entry.session as unknown as { isCompacting: boolean }).isCompacting = true;
    const queued = coordinator.begin(entry, input);
    assert.equal(queued.ok, true);
    if (!queued.ok) throw new Error("expected queued context");
    assert.equal(queued.context.behavior, "followUp");
    assert.equal(queued.context.wasStreaming, true);
    assert.equal(entry.assistantMessageId, "previous", "do not steal the previous assistant's event target");
    coordinator.enqueue(entry, queued.context);
    assert.equal(entry.pendingAssistantTurns[0]?.messageId, "next");
  });
  process.env.HOME = root; process.env.USERPROFILE = root; mkdirSync(join(root, ".mybuddy"), { recursive: true });
  check("settings default, disable, reload and unrelated preferences", () => {
    const store = new AppSettingsStore();
    assert.equal(store.read().compactionTriggerTokens, 200_000);
    store.write({ compactionTriggerRatio: 0.5, compactionTriggerTokens: 96000, theme: "dark" });
    assert.equal(new AppSettingsStore().read().compactionTriggerTokens, 96000);
    store.write({ compactionTriggerTokens: null });
    const result = new AppSettingsStore().read();
    assert.equal(result.compactionTriggerTokens, null); assert.equal(result.compactionTriggerRatio, 0.5); assert.equal(result.theme, "dark");
  });
  check("full UI history survives compact and disk reopen; model context is smaller", () => {
    const sm = SessionManager.create(root, join(root, "sessions"));
    const users: string[] = [], answers: string[] = [];
    for (let i = 0; i < 3; i++) {
      users.push(sm.appendMessage({ role: "user", content: `USER_${i}_FULL_HISTORY`, timestamp: Date.now() + i * 2 }));
      answers.push(sm.appendMessage({ role: "assistant", content: [{ type: "text", text: `ANSWER_${i}` }], timestamp: Date.now() + i * 2 + 1 } as any));
    }
    const file = sm.getSessionFile()!;
    sm.appendCompaction("Earlier conversation summarized.", users[2], 45000);
    const reopened = SessionManager.open(file);
    const contextUsers = reopened.buildContextEntries().filter(e => e.type === "message" && e.message.role === "user");
    assert.equal(contextUsers.length, 1);
    const history = loadTaskHistoryFromSession(file, root);
    assert.equal(history.messages.filter(m => m.role === "user").length, 3);
    assert.equal(history.messages.filter(m => m.role === "assistant").length, 3);
    assert.deepEqual(getVisibleSessionUserMessages(reopened).map(e => e.entryId), users);
    assert.equal(history.messages[0].entryId, users[0]);
    assert(readFileSync(file, "utf8").includes('"type":"compaction"'));
    reopened.branch(answers[0]); reopened.appendCustomEntry("test_navigation", {});
    const branch = loadTaskHistoryFromSession(file, root);
    assert.equal(branch.messages.length, 2, "do not resurrect abandoned branches");
    assert.equal(getVisibleSessionUserMessages(SessionManager.open(file)).length, 1);
  });
  console.log(`PASS all ${passed} policy/history checks`);
} finally {
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
}
