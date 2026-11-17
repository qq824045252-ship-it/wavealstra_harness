import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotificationService } from "../src/main/notification/NotificationService";
import { NotificationRepository } from "../src/main/notification/NotificationRepository";
import { parseNotificationTarget, type NotificationDto } from "../src/shared/notification";
import { openHistoricalNotification } from "../src/renderer/src/lib/historicalNotification";
import type { BotWorkspaceRequestDto } from "../src/shared/bot-workspace-navigation";
import { activateWorkspaceRequest } from "../src/renderer/src/lib/workspace-request-selection";

const directory = mkdtempSync(join(tmpdir(), "notification-routing-"));
const filename = join(directory, "test.db");
let db = new Database(filename);
db.exec(`CREATE TABLE notifications(id TEXT PRIMARY KEY,type TEXT,level TEXT,title TEXT,body TEXT,source_type TEXT,source_id TEXT,task_id TEXT,project_id TEXT,workspace_id TEXT,dedupe_key TEXT UNIQUE,created_at INTEGER,read_at INTEGER,dismissed_at INTEGER);
CREATE TABLE bots(bot_id TEXT PRIMARY KEY);
CREATE TABLE bot_conversations(conversation_id TEXT PRIMARY KEY,bot_id TEXT,team_id TEXT);
CREATE TABLE works(work_id TEXT,owner_bot_id TEXT);
CREATE TABLE tasks(id TEXT); CREATE TABLE projects(id TEXT);
INSERT INTO bots VALUES ('b'); INSERT INTO bot_conversations VALUES ('old','b',NULL); INSERT INTO works VALUES('work','b');`);
const settings = { read: () => ({ notificationPreferences: { inAppEnabled: false, desktopEnabled: true, desktopBackgroundOnly: false } }) };
const service = () => new NotificationService({ connection: db } as any, settings as any);
let notifications = service();
let delivered: NotificationDto | undefined;
notifications.setDesktopDelivery(record => { delivered = record; });
const result = notifications.publish({ type: "reminder.due", level: "info", title: "original", sourceType: "automation", target: {kind: "botConversation",botId:"b",conversationId:"old"} });
assert.ok(result && delivered);
assert.equal(notifications.unreadCount(), 0, "desktop-only does not populate bell");
assert.equal(notifications.list().length, 0);
const id = result.id;
db.close(); db = new Database(filename); notifications = service();
assert.deepEqual(notifications.resolveActivation(id), {kind:"botConversation",botId:"b",conversationId:"old",teamId:undefined,messageId:undefined}, "reopened database retains exact target");
assert.equal(notifications.resolveActivation("unknown"), null);
db.prepare("DELETE FROM bot_conversations WHERE conversation_id='old'").run();
assert.equal(notifications.resolveActivation(id), null, "deleted target cannot open another conversation");
const repo = new NotificationRepository(db);
repo.saveActivation({...result, id:"expired",createdAt:0});
assert.equal(repo.resolveActivation("expired"),null);
assert.equal(parseNotificationTarget({kind:"botConversation",botId:"b",conversationId:""}),null);
assert.equal(parseNotificationTarget({kind:"url",url:"file:///private"}),null);
settings.read = () => ({notificationPreferences:{inAppEnabled:true,desktopEnabled:false,desktopBackgroundOnly:false}});
notifications = service();
const work = notifications.publish({type:"task.completed",level:"success",title:"work",sourceType:"task",target:{kind:"work",workId:"work"},dedupeKey:"one"});
assert.ok(work); assert.deepEqual(notifications.resolveActivation(work.id),{kind:"work",workId:"work"});
assert.equal(notifications.publish({type:"task.completed",level:"success",title:"work",sourceType:"task",dedupeKey:"one"}),null);
assert.equal(notifications.unreadCount(),1);
notifications.markRead(work.id); assert.equal(notifications.unreadCount(),0);
notifications.dismiss(work.id); assert.equal(notifications.list().length,0);
db.close(); rmSync(directory,{recursive:true,force:true});

