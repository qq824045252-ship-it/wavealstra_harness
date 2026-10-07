/** Whole-source inventory plus execution-boundary contracts. This is an audit/test, not a runtime gate. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),parser=require('@babel/parser');
const root=path.resolve(__dirname,'..');process.chdir(root);
const roots=['src','app','fronts','shared'];
const excludedDirectories=new Set(['node_modules','build','dist']);
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?(excludedDirectories.has(x.name)?[]:walk(path.join(dir,x.name))):[path.join(dir,x.name)])}
const files=roots.filter(fs.existsSync).flatMap(walk).filter(p=>/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)).sort();
function parse(file,text){return parser.parse(text,{sourceType:'unambiguous',sourceFilename:file,plugins:[...(/\.tsx?$/.test(file)?['typescript']:[]),...(/\.(tsx|jsx|js)$/.test(file)?['jsx']:[])],createParenthesizedExpressions:true,allowReturnOutsideFunction:true})}
function visitAst(root,visitor){
  const ancestors=[];
  function visit(node){
    visitor(node,ancestors);ancestors.push(node);
    for(const [key,value]of Object.entries(node)){
      if(['loc','extra','comments','leadingComments','trailingComments','innerComments','tokens','errors'].includes(key))continue;
      if(Array.isArray(value)){for(const child of value)if(child&&typeof child.type==='string')visit(child)}
      else if(value&&typeof value.type==='string')visit(value);
    }
    ancestors.pop();
  }
  visit(root);
}
const isCall=node=>node.type==='CallExpression'||node.type==='OptionalCallExpression';
const isPropertyAccess=node=>(node.type==='MemberExpression'||node.type==='OptionalMemberExpression')&&!node.computed&&node.property.type==='Identifier';
const isMethod=node=>['ObjectMethod','ClassMethod','ClassPrivateMethod'].includes(node.type);
const sourceText=(text,node)=>text.slice(node.start,node.end);
const report={at:new Date().toISOString(),scope:roots,files:[],hooks:[],nativeCalls:[],violations:[],passed:false};
const digest=crypto.createHash('sha256');
for(const f of files){const file=f.replaceAll('\\','/'),text=fs.readFileSync(f,'utf8'),isTest=/\/(test|tests)\//.test(file);digest.update(file+'\0'+text+'\0');report.files.push({file,lines:text.split('\n').length,sha256:crypto.createHash('sha256').update(text).digest('hex'),test:isTest});if(isTest)continue;
  for(const symbol of ['preflightSideEffectGate','lifecycleBlockReason','agent_before_settle','shouldStopAfterTurn','gateReasons','requiredForCompletion','startBackgroundFetch'])if(new RegExp('\\b'+symbol+'\\b').test(text))report.violations.push({file,symbol});
  const sf=parse(f,text);
  visitAst(sf,(n,ancestors)=>{if(isCall(n)&&isPropertyAccess(n.callee)){
    const method=n.callee.property.name,line=n.loc.start.line;
    if(method==='on'&&n.arguments[0]?.type==='StringLiteral'&&/^(?:agent_|tool_|context$|session_|turn_|input$)/.test(n.arguments[0].value))report.hooks.push({file,line,event:n.arguments[0].value,receiver:sourceText(text,n.callee.object)});
    if(['prompt','continue','steer','followUp','sendUserMessage','sendMessage','clearQueue','setSystemPrompt','setTools','setActiveTools','replaceMessages','abort','compact','navigateTree'].includes(method))report.nativeCalls.push({file,line,method,expression:sourceText(text,n.callee)});
    if(method==='sendMessage'&&sourceText(text,n.callee.object)==='pi'){
      const owner=ancestors.findLast(node=>node.type==='FunctionDeclaration');
      if(file!=='src/main/capabilities/web-access/index.ts'||owner?.id?.name!=='publishUserSelectedSearch')report.violations.push({file,line,symbol:'unsolicited-pi-message'});
    }
  }});
}
const webPath='src/main/capabilities/web-access/index.ts',web=fs.readFileSync(webPath,'utf8'),sf=parse(webPath,web);
let explicitSubmissions=0;
visitAst(sf,(n,ancestors)=>{if(isCall(n)&&sourceText(web,n.callee)==='publishUserSelectedSearch'){
  explicitSubmissions++;const owner=ancestors.findLast(isMethod);
  if(!owner||sourceText(web,owner.key)!=='onSubmit')report.violations.push({file:webPath,symbol:'search-submission-not-from-user'});
}});
assert.equal(explicitSubmissions,1,'Only explicit curator user submission may initiate a model request');
for(const removed of ['src/main/agent/ExecutionRouter.ts','src/main/agent/ExecutionIntentAnalyzer.ts'])if(fs.existsSync(removed))report.violations.push({file:removed,symbol:'retired-execution-controller'});
report.sourceSha256=digest.digest('hex');report.passed=report.violations.length===0;
fs.mkdirSync('artifacts/pi-host-exit',{recursive:true});fs.writeFileSync('artifacts/pi-host-exit/source-boundary-audit.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:report.passed,files:report.files.length,sourceLines:report.files.reduce((n,f)=>n+f.lines,0),hooks:report.hooks.length,nativeCallSites:report.nativeCalls.length,sourceSha256:report.sourceSha256,violations:report.violations},null,2));
process.exitCode=report.passed?0:1;
