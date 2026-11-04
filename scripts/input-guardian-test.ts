import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  INPUT_GUARDIAN_PROTOCOL, InputGuardian, InputGuardianEngine, createGuardianRunner,
  validateInputGuardianHandshake, type GuardianRunner, type InputGuardianCommand,
  type InputGuardianReply, type InputGuardianRequest, type InputGuardianResult,
} from "../src/main/platform/computer-use/linux/inputGuardian";
import { ComputerUseError } from "../src/main/platform/computer-use/protocol";

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function tick(): Promise<void> { await new Promise<void>(resume => setImmediate(resume)); }
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) { if (predicate()) return; await tick(); }
  assert.fail("fixture condition did not become true");
}
function errorDetails(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof ComputerUseError);
  return error.details as Record<string, unknown>;
}
async function rejection(promise: Promise<unknown>, code?: string): Promise<ComputerUseError> {
  try { await promise; assert.fail("expected a rejected operation"); }
  catch (error) {
    assert.ok(error instanceof ComputerUseError, String(error));
    if (code) assert.equal(error.code, code);
    return error;
  }
}
const held = (keys: number[], pressed: boolean, buttons: number[] = []): InputGuardianCommand => ({ type: "held", keys, buttons, pressed });
let checks = 0;
async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  await run(); checks += 1; process.stdout.write("PASS " + name + "\n");
}

class FakeEmitter extends EventEmitter {
  readonly stderr = new PassThrough();
  readonly pid = 7100;
  readonly signals: string[] = [];
  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    this.emit("error", new Error("abort callback fired before process close"));
    return true;
  }
}

