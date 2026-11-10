import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AppDatabase} from '../src/main/db/AppDatabase';
import {BotRegistry} from '../src/main/agent/work/BotRegistry';
import {BotDisplayGroupsService} from '../src/main/agent/work/BotDisplayGroupsService';
const root=mkdtempSync(join(tmpdir(),'display-groups-'));const path=join(root,'app.db');let db=new AppDatabase(path);
try{
 const registry=new BotRegistry(db.connection),a=registry.registerBot({botId:'bot-a',userId:'a',displayName:'甲'}),b=registry.registerBot({botId:'bot-b',userId:'b',displayName:'乙'});
 const service=new BotDisplayGroupsService(db.connection,'a');
 let state=service.execute({kind:'create',name:'ERP',botId:a.botId});const id=state.groups[0].id;
 assert.equal(state.membership[a.botId],id);assert.throws(()=>service.execute({kind:'create',name:'erp'}));
 assert.throws(()=>service.execute({kind:'create',name:'未分组'}));assert.throws(()=>service.execute({kind:'create',name:'  '}));
 assert.throws(()=>service.execute({kind:'move',botId:b.botId,groupId:id}));
 const other=new BotDisplayGroupsService(db.connection,'b');assert.equal(other.execute({kind:'list'}).groups.length,0);assert.throws(()=>other.execute({kind:'delete',id}));
 assert.throws(()=>other.execute({kind:'move',botId:b.botId,groupId:id}));
 service.execute({kind:'rename',id,name:'产品'});service.execute({kind:'collapse',id,collapsed:true});
 db.close();db=new AppDatabase(path);const restarted=new BotDisplayGroupsService(db.connection,'a');
 state=restarted.execute({kind:'list'});assert.equal(state.groups[0].name,'产品');assert.equal(state.groups[0].collapsed,true);assert.equal(state.membership[a.botId],id);
 restarted.execute({kind:'move',botId:a.botId,groupId:null});assert.equal(restarted.execute({kind:'list'}).membership[a.botId],undefined);
 restarted.execute({kind:'move',botId:a.botId,groupId:id});state=restarted.execute({kind:'delete',id});assert.deepEqual(state,{groups:[],membership:{}});assert(db.connection.prepare('SELECT 1 FROM bots WHERE bot_id=?').get(a.botId));
 assert.throws(()=>restarted.execute({kind:'create',name:'原子失败',botId:b.botId}));assert.equal(restarted.execute({kind:'list'}).groups.length,0);
 console.log('PASS display groups: CRUD, membership, restart, duplicate, scope, atomicity and Bot preservation');
}finally{db.close();rmSync(root,{recursive:true,force:true});}
