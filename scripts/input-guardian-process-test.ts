import assert from "node:assert/strict";
import { fork, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { InputGuardian, quarantineGuardianGroup } from "../src/main/platform/computer-use/linux/inputGuardian";
import { ComputerUseError } from "../src/main/platform/computer-use/protocol";

interface Entry { event: string; pid?: number; guardianPid?: number; args?: string[]; code?: number; pressed?: boolean; signal?: string }
function fixtureLog(entry: Entry): void {
  const path = process.env.INPUT_GUARDIAN_FIXTURE_LOG;
  if (!path) throw new Error("Missing private process fixture log");
  appendFileSync(path, JSON.stringify(entry) + "\n");
}
async function waitFor<T>(read: () => Promise<T | undefined>, description: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + description);
    await new Promise(resume => setTimeout(resume, 10));
  }
}
async function readLog(path: string): Promise<Entry[]> {
  const text = await readFile(path, "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; });
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Entry);
}
async function active(pid: number): Promise<boolean> {
  try {
    const stat = await readFile("/proc/" + pid + "/stat", "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
async function rejected(promise: Promise<unknown>): Promise<ComputerUseError> {
  try { await promise; assert.fail("killed guardian unexpectedly acknowledged input"); }
  catch (error) { assert.ok(error instanceof ComputerUseError, String(error)); return error; }
}

/** This fixture is deliberately killed while its detached guardian owns DOWN. */
async function parentFixture(): Promise<void> {
  const guardian = new InputGuardian({ workerPath: process.env.INPUT_GUARDIAN_FIXTURE_WORKER });
  await guardian.probe();
  fixtureLog({ event: "parent-ready", pid: process.pid, guardianPid: guardian.pid });
  const first = guardian.setHeld([30], [], true).catch(error => fixtureLog({ event: "parent-command-error", signal: String(error) }));
  const queued = guardian.setHeld([31], [], true).catch(error => fixtureLog({ event: "parent-queued-error", signal: String(error) }));
  await Promise.all([first, queued]);
  // If the test failed to kill its parent in time, make that a visible failure.
  fixtureLog({ event: "parent-survived-input" });
  await guardian.shutdown();
  process.exitCode = 1;
}

const FAKE_YDOTOOL = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = value => fs.appendFileSync(process.env.INPUT_GUARDIAN_FIXTURE_LOG, JSON.stringify({ ...value, pid: process.pid }) + '\\n');
let terminated = false;
let timer;
process.on('SIGTERM', () => {
  terminated = true;
  log({ event: 'termination-requested', args, signal: 'SIGTERM' });
  clearTimeout(timer);
  // Still emit after cancellation, but before the runner's SIGKILL grace.
  timer = setTimeout(finish, 50);
});
log({ event: 'emitter-start', args });
const down = args[0] === 'key' && args.slice(1).some(value => value.endsWith(':1'));
const finish = () => {
  if (args[0] === 'key') for (const value of args.slice(1)) {
    const [code, state] = value.split(':');
    log({ event: 'edge', args, code: Number(code), pressed: state === '1' });
  }
  log({ event: 'emitter-exit', args, signal: terminated ? 'SIGTERM-observed' : undefined });
  process.exit(0);
};
// Emulate an emitter that can still write DOWN after SIGTERM. The guardian
// must wait for CLOSE or fence this owned process group before sending UP.
timer = setTimeout(finish, down ? 1000 : 1);
`;

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    process.stdout.write("Input guardian process lifecycle applies to Linux; no Linux process test executed on " + process.platform + "\n");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "mybuddy-guardian-process-"));
  const executable = join(root, "ydotool");
  const workerPath = resolve("out/main/input-guardian.cjs");
  const ownedParents = new Set<ChildProcess>();
  const ownedGuardians = new Set<number>();
  let client: InputGuardian | undefined;
  try {
    await writeFile(executable, FAKE_YDOTOOL); await chmod(executable, 0o700);
    const firstLog = join(root, "parent-killed.jsonl");
    const environment = (log: string): NodeJS.ProcessEnv => ({
      ...process.env, PATH: root + delimiter + (process.env.PATH ?? ""),
      ELECTRON_RUN_AS_NODE: "1", INPUT_GUARDIAN_FIXTURE_LOG: log, INPUT_GUARDIAN_FIXTURE_WORKER: workerPath,
    });
    const parent = spawn(process.execPath, [__filename, "--parent-fixture"], {
      env: environment(firstLog), stdio: ["ignore", "pipe", "pipe"], shell: false,
    });
    ownedParents.add(parent);
    let parentError: Error | undefined; let parentOutput = ""; let parentExited = false;
    parent.once("error", error => { parentError = error; });
    parent.once("exit", () => { parentExited = true; });
    parent.stderr?.on("data", data => { parentOutput = (parentOutput + String(data)).slice(-4_000); });
    const ready = await waitFor(async () => {
      if (parentError) throw parentError;
      const entries = await readLog(firstLog);
      const value = entries.find(entry => entry.event === "parent-ready");
      if (!value && parentExited) throw new Error("Parent fixture exited before guardian handshake: " + parentOutput);
      return value;
    }, "real parent/guardian handshake");
    assert.ok(ready.guardianPid && ready.guardianPid !== process.pid);
    ownedGuardians.add(ready.guardianPid);
    await waitFor(async () => (await readLog(firstLog)).find(entry => entry.event === "emitter-start" && entry.args?.includes("30:1")), "active owned DOWN emitter");
    assert.ok(parent.pid && parent.pid !== process.pid);
    process.kill(parent.pid, "SIGKILL");
    await waitFor(async () => (await readLog(firstLog)).find(entry => entry.event === "edge" && entry.code === 30 && entry.pressed === false), "cleanup UP after parent SIGKILL");
    await waitFor(async () => await active(ready.guardianPid!) ? undefined : true, "guardian exit after disconnect cleanup");
    const parentEntries = await readLog(firstLog);
    const down = parentEntries.findIndex(entry => entry.event === "edge" && entry.code === 30 && entry.pressed === true);
    const up = parentEntries.findIndex(entry => entry.event === "edge" && entry.code === 30 && entry.pressed === false);
    assert.ok(parentEntries.some(entry => entry.event === "termination-requested"), "cancellation signal was not delivered to the active emitter");
    assert.ok(down >= 0 && up > down, "cleanup UP must follow the late DOWN emitted after cancellation");
    assert.equal(parentEntries.some(entry => entry.event === "edge" && entry.code === 31 && entry.pressed), false, "queued DOWN escaped after parent death");
    assert.equal(parentEntries.slice(up + 1).some(entry => entry.event === "edge" && entry.pressed), false);
    process.stdout.write("PASS real parent SIGKILL drains the active emitter before UP and cancels queued DOWN\n");

    const secondLog = join(root, "guardian-killed.jsonl");
    client = new InputGuardian({ workerPath, spawnWorker: path => {
      const worker = fork(path, [], { execPath: process.execPath, execArgv: [], env: environment(secondLog), detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
      if (worker.pid) ownedGuardians.add(worker.pid);
      return worker;
    } });
    await client.probe();
    const guardianPid = client.pid;
    assert.ok(guardianPid && guardianPid !== process.pid);
    const pending = rejected(client.setHeld([34], [], true));
    const queued = rejected(client.setHeld([35], [], true));
    const emitter = await waitFor(async () => (await readLog(secondLog)).find(entry => entry.event === "emitter-start" && entry.args?.includes("34:1")), "guardian's owned emitter before SIGKILL");
    assert.ok(emitter.pid);
    process.kill(guardianPid, "SIGKILL");
    const failure = await pending; await queued;
    assert.equal((failure.details as { executed?: unknown }).executed, "unknown");
    await client.setHeld([34], [], false);
    assert.notEqual(client.pid, guardianPid);
    assert.equal(await active(emitter.pid), false, "old emitter survived the guardian process-group fence");
    // The original emitter would write at 1000ms if it had survived. Observe
    // beyond that deadline so an UP-before-orphan-DOWN race cannot pass.
    await new Promise(resume => setTimeout(resume, 1100));
    const guardianEntries = await readLog(secondLog);
    const recoveryUp = guardianEntries.findIndex(entry => entry.event === "edge" && entry.code === 34 && entry.pressed === false);
    assert.ok(recoveryUp >= 0);
    assert.equal(guardianEntries.filter(entry => entry.event === "emitter-start" && entry.args?.includes("34:1")).length, 1, "non-idempotent DOWN was replayed");
    assert.equal(guardianEntries.some(entry => entry.event === "edge" && entry.code === 35 && entry.pressed), false);
    assert.equal(guardianEntries.slice(recoveryUp + 1).some(entry => entry.event === "edge" && entry.pressed), false, "orphan DOWN arrived after recovery UP");
    await client.shutdown(); client = undefined;
    process.stdout.write("PASS real guardian SIGKILL fences only its owned emitters before replacement recovery; no DOWN replay\n");
    process.stdout.write("Input guardian: 2 real process lifecycle checks passed (private fake ydotool; no desktop input)\n");
  } finally {
    await client?.shutdown().catch(() => {});
    for (const parent of ownedParents) if (parent.pid && await active(parent.pid)) { try { process.kill(parent.pid, "SIGKILL"); } catch {} }
    for (const pid of ownedGuardians) await quarantineGuardianGroup(pid).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}
void (process.argv.includes("--parent-fixture") ? parentFixture() : main()).catch(error => {
  process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1;
});
