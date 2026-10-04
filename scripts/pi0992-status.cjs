const fs=require('node:fs');
for(const file of ['upgrade-results.json','memory-regression.json','native-regression.json','integration-regression.json','memory-race-results.json','memory-capsule-results.json','build-latest.json','android/build-results.json','desktop-live/results.json','memory-live/results.json']){
 const p='artifacts/pi0992-memory/'+file;if(!fs.existsSync(p))continue;
 let d=JSON.parse(fs.readFileSync(p,'utf8'));if(d.report)d=JSON.parse(fs.readFileSync(d.report,'utf8'));
 console.log(JSON.stringify({file,status:d.status??d.passed,pid:d.pid??d.harnessPid,error:d.error,executable:d.executable,apk:d.apk,deviceAvailable:d.deviceAvailable,steps:d.steps?.map(s=>({name:s.name,status:s.status??s.passed})),tests:(d.tests||d.results)?.map(t=>({name:t.name,status:t.status??t.passed,error:t.error,progress:t.progress}))}));
}
