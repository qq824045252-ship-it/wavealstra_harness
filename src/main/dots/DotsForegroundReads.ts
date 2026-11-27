import type Database from "better-sqlite3";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy, type AnswerRule, type DotsSchedulingPolicy } from "../../shared/answer-routing";
import { DOTS_TASK_ID, type DotsReplyOrigin } from "../../shared/dots";
import type { AgentPromptRequest } from "../../shared/agent-ipc";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader } from "../platform/runtime-audit";

export type ForegroundRead = { source: string; description: string; characters: number; excerpt?: string };
type Limits = DotsSchedulingPolicy["foregroundReadLimits"];
type Turn = { policy: DotsSchedulingPolicy; calls: number; characters: number; exhausted: boolean; reads: ForegroundRead[] };
export type ForegroundInput = { id: string; text: string; entryId: number; createdAt?: number; attachments?: AgentPromptRequest["attachments"] };

type Handoff = { spaceId: string; targetTaskId?: string; priorOperationId?: string; text: string; inputs: readonly ForegroundInput[]; origin: DotsReplyOrigin };
type ForegroundNative = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised" | "readDotsForegroundData" | "writeDotsForegroundData">;
type ChargeOptions = { rule?: { id: string; revision: number }; relatedInputIds?: string[]; fixturePolicy?: DotsSchedulingPolicy };
export type DotsForegroundQuery = { kind: "state"; inputId: string } | { kind: "unlinked"; afterInputId?: string };
export type DotsForegroundCommand = { kind: "freeze" | "linked"; inputId: string }
  | { kind: "handoff"; inputId: string; candidate: Handoff }
  | { kind: "charge"; inputId: string; callId: string; source: string; description: string; text: string;
    rule?: ChargeOptions["rule"]; relatedInputIds?: string[] };

export class DotsForegroundUnavailable extends Error {}

export class DotsForegroundReads {
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingPolicies = new Map<string, { policy: string; exhausted: number }>();
  private readonly pendingHandoffs = new Map<string, { data: string; linked: number }>();
  private readonly pendingReads = new Map<string, Array<{ callId: string; read: ForegroundRead }>>();

