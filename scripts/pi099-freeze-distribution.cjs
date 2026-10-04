/** Freeze a completed distribution before final validation; never overwrite another build. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');process.chdir(root);
const source=path.resolve('release-pi099-closeout/win-unpacked');
const pack=JSON.parse(fs.readFileSync('artifacts/pi099-closeout/pack/results.json','utf8'));
if(pack.status!=='passed')throw Error('The source distribution is still being built; do not copy a partial build.');
const critical=['MyBuddy.exe','resources/app.asar','resources/app.asar.unpacked/out/main/codemode-worker.cjs','resources/app.asar.unpacked/out/main/quickjs.wasm'];
const signature=()=>critical.map(file=>{const s=fs.statSync(path.join(source,file));return {file,size:s.size,mtime:s.mtimeMs};});
const before=signature();
const name='release-pi099-verified-'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,17);
const destination=path.resolve(name,'win-unpacked');
if(fs.existsSync(destination))throw Error('Snapshot destination already exists');
fs.cpSync(source,destination,{recursive:true,dereference:true,errorOnExist:true,force:false});
if(JSON.stringify(before)!==JSON.stringify(signature())){fs.rmSync(path.dirname(destination),{recursive:true,force:true});throw Error('Source changed during copy; the partial snapshot was removed.');}
async function hash(file){const h=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
(async()=>{
 const files=[];for(const file of critical)files.push({file,size:fs.statSync(path.join(destination,file)).size,sha256:await hash(path.join(destination,file))});
 const report={createdAt:new Date().toISOString(),sourcePackStartedAt:pack.startedAt,sourcePackFinishedAt:pack.finishedAt,destination,executable:path.join(destination,'MyBuddy.exe'),files};
 fs.mkdirSync('artifacts/pi099-migration/frozen',{recursive:true});fs.writeFileSync('artifacts/pi099-migration/frozen/distribution.json',JSON.stringify(report,null,2));
 const testSource=fs.readFileSync('scripts/pi099-desktop-live.cjs','utf8');
 const sourceSnapshotSetup="const inventoryRoot=path.join(temp,'repository-snapshot');fs.cpSync(path.join(root,'src'),path.join(inventoryRoot,'src'),{recursive:true,dereference:true});\n";
 let test=testSource.replace("const out=path.join(root,'artifacts/pi099-closeout/desktop-live')","const out=path.join(root,'artifacts/pi099-migration/frozen/desktop-live')");
 test=test.replace("const sourceHome=path.join(os.homedir(),'.mybuddy');",sourceSnapshotSetup+"const sourceHome=path.join(os.homedir(),'.mybuddy');");
 test=test.replace('workspace,root],exposure:', 'workspace,inventoryRoot],exposure:');
 test=test.replace("path.relative(root,f).replaceAll", "path.relative(inventoryRoot,f).replaceAll");
 test=test.replace("walk(path.join(root,'src'))", "walk(path.join(inventoryRoot,'src'))");
 test=test.replace("path.join(root,'release-pi099-closeout/win-unpacked/MyBuddy.exe')",JSON.stringify(report.executable));
 if(test===testSource||!test.includes('workspace,inventoryRoot]'))throw Error('Desktop fixture adaptation failed');
 fs.writeFileSync('scripts/pi099-frozen-desktop-live.cjs',test);
 console.log(JSON.stringify({executable:report.executable,criticalFiles:files.length,snapshotStable:true},null,2));
})().catch(error=>{console.error(error);process.exitCode=1;});
