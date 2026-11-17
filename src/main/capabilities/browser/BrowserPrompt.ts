import { randomUUID } from "node:crypto";
import type { Event, WebContents } from "electron";
import type { BrowserPageProtocol, DialogAnswer } from "./BrowserPageEvents";

export interface BrowserNativePrompt { id: string; type: "prompt"; message: string; defaultPrompt: string; url: string; frameId: string }
export class BrowserPromptError extends Error {
  readonly code: "UNSUPPORTED_SCOPE" | "PAGE_UNAVAILABLE";
  constructor(code: "UNSUPPORTED_SCOPE" | "PAGE_UNAVAILABLE", message: string) { super(message); this.code = code; this.name = "BrowserPromptError"; }
}
const owners = new WeakMap<WebContents, BrowserPrompt>();
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function handler(value: unknown): value is (...args: unknown[]) => void { return typeof value === "function"; }

/** BrowserHost calls this before its normal manual beforeunload dialog. Electron
 * requires a synchronous decision here; prearmed automation rules must own it. */
export function tryHandleBrowserBeforeUnload(wc: WebContents, event: Event): boolean {
  const owner = owners.get(wc);
  if (!owner) return false;
  if (owner.beforeUnload() === "accept") event.preventDefault();
  return true;
}

/** Electron 44 exposes no public prompt dialog handler. This deliberately narrow
 * adapter replaces only its guarded private prompt callback branch. Other native
 * dialogs keep their original handlers and no renderer IPC privilege is added. */
export class BrowserPrompt {
  private readonly slot = `__mybuddyPrompt_${randomUUID().replaceAll("-", "")}`;
  private originals: Array<(...args: unknown[]) => void> = [];
  private pending?: { id: string; defaultPrompt: string; reply: (accepted: boolean, text: string) => void };
  private disposed = false;
  private unsubscribe?: () => void;
  private readonly scripts = new Map<string, Promise<string>>();

  private readonly wc: WebContents;
  private readonly protocol: BrowserPageProtocol;
  private readonly onPrompt: (dialog: BrowserNativePrompt) => void;
  readonly beforeUnload: () => "accept" | "dismiss";
  constructor(wc: WebContents, protocol: BrowserPageProtocol,
    onPrompt: (dialog: BrowserNativePrompt) => void,
    beforeUnload: () => "accept" | "dismiss",
  ) { this.wc = wc; this.protocol = protocol; this.onPrompt = onPrompt; this.beforeUnload = beforeUnload; }

  private source(): string {
    return `(() => {
      const key=${JSON.stringify(this.slot)};
      if(window[key])return;
      const state={original:null,replacement:null,observer:null,disposed:false};
      Object.defineProperty(window,key,{value:state,configurable:true});
      const install=()=>{
        if(state.disposed||state.replacement)return;
        const current=window.prompt,source=Function.prototype.toString.call(current);
        const electronShim=(current.name===''&&source==='function () { [native code] }')||source.includes('prompt() is not supported.');
        if(!electronShim){state.observer?.disconnect();return;}
        if(!document.documentElement)return;
        const frame=document.createElement('iframe');frame.hidden=true;
        try{
          document.documentElement.appendChild(frame);
          const builtin=frame.contentWindow?.prompt;
          if(typeof builtin!=='function'||builtin.name!=='prompt'||!Function.prototype.toString.call(builtin).includes('[native code]'))throw new Error('MYBUDDY_NATIVE_PROMPT_UNAVAILABLE');
          const replacement=function prompt(){return Reflect.apply(builtin,window,arguments);};
          state.original=current;state.replacement=replacement;window.prompt=replacement;state.observer?.disconnect();
        }finally{frame.remove();}
      };
      state.install=install;
      if(document.documentElement)install();
      else{state.observer=new MutationObserver(install);state.observer.observe(document,{childList:true});document.addEventListener('DOMContentLoaded',install,{once:true});}
      return !!state.replacement;
    })()`;
  }

  async start(): Promise<void> {
    if (this.disposed || this.wc.isDestroyed() || owners.has(this.wc)) throw new BrowserPromptError("PAGE_UNAVAILABLE", "prompt 适配器不可用或已有 owner");
    const handlers = this.wc.listeners("-run-dialog").filter(handler);
    if (handlers.length !== 1 || handlers[0].length !== 2 || !String(handlers[0]).includes("dialogType") || !String(handlers[0]).includes("prompt")) {
      throw new BrowserPromptError("UNSUPPORTED_SCOPE", "当前 Electron 的 prompt 对话框接口不匹配，拒绝替换未知处理器");
    }
    this.originals = handlers;
    const emitter: NodeJS.EventEmitter = this.wc;
    for (const handler of handlers) emitter.removeListener("-run-dialog", handler);
    emitter.on("-run-dialog", this.handleNative);
    owners.set(this.wc, this);
    this.wc.on("did-frame-finish-load", this.onFrameLoaded);
    this.unsubscribe = this.protocol.subscribeProtocol((method, params) => {
      if (method === "Target.attachedToTarget" && record(params) && typeof params.sessionId === "string" && record(params.targetInfo) && params.targetInfo.type === "iframe") {
        void this.installFutureDocuments(params.sessionId).catch(() => {});
      }
    });
    try { await this.installFutureDocuments(""); await this.refresh(); }
    catch (error) { this.dispose(); throw error; }
  }

