import { randomUUID } from "node:crypto";
import type { ConversationInteractionAnswer, ConversationInteractionRequest } from "../../../shared/conversation-interaction";

export interface BrowserHandoffIdentity {
  taskId: string;
  ownerId: string;
  tabId: string;
  webContentsId: number;
  documentId: string;
}

export interface BrowserHandoffRequest {
  identity: BrowserHandoffIdentity;
  requestKey: string;
  reason: "login" | "2fa";
  signal?: AbortSignal;
  /** Must use ConversationInteractionService, not a model-supplied answer. */
  ask: (request: ConversationInteractionRequest, durableKey: string, signal?: AbortSignal) => Promise<ConversationInteractionAnswer>;
  /** Re-read BrowserHost ownership and the retained WebContents. */
  inspectTab: () => BrowserHandoffIdentity | Promise<BrowserHandoffIdentity>;
}

export interface BrowserHandoffResume<T> {
  token: string;
  identity: Pick<BrowserHandoffIdentity, "taskId" | "ownerId" | "tabId" | "webContentsId">;
  signal?: AbortSignal;
  inspectTab: () => BrowserHandoffIdentity | Promise<BrowserHandoffIdentity>;
  /** Fresh read-only page condition. A prior user answer does not prove login. */
  verify: () => Promise<{ passed: boolean; documentId: string; evidence: T }>;
}

interface HandoffRecord {
  key: string;
  identity: BrowserHandoffIdentity;
  token: string;
  status: "ready" | "used" | "invalid";
  touched: number;
  busy: boolean;
}

function sameTab(a: BrowserHandoffIdentity, b: Pick<BrowserHandoffIdentity, "taskId" | "ownerId" | "tabId" | "webContentsId">): boolean {
  return a.taskId === b.taskId && a.ownerId === b.ownerId && a.tabId === b.tabId && a.webContentsId === b.webContentsId;
}

function validIdentity(identity: BrowserHandoffIdentity): boolean {
  return Boolean(identity.taskId && identity.ownerId && identity.tabId && identity.documentId)
    && Number.isSafeInteger(identity.webContentsId) && identity.webContentsId >= 0;
}

/** The token is issued only after a real user interaction resolves affirmatively. */
export class BrowserHandoff {
  private readonly records = new Map<string, HandoffRecord>();
  private readonly keys = new Map<string, string>();
  private readonly pendingKeys = new Set<string>();

  constructor(private readonly maxRecords = 64, private readonly ttlMs = 15 * 60_000) {}

  async begin(request: BrowserHandoffRequest): Promise<{ token: string; initialDocumentId: string }> {
    const { identity, requestKey, signal, ask, inspectTab } = request;
    if (!validIdentity(identity) || !requestKey.trim() || requestKey.length > 200) throw new Error("Invalid browser handoff identity");
    this.expire();
    signal?.throwIfAborted();
    const live = await inspectTab();
    if (!validIdentity(live) || !sameTab(identity, live) || live.documentId !== identity.documentId) {
      throw new Error("Browser handoff page changed before asking the user");
    }
    const durableKey = JSON.stringify(["browser-handoff", identity.taskId, identity.ownerId, identity.tabId,
      identity.webContentsId, identity.documentId, requestKey]);
    const existingToken = this.keys.get(durableKey);
    const existing = existingToken ? this.records.get(existingToken) : undefined;
    if (existing) {
      if (existing.status !== "ready") throw new Error("Browser handoff already used or invalidated");
      existing.touched = Date.now();
      return { token: existing.token, initialDocumentId: existing.identity.documentId };
    }
    if (this.pendingKeys.has(durableKey)) throw new Error("Browser handoff is already awaiting the user");
    if (this.records.size + this.pendingKeys.size >= this.maxRecords) throw new Error("Too many browser handoffs");
    this.pendingKeys.add(durableKey);
    try {
      const question: ConversationInteractionRequest = {
        kind: "confirm",
        title: request.reason === "2fa" ? "请在当前浏览器标签完成双重验证" : "请在当前浏览器标签完成登录",
        description: "完成后选择“已完成”。不要在此处填写密码或验证码；若未完成请选择“取消”。",
        options: [{ id: "yes", label: "已完成" }, { id: "no", label: "取消" }],
      };
      const answer = await ask(question, durableKey, signal);
      signal?.throwIfAborted();
      if (answer !== true) throw new Error("User did not complete the browser handoff");
      const current = await inspectTab();
      if (!validIdentity(current) || !sameTab(identity, current)) throw new Error("Browser handoff tab changed while awaiting the user");
      signal?.throwIfAborted();
      const token = randomUUID();
      this.records.set(token, { key: durableKey, identity: { ...identity }, token, status: "ready", touched: Date.now(), busy: false });
      this.keys.set(durableKey, token);
      return { token, initialDocumentId: identity.documentId };
    } finally {
      this.pendingKeys.delete(durableKey);
    }
  }

  async resume<T>(request: BrowserHandoffResume<T>): Promise<{ status: "confirmed" | "pending"; evidence: T; documentId: string }> {
    this.expire();
    request.signal?.throwIfAborted();
    const record = this.records.get(request.token);
    if (!record || record.status !== "ready" || record.busy) throw new Error("Browser handoff token is stale or already used");
    if (!sameTab(record.identity, request.identity)) throw new Error("Browser handoff belongs to another task or tab");
    record.busy = true;
    try {
      const before = await request.inspectTab();
      if (!validIdentity(before) || !sameTab(before, record.identity)) {
        record.status = "invalid";
        throw new Error("Browser handoff tab changed before resume");
      }
      request.signal?.throwIfAborted();
      const result = await request.verify();
      request.signal?.throwIfAborted();
      const after = await request.inspectTab();
      if (!validIdentity(after) || !sameTab(after, record.identity) || after.documentId !== result.documentId) {
        record.status = "invalid";
        throw new Error("Browser handoff tab changed during verification");
      }
      record.touched = Date.now();
      if (!result.passed) return { status: "pending", evidence: result.evidence, documentId: result.documentId };
      record.status = "used";
      return { status: "confirmed", evidence: result.evidence, documentId: result.documentId };
    } finally {
      record.busy = false;
    }
  }

  invalidateTab(identity: Pick<BrowserHandoffIdentity, "taskId" | "ownerId" | "tabId" | "webContentsId">): void {
    for (const record of this.records.values()) if (sameTab(record.identity, identity)) record.status = "invalid";
  }

  private expire(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, record] of this.records) if (!record.busy && record.touched < cutoff) {
      this.records.delete(token);
      this.keys.delete(record.key);
    }
  }
}
