import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { AtSpiDriver, atSpiStateNames } from "../src/main/platform/computer-use/linux/atspiDriver";
import { AtSpiClient, validateAtSpiHandshake } from "../src/main/platform/computer-use/linux/atspiClient";
import { parseAtSpiBusAddress, type AtSpiBus, type AtSpiBusFactory, type AtSpiMessage, type AtSpiSignal } from "../src/main/platform/computer-use/linux/atspiDbus";
import { ComputerUseError, type WindowInfo } from "../src/main/platform/computer-use/protocol";
import type { AtSpiRect, AtSpiWorkerRequest } from "../src/main/platform/computer-use/linux/atspiTypes";

const APP = ":1.77";
const APP_PATH = "/org/test/app";
const FRAME = APP_PATH + "/frame";
const EDIT = FRAME + "/edit";
const BUTTON = FRAME + "/button";
const SLIDER = FRAME + "/slider";
const ACCESSIBLE = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const TEXT = "org.a11y.atspi.Text";
const ACTION = "org.a11y.atspi.Action";
const EDITABLE = "org.a11y.atspi.EditableText";
const VALUE = "org.a11y.atspi.Value";
const PROPS = "org.freedesktop.DBus.Properties";

function windowFixture(overrides: Partial<WindowInfo> = {}): WindowInfo {
  return {
    handle: "0xabc000000000000001", processId: 4242, className: "test-app", title: "Accessibility fixture",
    visible: true, minimized: false, foreground: true, windowRect: { left: -100, top: 80, right: 700, bottom: 680, width: 800, height: 600 },
    clientOrigin: { x: -100, y: 80 }, clientRect: { x: 0, y: 0, width: 800, height: 600 }, dpi: 144, scaleFactor: 1.5,
    coordinateSpace: "hyprland-logical", clientGeometryVerified: true, layoutId: "layout-1", identityToken: "window-generation-1",
    ...overrides,
  };
}

function stateWords(indices: number[]): number[] {
  const words = [0, 0];
  for (const index of indices) words[Math.floor(index / 32)] = (words[Math.floor(index / 32)] | (1 << (index % 32))) >>> 0;
  return words;
}

interface FixtureNode {
  name: string;
  role: number;
  parent?: string;
  children: string[];
  states: number[];
  interfaces: string[];
  bounds: AtSpiRect;
  origin?: { x: number; y: number };
  screenBounds?: AtSpiRect | null;
  windowBounds?: AtSpiRect | null;
  text?: string;
  value?: number;
}

class FakeBus implements AtSpiBus {
  readonly signals = new Set<(event: AtSpiSignal) => void>();
  readonly disconnects = new Set<(error?: Error) => void>();
  constructor(private readonly handler: (request: AtSpiMessage, signal?: AbortSignal) => Promise<unknown>) {}
  async call(request: AtSpiMessage, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (options.signal?.aborted) throw Object.assign(new Error("Aborted"), { code: "ABORT_ERR" });
    return await this.handler(request, options.signal);
  }
  onSignal(listener: (event: AtSpiSignal) => void): () => void { this.signals.add(listener); return () => { this.signals.delete(listener); }; }
  onDisconnect(listener: (error?: Error) => void): () => void { this.disconnects.add(listener); return () => { this.disconnects.delete(listener); }; }
  async close(): Promise<void> { this.signals.clear(); this.disconnects.clear(); }
  emit(event: AtSpiSignal): void { for (const listener of this.signals) listener(event); }
  disconnect(): void { for (const listener of this.disconnects) listener(new Error("fixture bus lost")); }
}

