const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.join(__dirname,'bot-frontdoor-live-test.cjs');let source=fs.readFileSync(filename,'utf8');
source=source.replace(/const out = path.join\(root,.*?; fs.mkdirSync\(out,/, "const out = path.join(root, 'out/diagnostics/bot-result-delivery/live'); fs.mkdirSync(out,");
source=source.replace("permissionMode: teamSubagentScenario || multiDelegationScenario ? 'auto' : 'readonly'","permissionMode: 'auto'");
const start=source.indexOf('    if (commitmentQueryScenario) {',source.indexOf('const foregroundDone')),end=source.indexOf("\n    const shot=await rpc('Page.captureScreenshot'",start);
if(start<0||end<0)throw Error('Harness anchors changed');
source=source.slice(0,start)+"    await require('./bot-result-delivery-live-scenario.cjs').run({send,foregroundDone,until,evaluate,history,rpc,report,requests,out,home,modelKey,botId});\n"+source.slice(end);
const runner=new Module(filename,module);runner.filename=filename;runner.paths=module.paths;runner._compile(source,filename);
