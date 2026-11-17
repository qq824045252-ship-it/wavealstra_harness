import { randomUUID } from "node:crypto";
import type { AutomationScope } from "../AutomationScope";
import type { BrowserDocumentContext } from "./BrowserDocumentContext";
import type { BrowserPageProtocol } from "./BrowserPageEvents";
import { withBrowserDom } from "./BrowserDom";
import type { BrowserUploadFile, BrowserUploadResult } from "./BrowserUploads";

type AXState = string | boolean | number;
export interface BrowserAXNode {
  documentId: string;
  nodeId: string;
  parentId?: string;
  backendNodeId?: number;
  role: string;
  name: string;
  description?: string;
  ignored: boolean;
  truncated?: boolean;
  states: Record<string, AXState>;
}
export interface BrowserAXSnapshot {
  frameId: string;
  documentId: string;
  nodes: BrowserAXNode[];
  truncated: boolean;
  coverage: { names: "chromium-accessibility"; actionableRefs: "excluded"; childFrames: "excluded" };
}
export class BrowserAccessibilityError extends Error {
  constructor(readonly code: "SURFACE_CHANGED" | "PAGE_UNAVAILABLE" | "UNSUPPORTED_SCOPE" | "READ_LIMIT", message: string) {
    super(message); this.name = "BrowserAccessibilityError";
  }
}

