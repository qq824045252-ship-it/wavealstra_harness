import { createHash, randomUUID } from "node:crypto";
import electron, { type WebContents } from "electron";
import type { BrowserPageHost } from "../../browser/BrowserHost";
import { PageCaptureScope, pageInspectionService } from "../../artifact/PageInspectionService";
import type { AutomationScope } from "../AutomationScope";
import { browserDocumentScript } from "../BrowserPageRead";
import { browserNativeInput } from "../BrowserNativeInput";

export interface BrowserVisualTarget { owner: string; tabId: string; host: BrowserPageHost }
export interface BrowserVisualPoint { captureId: string; x: number; y: number }
export interface BrowserVisualViewport {
  pixelWidth: number; pixelHeight: number;
  width: number; height: number;
  scrollX: number; scrollY: number;
  deviceScaleFactor: number; zoomFactor: number;
}
export interface BrowserVisualCapture {
  captureId: string;
  screenshot: Uint8Array;
  viewport: BrowserVisualViewport;
  documentId: string;
  url: string;
}
export class BrowserVisualInputError extends Error {
  constructor(readonly code: "SCREENSHOT_STALE" | "PAGE_UNAVAILABLE" | "INVALID_INPUT" | "SCREENSHOT_EMPTY" | "UNSUPPORTED_SCOPE", message: string) {
    super(message); this.name = "BrowserVisualInputError";
  }
}

interface FrameState {
  frameId: string; documentId: string; url: string;
  width: number; height: number; scrollX: number; scrollY: number; deviceScaleFactor: number;
  visualScale: number; visualOffsetX: number; visualOffsetY: number; revision: number;
}
interface PageState { version: number; webContentsId: number; zoomFactor: number; frames: FrameState[] }
interface PixelState { width: number; height: number; hash: string }
interface RetainedCapture { target: BrowserVisualTarget; state: PageState; pixels: PixelState; createdAt: number }

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function pixels(screenshot: Uint8Array): PixelState {
  const image = electron.nativeImage.createFromBuffer(Buffer.from(screenshot));
  const size = image.getSize();
  if (image.isEmpty() || size.width <= 0 || size.height <= 0) throw new BrowserVisualInputError("SCREENSHOT_EMPTY", "浏览器截图没有有效像素");
  return { ...size, hash: createHash("sha256").update(image.toBitmap()).digest("hex") };
}
function sameState(left: PageState, right: PageState): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** Coordinate actions are licensed by one task/tab/document screenshot, never by
 * free coordinates. Pixel hashes include canvas/video, which DOM revisions miss. */
export class BrowserVisualInput {
  private readonly slot = `__mybuddyVisual_${randomUUID().replaceAll("-", "")}`;
  private readonly captures = new Map<string, RetainedCapture>();

  constructor(private readonly maxCaptures = 24, private readonly maxAgeMs = 120000) {
    if (!Number.isSafeInteger(maxCaptures) || maxCaptures < 1 || maxCaptures > 256 || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new BrowserVisualInputError("INVALID_INPUT", "截图记录预算无效");
    }
  }

  private contents(target: BrowserVisualTarget): WebContents {
    const wc = target.host.inspectionWebContents;
    if (!wc || wc.isDestroyed()) throw new BrowserVisualInputError("PAGE_UNAVAILABLE", "截图所属浏览器标签已关闭");
    return wc;
  }

  private async ready(target: BrowserVisualTarget, scope: AutomationScope): Promise<void> {
    const ready = await scope.run(() => this.contents(target).executeJavaScript(`new Promise(resolve=>{
      const check=()=>innerWidth>0&&innerHeight>0?resolve(true):Date.now()>=${scope.deadline}?resolve(false):setTimeout(check,20);check();
    })`));
    if (ready !== true) throw new BrowserVisualInputError("SCREENSHOT_EMPTY", "浏览器原生视口尚未就绪");
  }

