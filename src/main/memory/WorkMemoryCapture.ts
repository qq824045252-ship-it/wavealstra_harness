import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryService } from "./MemoryService";
import { botMemoryTextEligible } from "./BotMemorySource";
import { MEMORY_CONTENT_MAX_CHARS } from "../../shared/memory-kernel";
import { LOCAL_USER_ID } from "../../shared/bot-work";

/** Facts-only bridge into the existing Kernel. Never consumes execution/outbox events. */
export class WorkMemoryCapture {
  constructor(private readonly db: AppDatabase, private readonly memory: MemoryService) {}

  capture(workId: string): string | undefined {
    return this.db.connection.transaction(() => {
      const key = `work-summary:${workId}`;
      const receipt = this.db.connection.prepare("SELECT * FROM memory_capture_receipts WHERE source_key=?").get(key) as
        { memory_id: string; content_hash: string; suppressed: number } | undefined;
      if (receipt?.suppressed) return undefined;
      const existing = receipt ? this.memory.get(receipt.memory_id) : undefined;
      // A manual correction or unbinding transfers ownership away from this capture source.
      if (receipt && (!existing
        || createHash('sha256').update(existing.content).digest('hex') !== receipt.content_hash
        || !existing.scopes.some(scope => scope.scopeType === 'work' && scope.scopeId === workId))) {
        this.db.connection.prepare("UPDATE memory_capture_receipts SET suppressed=1,updated_at=? WHERE source_key=?").run(Date.now(), key);
        return undefined;
      }
      const work = this.db.connection.prepare(`SELECT title,progress_summary,lifecycle,mode,closure_conclusion,intent_revision,input_snapshot_id
        FROM works WHERE work_id=? AND user_id=?`).get(workId, LOCAL_USER_ID) as {
          title: string; progress_summary: string | null; lifecycle: string; mode: string; closure_conclusion: string | null;
          intent_revision: number; input_snapshot_id: string;
        } | undefined;
      if (!work) return undefined;
      // Never persist credential-bearing text, raw transcripts, tool arguments, or authorization JSON.
      const safe = (value: string | null): string => value && botMemoryTextEligible(value) ? value.slice(0, 1500) : "";
      const deliverables = this.db.connection.prepare(`SELECT deliverable_id,status,summary FROM work_deliverables
        WHERE work_id=? AND intent_revision=? AND input_snapshot_id=? AND status IN ('accepted','proposed') ORDER BY created_at,deliverable_id`)
        .all(workId, work.intent_revision, work.input_snapshot_id) as Array<{ deliverable_id: string; status: string; summary: string }>;
      const blockers = this.db.connection.prepare("SELECT reason FROM work_blockers WHERE work_id=? AND status='open' ORDER BY created_at,blocker_id")
        .all(workId) as Array<{ reason: string }>;
      const lines = [
        `事项：${safe(work.title) || '标题含私密内容，未收录'}`,
        `模式：${work.mode === 'watch' ? '持续追踪（单轮产出不代表结束）' : '一次性委托'}；状态：${work.lifecycle}；结论：${work.closure_conclusion ?? '尚未结案'}`,
        safe(work.progress_summary) && `事实进展：${safe(work.progress_summary)}`,
        ...deliverables.map(d => {
          const evidenceCount = this.db.connection.prepare(`SELECT COUNT(*) AS n FROM work_evidence e
            WHERE e.work_id=? AND e.input_snapshot_id=? AND e.intent_revision=? AND EXISTS
            (SELECT 1 FROM work_deliverables d,json_each(d.evidence_refs_json) r WHERE d.deliverable_id=? AND r.value=e.evidence_id)`)
            .get(workId, work.input_snapshot_id, work.intent_revision, d.deliverable_id) as { n: number };
          return safe(d.summary) ? `${d.status === 'accepted' ? `已采纳（关联有效证据 ${evidenceCount.n} 条，不代表整个事项完成）` : '待核验成果（非已验证事实）'}：${safe(d.summary)}` : '';
        }),
        ...blockers.map(b => safe(b.reason) ? `未决事项：${safe(b.reason)}` : ''),
      ].filter(Boolean);
      const content = lines.join('\n').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MEMORY_CONTENT_MAX_CHARS);
      const hash = createHash('sha256').update(content).digest('hex');
      if (receipt?.content_hash === hash) return receipt.memory_id;
      const record = receipt ? this.memory.update({ id: receipt.memory_id, content, changedBy: 'event', changeReason: 'Work facts refreshed' })
        : this.memory.create({ kind: 'progress', title: 'Work 事实与未决事项', content, scopeType: 'work', scopeId: workId,
          sourceType: 'event', confidence: 1, metadata: { captureSource: key, factualSnapshot: true } });
      this.db.connection.prepare(`INSERT INTO memory_capture_receipts(source_key,memory_id,content_hash,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(source_key) DO UPDATE SET content_hash=excluded.content_hash,updated_at=excluded.updated_at`)
        .run(key, record.id, createHash('sha256').update(record.content).digest('hex'), Date.now());
      return record.id;
    })();
  }
}