class FakeWorker extends EventEmitter {
  connected = true;
  readonly engine: InputGuardianEngine;
  readonly pid: number;
  readonly received: InputGuardianCommand[] = [];
  constructor(pid: number, runner: GuardianRunner) {
    super(); this.pid = pid; this.engine = new InputGuardianEngine(runner);
    queueMicrotask(() => this.emit("message", { type: "ready", handshake: {
      protocol: INPUT_GUARDIAN_PROTOCOL, backend: "linux-atspi-input-guardian", nodeVersion: "24.1.0", pid, ready: true,
    } }));
  }
  unref(): this { return this; }
  send(raw: unknown, callback?: (error: Error | null) => void): boolean {
    const request = raw as InputGuardianRequest;
    callback?.(this.connected ? null : new Error("IPC closed"));
    if (!this.connected) return false;
    if (request.type === "cancel") { this.engine.cancel(request.requestId); return true; }
    this.received.push(request);
    void this.engine.execute(request.id, request).then(result => this.reply({ type: "result", id: request.id, result }), error => this.reply({ type: "error", id: request.id, error: {
      code: error instanceof ComputerUseError ? error.code : "HOST_UNAVAILABLE", message: String(error), details: error instanceof ComputerUseError ? error.details : undefined,
    } }));
    return true;
  }
  private reply(reply: InputGuardianReply): void { if (this.connected) this.emit("message", reply); }
  crash(): void { this.connected = false; this.emit("exit", null, "SIGKILL"); }
  disconnect(): void {
    this.connected = false; this.emit("disconnect");
    void this.engine.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  await test("successful DOWN remains held and explicit UP clears only owned inputs", async () => {
    const calls: string[][] = [];
    const engine = new InputGuardianEngine(async args => { calls.push([...args]); });
    const down = await engine.execute(1, held([29, 30], true, [0]));
    assert.deepEqual(down.heldKeys, [29, 30]); assert.deepEqual(down.heldButtons, [0]);
    assert.deepEqual(calls, [["key", "29:1"], ["key", "30:1"], ["click", "0x40"]]);
    await tick(); assert.equal(calls.length, 3);
    const up = await engine.execute(2, held([29, 30], false, [0]));
    assert.deepEqual(calls.slice(3), [["key", "30:0"], ["key", "29:0"], ["click", "0x80"]]);
    assert.deepEqual(up.heldKeys, []); assert.deepEqual(up.heldButtons, []);
    await engine.close();
  });
  await test("duplicate DOWN is not replayed; wheels share the guardian queue", async () => {
    const calls: string[][] = [];
    const engine = new InputGuardianEngine(async args => { calls.push([...args]); });
    await engine.execute(1, held([30, 30], true));
    const duplicate = await engine.execute(2, held([30], true));
    assert.equal(duplicate.executed, false);
    await engine.execute(3, { type: "scroll", horizontalNotches: -2, verticalNotches: 3 });
    assert.deepEqual(calls, [["key", "30:1"], ["mousemove", "--wheel", "-x", "-2", "-y", "3"]]);
    await engine.close(); assert.deepEqual(calls[2], ["key", "30:0"]);
  });
  await test("partial chord preserves completed and unknown edge evidence then releases owned state", async () => {
    const calls: string[][] = [];
    const engine = new InputGuardianEngine(async args => {
      calls.push([...args]);
      if (args[1] === "31:1") throw new ComputerUseError("REQUEST_TIMEOUT", "fixture timeout", { executed: "unknown", emitterStopped: true });
    });
    const failure = await rejection(engine.execute(1, held([30, 31, 32], true)), "REQUEST_TIMEOUT");
    assert.deepEqual(errorDetails(failure).completedKeys, [30]);
    assert.deepEqual(errorDetails(failure).unknownKeys, [31]);
    assert.equal(errorDetails(failure).executed, true);
    assert.deepEqual(errorDetails(failure).heldKeys, []);
    assert.deepEqual(calls, [["key", "30:1"], ["key", "31:1"], ["key", "31:0", "30:0"]]);
    await engine.close();
  });
  await test("proven pre-spawn failure emits no unnecessary UP", async () => {
    const calls: string[][] = [];
    const engine = new InputGuardianEngine(async args => {
      calls.push([...args]); throw new ComputerUseError("HOST_UNAVAILABLE", "spawn failed", { executed: false });
    });
    const failure = await rejection(engine.execute(1, held([30], true)));
    assert.equal(errorDetails(failure).executed, false);
    assert.deepEqual(engine.snapshot().heldKeys, []);
    assert.deepEqual(calls, [["key", "30:1"]]);
    await engine.close();
  });
  await test("queued cancellation never registers or sends its DOWN", async () => {
    const running = deferred(); const entered = deferred(); const calls: string[][] = [];
    const engine = new InputGuardianEngine(async args => {
      calls.push([...args]); if (args[1] === "30:1") { entered.resolve(); await running.promise; }
    });
    const first = engine.execute(1, held([30], true));
    await entered.promise;
    const queued = engine.execute(2, held([31], true)); const stopped = rejection(queued, "REQUEST_CANCELLED");
    engine.cancel(2); running.resolve(); await first;
    const failure = await stopped;
    assert.equal(errorDetails(failure).executed, false);
    assert.deepEqual(calls, [["key", "30:1"]]);
    assert.deepEqual(engine.snapshot().heldKeys, [30]);
    await engine.close(); assert.deepEqual(calls[1], ["key", "30:0"]);
  });
  await test("parent disconnect waits an actual late DOWN before sending cleanup UP", async () => {
    const emitterClosed = deferred(); const entered = deferred(); const events: string[] = [];
    const engine = new InputGuardianEngine(async (args, signal) => {
      if (args[1] === "30:1") {
        events.push("emitter-started"); entered.resolve();
        await emitterClosed.promise;
        events.push("late-DOWN");
        assert.equal(signal?.aborted, true);
        throw new ComputerUseError("REQUEST_CANCELLED", "emitter finally closed", { executed: "unknown", emitterStopped: true });
      }
      events.push(args[1] === "30:0" ? "cleanup-UP" : "unexpected-input");
    });
    const active = rejection(engine.execute(1, held([30], true)), "REQUEST_CANCELLED");
    await entered.promise;
    const queued = rejection(engine.execute(2, held([31], true)), "REQUEST_CANCELLED");
    const close = engine.close();
    await tick(); assert.deepEqual(events, ["emitter-started"]);
    emitterClosed.resolve(); await active; await queued; await close;
    assert.deepEqual(events, ["emitter-started", "late-DOWN", "cleanup-UP"]);
    assert.deepEqual(engine.snapshot().heldKeys, []);
  });
  await test("native runner ignores early abort error until the owned child close event", async () => {
    const emitters: FakeEmitter[] = []; const calls: string[][] = [];
    const runner = createGuardianRunner({ timeoutMs: 5_000, killGraceMs: 5_000, spawnCommand: args => {
      calls.push([...args]); const emitter = new FakeEmitter(); emitters.push(emitter);
      queueMicrotask(() => { emitter.emit("spawn"); if (emitters.length > 1) emitter.emit("close", 0, null); });
      return emitter as unknown as ChildProcess;
    } });
    const engine = new InputGuardianEngine(runner);
    const operation = rejection(engine.execute(1, held([30], true)), "REQUEST_CANCELLED");
    await waitFor(() => emitters.length === 1);
    let finished = false; const close = engine.close().then(() => { finished = true; });
    await tick();
    assert.equal(finished, false); assert.equal(calls.length, 1);
    assert.deepEqual(emitters[0].signals, ["SIGTERM"]);
    emitters[0].emit("close", null, "SIGTERM");
    await operation; await close;
    assert.deepEqual(calls, [["key", "30:1"], ["key", "30:0"]]);
  });
  await test("cleanup failure blocks subsequent DOWN until the old owned ledger is released", async () => {
    const calls: string[][] = []; let allowUp = false;
    const engine = new InputGuardianEngine(async args => {
      calls.push([...args]);
      if (args[1] === "30:1") throw new ComputerUseError("REQUEST_TIMEOUT", "unknown DOWN", { executed: "unknown" });
      if (args[1]?.endsWith(":0") && !allowUp) throw new ComputerUseError("HOST_UNAVAILABLE", "daemon missing", { executed: false });
    });
    const first = await rejection(engine.execute(1, held([30], true)));
    assert.deepEqual(errorDetails(first).heldKeys, [30]);
    await rejection(engine.execute(2, held([31], true)));
    assert.equal(calls.some(args => args[1] === "31:1"), false);
    assert.equal(calls.filter(args => args[1] === "30:1").length, 1);
    allowUp = true;
    await engine.execute(3, held([31], true));
    assert.deepEqual(calls.slice(-2), [["key", "30:0"], ["key", "31:1"]]);
    await engine.close();
  });
  await test("probe failure does not release held keys or claim input execution", async () => {
    const calls: string[][] = [];
    const engine = new InputGuardianEngine(async args => {
      calls.push([...args]); if (args[0] === "debug") throw new Error("probe unavailable");
    });
    await engine.execute(1, held([30], true));
    const failure = await rejection(engine.execute(2, { type: "probe" }));
    assert.equal(errorDetails(failure).executed, false);
    assert.deepEqual(engine.snapshot().heldKeys, [30]); assert.equal(calls.length, 2);
    await engine.close();
  });
  await test("validation refuses malformed codes, wheel budgets and runtime handshakes", () => {
    const engine = new InputGuardianEngine(async () => assert.fail("invalid input reached runner"));
    for (const command of [held([-1], true), held([768], true), held([30.5], true), held([], true, [3]), { type: "scroll", horizontalNotches: 1001, verticalNotches: 0 } as const]) {
      assert.throws(() => engine.execute(1, command), ComputerUseError);
    }
    const good = { protocol: INPUT_GUARDIAN_PROTOCOL, backend: "linux-atspi-input-guardian", nodeVersion: "24.21.0", pid: 100, ready: true };
    assert.equal(validateInputGuardianHandshake(good).nodeVersion, "24.21.0");
    for (const version of ["garbage", "NaN.0.0", "23.9.0", "24", "24.0.0oops"]) assert.throws(() => validateInputGuardianHandshake({ ...good, nodeVersion: version }), ComputerUseError);
  });
  await test("worker death fences its emitter group before recovery UP or any new input", async () => {
    const workers: FakeWorker[] = []; const calls: string[] = []; const fence = deferred(); const oldEmitter = deferred();
    let exits = 0;
    const client = new InputGuardian({ workerPath: resolve("src/main/platform/computer-use/linux/inputGuardianWorker.ts"),
      spawnWorker: () => {
        const index = workers.length;
        const worker = new FakeWorker(8000 + index, async args => {
          calls.push(index + ":" + args.join(" "));
          if (index === 0 && args[1] === "30:1") await oldEmitter.promise;
        });
        workers.push(worker); return worker as unknown as ChildProcess;
      },
      quarantineWorker: async pid => { assert.equal(pid, 8000); calls.push("fence-start"); await fence.promise; calls.push("fence-end"); },
      onUnexpectedExit: () => { exits += 1; },
    });
    const pending = rejection(client.setHeld([30], [], true));
    await waitFor(() => calls.includes("0:key 30:1"));
    workers[0].crash();
    const failure = await pending;
    assert.equal(errorDetails(failure).executed, "unknown"); assert.equal(exits, 1);
    const next = client.scroll(0, 1);
    await tick(); assert.equal(workers.length, 1); assert.equal(calls.includes("1:key 30:0"), false);
    fence.resolve(); oldEmitter.resolve(); await next;
    assert.deepEqual(calls.slice(-3), ["fence-end", "1:key 30:0", "1:mousemove --wheel -x 0 -y 1"]);
    assert.equal(calls.filter(value => value.endsWith("30:1")).length, 1);
    await client.shutdown();
  });
  await test("a failed process-group fence forbids replacement and recovery commands", async () => {
    const workers: FakeWorker[] = [];
    const client = new InputGuardian({ workerPath: resolve("src/main/platform/computer-use/linux/inputGuardianWorker.ts"),
      spawnWorker: () => { const worker = new FakeWorker(8100, async () => {}); workers.push(worker); return worker as unknown as ChildProcess; },
      quarantineWorker: async () => { throw new ComputerUseError("HOST_UNAVAILABLE", "emitter still running"); },
    });
    await client.setHeld([30], [], true); workers[0].crash();
    await rejection(client.setHeld([31], [], true)); assert.equal(workers.length, 1);
    await rejection(client.shutdown());
  });
  await test("client shutdown cancels queued input and waits cleanup before disconnecting", async () => {
    const gate = deferred(); const calls: string[][] = []; let worker!: FakeWorker;
    const client = new InputGuardian({ workerPath: resolve("src/main/platform/computer-use/linux/inputGuardianWorker.ts"),
      spawnWorker: () => {
        worker = new FakeWorker(8200, async (args, signal) => {
          calls.push([...args]);
          if (args[1] === "30:1") {
            await gate.promise;
            if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "closed", { executed: "unknown" });
          }
        }); return worker as unknown as ChildProcess;
      }, quarantineWorker: async () => assert.fail("healthy shutdown must not kill its guardian"),
    });
    const first = rejection(client.setHeld([30], [], true), "REQUEST_CANCELLED");
    await waitFor(() => calls.length === 1);
    const second = rejection(client.setHeld([31], [], true), "REQUEST_CANCELLED");
    await tick();
    const shutdown = client.shutdown();
    await tick(); assert.equal(worker.connected, true); assert.equal(calls.length, 1);
    gate.resolve(); await first; await second; await shutdown;
    assert.equal(worker.connected, false);
    assert.deepEqual(calls, [["key", "30:1"], ["key", "30:0"]]);
  });
  await test("already aborted client command never starts a guardian", async () => {
    const controller = new AbortController(); controller.abort();
    const client = new InputGuardian({ spawnWorker: () => assert.fail("pre-aborted request spawned a worker") });
    const failure = await rejection(client.setHeld([30], [], true, controller.signal), "REQUEST_CANCELLED");
    assert.equal(errorDetails(failure).executed, false); await client.shutdown();
  });
  process.stdout.write("Input guardian: " + checks + " behavior checks passed\n");
}
void main().catch(error => { process.stderr.write(String(error.stack ?? error) + "\n"); process.exitCode = 1; });
