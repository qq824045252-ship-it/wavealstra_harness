import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { createLinuxFixture, type LinuxFixture } from "./linux-native-backend-fixture";
import { ComputerUseError } from "../src/main/platform/computer-use/protocol";
import { clientDipToLogical } from "../src/main/platform/computer-use/linux/nativeHelpers";
import { logicalToOutputPixel, outputPixelToLogical, monitorForPoint, monitorLayoutId, parseHyprlandMonitors } from "../src/main/platform/computer-use/linux/hyprlandMonitors";
import { buildFocusScript, buildCursorMoveScript, buildMoveScript, createHyprlandDesktop, parseHyprlandWindows, hyprlandAddressFromHandle, HYPRLAND_LUA_CAPABILITY_PROBE } from "../src/main/platform/computer-use/linux/hyprlandWindows";
import { HyprlandEvents } from "../src/main/platform/computer-use/linux/hyprlandEvents";
import { createGrimScreenshotProvider } from "../src/main/platform/computer-use/linux/screenshotProvider";

let passed = 0;
async function check(name: string, run: (fixture: LinuxFixture) => Promise<void> | void): Promise<void> {
  const f = createLinuxFixture();
  try { await run(f); passed++; console.log(`PASS ${name}`); }
  finally { await f.backend.shutdown(); }
}
async function rejects(code: string, run: () => unknown | Promise<unknown>) {
  await assert.rejects(async () => run(), (error: unknown) => error instanceof ComputerUseError && error.code === code);
}
function hasEdge(f: LinuxFixture, token: string) { return f.state.edges.some(args => args.includes(token)); }

