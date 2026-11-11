/** Replay an actual persisted result DTO in a fresh isolated dev profile. No new business/model task. */
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),assert=require('node:assert/strict'),crypto=require('node:crypto');
exports.run=async({evaluate,history,rpc,until,report,out,requests})=>{
const original=JSON.parse(fs.readFileSync(path.resolve('out/diagnostics/bot-result-delivery/live/report.json'),'utf8'));
report.originalSuiteStatus=original.status;report.originalTimeout=original.cases.find(c=>c.id==='html-talk').error;
report.mode='fresh isolated profile; actual persisted result DTO replay; no business/model task';
const observed=JSON.parse(require('node:child_process').execFileSync('python',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'/.mybuddy/app.db?mode=ro',uri=True)
print(json.dumps({'statuses':[r[0] for r in c.execute('select status from work_execution_bindings')],'artifacts':[json.loads(r[0]) for r in c.execute('select payload_json from work_generated_artifacts')]}))`,original.home],{encoding:'utf8'}));
report.bindingStatuses=observed.statuses;assert(observed.statuses.every(s=>['completed','failed','stopped','invalidated'].includes(s)),'all original executions settled');
const message=original.history.messages.findLast(m=>m.workFeedback?.report?.title.includes('科学小讲堂')&&m.workFeedback.report.completion?.nextStep==='deliver');assert(message,'same actual HTML final delivery persisted');
report.message=message;const feedback=message.workFeedback.report;const work={workId:message.workFeedback.workId};
const selected=feedback.files.find(f=>f.name==='talk.html'&&feedback.primaryArtifactRefs.includes(f.ref));assert(selected?.openPath);const artifact=observed.artifacts.find(a=>a.snapshotPath===selected.openPath);assert(artifact);report.registeredArtifact=artifact;
await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.setState({botHistories:{['bot-mybuddy-default']:${JSON.stringify({...original.history,messages:[message]})}}}))`);
report.file={...selected,digest:crypto.createHash('sha256').update(fs.readFileSync(selected.openPath)).digest('hex')};assert.equal(report.file.digest,artifact.digest);
const recordings=JSON.parse(fs.readFileSync(path.resolve('out/diagnostics/bot-result-delivery/live/provider-requests.json'),'utf8'));
report.reviewInputs=recordings.flatMap(r=>r.messages||[]).filter(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('{"temporalContext"')).map(m=>JSON.parse(m.content.slice(m.content.indexOf('{"temporalContext"')))).filter(v=>v.originalRequest.workId===work.workId).map(v=>v.availableFiles);
assert(report.reviewInputs.some(files=>files.some(f=>f.ref===selected.ref)),'selection from original real review availableFiles');
const selector=`[data-message-id="${message.messageId}"]`;await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),'persisted HTML message');
await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);await new Promise(r=>setTimeout(r,400));
report.presentation=await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});return {text:el.innerText,body:el.querySelector('.bot-result-body')?.innerText,details:[...el.querySelectorAll('details')].map(d=>({label:d.querySelector('summary')?.innerText,open:d.open})),files:[...el.querySelectorAll('.bot-result-files strong')].filter(e=>e.getBoundingClientRect().height>0).map(e=>e.innerText)}})()`);
assert(report.presentation.files.includes('talk.html'));assert(report.presentation.body.includes('蒸发'));assert(report.presentation.details.filter(d=>d.label==='执行详情与来源').every(d=>!d.open));
const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'html-talk-after-timeout.png'),Buffer.from(shot.data,'base64'));
assert(await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const button=el.querySelector('[aria-label="打开 talk.html"]');if(!button||button.getBoundingClientRect().height===0)return false;button.click();return true;})()`));await new Promise(r=>setTimeout(r,800));
report.openError=await evaluate(`document.querySelector(${JSON.stringify(selector)})?.querySelector('.bot-result-attachments [role=alert]')?.innerText||''`);assert.equal(report.openError,'');
report.recheckModelCalls=requests.length;assert.equal(requests.length,0,'read-only recheck generated no new model task');report.checks.push('Same HTML task completed after original 240s timeout; persisted exact selected snapshot verified and opened through real Electron UI. Original suite failure remains preserved.');
};
if(require.main===module){
const filename=path.join(__dirname,'bot-frontdoor-live-test.cjs');let source=fs.readFileSync(filename,'utf8');const original=JSON.parse(fs.readFileSync(path.resolve('out/diagnostics/bot-result-delivery/live/report.json'),'utf8'));
source=source.replace(/const out = path.join\(root,.*?; fs.mkdirSync\(out,/,"const out = path.join(root, 'out/diagnostics/bot-result-delivery/recheck'); fs.mkdirSync(out,");
// Keep the harness fresh temporary profile: never reopen model-enabled source profile.
const start=source.indexOf('    if (commitmentQueryScenario) {',source.indexOf('const foregroundDone')),end=source.indexOf("\n    const shot=await rpc('Page.captureScreenshot'",start);assert(start>0&&end>start);
source=source.slice(0,start)+"    await require('./bot-result-delivery-dev-recheck.cjs').run({evaluate,history,rpc,until,report,out,requests});\n"+source.slice(end);
const runner=new Module(filename,module);runner.filename=filename;runner.paths=module.paths;runner._compile(source,filename);
}
