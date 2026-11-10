import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { watchEndedByTime, watchTimeExpired } from "../src/shared/work-watch-expiry";
import { workStatus } from "../src/renderer/src/lib/botWorkspacePresentation";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkDto } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "watch-expiry-"));
let now = Date.now(); let db!: AppDatabase; let works!: WorkService; let delivered = false;
const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
function open() {
  db = new AppDatabase(join(root,"fixture.db"));
  const bots = new BotRegistry(db.connection);
  bots.registerBot({ botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, displayName: "expiry fixture", authorization: DESKTOP_USER_GRANTS });
  works = new WorkService(db.connection,{ bots, now: () => now });
  works.scheduler.setExpiryReviewGate(() => delivered);
}
let sequence=0;
function create(endsAt?: number) {
  const result = works.createWork(actor,{ operationId:`create-${++sequence}`,title:`expiry-${sequence}`,inputSnapshotId:`input-${sequence}`,
    workspacePath:root,mode:"watch",authorization:DESKTOP_USER_GRANTS,
    watchRule:{cronExpression:"* * * * *",timezone:"Asia/Shanghai",endsAt,stopConditionText:"任意语义条件不能被当作已经满足"} });
  assert(result.ok,JSON.stringify(result)); return result.work;
}
const guard = (w:WorkDto) => ({expectedStateVersion:w.stateVersion,expectedIntentRevision:w.intentRevision,expectedOwnerEpoch:w.ownerEpoch});
open();
try {
  const forever=create(); const due=create(now+60_000); const paused=create(now+60_000); const cancel=create(now+60_000);
  assert(works.pauseWork(actor,{operationId:"pause",workId:paused.workId,versionGuard:guard(paused)}).ok);
  assert(works.cancelWork(actor,{operationId:"cancel",workId:cancel.workId,versionGuard:guard(cancel)}).ok);
  now+=59_999; works.scheduler.tick(now); assert.equal(works.getWork(due.workId)!.lifecycle,"active");
  now++; works.scheduler.tick(now);
  for(const w of [due,paused]) {
    const ended=works.getWork(w.workId)!; assert(watchEndedByTime(ended)); assert.equal(ended.closureConclusion,undefined);
    assert.equal(workStatus(works.getProjection(w.workId)!).label,"到期结束");
    assert.equal(works.phase5.summary(LOCAL_USER_ID,w.workId)?.currentConclusion,"到期结束");
    assert(works.repo.listSubscriptions(w.workId).every(s=>s.stoppedAt!==undefined));
    assert(!works.cards.list(ended).some(c=>["closure_failed","closure_cancelled","closure_succeeded"].includes(c.kind)));
  }
  assert.equal(works.getWork(cancel.workId)!.closureConclusion,"cancelled");
  assert.equal(works.getWork(forever.workId)!.lifecycle,"active","descriptive stopConditionText never ends a watch");
  const feedback=new WorkConversationFeedback({db:db.connection,userId:LOCAL_USER_ID,works,isAuthority:()=>true});
  feedback.drain(due.workId);
  assert((db.connection.prepare("SELECT text FROM bot_messages WHERE text LIKE '%到期结束%' ").all() as unknown[]).length>0);
  const before=db.connection.prepare("SELECT COUNT(*) n FROM work_notifications WHERE work_id=?").get(due.workId);
  works.scheduler.tick(now); feedback.drain(due.workId);
  assert.deepEqual(db.connection.prepare("SELECT COUNT(*) n FROM work_notifications WHERE work_id=?").get(due.workId),before);
  const running=create(now+30_000);
  const dispatch=works.dispatchExecution(actor,{operationId:"running",workId:running.workId,botId:DEFAULT_BOT_ID,taskId:"expiry-task",
    durableStoreKey:"expiry-store",conversationId:"expiry-native",workspaceBinding:root,delegatedScope:["workspace:read"],versionGuard:guard(running)});
  assert(dispatch.ok,JSON.stringify(dispatch)); const binding=works.repo.listBindings(running.workId)[0]; assert(binding);
  now+=30_000; works.scheduler.tick(now);
  assert.equal(works.getWork(running.workId)!.lifecycle,"closing");
  assert(db.connection.prepare("SELECT 1 FROM work_events_outbox WHERE work_id=? AND event_type='work.execution.stop_requested'").get(running.workId));
  assert(works.reconcileExecution({kind:"system",reason:"fixture-native-stop"},{bindingId:binding.bindingId,outcome:"stopped",note:"normal native stop receipt",usageTokens:0}).ok);
  works.scheduler.tick(now); assert.equal(works.getWork(running.workId)!.lifecycle,"closing","wait for final foreground review");
  now-=60_000; // Durable termination survives a wall-clock rollback.
  delivered=true; works.scheduler.tick(now); assert(watchEndedByTime(works.getWork(running.workId)!));
  const offline=create(now+10_000); db.close(); now+=20_000; open(); works.scheduler.tick(now);
  assert(watchEndedByTime(works.getWork(offline.workId)!));
  const extended=create(now+10_000); const old=now+10_000;
  assert(works.amendWork(actor,{operationId:"extend",workId:extended.workId,watchRule:{...extended.watchRule,endsAt:now+60_000},versionGuard:guard(extended)}).ok);
  now=old; works.scheduler.tick(now); assert.equal(works.getWork(extended.workId)!.lifecycle,"active");
  const reminder=create(); works.repo.updateWork({...works.getWork(reminder.workId)!,deadlineAt:now-1});
  works.scheduler.tick(now); assert.equal(works.getWork(reminder.workId)!.lifecycle,"active","deadline is reminder not expiry");
  assert(watchTimeExpired({...reminder,watchRule:{...reminder.watchRule!,endsAt:Date.parse("2026-11-10T12:00:00+08:00")}},Date.parse("2026-11-10T04:00:00Z")));
  for(const endsAt of [NaN,Infinity,-1,now,8640000000000001]) {
    assert(!works.createWork(actor,{operationId:`invalid-${++sequence}`,title:"invalid",mode:"watch",watchRule:{endsAt}}).ok);
  }
  console.log("PASS watch expiry: absolute boundary, pause, restart, no fabricated semantic success, user cancellation priority, final review gate, neutral feedback, idempotence, extension, reminder separation");
} finally { db!.close(); rmSync(root,{recursive:true,force:true}); }
