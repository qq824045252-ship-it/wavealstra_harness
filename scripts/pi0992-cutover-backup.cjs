const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {DatabaseSync}=require('node:sqlite');
const root=path.resolve(__dirname,'..');process.chdir(root);const out=path.join(root,'artifacts/pi0992-memory');
const expectedStart=Number(process.argv[2]);if(!Number.isFinite(expectedStart)||expectedStart<1e12)throw Error('Require verified current user process start timestamp');
for(const [file,count] of [['desktop-live/results.json',8],['memory-live/results.json',7]]){const r=JSON.parse(fs.readFileSync(path.join(out,file)));if(r.status!=='passed'||r.tests.length!==count||r.tests.some(t=>t.status!=='passed'))throw Error('Final model acceptance incomplete: '+file);}
const home=path.join(os.homedir(),'.mybuddy'),db=new DatabaseSync(path.join(home,'app.db'));
try{
 const running=db.prepare("SELECT task_id,started_at FROM task_runtime_context_snapshots WHERE status='running' AND started_at>=?").all(expectedStart);
 const leases=db.prepare('SELECT task_id,expires_at FROM task_run_leases WHERE expires_at>?').all(Date.now());
 if(running.length||leases.length)throw Error('Live user tasks remain; do not interrupt them');
 const folder=path.join(home,'backups','pi0992-memory-'+new Date().toISOString().replace(/\D/g,''));fs.mkdirSync(folder,{recursive:true});const backup=path.join(folder,'app.db');
 db.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");
 const check=new DatabaseSync(backup,{readOnly:true});let integrity;try{integrity=check.prepare('PRAGMA quick_check').get().quick_check;}finally{check.close();}
 if(integrity!=='ok')throw Error('Database backup integrity check failed');
 const report={at:new Date().toISOString(),backup,bytes:fs.statSync(backup).size,integrity,noRecordedLiveTasks:true,processStartedAt:expectedStart};fs.writeFileSync(path.join(out,'cutover-backup.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{db.close();}
