import type { WebContents } from "electron";

export type RuntimeProbeTarget = "app" | "browser" | "artifact";
export type RuntimeProbeLevel = "debug" | "info" | "warning" | "error";
export type RuntimeProbeKind = "console" | "runtime-error" | "load" | "navigation" | "process" | "lifecycle";
export type RuntimeProbeAction = "status" | "mark" | "read";

export interface RuntimeProbeInput {
  action: RuntimeProbeAction;
  target?: RuntimeProbeTarget;
  afterSequence?: number;
  limit?: number;
  levels?: RuntimeProbeLevel[];
  kinds?: RuntimeProbeKind[];
}

export interface RuntimeProbeEvent {
  sequence: number;
  timestamp: number;
  target: RuntimeProbeTarget;
  kind: RuntimeProbeKind;
  level: RuntimeProbeLevel;
  message: string;
  url?: string;
  sourceId?: string;
  line?: number;
  detail?: Record<string, unknown>;
}

export interface RuntimeFocusedElement {
  tag: string;
  id?: string;
  role?: string;
  name?: string;
  text?: string;
}

export interface RuntimeProbeState {
  target: RuntimeProbeTarget;
  available: boolean;
  webContentsId?: number;
  rendererPid?: number;
  url?: string;
  title?: string;
  loading?: boolean;
  crashed?: boolean;
  documentReadyState?: string;
  documentVisibility?: string;
  documentHasFocus?: boolean;
  focusedElement?: RuntimeFocusedElement | null;
  documentObservation?: "ready" | "unavailable";
}

export interface RuntimeProbeOutput {
  action: RuntimeProbeAction;
  target?: RuntimeProbeTarget;
  marker?: number;
  latestSequence: number;
  states?: RuntimeProbeState[];
  state?: RuntimeProbeState;
  events?: RuntimeProbeEvent[];
}

interface ProbeBinding {
  wc: WebContents;
  consoleMessage: (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>) => void;
  didFailLoad: (
    event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean,
  ) => void;
  renderProcessGone: (event: Electron.Event, details: Electron.RenderProcessGoneDetails) => void;
  didStartLoading: () => void;
  didStopLoading: () => void;
  didNavigate: (event: Electron.Event, url: string) => void;
  didNavigateInPage: (event: Electron.Event, url: string, isMainFrame: boolean) => void;
  domReady: () => void;
  destroyed: () => void;
}

const MAX_EVENTS_PER_TARGET = 400;
const MAX_MESSAGE_LENGTH = 8_000;
const RUNTIME_ERROR_PREFIX = "[MYBUDDY_RUNTIME_ERROR]";
const UNHANDLED_REJECTION_PREFIX = "[MYBUDDY_UNHANDLED_REJECTION]";
const RENDERER_OBSERVATION_TIMEOUT_MS = 1_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function boundedText(value: unknown, max = MAX_MESSAGE_LENGTH): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function normalizeConsoleLevel(value: unknown): RuntimeProbeLevel {
  if (value === "error" || value === "warning" || value === "debug" || value === "info") return value;
  return "info";
}

function runtimeHookScript(): string {
  return `(() => {
    const key = '__mybuddy_runtime_probe_v1__';
    if (globalThis[key]) return 'already-installed';
    try { Object.defineProperty(globalThis, key, { value: true, configurable: false }); }
    catch { globalThis[key] = true; }
    window.addEventListener('error', (event) => {
      const parts = [String(event.message || 'window error')];
      if (event.filename) parts.push('@ ' + event.filename + ':' + (event.lineno || 0) + ':' + (event.colno || 0));
      console.error(${JSON.stringify(RUNTIME_ERROR_PREFIX)} + ' ' + parts.join(' '));
    });
    window.addEventListener('unhandledrejection', (event) => {
      let reason = event.reason;
      try {
        if (reason instanceof Error) reason = reason.stack || reason.message;
        else if (typeof reason !== 'string') reason = JSON.stringify(reason);
      } catch { reason = String(reason); }
      console.error(${JSON.stringify(UNHANDLED_REJECTION_PREFIX)} + ' ' + String(reason ?? 'unknown rejection'));
    });
    return 'installed';
  })()`;
}

function focusedElementScript(): string {
  return `(() => {
    const el = document.activeElement;
    const norm = (v) => String(v ?? '').replace(/\\s+/g, ' ').trim();
    let focused = null;
    if (el && el instanceof Element) {
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || (el instanceof HTMLInputElement ? el.placeholder : '') || el.textContent;
      focused = {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        role: el.getAttribute('role') || undefined,
        name: norm(label).slice(0, 500) || undefined,
        text: norm(el.textContent).slice(0, 500) || undefined,
      };
    }
    return {
      readyState: document.readyState,
      visibility: document.visibilityState,
      hasFocus: document.hasFocus(),
      focused,
    };
  })()`;
}