async function main() {
  await check("window metadata is independent of unavailable AT-SPI and screenshot providers", async f => {
    f.state.treeUnavailable = true; f.state.captureFailure = true;
    const read = await f.observe();
    assert.equal(read.window?.handle, f.handle); assert.ok(read.observationId); assert.equal(f.state.inspectCalls, 0); assert.equal(f.state.captureCalls, 0);
    const active = await f.backend.execute({ action: "active_window" }); assert.equal(active.window?.handle, f.handle);
  });
  await check("negative origin and fractional scale use client logical translation", f => {
    assert.equal(hyprlandAddressFromHandle(f.handle), f.handle);
    assert.deepEqual(clientDipToLogical(f.window, 40, 50), { x: -1460, y: 130 });
    assert.deepEqual(logicalToOutputPixel(f.state.monitors[0], { x: -1460, y: 130 }), { x: 175, y: 162.5 });
    assert.deepEqual(outputPixelToLogical(f.state.monitors[0], { x: 175, y: 162.5 }), { x: -1460, y: 130 });
    const rotated = parseHyprlandMonitors([{ id: 3, name: "rotated", x: 1200, y: -100, width: 1200, height: 1920, scale: 1.5, transform: 1 }])[0];
    assert.deepEqual(rotated.logicalRect, { x: 1200, y: -100, width: 1280, height: 800 });
    const fractional = parseHyprlandMonitors([{ id: 4, name: "rounded", x: -2000, y: -100, width: 1920, height: 1080, scale: 1.35, transform: 0 }])[0];
    assert.deepEqual(fractional.logicalRect, { x: -2000, y: -100, width: 1422, height: 800 });
    assert.throws(() => outputPixelToLogical(fractional, { x: 1919.9, y: 0 }), ComputerUseError);
    assert.throws(() => monitorForPoint([fractional], { x: -578, y: 0 }), ComputerUseError);
    assert.notEqual(monitorLayoutId(f.state.monitors), monitorLayoutId([rotated]));
    assert.throws(() => monitorForPoint(f.state.monitors, { x: 1300, y: 20 }), ComputerUseError);
    assert.throws(() => clientDipToLogical(f.window, 600, 0), ComputerUseError);
  });
  await check("both client and screen inputs reject unbound coordinates before movement", async f => {
    for (const action of ["click_client", "mouse_click", "mouse_move", "drag_screen"] as const) await rejects("STALE_OBSERVATION", () => f.backend.execute({ action, windowHandle: f.handle, x: 30, y: 30, x2: 50, y2: 50 }));
    assert.equal(f.state.moves.length, 0); assert.equal(f.state.edges.length, 0);
  });
  await check("stale scale, geometry and recycled address cannot execute coordinates", async f => {
    let observed = await f.observe(); f.state.layoutId = "layout-changed";
    await rejects("STALE_OBSERVATION", () => f.backend.execute({ action: "click_client", observationId: observed.observationId, x: 40, y: 40 }));
    f.state.layoutId = f.window.layoutId; observed = await f.observe(); f.window.clientOrigin.x++;
    await rejects("STALE_OBSERVATION", () => f.backend.execute({ action: "click_client", observationId: observed.observationId, x: 40, y: 40 }));
    observed = await f.observe(); f.window.identityToken = "lifetime:2";
    await rejects("TARGET_CHANGED", () => f.backend.execute({ action: "click_client", observationId: observed.observationId, x: 40, y: 40 }));
    assert.equal(f.state.moves.length, 0); assert.equal(f.state.edges.length, 0);
  });
  await check("observation TTL and uncertified client mapping fail closed", async f => {
    const observed = await f.observe(); f.state.time += 30_001;
    await rejects("STALE_OBSERVATION", () => f.backend.execute({ action: "click_client", observationId: observed.observationId, x: 40, y: 40 }));
    f.window.clientGeometryVerified = false;
    await rejects("STALE_OBSERVATION", () => f.coordinates("mouse_click", { x: -1460, y: 120 }));
    assert.equal(f.state.edges.length, 0);
  });
  await check("long press moves before DOWN and preserves requested hold duration", async f => {
    const order: string[] = []; f.state.moveHook = () => { order.push("move"); }; f.state.inputHook = args => { order.push(args.join(" ")); };
    await f.coordinates("click_client", { holdMs: 250 });
    assert.deepEqual(order, ["move", "click 0x40", "click 0x80"]); assert.ok(f.state.sleepCalls.includes(250)); assert.equal(f.state.captureCalls, 0);
  });
  await check("triple click emits exactly three complete button pairs", async f => {
    await f.coordinates("click_client", { clickCount: 3 });
    assert.deepEqual(f.state.edges, [["click", "0x40"], ["click", "0x80"], ["click", "0x40"], ["click", "0x80"], ["click", "0x40"], ["click", "0x80"]]);
  });
  await check("drag duration is scheduled over intermediate verified cursor positions", async f => {
    const output = await f.coordinates("drag_client", { x2: 160, y2: 100, durationMs: 240, steps: 4 });
    assert.equal(output.actualDurationMs, 240); assert.equal(f.state.moves.length, 5);
    assert.deepEqual(f.state.moves.map(point => point.time), [1000, 1060, 1120, 1180, 1240]);
    assert.deepEqual(f.state.moves[4], { x: -1340, y: 180, time: 1240 });
    assert.deepEqual(f.state.edges, [["click", "0x40"], ["click", "0x80"]]);
  });
  await check("focus loss after cursor readback prevents button DOWN", async f => {
    f.state.moveHook = () => { f.state.activeHandle = "0x999"; };
    await rejects("FOCUS_FAILED", () => f.coordinates("click_client"));
    assert.equal(f.state.moves.length, 1); assert.equal(f.state.edges.length, 0);
  });
  await check("held modifiers persist across successful calls and are task-owned", async f => {
    await f.backend.execute({ action: "key_down", key: "Shift", windowHandle: f.handle, taskId: "owner-a" });
    await f.observe("owner-a"); assert.ok(hasEdge(f, "42:1")); assert.ok(!hasEdge(f, "42:0"));
    await rejects("HOST_UNAVAILABLE", () => f.backend.execute({ action: "key_press", key: "A", windowHandle: f.handle, taskId: "owner-b" }));
    assert.ok(!hasEdge(f, "42:0"));
    await f.backend.releaseHeldInput("owner-b"); assert.ok(!hasEdge(f, "42:0"));
    await f.backend.execute({ action: "key_up", key: "Shift", taskId: "owner-a" }); assert.ok(hasEdge(f, "42:0"));
  });
  await check("held button remains through a separate move and releases without a live target", async f => {
    await f.coordinates("mouse_down_client"); assert.ok(!hasEdge(f, "0x80"));
    await f.coordinates("move_client", { x: 100, y: 60 }); assert.ok(!hasEdge(f, "0x80"));
    f.state.windows = [];
    await f.backend.execute({ action: "mouse_up_client" }); assert.ok(hasEdge(f, "0x80"));
  });
  await check("Ctrl scroll actually wraps wheel events in temporary owned modifier edges", async f => {
    await f.coordinates("scroll_client", { notches: -3, modifiers: ["ctrl"] });
    assert.deepEqual(f.state.edges, [["key", "29:1"], ["mousemove", "--wheel", "-x", "0", "-y", "-3"], ["key", "29:0"]]);
  });
  await check("cancellation during drag releases held button and never continues path", async f => {
    const observed = await f.observe(); const controller = new AbortController();
    f.state.sleepHook = () => controller.abort();
    await rejects("REQUEST_CANCELLED", () => f.backend.execute({ action: "drag_client", observationId: observed.observationId, x: 40, y: 40, x2: 170, y2: 70, durationMs: 600, steps: 6 }, controller.signal));
    assert.equal(f.state.moves.length, 1); assert.ok(hasEdge(f, "0x80"));
  });
  await check("partial DOWN failure has a reserved cleanup edge before next transaction", async f => {
    f.state.inputHook = args => { if (args.includes("42:1")) throw new ComputerUseError("HOST_UNAVAILABLE", "fixture lost ACK", { executed: "unknown" }); };
    await rejects("HOST_UNAVAILABLE", () => f.backend.execute({ action: "key_down", key: "Shift", windowHandle: f.handle }));
    assert.deepEqual(f.state.edges, [["key", "42:1"], ["key", "42:0"]]);
  });
  await check("the transaction queue spans movement, hold and readback", async f => {
    const observed = await f.observe(); let unblock!: () => void; let moving!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; }); const begun = new Promise<void>(resolve => { moving = resolve; });
    f.state.moveHook = async () => { moving(); await gate; };
    const first = f.backend.execute({ action: "click_client", observationId: observed.observationId, x: 40, y: 40, observeAfter: true });
    await begun; const snapshots = f.state.snapshotCalls;
    const second = f.observe(); await nextTurn(); assert.equal(f.state.snapshotCalls, snapshots);
    unblock(); await first; await second; assert.equal(f.state.edges.at(-1)?.[1], "0x80");
  });
  await check("batch preflight rejects invalid later steps before any event", async f => {
    const observed = await f.observe();
    await rejects("HOST_PROTOCOL_ERROR", () => f.backend.execute({ observationId: observed.observationId, actions: [{ action: "key_press", key: "A" }, { action: "drag_client", x: 10, y: 10 }] }));
    assert.equal(f.state.edges.length, 0); assert.equal(f.state.moves.length, 0);
  });
  await check("AT-SPI refs cannot cross task ownership or observation provenance", async f => {
    const read = await f.inspect("ref-owner"); const runtimeId = read.controls![0].runtimeId;
    await rejects("STALE_OBSERVATION", () => f.backend.execute({ action: "set_control_value", windowHandle: f.handle, controlRuntimeId: runtimeId, text: "bad", taskId: "other-owner" }));
    const newer = await f.observe("ref-owner");
    await rejects("STALE_OBSERVATION", () => f.backend.execute({ action: "click_client", windowHandle: f.handle, observationId: newer.observationId, controlRuntimeId: runtimeId, x: 40, y: 40, taskId: "ref-owner" }));
    assert.equal(f.state.setValueCalls, 0); assert.equal(f.state.edges.length, 0);
  });
  await check("coordinate control input revalidates fresh bounds before any event", async f => {
    const read = await f.inspect();
    f.state.readControlHook = control => ({ ...control, boundsReliable: false });
    await rejects("STALE_OBSERVATION", () => f.backend.execute({ action: "click_client", windowHandle: f.handle, observationId: read.observationId, controlRuntimeId: read.controls![0].runtimeId, x: 40, y: 40 }));
    assert.equal(f.state.moves.length, 0); assert.equal(f.state.edges.length, 0);
    const semantic = await f.backend.execute({ action: "set_control_value", windowHandle: f.handle, controlRuntimeId: read.controls![0].runtimeId, text: "你好🌍" });
    assert.equal(semantic.verified, true); assert.equal(f.state.text, "你好🌍"); assert.equal(f.state.captureCalls, 0);
  });
  await check("Unicode insertion uses clipboard and preserves semantic uncertainty", async f => {
    const result = await f.backend.execute({ action: "type_text", windowHandle: f.handle, text: "中文 e\u0301 😀" });
    assert.equal(f.state.clipboard[0], "中文 e\u0301 😀"); assert.equal(result.pasted, true); assert.equal(result.verified, false); assert.equal(f.state.captureCalls, 0);
    assert.deepEqual(f.state.edges, [["key", "29:1", "47:1"], ["key", "47:0", "29:0"]]);
  });
  await check("diagnostics probe separately without a screenshot or input event", async f => {
    f.state.captureFailure = true;
    const status = await f.backend.execute({ action: "status" });
    assert.equal((status.capabilities as any).accessibility.available, true); assert.equal((status.capabilities as any).screenshot.available, false);
    assert.equal(f.state.captureCalls, 0); assert.deepEqual(f.state.edges, [["debug"]]);
    const count = f.state.snapshotCalls; f.backend.status(); f.backend.status(); assert.equal(f.state.snapshotCalls, count);
  });
  await check("Lua cursor/focus APIs use exact opaque addresses and verified cursor readback", async f => {
    assert.match(buildFocusScript(f.handle), /hl\.dsp\.focus/); assert.match(buildCursorMoveScript({ x: -5, y: 7 }), /hl\.dsp\.cursor\.move/);
    const calls: string[][] = [];
    const desktop = createHyprlandDesktop(async args => { calls.push(args); if (args[1] === "version") return JSON.stringify({ version: "0.56.2" }); if (args[0] === "repl" && args[1] === HYPRLAND_LUA_CAPABILITY_PROBE) return "wavealstra-lua-1"; if (args[0] === "repl") return "moved"; if (args[1] === "cursorpos") return JSON.stringify({ x: -3, y: 7 }); throw new Error(`unexpected ${args.join(" ")}`); }, { events: { connected: true, revision: 0, async connect() {}, identity: address => `life:${address}`, async shutdown() {} } });
    await rejects("HOST_PROTOCOL_ERROR", () => desktop.movePointer({ x: -5, y: 7 }));
    assert.ok(calls.some(args => args[0] === "repl")); assert.ok(calls.some(args => args[1] === "cursorpos")); await desktop.shutdown?.();
  });
  await check("compositor stable IDs close socket delivery races and visibility blocks input", async f => {
    let stableId = "1abc";
    const client = () => ({ address: f.handle, stableId, pid: 10, class: "Fixture", title: "Fixture", mapped: true, visible: true, acceptsInput: true, at: [-1500, 80], size: [600, 500], monitor: 1, workspace: { id: 1 }, xwayland: false, floating: true });
    const rawMonitors = [{ id: 1, name: "DP-1", x: -1600, y: 0, width: 2000, height: 1500, scale: 1.25, transform: 0, activeWorkspace: { id: 1 } }];
    const desktop = createHyprlandDesktop(async args => {
      if (args[1] === "version") return JSON.stringify({ version: "0.56.2" });
      if (args[0] === "repl") return "wavealstra-lua-1";
      if (args[1] === "monitors") return JSON.stringify(rawMonitors);
      if (args[1] === "clients") return JSON.stringify([client()]);
      if (args[1] === "activewindow") return JSON.stringify({ address: f.handle });
      throw new Error(`unexpected ${args.join(" ")}`);
    }, { events: { connected: true, revision: 0, async connect() {}, identity: address => `same-event-epoch:${address}`, async shutdown() {} } });
    const before = await desktop.snapshot(); stableId = "1abd";
    const after = await desktop.snapshot(); assert.notEqual(before.windows[0].identityToken, after.windows[0].identityToken);
    const parsed = parseHyprlandWindows([{ ...client(), visible: false, acceptsInput: false }], parseHyprlandMonitors(rawMonitors), f.handle)[0];
    assert.equal(parsed.visible, false); assert.equal(parsed.acceptsInput, false);
    f.window.acceptsInput = false;
    await rejects("CONTROL_NOT_ACTIONABLE", () => f.coordinates("click_client")); assert.equal(f.state.edges.length, 0);
    assert.match(buildMoveScript(f.handle, -1200, 80), /action = "set"/); await desktop.shutdown?.();
  });
  await check("screenshot capability does not keep an old successful verified flag after failure", async f => {
    let fail = false; const png = Buffer.alloc(24); Buffer.from("89504e470d0a1a0a", "hex").copy(png); png.writeUInt32BE(600, 16); png.writeUInt32BE(500, 20);
    const provider = createGrimScreenshotProvider({ available: () => true, runner: async () => { if (fail) throw new Error("forced capture failure"); return png; } });
    await provider.capture({ snapshot: await f.compositor.snapshot(), window: f.window }); assert.equal((await provider.probe()).verified, true);
    fail = true; await rejects("CAPTURE_FAILED", () => provider.capture({ snapshot: { windows: f.state.windows, monitors: f.state.monitors, layoutId: f.state.layoutId, observedAt: f.state.time }, window: f.window }));
    assert.equal((await provider.probe()).verified, false);
  });
  await check("socket2 window lifetime changes invalidate reused identical addresses", async () => {
    class EventSocket extends EventEmitter {
      destroyed = false; connecting = true;
      destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } return this; }
    }
    const sockets: EventSocket[] = [];
    let disconnected = 0;
    const events = new HyprlandEvents({
      path: "/test/hyprland/socket2", onDisconnect: () => { disconnected++; },
      connectSocket: () => {
        const socket = new EventSocket(); sockets.push(socket);
        queueMicrotask(() => { socket.connecting = false; socket.emit("connect"); });
        return socket as unknown as Socket;
      },
    });
    try {
      await events.connect(); const before = events.identity("0x123"); assert.ok(before);
      sockets[0].emit("data", Buffer.from("closewindow>>123\nopenwindow>>123,1,Fixture,Fixture\n"));
      const after = events.identity("0x123"); assert.ok(after); assert.notEqual(before, after);
      sockets[0].destroy(); assert.equal(events.identity("0x123"), undefined); assert.equal(disconnected, 1);
      await events.connect(); assert.notEqual(events.identity("0x123"), after);
      // A stale socket cannot invalidate a reconnected stream.
      const reconnected = events.identity("0x123"); sockets[0].emit("close");
      assert.equal(events.identity("0x123"), reconnected);
    } finally { await events.shutdown(); }
  });
  console.log(`\n${passed} Linux native backend behavior checks passed (mock desktop; no GUI acceptance claim).`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
