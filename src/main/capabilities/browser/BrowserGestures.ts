import type { UiNativeInput } from "../UiAutomationService";
import type { AutomationScope } from "../AutomationScope";

export interface GesturePoint { x: number; y: number; }
export interface DragData { items: readonly { mimeType: string; data: string }[]; dragOperationsMask: number; }
export interface DragProtocol { protocolCommand(method: string, parameters?: unknown): Promise<unknown>; }
export type DateInputType = "date" | "time" | "datetime-local" | "month" | "week";
export interface DateInputResult { strategy: "synthetic-setter"; type: DateInputType; value: string; }

function checkPoint(point: GesturePoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) throw new Error("Invalid gesture point");
}
function checkWaypoints(points: readonly GesturePoint[]): void {
  if (points.length < 2 || points.length > 64) throw new Error("Drag requires 2 to 64 points");
  points.forEach(checkPoint);
}

/** The caller supplies validated points in the pinned page viewport and owns the surface lease. */
export async function pointerDrag(input: UiNativeInput, scope: AutomationScope, points: readonly GesturePoint[]): Promise<void> {
  checkWaypoints(points); scope.check();
  let held = false; let last = points[0]; let pending: Promise<void> | undefined; let pendingUp: Promise<void> | undefined;
  try {
    await scope.run(() => input.send({ type: "mouseMove", ...last }));
    scope.dispatch();
    await scope.run(() => { held = true; pending = input.send({ type: "mouseDown", button: "left", clickCount: 1, ...last }); return pending; });
    for (const point of points.slice(1)) { last = point; await scope.run(() => { pending = input.send({ type: "mouseMove", modifiers: ["leftbuttondown"], ...point }); return pending; }); }
    await scope.run(() => { pendingUp = input.send({ type: "mouseUp", button: "left", clickCount: 1, ...last }); pending = pendingUp; return pendingUp; });
    held = false;
  } finally {
    if (held) {
      // A cancelled await does not cancel the underlying native command. Release only after down settles.
      if (pendingUp) { try { await pendingUp; held = false; } catch { /* release is retried below */ } }
      else await pending?.catch(() => {});
      if (held) await input.send({ type: "mouseUp", button: "left", clickCount: 1, ...last });
    }
  }
}

/** Dispatch explicit HTML drag data; this does not synthesize a source element's dragstart. */
export async function htmlDrag(protocol: DragProtocol, scope: AutomationScope, points: readonly GesturePoint[], data: DragData): Promise<void> {
  checkWaypoints(points); scope.check();
  if (!Number.isInteger(data.dragOperationsMask) || data.dragOperationsMask < 0 || data.dragOperationsMask > 7 || data.items.length < 1 || data.items.length > 16 || data.items.some(item => !item.mimeType || item.mimeType.length > 200 || item.data.length > 100_000) || data.items.reduce((n, item) => n + item.data.length, 0) > 200_000) throw new Error("Invalid drag data");
  const payload = { items: data.items.map(item => ({ mimeType: item.mimeType, data: item.data })), dragOperationsMask: data.dragOperationsMask };
  let active = false; let last = points[0]; let pending: Promise<unknown> | undefined; let pendingDrop: Promise<unknown> | undefined;
  const send = (type: "dragEnter" | "dragOver" | "drop" | "dragCancel", point: GesturePoint) => protocol.protocolCommand("Input.dispatchDragEvent", { type, ...point, data: payload });
  try {
    scope.dispatch();
    await scope.run(() => { active = true; pending = send("dragEnter", last); return pending; });
    for (const point of points.slice(1)) { last = point; await scope.run(() => { pending = send("dragOver", point); return pending; }); }
    await scope.run(() => { pendingDrop = send("drop", last); pending = pendingDrop; return pendingDrop; });
    active = false;
  } finally {
    if (active) {
      if (pendingDrop) { try { await pendingDrop; active = false; } catch { /* cancel below */ } }
      else await pending?.catch(() => {});
      if (active) await send("dragCancel", last);
    }
  }
}

/** Unicode code points are inserted individually, without a clipboard or synthetic key events. */
export async function insertTextSequential(input: UiNativeInput, scope: AutomationScope, text: string, delayMs = 0): Promise<void> {
  if (text.length > 100_000 || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > 1_000) throw new Error("Invalid sequential input");
  for (const character of text) {
    scope.dispatch();
    await scope.run(() => input.insertText(character));
    if (delayMs) await scope.run(() => new Promise<void>(resolve => setTimeout(resolve, delayMs)));
  }
}

/** evaluateOnElement must bind the function expression to the already observed and validated element. */
export async function setDateInput(scope: AutomationScope, evaluateOnElement: (functionExpression: string) => Promise<unknown>, type: DateInputType, value: string): Promise<DateInputResult> {
  if (!(type === "date" || type === "time" || type === "datetime-local" || type === "month" || type === "week") || value.length > 100) throw new Error("Invalid date input");
  const fn = `(element) => {
    const expectedType = ${JSON.stringify(type)}, requested = ${JSON.stringify(value)};
    if (!(element instanceof HTMLInputElement) || element.type !== expectedType || element.disabled || element.readOnly) return {ok:false, reason:'wrong type or non-editable'};
    const probe = element.cloneNode(false); probe.value = requested;
    if (probe.value !== requested || !probe.validity.valid) return {ok:false, reason:'invalid value'};
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(element, requested);
    element.dispatchEvent(new Event('input', {bubbles:true, composed:true}));
    element.dispatchEvent(new Event('change', {bubbles:true}));
    return {ok:true, value:element.value, valid:element.validity.valid};
  }`;
  scope.dispatch();
  const result = await scope.run(() => evaluateOnElement(fn));
  if (!result || typeof result !== "object" || !("ok" in result) || result.ok !== true || !("value" in result) || result.value !== value || !("valid" in result) || result.valid !== true) throw new Error("Date input rejected or changed value");
  return { strategy: "synthetic-setter", type, value };
}