export class RuntimeProbeService {
  private readonly bindings = new Map<RuntimeProbeTarget, ProbeBinding>();
  private readonly buffers = new Map<RuntimeProbeTarget, RuntimeProbeEvent[]>();
  private readonly listeners = new Set<(event: RuntimeProbeEvent) => void>();
  private sequence = 0;

  attach(target: RuntimeProbeTarget, wc: WebContents): void {
    const existing = this.bindings.get(target);
    if (existing?.wc === wc && !wc.isDestroyed()) return;
    if (existing) this.detach(target, existing.wc);

    const consoleMessage: ProbeBinding["consoleMessage"] = (event) => {
      const message = boundedText(event.message);
      const runtimeError = message.startsWith(RUNTIME_ERROR_PREFIX) || message.startsWith(UNHANDLED_REJECTION_PREFIX);
      this.push(target, {
        kind: runtimeError ? "runtime-error" : "console",
        level: runtimeError ? "error" : normalizeConsoleLevel(event.level),
        message,
        url: this.safeUrl(wc),
        sourceId: boundedText(event.sourceId, 2_000) || undefined,
        line: Number.isFinite(event.lineNumber) ? event.lineNumber : undefined,
      });
    };
    const didFailLoad: ProbeBinding["didFailLoad"] = (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || (errorCode === -3 && target !== "browser")) return;
      const failedUrl = validatedURL || this.safeUrl(wc);
      this.push(target, {
        kind: "load",
        level: "error",
        message: target === "browser"
          ? `net::${boundedText(errorDescription, 2_000)}${failedUrl ? ` ${failedUrl}` : ""}`
          : `did-fail-load ${errorCode}: ${boundedText(errorDescription, 2_000)}`,
        url: failedUrl,
        detail: { errorCode, isMainFrame },
      });
    };
    const renderProcessGone: ProbeBinding["renderProcessGone"] = (_event, details) => {
      this.push(target, {
        kind: "process",
        level: details.reason === "clean-exit" ? "info" : "error",
        message: `render-process-gone: ${details.reason}`,
        url: this.safeUrl(wc),
        detail: { reason: details.reason, exitCode: details.exitCode },
      });
    };
    const didStartLoading = () => this.push(target, {
      kind: "load", level: "debug", message: "did-start-loading", url: this.safeUrl(wc),
    });
    const didStopLoading = () => this.push(target, {
      kind: "load", level: "debug", message: "did-stop-loading", url: this.safeUrl(wc),
    });
    const didNavigate: ProbeBinding["didNavigate"] = (_event, url) => this.push(target, {
      kind: "navigation", level: "info", message: "did-navigate", url,
    });
    const didNavigateInPage: ProbeBinding["didNavigateInPage"] = (_event, url, isMainFrame) => {
      if (!isMainFrame) return;
      this.push(target, { kind: "navigation", level: "info", message: "did-navigate-in-page", url });
    };
    const domReady = () => {
      this.push(target, { kind: "lifecycle", level: "debug", message: "dom-ready", url: this.safeUrl(wc) });
      void this.installRendererHooks(wc);
    };
    const destroyed = () => {
      this.push(target, { kind: "lifecycle", level: "warning", message: "webContents destroyed", url: this.safeUrl(wc) });
      const current = this.bindings.get(target);
      if (current?.wc === wc) this.bindings.delete(target);
    };

