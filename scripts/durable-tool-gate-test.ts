/**
 * ToolGate — Issue #17 B: reuse one task/binding/permission read per synchronous phase while
 * every check after an await (approval / resource waits) reads fresh state again.
 */
import assert from "node:assert/strict";
import { ToolGate } from "../src/main/agent/durable/ToolGate";

async function oneReadPerSynchronousPhase(): Promise<void> {
  let reads = 0;
  let evaluations = 0;
  const gate = new ToolGate(
    () => {
      reads += 1;
      return { allowed: new Set(["write", "edit"]), revision: reads };
    },
    (value, name) => {
      evaluations += 1;
      return value.allowed.has(name);
    },
  );
  assert.equal(gate.allowed("write"), true);
  assert.equal(gate.allowed("edit"), true);
  assert.equal(gate.allowed("bash"), false);
  assert.equal(gate.allowed("write"), true);
  assert.equal(reads, 1, "one task read for the whole synchronous tool loop");
  assert.equal(evaluations, 3, "each distinct tool name is evaluated once");
  const revision = reads;
  assert.equal(gate.allowed("write"), true);
  assert.equal(reads, revision, "repeated names stay cached inside the phase");
}

async function rereadsAfterMicrotaskBoundary(): Promise<void> {
  let reads = 0;
  const gate = new ToolGate(() => ++reads, () => true);
  gate.allowed("write");
  assert.equal(reads, 1);
  await Promise.resolve();
  gate.allowed("write");
  assert.equal(reads, 2, "a check after an await must read again");
}

async function rereadsAfterRealWaitAndReset(): Promise<void> {
  let reads = 0;
  const gate = new ToolGate(() => ++reads, () => true);
  gate.allowed("write");
  await new Promise((resolve) => setTimeout(resolve, 5));
  gate.allowed("write");
  assert.equal(reads, 2, "approval/resource re-checks after a timer read fresh state");
  gate.reset();
  gate.allowed("write");
  assert.equal(reads, 3, "explicit reset forces a re-read inside the same phase");
}

async function main(): Promise<void> {
  const tests = [oneReadPerSynchronousPhase, rereadsAfterMicrotaskBoundary, rereadsAfterRealWaitAndReset];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`[durable-tool-gate] ${tests.length} behavior groups passed`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
