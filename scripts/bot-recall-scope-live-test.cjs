/** Opt-in, isolated production AgentService scope/reauthorization live acceptance. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawnSync,execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {buildSync}=require('esbuild');
const {loadLiveModel}=require('./bot-live-model-config.cjs');
(async()=>{
 const args=process.argv.slice(2);
 if(args.length!==1||!['--live','--check-harness'].includes(args[0])) throw Error('Usage: node scripts/bot-recall-scope-live-test.cjs --live | --check-harness');
 const root=path.resolve(__dirname,'..'),tmp=fs.realpathSync(process.env.TMPDIR||os.tmpdir());
 if(tmp===root||tmp.startsWith(root+path.sep)) throw Error('TMPDIR must be outside repository');
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const expected=process.env.BOT_RECALL_SCOPE_EXPECT_COMMIT;
 if(expected&&commit!==expected) throw Error('Fixed source commit mismatch');
 const home=fs.mkdtempSync(path.join(tmp,'rs-'));
 const out=path.join(root,'out/diagnostics/bot-recall-scope',new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid); fs.mkdirSync(out,{recursive:true});
 const model= args[0]==='--live' ? await loadLiveModel('http://127.0.0.1:3425/v1','opendesign/deepseek-v4.1-flash') : null;
 fs.writeFileSync(path.join(out,'model.json'),JSON.stringify(model,null,2));
 const bundle=path.join(out,'scope-live.mjs');
 const compiled=buildSync({metafile:true,absWorkingDir:root,entryPoints:['scripts/bot-recall-scope-live-test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',alias:{electron:path.join(root,'scripts/arch-electron-stub.ts')},outfile:bundle});
 const hash=b=>createHash('sha256').update(b).digest('hex');
 const inputs=Object.fromEntries([...new Set([...Object.keys(compiled.metafile.inputs),'scripts/bot-recall-scope-live-test.cjs','scripts/bot-live-model-config.cjs','package.json','pnpm-lock.yaml'])].sort().map(p=>[p,hash(fs.readFileSync(path.resolve(root,p)))]));
 fs.writeFileSync(path.join(out,'compile-provenance.json'),JSON.stringify({commit,inputs,bundleSha256:hash(fs.readFileSync(bundle)),launcherSha256:hash(fs.readFileSync(__filename))},null,2));
 const env={PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:tmp,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),PI_CODING_AGENT_DIR:path.join(home,'.mybuddy'),BOT_RECALL_SCOPE_HOME:home,BOT_RECALL_SCOPE_OUT:out,BOT_RECALL_SCOPE_REPO:root};
 fs.writeFileSync(path.join(out,'launch.json'),JSON.stringify({commit,home,out,root,args,node:process.version,startedAt:new Date().toISOString()},null,2));
 console.log('Recall scope artifacts: '+out);console.log('Isolated HOME: '+home);
 const child=spawnSync(process.execPath,['--max-old-space-size=2048',bundle,...args],{cwd:root,env,stdio:'inherit',timeout:25*60*1000});
 fs.writeFileSync(path.join(out,'exit.json'),JSON.stringify({code:child.status,signal:child.signal,error:child.error?.message,finishedAt:new Date().toISOString()},null,2));process.exitCode=child.status??1;
})().catch(error=>{console.error(error);process.exitCode=1;});
