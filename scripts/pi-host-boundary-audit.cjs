/** Whole-source inventory plus execution-boundary contracts. This is an audit/test, not a runtime gate. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),ts=require('typescript');
const root=path.resolve(__dirname,'..');process.chdir(root);
const roots=['src','app','fronts','shared'];
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?walk(path.join(dir,x.name)):[path.join(dir,x.name)])}
const files=roots.filter(fs.existsSync).flatMap(walk).filter(p=>/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)&&!/[\\/](node_modules|build|dist)[\\/]/.test(p)).sort();
const report={at:new Date().toISOString(),scope:roots,files:[],hooks:[],nativeCalls:[],violations:[],passed:false};
const digest=crypto.createHash('sha256');
for(const f of files){const file=f.replaceAll('\\','/'),text=fs.readFileSync(f,'utf8'),isTest=/\/(test|tests)\//.test(file);digest.update(file+'\0'+text+'\0');report.files.push({file,lines:text.split('\n').length,sha256:crypto.createHash('sha256').update(text).digest('hex'),test:isTest});if(isTest)continue;
  for(const symbol of ['preflightSideEffectGate','lifecycleBlockReason','agent_before_settle','shouldStopAfterTurn','gateReasons','requiredForCompletion','startBackgroundFetch'])if(new RegExp('\\b'+symbol+'\\b').test(text))report.violations.push({file,symbol});
  const sf=ts.createSourceFile(f,text,ts.ScriptTarget.Latest,true,/\.tsx$/.test(f)?ts.ScriptKind.TSX:/\.(?:mjs|cjs|js)$/.test(f)?ts.ScriptKind.JS:ts.ScriptKind.TS);
  function visit(n){if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)){
    const method=n.expression.name.text,line=sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;
    if(method==='on'&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0])&&/^(?:agent_|tool_|context$|session_|turn_|input$)/.test(n.arguments[0].text))report.hooks.push({file,line,event:n.arguments[0].text,receiver:n.expression.expression.getText(sf)});
    if(['prompt','continue','steer','followUp','sendUserMessage','sendMessage','clearQueue','setSystemPrompt','setTools','setActiveTools','replaceMessages','abort','compact','navigateTree'].includes(method))report.nativeCalls.push({file,line,method,expression:n.expression.getText(sf)});
    if(method==='sendMessage'&&n.expression.expression.getText(sf)==='pi'){
      let owner=n.parent;while(owner&&!ts.isFunctionDeclaration(owner))owner=owner.parent;
      if(file!=='src/main/capabilities/web-access/index.ts'||owner?.name?.text!=='publishUserSelectedSearch')report.violations.push({file,line,symbol:'unsolicited-pi-message'});
    }
  }ts.forEachChild(n,visit)}visit(sf);
}
const webPath='src/main/capabilities/web-access/index.ts',web=fs.readFileSync(webPath,'utf8'),sf=ts.createSourceFile(webPath,web,ts.ScriptTarget.Latest,true);
let explicitSubmissions=0;
function checkSubmission(n){if(ts.isCallExpression(n)&&n.expression.getText(sf)==='publishUserSelectedSearch'){
  explicitSubmissions++;let p=n.parent;while(p&&!ts.isMethodDeclaration(p))p=p.parent;
  if(!p||p.name.getText(sf)!=='onSubmit')report.violations.push({file:webPath,symbol:'search-submission-not-from-user'});
}ts.forEachChild(n,checkSubmission)}checkSubmission(sf);
assert.equal(explicitSubmissions,1,'Only explicit curator user submission may initiate a model request');
for(const removed of ['src/main/agent/ExecutionRouter.ts','src/main/agent/ExecutionIntentAnalyzer.ts'])if(fs.existsSync(removed))report.violations.push({file:removed,symbol:'retired-execution-controller'});
report.sourceSha256=digest.digest('hex');report.passed=report.violations.length===0;
fs.mkdirSync('artifacts/pi-host-exit',{recursive:true});fs.writeFileSync('artifacts/pi-host-exit/source-boundary-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,files:report.files.length,sourceLines:report.files.reduce((n,f)=>n+f.lines,0),hooks:report.hooks.length,nativeCallSites:report.nativeCalls.length,sourceSha256:report.sourceSha256,violations:report.violations},null,2));
process.exitCode=report.passed?0:1;
