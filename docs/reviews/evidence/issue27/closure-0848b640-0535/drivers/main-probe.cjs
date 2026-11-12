'use strict';
// Test-process-only metadata probe. No SQL, business result, setting, or credential changes.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
if(process.versions.electron && process.type==='browser' && process.env.ELECTRON_RUN_AS_NODE!=='1' && process.env.HOME===process.env.IQ27_PROBE_HOME && process.env.IQ27_PROBE_OUT){
 const home=fs.realpathSync(process.env.IQ27_PROBE_HOME),out=fs.realpathSync(process.env.IQ27_PROBE_OUT);
 if(!home.startsWith('/home/vivion/iq27-tmp/'))throw Error('Probe requires an isolated test profile');
 const file=path.join(out,`main-probe-${process.pid}.jsonl`),clock=()=>process.hrtime.bigint(),rows=[];let seq=0,txseq=0,overheadNs=0n,hookCalls=0;
 const add=(kind,ns,data={})=>rows.push({seq:++seq,pid:process.pid,kind,monoNs:String(ns),...data});
 const flush=()=>{if(rows.length)fs.appendFileSync(file,rows.splice(0).map(r=>JSON.stringify(r)).join('\n')+'\n');};
 const timer=setInterval(flush,250);timer.unref();
 add('probe-start',clock(),{home,sqliteBoundary:'synchronous native Statement.run return, not fsync or physical persistence'});
 const contexts=new WeakMap(),patched=new WeakSet(),allowedTable=/^(bot_messages|bot_message_\w+|bot_work_\w+|bot_send_receipts|bot_conversations|works|work_\w+|cron_\w+)$/;
 const safeKey=/^(?:.*_)?(?:id|revision|version)$|^(?:messageRevision|intentRevision|stateVersion|sourceVersion|requestId|messageId|conversationId|workId|bindingId|operationId|eventId|taskId|deliveryId|jobId|botId|userId)$/;
 function identities(args,sql){const ids={};let j=0;const put=(k,v)=>{if(safeKey.test(k)&&(typeof v==='string'||typeof v==='number'||v===null)&&String(v).length<250)ids[k]=v;};
  for(const a of args){if(a&&typeof a==='object'&&!Array.isArray(a))for(const [k,v] of Object.entries(a))put(k,v);else if(typeof a==='string'&&/^(?:bot-message-|bot-conversation-|bot-inbox-|work-|binding-|task-|reminder-|iq27-)/.test(a)&&a.length<250)ids['identity'+j++]=a;}
  const m=sql.match(/INSERT(?:\s+OR\s+\w+)?\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
  if(m){const cols=m[1].split(',').map(s=>s.trim()),vals=m[2].split(',').map(s=>s.trim());let p=0;vals.forEach((v,i)=>{if(v==='?')put(cols[i]||'',args[p++]);});}
  return ids;
 }
 function install(D){if(!D?.prototype||patched.has(D.prototype))return;patched.add(D.prototype);const orig=D.prototype.prepare;
  D.prototype.prepare=function(...args){const result=Reflect.apply(orig,this,args);const p=Object.getPrototypeOf(result);if(!patched.has(p)){patched.add(p);const run=p.run;
   p.run=function(...values){const enter=clock();let db;try{db=this.database;}catch{};if(!db||db.name!==path.join(home,'.mybuddy','app.db'))return Reflect.apply(run,this,values);
    const sql=this.source.trim(),verb=sql.match(/^(\w+)/)?.[1]?.toUpperCase(),table=sql.match(/^(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?([\w]+)/i)?.[1];
    const control=/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)$/.test(verb),tracked=table&&allowedTable.test(table);if(!control&&!tracked)return Reflect.apply(run,this,values);
    let c=contexts.get(db);if(!c){c={tx:null,writes:[],savepoints:[]};contexts.set(db,c);}const beforeTx=db.inTransaction,ids=tracked?identities(values,sql):{};const nativeStart=clock();let result;
    try{result=Reflect.apply(run,this,values);}catch(error){const ns=clock();add('sqlite-throw',ns,{verb,table,tx:c.tx,errorName:error?.name,code:error?.code});overheadNs+=(nativeStart-enter)+(clock()-ns);hookCalls++;throw error;}
    const returned=clock();
    if(verb==='BEGIN'&&!beforeTx){c.tx=++txseq;c.writes=[];c.savepoints=[];add('transaction-begin-return',returned,{tx:c.tx});}
    else if(verb==='COMMIT'){add('transaction-commit-return',returned,{tx:c.tx,identities:c.writes,sqliteCallNs:String(returned-nativeStart)});c.tx=null;c.writes=[];}
    else if(verb==='SAVEPOINT'){c.savepoints.push(c.writes.length);add('savepoint-return',returned,{tx:c.tx});}
    else if(verb==='ROLLBACK'&&db.inTransaction){c.writes.length=c.savepoints.at(-1)??c.writes.length;add('rollback-to-return',returned,{tx:c.tx});}
    else if(verb==='RELEASE'){c.savepoints.pop();add('savepoint-release-return',returned,{tx:c.tx});}
    else if(verb==='ROLLBACK'&&!db.inTransaction){add('transaction-rollback-return',returned,{tx:c.tx});c.tx=null;c.writes=[];}
    else if(tracked){const data={tx:c.tx,verb,table,identities:ids,autocommit:!beforeTx&&!db.inTransaction,sqliteCallNs:String(returned-nativeStart),changes:result?.changes};add('statement-return',returned,data);if(c.tx)c.writes.push({table,...ids});}
    overheadNs+=(nativeStart-enter)+(clock()-returned);hookCalls++;return result;
   };
  }return result;};
  add('sqlite-hook-installed',clock());
 }
 let electronInstalled=false;const oldLoad=Module._load;Module._load=function(request,...rest){const value=Reflect.apply(oldLoad,this,[request,...rest]);if(request==='better-sqlite3')install(value);if(request==='electron'&&value?.app&&!electronInstalled){electronInstalled=true;installElectron(value);}return value;};
 // Main broadcast listener only observes this process and does not replace IPC results.
 function installElectron(electron){require('./open-probe.cjs').install({electron,home,add,clock});electron.app.on('web-contents-created',(_e,wc)=>{const orig=wc.send;wc.send=function(channel,...args){const enter=clock();if(channel==='bot-work:message-changed'){const e=args[0],m=e?.message;add('main-broadcast-before',enter,{webContentsId:wc.id,conversationId:e?.conversationId,revision:e?.revision,messageId:m?.messageId,requestId:m?.requestId,messageRevision:m?.messageRevision,status:m?.status,role:m?.role,workIds:m?.workIds});}return Reflect.apply(orig,this,[channel,...args]);};});add('electron-hook-installed',clock());}
 process.once('exit',()=>{add('probe-end',clock(),{hookCalls,measuredHookOverheadNs:String(overheadNs),note:'Includes metadata and enqueue overhead; excludes 250ms batch flush I/O, trace and renderer observer overhead.'});flush();});
}
