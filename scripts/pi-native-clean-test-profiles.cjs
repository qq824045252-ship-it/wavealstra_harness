/** Remove only this acceptance harness's identified temporary profiles, including copied credentials. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
process.chdir(path.resolve(__dirname,'..'));
const out='artifacts/pi-native-control';
if(fs.existsSync(path.join(out,'desktop-live/acceptance.lock')))throw Error('Acceptance is still active; refusing cleanup');
const removed=[],skipped=[];
for(const entry of fs.readdirSync(os.tmpdir(),{withFileTypes:true})){
 if(!entry.isDirectory()||entry.isSymbolicLink()||!entry.name.startsWith('native-pi-desktop-'))continue;
 const dir=path.join(os.tmpdir(),entry.name),validator=path.join(dir,'workspace/validate.cjs');
 const settings=path.join(dir,'profile/.mybuddy/settings.json');
 if(!fs.existsSync(validator)||!fs.existsSync(settings)){skipped.push({name:entry.name,reason:'missing harness markers'});continue;}
 const code=fs.readFileSync(validator,'utf8');
 const config=JSON.parse(fs.readFileSync(settings,'utf8'));
 if(!code.includes('INPUT_INVALID: repair.json must contain enabled=true')||!code.includes('source:\'real-node\'')||config.defaultProvider!=='commandcode'||config.memoryEnabled!==false){skipped.push({name:entry.name,reason:'harness markers do not match'});continue;}
 fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:200});removed.push(entry.name);
}
const report={at:new Date().toISOString(),removed,skipped};
fs.writeFileSync(path.join(out,'temporary-profile-cleanup.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
