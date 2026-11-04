/**
 * Real D-Bus/IPC integration on private buses. The application is a protocol
 * fixture, not a GUI: this verifies transport/signatures/lifecycle and does not
 * claim GTK, Chromium, Hyprland, input, or packaged-desktop acceptance.
 */
import assert from "node:assert/strict";
import { spawn, fork, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import * as dbus from "dbus-native";
import { AtSpiDriver } from "../src/main/platform/computer-use/linux/atspiDriver";
import { AtSpiClient } from "../src/main/platform/computer-use/linux/atspiClient";
import { createAtSpiBus } from "../src/main/platform/computer-use/linux/atspiDbus";
import { ComputerUseError, type WindowInfo } from "../src/main/platform/computer-use/protocol";

const ACCESSIBLE = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const TEXT = "org.a11y.atspi.Text";
const EDITABLE = "org.a11y.atspi.EditableText";
const ACTION = "org.a11y.atspi.Action";
const VALUE = "org.a11y.atspi.Value";
const REGISTRY = "org.a11y.atspi.Registry";
const ROOT = "/org/test/application";
const FRAME = ROOT + "/window";
const EDIT = FRAME + "/edit";
const BUTTON = FRAME + "/button";
const SLIDER = FRAME + "/slider";

interface PrivateBus { child: ChildProcess; address: string }

async function privateBus(address: string): Promise<PrivateBus> {
  const child = spawn("dbus-daemon", ["--session", "--nofork", "--print-address=1", "--address=" + address], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-4_096); });
  return await new Promise<PrivateBus>((resolveBus, reject) => {
    let settled = false;
    const finish = (error?: Error, readyAddress?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGTERM"); reject(error); }
      else resolveBus({ child, address: readyAddress! });
    };
    const timer = setTimeout(() => finish(new Error("Private dbus-daemon startup timed out: " + stderr)), 3_000);
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => finish(new Error("Private dbus-daemon exited " + String(code) + ": " + stderr)));
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const line = stdout.split("\n")[0];
      if (stdout.includes("\n") && line.startsWith("unix:")) finish(undefined, line);
    });
  });
}

async function stopPrivateBus(bus: PrivateBus): Promise<void> {
  if (bus.child.exitCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => { bus.child.kill("SIGKILL"); resolveStop(); }, 500);
    bus.child.once("exit", () => { clearTimeout(timer); resolveStop(); });
    bus.child.kill("SIGTERM");
  });
}

async function service(address: string): Promise<dbus.MessageBus> {
  const bus = dbus.createClient({ busAddress: address, fdTransport: false, plainValues: true, variants: "plain", timeout: 2_000 });
  bus.connection.on("error", () => {});
  await bus.getId();
  return bus;
}

interface WireFixture {
  app: dbus.MessageBus;
  registrations: Set<string>;
  mutations: { text: number; action: number; value: number };
  text(): string;
  value(): number;
  holdNextState(): { entered: Promise<void>; release(): void };
}

function implementation(values: Record<string, unknown> = {}): EventEmitter & Record<string, unknown> {
  return Object.assign(new EventEmitter(), values);
}

