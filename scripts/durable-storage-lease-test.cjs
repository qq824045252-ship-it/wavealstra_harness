/** Synthetic single-writer mutex tests; never opens user storage. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const esbuild = require('esbuild');
const repo = path.resolve(__dirname, '..');
const snapshot = async dir => Object.fromEntries(await Promise.all((await fs.readdir(dir)).sort().map(async n => {
  const p = path.join(dir,n), st = await fs.stat(p); return [n, [st.mtimeMs,(await fs.readFile(p)).toString('base64')]];
})));
(async () => {
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR || require('node:os').tmpdir(), 'durable-lease-'));
  const children = [];
  try {
    await fs.symlink(path.join(repo,'node_modules'), path.join(tmp,'node_modules'), 'dir');
    const output = path.join(tmp,'lease.cjs');
    const compiled = await esbuild.build({write:false,entryPoints:[path.join(repo,'src/main/agent/durable/DurableStorageLease.ts')],outfile:output,bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
    await fs.writeFile(output, compiled.outputFiles[0].contents);
    const api = require(output);
    const dir = path.join(tmp,'synthetic');
    const lease = api.claimDurableStorageLease(dir);
    assert.throws(() => api.claimDurableStorageLease(dir), {code:'DURABLE_STORAGE_OWNED'});
    const before = await snapshot(dir);
    assert.equal(api.durableStorageOwnerState(dir),'active');
    assert.deepEqual(await snapshot(dir),before,'passive state changes no bytes, mtimes or inventory');
    lease.release();
    const next = api.claimDurableStorageLease(dir);
    lease.release();
    assert.throws(() => api.claimDurableStorageLease(dir), {code:'DURABLE_STORAGE_OWNED'},'old release cannot unlock new owner');
    next.release();
    await fs.writeFile(path.join(dir,'.mybuddy-owner.json'),JSON.stringify({format:1,pid:process.pid,token:'legacy',startedAt:1,updatedAt:1}));
    const metadataOnly = api.claimDurableStorageLease(dir);
    assert.equal(api.durableStorageOwnerState(dir),'active','current SQLite mutex, not legacy metadata, owns exclusion');
    metadataOnly.release();
    const worker = path.join(tmp,'worker.cjs');
    await fs.writeFile(worker, `const api=require(${JSON.stringify(output)}); process.on('message', m=>{if(m==='start'){try {global.lease=api.claimDurableStorageLease(process.argv[2]);process.send({held:true});}catch(e){process.send({held:false,code:e.code});}}else if(m==='release'){global.lease?.release();process.exit(0);}});process.send({ready:true});`);
    const launch = () => {const c=spawn(process.execPath,[worker,dir],{stdio:['ignore','inherit','inherit','ipc']});children.push(c);return c;};
    const guarded = api.claimDurableStorageLease(dir);
    assert.throws(() => api.claimDurableStorageLease(dir), {code:'DURABLE_STORAGE_OWNED'});
    const outsider = launch(); await once(outsider,'message');
    const denied = once(outsider,'message'); outsider.send('start');
    assert.equal((await denied)[0].code,'DURABLE_STORAGE_OWNED','closing failed same-process handle must not unlock the winner');
    guarded.release();
    const workers=Array.from({length:8},launch);
    await Promise.all(workers.map(c=>once(c,'message')));
    const answers=workers.map(c=>once(c,'message').then(([m])=>({c,...m})));
    for(const c of workers)c.send('start');
    const results=await Promise.all(answers);
    assert.equal(results.filter(x=>x.held).length,1,'exactly one simultaneous claimant wins');
    for(const x of results.filter(x=>!x.held))assert.equal(x.code,'DURABLE_STORAGE_OWNED');
    const winner=results.find(x=>x.held).c;
    const dead=once(winner,'exit');winner.kill('SIGKILL');await dead;
    assert.equal(api.durableStorageOwnerState(dir),'inactive');
    const recovered=api.claimDurableStorageLease(dir);
    assert.equal(api.durableStorageOwnerState(dir),'active');
    recovered.release();
    assert.equal(api.durableStorageOwnerState(dir),'inactive');
    assert((await fs.readdir(dir)).includes('.mybuddy-writer-lock.sqlite'),'mutex inode is retained');
    console.log('PASS durable lease: same-process exclusion, idempotent release, passive bytes/mtime/inventory, advisory metadata, 8-process race, SIGKILL recovery');
  } finally {
    await Promise.all(children.filter(c=>c.exitCode===null&&c.signalCode===null).map(async c=>{const exited=once(c,'exit');c.kill('SIGKILL');await exited;}));
    await fs.rm(tmp,{recursive:true,force:true});
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
