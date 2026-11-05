import { randomUUID } from "node:crypto";
import { ComputerUseError, type WindowInfo } from "../protocol";
import { createAtSpiBus, type AtSpiBus, type AtSpiBusFactory, type AtSpiMessage, type AtSpiSignal } from "./atspiDbus";
import {
  ATSPI_REFERENCE_TTL_MS,
  type AtSpiControlInfo,
  type AtSpiDriverApi,
  type AtSpiGeometry,
  type AtSpiInspection,
  type AtSpiInspectOptions,
  type AtSpiObjectReference,
  type AtSpiProbeResult,
  type AtSpiRect,
  type AtSpiSemanticResult,
} from "./atspiTypes";

const ACCESSIBLE = "org.a11y.atspi.Accessible";
const COMPONENT = "org.a11y.atspi.Component";
const ACTION = "org.a11y.atspi.Action";
const TEXT = "org.a11y.atspi.Text";
const EDITABLE_TEXT = "org.a11y.atspi.EditableText";
const VALUE = "org.a11y.atspi.Value";
const PROPERTIES = "org.freedesktop.DBus.Properties";
const DBUS = "org.freedesktop.DBus";
const REGISTRY = "org.a11y.atspi.Registry";
const REGISTRY_PATH = "/org/a11y/atspi/registry";
const DESKTOP: AtSpiObjectReference = { busName: REGISTRY, objectPath: "/org/a11y/atspi/accessible/root" };
const NULL_PATH = "/org/a11y/atspi/null";
const MAX_REFERENCE_COUNT = 12_000;
const MAX_TEXT_CHARS = 65_536;
const MAX_APPLICATIONS = 256;
const MAX_WINDOW_CANDIDATES = 256;
const MAX_PARENT_DEPTH = 64;
const SIGNAL_MATCHES = [
  "type='signal',interface='org.freedesktop.DBus',member='NameOwnerChanged'",
  "type='signal',interface='org.a11y.atspi.Event.Object'",
  "type='signal',interface='org.a11y.atspi.Event.Window'",
  "type='signal',interface='org.a11y.atspi.Cache',member='RemoveAccessible'",
];
const REGISTERED_EVENTS = ["object:children-changed", "object:state-changed:defunct", "object:property-change:accessible-parent", "object:bounds-changed", "window:destroy", "window:create"];

// Numeric roles are defined by atspi-constants.h. GetRoleName is optional in
// newer providers, so known roles do not require per-node introspection.
const ROLE_NAMES = ("invalid|accelerator label|alert|animation|arrow|calendar|canvas|check box|check menu item|color chooser|column header|combo box|date editor|desktop icon|desktop frame|dial|dialog|directory pane|drawing area|file chooser|filler|focus traversable|font chooser|frame|glass pane|html container|icon|image|internal frame|label|layered pane|list|list item|menu|menu bar|menu item|option pane|page tab|page tab list|panel|password text|popup menu|progress bar|button|radio button|radio menu item|root pane|row header|scroll bar|scroll pane|separator|slider|spin button|split pane|status bar|table|table cell|table column header|table row header|tearoff menu item|terminal|text|toggle button|tool bar|tool tip|tree|tree table|unknown|viewport|window|extended|header|footer|paragraph|ruler|application|autocomplete|editbar|embedded|entry|chart|caption|document frame|heading|page|section|redundant object|form|link|input method window|table row|tree item|document spreadsheet|document presentation|document text|document web|document email|comment|list box|grouping|image map|notification|info bar|level bar|title bar|block quote|audio|video|definition|article|landmark|log|marquee|math|rating|timer|static|math fraction|math root|subscript|superscript|description list|description term|description value|footnote|content deletion|content insertion|mark|suggestion|push button menu|switch").split("|");
const STATE_NAMES = ("invalid|active|armed|busy|checked|collapsed|defunct|editable|enabled|expandable|expanded|focusable|focused|has_tooltip|horizontal|iconified|modal|multi_line|multiselectable|opaque|pressed|resizable|selectable|selected|sensitive|showing|single_line|stale|transient|vertical|visible|manages_descendants|indeterminate|required|truncated|animated|invalid_entry|supports_autocompletion|selectable_text|is_default|visited|checkable|has_popup|read_only").split("|");
const TOP_LEVEL_ROLES = new Set([2, 16, 19, 23, 28, 41, 69, 89]);

interface Budget {
  deadline: number;
  signal?: AbortSignal;
}

interface NodeSnapshot {
  ref: AtSpiObjectReference;
  parent?: AtSpiObjectReference;
  name: string;
  description?: string;
  accessibleId?: string;
  role: number;
  roleName: string;
  states: string[];
  interfaces: string[];
  childCount: number;
  text?: string;
  textTruncated?: boolean;
  value?: number;
  screenBounds?: AtSpiRect;
  windowBounds?: AtSpiRect;
}

interface WindowBinding {
  ref: AtSpiObjectReference;
  application: AtSpiObjectReference;
  generation: string;
  window: WindowInfo;
  targetKey: string;
  root: NodeSnapshot;
  geometry?: AtSpiGeometry;
  windowCoordinates: boolean;
  screenCoordinates: boolean;
  capturedAt: number;
  observationId: string;
  revisions: Map<string, number>;
  revisionBaseline: Map<string, number>;
}

interface ControlReference {
  binding: WindowBinding;
  node: NodeSnapshot;
  control: AtSpiControlInfo;
  createdAt: number;
  invalidReason?: string;
}

interface Connection {
  session: AtSpiBus;
  accessibility: AtSpiBus;
  generation: string;
  disposeListeners: Array<() => void>;
  registeredEvents: string[];
  matches: string[];
  diagnostics: string[];
}

class QueryBudgetExceeded extends Error {}

function requireActive(budget: Budget): number {
  if (budget.signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求已取消");
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) throw new QueryBudgetExceeded("AT-SPI 查询超过时间预算");
  return remaining;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorName(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { dbusName?: unknown; name?: unknown; code?: unknown };
  return String(value.dbusName ?? value.code ?? value.name ?? "");
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function refKey(ref: AtSpiObjectReference): string {
  return ref.busName + "\n" + ref.objectPath;
}

function sameRef(left: AtSpiObjectReference | undefined, right: AtSpiObjectReference | undefined): boolean {
  return !!left && !!right && left.busName === right.busName && left.objectPath === right.objectPath;
}

function reference(value: unknown, defaultBus?: string): AtSpiObjectReference | undefined {
  if (!Array.isArray(value) || value.length < 2 || typeof value[0] !== "string" || typeof value[1] !== "string") return undefined;
  const busName = value[0] || defaultBus;
  const objectPath = value[1];
  if (!busName || objectPath === NULL_PATH || !/^\/(?:[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*)?$/.test(objectPath)) return undefined;
  if (!/^:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(busName) && !/^[A-Za-z_-][A-Za-z0-9_-]*(?:\.[A-Za-z_-][A-Za-z0-9_-]*)+$/.test(busName)) return undefined;
  return { busName, objectPath };
}

function rect(value: unknown): AtSpiRect | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const [x, y, width, height] = value.map(finiteInteger);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  // AT-SPI uses MIN_INT as the "not placed on screen" sentinel.
  if (x === -2_147_483_648 || y === -2_147_483_648) return undefined;
  return { x, y, width, height };
}

/** GetState returns two uint32 bitfields, not a list of state enum values. */
export function atSpiStateNames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI GetState 返回值不是位图");
  const words = value.map((entry) => {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 0 || entry > 0xffffffff) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI GetState 位图无效");
    }
    return entry >>> 0;
  });
  return STATE_NAMES.filter((_, index) => (((words[Math.floor(index / 32)] ?? 0) >>> (index % 32)) & 1) === 1);
}

function targetKey(window: WindowInfo): string {
  return JSON.stringify([
    window.handle, window.processId, window.className ?? "", window.title,
    window.identityToken ?? "", window.coordinateSpace ?? "",
    window.clientOrigin.x, window.clientOrigin.y, window.clientRect.width, window.clientRect.height,
    window.layoutId ?? "",
  ]);
}

