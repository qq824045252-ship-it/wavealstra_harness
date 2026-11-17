import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { DownloadItem, Event, WebContents } from "electron";
import { BrowserPrompt, BrowserPromptError } from "./BrowserPrompt.ts";

export interface BrowserPageProtocol {
  readonly isAttached: boolean;
  protocolCommand(method: string, parameters?: unknown, sessionId?: string): Promise<unknown>;
  subscribeProtocol(listener: (method: string, params: unknown, sessionId?: string) => void): () => void;
}
export interface EventWaitScope { run<T>(operation: () => Promise<T>): Promise<T>; }
export type PageTrace = { seq: number; time: number; sessionId?: string } & (
  | { kind: "request"; requestId: string; method: string; url: string }
  | { kind: "response"; requestId: string; url: string; status: number }
  | { kind: "failure"; requestId: string; error: string }
  | { kind: "console"; level: string; text: string }
  | { kind: "exception"; text: string }
);
type TracePayload = PageTrace extends infer T ? T extends PageTrace ? Omit<T, "seq" | "time"> : never : never;
export interface PageDialog { id: string; type: "alert" | "confirm" | "prompt" | "beforeunload"; message: string; url: string; sessionId?: string; defaultPrompt?: string; native?: boolean; }
export type DialogAnswer = { action: "dismiss" } | { action: "accept"; promptText?: string };
export interface DialogRule { type: PageDialog["type"]; answer: DialogAnswer; messageIncludes?: string; }
export type DownloadResult =
  | { id: string; state: "completed"; path: string; bytes: number; sha256: string; url: string }
  | { id: string; state: "cancelled" | "interrupted"; url: string };