  constructor(private readonly fixture: Database.Database | undefined, private readonly native?: ForegroundNative) {
    const db = fixture;
    if (db && !db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS dots_foreground_reads (
        input_id TEXT NOT NULL, call_id TEXT NOT NULL, source TEXT NOT NULL, description TEXT NOT NULL,
        characters INTEGER NOT NULL, PRIMARY KEY(input_id,call_id));
        CREATE TABLE IF NOT EXISTS dots_foreground_policies (
          input_id TEXT PRIMARY KEY, policy TEXT NOT NULL, exhausted INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS dots_foreground_handoffs (
          input_id TEXT PRIMARY KEY, data TEXT NOT NULL, linked INTEGER NOT NULL DEFAULT 0);`);
      const columns = db.prepare("PRAGMA table_info(dots_foreground_reads)").all() as { name: string }[];
      if (!columns.some(column => column.name === "excerpt"))
        db.exec("ALTER TABLE dots_foreground_reads ADD COLUMN excerpt TEXT");
    }
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new DotsForegroundUnavailable("Dots 本轮读取记录需要通过 Rust Core 读取");
    return this.fixture;
  }

  private get requiresRustWrites(): boolean {
    return !this.fixture || this.fixture.readonly || Boolean(this.native?.supervised);
  }

  flushWrites(): Promise<void> {
    return this.writeTail;
  }

  async readState(inputId: string): Promise<Turn> {
    if (this.fixture) return this.state(inputId);
    const reply = await this.native?.readDotsForegroundData<{ status: "ready"; state: Turn } | { status: "revoked" }>({ kind: "state", inputId });
    if (reply?.status !== "ready") throw new DotsForegroundUnavailable(reply?.status === "revoked" ? "本轮策略授权已撤销" : "Core 未确认本轮读取记录");
    return reply.state;
  }

  async freezeForInput(inputId: string): Promise<Turn> {
    if (this.fixture) return this.freeze(inputId);
    const reply = await this.writeCore<{ status: "ready"; state: Turn } | { status: "revoked" }>({ kind: "freeze", inputId });
    if (reply.status !== "ready") throw new DotsForegroundUnavailable("本轮策略授权已撤销");
    return reply.state;
  }

  async chargeRead(inputId: string, callId: string, source: string, description: string, text: string, options?: ChargeOptions) {
    if (this.fixture) return this.charge(inputId, callId, source, description, text, options?.fixturePolicy);
    const reply = await this.writeCore<{ status: "charged"; text: string; exhausted: boolean } | { status: "revoked" | "callReused" }>({
      kind: "charge", inputId, callId, source, description, text, rule: options?.rule, relatedInputIds: options?.relatedInputIds,
    });
    if (reply.status !== "charged") throw new DotsForegroundUnavailable(reply.status === "revoked" ? "本轮策略授权已撤销" : "本次读取标识已用于其他资料或版本");
    return { text: reply.text, exhausted: reply.exhausted };
  }

  async prepareHandoff(inputId: string, candidate: Handoff): Promise<Handoff> {
    if (this.fixture) return this.handoff(inputId, candidate);
    const reply = await this.writeCore<{ status: "prepared"; handoff: Handoff } | { status: "revoked" }>({ kind: "handoff", inputId, candidate });
    if (reply.status !== "prepared") throw new DotsForegroundUnavailable("本轮策略授权已撤销");
    return validateHandoff(reply.handoff, candidate);
  }

  async readUnlinked(): Promise<Handoff[]> {
    if (this.fixture) return this.unlinked();
    const rows: Handoff[] = [];
    let afterInputId: string | undefined;
    for (;;) {
      const page: { rows: Handoff[]; nextInputId: string | null } | undefined = await this.native?.readDotsForegroundData({ kind: "unlinked", afterInputId });
      if (!page || !Array.isArray(page.rows)) throw new DotsForegroundUnavailable("Core 未确认待移交的前台资料");
      rows.push(...page.rows);
      if (page.nextInputId === null) return rows;
      if (!page.nextInputId || page.nextInputId === afterInputId) throw new DotsForegroundUnavailable("Core 的前台移交分页位置无效");
      afterInputId = page.nextInputId;
    }
  }

  async markLinked(inputId: string): Promise<void> {
    if (this.fixture) { this.linked(inputId); return; }
    await this.writeCore({ kind: "linked", inputId });
  }

  private async writeCore<T>(command: DotsForegroundCommand): Promise<T> {
    const native = this.native;
    if (!native?.supervised) throw new DotsForegroundUnavailable("Dots 前台读取需要 Core");
    const write = () => native.writeDotsForegroundData<T>(command);
    const reply = await write().catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return write();
      throw error;
    });
    if (reply === undefined) throw new DotsForegroundUnavailable("Core 未确认本轮读取写入");
    return reply;
  }

  private enqueue(request: Record<string, unknown>, label: string): void {
    const batch4a = this.native?.batch4aWrite;
    if (!batch4a) throw new Error(`只读模式下缺少 Dots 前台读取 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => batch4a.call(this.native, request)).then(() => undefined, error => {
      console.warn(`[DotsForegroundReads] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) {
        this.pendingPolicies.clear();
        this.pendingHandoffs.clear();
        this.pendingReads.clear();
      }
    });
  }

  state(inputId: string): Turn {
    const snapshot = this.db.prepare(`SELECT t.snapshot,t.status,r.enabled FROM answer_rule_turns t
      LEFT JOIN answer_rules r ON r.id=t.rule_id WHERE t.task_id=? AND t.input_id=?`)
      .get(DOTS_TASK_ID, inputId) as { snapshot: string | null; status: string; enabled: number | null } | undefined;
    if (snapshot && (snapshot.status === "revoked" || snapshot.enabled !== 1))
      throw new DotsForegroundUnavailable("本轮策略授权已撤销");
    const saved = this.pendingPolicies.get(inputId)
      ?? (this.db.prepare("SELECT policy,exhausted FROM dots_foreground_policies WHERE input_id=?").get(inputId) as
        { policy: string; exhausted: number } | undefined);
    const fallback = this.db.prepare("SELECT config FROM answer_rules WHERE id=?").pluck().get(defaultAnswerRuleId) as string | undefined;
    const rule = snapshot?.snapshot ?? fallback;
    const policy = saved ? JSON.parse(saved.policy) as DotsSchedulingPolicy
      : (rule ? (JSON.parse(rule) as AnswerRule).policy : undefined) ?? defaultDotsSchedulingPolicy();
    const dbReads = this.db.prepare("SELECT call_id,source,description,characters,excerpt FROM dots_foreground_reads WHERE input_id=? ORDER BY rowid")
      .all(inputId) as Array<ForegroundRead & { call_id: string }>;
    const seenCallIds = new Set(dbReads.map(r => r.call_id));
    const reads: ForegroundRead[] = dbReads.map(({ call_id: _c, ...rest }) => rest);
    for (const pending of this.pendingReads.get(inputId) ?? []) {
      if (!seenCallIds.has(pending.callId)) {
        seenCallIds.add(pending.callId);
        reads.push(pending.read);
      }
    }
    const characters = reads.reduce((total, read) => total + read.characters, 0);
    const { calls, characters: maxCharacters } = policy.foregroundReadLimits;
    return { policy, calls: reads.length, characters, exhausted: Boolean(saved?.exhausted) || reads.length >= calls || characters >= maxCharacters, reads };
  }

  handoff(inputId: string, candidate: Handoff): Handoff {
    this.state(inputId);
    const candidateJson = JSON.stringify(candidate);
    let storedData: string | undefined;
    if (this.requiresRustWrites) {
      const pending = this.pendingHandoffs.get(inputId);
      if (pending) {
        storedData = pending.data;
      } else {
        const dbData = this.db.prepare("SELECT data FROM dots_foreground_handoffs WHERE input_id=?").pluck().get(inputId) as string | undefined;
        if (dbData !== undefined) {
          storedData = dbData;
        } else {
          this.pendingHandoffs.set(inputId, { data: candidateJson, linked: 0 });
          this.enqueue({ kind: "dotsForegroundHandoff", inputId, dataJson: candidateJson }, "handoff");
          storedData = candidateJson;
        }
      }
    } else {
      this.db.prepare("INSERT OR IGNORE INTO dots_foreground_handoffs(input_id,data) VALUES(?,?)")
        .run(inputId, candidateJson);
      storedData = this.db.prepare("SELECT data FROM dots_foreground_handoffs WHERE input_id=?")
        .pluck().get(inputId) as string;
    }
    return validateHandoff(JSON.parse(storedData) as Handoff, candidate);
  }

  unlinked(): Handoff[] {
    const rows = this.db.prepare("SELECT input_id, data FROM dots_foreground_handoffs WHERE linked=0").all() as Array<{ input_id: string; data: string }>;
    const byId = new Map(rows.map(r => [r.input_id, r.data]));
    for (const [id, pending] of this.pendingHandoffs) {
      if (pending.linked === 0) byId.set(id, pending.data);
      else byId.delete(id);
    }
    return [...byId.values()].map(value => JSON.parse(value) as Handoff);
  }

  linked(inputId: string) {
    if (this.requiresRustWrites) {
      const pending = this.pendingHandoffs.get(inputId);
      if (pending) this.pendingHandoffs.set(inputId, { ...pending, linked: 1 });
      else {
        const dbData = this.db.prepare("SELECT data FROM dots_foreground_handoffs WHERE input_id=?").pluck().get(inputId) as string | undefined;
        if (dbData) this.pendingHandoffs.set(inputId, { data: dbData, linked: 1 });
      }
      this.enqueue({ kind: "dotsForegroundLinked", inputId }, "linked");
      return;
    }
    this.db.prepare("UPDATE dots_foreground_handoffs SET linked=1 WHERE input_id=?").run(inputId);
  }

  freeze(inputId: string) {
    const state = this.state(inputId);
    const policyJson = JSON.stringify(state.policy);
    if (this.requiresRustWrites) {
      if (!this.pendingPolicies.has(inputId) && !this.db.prepare("SELECT 1 FROM dots_foreground_policies WHERE input_id=?").get(inputId)) {
        this.pendingPolicies.set(inputId, { policy: policyJson, exhausted: 0 });
      }
      this.enqueue({ kind: "dotsForegroundFreeze", inputId, policyJson }, "freeze");
      return state;
    }
    this.db.prepare("INSERT OR IGNORE INTO dots_foreground_policies(input_id,policy) VALUES(?,?)")
      .run(inputId, policyJson);
    return state;
  }

  /** The projection and its debit run in one synchronous transaction, including concurrent completions. */
  charge(inputId: string, callId: string, source: string, description: string, text: string, policy?: DotsSchedulingPolicy) {
    if (this.requiresRustWrites) {
      const state = this.state(inputId);
      const effective = policy ?? state.policy;
      const effectiveJson = JSON.stringify(effective);
      if (!this.pendingPolicies.has(inputId)) {
        const existingPolicy = this.db.prepare("SELECT policy,exhausted FROM dots_foreground_policies WHERE input_id=?").get(inputId) as { policy: string; exhausted: number } | undefined;
        this.pendingPolicies.set(inputId, existingPolicy ?? { policy: effectiveJson, exhausted: 0 });
      }
      const pendingList = this.pendingReads.get(inputId) ?? [];
      const existingPending = pendingList.find(r => r.callId === callId)?.read;
      const existingDb = existingPending ?? (this.db.prepare("SELECT characters FROM dots_foreground_reads WHERE input_id=? AND call_id=?")
        .get(inputId, callId) as { characters: number } | undefined);
      if (existingDb) return { text: text.slice(0, existingDb.characters), exhausted: state.exhausted || existingDb.characters < text.length };
      const limits: Limits = effective.foregroundReadLimits;
      const sources = new Set(state.reads.map(read => read.source));
      if (state.exhausted || (!sources.has(source) && sources.size >= limits.sources)) {
        const cur = this.pendingPolicies.get(inputId)!;
        this.pendingPolicies.set(inputId, { ...cur, exhausted: 1 });
        this.enqueue({
          kind: "dotsForegroundFreeze",
          inputId,
          policyJson: effectiveJson,
        }, "chargeFreeze");
        // Ensure exhausted flag is persisted too: reuse charge with empty? Add separate exhausted update or handle via freeze/charge:
        this.enqueue({
          kind: "dotsForegroundCharge",
          inputId,
          policyJson: effectiveJson,
          callId,
          source,
          description,
          characters: -1,
          excerpt: null,
          markExhausted: true,
        }, "chargeExhaustOnly");
        return { text: "", exhausted: true };
      }
      let prefix = text.slice(0, Math.max(0, limits.characters - state.characters));
      if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
      const excerpt = source.startsWith("file:") ? prefix : null;
      pendingList.push({ callId, read: { source, description, characters: prefix.length, ...(excerpt !== null ? { excerpt } : {}) } });
      this.pendingReads.set(inputId, pendingList);
      const exhausted = prefix.length < text.length || state.calls + 1 >= limits.calls ||
        state.characters + prefix.length >= limits.characters;
      if (exhausted) {
        const cur = this.pendingPolicies.get(inputId)!;
        this.pendingPolicies.set(inputId, { ...cur, exhausted: 1 });
      }
      this.enqueue({
        kind: "dotsForegroundCharge",
        inputId,
        policyJson: effectiveJson,
        callId,
        source,
        description,
        characters: prefix.length,
        excerpt,
        markExhausted: exhausted,
      }, "charge");
      return { text: prefix, exhausted };
    }
    return this.db.transaction(() => {
      const state = this.state(inputId);
      const effective = policy ?? state.policy;
      this.db.prepare("INSERT OR IGNORE INTO dots_foreground_policies(input_id,policy) VALUES(?,?)").run(inputId, JSON.stringify(effective));
      const limits: Limits = effective.foregroundReadLimits;
      const existing = this.db.prepare("SELECT characters FROM dots_foreground_reads WHERE input_id=? AND call_id=?")
        .get(inputId, callId) as { characters: number } | undefined;
      if (existing) return { text: text.slice(0, existing.characters), exhausted: state.exhausted || existing.characters < text.length };
      const sources = new Set(state.reads.map(read => read.source));
      const markExhausted = () => this.db.prepare("UPDATE dots_foreground_policies SET exhausted=1 WHERE input_id=?").run(inputId);
      if (state.exhausted || (!sources.has(source) && sources.size >= limits.sources)) {
        markExhausted();
        return { text: "", exhausted: true };
      }
      let prefix = text.slice(0, Math.max(0, limits.characters - state.characters));
      if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
      this.db.prepare("INSERT INTO dots_foreground_reads(input_id,call_id,source,description,characters,excerpt) VALUES(?,?,?,?,?,?)").run(inputId, callId, source, description, prefix.length, source.startsWith("file:") ? prefix : null);
      const exhausted = prefix.length < text.length || state.calls + 1 >= limits.calls ||
        state.characters + prefix.length >= limits.characters;
      if (exhausted) markExhausted();
      return { text: prefix, exhausted };
    }).immediate();
  }
}

function validateHandoff(stored: Handoff, candidate: Handoff): Handoff {
  if (stored.spaceId !== candidate.spaceId || stored.targetTaskId !== candidate.targetTaskId ||
      stored.priorOperationId !== candidate.priorOperationId || stored.origin.conversationId !== candidate.origin.conversationId ||
      stored.origin.entryId !== candidate.origin.entryId || stored.inputs.length !== candidate.inputs.length ||
      stored.inputs.some((input, index) => input.id !== candidate.inputs[index].id)) {
    throw new DotsForegroundUnavailable("本事项已准备过旧修订的移交。当前修订未自动派发。");
  }
  return stored;
}
