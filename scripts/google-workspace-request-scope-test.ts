import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkService, DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { BotConversationRepository } from '../src/main/agent/work/BotConversationRepository';
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from '../src/shared/bot-work';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { foregroundWorkspaceScope, workWorkspaceScope, durableWorkspaceScope, workspaceUserRequestScope } from '../src/main/agent/work/GoogleWorkspaceRequestScope';
import type { BotMessageDto } from '../src/shared/bot-conversation';
import type { BotMessageReceipt } from '../src/main/agent/work/BotConversationRepository';
import type { WorkDto, WorkExecutionBindingDto } from '../src/shared/bot-work';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const receipt = {user_id:'owner',bot_id:'bot',conversation_id:'chat',request_id:'request',user_message_id:'user-1',assistant_message_id:'assistant-1'} as BotMessageReceipt;
const user = {messageId:'user-1',botId:'bot',conversationId:'chat',requestId:'request',role:'user',status:'completed'} as BotMessageDto;
const assistant = {...user,messageId:'assistant-1',role:'assistant',status:'running'} as BotMessageDto;
const expected = workspaceUserRequestScope('owner','user-1');
assert.equal(foregroundWorkspaceScope('owner','bot','chat','request',receipt,user,assistant), expected);
const peerUser: BotMessageDto = { ...user, peerOrigin: { kind: 'request', collaborationId: 'collaboration', exchangeId: 'operation',
  senderBotId: 'a', senderDisplayName: 'A', sourceBotId: 'a', sourceConversationId: 'a-chat', sourceRequestId: 'a-request',
  sourceUserMessageId: 'human-input', sourceAssistantMessageId: 'a-assistant' } };
const originalHuman: BotMessageReceipt = { ...receipt, bot_id: 'a', conversation_id: 'a-chat', request_id: 'a-request',
  user_message_id: 'human-input', assistant_message_id: 'a-assistant' };
assert.equal(foregroundWorkspaceScope('owner','bot','chat','request',receipt,peerUser,assistant,originalHuman), workspaceUserRequestScope('owner','human-input'));
assert.throws(() => foregroundWorkspaceScope('owner','bot','chat','request',receipt,peerUser,assistant));
assert.throws(() => foregroundWorkspaceScope('owner','bot','chat','request',receipt,peerUser,assistant,{...originalHuman,user_id:'other'}));
assert.throws(() => foregroundWorkspaceScope('other','bot','chat','request',receipt,user,assistant));
assert.throws(() => foregroundWorkspaceScope('owner','bot','chat','request',receipt,{...user,role:'assistant'},assistant));
assert.throws(() => foregroundWorkspaceScope('owner','bot','chat','request',receipt,user,{...assistant,status:'completed'}));
assert.throws(() => foregroundWorkspaceScope('owner','bot','chat','different',receipt,user,assistant));
assert.throws(() => foregroundWorkspaceScope('owner','bot','chat','request',undefined,user,assistant));
console.log('PASS Workspace foreground source receipt ownership/role/status validation');

const db = new Database(':memory:');
try {
  db.exec(`CREATE TABLE work_intent_snapshots(work_id TEXT,input_snapshot_id TEXT,intent_revision INTEGER,source_message_id TEXT);
    CREATE TABLE bot_send_receipts(user_id TEXT,bot_id TEXT,conversation_id TEXT,request_id TEXT,user_message_id TEXT);
    CREATE TABLE bot_messages(message_id TEXT,role TEXT,bot_id TEXT,conversation_id TEXT,request_id TEXT);
    INSERT INTO bot_send_receipts VALUES('owner','bot','chat','request','user-1');
    INSERT INTO bot_messages VALUES('user-1','user','bot','chat','request');
    INSERT INTO work_intent_snapshots VALUES('work-1','input-1',1,'user-1'),('work-1','input-1',2,NULL),('work-2','input-1',1,'user-1');`);
  const work = {workId:'work-1',userId:'owner',lifecycle:'active',intentRevision:2,inputSnapshotId:'input-1',ownerEpoch:1} as WorkDto;
  const binding = {taskId:'task-1',workId:'work-1',status:'running',intentRevision:2,inputSnapshotId:'input-1',ownerEpoch:1} as WorkExecutionBindingDto;
  assert.equal(workWorkspaceScope(db,'owner','task-1',binding,work),expected);
  assert.equal(workWorkspaceScope(db,'owner','task-2',{...binding,taskId:'task-2'},work),expected);
  assert.equal(workWorkspaceScope(db,'owner','task-3',{...binding,taskId:'task-3',workId:'work-2',intentRevision:1},{...work,workId:'work-2',intentRevision:1}),expected);
  for (const mutation of [{invalidatedAt:1},{intentRevision:1},{ownerEpoch:2},{inputSnapshotId:'new-input'},{status:'completed'}])
    assert.throws(() => workWorkspaceScope(db,'owner','task-1',{...binding,...mutation} as WorkExecutionBindingDto,work));
  assert.throws(() => workWorkspaceScope(db,'other','task-1',binding,work));
  assert.throws(() => workWorkspaceScope(db,'owner','task-1',binding,{...work,lifecycle:'paused'}));
  assert.throws(() => workWorkspaceScope(db,'owner','task-1',binding,{...work,workId:'unrelated'}));
  db.prepare("UPDATE bot_messages SET role='assistant'").run();
  assert.throws(() => workWorkspaceScope(db,'owner','task-1',binding,work));
  db.prepare("UPDATE bot_messages SET role='user'").run();
  db.exec("INSERT INTO bot_send_receipts VALUES('owner','bot','chat','second','user-2'); INSERT INTO bot_messages VALUES('user-2','user','bot','chat','second'); INSERT INTO work_intent_snapshots VALUES('work-1','input-1',2,'user-2');");
  assert.throws(() => workWorkspaceScope(db,'owner','task-1',binding,work));
  console.log('PASS Workspace Work source stable across tasks/Works and retained-input amendments; stale, foreign, missing and ambiguous sources rejected');
} finally { db.close(); }

