import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {WorkService} from '../src/main/agent/work/WorkService';
import {DEFAULT_BOT_ID, LOCAL_USER_ID, minimumAuthorization, type WorkActor, type WorkControlResult} from '../src/shared/bot-work';
const root=mkdtempSync(join(tmpdir(),'work-permissions-retired-'));
const db=new AppDatabase(join(root,'test.db'));const bots=new BotRegistry(db.connection);bots.ensureDefaultBot(LOCAL_USER_ID);
const works=new WorkService(db.connection,{bots});const actor:WorkActor={kind:'user',userId:LOCAL_USER_ID,grants:minimumAuthorization()};
const ok=(r:WorkControlResult)=>{assert(r.ok,JSON.stringify(r));return r.work;};
try {
 const work=ok(works.createWork(actor,{operationId:'create',title:'Old restricted Work continues',inputSnapshotId:'input',workspacePath:root,
 authorization:{allowedScopes:[],targetWhitelist:['obsolete'],allowRedelegation:false,allowGitBranchOrWorktree:false,expiresAt:1}}));
 // Inject an actual historical stored policy, rather than only exercising new creation normalization.
 db.connection.prepare('UPDATE works SET authorization_json=? WHERE work_id=?').run(JSON.stringify({allowedScopes:['workspace:read'],targetWhitelist:[],allowRedelegation:false,allowGitBranchOrWorktree:false,expiresAt:1}),work.workId);
 ok(works.pauseWork(actor,{operationId:'pause',workId:work.workId}));ok(works.resumeWork(actor,{operationId:'resume',workId:work.workId}));
 const dispatched=ok(works.dispatchExecution(actor,{operationId:'dispatch',workId:work.workId,botId:DEFAULT_BOT_ID,taskId:'execution',durableStoreKey:'execution',conversationId:'execution',workspaceBinding:root,delegatedScope:['workspace:read']}));
 const bindingId=dispatched.activeExecutionIds[0]!;
 for (const actionKind of ['workspace:read','workspace:write','git:branch','delegate','custom:tool']) {
  const r=works.admitNewAction(actor,{admissionId:actionKind,operationId:actionKind,workId:work.workId,bindingId,actionKind,paths:[join(root,'..','external-output')]});assert(r.ok,JSON.stringify(r));
  const replay=works.admitNewAction(actor,{admissionId:actionKind,operationId:actionKind,workId:work.workId,bindingId,actionKind});assert(replay.ok);assert.equal(replay.admission.admissionId,r.admission.admissionId);works.settleAdmission(r.admission.admissionId,'consumed');
 }
 const foreign=works.admitNewAction({kind:'user',userId:'other-user',grants:minimumAuthorization()},{admissionId:'foreign',operationId:'foreign',workId:work.workId,bindingId,actionKind:'workspace:write'});assert.equal(foreign.ok,false,'ownership remains distinct from tool approvals');
 ok(works.pauseWork(actor,{operationId:'pause-again',workId:work.workId}));assert.equal(works.admitNewAction(actor,{admissionId:'paused',operationId:'paused',workId:work.workId,bindingId,actionKind:'workspace:write'}).ok,false,'explicit pause still works');
 assert.equal(works.listWorks(LOCAL_USER_ID).length,1,'historical task preserved');
 console.log('PASS: legacy expiry/scopes/paths removed; actions replay safely; user ownership and pause retained');
} finally {db.close();rmSync(root,{recursive:true,force:true});}