interface RuntimeContext { id: number; frameId: string; sessionId: string; generation: number }
interface ChildSession { parentId?: string; ready: Promise<void> }
interface SnapshotOptions { maxNodes?: number; maxChars?: number; maxDepth?: number; includeIgnored?: boolean }

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
function string(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function positiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function axValue(value: unknown): unknown { return record(value) ? value.value : undefined; }
function limited(value: unknown, limit: number): string { return typeof value === "string" ? value.slice(0, limit) : ""; }
const states = new Set(["disabled", "editable", "focused", "multiline", "multiselectable", "readonly", "required", "checked", "expanded", "selected", "level", "modal", "invalid", "orientation", "autocomplete", "hasPopup", "busy"]);

function parseNode(value: unknown, documentId: string): BrowserAXNode {
  if (!record(value) || typeof value.nodeId !== "string" || typeof value.ignored !== "boolean") {
    throw new BrowserAccessibilityError("UNSUPPORTED_SCOPE", "Chromium 返回了无效的 AX 节点");
  }
  const properties: Record<string, AXState> = {};
  let truncated = [axValue(value.role), axValue(value.name), axValue(value.description)].some((text, index) => typeof text === "string" && text.length > (index === 0 ? 100 : 1000));
  if (Array.isArray(value.properties)) for (const property of value.properties) {
    if (!record(property) || typeof property.name !== "string" || !states.has(property.name)) continue;
    const state = axValue(property.value);
    if (typeof state === "string") { properties[property.name] = state.slice(0, 200); truncated ||= state.length > 200; }
    else if (typeof state === "boolean" || typeof state === "number" && Number.isFinite(state)) properties[property.name] = state;
  }
  return {
    documentId, nodeId: value.nodeId, ...(typeof value.parentId === "string" ? { parentId: value.parentId } : {}),
    ...(positiveInteger(value.backendDOMNodeId) ? { backendNodeId: value.backendDOMNodeId } : {}),
    role: limited(axValue(value.role), 100), name: limited(axValue(value.name), 1000),
    ...(typeof axValue(value.description) === "string" ? { description: limited(axValue(value.description), 1000) } : {}),
    ignored: value.ignored, states: properties, ...(truncated ? { truncated: true } : {}),
  };
}

/** One observer of the existing inspection connection. It never attaches another
 * debugger, selects tabs, or disables domains used by another consumer. */
export class BrowserAccessibility {
  private readonly contexts = new Map<string, RuntimeContext>();
  private readonly sessions = new Map<string, ChildSession>();
  private readonly observations = new Map<string, Set<number>>();
  private unsubscribe?: () => void;
  private disposed = false;
  private generation = 0;

  constructor(private readonly protocol: BrowserPageProtocol, private readonly observationSlot: string) {
    this.unsubscribe = protocol.subscribeProtocol(this.onEvent);
  }

  private check(context: BrowserDocumentContext, scope: AutomationScope): void {
    scope.check(); context.validate();
    if (this.disposed || !this.protocol.isAttached) throw new BrowserAccessibilityError("PAGE_UNAVAILABLE", "AX 检查会话已释放或断开");
  }

  private configure(sessionId: string, parentId?: string): Promise<void> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.ready;
    const ready = (async () => {
      for (const method of ["Runtime.enable", "Accessibility.enable", "Target.setAutoAttach"]) {
        if (this.disposed) return;
        await this.protocol.protocolCommand(method, method === "Target.setAutoAttach"
          ? { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } : {}, sessionId || undefined);
      }
    })();
    this.sessions.set(sessionId, { ready, parentId });
    // A child can disappear while being configured. Matching that exact child
    // later awaits ready and reports the failure; event callbacks never reject.
    void ready.catch(() => {});
    return ready;
  }

  private dropSession(sessionId: string): void {
    for (const [child, state] of this.sessions) if (state.parentId === sessionId) this.dropSession(child);
    this.sessions.delete(sessionId);
    for (const [key, context] of this.contexts) if (context.sessionId === sessionId) this.contexts.delete(key);
  }

  private onEvent = (method: string, params: unknown, sessionId = ""): void => {
    if (this.disposed) return;
    if (method === "Inspector.detached") { this.dispose(); return; }
    if (!record(params)) return;
    if (method === "Target.attachedToTarget" && typeof params.sessionId === "string" && record(params.targetInfo) && params.targetInfo.type === "iframe") {
      void this.configure(params.sessionId, sessionId); return;
    }
    if (method === "Target.detachedFromTarget" && typeof params.sessionId === "string") { this.dropSession(params.sessionId); return; }
    if (method === "Runtime.executionContextsCleared") {
      for (const [key, context] of this.contexts) if (context.sessionId === sessionId) this.contexts.delete(key);
      return;
    }
    if (method === "Runtime.executionContextDestroyed" && positiveInteger(params.executionContextId)) {
      this.contexts.delete(`${sessionId}:${params.executionContextId}`); return;
    }
    const context = params.context;
    if (method === "Runtime.executionContextCreated" && record(context) && positiveInteger(context.id)
      && record(context.auxData) && context.auxData.isDefault === true && typeof context.auxData.frameId === "string") {
      this.contexts.set(`${sessionId}:${context.id}`, { id: context.id, frameId: context.auxData.frameId, sessionId, generation: ++this.generation });
      if (!this.sessions.has(sessionId)) void this.configure(sessionId);
    }
  };

  private async matchingContext(context: BrowserDocumentContext, scope: AutomationScope): Promise<RuntimeContext> {
    this.check(context, scope);
    if (!this.unsubscribe) this.unsubscribe = this.protocol.subscribeProtocol(this.onEvent);
    await scope.run(() => this.configure(""));
    await context.evaluate("true");
    for (;;) {
      this.check(context, scope);
      const candidates = [...this.contexts.values()];
      const matches = await Promise.all(candidates.map(async candidate => {
        try {
          const response = await scope.run(() => this.protocol.protocolCommand("Runtime.evaluate", {
            expression: `window[${JSON.stringify(this.observationSlot)}]?.documentId`, contextId: candidate.id, returnByValue: true,
          }, candidate.sessionId || undefined));
          if (this.contexts.get(`${candidate.sessionId}:${candidate.id}`) !== candidate) return undefined;
          return record(response) && record(response.result) && response.result.value === context.identity.documentId ? candidate : undefined;
        } catch (error) {
          this.check(context, scope);
          if (this.contexts.get(`${candidate.sessionId}:${candidate.id}`) === candidate) throw error;
          return undefined;
        }
      }));
      this.check(context, scope);
      const exact = matches.filter(candidate => candidate !== undefined);
      if (exact.length > 1) throw new BrowserAccessibilityError("SURFACE_CHANGED", "文档身份对应多个 Runtime context，拒绝猜测");
      const match = exact[0];
      if (match) {
        const session = this.sessions.get(match.sessionId);
        if (!session) throw new BrowserAccessibilityError("SURFACE_CHANGED", "frame 检查会话已变化");
        await scope.run(() => session.ready);
        await context.evaluate("true");
        this.check(context, scope);
        if (this.contexts.get(`${match.sessionId}:${match.id}`) !== match) continue;
        return match;
      }
      await scope.run(() => new Promise<void>(resolve => setTimeout(resolve, 15)));
    }
  }

  async snapshot(context: BrowserDocumentContext, scope: AutomationScope, options: SnapshotOptions = {}): Promise<BrowserAXSnapshot> {
    const maxNodes = options.maxNodes ?? 200, maxChars = options.maxChars ?? 30000, maxDepth = options.maxDepth ?? 24;
    if (!positiveInteger(maxNodes) || maxNodes > 2000 || !positiveInteger(maxChars) || maxChars < 1000 || maxChars > 200000
      || !positiveInteger(maxDepth) || maxDepth > 100) throw new BrowserAccessibilityError("READ_LIMIT", "AX 输出预算无效");
    const mapped = await this.matchingContext(context, scope);
    const raw = await scope.run(() => this.protocol.protocolCommand("Accessibility.getFullAXTree", { frameId: mapped.frameId, depth: maxDepth }, mapped.sessionId || undefined));
    await context.evaluate("true"); this.check(context, scope);
    if (this.contexts.get(`${mapped.sessionId}:${mapped.id}`) !== mapped) throw new BrowserAccessibilityError("SURFACE_CHANGED", "AX 观察期间文档已变化");
    if (!record(raw) || !Array.isArray(raw.nodes)) throw new BrowserAccessibilityError("UNSUPPORTED_SCOPE", "Chromium 未返回 AX 树");
    const all = raw.nodes.map(node => parseNode(node, context.identity.documentId));
    const rawIds = new Set(all.map(node => node.nodeId));
    const depthLimited = raw.nodes.some(node => record(node) && Array.isArray(node.childIds) && node.childIds.some(child => typeof child === "string" && !rawIds.has(child)));
    const included = options.includeIgnored ? all : all.filter(node => !node.ignored);
    const result: BrowserAXSnapshot = {
      frameId: context.identity.frameId, documentId: context.identity.documentId, nodes: [], truncated: depthLimited || included.some(node => node.truncated),
      coverage: { names: "chromium-accessibility", actionableRefs: "excluded", childFrames: "excluded" },
    };
    let size = JSON.stringify(result).length;
    for (const node of included) {
      const next = JSON.stringify(node).length + 1;
      if (result.nodes.length >= maxNodes || size + next > maxChars) { result.truncated = true; break; }
      result.nodes.push(node); size += next;
    }
    this.observations.delete(context.identity.documentId);
    this.observations.set(context.identity.documentId, new Set(result.nodes.flatMap(node => node.backendNodeId === undefined ? [] : [node.backendNodeId])));
    while (this.observations.size > 32) {
      const oldest = this.observations.keys().next().value;
      if (oldest !== undefined) this.observations.delete(oldest);
    }
    return result;
  }

  /** Turn only a node from the returned snapshot into the UI engine's existing
   * observed-node selector. Backend IDs are never accepted without observation. */
  async resolveNodeRef(context: BrowserDocumentContext, node: Pick<BrowserAXNode, "documentId" | "backendNodeId">, scope: AutomationScope): Promise<{ selector: string; tag: string }> {
    this.check(context, scope);
    const backendNodeId = node.backendNodeId;
    if (node.documentId !== context.identity.documentId || !positiveInteger(backendNodeId) || !this.observations.get(context.identity.documentId)?.has(backendNodeId)) {
      throw new BrowserAccessibilityError("SURFACE_CHANGED", "AX 节点不属于当前返回的观察");
    }
    const mapped = await this.matchingContext(context, scope);
    const resolved = await scope.run(() => this.protocol.protocolCommand("DOM.resolveNode", { backendNodeId, executionContextId: mapped.id }, mapped.sessionId || undefined));
    const objectId = record(resolved) && record(resolved.object) ? string(resolved.object.objectId) : undefined;
    if (!objectId) throw new BrowserAccessibilityError("UNSUPPORTED_SCOPE", "AX 节点没有可操作的 DOM 元素");
    try {
      const response = await scope.run(() => this.protocol.protocolCommand("Runtime.callFunctionOn", {
        objectId, returnByValue: true,
        functionDeclaration: `function(slot,documentId,prefix){
          if(window[slot]?.documentId!==documentId||!(this instanceof Element)||this.ownerDocument!==document||!this.isConnected)throw new Error('MYBUDDY_AX_NODE_STALE');
          const refs=window.__mybuddyUiRefs||(window.__mybuddyUiRefs=new WeakMap());
          let ref=refs.get(this);
          if(!ref||this.getAttribute('data-mybuddy-ui-ref')!==ref){ref=prefix+'-'+(++window.__mybuddyUiRefCounter||(window.__mybuddyUiRefCounter=1));refs.set(this,ref);this.setAttribute('data-mybuddy-ui-ref',ref);}
          return {selector:'[data-mybuddy-ui-ref="'+CSS.escape(ref)+'"]',tag:this.localName};
        }`,
        arguments: [{ value: this.observationSlot }, { value: context.identity.documentId }, { value: randomUUID() }],
      }, mapped.sessionId || undefined));
      await context.evaluate("true"); this.check(context, scope);
      if (!record(response) || response.exceptionDetails || !record(response.result) || !record(response.result.value)
        || typeof response.result.value.selector !== "string" || typeof response.result.value.tag !== "string") {
        throw new BrowserAccessibilityError("SURFACE_CHANGED", "AX 节点已消失或不是当前文档中的元素");
      }
      return { selector: response.result.value.selector, tag: response.result.value.tag };
    } finally {
      void this.protocol.protocolCommand("Runtime.releaseObject", { objectId }, mapped.sessionId || undefined).catch(() => {});
    }
  }

  /** Paths must already be validated by uploadBrowserFiles against the task root. */
  async setFiles(context: BrowserDocumentContext, selector: string, files: readonly BrowserUploadFile[], scope: AutomationScope): Promise<BrowserUploadResult> {
    if (!selector || files.length < 1 || files.length > 20) throw new BrowserAccessibilityError("UNSUPPORTED_SCOPE", "上传目标或文件数量无效");
    const mapped = await this.matchingContext(context, scope);
    const response = await scope.run(() => this.protocol.protocolCommand("Runtime.evaluate", {
      expression: withBrowserDom(`(() => {
        const matches=__mbDom.all(${JSON.stringify(selector)});
        if(matches.length!==1)return null;
        const el=matches[0],ref=el.getAttribute('data-mybuddy-ui-ref');
        return ref&&window.__mybuddyUiRefs?.get(el)===ref?el:null;
      })()`), contextId: mapped.id, returnByValue: false,
    }, mapped.sessionId || undefined));
    this.check(context, scope);
    const objectId = record(response) && !response.exceptionDetails && record(response.result) ? string(response.result.objectId) : undefined;
    if (!objectId) throw new BrowserAccessibilityError("SURFACE_CHANGED", "上传目标不是当前文档中唯一的已观察节点");
    const inspect = async (): Promise<unknown> => this.protocol.protocolCommand("Runtime.callFunctionOn", {
      objectId, returnByValue: true,
      functionDeclaration: `function(slot,documentId,count){
        const ref=this.getAttribute?.('data-mybuddy-ui-ref');
        if(window[slot]?.documentId!==documentId||!(this instanceof HTMLInputElement)||this.ownerDocument!==document||!this.isConnected||this.type!=='file'||this.matches(':disabled')||!ref||window.__mybuddyUiRefs?.get(this)!==ref)return {ok:false};
        if(count>1&&!this.multiple)return {ok:false};
        return {ok:true,files:Array.from(this.files||[],f=>({name:f.name,size:f.size}))};
      }`,
      arguments: [{ value: this.observationSlot }, { value: context.identity.documentId }, { value: files.length }],
    }, mapped.sessionId || undefined);
    const getValue = (raw: unknown): Record<string, unknown> | undefined => record(raw) && !raw.exceptionDetails && record(raw.result) && record(raw.result.value) ? raw.result.value : undefined;
    try {
      const before = getValue(await scope.run(inspect));
      await context.evaluate("true"); this.check(context, scope);
      if (this.contexts.get(`${mapped.sessionId}:${mapped.id}`) !== mapped || before?.ok !== true) throw new BrowserAccessibilityError("SURFACE_CHANGED", "文件输入已变化、不可用或不允许多文件");
      await scope.run(() => {
        this.check(context, scope);
        if (this.contexts.get(`${mapped.sessionId}:${mapped.id}`) !== mapped) throw new BrowserAccessibilityError("SURFACE_CHANGED", "文件输入文档已变化");
        scope.dispatch();
        return this.protocol.protocolCommand("DOM.setFileInputFiles", { objectId, files: files.map(file => file.path) }, mapped.sessionId || undefined);
      });
      const after = getValue(await scope.run(inspect));
      await context.evaluate("true"); this.check(context, scope);
      if (this.contexts.get(`${mapped.sessionId}:${mapped.id}`) !== mapped || after?.ok !== true || !Array.isArray(after.files)
        || after.files.length !== files.length || after.files.some((item, index) => !record(item) || item.name !== files[index].name || item.size !== files[index].size)) {
        throw new BrowserAccessibilityError("SURFACE_CHANGED", "文件输入已派发但文件列表未能确认，请只读核对");
      }
      scope.confirmed = true;
      return { files: files.map(({ name, size }) => ({ name, size })) };
    } finally {
      void this.protocol.protocolCommand("Runtime.releaseObject", { objectId }, mapped.sessionId || undefined).catch(() => {});
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.unsubscribe?.(); this.unsubscribe = undefined;
    this.contexts.clear(); this.sessions.clear(); this.observations.clear();
    // Shared domain state and child attachments belong to the debugger owner.
  }
}
