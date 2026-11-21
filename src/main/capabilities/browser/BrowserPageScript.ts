import type { AutomationScope } from "../AutomationScope";
import { Script } from "node:vm";
import { randomUUID } from "node:crypto";
import type { BrowserEventReceipt } from "./BrowserEventSubscription";

// Keep page computation separate from the signed-in renderer. The snapshot
// contains DOM structure, visible text and control state, never the page runtime.
export function pageSnapshotScript(editSelector?: string): string { return `(() => {
  const root=document.documentElement.cloneNode(true);
  let editor;
  if (${Boolean(editSelector)}) {
    const selector=${JSON.stringify(editSelector ?? "")};
    const live=__mbDom.one(selector), mirror=root.querySelector(selector);
    if(!live || !mirror || !live.matches('textarea,input[type=text],input:not([type]),input[type=search]') || live.disabled || live.readOnly
      || !live.checkVisibility({visibilityProperty:true}) || /password|token|secret|pin|otp|one-time|验证码|密码/i.test([live.name,live.id,live.autocomplete,live.placeholder,live.getAttribute('aria-label')].join(' '))) throw Error('Select a visible ordinary text field in this document');
    if(live.value.length>100000)throw Error('Field exceeds editing budget');
    editor={before:live.value,marker:${JSON.stringify(randomUUID())}};
    mirror.setAttribute('data-mybuddy-edit',editor.marker);
  }
  root.querySelectorAll('script,style,noscript,iframe,frame,object,embed,link,base,meta,template,input[type=hidden]').forEach(el=>el.remove());
  const ordinary=new Set(['id','class','role','name','type','aria-label','aria-checked','checked','selected','disabled','colspan','rowspan','placeholder','hidden','open','inert','readonly','multiple','required','aria-hidden','aria-expanded','aria-selected','aria-disabled','data-testid','data-action','data-state','data-role']);
  const localPreview=location.protocol==='file:';
  for (const el of [root,...root.querySelectorAll('*')]) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name==='data-mybuddy-edit' && editor && attr.value===editor.marker)continue;
      if (ordinary.has(attr.name))continue;
      // Local HTML components commonly put both control identity and localized
      // labels in dataset. Keep their inert markup, excluding host references.
      if (localPreview && attr.name.startsWith('data-') && !attr.name.startsWith('data-mybuddy-'))continue;
      el.removeAttribute(attr.name);
    }
  }
  const html=root.outerHTML;
  if (html.length>2000000) throw Error('DOM snapshot exceeds 2M characters');
  return {html,editor};
})()`; }

export interface PageSnapshot { html: string; editor?: { before: string; marker: string }; event?: BrowserEventReceipt | null }
export class BrowserExpressionError extends Error {}

export async function evaluatePageSnapshot(snapshot: PageSnapshot, expression: string, scope: AutomationScope): Promise<{ value: unknown; edited?: string }> {
  const { BrowserWindow, session } = await import("electron");
  // Each data: document has a unique opaque origin. Reuse the offline partition
  // so repeated script calls do not allocate unbounded Chromium sessions.
  const isolated = session.fromPartition("mybuddy-offline-dom");
  const win = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true,
    nodeIntegration: false, contextIsolation: true, disableDialogs: true, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-frame-navigate", event => event.preventDefault());
  isolated.setPermissionRequestHandler((_wc, _permission, respond) => respond(false));
  isolated.setPermissionCheckHandler(() => false);
  const container = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; form-action \'none\'; base-uri \'none\'">';
  const bootstrap = "data:text/html," + encodeURIComponent(container);
  isolated.webRequest.onBeforeRequest((request, done) => done({ cancel: request.url !== bootstrap }));
  try {
    await scope.run(() => wc.loadURL(bootstrap));
    const source = `(async () => {
      const document = new DOMParser().parseFromString(${JSON.stringify(snapshot.html)}, 'text/html');
      const event = ${JSON.stringify(snapshot.event ?? null)};
      const editor = ${snapshot.editor ? `document.querySelector(${JSON.stringify('[data-mybuddy-edit="' + snapshot.editor.marker + '"]')})` : "null"};
      if (editor) editor.value=${JSON.stringify(snapshot.editor?.before ?? "")};
      try {
        const value = await (${expression}\n);
        const json = JSON.stringify({value:value ?? null,edited:editor?.value});
        if (json.length > 200100) throw Error('Script result exceeds budget');
        return {json};
      } catch (error) {
        return {scriptError:String(error).slice(0,1000)};
      }
    })()`;
    let result: { json: string } | { scriptError: string };
    try {
      result = await scope.run(() => wc.executeJavaScript(source));
    } catch (error) {
      // A parse error occurs before the renderer can return its tagged result.
      // Compile only the supplied expression to distinguish it from a lost renderer.
      scope.check();
      try { new Script(`(async () => (${expression}\n))`); }
      catch (syntax) { if (syntax instanceof SyntaxError) throw new BrowserExpressionError(syntax.message); }
      throw error;
    }
    if ("scriptError" in result) throw new BrowserExpressionError(result.scriptError);
    return JSON.parse(result.json);
  } finally { if (!win.isDestroyed()) win.destroy(); }
}

/** Use browser fetch semantics within the selected HTTP(S) document. */
export interface BrowserFetchRequest {
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";
  contentType?: "application/json" | "application/x-www-form-urlencoded" | "text/plain";
  body?: string;
}

export function pageFetchScript(target: string, maxBytes: number, timeoutMs: number, request: BrowserFetchRequest): string {
  return `(async () => {
    const url=new URL(${JSON.stringify(target)},location.href);
    if (!/^https?:$/.test(url.protocol)||url.username||url.password) throw Error('Invalid resource URL');
    const options=${JSON.stringify(request)};
    const sameOrigin=url.origin===location.origin;
    if(!sameOrigin && !['GET','HEAD'].includes(options.method))throw Error('Cross-origin fetch requires a public read');
    const response=await fetch(url,{method:options.method,body:options.body,
      headers:options.contentType?{'Content-Type':options.contentType}:undefined,
      mode:sameOrigin?'same-origin':'cors',redirect:'error',credentials:sameOrigin?'same-origin':'omit',signal:AbortSignal.timeout(${timeoutMs})});
    const contentType=response.headers.get('content-type')||'';
    if(!/^(text\\/|application\\/(?:[\\w.+-]*json|[\\w.+-]*xml|csv)\\b)/i.test(contentType) && response.body) {
      await response.body.cancel(); throw Error('Use download for binary responses');
    }
    const reader=response.body?.getReader(), decoder=new TextDecoder(); let body='',size=0, truncated=false;
    try { while(reader) {
      const {done,value}=await reader.read(); if(done) break;
      const available=${maxBytes}-size;
      body+=decoder.decode(value.subarray(0,available),{stream:true}); size+=Math.min(available,value.length);
      if(value.length>available){truncated=true;await reader.cancel();break;}
    }} finally {reader?.releaseLock()}
    return {status:response.status,ok:response.ok,contentType,body:body+decoder.decode(),truncated};
  })()`;
}
