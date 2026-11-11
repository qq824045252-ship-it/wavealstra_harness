import { createHash } from "node:crypto";
import { constants, openSync, closeSync, fstatSync, readSync } from "node:fs";
import type Database from "better-sqlite3";
import type { CronJobDto } from "../../shared/agent-ipc";
import { type WorkFeedbackDto } from "../../shared/bot-conversation";
import { generatedArtifactSchema } from "../../shared/bot-work-phase3";

export const REMINDER_RESULT_LIMITS = { fileBytes: 4*1024*1024, totalBytes: 8*1024*1024, files: 20, refs: 64, registrations: 128, chunkBytes: 64*1024 } as const;

/** Bounded descriptor reads: never follow a final symlink or block opening a FIFO.
 * Fail closed when the runtime cannot enforce these flags. Counts consumed bytes
 * even on failed validation so corrupt files cannot multiply the IO budget. */
export function verifyReminderSnapshot(path: string, size: number, digest: string, budget: {bytes:number}): 'verified'|'budget'|'unreadable' {
  if (size>REMINDER_RESULT_LIMITS.fileBytes || size>budget.bytes) return 'budget';
  let fd:number|undefined;
  try {
    if (!constants.O_NOFOLLOW || !constants.O_NONBLOCK) return 'unreadable';
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=fstatSync(fd);
    if (!before.isFile() || before.size!==size) return 'unreadable';
    const hash=createHash('sha256'),chunk=Buffer.alloc(REMINDER_RESULT_LIMITS.chunkBytes);
    let offset=0;
    while(offset<size) {
      const count=readSync(fd,chunk,0,Math.min(chunk.length,size-offset),offset);
      if (!count) return 'unreadable';
      offset+=count;budget.bytes-=count;hash.update(chunk.subarray(0,count));
    }
    const after=fstatSync(fd);
    return after.size===before.size && after.mtimeMs===before.mtimeMs && after.ctimeMs===before.ctimeMs && hash.digest('hex')===digest ? 'verified':'unreadable';
  } catch { return 'unreadable'; }
  finally { if(fd!==undefined) closeSync(fd); }
}

type Target = NonNullable<CronJobDto["reminder"]>;
/** IDs and exact registered refs only. No model-supplied path is ever opened. */
export function reminderResultAccessible(db: Database.Database, target: Target): boolean {
  if (!target.result) return true;
  return !!db.prepare(`SELECT 1 FROM works w JOIN work_conversations t ON t.work_id=w.work_id
    JOIN bot_conversations c ON c.conversation_id=t.conversation_id AND c.user_id=w.user_id
    WHERE w.work_id=? AND w.user_id=? AND t.conversation_id=? AND t.channel_type='bot-delivery'
    AND ((? IS NULL AND c.team_id IS NULL AND w.owner_bot_id=? AND c.bot_id=?)
      OR (c.team_id=? AND EXISTS(SELECT 1 FROM work_team_ownership o WHERE o.work_id=w.work_id AND o.team_id=c.team_id)))
    AND NOT EXISTS(SELECT 1 FROM work_team_record_visibility v WHERE v.work_id=w.work_id AND (v.removed_at IS NOT NULL OR v.removal_requested_at IS NOT NULL))`)
    .get(target.result.workId,target.userId,target.conversationId,target.teamId??null,target.botId,target.botId,target.teamId??null);
}

/** Reuse only a current, settled result and registered immutable bytes.
 * Read at due time, then freeze the resolved payload in the reminder outbox. */
