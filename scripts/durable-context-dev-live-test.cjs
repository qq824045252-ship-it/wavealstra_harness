/** Issue #26: six distinct tasks through production pnpm dev/Electron, with transparent real-model transport. */
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const engine=process.env.CONTEXT_LIVE_ENGINE || 'billion-context';
if(!['billion-context','native'].includes(engine))throw Error('Unsupported CONTEXT_LIVE_ENGINE');
const filename=path.join(__dirname,'bot-frontdoor-live-test.cjs');
let source=fs.readFileSync(filename,'utf8');
function replace(before,after){if(!source.includes(before))throw Error('Live harness anchor changed: '+before.slice(0,80));source=source.replace(before,after);}
replace("const performanceScenario = process.argv.includes('--performance');",'const performanceScenario = true;');
source=source.replace(/const out = path.join\(root,.*?; fs.mkdirSync\(out,/,"const out = path.join(root, 'out/diagnostics/durable-context/live-' + new Date().toISOString().replace(/[:.]/g,'-')); fs.mkdirSync(out,");
replace("const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bot-frontdoor-live-')));","const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'i26-')));");
replace("remoteAccessEnabled: false, closeToTray: false, theme: 'light', permissionMode:","remoteAccessEnabled: false, closeToTray: false, theme: 'light', compactionEngine: '"+engine+"', compactionTriggerRatio: 0.8, compactionTriggerTokens: 12000, permissionMode:");
// Linux Electron rewrites argv/environ. Use the proven executable/cwd/debug-port + PID-start-time identity.
const shared=fs.readFileSync(path.join(__dirname,'usage-dashboard-dev-test.cjs'),'utf8');
const identity=shared.slice(shared.indexOf('const observedDescendants = new Map();'),shared.indexOf('function rpc('));
const identityStart=source.indexOf('function isTestElectronMain('),identityEnd=source.indexOf('function rpc(',identityStart);
if(identityStart<0||identityEnd<0||!identity)throw Error('Process-identity anchors changed');
source=source.slice(0,identityStart)+identity+source.slice(identityEnd);
replace('const body = JSON.parse(raw); requests.push(body);',`const body = JSON.parse(raw); requests.push(body);
    fs.appendFileSync(path.join(out,'provider-requests.jsonl'),JSON.stringify({at:Date.now(),body})+'\\n');`);
const start=source.indexOf('    await launch();'),end=source.indexOf("\n    const shot=await rpc('Page.captureScreenshot'",start);
if(start<0||end<0)throw Error('Scenario anchors changed');
source=source.slice(0,start)+`
    await launch();
    await until(()=>evaluate('Boolean(window.api?.agent && document.querySelector(".input-area textarea"))'),'ordinary task composer');
    const restart=async()=>{
      if(electronWatch){clearInterval(electronWatch);electronWatch=undefined;}
      await rpc('Browser.close').catch(()=>{});socket.close();socket=undefined;
      await stopTestElectronMains();if(processDev.exitCode===null)processDev.kill('SIGTERM');
      await launch();await until(()=>evaluate('Boolean(window.api?.agent && document.querySelector(".input-area textarea"))'),'restart ordinary composer');
    };
    await require('./durable-context-dev-live-scenario.cjs').run({evaluate,rpc,until,report,requests,rawUsageAudit,out,home,restart});
`+source.slice(end);
if(process.argv.includes('--check-harness')){new(require('node:vm').Script)(source,{filename});console.log('PASS context live harness syntax; no app or model launch');}
else{const runner=new Module(filename,module);runner.filename=filename;runner.paths=module.paths;runner._compile(source,filename);}
