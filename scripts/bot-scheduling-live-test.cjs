/** Issue 27 acceptance: reuse the real pnpm-dev/Electron transport, never a fake model. */
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module');
const filename = path.join(__dirname, 'bot-frontdoor-live-test.cjs');
let source = fs.readFileSync(filename, 'utf8');
function replaceOnce(before, after) {
  if (!source.includes(before)) throw Error('Frontdoor harness anchor changed: ' + before.slice(0, 90));
  source = source.replace(before, after);
}
replaceOnce("const out = path.join(root, performanceScenario", "const out = path.join(root, performanceScenario");
source = source.replace(/const out = path.join\(root,.*?; fs.mkdirSync\(out,/, "const out = path.join(root, 'out/diagnostics/bot-scheduling/batch-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid); fs.mkdirSync(out,");
replaceOnce("permissionMode: teamMissingScenario || teamSubagentScenario || multiDelegationScenario ? 'auto' : 'readonly'", "permissionMode: 'auto'");
// Enable transparent SSE timing, not output-pressure or model response modification.
replaceOnce("const performanceScenario = process.argv.includes('--performance');", 'const performanceScenario = true;');
replaceOnce("const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-frontdoor-live-')));", "const home = fs.realpathSync(process.env.BOT_SCHEDULING_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'i27-')));");
replaceOnce('    if (teamSubagentScenario) {', `    fs.writeFileSync(path.join(agentDir,'web-search.json'),JSON.stringify({workflow:'none',searchPolicy:{mode:'fallback',providers:['exa'],providerTimeoutMs:30000,totalTimeoutMs:45000,maxRequests:2,verifySources:false}}));
    if (teamSubagentScenario) {`);
// Persist every real transport request before forwarding; retain exact route and count on interruption.
replaceOnce('const body = JSON.parse(raw); requests.push(body);', `const body = JSON.parse(raw); requests.push(body);
    fs.appendFileSync(path.join(out,'provider-requests.jsonl'),JSON.stringify({requestIndex:requests.length-1,at:Date.now(),body})+'\\n');
    fs.writeFileSync(path.join(out,'call-count.json'),JSON.stringify({at:Date.now(),requests:requests.length,models:[...new Set(requests.map(r=>r.model))]},null,2));`);
replaceOnce('(async () => {\n  try {', `
let interrupting=false;
for(const signal of ['SIGINT','SIGTERM']) process.once(signal,async()=>{
  if(interrupting)return;interrupting=true;
  report.status='interrupted';report.interruption={signal,at:Date.now(),modelCalls:requests.length};
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'interruption.json'),JSON.stringify(report.interruption,null,2));
  fs.writeFileSync(path.join(out,'raw-usage-audit.json'),JSON.stringify(rawUsageAudit,null,2));
  if(electronWatch)clearInterval(electronWatch);
  await stopTestElectronMains();
  if(processDev&&processDev.exitCode===null)processDev.kill('SIGTERM');
  provider.closeAllConnections();process.exit(130);
});
(async () => {
  try {`);
// A frozen source copy need not contain .git. Fingerprint the actual test inputs instead.
const sourceLine = source.split('\n').find(line=>line.includes('if (performanceScenario) report.source ='));
if(!sourceLine)throw Error('source provenance anchor changed');
replaceOnce(sourceLine, `    const fingerprint=()=>{const hash=require('node:crypto').createHash('sha256');let count=0;
      const walk=dir=>{for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()){hash.update(path.relative(root,p));hash.update(fs.readFileSync(p));count++;}}};
      walk(path.join(root,'src'));if(fs.existsSync(path.join(root,'shared')))walk(path.join(root,'shared'));if(fs.existsSync(path.join(root,'resources')))walk(path.join(root,'resources'));for(const name of ['package.json','pnpm-lock.yaml','scripts/bot-frontdoor-live-test.cjs','scripts/bot-scheduling-live-test.cjs','scripts/bot-scheduling-live-scenario.cjs']){const p=path.join(root,name);hash.update(name);hash.update(fs.readFileSync(p));count++;}return {sha256:hash.digest('hex'),files:count};};
    report.source={root,capturedAt:Date.now(),fingerprint:fingerprint(),snapshotLabel:process.env.BOT_SCHEDULING_SNAPSHOT||'UNVERIFIED_SOURCE_COPY'};
    fs.writeFileSync(path.join(out,'source-provenance.json'),JSON.stringify(report.source,null,2));
    report.performanceCaveat=process.env.BOT_SCHEDULING_LOAD_NOTE||'Isolated live batch; unrelated host load unmeasured. Empirical probe percentiles have a small sample and are not an SLA.';`);

const start = source.indexOf('    if (performanceScenario) {', source.indexOf('const foregroundDone'));
const end = source.indexOf("\n    const shot=await rpc('Page.captureScreenshot'", start);
if (start < 0 || end < 0) throw Error('Frontdoor scenario anchors changed');
source = source.slice(0, start) + `
    const restart = async () => {
      if (electronWatch) { clearInterval(electronWatch); electronWatch=undefined; }
      await rpc('Browser.close').catch(()=>{}); socket.close(); socket=undefined;
      await stopTestElectronMains();
      if (processDev.exitCode===null) processDev.kill('SIGTERM');
      await launch();
      await until(()=>evaluate('Boolean(window.api?.botWork?.history && document.querySelector(".sidebar-user-main"))'),'restart preload');
      if(!await evaluate('Boolean(document.querySelector("#bot-draft"))')) {
        await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Bot 模式"))'),'restart navigation');
        await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Bot 模式")).click()');
      }
      await until(()=>evaluate('Boolean(document.querySelector("#bot-draft"))'),'restart composer');
    };
    await require('./bot-scheduling-live-scenario.cjs').run({send,foregroundDone,until,evaluate,history,rpc,report,requests,rawUsageAudit,out,home,modelKey,botId,restart});
    report.source.finishedFingerprint=fingerprint();
    assert.equal(report.source.finishedFingerprint.sha256,report.source.fingerprint.sha256,'frozen source must not change during live batch');
` + source.slice(end);
if (process.argv.includes('--check-harness')) {
  new (require('node:vm').Script)(source, {filename});
  console.log('PASS scheduling harness compilation; no app launch or inference');
} else {
  const runner = new Module(filename, module); runner.filename=filename; runner.paths=module.paths; runner._compile(source,filename);
}