class Fixture {
  readonly nodes = new Map<string, FixtureNode>([
    [APP_PATH, { name: "Fixture", role: 75, children: [FRAME], states: stateWords([8, 25, 30]), interfaces: [ACCESSIBLE], bounds: { x: 0, y: 0, width: 800, height: 600 } }],
    [FRAME, { name: "Accessibility fixture", role: 23, parent: APP_PATH, children: [EDIT, BUTTON, SLIDER], states: stateWords([1, 8, 25, 30]), interfaces: [ACCESSIBLE, COMPONENT], bounds: { x: 0, y: 0, width: 800, height: 600 }, origin: { x: -100, y: 80 } }],
    [EDIT, { name: "Message", role: 79, parent: FRAME, children: [], states: stateWords([7, 8, 11, 25, 30]), interfaces: [ACCESSIBLE, COMPONENT, TEXT, EDITABLE], bounds: { x: 150, y: 50, width: 200, height: 40 }, text: "" }],
    [BUTTON, { name: "Send", role: 43, parent: FRAME, children: [], states: stateWords([8, 11, 25, 30]), interfaces: [ACCESSIBLE, COMPONENT, ACTION], bounds: { x: 0, y: 0, width: 100, height: 30 } }],
    [SLIDER, { name: "Volume", role: 51, parent: FRAME, children: [], states: stateWords([8, 11, 25, 30]), interfaces: [ACCESSIBLE, COMPONENT, VALUE], bounds: { x: 400, y: 100, width: 150, height: 30 }, value: 1 }],
  ]);
  readonly addresses: string[] = [];
  readonly calls: AtSpiMessage[] = [];
  readonly buses: FakeBus[] = [];
  readonly mutations: string[] = [];
  failTextRead = false;
  mutationHook?: (message: AtSpiMessage) => void;
  queryHook?: (message: AtSpiMessage) => void;
  active = 0;
  maxActive = 0;
  latencyMs = 0;
  appPresent = true;
  sessionFailure?: Error;
  readonly factory: AtSpiBusFactory = async (address) => {
    this.addresses.push(address);
    const session = address === "unix:path=/fixture/session";
    const bus = new FakeBus(async (message, signal) => {
      this.calls.push(message);
      this.active += 1;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        if (this.latencyMs) await new Promise((resolveDelay) => setTimeout(resolveDelay, this.latencyMs));
        if (signal?.aborted) throw Object.assign(new Error("Aborted"), { code: "ABORT_ERR" });
        this.queryHook?.(message);
        if (session) {
          assert.equal(message.destination, "org.a11y.Bus");
          assert.equal(message.path, "/org/a11y/bus");
          assert.equal(message.member, "GetAddress");
          if (this.sessionFailure) throw this.sessionFailure;
          return "unix:abstract=fixture-a11y";
        }
        return this.reply(message);
      } finally { this.active -= 1; }
    });
    this.buses.push(bus);
    return bus;
  };
  driver(): AtSpiDriver { return new AtSpiDriver({ busFactory: this.factory, sessionAddress: "unix:path=/fixture/session" }); }
  get accessibility(): FakeBus { return this.buses[this.buses.length - 1]; }
  private node(path: string): FixtureNode {
    const node = this.nodes.get(path);
    if (!node) throw Object.assign(new Error("Unknown object"), { dbusName: "org.freedesktop.DBus.Error.UnknownObject" });
    return node;
  }
  private root(path: string): FixtureNode {
    const node = this.node(path);
    return node.origin ? node : node.parent ? this.root(node.parent) : node;
  }
  private props(path: string): Record<string, unknown> {
    const node = this.node(path);
    return { Name: node.name, Description: "", ChildCount: node.children.length, Parent: [APP, node.parent ?? "/org/a11y/atspi/null"], AccessibleId: path };
  }
  private reply(message: AtSpiMessage): unknown {
    const { interface: iface, member, body = [], path } = message;
    if (message.destination === "org.freedesktop.DBus") {
      if (["AddMatch", "RemoveMatch"].includes(member)) return undefined;
      if (member === "GetConnectionUnixProcessID") return 4242;
      if (member === "GetNameOwner") return APP;
    }
    if (iface === "org.a11y.atspi.Registry") {
      if (member === "RegisterEvent") { assert.equal(message.signature, "sass"); return undefined; }
      if (member === "DeregisterEvent") { assert.equal(message.signature, "ss"); return undefined; }
    }
    if (path === "/org/a11y/atspi/accessible/root" && member === "GetChildren") return this.appPresent ? [[APP, APP_PATH]] : [];
    const node = this.node(path);
    if (iface === PROPS) {
      if (member === "GetAll" && body[0] === ACCESSIBLE) return this.props(path);
      if (member === "GetAll" && body[0] === VALUE) return { MinimumValue: 0, MaximumValue: 10, CurrentValue: node.value };
      if (member === "Get" && body[0] === ACCESSIBLE) return this.props(path)[String(body[1])];
      if (member === "Get" && body[0] === ACTION && body[1] === "NActions") return 1;
      if (member === "Get" && body[0] === TEXT && body[1] === "CharacterCount") return Array.from(node.text ?? "").length;
      if (member === "Get" && body[0] === VALUE && body[1] === "CurrentValue") return node.value;
      if (member === "Set" && body[0] === VALUE) {
        assert.equal(message.signature, "ssv");
        assert.deepEqual((body[2] as unknown[])[0], "d");
        node.value = Number((body[2] as unknown[])[1]);
        this.mutations.push("value");
        this.mutationHook?.(message);
        return undefined;
      }
    }
    if (iface === ACCESSIBLE) {
      if (member === "GetRole") return node.role;
      if (member === "GetState") return node.states;
      if (member === "GetInterfaces") return node.interfaces;
      if (member === "GetChildren") return node.children.map((child) => [APP, child]);
    }
    if (iface === COMPONENT) {
      if (member === "GetExtents") {
        assert.equal(message.signature, "u");
        const mode = body[0];
        const origin = this.root(path).origin ?? { x: 0, y: 0 };
        const rectangle = mode === 1 ? node.windowBounds ?? node.bounds :
          node.screenBounds ?? { ...node.bounds, x: origin.x + node.bounds.x, y: origin.y + node.bounds.y };
        if (mode === 0 && node.screenBounds === null || mode === 1 && node.windowBounds === null) throw new Error("No reliable bounds");
        return [rectangle.x, rectangle.y, rectangle.width, rectangle.height];
      }
      if (member === "GetAccessibleAtPoint") {
        assert.equal(message.signature, "iiu");
        const origin = this.root(path).origin ?? { x: 0, y: 0 };
        const x = Number(body[0]) - (body[2] === 0 ? origin.x : 0);
        const y = Number(body[1]) - (body[2] === 0 ? origin.y : 0);
        const child = node.children.find((candidate) => {
          const r = this.node(candidate).bounds;
          return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
        });
        return [APP, child ?? path];
      }
    }
    if (iface === TEXT && member === "GetText") {
      if (this.failTextRead) throw new Error("Application refused text readback");
      assert.equal(message.signature, "ii");
      return Array.from(node.text ?? "").slice(Number(body[0]), Number(body[1])).join("");
    }
    if (iface === EDITABLE && member === "SetTextContents") {
      assert.equal(message.signature, "s");
      node.text = String(body[0]);
      this.mutations.push("text");
      this.mutationHook?.(message);
      return true;
    }
    if (iface === ACTION) {
      if (member === "GetName") return "click";
      if (member === "DoAction") {
        assert.equal(message.signature, "i");
        assert.equal(body[0], 0);
        this.mutations.push("action");
        this.mutationHook?.(message);
        return true;
      }
    }
    throw new Error("Unexpected fixture call " + iface + "." + member);
  }
}