  private async state(target: BrowserVisualTarget, scope: AutomationScope): Promise<PageState> {
    scope.check();
    const wc = this.contents(target), version = target.host.captureVersion;
    const nativeFrames = wc.mainFrame.framesInSubtree;
    if (nativeFrames.length > 256) throw new BrowserVisualInputError("UNSUPPORTED_SCOPE", "页面 frame 数超出截图身份验证预算");
    const frames: FrameState[] = [];
    for (const frame of nativeFrames) {
      if (frame.isDestroyed() || frame.detached) throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图期间 frame 已替换");
      const frameId = `${frame.frameTreeNodeId}:${frame.frameToken}`;
      const raw = await scope.run(() => frame.executeJavaScript(`(() => {
        const documentId=${browserDocumentScript(this.slot)},state=window[${JSON.stringify(this.slot)}];
        state.changed(state.observer.takeRecords());
        return {documentId,url:location.href,width:innerWidth,height:innerHeight,scrollX,scrollY,deviceScaleFactor:devicePixelRatio,
          visualScale:visualViewport?.scale??1,visualOffsetX:visualViewport?.offsetLeft??0,visualOffsetY:visualViewport?.offsetTop??0,revision:state.revision};
      })()`));
      if (!record(raw) || typeof raw.documentId !== "string" || typeof raw.url !== "string"
        || !finite(raw.width) || !finite(raw.height) || !finite(raw.scrollX) || !finite(raw.scrollY)
        || !finite(raw.deviceScaleFactor) || !finite(raw.visualScale) || !finite(raw.visualOffsetX) || !finite(raw.visualOffsetY) || !finite(raw.revision)) {
        throw new BrowserVisualInputError("SCREENSHOT_STALE", "页面没有返回有效的截图来源信息");
      }
      if (raw.width < 0 || raw.height < 0 || raw.deviceScaleFactor <= 0 || raw.visualScale <= 0
        || frame.isDestroyed() || frame.detached || `${frame.frameTreeNodeId}:${frame.frameToken}` !== frameId) {
        throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图所属 frame 的视口已变化");
      }
      frames.push({ frameId, documentId: raw.documentId, url: raw.url, width: raw.width, height: raw.height,
        scrollX: raw.scrollX, scrollY: raw.scrollY, deviceScaleFactor: raw.deviceScaleFactor,
        visualScale: raw.visualScale, visualOffsetX: raw.visualOffsetX, visualOffsetY: raw.visualOffsetY, revision: raw.revision });
    }
    if (this.contents(target) !== wc || target.host.captureVersion !== version
      || wc.mainFrame.framesInSubtree.map(frame => `${frame.frameTreeNodeId}:${frame.frameToken}`).join("|") !== frames.map(frame => frame.frameId).join("|")) {
      throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图所属标签或 frame 树已变化");
    }
    scope.check(); return { version, webContentsId: wc.id, zoomFactor: wc.getZoomFactor(), frames };
  }