function geometryFor(window: WindowInfo, options: AtSpiInspectOptions): AtSpiGeometry | undefined {
  if (options.geometry) {
    const candidate = options.geometry;
    const r = candidate.clientLogical;
    if (candidate.coordinateSpace === "hyprland-logical" && candidate.identity &&
      [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0) return candidate;
    return undefined;
  }
  if (window.coordinateSpace !== "hyprland-logical" || window.clientGeometryVerified !== true) return undefined;
  const { x, y } = window.clientOrigin;
  const { width, height } = window.clientRect;
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return undefined;
  return { coordinateSpace: "hyprland-logical", clientLogical: { x, y, width, height }, identity: targetKey(window) };
}

function near(left: number, right: number): boolean { return Math.abs(left - right) <= 1.5; }
function sameRectangle(left: AtSpiRect | undefined, right: AtSpiRect | undefined): boolean {
  return !!left && !!right && near(left.x, right.x) && near(left.y, right.y) && near(left.width, right.width) && near(left.height, right.height);
}

function controlType(node: NodeSnapshot): string {
  const known: Record<number, string> = { 7: "CheckBox", 8: "MenuItem", 11: "ComboBox", 16: "Window", 23: "Window", 29: "Text", 31: "List", 32: "ListItem", 33: "Menu", 34: "MenuBar", 35: "MenuItem", 37: "TabItem", 38: "Tab", 40: "Edit", 43: "Button", 44: "RadioButton", 48: "ScrollBar", 49: "Pane", 51: "Slider", 52: "Spinner", 54: "StatusBar", 55: "Table", 56: "DataItem", 62: "Button", 65: "Tree", 66: "Tree", 69: "Window", 79: "Edit", 88: "Hyperlink", 91: "TreeItem", 98: "List", 129: "Button", 130: "CheckBox" };
  if (node.role === 61) return node.states.includes("editable") ? "Edit" : "Text";
  return known[node.role] ?? node.roleName.split(/[ _-]/).map((part) => part[0]?.toUpperCase() + part.slice(1)).join("");
}

/** Eight calls across at most four concurrently read nodes, never unbounded fanout. */
class CallGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  async run<T>(budget: Budget, action: () => Promise<T>): Promise<T> {
    requireActive(budget);
    if (this.active >= 8) {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const cleanup = (): void => {
          clearTimeout(timer);
          budget.signal?.removeEventListener("abort", cancel);
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
        };
        const resume = (): void => {
          if (done) return;
          done = true;
          cleanup();
          resolve();
        };
        const cancel = (): void => {
          if (done) return;
          done = true;
          cleanup();
          reject(new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 排队请求已取消"));
        };
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new QueryBudgetExceeded("AT-SPI 查询排队超过时间预算"));
        }, Math.max(1, budget.deadline - Date.now()));
        this.waiting.push(resume);
        budget.signal?.addEventListener("abort", cancel, { once: true });
        if (budget.signal?.aborted) cancel();
      });
    } else this.active += 1;
    try {
      requireActive(budget);
      return await action();
    } finally {
      const next = this.waiting.shift();
      // Transfer the reserved permit before resolving the queued waiter.
      // A new caller cannot overtake it and create a ninth in-flight call.
      if (next) next();
      else this.active -= 1;
    }
  }
}

/**
 * AT-SPI implementation follows the official XML signatures. It discovers the
 * independent accessibility bus through org.a11y.Bus on the session bus and
 * operates on unique bus names plus object paths, never a mutable tree index.
 */
export class AtSpiDriver implements AtSpiDriverApi {
  private connection?: Connection;
  private connecting?: Promise<Connection>;
  private generation: string = randomUUID();
  private stopped = false;
  private readonly lifecycle = new AbortController();
  private readonly gate = new CallGate();
  private readonly references = new Map<string, ControlReference>();
  private readonly busPids = new Map<string, number>();
  private readonly busOwners = new Map<string, string>();
  private readonly ownerRevisions = new Map<string, number>();

  constructor(private readonly options: { busFactory?: AtSpiBusFactory; sessionAddress?: string } = {}) {}

  private budget(signal?: AbortSignal, timeoutMs = 8_000): Budget {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI timeoutMs 必须是非负有限数值");
    const signals = [this.lifecycle.signal, ...(signal ? [signal] : [])];
    return { deadline: Date.now() + Math.max(100, Math.min(20_000, timeoutMs)), signal: AbortSignal.any(signals) };
  }

