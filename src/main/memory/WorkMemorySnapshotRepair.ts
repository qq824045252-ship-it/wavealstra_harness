import type { AppDatabase } from '../db/AppDatabase';
import type { MemoryService } from './MemoryService';
import { resolveWorkMemoryScope } from './AssistantMemoryScopes';

/** Repair only a provable automatic-candidate takeover, never a user edit/delete/unbind. */
export function repairWorkMemorySnapshot(db: AppDatabase, memory: MemoryService, workId: string, memoryId: string): boolean {
  const record = memory.get(memoryId);
  if (!record || record.status !== 'active' || record.metadata.factualSnapshot !== true
    || record.metadata.captureSource !== `work-summary:${workId}`
    || record.scopes.length !== 1 || record.scopes[0].scopeType !== 'work' || record.scopes[0].scopeId !== workId) return false;
  const revisions = db.connection.prepare('SELECT revision,changed_by,change_reason,content,title FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC').all(memoryId) as Array<{revision:number;changed_by:string;change_reason:string;content:string;title:string}>;
  const lastEvent = revisions.findIndex(row => row.changed_by === 'event');
  if (lastEvent <= 0) return false;
  for (const row of revisions.slice(0, lastEvent)) {
    const candidateId = /^candidate:(.+)$/.exec(row.change_reason)?.[1];
    if (!candidateId) return false;
    const candidate = db.connection.prepare('SELECT task_id,status,resolved_memory_id FROM memory_candidates WHERE id=?').get(candidateId) as {task_id:string;status:string;resolved_memory_id:string} | undefined;
    if (!candidate || candidate.status !== 'committed' || candidate.resolved_memory_id !== memoryId
      || resolveWorkMemoryScope(db, candidate.task_id)?.work_id !== workId) return false;
  }
  // Preserve the audit trail. Capture immediately replaces this old event text with current facts.
  memory.update({id:memoryId,title:revisions[lastEvent].title,content:revisions[lastEvent].content,changedBy:'event',changeReason:'Repair verified automatic candidate overwrite'});
  db.connection.prepare("UPDATE memory_records SET source_type='event',source_id=NULL,source_task_id=NULL WHERE id=?").run(memoryId);
  db.connection.prepare("UPDATE memory_capture_receipts SET suppressed=0,content_hash='',updated_at=? WHERE memory_id=? AND source_key=?").run(Date.now(),memoryId,`work-summary:${workId}`);
  return true;
}
