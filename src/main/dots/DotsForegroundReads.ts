import type Database from "better-sqlite3";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy, type AnswerRule, type DotsSchedulingPolicy } from "../../shared/answer-routing";
import { DOTS_TASK_ID, type DotsReplyOrigin } from "../../shared/dots";

export type ForegroundRead = { source: string; description: string; characters: number; excerpt?: string };
type Limits = DotsSchedulingPolicy["foregroundReadLimits"];
type Turn = { policy: DotsSchedulingPolicy; calls: number; characters: number; exhausted: boolean; reads: ForegroundRead[] };
export type ForegroundInput = { id: string; text: string; entryId: number; createdAt?: number };

type Handoff = { spaceId: string; targetTaskId?: string; priorOperationId?: string; text: string; inputs: readonly ForegroundInput[]; origin: DotsReplyOrigin };

export class DotsForegroundUnavailable extends Error {}

export class DotsForegroundReads {
  constructor(private readonly db: Database.Database) {
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

  state(inputId: string): Turn {
    const snapshot = this.db.prepare(`SELECT t.snapshot,t.status,r.enabled FROM answer_rule_turns t
      LEFT JOIN answer_rules r ON r.id=t.rule_id WHERE t.task_id=? AND t.input_id=?`)
      .get(DOTS_TASK_ID, inputId) as { snapshot: string | null; status: string; enabled: number | null } | undefined;
    if (snapshot && (snapshot.status === "revoked" || snapshot.enabled !== 1))
      throw new DotsForegroundUnavailable("本轮策略授权已撤销");
    const saved = this.db.prepare("SELECT policy,exhausted FROM dots_foreground_policies WHERE input_id=?").get(inputId) as
      { policy: string; exhausted: number } | undefined;
    const fallback = this.db.prepare("SELECT config FROM answer_rules WHERE id=?").pluck().get(defaultAnswerRuleId) as string | undefined;
    const rule = snapshot?.snapshot ?? fallback;
    const policy = saved ? JSON.parse(saved.policy) as DotsSchedulingPolicy
      : (rule ? (JSON.parse(rule) as AnswerRule).policy : undefined) ?? defaultDotsSchedulingPolicy();
    const reads = this.db.prepare("SELECT source,description,characters,excerpt FROM dots_foreground_reads WHERE input_id=? ORDER BY rowid")
      .all(inputId) as ForegroundRead[];
    const characters = reads.reduce((total, read) => total + read.characters, 0);
    const { calls, characters: maxCharacters } = policy.foregroundReadLimits;
    return { policy, calls: reads.length, characters, exhausted: Boolean(saved?.exhausted) || reads.length >= calls || characters >= maxCharacters, reads };
  }

  handoff(inputId: string, candidate: Handoff): Handoff {
    this.state(inputId);
    this.db.prepare("INSERT OR IGNORE INTO dots_foreground_handoffs(input_id,data) VALUES(?,?)")
      .run(inputId, JSON.stringify(candidate));
    const stored = JSON.parse(this.db.prepare("SELECT data FROM dots_foreground_handoffs WHERE input_id=?")
      .pluck().get(inputId) as string) as Handoff;
    if (stored.spaceId !== candidate.spaceId || stored.targetTaskId !== candidate.targetTaskId ||
        stored.priorOperationId !== candidate.priorOperationId || stored.inputs.length !== candidate.inputs.length || stored.inputs.some((input, index) => input.id !== candidate.inputs[index].id))
      throw new DotsForegroundUnavailable("本事项已准备过旧修订的移交。当前修订未自动派发。");
    return stored;
  }

  unlinked(): Handoff[] {
    return (this.db.prepare("SELECT data FROM dots_foreground_handoffs WHERE linked=0").pluck().all() as string[])
      .map(value => JSON.parse(value) as Handoff);
  }

  linked(inputId: string) {
    this.db.prepare("UPDATE dots_foreground_handoffs SET linked=1 WHERE input_id=?").run(inputId);
  }

  freeze(inputId: string) {
    const state = this.state(inputId);
    this.db.prepare("INSERT OR IGNORE INTO dots_foreground_policies(input_id,policy) VALUES(?,?)")
      .run(inputId, JSON.stringify(state.policy));
    return state;
  }

  /** The projection and its debit run in one synchronous transaction, including concurrent completions. */
  charge(inputId: string, callId: string, source: string, description: string, text: string, policy?: DotsSchedulingPolicy) {
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