  private async call(bus: AtSpiBus, message: AtSpiMessage, budget: Budget, dispatched?: () => void): Promise<unknown> {
    return await this.gate.run(budget, async () => {
      const timeoutMs = Math.min(2_000, requireActive(budget));
      dispatched?.();
      try {
        return await bus.call(message, { signal: budget.signal, timeoutMs });
      } catch (error) {
        if (budget.signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求已取消");
        if (Date.now() >= budget.deadline) throw new QueryBudgetExceeded("AT-SPI 查询超过时间预算");
        throw error;
      }
    });
  }

  private async request(ref: AtSpiObjectReference, iface: string, member: string, signature: string | undefined, body: unknown[] | undefined, budget: Budget, dispatched?: () => void): Promise<unknown> {
    const connection = this.connection;
    if (!connection) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI 总线已断开", { diagnosticCode: "BUS_DISCONNECTED" });
    return await this.call(connection.accessibility, { destination: ref.busName, path: ref.objectPath, interface: iface, member, signature, body }, budget, dispatched);
  }

  private async ensureConnection(signal?: AbortSignal): Promise<Connection> {
    if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求已取消");
    if (this.stopped) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI worker 已关闭");
    if (this.connecting) {
      const connection = await this.connecting;
      if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求已取消");
      return connection;
    }
    if (this.connection) return this.connection;
    if (!this.connecting) {
      const pending = this.openConnection();
      this.connecting = pending;
      void pending.finally(() => { if (this.connecting === pending) this.connecting = undefined; }).catch(() => {});
    }
    const connection = await this.connecting;
    if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 请求已取消");
    return connection;
  }

  private async openConnection(): Promise<Connection> {
    const factory = this.options.busFactory ?? createAtSpiBus;
    const address = this.options.sessionAddress ?? process.env.DBUS_SESSION_BUS_ADDRESS;
    if (!address) throw new ComputerUseError("HOST_UNAVAILABLE", "当前进程没有图形会话 DBUS_SESSION_BUS_ADDRESS", { diagnosticCode: "SESSION_BUS_MISSING" });
    const budget = this.budget(undefined, 6_000);
    const connectSignal = AbortSignal.any([this.lifecycle.signal, AbortSignal.timeout(6_000)]);
    let session: AtSpiBus | undefined;
    let accessibility: AtSpiBus | undefined;
    try {
      session = await factory(address, connectSignal);
      let accessibilityAddress: unknown;
      try {
        accessibilityAddress = await this.call(session, {
          destination: "org.a11y.Bus", path: "/org/a11y/bus", interface: "org.a11y.Bus", member: "GetAddress",
        }, budget);
      } catch (error) {
        const missing = /ServiceUnknown|NameHasNoOwner|Spawn.ServiceNotFound/.test(errorName(error));
        throw new ComputerUseError("HOST_UNAVAILABLE", missing ? "图形会话没有 org.a11y.Bus 无障碍服务" : "读取 AT-SPI 总线地址失败：" + errorText(error), { diagnosticCode: missing ? "ACCESSIBILITY_SERVICE_MISSING" : "ACCESSIBILITY_DISCOVERY_FAILED" });
      }
      if (typeof accessibilityAddress !== "string" || !accessibilityAddress) {
        throw new ComputerUseError("HOST_PROTOCOL_ERROR", "org.a11y.Bus.GetAddress 返回空地址", { diagnosticCode: "ACCESSIBILITY_ADDRESS_INVALID" });
      }
      accessibility = await factory(accessibilityAddress, connectSignal);
      requireActive(budget);
      const connection: Connection = {
        session, accessibility, generation: randomUUID(), disposeListeners: [], registeredEvents: [], matches: [], diagnostics: [],
      };
      this.generation = connection.generation;
      this.connection = connection;
      const disconnect = (): void => {
        if (this.connection !== connection) return;
        this.connection = undefined;
        this.invalidateAll("总线连接已断开");
        this.generation = randomUUID();
        this.busPids.clear();
        this.busOwners.clear();
        this.ownerRevisions.clear();
        for (const dispose of connection.disposeListeners.splice(0)) dispose();
        void Promise.allSettled([connection.session.close(), connection.accessibility.close()]);
      };
      connection.disposeListeners.push(session.onDisconnect(disconnect), accessibility.onDisconnect(disconnect), accessibility.onSignal((message) => this.handleSignal(message)));
      // NameOwnerChanged protects against bus-name reuse and application exit.
      for (const match of SIGNAL_MATCHES) {
        await this.call(accessibility, { destination: DBUS, path: "/org/freedesktop/DBus", interface: DBUS, member: "AddMatch", signature: "s", body: [match] }, budget);
        connection.matches.push(match);
      }
      for (const event of REGISTERED_EVENTS) {
        await this.call(accessibility, { destination: REGISTRY, path: REGISTRY_PATH, interface: REGISTRY, member: "RegisterEvent", signature: "sass", body: [event, [], ""] }, budget);
        connection.registeredEvents.push(event);
      }
      if (this.connection !== connection) throw new ComputerUseError("HOST_UNAVAILABLE", "AT-SPI 初始化期间总线断开");
      return connection;
    } catch (error) {
      if (this.connection?.accessibility === accessibility) this.connection = undefined;
      this.invalidateAll("AT-SPI 初始化失败");
      await Promise.allSettled([session?.close(), accessibility?.close()]);
      throw error;
    }
  }

  private invalidateAll(reason: string): void {
    for (const record of this.references.values()) record.invalidReason = reason;
  }

  private handleSignal(message: AtSpiSignal): void {
    const body = message.body ?? [];
    if (message.interface === DBUS && message.member === "NameOwnerChanged") {
      const [name, oldOwner, newOwner] = body;
      if (typeof name !== "string" || !oldOwner || oldOwner === newOwner) return;
      this.busPids.delete(name);
      this.busOwners.delete(name);
      this.ownerRevisions.set(name, (this.ownerRevisions.get(name) ?? 0) + 1);
      if (typeof oldOwner === "string") this.ownerRevisions.set(oldOwner, (this.ownerRevisions.get(oldOwner) ?? 0) + 1);
      for (const record of this.references.values()) {
        if ([record.node.ref.busName, record.binding.ref.busName, record.binding.application.busName].includes(name) ||
          [record.node.ref.busName, record.binding.ref.busName].includes(String(oldOwner))) record.invalidReason = "应用退出或重新连接了无障碍总线";
      }
      return;
    }
    const sender = message.sender;
    if (!sender) return;
    const member = message.member ?? "";
    const structural = member === "ChildrenChanged" || member === "Destroy" || member === "Create" ||
      (member === "StateChanged" && body[0] === "defunct" && body[1] === 1) ||
      (member === "PropertyChange" && body[0] === "accessible-parent") ||
      (message.interface === "org.a11y.atspi.Cache" && member === "RemoveAccessible");
    if (structural || member === "BoundsChanged") this.ownerRevisions.set(sender, (this.ownerRevisions.get(sender) ?? 0) + 1);
    for (const record of this.references.values()) {
      if (record.node.ref.busName !== sender && record.binding.ref.busName !== sender) continue;
      if (structural) record.invalidReason = "应用无障碍对象结构发生变化；请重新观察";
      else if (member === "BoundsChanged" && (record.node.ref.objectPath === message.path || record.binding.ref.objectPath === message.path)) {
        record.invalidReason = "控件或窗口边界已变化；请重新观察";
      }
    }
  }

  private async canonical(ref: AtSpiObjectReference, budget: Budget): Promise<AtSpiObjectReference> {
    if (ref.busName.startsWith(":")) return ref;
    let owner = this.busOwners.get(ref.busName);
    if (!owner) {
      const response = await this.request({ busName: DBUS, objectPath: "/org/freedesktop/DBus" }, DBUS, "GetNameOwner", "s", [ref.busName], budget);
      if (typeof response !== "string" || !response.startsWith(":")) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "D-Bus 返回无效的唯一总线名");
      owner = response;
      this.busOwners.set(ref.busName, owner);
    }
    return { busName: owner, objectPath: ref.objectPath };
  }

  private async children(ref: AtSpiObjectReference, budget: Budget, limit: number): Promise<{ refs: AtSpiObjectReference[]; truncated: boolean }> {
    const raw = await this.request(ref, ACCESSIBLE, "GetChildren", undefined, undefined, budget);
    if (!Array.isArray(raw)) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI GetChildren 返回值不是数组");
    const refs: AtSpiObjectReference[] = [];
    for (const entry of raw.slice(0, limit)) {
      const parsed = reference(entry, ref.busName);
      if (!parsed) continue;
      refs.push(await this.canonical(parsed, budget));
    }
    return { refs, truncated: raw.length > limit };
  }

  private async processId(ref: AtSpiObjectReference, budget: Budget): Promise<number> {
    const cached = this.busPids.get(ref.busName);
    if (cached !== undefined) return cached;
    const raw = await this.request({ busName: DBUS, objectPath: "/org/freedesktop/DBus" }, DBUS, "GetConnectionUnixProcessID", "s", [ref.busName], budget);
    const pid = finiteInteger(raw);
    if (pid === undefined || pid <= 0) throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI 应用 PID 无效");
    this.busPids.set(ref.busName, pid);
    return pid;
  }

  private async readNode(ref: AtSpiObjectReference, budget: Budget, textLimit = 4_096): Promise<NodeSnapshot> {
    const [propertiesRaw, roleRaw, statesRaw, interfacesRaw] = await Promise.all([
      this.request(ref, PROPERTIES, "GetAll", "s", [ACCESSIBLE], budget),
      this.request(ref, ACCESSIBLE, "GetRole", undefined, undefined, budget),
      this.request(ref, ACCESSIBLE, "GetState", undefined, undefined, budget),
      this.request(ref, ACCESSIBLE, "GetInterfaces", undefined, undefined, budget),
    ]);
    const properties = object(propertiesRaw);
    const role = finiteInteger(roleRaw);
    const childCount = finiteInteger(properties.ChildCount);
    if (role === undefined || role < 0 || childCount === undefined || childCount < 0 ||
      typeof properties.Name !== "string" || !Array.isArray(interfacesRaw) || !interfacesRaw.every((item) => typeof item === "string")) {
      throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI 节点 role/interfaces 无效", { ref });
    }
    const states = atSpiStateNames(statesRaw);
    if (states.includes("defunct")) throw new ComputerUseError("STALE_OBSERVATION", "无障碍控件已销毁", { ref });
    const node: NodeSnapshot = {
      ref,
      parent: reference(properties.Parent, ref.busName),
      name: typeof properties.Name === "string" ? properties.Name : "",
      description: typeof properties.Description === "string" ? properties.Description : undefined,
      accessibleId: typeof properties.AccessibleId === "string" ? properties.AccessibleId : undefined,
      role, roleName: ROLE_NAMES[role] ?? "unknown",
      states, interfaces: interfacesRaw as string[],
      childCount,
    };
    if (node.parent) node.parent = await this.canonical(node.parent, budget);
    // Missing optional data remains absent. A failed text read is never an
    // empty string and therefore cannot verify an empty SetTextContents.
    const optional: Array<Promise<void>> = [];
    if (node.interfaces.includes(COMPONENT)) {
      optional.push((async () => {
        const [screen, window] = await Promise.allSettled([
          this.request(ref, COMPONENT, "GetExtents", "u", [0], budget),
          this.request(ref, COMPONENT, "GetExtents", "u", [1], budget),
        ]);
        if (screen.status === "fulfilled") node.screenBounds = rect(screen.value);
        if (window.status === "fulfilled") node.windowBounds = rect(window.value);
      })());
    }
    if (node.interfaces.includes(TEXT) && node.role !== 40) {
      optional.push((async () => {
        const countRaw = await this.request(ref, PROPERTIES, "Get", "ss", [TEXT, "CharacterCount"], budget);
        const count = finiteInteger(countRaw);
        if (count === undefined || count < 0) return;
        const end = Math.min(count, textLimit);
        const raw = await this.request(ref, TEXT, "GetText", "ii", [0, end], budget);
        if (typeof raw === "string") {
          node.text = raw;
          node.textTruncated = count > end;
        }
      })().catch((error: unknown) => {
        if (budget.signal?.aborted || error instanceof QueryBudgetExceeded) throw error;
      }));
    }
    if (node.interfaces.includes(VALUE)) {
      optional.push((async () => {
        const raw = await this.request(ref, PROPERTIES, "Get", "ss", [VALUE, "CurrentValue"], budget);
        if (typeof raw === "number" && Number.isFinite(raw)) node.value = raw;
      })().catch((error: unknown) => {
        if (budget.signal?.aborted || error instanceof QueryBudgetExceeded) throw error;
      }));
    }
    await Promise.all(optional);
    requireActive(budget);
    return node;
  }

