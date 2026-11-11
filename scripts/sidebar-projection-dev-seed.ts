import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from '../src/shared/bot-work';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import assert from 'node:assert/strict';
const home=resolve(process.env.HOME!);assert.equal(home,resolve(process.env.SIDEBAR_PROJECTION_HOME!));assert(basename(home).startsWith('sbd-'));
const dir=join(home,'.mybuddy');mkdirSync(dir,{recursive:true});
const app=new AppDatabase(join(dir,'app.db'));
try {
 const db=app.connection, now=1794412800000;
 db.transaction(()=>{
  app.createSpace({id:'sb-root',name:'Benchmark workspace',sortOrder:0});
  app.createSpace({id:'sb-nested',name:'Nested workspace',parentId:'sb-root',sortOrder:0});
  app.createSpace({id:'sb-other',name:'Other workspace',sortOrder:1});
  for(let i=0;i<(process.env.SIDEBAR_SMALL_PARITY?20:5000);i++)app.upsertTask({id:'sb-task-'+String(i).padStart(5,'0'),title:'Synthetic task '+String(i).padStart(5,'0'),spaceId:process.env.SIDEBAR_NAV_ONLY&&!process.env.SIDEBAR_SMALL_PARITY?undefined:i%10===0?'sb-nested':i%10===1?'sb-other':'sb-root',status:(['planning','completed','failed','in_progress','pending'] as const)[i%5],updatedAt:now-i*60001,spaceSortOrder:0,isFavorited:i===2,archived:i%137===136,doneAckedAt:now+1,welcomeMode:'general',modelId:'fixture/fixture'});
  if(process.env.SIDEBAR_NAV_ONLY){
   new BotRegistry(db).ensureDefaultBot(LOCAL_USER_ID);
   for(let c=0;c<3;c++){
    const id='sbd-conversation-'+c;db.prepare('INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at,archived_at) VALUES(?,?,?,?,?,?)').run(id,DEFAULT_BOT_ID,LOCAL_USER_ID,now+c,now+c,c>0?now:null);
    for(let i=0;i<(c===0?25:c===1?2:0);i++){
     const request='sbd-request-'+c+'-'+i,user=request+'-user',assistant=request+'-assistant';
     for(const [message,role,text] of [[user,'user','Synthetic foreground '+i],[assistant,'assistant','Synthetic completed response']])db.prepare('INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(message,id,DEFAULT_BOT_ID,request,role,text,'completed',now+i,now+i);
     db.prepare('INSERT INTO bot_send_receipts(user_id,bot_id,request_id,payload_hash,conversation_id,user_message_id,assistant_message_id) VALUES(?,?,?,?,?,?,?)').run(LOCAL_USER_ID,DEFAULT_BOT_ID,request,'fixture',id,user,assistant);
    }
   }
  }
 })();db.pragma('wal_checkpoint(TRUNCATE)');
 writeFileSync(join(home,'fixture.json'),JSON.stringify({now,tasks:process.env.SIDEBAR_SMALL_PARITY?20:5000,seededSpaces:3,foregroundConversations:process.env.SIDEBAR_NAV_ONLY?3:0,foregroundRequests:process.env.SIDEBAR_NAV_ONLY?27:0}));
}finally{app.close();}
