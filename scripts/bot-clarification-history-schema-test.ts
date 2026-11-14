import assert from 'node:assert/strict';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {BotConversationRepository} from '../src/main/agent/work/BotConversationRepository';
import {LOCAL_USER_ID} from '../src/shared/bot-work';
const app=new AppDatabase(':memory:'),db=app.connection;
try {
 const bots=new BotRegistry(db);bots.registerBot({botId:'owner',userId:LOCAL_USER_ID,displayName:'Owner'});
 const messages=new BotConversationRepository(db);
 const receipt=messages.accept(LOCAL_USER_ID,{botId:'owner',teamId:'team',requestId:'r',text:'Question'});
 messages.update(receipt.assistantMessageId,'completed','Answer');
 assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='work_team_templates'").get(),undefined);
 assert.equal(messages.message(receipt.assistantMessageId)?.text,'Answer','ordinary team history works without team service schema');
 db.prepare('INSERT INTO bot_request_runs(message_id,runtime_key,context_json,created_at) VALUES (?,?,?,?)').run(receipt.assistantMessageId,'fixture','{}',1);
 const set=(goal:unknown)=>db.prepare('UPDATE bot_request_runs SET context_json=? WHERE message_id=?').run(JSON.stringify({clarificationState:{goals:[goal]}}),receipt.assistantMessageId);
 set({goalId:'plain',question:'Question',state:'pending',updatedBy:receipt.assistantMessageId});
 assert.deepEqual(messages.message(receipt.assistantMessageId)?.clarifications,[],'plain clarification has no interactive owner lookup');
 const goal={goalId:'interactive',question:'Choose',state:'consumed',updatedBy:receipt.assistantMessageId,options:[{id:'a',label:'A'}]};
 set(goal);assert.equal(messages.message(receipt.assistantMessageId)?.clarifications?.[0]?.status,'consumed','historical goal needs no current owner');
 db.exec('CREATE TABLE work_team_templates(template_id TEXT PRIMARY KEY,user_id TEXT,deleted_at INTEGER)');
 set({...goal,state:'cancelled'});assert.equal(messages.message(receipt.assistantMessageId)?.clarifications?.[0]?.status,'cancelled','minimal memory schema remains supported');
 db.exec('ALTER TABLE work_team_templates ADD COLUMN plan_json TEXT');
 db.prepare('INSERT INTO work_team_templates VALUES (?,?,NULL,?)').run('team',LOCAL_USER_ID,JSON.stringify({ownerBotId:'owner'}));
 set({...goal,state:'pending'});assert.equal(messages.message(receipt.assistantMessageId)?.clarifications?.[0]?.status,'pending');
 db.prepare('UPDATE work_team_templates SET plan_json=?').run(JSON.stringify({ownerBotId:'replacement'}));
 assert.equal(messages.message(receipt.assistantMessageId)?.clarifications?.[0]?.status,'expired','live interactive goal still validates owner');
 console.log('PASS lazy clarification owner projection: absent/minimal schema, ordinary/plain/completed history and live owner expiry');
} finally {app.close();}