function installFixture(app: dbus.MessageBus, registry: dbus.MessageBus): WireFixture {
  const busName = app.name as string;
  assert(busName.startsWith(":"));
  const registrations = new Set<string>();
  const mutations = { text: 0, action: 0, value: 0 };
  let text = "";
  let currentValue = 1;
  let heldState: { entered: () => void; wait: Promise<void> } | undefined;
  registry.exportInterface(implementation({
    RegisterEvent: (event: string, properties: string[], owner: string) => { assert.deepEqual(properties, []); assert.equal(owner, ""); registrations.add(event); },
    DeregisterEvent: (event: string, owner: string) => { assert.equal(owner, ""); registrations.delete(event); },
  }), "/org/a11y/atspi/registry", {
    name: REGISTRY,
    methods: { RegisterEvent: ["sass", "", ["event", "properties", "app_bus_name"], []], DeregisterEvent: ["ss", "", ["event", "app_bus_name"], []] },
  });
  registry.exportInterface(implementation({ GetChildren: () => [[busName, ROOT]] }), "/org/a11y/atspi/accessible/root", {
    name: ACCESSIBLE, methods: { GetChildren: ["", "a(so)", [], ["children"]] },
  });
  const nodes = [
    { path: ROOT, name: "Protocol fixture", role: 75, parent: "/org/a11y/atspi/null", children: [FRAME], bounds: [0, 0, 800, 600], extra: [] as string[] },
    { path: FRAME, name: "Wire fixture", role: 23, parent: ROOT, children: [EDIT, BUTTON, SLIDER], bounds: [0, 0, 800, 600], extra: [COMPONENT] },
    { path: EDIT, name: "Message", role: 79, parent: FRAME, children: [], bounds: [20, 40, 250, 40], extra: [COMPONENT, TEXT, EDITABLE] },
    { path: BUTTON, name: "Submit", role: 43, parent: FRAME, children: [], bounds: [300, 40, 100, 40], extra: [COMPONENT, ACTION] },
    { path: SLIDER, name: "Count", role: 51, parent: FRAME, children: [], bounds: [450, 40, 150, 40], extra: [COMPONENT, VALUE] },
  ];
  for (const node of nodes) {
    const accessible = implementation({
      Name: node.name, Parent: [busName, node.parent], ChildCount: node.children.length, AccessibleId: node.path,
      GetRole: () => node.role,
      GetChildren: () => node.children.map((child) => [busName, child]),
      GetInterfaces: () => [ACCESSIBLE, ...node.extra],
      GetState: async () => {
        if (heldState && node.path === EDIT) {
          const wait = heldState;
          heldState = undefined;
          wait.entered();
          await wait.wait;
        }
        return [(1 << 8) | (1 << 11) | (1 << 25) | (1 << 30), 0];
      },
    });
    app.exportInterface(accessible, node.path, {
      name: ACCESSIBLE,
      properties: { Name: { type: "s", access: "read" }, Parent: { type: "(so)", access: "read" }, ChildCount: { type: "i", access: "read" }, AccessibleId: { type: "s", access: "read" } },
      methods: { GetRole: ["", "u", [], ["role"]], GetChildren: ["", "a(so)", [], ["children"]], GetInterfaces: ["", "as", [], ["interfaces"]], GetState: ["", "au", [], ["states"]] },
    });
    if (!node.extra.includes(COMPONENT)) continue;
    app.exportInterface(implementation({
      GetExtents: (coordinateType: number) => {
        const [x, y, width, height] = node.bounds;
        return [x + (coordinateType === 0 ? -200 : 0), y + (coordinateType === 0 ? 100 : 0), width, height];
      },
      GetAccessibleAtPoint: (xRaw: number, yRaw: number, coordinateType: number) => {
        const x = xRaw - (coordinateType === 0 ? -200 : 0);
        const y = yRaw - (coordinateType === 0 ? 100 : 0);
        const child = node.children.find((path) => {
          const entry = nodes.find((item) => item.path === path)!;
          const [left, top, width, height] = entry.bounds;
          return x >= left && y >= top && x < left + width && y < top + height;
        });
        return [busName, child ?? node.path];
      },
    }), node.path, {
      name: COMPONENT,
      methods: { GetExtents: ["u", "(iiii)", ["coord_type"], ["bounds"]], GetAccessibleAtPoint: ["iiu", "(so)", ["x", "y", "coord_type"], ["accessible"]] },
    });
  }
  const textInterface = implementation({ GetText: (start: number, end: number) => Array.from(text).slice(start, end).join("") });
  Object.defineProperty(textInterface, "CharacterCount", { enumerable: true, get: () => Array.from(text).length });
  app.exportInterface(textInterface, EDIT, { name: TEXT, properties: { CharacterCount: { type: "i", access: "read" } }, methods: { GetText: ["ii", "s", ["startOffset", "endOffset"], ["text"]] } });
  app.exportInterface(implementation({ SetTextContents: (next: string) => { text = next; mutations.text += 1; return true; } }), EDIT, { name: EDITABLE, methods: { SetTextContents: ["s", "b", ["newContents"], ["result"]] } });
  app.exportInterface(implementation({ NActions: 1, GetName: () => "click", DoAction: (index: number) => { assert.equal(index, 0); mutations.action += 1; return true; } }), BUTTON, {
    name: ACTION, properties: { NActions: { type: "i", access: "read" } }, methods: { GetName: ["i", "s", ["index"], ["name"]], DoAction: ["i", "b", ["index"], ["result"]] },
  });
  const valueInterface = implementation({ MinimumValue: 0, MaximumValue: 10 });
  Object.defineProperty(valueInterface, "CurrentValue", { enumerable: true, get: () => currentValue, set: (value: number) => { currentValue = value; mutations.value += 1; } });
  app.exportInterface(valueInterface, SLIDER, {
    name: VALUE, properties: { MinimumValue: { type: "d", access: "read" }, MaximumValue: { type: "d", access: "read" }, CurrentValue: { type: "d", access: "readwrite" } },
  });
  return {
    app, registrations, mutations, text: () => text, value: () => currentValue,
    holdNextState: () => {
      let release!: () => void;
      let entered!: () => void;
      const wait = new Promise<void>((resolveWait) => { release = resolveWait; });
      const enteredPromise = new Promise<void>((resolveEntered) => { entered = resolveEntered; });
      heldState = { entered, wait };
      return { entered: enteredPromise, release };
    },
  };
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    console.log("AT-SPI Unix transport fixture is Linux-only; this is not Linux desktop acceptance");
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "mybuddy-atspi-wire-"));
  const daemons: PrivateBus[] = [];
  const services: dbus.MessageBus[] = [];
  let driver: AtSpiDriver | undefined;
  let client: AtSpiClient | undefined;
  try {
    const session = await privateBus("unix:path=" + join(directory, "session"));
    daemons.push(session);
    const accessibility = await privateBus("unix:abstract=mybuddy-atspi-" + randomUUID());
    daemons.push(accessibility);
    const sessionService = await service(session.address);
    services.push(sessionService);
    const registry = await service(accessibility.address);
    services.push(registry);
    const app = await service(accessibility.address);
    services.push(app);
    await sessionService.requestName("org.a11y.Bus", 0);
    await registry.requestName(REGISTRY, 0);
    sessionService.exportInterface(implementation({ GetAddress: () => accessibility.address }), "/org/a11y/bus", { name: "org.a11y.Bus", methods: { GetAddress: ["", "s", [], ["address"]] } });
    const fixture = installFixture(app, registry);
    const window: WindowInfo = {
      handle: "0x123456789abcdef00", processId: process.pid, className: "wire-fixture", title: "Wire fixture",
      visible: true, minimized: false, foreground: true, dpi: 144, scaleFactor: 1.5,
      windowRect: { left: -200, top: 100, right: 600, bottom: 700, width: 800, height: 600 },
      clientOrigin: { x: -200, y: 100 }, clientRect: { x: 0, y: 0, width: 800, height: 600 },
      coordinateSpace: "hyprland-logical", clientGeometryVerified: true, layoutId: "fixture-layout", identityToken: "fixture-lifetime",
    };
    // Both Unix address families are exercised through the production transport.
    for (const address of [session.address, accessibility.address]) {
      const bus = await createAtSpiBus(address);
      const id = await bus.call({ destination: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", interface: "org.freedesktop.DBus", member: "GetId" });
      assert.equal(typeof id, "string");
      await bus.close();
    }
    console.log("PASS real dbus-daemon Unix path and abstract authentication");
    driver = new AtSpiDriver({ sessionAddress: session.address });
    assert.equal((await driver.probe()).available, true);
    assert.equal(fixture.registrations.size, 6);
    const tree = await driver.inspectWindow(window, { peerWindows: [window] });
    assert.equal(tree.controls.length, 4);
    assert.equal(tree.truncated, false);
    const edit = tree.controls.find((control) => control.name === "Message")!;
    const button = tree.controls.find((control) => control.name === "Submit")!;
    const slider = tree.controls.find((control) => control.name === "Count")!;
    assert.equal(edit.boundsReliable, true);
    const textResult = await driver.setValue(window, edit.runtimeId, "真实 D-Bus 中文 😀");
    assert.equal(textResult.verified, true);
    assert.equal(fixture.text(), "真实 D-Bus 中文 😀");
    assert.equal((await driver.setValue(window, slider.runtimeId, "3.5")).verified, true);
    assert.equal(fixture.value(), 3.5);
    const actionResult = await driver.invoke(window, button.runtimeId, "click");
    assert.equal(actionResult.executed, true);
    assert.equal(actionResult.verified, false);
    assert.deepEqual(fixture.mutations, { text: 1, action: 1, value: 1 });
    console.log("PASS real AT-SPI signatures, variants, state words, parent/child refs, hit tests, Unicode/Value readback");
    app.sendSignal(FRAME, "org.a11y.atspi.Event.Object", "ChildrenChanged", "siiva{sv}", ["remove", 0, 0, new dbus.Variant("(so)", [app.name, BUTTON]), {}]);
    await new Promise((resume) => setTimeout(resume, 30));
    await assert.rejects(driver.invoke(window, button.runtimeId), (error: unknown) => error instanceof ComputerUseError && error.code === "STALE_OBSERVATION");
    assert.equal(fixture.mutations.action, 1);
    await driver.shutdown();
    driver = undefined;
    assert.equal(fixture.registrations.size, 0);
    console.log("PASS real event invalidation and subscription cleanup");
    let exits = 0;
    client = new AtSpiClient({
      workerPath: resolve("out/main/atspi-worker.cjs"),
      spawnWorker: (workerPath) => fork(workerPath, [], {
        execPath: process.execPath, execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DBUS_SESSION_BUS_ADDRESS: session.address },
        stdio: ["ignore", "ignore", "pipe", "ipc"], serialization: "advanced",
      }),
      onUnexpectedExit: () => { exits += 1; },
    });
    assert.equal((await client.probe()).available, true);
    const workerTree = await client.inspectWindow(window, { peerWindows: [window] });
    const workerButton = workerTree.controls.find((control) => control.name === "Submit")!;
    const hold = fixture.holdNextState();
    const observation = client.inspectWindow(window, { peerWindows: [window] });
    await hold.entered;
    const abort = new AbortController();
    const queued = client.invoke(window, workerButton.runtimeId, undefined, abort.signal);
    await new Promise((resume) => setImmediate(resume));
    abort.abort();
    hold.release();
    await observation;
    await assert.rejects(queued, (error: unknown) => error instanceof ComputerUseError && error.code === "REQUEST_CANCELLED");
    assert.equal(fixture.mutations.action, 1);
    console.log("PASS real worker queue cancellation sends no Action.DoAction");
    const oldPid = client.pid!;
    assert(oldPid > 0 && oldPid !== process.pid);
    process.kill(oldPid, "SIGKILL");
    for (let count = 0; client.pid !== undefined && count < 100; count += 1) await new Promise((resume) => setTimeout(resume, 10));
    assert.equal(exits, 1);
    await assert.rejects(client.readControl(window, workerButton.runtimeId), (error: unknown) => error instanceof ComputerUseError && error.code === "STALE_OBSERVATION");
    assert.equal(fixture.mutations.action, 1);
    await client.shutdown();
    client = undefined;
    console.log("PASS real worker crash invalidates old references and never replays actions");
    console.log("AT-SPI real transport fixture passed (not a GUI acceptance result)");
  } finally {
    await client?.shutdown();
    await driver?.shutdown();
    for (const bus of services) bus.connection.end();
    await Promise.all(daemons.map(stopPrivateBus));
    await rm(directory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
