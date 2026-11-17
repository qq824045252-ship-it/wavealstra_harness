import { randomUUID } from "node:crypto";
import type { WebContents, WebFrameMain } from "electron";
import { AutomationScope } from "../AutomationScope";
import { browserDocumentScript } from "../BrowserPageRead";

export interface BrowserFrameInfo {
  frameId: string;
  name: string;
  url: string;
  parentId?: string;
  main: boolean;
}

export class BrowserDocumentContextError extends Error {
  constructor(readonly code: "SURFACE_CHANGED" | "PAGE_UNAVAILABLE" | "UNSUPPORTED_SCOPE", message: string) {
    super(message);
    this.name = "BrowserDocumentContextError";
  }
}

interface Point { x: number; y: number }
interface DocumentBinding {
  frame: WebFrameMain;
  frameId: string;
  documentId: string;
  url: string;
  documentUrl: string;
  navigationEpoch: number;
}
interface FrameEdge { parent: DocumentBinding; child: DocumentBinding; ownerKey: string }

export interface BrowserDocumentContext {
  readonly identity: { frameId: string; documentId: string; url: string };
  readonly nativeFrame: WebFrameMain;
  evaluate(script: string): Promise<unknown>;
  validate(): void;
  prepare(): Promise<void>;
  mapPoint(point: Point): Promise<Point>;
  dispose(): void;
}

function id(frame: WebFrameMain): string {
  return `${frame.frameTreeNodeId}:${frame.frameToken}`;
}

