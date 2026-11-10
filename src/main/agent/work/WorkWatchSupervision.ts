import type { WorkCompletionOptions } from "./WorkCompletionCoordinator";
import type { WorkResultDecision } from "./BotWorkResultTurn";
import { watchObservationDelivery, watchReadEvidence } from "./WorkWatchObservation";

/** A durable, independent owner review per observation. A round never closes the
 * standing commission, and reviewing a receipt never repeats its business effects. */
export class WorkWatchSupervision {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Set<string>();
  private closed = false;
  constructor(private readonly options: WorkCompletionOptions) {
    options.db.exec(`CREATE TABLE IF NOT EXISTS work_watch_reviews (
      binding_id TEXT PRIMARY KEY, context_json TEXT NOT NULL, decision_json TEXT,
      state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, error TEXT, reviewed_at INTEGER)`);
  }
  start(): void { if (this.timer) return; this.timer = setInterval(() => this.wake(), 1000); this.timer.unref(); this.wake(); }
  close(): void { this.closed = true; if (this.timer) clearInterval(this.timer); }
  wake(): void {
    if (this.closed || !this.options.isAuthority()) return;
    const rows = this.options.db.prepare(`WITH pending AS (SELECT b.binding_id,b.work_id,b.admitted_at,r.retry_at,
        ROW_NUMBER() OVER (PARTITION BY b.work_id ORDER BY b.admitted_at,b.rowid) ordinal FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id LEFT JOIN work_watch_reviews r ON r.binding_id=b.binding_id
      WHERE w.mode='watch' AND w.lifecycle IN ('active','paused','closing') AND b.bot_id=w.owner_bot_id
      AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id
      AND b.owner_epoch=w.owner_epoch AND b.invalidated_at IS NULL
      AND b.status IN ('completed','failed','stopped')
      AND (r.binding_id IS NULL OR r.state='queued')
      AND (r.binding_id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM bot_work_feedback f
        WHERE json_extract(f.metadata_json,'$.executionId')=b.binding_id
        AND json_extract(f.metadata_json,'$.kind')='result'))
      AND (b.status<>'completed' OR EXISTS (SELECT 1 FROM work_native_inbox n WHERE n.binding_id=b.binding_id AND n.consumed_at IS NOT NULL))
      ) SELECT binding_id,work_id,retry_at FROM pending WHERE ordinal=1
      ORDER BY COALESCE(retry_at,0),admitted_at LIMIT 128`).all() as Array<{binding_id:string;work_id:string;retry_at:number|null}>;
    const seen = new Set<string>();
    for (const row of rows) {
      if (this.active.size >= 2) break;
      if (seen.has(row.work_id)) continue;
      seen.add(row.work_id);
      if ((row.retry_at ?? 0) > Date.now() || [...this.active].some(id => this.options.works.repo.getBinding(id)?.workId === row.work_id)) continue;
      if (this.active.has(row.binding_id)) continue;
      this.active.add(row.binding_id);
      void this.process(row.binding_id).catch(error => {
        if (!this.closed && this.options.isAuthority()) this.recordFailure(row.binding_id,error);
        console.warn('[Work] 持续委托结果整理等待重试', error);
      })
        .finally(() => this.active.delete(row.binding_id));
    }
  }
  private recordFailure(id: string, error: unknown): void {
    const {db} = this.options;
    db.prepare(`INSERT INTO work_watch_reviews(binding_id,context_json,attempts,retry_at,error) VALUES (?,'{}',1,?,?)
      ON CONFLICT(binding_id) DO UPDATE SET attempts=attempts+1,retry_at=excluded.retry_at,error=excluded.error`)
      .run(id,Date.now()+15000,String(error));
    const row = db.prepare('SELECT attempts,decision_json FROM work_watch_reviews WHERE binding_id=?').get(id) as {attempts:number;decision_json:string|null};
    if (row.attempts < 2 || row.decision_json) return;
    const current = this.snapshot(id); if (!current) return;
    const raw = current.results.map(r=>r.summary).join('\n\n') || current.binding.settlementNote || '本轮没有可用结果正文';
    if (this.options.deliver({bindingId:id,eventId:`watch-supervision:${id}`,category:'result',text:raw,
      notices:['前台整理未完成，先交付原始结果；没有重跑本轮业务。',String(error)]}))
      db.prepare("UPDATE work_watch_reviews SET state='delivered',reviewed_at=? WHERE binding_id=?").run(Date.now(),id);
  }
  hasPending(workId: string): boolean {
    return Boolean(this.options.db.prepare(`SELECT 1 FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id LEFT JOIN work_watch_reviews r ON r.binding_id=b.binding_id
      WHERE b.work_id=? AND b.bot_id=w.owner_bot_id AND b.owner_epoch=w.owner_epoch
      AND b.intent_revision=w.intent_revision AND b.input_snapshot_id=w.input_snapshot_id AND b.invalidated_at IS NULL AND b.status IN ('completed','failed','stopped')
      AND (r.binding_id IS NULL OR r.state='queued')
      AND NOT EXISTS (SELECT 1 FROM bot_work_feedback f WHERE json_extract(f.metadata_json,'$.executionId')=b.binding_id
        AND json_extract(f.metadata_json,'$.kind')='result') LIMIT 1`).get(workId));
  }
  private snapshot(id: string) {
    const {works} = this.options;
    const binding = works.repo.getBinding(id);
    const work = binding && works.getWork(binding.workId);
    if (!binding || !work || work.mode !== 'watch' || !['active','paused','closing'].includes(work.lifecycle)
      || binding.invalidatedAt || binding.ownerEpoch !== work.ownerEpoch || binding.intentRevision !== work.intentRevision
      || binding.inputSnapshotId !== work.inputSnapshotId) return;
    const results = works.repo.listDeliverables(work.workId).filter(r => r.executionId === id && r.status !== 'superseded');
    const evidence = JSON.stringify(results.map(r => [r.deliverableId,r.summary,r.status,r.uncoveredScope,r.artifactRefs,r.isSpeculation,r.hasWriteConflicts]));
    return {binding,work,results,evidence};
  }
  private async process(id: string): Promise<void> {
    const {works,db} = this.options;
    const current = this.snapshot(id); if (!current) return;
    const {binding,work,results,evidence} = current;
    // Native receipt consumption and its aggregate result commit together.
    if (binding.status === 'completed' && !db.prepare('SELECT 1 FROM work_native_inbox WHERE binding_id=? AND consumed_at IS NOT NULL').get(id)) return;
    const allResults = works.repo.listDeliverables(work.workId);
    const position = allResults.findIndex(r => r.executionId === id);
    const prior = allResults.slice(0,position < 0 ? 0 : position).filter(r => r.executionId !== id && r.intentRevision === work.intentRevision
      && r.inputSnapshotId === work.inputSnapshotId && r.status !== 'superseded').slice(-3);
    const source = JSON.parse(works.repo.executionInput(binding));
    const {instructions:_instructions,teamAssignment:_assignment,...originalRequest} = source;
    const result = results.find(r => r.deliverableId === `result:${id}`);
    const presentation = result ? watchObservationDelivery(work,result,works.repo.listDeliverables(work.workId),
      item => watchReadEvidence(db,works.repo.getBinding(item.executionId),item)) : {silent:false,summary:binding.settlementNote || '本轮没有返回可用结果'};
    const context = {watchSupervision:true,originalRequest,title:work.title,goal:work.goalDescription,
      watchRule:work.watchRule,lifecycle:work.lifecycle,
      nextWakeAt:works.repo.listSubscriptions(work.workId).filter(s => !s.stoppedAt).map(s => s.nextWakeAt).filter(Boolean),
      observedAt:binding.settledAt, reviewAt:Date.now(), executionStatus:binding.status,
      results:results.map(r=>({summary:r.summary,artifactRefs:r.artifactRefs,uncoveredScope:r.uncoveredScope})),
      previousResults:prior.map(r=>({summary:r.summary,createdAt:r.createdAt})),
      observationSummary:presentation.summary, hostProvenUnchanged:presentation.silent,
      notificationMode:work.watchRule?.notificationMode ?? 'every_check',
      nextAction:work.lifecycle==='active' ? '按已保存的周期继续下一轮；本回合不执行工具、不改变周期、不自动结束长期职责' : work.lifecycle==='closing' ? '已停止新轮，整理末轮结果，说明正在收尾；不承诺下一轮' : '已暂停，只整理已发生的本轮观察，不承诺下一轮', evidence};
    db.prepare('INSERT OR IGNORE INTO work_watch_reviews(binding_id,context_json) VALUES (?,?)').run(id,JSON.stringify(context));
    db.prepare("UPDATE work_watch_reviews SET context_json=?,decision_json=NULL WHERE binding_id=? AND json_extract(context_json,'$.evidence')<>?").run(JSON.stringify(context),id,evidence);
    const row = db.prepare('SELECT * FROM work_watch_reviews WHERE binding_id=?').get(id) as {context_json:string;decision_json:string|null;attempts:number;error:string|null};
    const attempt = row.attempts > 0 && !row.error && !row.decision_json ? row.attempts : row.attempts+1;
    db.prepare('UPDATE work_watch_reviews SET attempts=?,error=NULL WHERE binding_id=?').run(attempt,id);
    let decision: WorkResultDecision;
    let error: string | undefined;
    try {
      decision = row.decision_json ? JSON.parse(row.decision_json) : await this.options.review({eventId:`watch-review:${id}:${attempt}`,botId:work.ownerBotId,context});
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      if (attempt < 2) {
        db.prepare('UPDATE work_watch_reviews SET retry_at=?,error=? WHERE binding_id=?').run(Date.now()+15000,error,id);
        return;
      }
      decision = {decision:'deliver',outcome:'unknown',missing:[],reply:`${presentation.summary}\n\n本轮前台整理失败，以上是原始观察；后续关注计划保持不变。`};
    }
    if (this.closed || !this.options.isAuthority()) return;
    const fresh = this.snapshot(id);
    if (!fresh) return;
    if (fresh.evidence !== evidence || fresh.work.lifecycle !== work.lifecycle) {
      db.prepare('UPDATE work_watch_reviews SET decision_json=NULL,attempts=0,error=NULL,retry_at=0 WHERE binding_id=?').run(id); return;
    }
    // Preserve the expensive model verdict independently of delivery retries.
    db.prepare('UPDATE work_watch_reviews SET decision_json=?,error=? WHERE binding_id=?').run(JSON.stringify(decision),error??null,id);
    works.transaction(()=>{
      const latest = this.snapshot(id); if (!latest) return;
      if (latest.evidence !== evidence || latest.work.lifecycle !== work.lifecycle) {
        db.prepare('UPDATE work_watch_reviews SET context_json=?,decision_json=NULL,retry_at=0 WHERE binding_id=?').run(JSON.stringify(context),id); return;
      }
      db.prepare('UPDATE work_watch_reviews SET decision_json=?,error=? WHERE binding_id=?').run(JSON.stringify(decision),error??null,id);
      // Silence only with host-verified unchanged evidence, never an LLM assertion.
      const silent = presentation.silent && decision.outcome === 'completed' && decision.decision !== 'ask' && !error;
      if (!silent && !this.options.deliver({bindingId:id,eventId:`watch-supervision:${id}`,text:decision.reply,category:'result',
        notices:[`本轮执行回执时间：${binding.settledAt ? new Date(binding.settledAt).toISOString() : '未记录'}（不是来源内容发布时间）`,...(error ? [`前台整理错误：${error}`] : []), work.lifecycle!=='active' ? '持续委托已暂停或正在结束，不会安排新检查。' : '本轮结束不结束持续委托，后续按已保存计划运行。']})) throw Error('持续委托结果尚未送达原会话');
      db.prepare('UPDATE work_watch_reviews SET state=?,reviewed_at=?,retry_at=0 WHERE binding_id=?').run(silent?'silent':'delivered',Date.now(),id);
    });
  }
}