  async capture(target: BrowserVisualTarget, scope: AutomationScope): Promise<BrowserVisualCapture> {
    const { before, screenshot, after } = await scope.run(() => target.host.withAutomationSurface(async () => {
      await this.ready(target, scope);
      const wc = this.contents(target), before = await this.state(target, scope);
      const existing = pageInspectionService.sessionFor(wc, "browser-host");
      const session = existing ?? pageInspectionService.acquire(wc, "browser-host");
      const captureScope = new PageCaptureScope(scope.signal, scope.remaining, () => { scope.check(); if (this.contents(target) !== wc || target.host.captureVersion !== before.version) throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图期间标签已变化"); });
      try {
        await scope.run(() => session.attach(wc.debugger));
        await scope.run(() => session.suspendInputOverlay(() => scope.check()));
        const screenshot = await scope.run(() => session.captureScreenshot(captureScope));
        return { before, screenshot, after: await this.state(target, scope) };
      } finally {
        await captureScope.drain();
        if (!existing && !session.hasProtocolSubscribers) pageInspectionService.release(wc, "browser-host");
      }
    }));
    if (!sameState(before, after)) throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图期间页面已变化，请重新截图");
    const pixelState = pixels(screenshot), main = after.frames[0];
    scope.check();
    if (!main) throw new BrowserVisualInputError("PAGE_UNAVAILABLE", "截图主文档不可用");
    if (main.visualScale !== 1 || main.visualOffsetX !== 0 || main.visualOffsetY !== 0) {
      throw new BrowserVisualInputError("UNSUPPORTED_SCOPE", "当前视觉视口缩放或偏移尚不能验证坐标映射");
    }
    const captureId = randomUUID();
    for (const [key, entry] of this.captures) if (Date.now() - entry.createdAt > this.maxAgeMs) this.captures.delete(key);
    while (this.captures.size >= this.maxCaptures) {
      const oldest = this.captures.keys().next().value;
      if (oldest !== undefined) this.captures.delete(oldest);
    }
    this.captures.set(captureId, { target: { ...target }, state: after, pixels: pixelState, createdAt: Date.now() });
    return { captureId, screenshot, documentId: main.documentId, url: main.url, viewport: {
      pixelWidth: pixelState.width, pixelHeight: pixelState.height, width: main.width, height: main.height,
      scrollX: main.scrollX, scrollY: main.scrollY, deviceScaleFactor: main.deviceScaleFactor, zoomFactor: after.zoomFactor,
    } };
  }

  private retained(target: BrowserVisualTarget, point: BrowserVisualPoint): RetainedCapture {
    const retained = this.captures.get(point.captureId);
    if (!retained || retained.target.owner !== target.owner || retained.target.tabId !== target.tabId || retained.target.host !== target.host
      || Date.now() - retained.createdAt > this.maxAgeMs) throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图引用已过期或不属于当前任务标签");
    if (!finite(point.x) || !finite(point.y) || point.x < 0 || point.y < 0 || point.x >= retained.pixels.width || point.y >= retained.pixels.height) {
      throw new BrowserVisualInputError("INVALID_INPUT", "坐标必须位于引用截图的像素范围内");
    }
    return retained;
  }

  private async act(target: BrowserVisualTarget, point: BrowserVisualPoint, scope: AutomationScope,
    action: { kind: "click"; button: "left" | "right" | "middle" } | { kind: "scroll"; deltaX: number; deltaY: number },
  ): Promise<{ captureId: string; point: { x: number; y: number }; dispatched: true }> {
    scope.check(); this.retained(target, point);
    // Never call this inside another presentation lease. Capture and input share
    // this single lease; recapture uses the session directly to avoid queue recursion.
    return scope.run(() => target.host.withAutomationSurface(async () => {
      scope.check();
      await this.ready(target, scope);
      const retained = this.retained(target, point), wc = this.contents(target);
      const before = await this.state(target, scope);
      if (!sameState(retained.state, before)) throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图所属文档、滚动或视口已变化");
      const existing = pageInspectionService.sessionFor(wc, "browser-host");
      const session = existing ?? pageInspectionService.acquire(wc, "browser-host");
      const captureScope = new PageCaptureScope(scope.signal, scope.remaining, () => { scope.check(); if (this.contents(target) !== wc || target.host.captureVersion !== retained.state.version) throw new BrowserVisualInputError("SCREENSHOT_STALE", "截图所属标签已变化"); });
      try {
        await scope.run(() => session.attach(wc.debugger));
        await scope.run(() => session.suspendInputOverlay(() => scope.check()));
        const fresh = pixels(await scope.run(() => session.captureScreenshot(captureScope)));
        const after = await this.state(target, scope);
        if (!sameState(before, after) || fresh.width !== retained.pixels.width || fresh.height !== retained.pixels.height || fresh.hash !== retained.pixels.hash) {
          throw new BrowserVisualInputError("SCREENSHOT_STALE", "页面像素或布局已变化，请重新截图后操作");
        }
        const main = after.frames[0];
        if (!main) throw new BrowserVisualInputError("PAGE_UNAVAILABLE", "主文档已关闭");
        const mapped = { x: point.x * main.width / fresh.width, y: point.y * main.height / fresh.height };
        this.retained(target, point); scope.check();
        const input = browserNativeInput(session);
        // Consume all observations of this target before dispatch, so a failed or
        // uncertain action cannot be replayed using an unchanged screenshot.
        this.invalidate(target.owner, target.tabId);
        scope.dispatch();
        if (action.kind === "scroll") {
          await scope.run(() => input.send({ type: "mouseWheel", ...mapped, deltaX: action.deltaX, deltaY: action.deltaY }));
        } else {
          try { await scope.run(() => input.send({ type: "mouseDown", ...mapped, button: action.button, clickCount: 1 })); }
          finally {
            // Release uses already-dispatched root coordinates even when a click
            // navigated/closed its document or the caller cancelled after down.
            if (session.isAttached && !wc.isDestroyed()) await input.send({ type: "mouseUp", ...mapped, button: action.button, clickCount: 1 });
          }
        }
        scope.check(); return { captureId: point.captureId, point: mapped, dispatched: true };
      } finally {
        await captureScope.drain();
        if (!existing && !session.hasProtocolSubscribers) pageInspectionService.release(wc, "browser-host");
      }
    }));
  }

  click(target: BrowserVisualTarget, input: BrowserVisualPoint & { button?: "left" | "right" | "middle" }, scope: AutomationScope): Promise<{ captureId: string; point: { x: number; y: number }; dispatched: true }> {
    const button = input.button ?? "left";
    if (!["left", "right", "middle"].includes(button)) return Promise.reject(new BrowserVisualInputError("INVALID_INPUT", "鼠标按键无效"));
    return this.act(target, input, scope, { kind: "click", button });
  }

  scroll(target: BrowserVisualTarget, input: BrowserVisualPoint & { deltaX: number; deltaY: number }, scope: AutomationScope): Promise<{ captureId: string; point: { x: number; y: number }; dispatched: true }> {
    if (!finite(input.deltaX) || !finite(input.deltaY) || Math.abs(input.deltaX) > 100000 || Math.abs(input.deltaY) > 100000 || !(input.deltaX || input.deltaY)) {
      return Promise.reject(new BrowserVisualInputError("INVALID_INPUT", "滚动量必须为非零且在允许范围内"));
    }
    return this.act(target, input, scope, { kind: "scroll", deltaX: input.deltaX, deltaY: input.deltaY });
  }

  invalidate(owner: string, tabId?: string): void {
    for (const [key, entry] of this.captures) if (entry.target.owner === owner && (tabId === undefined || entry.target.tabId === tabId)) this.captures.delete(key);
  }

  dispose(): void { this.captures.clear(); }
}