export function listBrowserFrames(wc: WebContents): BrowserFrameInfo[] {
  if (wc.isDestroyed()) throw new BrowserDocumentContextError("PAGE_UNAVAILABLE", "浏览器标签已关闭");
  return wc.mainFrame.framesInSubtree.filter(frame => !frame.isDestroyed() && !frame.detached).map(frame => ({
    frameId: id(frame), name: frame.name, url: frame.url,
    ...(frame.parent ? { parentId: id(frame.parent) } : {}), main: frame === wc.mainFrame,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pointResult(value: unknown): Point {
  if (!isRecord(value) || typeof value.x !== "number" || !Number.isFinite(value.x)
    || typeof value.y !== "number" || !Number.isFinite(value.y)) {
    throw new BrowserDocumentContextError("UNSUPPORTED_SCOPE", "无法验证 frame 坐标映射");
  }
  return { x: value.x, y: value.y };
}

const changed = "MYBUDDY_DOCUMENT_CHANGED";
const unsupported = "MYBUDDY_FRAME_GEOMETRY_UNSUPPORTED";
const navigationStates = new WeakMap<WebContents, { frames: WeakMap<WebFrameMain, number>; unknown: number }>();

function navigationState(wc: WebContents): { frames: WeakMap<WebFrameMain, number>; unknown: number } {
  const existing = navigationStates.get(wc);
  if (existing) return existing;
  const state = { frames: new WeakMap<WebFrameMain, number>(), unknown: 0 };
  navigationStates.set(wc, state);
  // One lifecycle listener per WebContents, rather than per short-lived binding.
  // Native navigation invalidates synchronous guards even for same-URL reloads.
  wc.on("did-start-navigation", event => {
    if (event.frame) state.frames.set(event.frame, (state.frames.get(event.frame) ?? 0) + 1);
    else state.unknown++;
  });
  return state;
}

/** Bind the actual native frame and every ancestor document. A frame token alone
 * does not identify the document after same-URL navigation. */
export async function bindBrowserDocument(
  wc: WebContents, frameId: string | undefined, slot: string, scope: AutomationScope,
): Promise<BrowserDocumentContext> {
  scope.check();
  if (wc.isDestroyed()) throw new BrowserDocumentContextError("PAGE_UNAVAILABLE", "浏览器标签已关闭");
  const nativeFrame = frameId === undefined ? wc.mainFrame : wc.mainFrame.framesInSubtree.find(frame => id(frame) === frameId);
  if (!nativeFrame || nativeFrame.isDestroyed() || nativeFrame.detached) {
    throw new BrowserDocumentContextError("PAGE_UNAVAILABLE", "frame 已关闭或不属于当前标签");
  }
  const navigation = navigationState(wc), unknownNavigation = navigation.unknown;
  const bindings: DocumentBinding[] = [];
  for (let frame: WebFrameMain | null = nativeFrame; frame; frame = frame.parent) {
    const frameIdentity = id(frame), url = frame.url;
    const navigationEpoch = navigation.frames.get(frame) ?? 0;
    const raw = await scope.run(() => frame.executeJavaScript(`(() => ({ documentId: ${browserDocumentScript(slot)}, documentUrl: location.href }))()`));
    if (!isRecord(raw) || typeof raw.documentId !== "string" || typeof raw.documentUrl !== "string") {
      throw new BrowserDocumentContextError("SURFACE_CHANGED", "frame 文档未返回有效身份");
    }
    if (frame.isDestroyed() || frame.detached || id(frame) !== frameIdentity || frame.url !== url
      || (navigation.frames.get(frame) ?? 0) !== navigationEpoch || navigation.unknown !== unknownNavigation) {
      throw new BrowserDocumentContextError("SURFACE_CHANGED", "绑定期间 frame 文档已变化");
    }
    bindings.unshift({ frame, frameId: frameIdentity, url, documentId: raw.documentId, documentUrl: raw.documentUrl, navigationEpoch });
  }
  const document = bindings.at(-1);
  if (!document) throw new BrowserDocumentContextError("PAGE_UNAVAILABLE", "frame 不可用");
  let edges: FrameEdge[] | undefined;
  const ownedEntries: Array<{ parent: DocumentBinding; ownerKey: string }> = [];
  let disposed = false;

  const validate = (): void => {
    if (disposed) throw new BrowserDocumentContextError("SURFACE_CHANGED", "frame 操作上下文已释放");
    if (wc.isDestroyed()) throw new BrowserDocumentContextError("PAGE_UNAVAILABLE", "浏览器标签已关闭");
    const members = wc.mainFrame.framesInSubtree;
    for (const binding of bindings) {
      const frame = binding.frame;
      if (frame.isDestroyed() || frame.detached || !members.includes(frame) || id(frame) !== binding.frameId || frame.url !== binding.url
        || (navigation.frames.get(frame) ?? 0) !== binding.navigationEpoch || navigation.unknown !== unknownNavigation) {
        throw new BrowserDocumentContextError("SURFACE_CHANGED", "frame 或所属文档已变化，请重新观察");
      }
    }
    if (bindings[0]?.frame !== wc.mainFrame) throw new BrowserDocumentContextError("SURFACE_CHANGED", "frame 根文档已变化");
  };

  const evaluateIn = async (binding: DocumentBinding, script: string): Promise<unknown> => {
    scope.check(); validate();
    const guard = `if(window[${JSON.stringify(slot)}]?.documentId!==${JSON.stringify(binding.documentId)}||location.href!==${JSON.stringify(binding.documentUrl)})throw new Error(${JSON.stringify(changed)});`;
    try {
      const result = await scope.run(() => binding.frame.executeJavaScript(`(async () => {${guard}const result = await (${script});${guard}return result;})()`, true));
      validate(); scope.check();
      return result;
    } catch (error) {
      scope.check(); validate();
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(changed)) throw new BrowserDocumentContextError("SURFACE_CHANGED", "frame 文档或 owner 节点已替换");
      if (message.includes(unsupported)) throw new BrowserDocumentContextError("UNSUPPORTED_SCOPE", "frame 存在遮挡、不可见区域或无法验证的几何变换");
      throw error;
    }
  };

  // Parent JS records the exact iframe whose contentWindow sent this nonce.
  // No URL, name or sibling ordering participates in owner selection.
  const resolveOwners = async (): Promise<FrameEdge[]> => {
    if (edges) return edges;
    const resolved: FrameEdge[] = [];
    for (let index = 1; index < bindings.length; index++) {
      const parent = bindings[index - 1], child = bindings[index];
      const ownerKey = randomUUID();
      const key = JSON.stringify(ownerKey);
      ownedEntries.push({ parent, ownerKey });
      await evaluateIn(parent, `(() => {
        const state=window[${JSON.stringify(slot)}];
        const owners=state.frameOwners||(state.frameOwners=new Map());
        while(owners.size>=64){const first=owners.keys().next().value;owners.get(first)?.cleanup();owners.delete(first);}
        const entry={owner:null,unresolved:false,cleanup:()=>{}};
        const visit=root=>{const frames=[];for(const el of root.querySelectorAll('*')){if(el instanceof HTMLIFrameElement||el instanceof HTMLFrameElement)frames.push(el);if(el.shadowRoot)frames.push(...visit(el.shadowRoot));}return frames;};
        const listener=event=>{if(event.data?.mybuddyFrameOwner!==${key})return;
          const matches=visit(document).filter(el=>el.contentWindow===event.source);
          if(matches.length===1)entry.owner=matches[0];else entry.unresolved=true;
          entry.cleanup();
        };
        const timer=setTimeout(()=>{entry.cleanup();if(!entry.owner)owners.delete(${key});},${Math.max(1, scope.remaining)});
        entry.cleanup=()=>{clearTimeout(timer);window.removeEventListener('message',listener);};
        owners.set(${key},entry);window.addEventListener('message',listener);return true;
      })()`);
      try {
        await evaluateIn(child, `(() => {parent.postMessage({mybuddyFrameOwner:${key}},'*');return true;})()`);
        await evaluateIn(parent, `(async () => {
          const owners=window[${JSON.stringify(slot)}].frameOwners;
          while(!owners.get(${key})?.owner){if(owners.get(${key})?.unresolved)throw new Error(${JSON.stringify(unsupported)});if(Date.now()>=${scope.deadline})throw new Error(${JSON.stringify(changed)});await new Promise(resolve=>setTimeout(resolve,10));}
          return true;
        })()`);
      } finally {
        // Cleanup is intentionally independent of the cancelled operation scope.
        // It removes only this nonce's listener and cannot send input or navigate.
        if (!parent.frame.isDestroyed() && !parent.frame.detached) {
          void parent.frame.executeJavaScript(`window[${JSON.stringify(slot)}]?.frameOwners?.get(${key})?.cleanup()`).catch(() => {});
        }
      }
      resolved.push({ parent, child, ownerKey });
    }
    edges = resolved;
    return resolved;
  };

  const ownerScript = (edge: FrameEdge, body: string): string => `(() => {
    const owner=window[${JSON.stringify(slot)}].frameOwners?.get(${JSON.stringify(edge.ownerKey)})?.owner;
    if(!owner?.isConnected)throw new Error(${JSON.stringify(changed)});
    ${body}
  })()`;

  return {
    identity: { frameId: document.frameId, documentId: document.documentId, url: document.url }, nativeFrame,
    validate,
    evaluate: script => evaluateIn(document, script),
    prepare: async () => {
      for (const edge of await resolveOwners()) {
        await evaluateIn(edge.parent, ownerScript(edge, `owner.scrollIntoView({block:'center',inline:'center',behavior:'instant'});return true;`));
        await evaluateIn(edge.child, "true");
      }
      scope.check(); validate();
    },
    mapPoint: async point => {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new BrowserDocumentContextError("UNSUPPORTED_SCOPE", "frame 输入坐标无效");
      let mapped = point;
      const owners = await resolveOwners();
      for (const edge of [...owners].reverse()) {
        const viewport = await evaluateIn(edge.child, "({width:innerWidth,height:innerHeight})");
        if (!isRecord(viewport) || typeof viewport.width !== "number" || typeof viewport.height !== "number"
          || viewport.width <= 0 || viewport.height <= 0) throw new BrowserDocumentContextError("UNSUPPORTED_SCOPE", "frame 视口无效");
        const result = await evaluateIn(edge.parent, ownerScript(edge, `
          const fail=()=>{throw new Error(${JSON.stringify(unsupported)});};
          for(let el=owner;el;el=el.parentElement||(el.getRootNode() instanceof ShadowRoot?el.getRootNode().host:null)){
            const style=getComputedStyle(el);
            if(style.perspective!=='none'||(style.rotate!=='none'&&!/^0(?:deg|rad|turn)?$/.test(style.rotate)))fail();
            if(style.scale!=='none'&&style.scale.split(/\\s+/).some(value=>!Number.isFinite(Number(value))||Number(value)<=0))fail();
            if(style.transform!=='none'){const matrix=new DOMMatrixReadOnly(style.transform);if(!matrix.is2D||Math.abs(matrix.b)>1e-7||Math.abs(matrix.c)>1e-7||matrix.a<=0||matrix.d<=0)fail();}
          }
          if(!owner.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true}))fail();
          const rect=owner.getBoundingClientRect(),style=getComputedStyle(owner),number=value=>parseFloat(value)||0;
          const left=number(style.borderLeftWidth)+number(style.paddingLeft),right=number(style.borderRightWidth)+number(style.paddingRight);
          const top=number(style.borderTopWidth)+number(style.paddingTop),bottom=number(style.borderBottomWidth)+number(style.paddingBottom);
          const width=number(style.width)+(style.boxSizing==='border-box'?0:left+right);
          const height=number(style.height)+(style.boxSizing==='border-box'?0:top+bottom);
          if(width<=left+right||height<=top+bottom||rect.width<=0||rect.height<=0)fail();
          const local=${JSON.stringify(mapped)},viewport=${JSON.stringify(viewport)};
          if(local.x<0||local.y<0||local.x>=viewport.width||local.y>=viewport.height)fail();
          const x=rect.x+left*rect.width/width+local.x*(width-left-right)*rect.width/width/viewport.width;
          const y=rect.y+top*rect.height/height+local.y*(height-top-bottom)*rect.height/height/viewport.height;
          if(x<0||y<0||x>=innerWidth||y>=innerHeight)fail();
          let hit=document.elementFromPoint(x,y);
          while(hit?.shadowRoot){const inner=hit.shadowRoot.elementFromPoint(x,y);if(!inner||inner===hit)break;hit=inner;}
          if(hit!==owner)fail();return {x,y};
        `));
        mapped = pointResult(result);
      }
      await evaluateIn(document, "true");
      scope.check(); validate(); return mapped;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const { parent, ownerKey } of ownedEntries) {
        if (parent.frame.isDestroyed() || parent.frame.detached) continue;
        const key = JSON.stringify(ownerKey);
        void parent.frame.executeJavaScript(`(() => {const owners=window[${JSON.stringify(slot)}]?.frameOwners;owners?.get(${key})?.cleanup();owners?.delete(${key});})()`).catch(() => {});
      }
      ownedEntries.length = 0;
      edges = undefined;
    },
  };
}