let passed = 0;
async function test(name: string, callback: () => void | Promise<void>): Promise<void> {
  await callback();
  passed += 1;
  console.log("PASS " + name);
}

async function withDriver(callback: (driver: AtSpiDriver, fixture: Fixture, window: WindowInfo) => Promise<void>): Promise<void> {
  const fixture = new Fixture();
  const driver = fixture.driver();
  try { await callback(driver, fixture, windowFixture()); }
  finally { await driver.shutdown(); }
}

async function main(): Promise<void> {
  await test("Unix path/abstract addresses use native sockets and decode escaped bytes", () => {
    assert.deepEqual(parseAtSpiBusAddress("unix:path=/run/user/1000/a11y%20bus,guid=abc;unix:abstract=accessibility-1"), ["/run/user/1000/a11y bus", "\0accessibility-1"]);
    assert.throws(() => parseAtSpiBusAddress("unixexec:path=/bin/sh,argv1=-c,argv2=bad"), /unix:path/);
    assert.throws(() => parseAtSpiBusAddress("unix:path=/tmp/%00bad"), /NUL/);
    assert.throws(() => parseAtSpiBusAddress("unix:path=/a,abstract=b"), /同时/);
  });
  await test("AT-SPI state words decode high bits correctly", () => {
    assert.deepEqual(atSpiStateNames(stateWords([8, 30, 32, 43])), ["enabled", "visible", "indeterminate", "read_only"]);
  });
  await test("Worker handshake checks actual Node and pinned library versions", () => {
    const good = { protocol: 1, backend: "linux-atspi", nodeVersion: "24.1.0", dbusNativeVersion: "0.16.3", pid: 123, ready: true };
    assert.equal(validateAtSpiHandshake(good).pid, 123);
    assert.throws(() => validateAtSpiHandshake({ ...good, nodeVersion: "22.12.0" }), /Node/);
    assert.throws(() => validateAtSpiHandshake({ ...good, nodeVersion: "garbage" }), /Node/);
    assert.throws(() => validateAtSpiHandshake({ ...good, dbusNativeVersion: "0.15.0" }), /dbus-native/);
  });
  await test("Discovery uses session GetAddress followed by a separate accessibility bus", () => withDriver(async (driver, fixture) => {
    const result = await driver.probe();
    assert.equal(result.available, true);
    assert.equal(result.applicationCount, 1);
    assert.deepEqual(fixture.addresses, ["unix:path=/fixture/session", "unix:abstract=fixture-a11y"]);
    assert.equal(fixture.calls.filter((call) => call.member === "GetAddress").length, 1);
    assert(fixture.calls.some((call) => call.member === "RegisterEvent"));
  }));
  await test("Missing accessibility service is distinguished from an empty registry", async () => {
    const missing = new Fixture();
    missing.sessionFailure = Object.assign(new Error("Service absent"), { dbusName: "org.freedesktop.DBus.Error.ServiceUnknown" });
    const driver = missing.driver();
    assert.equal((await driver.probe()).code, "ACCESSIBILITY_SERVICE_MISSING");
    await driver.shutdown();
    await withDriver(async (emptyDriver, fixture, window) => {
      fixture.appPresent = false;
      assert.equal((await emptyDriver.probe()).applicationCount, 0);
      await assert.rejects(emptyDriver.inspectWindow(window, { peerWindows: [window] }), (error: unknown) => {
        assert(error instanceof ComputerUseError);
        assert.equal((error.details as Record<string, unknown>).diagnosticCode, "APPLICATION_NOT_ACCESSIBLE");
        return true;
      });
    });
  });
  await test("Legitimate zero-origin control and negative-origin window have certified logical bounds", () => withDriver(async (driver, _fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    assert.equal(tree.controls.length, 4);
    const button = tree.controls.find((control) => control.name === "Send")!;
    assert.equal(button.boundsReliable, true);
    assert.deepEqual(button.clientBoundsDip, { x: 0, y: 0, width: 100, height: 30 });
    assert.deepEqual(button.screenBoundsLogical, { left: -100, top: 80, width: 100, height: 30 });
    assert.equal(button.screenBoundsPhysical, undefined);
    assert(button.runtimeId.startsWith("atspi:"));
  }));
  await test("Contradictory bounds lose coordinate capability while semantic text remains available", () => withDriver(async (driver, fixture, window) => {
    fixture.nodes.get(EDIT)!.windowBounds = { x: 0, y: 0, width: 200, height: 40 };
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    const edit = tree.controls.find((control) => control.name === "Message")!;
    assert.equal(edit.boundsReliable, false);
    assert.equal(edit.clientBoundsDip, undefined);
    assert.equal((await driver.setValue(window, edit.runtimeId, "中文 😀")).verified, true);
  }));
  await test("Unknown coordinate units never become reliable via scale=1 fallback", () => withDriver(async (driver, fixture, window) => {
    fixture.nodes.get(FRAME)!.screenBounds = null;
    fixture.nodes.get(FRAME)!.windowBounds = { x: 0, y: 0, width: 1200, height: 900 };
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    assert.equal(tree.boundsReliable, false);
    assert(tree.controls.every((control) => control.clientBoundsDip === undefined));
  }));
  await test("Same-PID same-title windows bind by exact distinct geometry", () => withDriver(async (driver, fixture, first) => {
    const path = APP_PATH + "/second";
    fixture.nodes.get(APP_PATH)!.children.push(path);
    fixture.nodes.set(path, { ...fixture.nodes.get(FRAME)!, children: [], origin: { x: 1000, y: 80 } });
    const second = windowFixture({ handle: "0xdef", clientOrigin: { x: 1000, y: 80 }, identityToken: "second" });
    const tree = await driver.inspectWindow(second, { peerWindows: [first, second] });
    assert.equal(tree.controls[0].atspi.objectPath, path);
    assert.equal(tree.treeStatus, "empty");
  }));
  await test("Ambiguous same-PID same-title windows reject instead of choosing the first tree", () => withDriver(async (driver, fixture, first) => {
    const path = APP_PATH + "/second";
    fixture.nodes.get(FRAME)!.screenBounds = null;
    fixture.nodes.get(APP_PATH)!.children.push(path);
    fixture.nodes.set(path, { ...fixture.nodes.get(FRAME)!, children: [], origin: { x: 1000, y: 80 }, screenBounds: null });
    const second = windowFixture({ handle: "0xdef", clientOrigin: { x: 1000, y: 80 }, identityToken: "second" });
    await assert.rejects(driver.inspectWindow(first, { peerWindows: [first, second] }), (error: unknown) => error instanceof ComputerUseError && error.code === "WINDOW_AMBIGUOUS");
  }));
  await test("Traversal reports depth and node limits instead of an apparently complete tree", () => withDriver(async (driver, _fixture, window) => {
    const byDepth = await driver.inspectWindow(window, { peerWindows: [window], maxDepth: 0 });
    assert.equal(byDepth.truncated, true);
    assert.equal(byDepth.controls.length, 1);
    const byCount = await driver.inspectWindow(window, { peerWindows: [window], maxNodes: 2 });
    assert.equal(byCount.truncated, true);
    assert.equal(byCount.controls.length, 2);
  }));
  await test("Multiple observations retain their own references and Unicode write verifies exact text", () => withDriver(async (driver, fixture, window) => {
    const first = await driver.inspectWindow(window, { peerWindows: [window] });
    const firstEdit = first.controls.find((control) => control.name === "Message")!;
    const second = await driver.inspectWindow(window, { peerWindows: [window] });
    assert.notEqual(firstEdit.runtimeId, second.controls.find((control) => control.name === "Message")!.runtimeId);
    const result = await driver.setValue(window, firstEdit.runtimeId, "中文 😀 e\u0301");
    assert.equal(result.executed, true);
    assert.equal(result.verified, true);
    assert.equal(result.after?.text, "中文 😀 e\u0301");
    assert.deepEqual(fixture.mutations, ["text"]);
  }));
  await test("DoAction success is not a verified business outcome", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    const result = await driver.invoke(window, tree.controls.find((control) => control.name === "Send")!.runtimeId);
    assert.equal(result.executed, true);
    assert.equal(result.verified, false);
    assert(result.after);
    assert.deepEqual(fixture.mutations, ["action"]);
  }));
  await test("Numeric Value capability validates range and reads CurrentValue back", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    const slider = tree.controls.find((control) => control.name === "Volume")!;
    await assert.rejects(driver.setValue(window, slider.runtimeId, "11"), /范围/);
    assert.deepEqual(fixture.mutations, []);
    const result = await driver.setValue(window, slider.runtimeId, "2.5");
    assert.equal(result.verified, true);
    assert.equal(result.after?.value, 2.5);
  }));
  await test("A failed text read cannot verify an empty write or imply window closure", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    fixture.mutationHook = () => { fixture.failTextRead = true; };
    const result = await driver.setValue(window, tree.controls.find((control) => control.name === "Message")!.runtimeId, "");
    assert.equal(result.executed, true);
    assert.equal(result.verified, false);
    assert.equal(result.after?.text, undefined);
    assert.deepEqual(fixture.mutations, ["text"]);
  }));
  await test("A timed-out mutation is read back without replay", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    fixture.mutationHook = () => { throw Object.assign(new Error("Reply lost"), { code: "ETIMEDOUT" }); };
    const result = await driver.setValue(window, tree.controls.find((control) => control.name === "Message")!.runtimeId, "仅一次");
    assert.equal(result.executed, "unknown");
    assert.equal(result.verified, true);
    assert.deepEqual(fixture.mutations, ["text"]);
  }));
  await test("Cancellation after dispatch preserves execution evidence and does not repeat text", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    const abort = new AbortController();
    fixture.mutationHook = () => { abort.abort(); throw new Error("Cancelled after application handled write"); };
    const result = await driver.setValue(window, tree.controls.find((control) => control.name === "Message")!.runtimeId, "收到", abort.signal);
    assert.equal(result.executed, "unknown");
    assert.equal(result.verified, true);
    assert.deepEqual(fixture.mutations, ["text"]);
  }));
  await test("Window movement invalidates old target-bound references before a mutation", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    const moved = { ...window, clientOrigin: { x: 50, y: 80 } };
    await assert.rejects(driver.invoke(moved, tree.controls.find((control) => control.name === "Send")!.runtimeId), (error: unknown) => error instanceof ComputerUseError && error.code === "TARGET_CHANGED");
    assert.deepEqual(fixture.mutations, []);
  }));
  await test("Object rebuild during traversal rejects the new observation", () => withDriver(async (driver, fixture, window) => {
    let fired = false;
    fixture.queryHook = (message) => {
      if (!fired && message.path === EDIT && message.member === "GetInterfaces") {
        fired = true;
        fixture.accessibility.emit({ sender: APP, path: FRAME, interface: "org.a11y.atspi.Event.Object", member: "ChildrenChanged", body: ["remove", 0, 0] });
      }
    };
    await assert.rejects(driver.inspectWindow(window, { peerWindows: [window] }), (error: unknown) => error instanceof ComputerUseError && error.code === "STALE_OBSERVATION");
  }));
  await test("Object rebuild during mutation cannot verify a replacement at the same object path", () => withDriver(async (driver, fixture, window) => {
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    fixture.mutationHook = () => fixture.accessibility.emit({ sender: APP, path: FRAME, interface: "org.a11y.atspi.Event.Object", member: "ChildrenChanged", body: ["add", 0, 0] });
    const result = await driver.setValue(window, tree.controls.find((control) => control.name === "Message")!.runtimeId, "replacement");
    assert.equal(result.executed, true);
    assert.equal(result.verified, false);
    assert(result.readbackError);
    assert.deepEqual(fixture.mutations, ["text"]);
  }));
  await test("App exit and total bus reconnect both invalidate previously issued references", () => withDriver(async (driver, fixture, window) => {
    let tree = await driver.inspectWindow(window, { peerWindows: [window] });
    fixture.accessibility.emit({ sender: "org.freedesktop.DBus", interface: "org.freedesktop.DBus", member: "NameOwnerChanged", body: [APP, APP, ""] });
    await assert.rejects(driver.invoke(window, tree.controls.find((control) => control.name === "Send")!.runtimeId), /重新|变化|退出/);
    tree = await driver.inspectWindow(window, { peerWindows: [window] });
    const generation = tree.generation;
    fixture.accessibility.disconnect();
    assert.notEqual((await driver.probe()).generation, generation);
    await assert.rejects(driver.invoke(window, tree.controls.find((control) => control.name === "Send")!.runtimeId), (error: unknown) => error instanceof ComputerUseError && error.code === "STALE_OBSERVATION");
    assert.deepEqual(fixture.mutations, []);
  }));
  await test("D-Bus concurrency stays bounded under concurrent observations", () => withDriver(async (driver, fixture, window) => {
    fixture.latencyMs = 1;
    await Promise.all(Array.from({ length: 5 }, () => driver.inspectWindow(window, { peerWindows: [window] })));
    assert(fixture.maxActive <= 8, "observed " + fixture.maxActive + " concurrent D-Bus calls");
  }));
  await test("Shutdown deregisters events and removes match rules", async () => {
    const fixture = new Fixture();
    const driver = fixture.driver();
    await driver.probe();
    await driver.shutdown();
    assert.equal(fixture.calls.filter((call) => call.member === "DeregisterEvent").length, fixture.calls.filter((call) => call.member === "RegisterEvent").length);
    assert.equal(fixture.calls.filter((call) => call.member === "RemoveMatch").length, fixture.calls.filter((call) => call.member === "AddMatch").length);
  });
  await test("Client cancellation before startup sends no IPC or desktop request", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawns = 0;
    const client = new AtSpiClient({ spawnWorker: () => { spawns += 1; throw new Error("must not spawn"); } });
    await assert.rejects(client.probe(controller.signal), (error: unknown) => error instanceof ComputerUseError && error.code === "REQUEST_CANCELLED");
    assert.equal(spawns, 0);
    await client.shutdown();
  });
  await test("Worker death reports an unknown mutation without replay and notifies recovery", async () => {
    const child = new EventEmitter() as EventEmitter & { connected: boolean; stderr: PassThrough; send: (request: AtSpiWorkerRequest, callback?: (error?: Error | null) => void) => boolean; kill: () => boolean };
    child.connected = true;
    child.stderr = new PassThrough();
    const sent: AtSpiWorkerRequest[] = [];
    child.kill = () => { child.connected = false; child.emit("exit", null, "SIGTERM"); return true; };
    child.send = (request, callback) => { sent.push(request); callback?.(); return true; };
    let exits = 0;
    const client = new AtSpiClient({
      workerPath: resolve("src/main/platform/computer-use/linux/atspiWorker.ts"),
      spawnWorker: () => {
        queueMicrotask(() => child.emit("message", { type: "ready", handshake: { protocol: 1, backend: "linux-atspi", nodeVersion: process.versions.node, dbusNativeVersion: "0.16.3", pid: 999, ready: true } }));
        return child as unknown as ChildProcess;
      },
      onUnexpectedExit: () => { exits += 1; },
    });
    const result = client.invoke(windowFixture(), "test-reference");
    await new Promise((resume) => setImmediate(resume));
    child.kill();
    await assert.rejects(result, (error: unknown) => {
      assert(error instanceof ComputerUseError);
      assert.equal((error.details as Record<string, unknown>).executed, "unknown");
      assert.equal((error.details as Record<string, unknown>).retrySafe, false);
      return true;
    });
    assert.equal(sent.filter((request) => request.method === "invoke").length, 1);
    assert.equal(exits, 1);
    await client.shutdown();
  });
  await test("Ignored mutation cancellation quarantines immediately and waits confirmed worker exit before a new generation", async () => {
    type FixtureChild = EventEmitter & {
      connected: boolean; stderr: PassThrough; pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null;
      sent: AtSpiWorkerRequest[]; signals: NodeJS.Signals[];
      send: (request: AtSpiWorkerRequest, callback?: (error?: Error | null) => void) => boolean;
      kill: (signal: NodeJS.Signals) => boolean;
    };
    const children: FixtureChild[] = [];
    let unexpectedExits = 0;
    const ready = (pid: number) => ({ type: "ready", handshake: { protocol: 1, backend: "linux-atspi", nodeVersion: process.versions.node, dbusNativeVersion: "0.16.3", pid, ready: true } });
    const client = new AtSpiClient({
      workerPath: resolve("src/main/platform/computer-use/linux/atspiWorker.ts"),
      spawnWorker: () => {
        const child = new EventEmitter() as FixtureChild;
        child.connected = true; child.stderr = new PassThrough(); child.pid = 9100 + children.length;
        child.exitCode = null; child.signalCode = null; child.sent = []; child.signals = [];
        child.send = (request, callback) => { child.sent.push(request); callback?.(); return true; };
        child.kill = signal => {
          child.signals.push(signal);
          // The first worker ignores SIGTERM and SIGKILL until the fixture
          // confirms its actual exit. Recording a signal is not an exit.
          if (children.indexOf(child) > 0) { child.connected = false; child.signalCode = signal; child.emit("exit", null, signal); }
          return true;
        };
        children.push(child); queueMicrotask(() => child.emit("message", ready(child.pid)));
        return child as unknown as ChildProcess;
      },
      onUnexpectedExit: () => { unexpectedExits += 1; },
    });
    const controller = new AbortController();
    const mutation = client.invoke(windowFixture(), "old-reference", undefined, controller.signal);
    const rejected = assert.rejects(mutation, (error: unknown) => {
      assert(error instanceof ComputerUseError);
      assert.equal(error.code, "REQUEST_CANCELLED");
      assert.equal((error.details as Record<string, unknown>).executed, "unknown");
      assert.equal((error.details as Record<string, unknown>).retrySafe, false);
      return true;
    });
    await new Promise(resume => setImmediate(resume));
    controller.abort(); await rejected;
    const old = children[0];
    assert.equal(client.pid, undefined); assert.equal(client.handshake, undefined);
    assert.deepEqual(old.sent.map(request => request.method), ["invoke", "cancel"]);
    assert.deepEqual(old.signals, ["SIGTERM"]);
    let probeResolved = false;
    const probe = client.probe().then(value => { probeResolved = true; return value; });
    old.emit("message", ready(old.pid));
    await new Promise(resume => setTimeout(resume, 550));
    assert.equal(children.length, 1); assert.equal(probeResolved, false); assert.equal(client.pid, undefined);
    assert.deepEqual(old.signals, ["SIGTERM", "SIGKILL"]);
    assert.deepEqual(old.sent.map(request => request.method), ["invoke", "cancel"]);
    old.connected = false; old.signalCode = "SIGKILL"; old.emit("exit", null, "SIGKILL");
    await new Promise(resume => setImmediate(resume));
    assert.equal(children.length, 2);
    const fresh = children[1]; const request = fresh.sent.find(value => value.method === "probe");
    assert(request); assert.equal(client.pid, fresh.pid);
    old.emit("message", ready(old.pid));
    old.emit("message", { type: "result", id: request.id, result: { available: true, generation: "old-worker" } });
    await new Promise(resume => setImmediate(resume));
    assert.equal(probeResolved, false); assert.equal(client.pid, fresh.pid);
    fresh.emit("message", { type: "result", id: request.id, result: { available: true, generation: "fresh-worker" } });
    assert.equal((await probe).generation, "fresh-worker");
    assert.equal(unexpectedExits, 1);
    assert.equal(children.flatMap(child => child.sent).filter(request => request.method === "invoke").length, 1);
    await client.shutdown();
  });
  console.log("AT-SPI driver: " + passed + " behavior checks passed");
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
