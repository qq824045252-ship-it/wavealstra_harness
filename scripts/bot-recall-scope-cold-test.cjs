/** Opt-in actual-process restart probe; consumes only a completed synthetic live fixture. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const {spawnSync,execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const {buildSync}=require('esbuild');
(async()=>{
 const args=process.argv.slice(2);
 if(args.length!==2||!['--live','--check-harness'].includes(args[0]))throw Error('Usage: node scripts/bot-recall-scope-cold-test.cjs --live|--check-harness PRIOR_ARTIFACT_DIRECTORY');
 const root=fs.realpathSync(path.resolve(__dirname,'..')),tmp=fs.realpathSync(process.env.TMPDIR||os.tmpdir());
 const prior=fs.realpathSync(path.resolve(args[1]));
 assert(prior.startsWith(path.join(root,'out/diagnostics/bot-recall-scope')+path.sep),'Only this clone synthetic live fixture is allowed');
 const read=name=>JSON.parse(fs.readFileSync(path.join(prior,name),'utf8'));
 const launch=read('launch.json'),report=read('report.json'),priorCompile=read('compile-provenance.json'),exit=read('exit.json');
 assert.equal(launch.root,root);assert.deepEqual(launch.args,['--live']);assert.equal(exit.code,0);assert.equal(report.passed,24);assert.equal(report.failed,0);assert.equal(report.source.unchanged,true);assert(!report.fatal);
 const home=fs.realpathSync(launch.home);assert.equal(home,launch.home);assert(path.basename(home).startsWith('rs-'));assert(home.startsWith(tmp+path.sep),'Synthetic HOME must be under explicit TMPDIR');assert.notEqual(home,os.homedir());assert(fs.statSync(path.join(home,'app.db')).isFile());assert(fs.statSync(path.join(home,'.mybuddy')).isDirectory());
 const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const expected=process.env.BOT_RECALL_SCOPE_EXPECT_COMMIT;if(expected)assert.equal(commit,expected);
 const priorCommit=launch.commit;assert.equal(priorCommit,priorCompile.commit);
 execFileSync('git',['merge-base','--is-ancestor',priorCommit,commit],{cwd:root});
 const hash=b=>createHash('sha256').update(b).digest('hex');
 for(const [p,digest] of Object.entries(priorCompile.inputs))assert.equal(hash(fs.readFileSync(path.resolve(root,p))),digest,'Prior fixed compiler input changed: '+p);
 const out=path.join(root,'out/diagnostics/bot-recall-scope-cold',new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid);fs.mkdirSync(out,{recursive:true});
 const evidenceHashes={};for(const name of ['report.json','launch.json','model.json','compile-provenance.json','exit.json']){const bytes=fs.readFileSync(path.join(prior,name));evidenceHashes[name]=hash(bytes);if(name==='report.json')fs.writeFileSync(path.join(out,'prior-report.json'),bytes);if(name==='model.json')fs.writeFileSync(path.join(out,name),bytes);}
 const bundle=path.join(out,'scope-cold.mjs');
 const compiled=buildSync({metafile:true,absWorkingDir:root,entryPoints:['scripts/bot-recall-scope-cold-test.ts'],bundle:true,platform:'node',format:'esm',packages:'external',alias:{electron:path.join(root,'scripts/arch-electron-stub.ts')},outfile:bundle});
 const inputs=Object.fromEntries([...new Set([...Object.keys(compiled.metafile.inputs),'scripts/bot-recall-scope-cold-test.cjs','package.json','pnpm-lock.yaml'])].sort().map(p=>[p,hash(fs.readFileSync(path.resolve(root,p)))]));
 fs.writeFileSync(path.join(out,'compile-provenance.json'),JSON.stringify({commit,coldCommit:commit,priorCommit,inputs,bundleSha256:hash(fs.readFileSync(bundle)),launcherSha256:hash(fs.readFileSync(__filename)),prior,evidenceHashes},null,2));
 const env={PATH:process.env.PATH,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TMPDIR:tmp,HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),PI_CODING_AGENT_DIR:path.join(home,'.mybuddy'),BOT_RECALL_SCOPE_HOME:home,BOT_RECALL_SCOPE_OUT:out,BOT_RECALL_SCOPE_REPO:root};
 fs.writeFileSync(path.join(out,'launch.json'),JSON.stringify({commit,coldCommit:commit,priorCommit,home,out,root,args,node:process.version,parentPid:process.pid,prior,startedAt:new Date().toISOString(),modelEvidence:'Reused prior public catalog; no /models network refresh'},null,2));
 console.log('Cold recall artifacts: '+out);console.log('Reused synthetic HOME: '+home);
 const child=spawnSync(process.execPath,['--max-old-space-size=2048',bundle,args[0]],{cwd:root,env,stdio:'inherit',timeout:15*60*1000});
 fs.writeFileSync(path.join(out,'exit.json'),JSON.stringify({code:child.status,pid:child.pid,signal:child.signal,error:child.error?.message,finishedAt:new Date().toISOString()},null,2));process.exitCode=child.status??1;
})().catch(error=>{console.error(error);process.exitCode=1;});