  private installFutureDocuments(sessionId: string): Promise<string> {
    const previous = this.scripts.get(sessionId);
    if (previous) return previous;
    const job = this.protocol.protocolCommand("Page.addScriptToEvaluateOnNewDocument", { source: this.source() }, sessionId || undefined).then(result => {
      if (!record(result) || typeof result.identifier !== "string") throw new BrowserPromptError("UNSUPPORTED_SCOPE", "无法为后续文档安装 prompt 适配器");
      return result.identifier;
    });
    this.scripts.set(sessionId, job); return job;
  }

  private readonly onFrameLoaded = (): void => { void this.refresh().catch(() => {}); };

  async refresh(): Promise<void> {
    if (this.disposed || this.wc.isDestroyed() || !this.wc.getURL()) return;
    for (const frame of this.wc.mainFrame.framesInSubtree) {
      if (this.disposed || frame.isDestroyed() || frame.detached) continue;
      try { await frame.executeJavaScript(this.source()); }
      catch (error) { if (!frame.isDestroyed() && !frame.detached && !this.disposed) throw error; }
    }
  }

  private readonly handleNative = (info: unknown, callback: unknown): void => {
    if (!record(info) || info.dialogType !== "prompt") {
      for (const handler of this.originals) Reflect.apply(handler, this.wc, [info, callback]);
      return;
    }
    if (typeof callback !== "function") throw new BrowserPromptError("UNSUPPORTED_SCOPE", "Electron prompt 回调接口不匹配");
    const reply = (accepted: boolean, value: string): void => { callback(accepted, value); };
    if (this.disposed || this.wc.isDestroyed() || this.pending) { reply(false, ""); return; }
    const frame = this.wc.mainFrame.framesInSubtree.find(candidate => candidate === info.frame);
    if (!frame || frame.isDestroyed() || frame.detached || typeof info.messageText !== "string" || typeof info.defaultPromptText !== "string") { reply(false, ""); return; }
    const dialog: BrowserNativePrompt = { id: randomUUID(), type: "prompt", message: info.messageText, defaultPrompt: info.defaultPromptText,
      url: frame.url, frameId: `${frame.frameTreeNodeId}:${frame.frameToken}` };
    this.pending = { id: dialog.id, defaultPrompt: dialog.defaultPrompt, reply };
    this.onPrompt(dialog);
  };

  owns(id: string): boolean { return this.pending?.id === id; }
  answer(id: string, answer: DialogAnswer): void {
    const pending = this.pending;
    if (!pending || pending.id !== id) throw new BrowserPromptError("PAGE_UNAVAILABLE", "prompt 已关闭或不属于当前请求");
    this.pending = undefined;
    pending.reply(answer.action === "accept", answer.action === "accept" ? answer.promptText ?? pending.defaultPrompt : "");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.pending; this.pending = undefined; pending?.reply(false, "");
    this.unsubscribe?.(); this.unsubscribe = undefined;
    this.wc.off("did-frame-finish-load", this.onFrameLoaded);
    if (owners.get(this.wc) === this) {
      const emitter: NodeJS.EventEmitter = this.wc;
      owners.delete(this.wc); emitter.removeListener("-run-dialog", this.handleNative);
      for (const handler of this.originals) emitter.on("-run-dialog", handler);
    }
    for (const [sessionId, identifier] of this.scripts) void identifier.then(id => this.protocol.protocolCommand("Page.removeScriptToEvaluateOnNewDocument", { identifier: id }, sessionId || undefined)).catch(() => {});
    this.scripts.clear();
    if (!this.wc.isDestroyed()) for (const frame of this.wc.mainFrame.framesInSubtree) {
      if (frame.isDestroyed() || frame.detached) continue;
      void frame.executeJavaScript(`(() => {const state=window[${JSON.stringify(this.slot)}];if(!state)return;state.disposed=true;state.observer?.disconnect();document.removeEventListener('DOMContentLoaded',state.install);if(state.replacement&&window.prompt===state.replacement)window.prompt=state.original;delete window[${JSON.stringify(this.slot)}];})()`).catch(() => {});
    }
  }
}
