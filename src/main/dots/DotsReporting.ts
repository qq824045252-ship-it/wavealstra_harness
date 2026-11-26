import type Database from "better-sqlite3";
import { DOTS_NO_CHANGE, type DotsAssistantReply, type DotsLiveReport } from "../../shared/dots";
import type { DotsAppendOutcome } from "../agent/durable/DurableDotsReply";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import type { AppendDotsReply } from "./DotsReplyOutbox";

type Generate = (prompt: string, signal: AbortSignal, onText: (text: string) => void) => Promise<string>;
const pending = { status: "pending" } as const;
const discarded = { status: "discarded" } as const;
type ReportingNative = Pick<RuntimeAuditReader, "batch4aWrite" | "supervised">;

/** One lower-priority reporting stream. Worker runs and the native Dots conversation stay independent. */
export class DotsReporting {
  private active?: AbortController;
  private foreground = 0;
  private readonly waiting = new Map<string, () => boolean>();
  private draft: DotsLiveReport | null = null;
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingTexts = new Map<string, string>();

  constructor(private readonly db: Database.Database, private readonly busy: () => boolean,
    private readonly generate: Generate, private readonly write: AppendDotsReply,
    private readonly notify: (report: DotsLiveReport | null) => void,
    private readonly native?: ReportingNative) {
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS dots_report_text (
        delivery_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL, text TEXT NOT NULL
      ); CREATE INDEX IF NOT EXISTS dots_report_operation ON dots_report_text(operation_id)`);
    }
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.native?.supervised);
  }

  flushWrites(): Promise<void> {
    return this.writeTail;
  }

  snapshot(): DotsLiveReport | null { return this.draft; }

  beginForeground(): () => void {
    this.foreground++;
    this.active?.abort();
    this.publish(null);
    return () => { this.foreground--; };
  }

  private publish(draft: DotsLiveReport | null) {
    if (!draft && !this.draft) return;
    this.draft = draft;
    this.notify(draft);
  }

  async append(reply: DotsAssistantReply, current: () => boolean): Promise<DotsAppendOutcome> {
    const plan = this.db.prepare(`SELECT json_extract(plan,'$.goal') AS goal,
      json_extract(plan,'$.deliveryInstruction') AS format FROM dots_followup_plans WHERE operation_id=?`)
      .get(reply.operationId) as { goal?: string; format?: string } | undefined;
    const prose = reply.kind === "conclusion" && reply.text.trim() && !reply.completion && !reply.citations?.length
      && !plan?.format && !/^\s*(?:[\[{\x60"<]|(?:true|false|null|[+-]?[\d.]+%?)\s*$)/u.test(reply.text);
    if (reply.presentation !== "report" && !prose) return this.active ? pending : this.write(reply, current);

    for (const [key, valid] of this.waiting) if (!valid()) this.waiting.delete(key);
    if (!current()) return discarded;
    const saved = this.pendingTexts.has(reply.deliveryKey)
      ? { text: this.pendingTexts.get(reply.deliveryKey)! }
      : this.db.prepare("SELECT text FROM dots_report_text WHERE delivery_key=?").get(reply.deliveryKey) as
        { text: string } | undefined;
    if (!saved && reply.kind === "progress" && this.db.prepare(`SELECT 1 FROM dots_reply_events old
      JOIN dots_reply_events newer ON newer.operation_id=old.operation_id AND newer.rowid>old.rowid
      WHERE old.event_key=? AND newer.status='sample' AND newer.settled=0 LIMIT 1`).get(reply.deliveryKey)) {
      this.waiting.delete(reply.deliveryKey);
      return discarded;
    }
    this.waiting.set(reply.deliveryKey, current);
    if (this.active || this.foreground || this.busy() || this.waiting.keys().next().value !== reply.deliveryKey) return pending;

    const controller = new AbortController();
    this.active = controller;
    const available = () => current() && !controller.signal.aborted && !this.foreground && !this.busy();
    const show = (body: string) => {
      if (!available() || body === this.draft?.text || (body && DOTS_NO_CHANGE.startsWith(body.trim()))) return;
      this.publish({ deliveryKey: reply.deliveryKey, operationId: reply.operationId, title: reply.title,
        taskId: reply.taskId, sourceMessageId: reply.sourceMessageId, kind: reply.kind, origin: reply.origin, text: body });
    };
    try {
      let body = saved?.text;
      if (body === undefined) {
        let previous: string | undefined;
        for (const text of this.pendingTexts.values()) {
          if (text) previous = text;
        }
        if (previous === undefined) {
          previous = this.db.prepare(`SELECT text FROM dots_report_text
            WHERE operation_id=? AND text<>'' ORDER BY rowid DESC LIMIT 1`).pluck().get(reply.operationId) as string | undefined;
        }
        show("");
        try {
          body = (await this.generate(JSON.stringify({ kind: reply.kind, assignment: plan?.goal ?? reply.title,
            evidence: reply.text, previous }), controller.signal, show)).trim();
        } catch (error) {
          if (!available()) return pending;
          console.warn("[Dots] 回报生成失败", reply.operationId, error);
          body = reply.text;
        }
        if (!available()) return pending;
        if (!body || body === DOTS_NO_CHANGE) body = reply.text;
        if (this.requiresRustWrites) {
          const batch4a = this.native?.batch4aWrite;
          if (!batch4a) throw new Error("只读模式下缺少 Dots 回报文本 Rust 写入通道");
          this.pendingTexts.set(reply.deliveryKey, body);
          this.pendingWriteCount += 1;
          this.writeTail = this.writeTail.then(() => batch4a.call(this.native, {
            kind: "dotsReportSaveText",
            deliveryKey: reply.deliveryKey,
            operationId: reply.operationId,
            body,
          })).then(() => undefined, error => {
            console.warn("[DotsReporting] saveText failed", error);
          }).finally(() => {
            this.pendingWriteCount -= 1;
            if (this.pendingWriteCount === 0) this.pendingTexts.clear();
          });
        } else {
          this.db.prepare("INSERT OR IGNORE INTO dots_report_text VALUES(?,?,?)").run(reply.deliveryKey, reply.operationId, body);
        }
      }
      if (!body) return discarded;
      show(body);
      if (!available()) return pending;
      const result = await this.write({ ...reply, presentation: "report", text: body }, available);
      return result.status === "discarded" && current() && !available() ? pending : result;
    } finally {
      this.active = undefined;
      this.waiting.delete(reply.deliveryKey);
      this.publish(null);
    }
  }
}
