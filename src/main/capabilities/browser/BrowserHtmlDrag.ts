import type { PageInspectionSession } from "../../artifact/PageInspectionService";
import type { AutomationScope } from "../AutomationScope";
import type { UiNativeInput } from "../UiAutomationService";

interface Point { x: number; y: number }
interface NativeDragData {
  items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
  files?: string[];
  dragOperationsMask: number;
}
type DragProtocol = Pick<PageInspectionSession, "protocolCommand" | "subscribeProtocol">;
export interface BrowserHtmlDragOptions { protocol: DragProtocol; input: UiNativeInput; scope: AutomationScope; points: readonly Point[] }
export class BrowserHtmlDragError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "UNSUPPORTED_SCOPE", message: string) { super(message); this.name = "BrowserHtmlDragError"; }
}
const owners = new WeakSet<DragProtocol>();
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function nativeData(value: unknown): NativeDragData {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 64 || !Number.isInteger(value.dragOperationsMask)) throw new BrowserHtmlDragError("UNSUPPORTED_SCOPE", "Chromium 返回了无效拖放数据");
  let length = 0;
  for (const item of value.items) {
    if (!record(item) || typeof item.mimeType !== "string" || typeof item.data !== "string" || item.mimeType.length > 200 ||
      item.title !== undefined && typeof item.title !== "string" || item.baseURL !== undefined && typeof item.baseURL !== "string") throw new BrowserHtmlDragError("UNSUPPORTED_SCOPE", "Chromium 返回了无效拖放条目");
    length += item.data.length + (typeof item.title === "string" ? item.title.length : 0) + (typeof item.baseURL === "string" ? item.baseURL.length : 0);
  }
  if (length > 2_000_000 || value.files !== undefined && (!Array.isArray(value.files) || value.files.length > 64 || value.files.some(file => typeof file !== "string" || file.length > 32_000))) throw new BrowserHtmlDragError("UNSUPPORTED_SCOPE", "原生拖放数据超过支持范围");
  return value as unknown as NativeDragData;
}

/** Caller owns the pinned document guards and surface lease. Both points and
 * input are in the root viewport; data comes only from Chromium's source drag. */
export async function htmlDragFromSource({ protocol, input, scope, points }: BrowserHtmlDragOptions): Promise<void> {
  if (points.length < 2 || points.length > 64 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000)) throw new BrowserHtmlDragError("INVALID_INPUT", "拖放需要有效的起点和终点");
  scope.check();
  if (owners.has(protocol)) throw new BrowserHtmlDragError("UNSUPPORTED_SCOPE", "该标签已有原生拖放操作");
  owners.add(protocol);
  let held = false, interception = false, dropped = false, failed = false;
  let last = points[0], captured: NativeDragData | undefined, captureError: unknown;
  let pending: Promise<unknown> | undefined;
  let notify!: () => void;
  const intercepted = new Promise<void>(resolve => { notify = resolve; });
  const unsubscribe = protocol.subscribeProtocol((method, params, sessionId) => {
    if (method !== "Input.dragIntercepted" || sessionId || captured || captureError) return;
    try { captured = nativeData(record(params) ? params.data : undefined); }
    catch (error) { captureError = error; }
    notify();
  });
  const command = (method: string, parameters?: unknown) => scope.run(() => { pending = protocol.protocolCommand(method, parameters); return pending; });
  const send = (event: Parameters<UiNativeInput["send"]>[0]) => scope.run(() => { pending = input.send(event); return pending; });
  try {
    await scope.run(() => { interception = true; pending = protocol.protocolCommand("Input.setInterceptDrags", { enabled: true }); return pending; });
    await send({ type: "mouseMove", ...last });
    scope.dispatch();
    await scope.run(() => { held = true; pending = input.send({ type: "mouseDown", button: "left", clickCount: 1, ...last }); return pending; });
    for (const endpoint of points.slice(1)) {
      const start = last;
      for (let step = 1; step <= 8 && !captured && !captureError; step++) {
        last = { x: start.x + (endpoint.x - start.x) * step / 8, y: start.y + (endpoint.y - start.y) * step / 8 };
        await send({ type: "mouseMove", button: "left", modifiers: ["leftbuttondown"], ...last });
      }
      if (captured || captureError) break;
    }
    if (!captured && !captureError) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { await scope.run(() => Promise.race([intercepted, new Promise<void>(resolve => { timer = setTimeout(resolve, 500); })])); }
      finally { clearTimeout(timer); }
    }
    if (captureError) throw captureError;
    if (!captured) throw new BrowserHtmlDragError("UNSUPPORTED_SCOPE", "源元素没有产生原生 HTML 拖放；不会伪造数据或重放手势");
    const data = captured;
    await command("Input.dispatchDragEvent", { type: "dragEnter", ...last, data });
    for (const point of points.slice(1)) {
      last = point;
      await command("Input.dispatchDragEvent", { type: "dragOver", ...last, data });
    }
    await scope.run(() => { pending = protocol.protocolCommand("Input.dispatchDragEvent", { type: "drop", ...last, data }).then(() => { dropped = true; }); return pending; });
  } catch (error) { failed = true; throw error; }
  finally {
    await pending?.catch(() => {});
    let cleanupError: unknown;
    const cleanup = async (operation: () => Promise<unknown>) => { try { await operation(); } catch (error) { cleanupError ??= error; } };
    if (held && !dropped && captured) await cleanup(() => protocol.protocolCommand("Input.dispatchDragEvent", { type: "dragCancel", ...last, data: captured }));
    if (held && !dropped) await cleanup(() => protocol.protocolCommand("Input.cancelDragging"));
    if (held) await cleanup(() => input.send({ type: "mouseUp", button: "left", clickCount: 1, ...last }));
    if (interception) await cleanup(() => protocol.protocolCommand("Input.setInterceptDrags", { enabled: false }));
    unsubscribe(); owners.delete(protocol);
    if (!failed && cleanupError) throw cleanupError;
  }
}
