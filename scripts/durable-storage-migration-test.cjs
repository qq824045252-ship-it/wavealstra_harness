/** Synthetic production-opener differential, fail-closed, snapshot and process-kill coverage. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '..');
async function snapshot(dir, journalsOnly = false) {
  const result = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    if (journalsOnly && !name.endsWith('.jsonl')) continue;
    const file = path.join(dir,name), stat = await fs.stat(file);
    result[name] = stat.isDirectory() ? await snapshot(file) : { bytes:(await fs.readFile(file)).toString('base64'), mtime:stat.mtimeMs };
  }
  return result;
}
async function load(bundle) {
  const { BACKGROUND_CONTEXT: ctx } = await import('@earendil-works/chord/context');
  return { ctx, ...await import(pathToFileURL(bundle).href) };
}
if (process.argv[2] === '--child') {
  (async()=>{
    const [bundle, dir, boundary] = process.argv.slice(3);
    const rename = fs.rename;
    fs.rename = async (from,to) => {
      const result = await rename(from,to);
      const name = path.basename(to);
      let state;
      if(name === '.mybuddy-storage-intent.json') state = JSON.parse(await fs.readFile(to,'utf8')).state;
      if ((boundary === 'copying' && state === 'copying') || (boundary === 'verified' && state === 'verified') ||
        (boundary === 'artifact' && name === 'durable.sqlite') || (boundary === 'selector' && name === '.mybuddy-storage.json')) {
        process.stdout.write('BOUNDARY\n'); setInterval(()=>{},1000); await new Promise(()=>{});
      }
      return result;
    };
    syncBuiltinESMExports();
    const {ctx,openDurableStorage} = await load(bundle);
    await openDurableStorage(dir,ctx);
  })().catch(e=>{console.error(e);process.exit(1)});
} else (async()=>{
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR || require('node:os').tmpdir(),'durable-migration-'));
  try {
    await fs.symlink(path.join(repo,'node_modules'),path.join(tmp,'node_modules'),'dir');
    const bundle = path.join(tmp,'storage.mjs');
    await esbuild.build({stdin:{contents:`export * from ${JSON.stringify(path.join(repo,'src/main/agent/durable/DurableStorage.ts'))}; export { DurableSqliteDatabase as TestDatabase } from ${JSON.stringify(path.join(repo,'src/main/agent/durable/DurableSqliteDatabase.ts'))};`,resolveDir:repo,loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'esm',packages:'external'});
    const {ctx,openDurableStorage:open,openDurablePassiveStorage:passive,durableStorageExists:exists,TestDatabase:DB} = await load(bundle);
    const {openNodeJsonlStorage:jsonl} = await import('@earendil-works/pi-durable/storage/jsonl/node');
    // Create through a symlink parent before the file exists; later canonical readers must share its gate.
    const realDir=path.join(tmp,'canonical');await fs.mkdir(realDir);const aliasDir=path.join(tmp,'alias');await fs.symlink(realDir,aliasDir,'dir');
    const aliasWriter=await DB.open(path.join(aliasDir,'new.sqlite'));await aliasWriter.exec('CREATE TABLE fixture (value INTEGER)');await aliasWriter.run('INSERT INTO fixture VALUES (1)');
    const canonicalWriter=await DB.open(path.join(realDir,'new.sqlite'));
    for(const [index,writer] of [aliasWriter,canonicalWriter].entries()) {
      const reader=await DB.open(path.join(realDir,'new.sqlite'),{readonly:true,snapshot:true});assert.equal((await reader.get('SELECT value FROM fixture')).value,index+1);
      let finished=false;const update=(index===0?writer.run('UPDATE fixture SET value=2'):writer.exec('UPDATE fixture SET value=3')).then(()=>{finished=true});
      await new Promise(r=>setTimeout(r,20));assert.equal(finished,false,'alias mutation must wait asynchronously');
      assert.equal((await reader.get('SELECT value FROM fixture')).value,index+1);await reader.close();await update;
      await writer.close(); // canonicalWriter retains the original gate when aliasWriter closes.
    }
    const fixture = path.join(tmp,'fixture'); const old = await jsonl(fixture,ctx);
    const commit = async writes => assert.equal((await old.commit([writes],()=>{},ctx)).stored,1);
    const doc = (id,scope,history='latest')=>({id,kind:'fixture-'+id,scope,history,fork:'asOf'});
    await commit([{type:'conversation',value:{id:2}}, {type:'entry',value:{id:10,conversationId:2,kind:'original',data:'EXACT 原文'}},
      {type:'document.create',record:doc(20,{kind:'conversation',conversationId:2},'rewindable'),content:{kind:'base',version:1,value:{text:'before'}}},
      {type:'document.create',record:doc(21,{kind:'session'}),content:{kind:'base',version:1,value:{activeBranch:2}}},
      {type:'document.create',record:doc(22,{kind:'task',taskId:30}),content:{kind:'base',version:1,value:{checkpoint:1}}},
      {type:'task',value:{id:30,conversationId:2,kind:'pending',version:1,input:{},background:false,abortRequested:false,state:{status:'running',checkpoint:{exact:'pending'}}}},
      {type:'submission',value:{id:40,conversationId:2,type:'input',status:'queued',requestId:'pending-request'}}]);
    await commit([{type:'document.change',id:20,content:{kind:'base',version:1,value:{text:'after'}}}, {type:'document.change',id:21,content:{kind:'base',version:1,value:{activeBranch:3}}}]);
    await commit([{type:'conversation',value:{id:3,parent:{conversationId:2,at:10}}}, {type:'document.copy',record:{...doc(24,{kind:'conversation',conversationId:3},'rewindable'),kind:'fixture-20'},source:{id:20,at:1}}]);
    await commit([{type:'document.retire',id:20}]); await commit([]); await old.close(ctx);
    const working = path.join(tmp,'working'); await fs.cp(fixture,working,{recursive:true,preserveTimestamps:true});
    // More than one verification page for each table, with deliberately mismatching tail reads.
    const many=path.join(tmp,'many-source');const manyStore=await jsonl(many,ctx);
    const writes=[];
    for(let i=0;i<300;i++)writes.push({type:'conversation',value:{id:100+i}},
      {type:'task',value:{id:1000+i,conversationId:100+i,kind:'pending',version:1,input:{exact:i},background:false,abortRequested:false,state:{status:'pending'}}},
      {type:'submission',value:{id:2000+i,conversationId:100+i,type:'input',status:'queued',requestId:'request-'+i}});
    assert.equal((await manyStore.commit([writes],()=>{},ctx)).stored,1);await manyStore.close(ctx);
    const {SqliteStorage:SQL}=await import('@earendil-works/pi-durable/storage/sqlite');
    for(const method of ['scanConversations','scanTasks','scanSubmissions']) {
      const dir=path.join(tmp,'bad-tail-'+method);await fs.cp(many,dir,{recursive:true});
      const pristine=await snapshot(dir,true);const real=SQL.prototype[method];let calls=0;
      SQL.prototype[method]=async function(...args){const page=await real.apply(this,args);calls++;if(args[2]&&page.items.length){return {...page,items:page.items.map((item,index)=>index===page.items.length-1?{...item,verificationMismatch:true}:item)}}return page};
      try {await assert.rejects(open(dir,ctx),/verification failed/);assert(calls>=2,method+' must inspect subsequent pages')}
      finally {SQL.prototype[method]=real}
      assert.deepEqual(await snapshot(dir,true),pristine);assert.equal(await fs.access(path.join(dir,'.mybuddy-storage.json')).then(()=>true,()=>false),false);
    }
    const manyOk=path.join(tmp,'many-ok');await fs.cp(many,manyOk,{recursive:true});const manyHandle=await open(manyOk,ctx);
    assert.equal((await manyHandle.storage.task(1299,ctx)).input.exact,299);assert.equal((await manyHandle.storage.submission(2299,ctx)).requestId,'request-299');
    await manyHandle.storage.close(ctx);manyHandle.lease.release();
    const original = await snapshot(working,true);
    let handle = await open(working,ctx); assert(exists(working));
    assert.equal((await handle.storage.entry(10,ctx)).commitSeq,1);
    assert.equal((await handle.storage.document(24,'current',ctx)).value.text,'before');
    assert.equal((await handle.storage.document(21,'current',ctx)).value.activeBranch,3);
    assert.equal((await handle.storage.task(30,ctx)).state.checkpoint.exact,'pending');
    assert.equal((await handle.storage.submission(40,ctx)).status,'queued');
    await handle.storage.close(ctx); handle.lease.release();
    assert.deepEqual(await snapshot(working,true),original,'legacy bytes and mtimes retained');
    const before = await snapshot(working);
    const view = await passive(working,ctx); assert.equal((await view.entry(10,ctx)).entry.data,'EXACT 原文');
    await assert.rejects(view.mintId(),/read-only/); await view.close(ctx);
    assert.deepEqual(await snapshot(working),before,'passive bytes/mtime/inventory unchanged');
    // A pinned snapshot keeps related reads coherent. A local writer waits asynchronously, not synchronously in SQLite.
    handle = await open(working,ctx); const ro = await passive(working,ctx);
    let settled=false;
    const write=handle.storage.commit([[{type:'document.change',id:21,content:{kind:'base',version:1,value:{activeBranch:99}}}]],()=>{},ctx).then(()=>{settled=true});
    await new Promise(r=>setTimeout(r,20)); assert.equal(settled,false);
    assert.equal((await ro.document(21,'current',ctx)).value.activeBranch,3);
    await ro.close(ctx); await write; assert.equal(settled,true);
    await handle.storage.close(ctx);handle.lease.release();
    for(const mode of ['missing-selector','bad-selector','missing-target']) {
      const dir=path.join(tmp,mode);await fs.cp(working,dir,{recursive:true});
      const unchanged = await snapshot(dir,true);
      if(mode==='missing-selector')await fs.unlink(path.join(dir,'.mybuddy-storage.json'));
      if(mode==='bad-selector')await fs.writeFile(path.join(dir,'.mybuddy-storage.json'),'{}');
      if(mode==='missing-target')await fs.unlink(path.join(dir,'durable.sqlite'));
      await assert.rejects(passive(dir,ctx));await assert.rejects(open(dir,ctx));
      assert.deepEqual(await snapshot(dir,true),unchanged);
    }
    // A valid unrelated SQLite file must never be initialized as a blank selected Durable store.
    const unrelated=path.join(tmp,'unrelated-target');await fs.cp(working,unrelated,{recursive:true});
    const unrelatedPath=path.join(unrelated,'durable.sqlite');await fs.unlink(unrelatedPath);
    const foreign=await DB.open(unrelatedPath);await foreign.exec('CREATE TABLE foreign_data (value TEXT)');await foreign.run('INSERT INTO foreign_data VALUES (?)','must stay untouched');await foreign.close();
    const unrelatedBytes=await fs.readFile(unrelatedPath);
    await assert.rejects(passive(unrelated,ctx));await assert.rejects(open(unrelated,ctx));
    assert.deepEqual(await fs.readFile(unrelatedPath),unrelatedBytes,'selected unrelated DB must not gain Durable tables');
    // Real child SIGKILL at each publication boundary, then idempotent writable recovery.
    for(const boundary of ['copying','verified','artifact','selector']) {
      const dir=path.join(tmp,'kill-'+boundary);await fs.cp(fixture,dir,{recursive:true,preserveTimestamps:true});
      const unchanged = await snapshot(dir,true);
      await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[__filename,'--child',bundle,dir,boundary],{stdio:['ignore','pipe','pipe']});let reached=false,stderr='';
        const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('boundary timeout '+boundary+stderr))},15000);
        child.stderr.on('data',d=>stderr+=d);child.stdout.on('data',d=>{if(String(d).includes('BOUNDARY')){reached=true;child.kill('SIGKILL')}});
        child.on('exit',(code,signal)=>{clearTimeout(timeout);if(reached&&signal==='SIGKILL')resolve();else reject(new Error('child failed '+code+stderr))});
      });
      const h=await open(dir,ctx);assert.equal((await h.storage.entry(10,ctx)).entry.data,'EXACT 原文');
      await h.storage.close(ctx);h.lease.release();const h2=await open(dir,ctx);await h2.storage.close(ctx);h2.lease.release();
      assert.deepEqual(await snapshot(dir,true),unchanged,'SIGKILL originals '+boundary);
    }
    // A killed writer with spilled pages leaves a hot rollback journal. Passive inspection must not recover it.
    const hot=path.join(tmp,'hot-journal');await fs.cp(working,hot,{recursive:true});
    await new Promise((resolve,reject)=>{
      const code=`const D=require('better-sqlite3');const d=new D(process.argv[1]);d.pragma('cache_size=1');d.exec('BEGIN IMMEDIATE');d.prepare("UPDATE entries SET record=json_set(record,'$.data',?) WHERE id=10").run('uncommitted'.repeat(500000));process.stdout.write('HOT\\n');setInterval(()=>{},1000);`;
      const child=spawn(process.execPath,['-e',code,path.join(hot,'durable.sqlite')],{cwd:repo,stdio:['ignore','pipe','pipe']});let reached=false,stderr='';
      const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('hot journal timeout '+stderr))},15000);
      child.stderr.on('data',d=>stderr+=d);child.stdout.on('data',d=>{if(String(d).includes('HOT')){reached=true;child.kill('SIGKILL')}});
      child.on('exit',(code,signal)=>{clearTimeout(timeout);if(reached&&signal==='SIGKILL')resolve();else reject(new Error('hot child '+code+stderr))});
    });
    assert((await fs.stat(path.join(hot,'durable.sqlite-journal'))).size>0);
    const hotBefore=await snapshot(hot);await assert.rejects(passive(hot,ctx));assert.deepEqual(await snapshot(hot),hotBefore);
    const recovered=await open(hot,ctx);assert.equal((await recovered.storage.entry(10,ctx)).entry.data,'EXACT 原文');await recovered.storage.close(ctx);recovered.lease.release();
    // POSIX fsync errors, including EPERM, must reject rather than acknowledge publication.
    for(const code of (process.platform === 'win32' ? [] : ['EIO','EPERM'])) for(const phase of ['intent','selector']) {
      const dir=path.join(tmp,`sync-${code}-${phase}`);await fs.cp(fixture,dir,{recursive:true});const pristine=await snapshot(dir,true);
      const realOpen=fs.open;let directorySyncs=0,failed=false;
      fs.open=async function(file,...args){const h=await realOpen.call(this,file,...args);if(file===dir){const realSync=h.sync.bind(h);h.sync=async()=>{directorySyncs++;if(directorySyncs===(phase==='intent'?1:3)){failed=true;throw Object.assign(new Error('injected directory fsync '+code),{code})}return realSync()}}return h};
      syncBuiltinESMExports();
      try {await assert.rejects(open(dir,ctx),error=>error.code===code);assert(failed)}
      finally {fs.open=realOpen;syncBuiltinESMExports()}
      assert.deepEqual(await snapshot(dir,true),pristine);
      if(phase==='intent')assert.equal(await fs.access(path.join(dir,'.mybuddy-storage.json')).then(()=>true,()=>false),false);
      // A rename followed by failed fsync has an unknown durable outcome. Recovery checks authority;
      // callers got rejection, not a successful writer handle or permission to replay business effects.
      const retry=await open(dir,ctx);assert.equal((await retry.storage.entry(10,ctx)).entry.data,'EXACT 原文');await retry.storage.close(ctx);retry.lease.release();
    }
    const corrupt=path.join(tmp,'corrupt');await fs.cp(fixture,corrupt,{recursive:true,preserveTimestamps:true});
    await fs.appendFile(path.join(corrupt,'main.jsonl'),'{"invalid":true}\n');const corruptBefore=await snapshot(corrupt,true);
    await assert.rejects(open(corrupt,ctx));assert.deepEqual(await snapshot(corrupt,true),corruptBefore);
    assert.equal(await fs.access(path.join(corrupt,'.mybuddy-storage.json')).then(()=>true,()=>false),false);
    const empty=path.join(tmp,'new');const h=await open(empty,ctx);await h.storage.close(ctx);h.lease.release();
    assert(exists(empty));assert.equal(await fs.access(path.join(empty,'main.jsonl')).then(()=>true,()=>false),false);
    console.log('PASS production SQLite migration: original bytes/mtime, task/submission/retired/fork state, passive coherent snapshots, fail closed, 4 real SIGKILL publication boundaries');
  } finally {await fs.rm(tmp,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
