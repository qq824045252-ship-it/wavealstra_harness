import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const draft = readFileSync(new URL('../draft.ts.txt', import.meta.url), 'utf8');
const transformed = stripTypeScriptTypes(draft, { mode: 'transform' });
const { BotRegistry, WorkRepository, WorkService, migrateToV28BotWorkPhase1 } = await import('data:text/javascript;base64,' + Buffer.from(transformed).toString('base64'));
function makeDb() {
 const raw=new DatabaseSync(':memory:');
 const db={exec:s=>raw.exec(s),prepare:s=>raw.prepare(s),pragma:s=>raw.prepare('PRAGMA '+s).all(),transaction:fn=>(...args)=>{raw.exec('BEGIN');try{const x=fn(...args);raw.exec('COMMIT');return x}catch(e){raw.exec('ROLLBACK');throw e}}};
 return {raw,db};
}
const findings={};
{
 const {raw,db}=makeDb();
 migrateToV28BotWorkPhase1(db);
 findings.freshDdl={tables:raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n,userVersion:raw.prepare('PRAGMA user_version').get().user_version};
 const bots=new BotRegistry(db);
 bots.stageExpertTemplateUpdate('bot-mybuddy-primary',2);
 bots.stageExpertTemplateUpdate('bot-mybuddy-primary',3);
 const result=bots.adoptPendingExpertVersion('bot-mybuddy-primary','prompt-hash-of-version-2');
 findings.staleExpertApproval={activeVersion:result.expertProfile.activeVersion,hash:result.expertProfile.systemPromptHash};
 raw.close();
}
{
 const {raw,db}=makeDb();
 const actualSchema=readFileSync(new URL('../fixtures/AppDatabase.goal-schema.txt',import.meta.url),'utf8');
 const goalDdl=actualSchema.match(/CREATE TABLE IF NOT EXISTS conversation_goals \([\s\S]*?\n\s*\);/)[0];
 raw.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY); INSERT INTO tasks VALUES (\'task1\');');
 raw.exec(goalDdl);
 raw.prepare(`INSERT INTO conversation_goals(id,task_id,title,description,status,criteria_json,version,created_by,created_at,updated_at,achieved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('goal1','task1','legacy title','legacy description','active',JSON.stringify([{id:'c1',text:'required test',status:'met',evidence:'test passed'}]),4,'agent_explicit_request',1,2,null);
 migrateToV28BotWorkPhase1(db);
 const repo=new WorkRepository(db);
 const migrated=repo.get('goal1');
 findings.migrationEnums={oldStatus:'met',newStatus:migrated.criteria[0].status,oldCreatedBy:'agent_explicit_request',newCreatedBy:migrated.createdBy};
 const service=new WorkService(db,repo,new BotRegistry(db));
 const amended=service.amendWork({workId:'goal1',operationId:'amend1',actorBotId:'bot-mybuddy-primary',title:'work title changed',versionGuard:{expectedOwnerEpoch:migrated.ownerEpoch,expectedIntentRevision:migrated.intentRevision,expectedStateVersion:migrated.stateVersion}});
 findings.twoTruthStores={amendOk:amended.ok,workTitle:repo.get('goal1').title,legacyTitle:raw.prepare('SELECT title FROM conversation_goals WHERE id=?').get('goal1').title};
 findings.currentAppWouldRejectVersion={currentVersion:Number(actualSchema.match(/CURRENT_DATABASE_SCHEMA_VERSION = (\d+)/)[1]),afterDraftMigration:raw.prepare('PRAGMA user_version').get().user_version};
 raw.close();
}
console.log(JSON.stringify(findings,null,2));
