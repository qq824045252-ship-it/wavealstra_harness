/** Parse every decoded CDP expression before starting the real Electron/model run. */
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const parser=require('@babel/parser');
const file=path.join(__dirname,'bot-collaboration-live-scenario.cjs');
const code=fs.readFileSync(file,'utf8');
new vm.Script(code,{filename:file});
const ast=parser.parse(code,{sourceType:'script'}),checks=[];
function visit(node) {
  if(!node||typeof node!=='object')return;
  if(node.type==='CallExpression'&&node.callee?.type==='Identifier'&&node.callee.name==='evaluate') {
    const argument=node.arguments[0];
    const expression=argument?.type==='StringLiteral'?argument.value
      :argument?.type==='TemplateLiteral'?argument.quasis.map((part,index)=>(index?'null':'')+part.value.cooked).join(''):undefined;
    if(expression!==undefined) {
      new vm.Script(expression,{filename:file+':evaluate-line-'+node.loc.start.line});
      checks.push({line:node.loc.start.line,dynamic:argument.type==='TemplateLiteral'&&argument.expressions.length>0});
    }
  }
  for(const value of Object.values(node)) {
    if(Array.isArray(value))for(const child of value)visit(child);
    else if(value&&typeof value==='object')visit(value);
  }
}
visit(ast);
const output=path.join(__dirname,'../out/diagnostics/issue32');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'live-scenario-preflight.json'),JSON.stringify({
  file,capturedAt:new Date().toISOString(),method:'Babel decoded literals and template text; vm.Script syntax verification; runtime verifies exact interpolated expressions',checks,
},null,2));
console.log(`collaboration live driver preflight: ${checks.length} expressions PASS`);
if(!process.argv.includes('--preflight-only')) {
  if(!process.argv.includes('--collaboration'))process.argv.push('--collaboration');
  require('./bot-frontdoor-live-test.cjs');
}