    wc.on("console-message", consoleMessage);
    wc.on("did-fail-load", didFailLoad);
    wc.on("render-process-gone", renderProcessGone);
    wc.on("did-start-loading", didStartLoading);
    wc.on("did-stop-loading", didStopLoading);
    wc.on("did-navigate", didNavigate);
    wc.on("did-navigate-in-page", didNavigateInPage);
    wc.on("dom-ready", domReady);
    wc.on("destroyed", destroyed);
    this.bindings.set(target, {
      wc, consoleMessage, didFailLoad, renderProcessGone, didStartLoading, didStopLoading,
      didNavigate, didNavigateInPage, domReady, destroyed,
    });
    this.push(target, { kind: "lifecycle", level: "info", message: "runtime probe attached", url: this.safeUrl(wc) });
    void this.installRendererHooks(wc);
  }

  detach(target: RuntimeProbeTarget, expected?: WebContents): void {
    const binding = this.bindings.get(target);
    if (!binding || (expected && binding.wc !== expected)) return;
    const wc = binding.wc;
    if (!wc.isDestroyed()) {
      wc.removeListener("console-message", binding.consoleMessage);
      wc.removeListener("did-fail-load", binding.didFailLoad);
      wc.removeListener("render-process-gone", binding.renderProcessGone);
      wc.removeListener("did-start-loading", binding.didStartLoading);
      wc.removeListener("did-stop-loading", binding.didStopLoading);
      wc.removeListener("did-navigate", binding.didNavigate);
      wc.removeListener("did-navigate-in-page", binding.didNavigateInPage);
      wc.removeListener("dom-ready", binding.domReady);
      wc.removeListener("destroyed", binding.destroyed);
    }
    this.bindings.delete(target);
  }

  onEvent(listener: (event: RuntimeProbeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(target: RuntimeProbeTarget): void {
    this.buffers.set(target, []);
  }

  anyAvailable(): boolean {
    return (["app", "browser", "artifact"] as RuntimeProbeTarget[]).some((target) => this.available(target));
  }

  available(target: RuntimeProbeTarget): boolean {
    const wc = this.bindings.get(target)?.wc;
    return Boolean(wc && !wc.isDestroyed());
  }

  async execute(input: RuntimeProbeInput): Promise<RuntimeProbeOutput> {
    if (input.action === "status") {
      if (input.target) {
        const state = await this.state(input.target);
        return { action: input.action, target: input.target, latestSequence: this.sequence, state };
      }
      const states = await Promise.all(((["app", "browser", "artifact"] as RuntimeProbeTarget[])).map((target) => this.state(target)));
      return { action: input.action, latestSequence: this.sequence, states };
    }

    const target = input.target ?? "app";
    const state = await this.state(target);
    if (input.action === "mark") {
      return { action: input.action, target, marker: this.sequence, latestSequence: this.sequence, state };
    }

    const after = Number.isFinite(input.afterSequence) ? Math.max(0, Math.floor(input.afterSequence!)) : 0;
    const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 80)));
    const levelSet = input.levels?.length ? new Set(input.levels) : null;
    const kindSet = input.kinds?.length ? new Set(input.kinds) : null;
    const events = (this.buffers.get(target) ?? [])
      .filter((event) => event.sequence > after)
      .filter((event) => !levelSet || levelSet.has(event.level))
      .filter((event) => !kindSet || kindSet.has(event.kind))
      .slice(-limit);
    return { action: input.action, target, latestSequence: this.sequence, state, events };
  }

  private safeUrl(wc: WebContents): string | undefined {
    try {
      if (wc.isDestroyed()) return undefined;
      return wc.getURL() || undefined;
    } catch {
      return undefined;
    }
  }

  private push(target: RuntimeProbeTarget, event: Omit<RuntimeProbeEvent, "sequence" | "timestamp" | "target">): void {
    const row: RuntimeProbeEvent = {
      ...event,
      sequence: ++this.sequence,
      timestamp: Date.now(),
      target,
      message: boundedText(event.message),
    };
    const buffer = this.buffers.get(target) ?? [];
    buffer.push(row);
    if (buffer.length > MAX_EVENTS_PER_TARGET) buffer.splice(0, buffer.length - MAX_EVENTS_PER_TARGET);
    this.buffers.set(target, buffer);
    for (const listener of this.listeners) {
      try {
        listener(row);
      } catch {
        // 诊断订阅者失败不得反向破坏页面事件采集。
      }
    }
  }

  private async installRendererHooks(wc: WebContents): Promise<void> {
    try {
      if (wc.isDestroyed() || wc.isCrashed()) return;
      await withTimeout(wc.executeJavaScript(runtimeHookScript(), true), RENDERER_OBSERVATION_TIMEOUT_MS, "runtime hook injection");
    } catch {
      // Navigation, sandbox state, or a renderer crash may make injection temporarily unavailable.
      // The next dom-ready event retries automatically.
    }
  }

  private async state(target: RuntimeProbeTarget): Promise<RuntimeProbeState> {
    const wc = this.bindings.get(target)?.wc;
    if (!wc || wc.isDestroyed()) return { target, available: false };
    const state: RuntimeProbeState = {
      target,
      available: true,
      webContentsId: wc.id,
      rendererPid: wc.getOSProcessId(),
      url: this.safeUrl(wc),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      crashed: wc.isCrashed(),
    };
    if (state.crashed) return state;
    try {
      const documentState = await withTimeout(
        wc.executeJavaScript(focusedElementScript(), true) as Promise<{
          readyState?: string;
          visibility?: string;
          hasFocus?: boolean;
          focused?: RuntimeFocusedElement | null;
        }>,
        RENDERER_OBSERVATION_TIMEOUT_MS,
        "runtime document observation",
      );
      state.documentReadyState = documentState?.readyState;
      state.documentVisibility = documentState?.visibility;
      state.documentHasFocus = documentState?.hasFocus;
      state.focusedElement = documentState?.focused ?? null;
      state.documentObservation = "ready";
    } catch {
      // Keep process/window state useful even before a document is ready or during navigation.
      state.documentObservation = "unavailable";
    }
    return state;
  }
}

export const runtimeProbeService = new RuntimeProbeService();