export function reminderResult(db: Database.Database, target: Target, eventId: string): { notice: string; feedback?: WorkFeedbackDto } {
  if (!target.result) return { notice: "" };
  if (!reminderResultAccessible(db,target)) return {notice:"关联成果已删除或不可访问；未重新执行。"};
  // A silent watch result need never have had a chat report. Use the latest
  // settled owner result, with exact binding/revision provenance, not chat text.
  const row = db.prepare(`SELECT d.work_id,d.execution_id,d.intent_revision,d.input_snapshot_id,d.status,substr(d.summary,1,32000) summary,w.title,
      json_array_length(d.artifact_refs_json) ref_count,
      (SELECT json_group_array(value) FROM (SELECT value FROM json_each(d.artifact_refs_json) LIMIT 64)) artifact_refs_json
      FROM work_deliverables d
    JOIN works w ON w.work_id=d.work_id JOIN work_execution_bindings b ON b.binding_id=d.execution_id
    WHERE w.work_id=? AND d.intent_revision=w.intent_revision AND d.input_snapshot_id=w.input_snapshot_id
      AND d.owner_epoch=w.owner_epoch AND d.producer_bot_id=w.owner_bot_id
      AND b.work_id=d.work_id AND b.bot_id=d.producer_bot_id AND b.intent_revision=d.intent_revision
      AND b.input_snapshot_id=d.input_snapshot_id AND b.owner_epoch=d.owner_epoch
      AND b.invalidated_at IS NULL AND b.status='completed' AND b.settled_at IS NOT NULL
      AND d.status IN ('proposed','accepted') AND d.is_speculation=0 AND d.has_write_conflicts=0
    ORDER BY b.admitted_at DESC,d.created_at DESC,d.rowid DESC LIMIT 1`).get(target.result.workId) as {
      work_id:string;execution_id:string;intent_revision:number;input_snapshot_id:string;title:string;
      summary:string;artifact_refs_json:string;ref_count:number;status:'proposed'|'accepted';
    }|undefined;
  if (!row) return {notice:"关联成果尚无当前可投递结果；未重新执行。"};
  const refs=JSON.parse(row.artifact_refs_json) as string[];
  const registered=db.prepare(`SELECT payload_json,COUNT(*) OVER() registration_count FROM work_generated_artifacts WHERE binding_id=?
    ORDER BY json_extract(payload_json,'$.sourceEntryId') DESC,json_extract(payload_json,'$.registeredAt') DESC,rowid DESC LIMIT 128`)
    .all(row.execution_id) as Array<{payload_json:string;registration_count:number}>;
  const artifacts=registered.map(row=>generatedArtifactSchema.parse(JSON.parse(row.payload_json)));
  // First honor exact requested versions inside this binding's referenced
  // registry, then collapse each output path to its newest eligible version.
  // Collapsing before selection would hide an explicitly requested snapshot.
  const eligible=artifacts.filter(a=>refs.some(ref=>ref===a.path || ref===a.snapshotPath)
    && (!target.result!.fileRefs?.length || target.result!.fileRefs.some(ref=>ref===a.path || ref===a.snapshotPath)))
    .sort((a,b)=>b.registeredAt-a.registeredAt || b.sourceEntryId-a.sourceEntryId);
  const byPath=new Map<string,(typeof artifacts)[number]>();
  for(const artifact of eligible) if(!byPath.has(artifact.path)) byPath.set(artifact.path,artifact);
  const source:WorkFeedbackDto={workId:row.work_id,eventId,kind:'result',category:'result',executionId:row.execution_id,
    intentRevision:row.intent_revision,inputSnapshotId:row.input_snapshot_id,
    report:{title:row.title,summary:row.summary,artifactRefs:refs,reviewStatus:row.status,current:true,notices:[],
      files:[...byPath.values()].map(a=>({ref:a.snapshotPath??a.path,name:a.path.split(/[\\/]/).pop()??a.path,openPath:a.snapshotPath}))}};
  const notices:string[]=[];
  if(row.ref_count>refs.length) notices.push(`成果引用数量超限：${row.ref_count-refs.length} 条引用未检查、未附加。`);
  const omittedRegistrations=(registered[0]?.registration_count??0)-registered.length;
  if(omittedRegistrations>0) notices.push(`登记数量超限：${omittedRegistrations} 条登记未检查，对应文件未附加。`);
  if (refs.some(ref=>!artifacts.some(a=>a.path===ref || a.snapshotPath===ref))) notices.push('部分成果引用尚无登记的不可变文件，未提供打开路径。');
  const selected=source.report!.files??[];
  const budget={bytes:REMINDER_RESULT_LIMITS.totalBytes as number};
  let budgetSkipped=0, unreadable=0;
  const files=selected.slice(0,REMINDER_RESULT_LIMITS.files).flatMap(file=>{
    const artifact=artifacts.find(a=>a.snapshotPath && a.snapshotPath===file.openPath && file.ref===a.snapshotPath);
    const status=artifact?.snapshotPath ? verifyReminderSnapshot(artifact.snapshotPath,artifact.sizeBytes,artifact.digest,budget) : 'unreadable';
    if(status==='verified') return [file];
    if(status==='budget') budgetSkipped++; else unreadable++;
    return [];
  });
  const countSkipped=Math.max(0,selected.length-REMINDER_RESULT_LIMITS.files);
  if(countSkipped) notices.push(`文件数量超限：${countSkipped} 个文件未检查、未附加（每次最多20个）。`);
  if(budgetSkipped) notices.push(`校验字节预算超限：${budgetSkipped} 个文件未检查、未附加（单文件4MiB，每次8MiB）。`);
  if(unreadable) notices.push(`${unreadable} 个文件已删除、不可读或快照校验失败，未附加。`);
  if (target.result.fileRefs?.some(ref=>!selected.some(file=>file.ref===ref || artifacts.some(a=>a.path===ref && a.snapshotPath===file.openPath)))) notices.push('部分指定文件尚无当前可投递成果。');
  return {notice:["以下是已有成果；未重新执行。",...notices].join('\n'),feedback:{...source,eventId,
    report:{...source.report!,files,artifactRefs:files.map(file=>file.ref),primaryArtifactRefs:files.map(file=>file.ref),notices:[...source.report!.notices,...notices]}}};
}