  private async bindWindow(window: WindowInfo, options: AtSpiInspectOptions, budget: Budget): Promise<WindowBinding> {
    const connection = await this.ensureConnection(budget.signal);
    const revisionBaseline = new Map(this.ownerRevisions);
    const applications = await this.children(DESKTOP, budget, MAX_APPLICATIONS);
    if (applications.truncated) throw new ComputerUseError("CONTROL_NOT_FOUND", "AT-SPI 应用枚举超过预算，无法可靠绑定窗口", { diagnosticCode: "QUERY_TRUNCATED" });
    const matchingApplications: AtSpiObjectReference[] = [];
    const discoveryFailures: string[] = [];
    for (let start = 0; start < applications.refs.length; start += 4) {
      const slice = applications.refs.slice(start, start + 4);
      const pids = await Promise.allSettled(slice.map((ref) => this.processId(ref, budget)));
      pids.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value === window.processId) matchingApplications.push(slice[index]);
        else if (result.status === "rejected") discoveryFailures.push(errorText(result.reason));
      });
      requireActive(budget);
    }
    if (matchingApplications.length === 0) {
      throw new ComputerUseError("CONTROL_NOT_FOUND", "目标应用没有导出可绑定的 AT-SPI 应用树；请检查应用的无障碍桥", {
        diagnosticCode: discoveryFailures.length ? "APPLICATION_DISCOVERY_INCOMPLETE" : "APPLICATION_NOT_ACCESSIBLE",
        processId: window.processId, applicationCount: applications.refs.length, discoveryFailures,
      });
    }
    const candidates: Array<{ node: NodeSnapshot; app: AtSpiObjectReference }> = [];
    let visited = 0;
    let discoveryTruncated = false;
    for (const application of matchingApplications) {
      const initial = await this.children(application, budget, MAX_WINDOW_CANDIDATES);
      discoveryTruncated ||= initial.truncated;
      const pending = initial.refs.map((ref) => ({ ref, depth: 0 }));
      const seen = new Set<string>();
      while (pending.length && visited < MAX_WINDOW_CANDIDATES) {
        const entry = pending.shift()!;
        if (seen.has(refKey(entry.ref))) continue;
        seen.add(refKey(entry.ref));
        visited += 1;
        let node: NodeSnapshot;
        try { node = await this.readNode(entry.ref, budget, 0); }
        catch (error) {
          if (budget.signal?.aborted || error instanceof QueryBudgetExceeded) throw error;
          discoveryTruncated = true;
          continue;
        }
        if (TOP_LEVEL_ROLES.has(node.role)) {
          candidates.push({ node, app: application });
          continue;
        }
        if (node.childCount > 0 && entry.depth < 3) {
          const next = await this.children(entry.ref, budget, MAX_WINDOW_CANDIDATES - visited);
          discoveryTruncated ||= next.truncated;
          pending.push(...next.refs.map((ref) => ({ ref, depth: entry.depth + 1 })));
        } else if (node.childCount > 0) discoveryTruncated = true;
      }
      discoveryTruncated ||= pending.length > 0;
    }
    if (discoveryTruncated) {
      throw new ComputerUseError("CONTROL_NOT_FOUND", "AT-SPI 窗口枚举不完整，不能确认唯一目标", { diagnosticCode: "QUERY_TRUNCATED", visited });
    }
    const geometry = geometryFor(window, options);
    const exactGeometry = geometry ? candidates.filter(({ node }) => sameRectangle(node.screenBounds, geometry.clientLogical)) : [];
    const matchingTitles = candidates.filter(({ node }) => node.name === window.title);
    const peers = options.peerWindows?.filter((peer) => peer.processId === window.processId && peer.title === window.title);
    let chosen: typeof candidates[number] | undefined;
    if (exactGeometry.length === 1) {
      const sameGeometryPeers = options.peerWindows?.filter((peer) =>
        peer.processId === window.processId && peer.coordinateSpace === "hyprland-logical" &&
        near(peer.clientOrigin.x, window.clientOrigin.x) && near(peer.clientOrigin.y, window.clientOrigin.y) &&
        near(peer.clientRect.width, window.clientRect.width) && near(peer.clientRect.height, window.clientRect.height));
      if (!sameGeometryPeers || (sameGeometryPeers.length === 1 && sameGeometryPeers[0].handle === window.handle)) chosen = exactGeometry[0];
    }
    if (!chosen && matchingTitles.length === 1 && peers?.length === 1 && peers[0].handle === window.handle) chosen = matchingTitles[0];
    if (!chosen) {
      throw new ComputerUseError(candidates.length === 0 ? "CONTROL_NOT_FOUND" : "WINDOW_AMBIGUOUS",
        candidates.length === 0 ? "目标应用没有导出可访问窗口" : "无法把 AT-SPI 窗口与 Hyprland 地址唯一对应；不会按相似标题或 PID 猜测",
        { diagnosticCode: candidates.length === 0 ? "NO_ACCESSIBLE_WINDOW" : "WINDOW_BINDING_AMBIGUOUS", windowHandle: window.handle, processId: window.processId,
          candidates: candidates.map(({ node }) => ({ ...node.ref, name: node.name, screenBounds: node.screenBounds })),
          compositorPeers: peers?.map((peer) => peer.handle) });
    }
    const logical = geometry?.clientLogical;
    const windowCoordinates = !!logical && sameRectangle(chosen.node.windowBounds, { x: 0, y: 0, width: logical.width, height: logical.height });
    const screenCoordinates = !!logical && sameRectangle(chosen.node.screenBounds, logical);
    const binding: WindowBinding = {
      ref: chosen.node.ref, application: chosen.app, generation: connection.generation,
      window: structuredClone(window), targetKey: targetKey(window), root: chosen.node, geometry,
      windowCoordinates, screenCoordinates, capturedAt: Date.now(), observationId: options.observationId ?? randomUUID(),
      revisions: new Map([chosen.node.ref.busName, chosen.app.busName].map((owner) => [owner, revisionBaseline.get(owner) ?? 0])),
      revisionBaseline,
    };
    this.assertBindingCurrent(binding);
    return binding;
  }

  private assertBindingCurrent(binding: WindowBinding): void {
    if (this.connection?.generation !== binding.generation) throw new ComputerUseError("STALE_OBSERVATION", "AT-SPI 连接代次已变化");
    for (const [owner, revision] of binding.revisions) {
      if ((this.ownerRevisions.get(owner) ?? 0) !== revision) {
        throw new ComputerUseError("STALE_OBSERVATION", "观测期间控件结构或边界已变化；请重新获取控件", { busName: owner });
      }
    }
  }

  private makeControl(node: NodeSnapshot, binding: WindowBinding, depth?: number, runtimeId?: string): AtSpiControlInfo {
    const patterns: string[] = [];
    if (node.interfaces.includes(ACTION)) patterns.push("Invoke");
    if (node.interfaces.includes(EDITABLE_TEXT) || node.interfaces.includes(VALUE)) patterns.push("Value");
    if (node.interfaces.includes(TEXT)) patterns.push("Text");
    if (node.states.includes("checkable") && node.interfaces.includes(ACTION)) patterns.push("Toggle");
    if (node.states.includes("expandable") && node.interfaces.includes(ACTION)) patterns.push("ExpandCollapse");
    return {
      runtimeId: runtimeId ?? "atspi:" + Buffer.from(JSON.stringify({
        generation: binding.generation, bus: node.ref.busName, path: node.ref.objectPath,
        window: binding.window.handle, observation: binding.observationId, nonce: randomUUID(),
      })).toString("base64url"),
      automationId: node.accessibleId || undefined,
      name: node.name || undefined, controlType: controlType(node),
      frameworkId: "AT-SPI",
      enabled: (node.states.includes("enabled") || node.states.includes("sensitive")) && !node.states.includes("defunct"),
      offscreen: !node.states.includes("visible") || !node.states.includes("showing"),
      keyboardFocusable: node.states.includes("focusable"), hasKeyboardFocus: node.states.includes("focused"),
      patterns, depth, text: node.text, value: node.value, textTruncated: node.textTruncated,
      interfaces: [...node.interfaces], states: [...node.states], boundsReliable: false,
      atspi: {
        ...node.ref, generation: binding.generation, observationId: binding.observationId,
        windowHandle: binding.window.handle, role: node.role, parent: node.parent,
        screenBounds: node.screenBounds, windowBounds: node.windowBounds,
        boundsReliable: false, boundsReason: "尚未通过 AT-SPI 坐标与命中测试校验",
      },
    };
  }

  /**
   * AT-SPI providers do not all publish the same state vocabulary. GTK commonly
   * exports SENSITIVE without ENABLED. Treat either active state as the node's
   * positive capability, but require it on every node up to the target window.
   * This also prevents a sensitive child under an insensitive container from
   * being treated as actionable.
   */
  private async effectiveEnabled(node: NodeSnapshot, binding: WindowBinding, snapshots: Map<string, NodeSnapshot>, budget: Budget): Promise<boolean> {
    let currentRef = node.ref;
    let states = node.states;
    const visited = new Set<string>();
    for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
      if (states.includes("defunct") || (!states.includes("enabled") && !states.includes("sensitive"))) return false;
      if (sameRef(currentRef, binding.ref)) return true;
      const key = refKey(currentRef);
      if (visited.has(key)) return false;
      visited.add(key);
      let parent = snapshots.get(key)?.parent;
      if (!parent) {
        const raw = await this.request(currentRef, PROPERTIES, "Get", "ss", [ACCESSIBLE, "Parent"], budget);
        const parsed = reference(raw, currentRef.busName);
        parent = parsed ? await this.canonical(parsed, budget) : undefined;
      }
      if (!parent) return false;
      currentRef = await this.canonical(parent, budget);
      const cached = snapshots.get(refKey(currentRef));
      states = cached?.states ?? atSpiStateNames(await this.request(currentRef, ACCESSIBLE, "GetState", undefined, undefined, budget));
    }
    return false;
  }

  private pruneReferences(): void {
    const now = Date.now();
    for (const [id, record] of this.references) {
      if (record.invalidReason || now - record.createdAt > ATSPI_REFERENCE_TTL_MS) this.references.delete(id);
    }
    while (this.references.size >= MAX_REFERENCE_COUNT) this.references.delete(this.references.keys().next().value!);
  }

  private async hitTest(binding: WindowBinding, target: NodeSnapshot, bounds: AtSpiRect, source: "atspi-screen" | "atspi-window", snapshots: Map<string, NodeSnapshot>, budget: Budget): Promise<boolean> {
    const coordType = source === "atspi-screen" ? 0 : 1;
    const global = binding.geometry!.clientLogical;
    const x = Math.floor(bounds.x + bounds.width / 2 + (coordType === 0 ? global.x : 0));
    const y = Math.floor(bounds.y + bounds.height / 2 + (coordType === 0 ? global.y : 0));
    const path: NodeSnapshot[] = [target];
    let current = target;
    const visited = new Set<string>();
    while (!sameRef(current.ref, binding.ref) && path.length <= MAX_PARENT_DEPTH) {
      const key = refKey(current.ref);
      if (visited.has(key)) return false;
      visited.add(key);
      let parent = current.parent;
      if (!parent) {
        const rawParent = await this.request(current.ref, PROPERTIES, "Get", "ss", [ACCESSIBLE, "Parent"], budget);
        const parsed = reference(rawParent, current.ref.busName);
        parent = parsed ? await this.canonical(parsed, budget) : undefined;
      }
      if (!parent) return false;
      const canonicalParent = await this.canonical(parent, budget);
      const parentNode = snapshots.get(refKey(canonicalParent));
      if (!parentNode) return false;
      path.push(parentNode);
      current = parentNode;
    }
    if (!sameRef(path[path.length - 1]?.ref, binding.ref)) return false;

    const ancestorKeys = new Set(path.slice(1).map(node => refKey(node.ref)));
    const isTargetOrDescendant = async (ref: AtSpiObjectReference): Promise<boolean> => {
      let cursor = ref;
      const seen = new Set<string>();
      for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
        if (sameRef(cursor, target.ref)) return true;
        const key = refKey(cursor);
        if (seen.has(key)) return false;
        seen.add(key);
        let parent = snapshots.get(key)?.parent;
        if (!parent) {
          const rawParent = await this.request(cursor, PROPERTIES, "Get", "ss", [ACCESSIBLE, "Parent"], budget);
          const parsed = reference(rawParent, cursor.busName);
          parent = parsed ? await this.canonical(parsed, budget) : undefined;
        }
        if (!parent) return false;
        cursor = await this.canonical(parent, budget);
      }
      return false;
    };

    // Probe from the nearest parent outward. An ancestor-only result is not
    // mistaken for the target, and a provider returning the same container
    // cannot create an infinite descent loop.
    for (const candidate of path.slice(1)) {
      if (!candidate.interfaces.includes(COMPONENT)) continue;
      const raw = await this.request(candidate.ref, COMPONENT, "GetAccessibleAtPoint", "iiu", [x, y, coordType], budget);
      const parsed = reference(raw, candidate.ref.busName);
      if (!parsed) continue;
      const hit = await this.canonical(parsed, budget);
      if (await isTargetOrDescendant(hit)) return true;
      if (ancestorKeys.has(refKey(hit))) continue;
      return false;
    }

    // Chromium/Electron can expose a correct Component tree and extents while
    // GetAccessibleAtPoint stops at a generic ancestor. Component.Contains is
    // an independent AT-SPI hit-region query. Accept only when the target and
    // each Component ancestor contain the point, the observed sibling set is
    // complete, and no sibling contains the same point.
    for (const candidate of path) {
      if (!candidate.interfaces.includes(COMPONENT)) continue;
      const contains = await this.request(candidate.ref, COMPONENT, "Contains", "iiu", [x, y, coordType], budget);
      if (contains !== true) return false;
    }
    for (let index = 0; index < path.length - 1; index += 1) {
      const branch = path[index];
      const parent = path[index + 1];
      const siblings = [...snapshots.values()].filter(node => sameRef(node.parent, parent.ref));
      if (siblings.length < parent.childCount || !siblings.some(node => sameRef(node.ref, branch.ref))) return false;
      for (const sibling of siblings) {
        if (sameRef(sibling.ref, branch.ref)) continue;
        if (!sibling.interfaces.includes(COMPONENT)) return false;
        const overlaps = await this.request(sibling.ref, COMPONENT, "Contains", "iiu", [x, y, coordType], budget);
        if (overlaps === true) return false;
      }
    }
    return true;
  }

  private async certifyBounds(node: NodeSnapshot, binding: WindowBinding, control: AtSpiControlInfo, snapshots: Map<string, NodeSnapshot>, budget: Budget): Promise<void> {
    const geometry = binding.geometry?.clientLogical;
    if (!geometry || (!binding.windowCoordinates && !binding.screenCoordinates)) {
      control.atspi.boundsReason = "无法证明 AT-SPI 单位/原点与目标客户区逻辑坐标一致";
      return;
    }
    let candidate: AtSpiRect | undefined;
    let source: "atspi-window" | "atspi-screen";
    if (binding.windowCoordinates && node.windowBounds) {
      candidate = node.windowBounds;
      source = "atspi-window";
    } else if (binding.screenCoordinates && node.screenBounds) {
      candidate = { ...node.screenBounds, x: node.screenBounds.x - geometry.x, y: node.screenBounds.y - geometry.y };
      source = "atspi-screen";
    } else {
      control.atspi.boundsReason = "控件没有可靠的 Component bounds";
      return;
    }
    if (candidate.x < 0 || candidate.y < 0 || candidate.width <= 0 || candidate.height <= 0 ||
      candidate.x + candidate.width > geometry.width + 1.5 || candidate.y + candidate.height > geometry.height + 1.5) {
      control.atspi.boundsReason = "控件矩形为空、被裁剪或超出已验证客户区";
      return;
    }
    if (binding.screenCoordinates && node.screenBounds && node.windowBounds &&
      !sameRectangle(node.screenBounds, { ...node.windowBounds, x: geometry.x + node.windowBounds.x, y: geometry.y + node.windowBounds.y })) {
      control.atspi.boundsReason = "AT-SPI screen 与 window 坐标互相矛盾";
      return;
    }
    if (!(await this.hitTest(binding, node, candidate, source, snapshots, budget))) {
      control.atspi.boundsReason = "AT-SPI 命中测试未确认该矩形属于目标控件";
      return;
    }
    control.clientBoundsDip = { ...candidate };
    control.bounds = { left: candidate.x, top: candidate.y, width: candidate.width, height: candidate.height };
    control.screenBoundsLogical = { left: geometry.x + candidate.x, top: geometry.y + candidate.y, width: candidate.width, height: candidate.height };
    control.boundsReliable = true;
    control.boundsSource = source;
    control.atspi.boundsReliable = true;
    control.atspi.boundsSource = source;
    control.atspi.boundsReason = undefined;
  }

  async probe(signal?: AbortSignal): Promise<AtSpiProbeResult> {
    try {
      const connection = await this.ensureConnection(signal);
      const applications = await this.children(DESKTOP, this.budget(signal, 5_000), MAX_APPLICATIONS);
      return {
        available: true, generation: connection.generation, checkedAt: Date.now(), applicationCount: applications.refs.length,
        diagnostics: [...connection.diagnostics, ...(applications.refs.length === 0 ? ["无障碍总线可访问，但尚无应用导出可访问树"] : []),
          ...(applications.truncated ? ["应用列表达到查询上限"] : [])],
      };
    } catch (error) {
      if (signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 诊断已取消");
      const details = error instanceof ComputerUseError ? object(error.details) : {};
      return { available: false, generation: this.generation, checkedAt: Date.now(), code: String(details.diagnosticCode || errorName(error) || "ACCESSIBILITY_UNAVAILABLE"), reason: errorText(error) };
    }
  }

  async inspectWindow(window: WindowInfo, options: AtSpiInspectOptions = {}, signal?: AbortSignal): Promise<AtSpiInspection> {
    for (const key of ["maxNodes", "maxDepth"] as const) {
      if (options[key] !== undefined && (!Number.isFinite(options[key]) || !Number.isInteger(options[key]) || options[key]! < 0)) {
        throw new ComputerUseError("HOST_PROTOCOL_ERROR", "AT-SPI " + key + " 必须是非负整数");
      }
    }
    const budget = this.budget(signal, options.timeoutMs);
    const maxDepth = Math.max(0, Math.min(50, Math.floor(options.maxDepth ?? 12)));
    const maxNodes = Math.max(1, Math.min(3_000, Math.floor(options.maxNodes ?? 500)));
    let binding: WindowBinding;
    try { binding = await this.bindWindow(window, options, budget); }
    catch (error) {
      if (error instanceof QueryBudgetExceeded) throw new ComputerUseError("REQUEST_TIMEOUT", error.message, { diagnosticCode: "QUERY_TRUNCATED" });
      throw error;
    }
    const controls: AtSpiControlInfo[] = [];
    const diagnostics: string[] = [...(this.connection?.diagnostics ?? [])];
    const snapshots = new Map<string, NodeSnapshot>([[refKey(binding.root.ref), binding.root]]);
    const queue: Array<{ ref: AtSpiObjectReference; depth: number }> = [{ ref: binding.ref, depth: 0 }];
    const visited = new Set<string>();
    let truncated = false;
    let complete = true;
    while (queue.length && controls.length < maxNodes) {
      let entries: Array<{ ref: AtSpiObjectReference; depth: number }>;
      try {
        requireActive(budget);
        entries = queue.splice(0, Math.min(4, maxNodes - controls.length));
        const results = await Promise.allSettled(entries.map(async (entry) => ({
          entry, node: snapshots.get(refKey(entry.ref)) ?? await this.readNode(entry.ref, budget),
        })));
        for (let index = 0; index < results.length; index += 1) {
          const entry = entries[index];
          if (visited.has(refKey(entry.ref))) continue;
          visited.add(refKey(entry.ref));
          const result = results[index];
          if (result.status === "rejected") {
            if (budget.signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 查询已取消");
            diagnostics.push("部分节点读取失败：" + errorText(result.reason));
            complete = false;
            truncated = true;
            continue;
          }
          const node = result.value.node;
          binding.revisions.set(node.ref.busName, binding.revisionBaseline.get(node.ref.busName) ?? 0);
          snapshots.set(refKey(node.ref), node);
          const control = this.makeControl(node, binding, entry.depth);
          controls.push(control);
          if (node.childCount === 0) continue;
          if (entry.depth >= maxDepth) { truncated = true; continue; }
          if (node.states.includes("manages_descendants")) {
            diagnostics.push("节点自行管理大量后代，未枚举不可见虚拟子节点：" + node.ref.objectPath);
            truncated = true;
            continue;
          }
          try {
            const children = await this.children(node.ref, budget, Math.max(1, maxNodes - controls.length - queue.length));
            truncated ||= children.truncated;
            if (!children.truncated && children.refs.length < node.childCount) {
              truncated = true;
              complete = false;
              diagnostics.push("GetChildren 少于已报告的 ChildCount，不能把不完整读取视为空树");
            }
            queue.push(...children.refs.filter((ref) => !visited.has(refKey(ref))).map((ref) => ({ ref, depth: entry.depth + 1 })));
          } catch (error) {
            if (budget.signal?.aborted) throw error;
            truncated = true;
            complete = false;
            diagnostics.push("子节点查询不完整：" + errorText(error));
          }
        }
      } catch (error) {
        if (budget.signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 查询已取消");
        truncated = true;
        complete = false;
        diagnostics.push("树查询达到时间预算：" + errorText(error));
        break;
      }
    }
    truncated ||= queue.length > 0;
    this.assertBindingCurrent(binding);
    // Derive actionability from the node and its complete parent chain. This is
    // intentionally separate from bounds: a control can be semantically usable
    // even when pointer targeting cannot be certified.
    for (const control of controls) {
      const node = snapshots.get(refKey(control.atspi));
      if (!node) { control.enabled = false; continue; }
      try { control.enabled = await this.effectiveEnabled(node, binding, snapshots, budget); }
      catch (error) {
        if (budget.signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 有效控件状态查询已取消");
        control.enabled = false;
        diagnostics.push("无法确认控件及父链的 sensitive/enabled 状态，已拒绝操作：" + errorText(error));
      }
    }
    // Bounds are independent from semantic capability. The bounded hit tests
    // reject contradictory coordinates, including broken all-zero exporters,
    // without declaring a legitimate (0,0) or negative screen origin invalid.
    for (let start = 0; start < controls.length; start += 4) {
      if (Date.now() >= budget.deadline) {
        diagnostics.push("坐标命中验证达到时间预算，剩余控件保留语义能力但不提供输入坐标");
        break;
      }
      const results = await Promise.allSettled(controls.slice(start, start + 4).map(async (control) => {
        const node = snapshots.get(refKey(control.atspi))!;
        if (!node.interfaces.includes(COMPONENT) || control.offscreen) return;
        await this.certifyBounds(node, binding, control, snapshots, budget);
      }));
      for (const result of results) {
        if (result.status === "rejected" && budget.signal?.aborted) throw new ComputerUseError("REQUEST_CANCELLED", "AT-SPI 查询已取消");
      }
    }
    this.assertBindingCurrent(binding);
    this.pruneReferences();
    for (const control of controls) {
      while (this.references.size >= MAX_REFERENCE_COUNT) this.references.delete(this.references.keys().next().value!);
      this.references.set(control.runtimeId, { binding, node: snapshots.get(refKey(control.atspi))!, control, createdAt: binding.capturedAt });
    }
    const root = controls.find((control) => sameRef(control.atspi, binding.ref));
    if (!root) throw new ComputerUseError("CONTROL_NOT_FOUND", "窗口可访问对象在读取过程中消失", { diagnosticCode: "WINDOW_TREE_UNREADABLE" });
    const empty = binding.root.childCount === 0 && controls.length === 1 && complete;
    return {
      controls, readableText: controls.map((control) => control.text ?? control.name ?? "").filter(Boolean).join("\n").slice(0, MAX_TEXT_CHARS),
      truncated, diagnostics: [...new Set(diagnostics)], generation: binding.generation,
      windowRef: root.runtimeId, observationId: binding.observationId,
      boundsReliable: controls.some((control) => control.boundsReliable),
      treeStatus: truncated ? "truncated" : empty ? "empty" : "available",
    };
  }

  private requireReference(window: WindowInfo, runtimeId: string): ControlReference {
    const record = this.references.get(runtimeId);
    if (!record || record.binding.generation !== this.connection?.generation || record.invalidReason ||
      Date.now() - record.createdAt > ATSPI_REFERENCE_TTL_MS) {
      throw new ComputerUseError("STALE_OBSERVATION", record?.invalidReason ?? "AT-SPI 控件引用不存在、已过期或属于旧连接；请重新观察");
    }
    if (record.binding.targetKey !== targetKey(window)) {
      throw new ComputerUseError("TARGET_CHANGED", "控件引用所属窗口、布局或几何已变化；请重新观察", { expectedHandle: record.binding.window.handle, actualHandle: window.handle });
    }
    this.assertBindingCurrent(record.binding);
    return record;
  }

  private async verifyAncestry(record: ControlReference, budget: Budget, allowTitleChange = false): Promise<void> {
    const root = await this.readNode(record.binding.ref, budget, 0);
    if (root.role !== record.binding.root.role || !allowTitleChange && root.name !== record.binding.root.name ||
      (record.binding.root.accessibleId && root.accessibleId !== record.binding.root.accessibleId)) {
      throw new ComputerUseError("STALE_OBSERVATION", "所属 AT-SPI 窗口已变化");
    }
    if (record.binding.windowCoordinates && !sameRectangle(root.windowBounds, record.binding.root.windowBounds) ||
      record.binding.screenCoordinates && !sameRectangle(root.screenBounds, record.binding.root.screenBounds)) {
      throw new ComputerUseError("STALE_OBSERVATION", "所属 AT-SPI 窗口坐标已变化");
    }
    let current: AtSpiObjectReference | undefined = record.node.ref;
    const seen = new Set<string>();
    for (let depth = 0; current && depth < MAX_PARENT_DEPTH; depth += 1) {
      if (sameRef(current, record.binding.ref)) return;
      if (seen.has(refKey(current))) break;
      seen.add(refKey(current));
      const raw = await this.request(current, PROPERTIES, "Get", "ss", [ACCESSIBLE, "Parent"], budget);
      const parent = reference(raw, current.busName);
      current = parent ? await this.canonical(parent, budget) : undefined;
    }
    throw new ComputerUseError("STALE_OBSERVATION", "控件不再属于观测时的窗口");
  }

  private async freshControl(record: ControlReference, budget: Budget, forAction: boolean, textLimit = 4_096): Promise<{ node: NodeSnapshot; control: AtSpiControlInfo }> {
    await this.verifyAncestry(record, budget);
    const node = await this.readNode(record.node.ref, budget, textLimit);
    if (node.role !== record.node.role || node.accessibleId !== record.node.accessibleId ||
      !sameRef(node.parent, record.node.parent) && (node.parent !== undefined || record.node.parent !== undefined) ||
      forAction && node.name !== record.node.name) {
      throw new ComputerUseError("STALE_OBSERVATION", "控件身份或父子关系已变化；请重新观察");
    }
    if (record.invalidReason) throw new ComputerUseError("STALE_OBSERVATION", record.invalidReason);
    const control = this.makeControl(node, record.binding, record.control.depth, record.control.runtimeId);
    control.enabled = await this.effectiveEnabled(node, record.binding, new Map(), budget);
    if (sameRectangle(node.windowBounds, record.node.windowBounds) && sameRectangle(node.screenBounds, record.node.screenBounds)) {
      control.clientBoundsDip = record.control.clientBoundsDip;
      control.screenBoundsLogical = record.control.screenBoundsLogical;
      control.bounds = record.control.bounds;
      control.boundsReliable = record.control.boundsReliable;
      control.boundsSource = record.control.boundsSource;
      control.atspi.boundsReliable = record.control.atspi.boundsReliable;
      control.atspi.boundsSource = record.control.atspi.boundsSource;
      control.atspi.boundsReason = record.control.atspi.boundsReason;
    }
    return { node, control };
  }

  async readControl(window: WindowInfo, runtimeId: string, signal?: AbortSignal): Promise<AtSpiControlInfo> {
    const record = this.requireReference(window, runtimeId);
    return (await this.freshControl(record, this.budget(signal, 5_000), false)).control;
  }

  private async actionResult(record: ControlReference, before: AtSpiControlInfo, executed: boolean | "unknown", expectedText: string | undefined, expectedValue: number | undefined, signal?: AbortSignal, dispatchError?: unknown): Promise<AtSpiSemanticResult> {
    // Cancellation/timeout does not roll back a remote action. A separate,
    // read-only budget attempts reconciliation and never repeats the mutation.
    const budget = this.budget(undefined, 3_000);
    try {
      this.assertBindingCurrent(record.binding);
      if (record.invalidReason) throw new Error(record.invalidReason);
      const node = await this.readNode(record.node.ref, budget, expectedText === undefined ? 4_096 : Math.min(MAX_TEXT_CHARS + 1, Array.from(expectedText).length + 1));
      if (node.role !== record.node.role || node.accessibleId !== record.node.accessibleId ||
        !sameRef(node.parent, record.node.parent) && (node.parent !== undefined || record.node.parent !== undefined)) {
        throw new ComputerUseError("STALE_OBSERVATION", "回读控件身份发生变化");
      }
      // Editing a document may intentionally change its title. The unique
      // owner/object/parent/lifetime remains the post-action identity proof.
      await this.verifyAncestry(record, budget, true);
      this.assertBindingCurrent(record.binding);
      if (record.invalidReason) throw new Error(record.invalidReason);
      const after = this.makeControl(node, record.binding, record.control.depth, record.control.runtimeId);
      after.enabled = await this.effectiveEnabled(node, record.binding, new Map(), budget);
      let verified = false;
      let evidence: string;
      if (expectedText !== undefined) {
        verified = node.text !== undefined && node.textTruncated !== true && node.text === expectedText;
        evidence = verified ? "EditableText 写入后的完整文本与请求值相同" : "已回读文本，尚未确认与请求值相同";
      } else if (expectedValue !== undefined) {
        verified = node.value !== undefined && Object.is(node.value, expectedValue);
        evidence = verified ? "Value.CurrentValue 回读与请求值相同" : "已回读 Value，尚未确认与请求值相同";
      } else {
        // A successful DoAction and arbitrary UI change do not prove the
        // caller's business outcome. The backend evaluates explicit outcomes.
        evidence = "Action 请求已返回；相关文本/状态已回读，业务结果仍需明确 expected_outcomes 验证";
      }
      if (dispatchError) evidence += "；发送返回异常，已只读回查且未重放：" + errorText(dispatchError);
      if (signal?.aborted) evidence += "；调用已取消，远端动作可能已发生";
      return { executed, verified, before, after, evidence, readbackError: dispatchError ? errorText(dispatchError) : undefined };
    } catch (error) {
      return {
        executed, verified: false, before,
        evidence: "动作可能已发生，但回读失败；结果未知，不得把读取失败推断为窗口已关闭或自动重试",
        readbackError: [dispatchError ? errorText(dispatchError) : undefined, errorText(error)].filter(Boolean).join("；"),
      };
    }
  }

  private async focusResult(record: ControlReference, before: AtSpiControlInfo, executed: boolean | "unknown", signal?: AbortSignal, dispatchError?: unknown): Promise<AtSpiSemanticResult> {
    const budget = this.budget(undefined, 3_000);
    try {
      this.assertBindingCurrent(record.binding);
      if (record.invalidReason) throw new Error(record.invalidReason);
      const node = await this.readNode(record.node.ref, budget, 4_096);
      if (node.role !== record.node.role || node.accessibleId !== record.node.accessibleId ||
        !sameRef(node.parent, record.node.parent) && (node.parent !== undefined || record.node.parent !== undefined)) {
        throw new ComputerUseError("STALE_OBSERVATION", "聚焦后的控件身份或父子关系已变化");
      }
      await this.verifyAncestry(record, budget);
      this.assertBindingCurrent(record.binding);
      if (record.invalidReason) throw new Error(record.invalidReason);
      const after = this.makeControl(node, record.binding, record.control.depth, record.control.runtimeId);
      after.enabled = await this.effectiveEnabled(node, record.binding, new Map(), budget);
      const verified = after.hasKeyboardFocus;
      let evidence = verified ? "Component.GrabFocus 后读回 focused 状态" : "Component.GrabFocus 已返回，但未从控件状态确认焦点";
      if (dispatchError) evidence += "；发送返回异常，已只读回查且未重放：" + errorText(dispatchError);
      if (signal?.aborted) evidence += "；调用已取消，焦点请求可能已发生";
      return { executed, verified, before, after, evidence, readbackError: dispatchError ? errorText(dispatchError) : undefined };
    } catch (error) {
      return { executed, verified: false, before, evidence: "焦点请求可能已发生，但 focused 状态回读失败；不会自动重试", readbackError: [dispatchError ? errorText(dispatchError) : undefined, errorText(error)].filter(Boolean).join("；") };
    }
  }

  async focus(window: WindowInfo, runtimeId: string, signal?: AbortSignal): Promise<AtSpiSemanticResult> {
    const record = this.requireReference(window, runtimeId);
    const budget = this.budget(signal, 8_000);
    const { node, control: before } = await this.freshControl(record, budget, true);
    if (!before.enabled || before.offscreen || !before.keyboardFocusable || !node.interfaces.includes(COMPONENT)) {
      throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件不可聚焦，或缺少可用的 AT-SPI Component 接口");
    }
    this.requireReference(window, runtimeId);
    let dispatched = false;
    try {
      const result = await this.request(node.ref, COMPONENT, "GrabFocus", undefined, undefined, budget, () => { dispatched = true; });
      if (result !== true) return { executed: false, verified: false, before, evidence: "AT-SPI Component.GrabFocus 明确返回 false" };
      return await this.focusResult(record, before, true, signal);
    } catch (error) {
      if (!dispatched) throw error;
      return await this.focusResult(record, before, "unknown", signal, error);
    }
  }

  async invoke(window: WindowInfo, runtimeId: string, actionName?: string, signal?: AbortSignal): Promise<AtSpiSemanticResult> {
    const record = this.requireReference(window, runtimeId);
    const budget = this.budget(signal, 8_000);
    const { node, control: before } = await this.freshControl(record, budget, true);
    if (!before.enabled || before.offscreen || !node.interfaces.includes(ACTION)) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件当前没有可用的 AT-SPI Action");
    const countRaw = await this.request(node.ref, PROPERTIES, "Get", "ss", [ACTION, "NActions"], budget);
    const count = finiteInteger(countRaw);
    if (count === undefined || count < 1 || count > 64) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件的 Action 数量无效");
    let actionIndex = 0;
    if (actionName) {
      const names: string[] = [];
      for (let start = 0; start < count; start += 4) {
        const indices = Array.from({ length: Math.min(4, count - start) }, (_, offset) => start + offset);
        const values = await Promise.all(indices.map((index) => this.request(node.ref, ACTION, "GetName", "i", [index], budget)));
        names.push(...values.map((value) => String(value)));
      }
      const matches = names.flatMap((name, index) => name === actionName ? [index] : []);
      if (matches.length !== 1) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "无法唯一匹配指定的 AT-SPI Action", { actionName, names });
      actionIndex = matches[0];
    }
    this.requireReference(window, runtimeId);
    let dispatched = false;
    try {
      const result = await this.request(node.ref, ACTION, "DoAction", "i", [actionIndex], budget, () => { dispatched = true; });
      if (result !== true) return { executed: false, verified: false, before, evidence: "AT-SPI Action.DoAction 明确返回 false" };
      return await this.actionResult(record, before, true, undefined, undefined, signal);
    } catch (error) {
      if (!dispatched) throw error;
      return await this.actionResult(record, before, "unknown", undefined, undefined, signal, error);
    }
  }

  async setValue(window: WindowInfo, runtimeId: string, text: string, signal?: AbortSignal): Promise<AtSpiSemanticResult> {
    if (typeof text !== "string" || Array.from(text).length > MAX_TEXT_CHARS) {
      throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "AT-SPI 单次写入最多 65536 个 Unicode 字符；未发送任何内容");
    }
    const record = this.requireReference(window, runtimeId);
    const budget = this.budget(signal, 8_000);
    const { node, control: before } = await this.freshControl(record, budget, true);
    if (!before.enabled || node.states.includes("read_only")) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件不可编辑");
    let expectedText: string | undefined;
    let expectedValue: number | undefined;
    let iface: string;
    let member: string;
    let signature: string;
    let body: unknown[];
    if (node.interfaces.includes(EDITABLE_TEXT)) {
      iface = EDITABLE_TEXT; member = "SetTextContents"; signature = "s"; body = [text]; expectedText = text;
    } else if (node.interfaces.includes(VALUE)) {
      const number = text.trim() ? Number(text) : Number.NaN;
      if (!Number.isFinite(number)) throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "该控件仅支持数值 Value，不能写入非数值文本");
      const raw = object(await this.request(node.ref, PROPERTIES, "GetAll", "s", [VALUE], budget));
      const min = raw.MinimumValue; const max = raw.MaximumValue;
      if (typeof min !== "number" || typeof max !== "number" || !Number.isFinite(min) || !Number.isFinite(max) || number < min || number > max) {
        throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "Value 数值超出有效范围或范围不可确认", { requested: number, min, max });
      }
      iface = PROPERTIES; member = "Set"; signature = "ssv"; body = [VALUE, "CurrentValue", ["d", number]]; expectedValue = number;
    } else throw new ComputerUseError("CONTROL_NOT_ACTIONABLE", "控件没有 EditableText 或 Value 接口");
    this.requireReference(window, runtimeId);
    let dispatched = false;
    try {
      const result = await this.request(node.ref, iface, member, signature, body, budget, () => { dispatched = true; });
      if (iface === EDITABLE_TEXT && result !== true) return { executed: false, verified: false, before, evidence: "AT-SPI EditableText.SetTextContents 明确返回 false" };
      return await this.actionResult(record, before, true, expectedText, expectedValue, signal);
    } catch (error) {
      if (!dispatched) throw error;
      return await this.actionResult(record, before, "unknown", expectedText, expectedValue, signal, error);
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.lifecycle.abort();
    this.invalidateAll("AT-SPI worker 已关闭");
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    for (const dispose of connection.disposeListeners.splice(0)) dispose();
    // Remove app event registrations and bus match rules before disconnect.
    // Bounded best effort: a dead bus must never prevent worker termination.
    await Promise.allSettled([
      ...connection.registeredEvents.map((event) => connection.accessibility.call({ destination: REGISTRY, path: REGISTRY_PATH, interface: REGISTRY, member: "DeregisterEvent", signature: "ss", body: [event, ""] }, { timeoutMs: 300 })),
      ...connection.matches.map((match) => connection.accessibility.call({ destination: DBUS, path: "/org/freedesktop/DBus", interface: DBUS, member: "RemoveMatch", signature: "s", body: [match] }, { timeoutMs: 300 })),
    ]);
    await Promise.allSettled([connection.session.close(), connection.accessibility.close()]);
    this.references.clear();
    this.busPids.clear();
    this.busOwners.clear();
    this.ownerRevisions.clear();
  }
}