export interface DownloadWatch { id: string; wait(scope: EventWaitScope): Promise<DownloadResult>; cancel(): void; }
export interface ResponseWatch { wait(scope: EventWaitScope): Promise<Extract<PageTrace, { kind: "response" }>>; cancel(): void; }
export interface ResponseCriteria { urlIncludes?: string; status?: number; }
export interface DownloadCriteria { urlIncludes?: string; filename?: string; }

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue { return value && typeof value === "object" ? value as RecordValue : {}; }
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function safeUrl(value: unknown): string {
  const text = str(value);
  try { const u = new URL(text); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.toString().slice(0, 2048); }
  catch { return ""; }
}
function safeText(value: unknown): string {
  return str(value).slice(0, 2000)
    .replace(/https?:\/\/[^\s"'<>]+/gi, match => safeUrl(match))
    .replace(/\b(authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
}
function safeFilename(value: string): string {
  const name = basename(value.replace(/\\/g, "/")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 120);
  return !name || name === "." || name === ".." ? "download" : name;
}
async function digest(path: string): Promise<{ bytes: number; sha256: string }> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error("Download is not a regular file");
  const hash = createHash("sha256"); let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== info.size) throw new Error("Download changed while hashing");
  return { bytes, sha256: hash.digest("hex") };
}

type PendingDownload = {
  id: string; criteria: DownloadCriteria; item?: DownloadItem;
  resolve: (result: DownloadResult) => void; reject: (error: Error) => void;
  promise: Promise<DownloadResult>; cancel: () => void;
};

/** Events belong to one pinned WebContents and one already attached inspector. */
export class BrowserPageEvents {
  private readonly childSessions = new Set<string>();
  private seq = 0;
  private trace: PageTrace[] = [];
  private readonly requestStarts = new Map<string, number>();
  private unsubscribe?: () => void;
  private started = false;
  private disposed = false;
  private dialog?: PageDialog;
  private answering = false;
  private rules: DialogRule[] = [];
  private ruleOwner?: object;
  private promptBridge?: BrowserPrompt;
  private nativeBeforeUnload?: string;
  private beforeUnloadResponse?: "accept" | "dismiss";
  private navigationDialog?: { closed: boolean; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
  private downloads: PendingDownload[] = [];
  private responseListeners = new Set<(event: Extract<PageTrace, { kind: "response" }>) => void>();
  private responseCancels = new Set<() => void>();
  private downloadDirectory = "";

  private readonly protocol: BrowserPageProtocol;
  private readonly wc: WebContents;
  private readonly downloadsDir: string | undefined;
  private readonly traceLimit: number;
  constructor(protocol: BrowserPageProtocol, wc: WebContents, downloadsDir: string | undefined, traceLimit = 500) {
    this.protocol = protocol; this.wc = wc; this.downloadsDir = downloadsDir; this.traceLimit = traceLimit;
  }

  async start(): Promise<() => void> {
    if (this.disposed || this.started || !this.protocol.isAttached) throw new Error("Page events require a live attached session");
    this.started = true;
    try {
      if (this.downloadsDir) {
        await mkdir(resolve(this.downloadsDir), { recursive: true });
        this.downloadDirectory = await realpath(resolve(this.downloadsDir));
      }
      if (this.disposed) throw new Error("Page events disposed");
      this.unsubscribe = this.protocol.subscribeProtocol((method, params, sessionId) => this.onProtocol(method, params, sessionId));
      this.wc.session.on("will-download", this.onDownload);
      await this.protocol.protocolCommand("Network.enable");
      if (this.disposed) throw new Error("Page events disposed");
      await this.protocol.protocolCommand("Runtime.enable");
      if (this.disposed) throw new Error("Page events disposed");
      await this.protocol.protocolCommand("Page.enable");
      await this.protocol.protocolCommand("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      if (this.disposed) throw new Error("Page events disposed");
      this.promptBridge = new BrowserPrompt(this.wc, this.protocol,
        dialog => this.publishDialog({ ...dialog, message: safeText(dialog.message), url: safeUrl(dialog.url), native: true }),
        () => this.handleBeforeUnload());
      await this.promptBridge.start();
      return () => this.dispose();
    } catch (error) { this.dispose(); throw error; }
  }

  snapshot(since = 0): { events: PageTrace[]; cursor: number; truncated: boolean } {
    return { events: this.trace.filter(event => event.seq > since), cursor: this.seq, truncated: this.trace.length > 0 && since < this.trace[0].seq - 1 };
  }
  currentDialog(): PageDialog | undefined { return this.dialog && { ...this.dialog }; }
  armDialogRules(rules: readonly DialogRule[]): () => void {
    this.setDialogRules(rules); const owner = {}; this.ruleOwner = owner;
    return () => { if (this.ruleOwner === owner) this.setDialogRules([]); };
  }
  setDialogRules(rules: readonly DialogRule[]): void { this.ruleOwner = undefined; this.rules = rules.map(rule => ({ ...rule, answer: { ...rule.answer } })); this.beforeUnloadResponse = undefined; }
  async preparePrompts(): Promise<void> { await this.promptBridge?.refresh(); }
  async settleNavigationDialog(scope: EventWaitScope): Promise<void> {
    const pending = this.navigationDialog;
    if (!pending) return;
    await scope.run(() => pending.promise);
    if (this.disposed || this.wc.isDestroyed()) throw new Error("Navigation dialog page is unavailable");
    await scope.run(() => this.wc.executeJavaScript("true"));
    if (this.navigationDialog === pending) this.navigationDialog = undefined;
  }
  async answerDialog(id: string, answer: DialogAnswer): Promise<void> {
    if (!this.dialog || this.dialog.id !== id || this.answering) throw new Error("Dialog is no longer pending");
    if (this.nativeBeforeUnload === id) {
      if (answer.action === "accept") throw new BrowserPromptError("UNSUPPORTED_SCOPE", "离开请求已安全取消；请为原操作预设 beforeunload 接受规则后重试，不会猜测或重放导航");
      this.nativeBeforeUnload = undefined; this.dialog = undefined; return;
    }
    this.answering = true;
    try {
      if (this.promptBridge?.owns(id)) this.promptBridge.answer(id, answer);
      else await this.protocol.protocolCommand("Page.handleJavaScriptDialog", { accept: answer.action === "accept", ...(answer.action === "accept" && answer.promptText !== undefined ? { promptText: answer.promptText } : {}) }, this.dialog.sessionId);
      if (this.dialog?.id === id) this.dialog = undefined;
    } finally { this.answering = false; }
  }

  armResponse(criteria: ResponseCriteria = {}): ResponseWatch {
    if (!this.started || this.disposed) throw new Error("Page events are not ready");
    const armedAt = this.seq;
    let resolvePromise!: (value: Extract<PageTrace, { kind: "response" }>) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<Extract<PageTrace, { kind: "response" }>>((resolveResult, reject) => { resolvePromise = resolveResult; rejectPromise = reject; });
    void promise.catch(() => {});
    const cleanup = () => { this.responseListeners.delete(listener); this.responseCancels.delete(cancel); };
    const cancel = () => { cleanup(); rejectPromise(new Error("Response watch cancelled")); };
    const listener = (event: Extract<PageTrace, { kind: "response" }>) => {
      if ((this.requestStarts.get(event.requestId) ?? -1) <= armedAt) return;
      if ((criteria.urlIncludes && !event.url.includes(criteria.urlIncludes)) || (criteria.status !== undefined && event.status !== criteria.status)) return;
      cleanup(); resolvePromise(event);
    };
    this.responseListeners.add(listener); this.responseCancels.add(cancel);
    return { cancel, wait: async scope => { try { return await scope.run(() => promise); } catch (error) { cancel(); throw error; } } };
  }
  armDownload(criteria: DownloadCriteria = {}): DownloadWatch {
    if (!this.started || this.disposed || !this.downloadDirectory) throw new Error("Page events are not ready");
    let resolvePromise!: (result: DownloadResult) => void, rejectPromise!: (error: Error) => void;
    const promise = new Promise<DownloadResult>((resolveResult, reject) => { resolvePromise = resolveResult; rejectPromise = reject; });
    void promise.catch(() => {});
    const entry: PendingDownload = { id: randomUUID(), criteria, promise, resolve: resolvePromise, reject: rejectPromise, cancel: () => {} };
    entry.cancel = () => { if (!this.downloads.includes(entry)) return; this.removeDownload(entry); entry.item?.cancel(); entry.reject(new Error("Download watch cancelled")); };
    this.downloads.push(entry);
    return { id: entry.id, cancel: entry.cancel, wait: async scope => {
      try { return await scope.run(() => promise); } catch (error) { entry.cancel(); throw error; }
    } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.navigationDialog?.reject(new Error("Navigation dialog owner disposed")); this.navigationDialog = undefined;
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.promptBridge?.dispose(); this.promptBridge = undefined; this.nativeBeforeUnload = undefined;
    this.wc.session.off("will-download", this.onDownload);
    for (const entry of [...this.downloads]) entry.cancel();
    for (const cancel of [...this.responseCancels]) cancel();
    this.dialog = undefined; this.rules = [];
  }

  private push(value: TracePayload): void {
    this.trace.push({ ...value, seq: ++this.seq, time: Date.now() } as PageTrace);
    const excess = this.trace.length - Math.max(1, this.traceLimit);
    if (excess > 0) this.trace.splice(0, excess);
    const event = this.trace[this.trace.length - 1];
    if (event.kind === "request") {
      this.requestStarts.set(event.requestId, event.seq);
      while (this.requestStarts.size > Math.max(1, this.traceLimit)) this.requestStarts.delete(this.requestStarts.keys().next().value!);
    }
    if (event.kind === "response") for (const listener of [...this.responseListeners]) listener(event);
  }
  private publishDialog(dialog: PageDialog): void {
    this.dialog = dialog;
    const index = this.rules.findIndex(rule => rule.type === dialog.type && (rule.messageIncludes === undefined || dialog.message.includes(rule.messageIncludes)));
    if (index >= 0) { const [rule] = this.rules.splice(index, 1); void this.answerDialog(dialog.id, rule.answer).catch(() => {}); }
  }
  private handleBeforeUnload(): "accept" | "dismiss" {
    if (!this.navigationDialog || this.navigationDialog.closed) {
      let resolve!: () => void, reject!: (error: Error) => void;
      const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
      void promise.catch(() => {});
      this.navigationDialog = { closed: false, promise, resolve, reject };
    }
    if (this.beforeUnloadResponse) return this.beforeUnloadResponse;
    const message = "网页请求确认离开";
    const index = this.rules.findIndex(rule => rule.type === "beforeunload" && (rule.messageIncludes === undefined || message.includes(rule.messageIncludes)));
    if (index >= 0) {
      const [rule] = this.rules.splice(index, 1); this.dialog = undefined; this.nativeBeforeUnload = undefined;
      this.beforeUnloadResponse = rule.answer.action; return rule.answer.action;
    }
    const id = randomUUID(); this.nativeBeforeUnload = id;
    this.dialog = { id, type: "beforeunload", message, url: safeUrl(this.wc.getURL()), native: true };
    this.beforeUnloadResponse = "dismiss"; return "dismiss";
  }
  private onProtocol(method: string, value: unknown, sessionId?: string): void {
    if (this.disposed) return;
    const p = record(value);
    if (method === "Target.attachedToTarget" && typeof p.sessionId === "string" && record(p.targetInfo).type === "iframe" && !this.childSessions.has(p.sessionId)) {
      const child = p.sessionId; this.childSessions.add(child);
      void (async () => { for (const domain of ["Network.enable", "Runtime.enable", "Page.enable", "Target.setAutoAttach"]) {
        if (this.disposed || !this.childSessions.has(child)) return;
        await this.protocol.protocolCommand(domain, domain === "Target.setAutoAttach" ? { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } : {}, child);
      } })().catch(() => { this.childSessions.delete(child); });
      return;
    }
    if (method === "Target.detachedFromTarget" && typeof p.sessionId === "string") { this.childSessions.delete(p.sessionId); return; }
    if (method === "Inspector.detached") { this.dispose(); return; }
    const push = (event: TracePayload) => this.push({ ...event, ...(sessionId ? { sessionId } : {}) });
    if (method === "Network.requestWillBeSent") { const r = record(p.request); push({ kind: "request", requestId: `${sessionId ?? "root"}:${str(p.requestId)}`, method: str(r.method), url: safeUrl(r.url) }); }
    else if (method === "Network.responseReceived") { const r = record(p.response); push({ kind: "response", requestId: `${sessionId ?? "root"}:${str(p.requestId)}`, status: typeof r.status === "number" ? r.status : 0, url: safeUrl(r.url) }); }
    else if (method === "Network.loadingFailed") push({ kind: "failure", requestId: `${sessionId ?? "root"}:${str(p.requestId)}`, error: safeText(p.errorText) });
    else if (method === "Runtime.consoleAPICalled") { const args = Array.isArray(p.args) ? p.args : []; push({ kind: "console", level: str(p.type), text: args.map(value => safeText(record(value).value)).filter(Boolean).join(" ").slice(0, 2000) }); }
    else if (method === "Runtime.exceptionThrown") { const detail = record(p.exceptionDetails), exception = record(detail.exception); push({ kind: "exception", text: safeText(exception.description || detail.text) }); }
    else if (method === "Page.javascriptDialogOpening") {
      const type = str(p.type);
      if (type !== "alert" && type !== "confirm" && type !== "prompt" && type !== "beforeunload") return;
      if (this.promptBridge && type === "prompt") return;
      if (this.promptBridge && type === "beforeunload") {
        // DevTools and Electron's synchronous native callback see one decision.
        // Resolving the protocol dialog also releases Chromium's pending dialog
        // state after a denied navigation; neither path invokes a system modal.
        const answer = this.handleBeforeUnload();
        void this.protocol.protocolCommand("Page.handleJavaScriptDialog", { accept: answer === "accept" }, sessionId).catch(() => {});
        return;
      }
      const dialog: PageDialog = { id: randomUUID(), type, message: safeText(p.message), url: safeUrl(p.url), ...(sessionId ? { sessionId } : {}) };
      this.publishDialog(dialog);
    } else if (method === "Page.javascriptDialogClosed") {
      if (this.navigationDialog) { this.navigationDialog.closed = true; this.navigationDialog.resolve(); }
      this.beforeUnloadResponse = undefined;
      if (this.dialog?.id !== this.nativeBeforeUnload && !(this.dialog && this.promptBridge?.owns(this.dialog.id))) this.dialog = undefined;
    }
  }
  private removeDownload(entry: PendingDownload): void { this.downloads = this.downloads.filter(value => value !== entry); }
  private onDownload = (_event: Event, item: DownloadItem, source: WebContents): void => {
    if (source !== this.wc || this.disposed) return;
    const url = safeUrl(item.getURL()), filename = item.getFilename();
    const entry = this.downloads.find(value => !value.item && (!value.criteria.urlIncludes || url.includes(value.criteria.urlIncludes)) && (!value.criteria.filename || filename === value.criteria.filename));
    if (!entry) return;
    entry.item = item;
    const path = join(this.downloadDirectory, `${entry.id}-${safeFilename(filename)}`);
    try { item.setSavePath(path); } catch (error) { this.removeDownload(entry); entry.reject(error instanceof Error ? error : new Error(String(error))); item.cancel(); return; }
    item.once("done", (_event, state) => {
      this.removeDownload(entry);
      if (state !== "completed") { entry.resolve({ id: entry.id, state: state === "cancelled" ? "cancelled" : "interrupted", url }); return; }
      void digest(path).then(result => entry.resolve({ id: entry.id, state: "completed", path, url, ...result }), error => entry.reject(error instanceof Error ? error : new Error(String(error))));
    });
  };
}