const tx = {
  conversation: async (id: number) => id === 2 ? {owner:{conversationId:1}} : {},
  scanEntries: async () => ({items:[{id:10,kind:'mybuddy.user',data:{mybuddyInput:{audit:{userMessageId:'user-1'}}}}]}),
  submissionByRequest: async () => ({type:'input',id:5,entry:10}),
};
const api = {conversationId:2, commit: async (f: (tx: unknown) => unknown) => f(tx), snapshot:async () => ({run:{inputs:[5]}})} as unknown as ToolExecutionApi;
assert.equal(await durableWorkspaceScope('owner')(api,BACKGROUND_CONTEXT),expected);
await assert.rejects(() => durableWorkspaceScope('owner')({...api,snapshot:async () => ({run:{inputs:[5,6]}})} as unknown as ToolExecutionApi,BACKGROUND_CONTEXT));
await assert.rejects(() => durableWorkspaceScope('owner')({...api,snapshot:async () => undefined} as unknown as ToolExecutionApi,BACKGROUND_CONTEXT));
console.log('PASS Workspace durable source owner-chain and exact submission receipt; missing/ambiguous inputs rejected');

// Exercise actual schema/repositories and service mutations, not handwritten rows.
const integrationRoot = mkdtempSync(join(tmpdir(), 'gws-work-source-'));
const previousHome = process.env.HOME, previousProfile = process.env.USERPROFILE;
process.env.HOME = integrationRoot; process.env.USERPROFILE = integrationRoot;
const appDb = new AppDatabase(join(integrationRoot, 'app.db'));
try {
  const bots = new BotRegistry(appDb.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(appDb.connection, { bots });
  const messages = new BotConversationRepository(appDb.connection);
  const actor: WorkActor = {kind:'user',userId:LOCAL_USER_ID,entry:'desktop',grants:DESKTOP_USER_GRANTS};
  const unwrap = (result: WorkControlResult) => { if (!result.ok) throw new Error(`${result.code}: ${result.message}`); return result.work; };
  const firstSource = messages.accept(LOCAL_USER_ID, {botId:DEFAULT_BOT_ID,requestId:'scope-create',text:'Create the requested calendar event'});
  let actualWork = unwrap(works.createWork(actor, {operationId:'scope-create-work',title:'Synthetic calendar task',ownerBotId:DEFAULT_BOT_ID,
    authorization:DESKTOP_USER_GRANTS,conversationId:firstSource.conversationId,sourceMessageId:firstSource.userMessageId,
    inputSnapshotId:`input:${firstSource.userMessageId}`}));
  const dispatch = (taskId: string) => {
    appDb.upsertTask({id:taskId,title:taskId,updatedAt:Date.now(),welcomeMode:'general'});
    actualWork = unwrap(works.dispatchExecution(actor, {operationId:`dispatch-${taskId}`,workId:actualWork.workId,botId:DEFAULT_BOT_ID,taskId,
      durableStoreKey:`store-${taskId}`,conversationId:`native-${taskId}`,workspaceBinding:integrationRoot}));
    const binding = works.repo.bindingForTask(taskId); assert.ok(binding); return binding;
  };
  const firstBinding = dispatch('scope-task-first');
  const firstScope = workspaceUserRequestScope(LOCAL_USER_ID, firstSource.userMessageId);
  assert.equal(workWorkspaceScope(appDb.connection,LOCAL_USER_ID,firstBinding.taskId,firstBinding,actualWork),firstScope);
  // Same input, new intent version: the service writes a snapshot without a new
  // source message. It must resolve the original source of that retained input.
  actualWork = unwrap(works.amendWork(actor,{operationId:'scope-retained-input',workId:actualWork.workId,title:'Updated execution details'}));
  assert.equal(actualWork.inputSnapshotId,`input:${firstSource.userMessageId}`);
  assert.throws(() => workWorkspaceScope(appDb.connection,LOCAL_USER_ID,firstBinding.taskId,firstBinding,actualWork));
  const retainedBinding = dispatch('scope-task-retained');
  assert.equal(workWorkspaceScope(appDb.connection,LOCAL_USER_ID,retainedBinding.taskId,retainedBinding,actualWork),firstScope);
  // A new user instruction uses the same host-provided source/input fields as
  // BotForegroundTools.work_amend, and must not inherit the previous request key.
  const secondSource = messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,conversationId:firstSource.conversationId,requestId:'scope-amend',text:'Change the requested event date'});
  actualWork = unwrap(works.amendWork(actor,{operationId:'scope-new-input',workId:actualWork.workId,title:'New requested date',
    sourceMessageId:secondSource.userMessageId,inputSnapshotId:`input:${secondSource.userMessageId}`}));
  assert.throws(() => workWorkspaceScope(appDb.connection,LOCAL_USER_ID,retainedBinding.taskId,retainedBinding,actualWork));
  const revisedBinding = dispatch('scope-task-revised');
  const revisedScope = workWorkspaceScope(appDb.connection,LOCAL_USER_ID,revisedBinding.taskId,revisedBinding,actualWork);
  assert.equal(revisedScope,workspaceUserRequestScope(LOCAL_USER_ID,secondSource.userMessageId));
  assert.notEqual(revisedScope,firstScope);
  console.log('PASS actual AppDatabase/receipt/createWork/dispatch chain; retained-input and new-user-input amendments preserve/update scope correctly');
} finally {
  appDb.close();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  rmSync(integrationRoot,{recursive:true,force:true});
}