// Production store actions route retired Bot notifications into exact read-only
// workspace history, without creating an ordinary Task or reviving Bot mode.
(globalThis as any).localStorage = {getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const events: any[] = [];
(globalThis as any).window = { dispatchEvent: (event: any) => { events.push(event); return true; } };
const { selectedWorkspaceRequest, clearWorkspaceRequest } = await import('../src/renderer/src/lib/workspace-request-selection');
const ordinaryDraft = { title: 'ordinary draft' };
let state: any = { page:'chat', activeTaskId:'ordinary-task', draft:ordinaryDraft };
const requests: any[] = [];
const routes: BotWorkspaceRequestDto[] = [
 {id:'r-old',spaceId:'space-b',botId:'b',conversationId:'old',requestId:'old-request',messageId:'old-user',title:'old',status:'completed',createdAt:1,updatedAt:1,archived:true},
 {id:'r-new',spaceId:'space-b',botId:'b',conversationId:'old',requestId:'new-request',messageId:'new-user',title:'new',status:'completed',createdAt:2,updatedAt:2,archived:false},
 {id:'r-other',spaceId:'space-other',botId:'other-bot',conversationId:'old',requestId:'old-request',messageId:'old-user',title:'wrong owner',status:'completed',createdAt:3,updatedAt:3,archived:false},
];
let release: (()=>void) | undefined;
let gate: Promise<void> | undefined;
let invalidIdentity = false;
const api: any = { botWork: {
 workspaceNavigation:async()=>{ if(gate) await gate; return {spaces:[],taskSpaces:[],conversations:[],foregroundRequests:routes}; },
 history:async(request:any)=>{requests.push(request); return {botId:invalidIdentity?'wrong':request.botId,teamId:request.teamId,conversationId:request.conversationId,
  messages:request.before === undefined ? [{messageId:'new-user',requestId:'new-request'}] : [{messageId:'old-assistant',requestId:'old-request'}],
  before:request.before === undefined ? 10 : undefined};},
} };
const actions = { openNotificationConversation: (target: any, signal?: AbortSignal) => {
 const page = state.page, taskId = state.activeTaskId;
 return openHistoricalNotification(target, api.botWork, request => activateWorkspaceRequest(request, spaceId => state.openWorkspaceDetail(spaceId)),
   { signal, isCurrent: () => state.page === page && state.activeTaskId === taskId });
}};
state={...state,...actions,openWorkspaceDetail:(spaceId:string)=>{state={...state,page:'workspace',activeWorkspaceId:spaceId};}};
await actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old',messageId:'old-assistant'});
assert.equal(state.page,'workspace');assert.equal(state.activeWorkspaceId,'space-b');
assert.equal(selectedWorkspaceRequest('space-b')?.requestId,'old-request','message identity, not newest neighbour, selects history');
assert.equal(events.at(-1).detail.requestId,'old-request');assert.equal(requests.length,2,'historical message lookup paginates');
assert.equal(state.draft,ordinaryDraft);assert.equal(state.activeTaskId,'ordinary-task');

assert.equal(Object.hasOwn(api.botWork,'listBots'),false,'history routing does not require live Bot runtime');
await actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old'});
assert.equal(selectedWorkspaceRequest('space-b')?.requestId,'new-request','conversation-only target selects latest matching owner request');
const navigations=events.length;
await assert.rejects(actions.openNotificationConversation({kind:'botConversation',botId:'b',teamId:'other-team',conversationId:'old'}),/尚无工作空间入口/);
await assert.rejects(actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old',messageId:'missing'}),/未找到/);
invalidIdentity=true;
await assert.rejects(actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old',messageId:'old-assistant'}),/身份不匹配/);
invalidIdentity=false;assert.equal(events.length,navigations,'invalid targets cannot navigate to neighbours');
gate=new Promise<void>(resolve=>{release=resolve;});
const pending=actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old'});
await Promise.resolve();state.activeTaskId="newer-task";release!();gate=undefined;
await assert.rejects(pending,/新的选择/);assert.equal(events.length,navigations,'late response cannot replace newer selection');
gate=new Promise<void>(resolve=>{release=resolve;});
const sameSpacePending=actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old'});
await Promise.resolve();activateWorkspaceRequest(routes[0],()=>{});const afterUserSelection=events.length;release!();gate=undefined;
await assert.rejects(sameSpacePending,/新的选择/);
assert.equal(events.length,afterUserSelection,'late notification cannot replace another historical request in the same workspace');
const aborted=new AbortController();aborted.abort();
await assert.rejects(actions.openNotificationConversation({kind:'botConversation',botId:'b',conversationId:'old'},aborted.signal));
assert.equal(events.length,afterUserSelection,'disposed renderer cannot navigate');clearWorkspaceRequest();
console.log('notification routing: PASS (SQLite restart/desktop-only/deletion/expiry/dedupe + exact read-only workspace request/drafts/pagination/race)');

// Use the production per-click delivery policy, not a duplicate test-only drain.
const { deliverNotificationActivation } = await import('../src/renderer/src/lib/notificationActivationDelivery');
const queue = ['bad-a', 'good-b'];
const opened:string[]=[]; const errors:string[]=[]; const acknowledged:string[]=[];
while(queue.length){
 const current=queue[0];
 const continued=await deliverNotificationActivation({notificationId:current,target:{kind:'work',workId:current}}, {
  disposed:()=>false,
  navigate:async()=>{if(current==='bad-a')throw new Error('deleted team');opened.push(current);},
  markRead:async()=>{}, showError:message=>errors.push(message),
  acknowledge:async id=>{acknowledged.push(id);queue.shift();},
 });
 assert(continued);
}
assert.deepEqual(opened,['good-b']);assert.deepEqual(acknowledged,['bad-a','good-b']);assert.deepEqual(errors,['deleted team']);
let disposed=false;let ackCount=0;
assert.equal(await deliverNotificationActivation({notificationId:'late',target:null},{
 disposed:()=>disposed,navigate:async()=>{disposed=true;throw new Error('unmounted');},markRead:async()=>{},showError:()=>assert.fail('disposed error'),acknowledge:async()=>{ackCount++;}
}),false);assert.equal(ackCount,0,'renderer teardown preserves the pending click');
await assert.rejects(deliverNotificationActivation({notificationId:'transport',target:null},{
 disposed:()=>false,navigate:async()=>{},markRead:async()=>{},showError:()=>{},acknowledge:async()=>{throw new Error('IPC unavailable');}
}),/IPC unavailable/,'ack transport error stops the drain without a busy loop');
console.log('notification click delivery: PASS (bad A permits good B, disposed preserves click, ack failure stops drain)');
// Acknowledging removes only the queued click; the same persisted identity can be retried.
assert.equal(await deliverNotificationActivation({notificationId:'bad-a',target:{kind:'work',workId:'bad-a'}},{
 disposed:()=>false,navigate:async()=>{opened.push('bad-a-retry');},markRead:async()=>{},showError:()=>assert.fail('retry should succeed'),acknowledge:async id=>{acknowledged.push(id);}
}),true);assert.equal(opened.at(-1),'bad-a-retry');
