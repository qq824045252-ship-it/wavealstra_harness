const fs=require('node:fs'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
const resolve=new Function(stripTypeScriptTypes(fs.readFileSync('src/main/agent/work/BotWorkTargetSelection.ts','utf8')).replace(/export /g,'')+';return resolveWorkTarget')();
let count=0;function check(text,id,action,ok){const result=resolve({userText:text,explicitWorkIds:['work-a','work-b'],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'work-a',title:'Alpha report'},{workId:'work-b',title:'Beta report'}],openWorksComplete:true,requestedWorkId:id,requestedAction:action});assert.equal(result.ok,ok,`${text} / ${action}(${id})`);count++;}
for(const prefix of ["Don't",'Do not','Never','Not','Don’t']){const text=`${prefix} pause work-a; resume work-b`;check(text,'work-a','pause',false);check(text,'work-b','resume',true);check(text,'work-b','cancel',false);}
for(const text of ["Don't pause work-a and resume work-b","Do not pause work-a or resume work-b","Never pause work-a, resume work-b"]){check(text,'work-a','pause',false);check(text,'work-b','resume',false);}
for(const text of ["Don't pause work-a but resume work-b","Do not pause work-a; instead resume work-b"]){check(text,'work-a','pause',false);check(text,'work-b','resume',true);}
check('pause work-a; resume work-b','work-a','pause',true);check('pause work-a; resume work-b','work-b','resume',true);check('不要暂停 work-a；恢复 work-b','work-a','pause',false);check('不要暂停 work-a；恢复 work-b','work-b','resume',true);check('暂停 work-a；恢复 work-b','work-a','pause',true);
for (const text of ["Do not cancel work-a; pause work-b", "Never stop work-a; resume work-b", "Not amend work-a; resume work-b"]) {check(text,'work-a','cancel',false);check(text,'work-b',text.includes('pause work-b')?'pause':'resume',true);}
check('resume work-a; do not pause work-b','work-a','resume',true);
check('resume work-a; do not pause work-b','work-b','pause',false);
check('pause Alpha report; resume Beta report','work-a','pause',true);
check("Don't pause Alpha report; resume Beta report",'work-a','pause',false);
check("Don't pause Alpha report; resume Beta report",'work-b','resume',true);
for(const prefix of ["Don't ever",'Do not immediately',"I don't want you to",'Never ever']) {check(`${prefix} pause work-a; resume work-b`,'work-a','pause',false);check(`${prefix} pause work-a; resume work-b`,'work-b','resume',true);}
for(const title of ['Alpha but Beta','Instead report','Not pause report','Do not pause']) {const facts={userText:`pause ${title}; resume Beta report`,explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'work-a',title},{workId:'work-b',title:'Beta report'}],openWorksComplete:true,requestedWorkId:'work-a',requestedAction:'pause'};assert.equal(resolve(facts).ok,true,title);count++;}
for(const title of ['Do not pause',"Don't ever",'not immediately']) {const userText=title==='Do not pause'?'Do not pause work-a':title==="Don't ever"?"Don't ever pause work-a; resume work-b":'Do not immediately pause work-a; resume work-b';assert.equal(resolve({userText,explicitWorkIds:['work-a','work-b'],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'work-a',title:'Alpha report'},{workId:'work-b',title:'Beta report'},{workId:'work-c',title}],openWorksComplete:true,requestedWorkId:'work-a',requestedAction:'pause'}).ok,false,title);count++;}
check('Pause work-a, not work-b','work-a','pause',true);check('Pause work-a, not work-b','work-b','pause',false);
for(const text of ['If not ready; pause work-a; resume work-b','If not ready:\npause work-a; resume work-b']) {check(text,'work-a','pause',false);check(text,'work-b','resume',false);}
for(const title of ['Alpha but Beta','Instead report','Not pause report','Do not pause']) {assert.equal(resolve({userText:`pause ${title}.`,explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'work-a',title}],openWorksComplete:true,requestedWorkId:'work-a',requestedAction:'pause'}).ok,true,title+'.');count++;}
for(const prefix of ["You mustn't","You shouldn't","You wouldn't","You can't",'禁止']){check(`${prefix} pause work-a; resume work-b`,'work-a','pause',false);check(`${prefix} pause work-a; resume work-b`,'work-b','resume',true);}
for(const text of ['Do not:\npause work-a; resume work-b','Never:\npause work-a\nresume work-b','禁止：\npause work-a\nresume work-b']){check(text,'work-a','pause',false);check(text,'work-b','resume',false);}
check('Do not:\npause work-a; now resume work-b','work-a','pause',false);check('Do not:\npause work-a; now resume work-b','work-b','resume',true);

for (const context of [{selectedWorkId:'work-a'}, {referencedWorkIds:['work-a']}]) {
 const base={userText:'',explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'work-a',title:'Alpha report'},{workId:'work-b',title:'Beta report'}],openWorksComplete:true,requestedWorkId:'work-a',...context};
 for(const [text,action] of [["Don't pause it; thanks",'pause'],['Do not cancel this task. Thank you.','cancel'],['不要暂停它；谢谢','pause'],['别取消这个任务，谢谢','cancel'],["Don't pause it; pause it",'pause'],['不要暂停它；暂停它','pause']]) {
  assert.equal(resolve({...base,userText:text,requestedAction:action}).ok,false,text);count++;
 }
 for(const [text,action,id] of [["Don't pause it; resume work-b",'resume','work-b'],['不要暂停它；恢复 work-b','resume','work-b'],["Don't pause it; now resume it",'resume','work-a'],['不要暂停它；现在恢复它','resume','work-a']]) {
  assert.equal(resolve({...base,userText:text,explicitWorkIds:text.includes('work-b')?['work-b']:[],requestedAction:action,requestedWorkId:id}).ok,true,text);count++;
 }
}

for(const title of ['This report','Pause this report','这个报告项目']) {
 const facts={userText:'Do not pause '+title+'; pause work-a',explicitWorkIds:['work-a'],referencedWorkIds:[],selectedWorkId:'work-a',linkedWorkIds:[],openWorks:[{workId:'work-a',title:'Alpha report'},{workId:'work-b',title}],openWorksComplete:true,requestedWorkId:'work-a',requestedAction:'pause'};
 assert.equal(resolve(facts).ok,true,title+' must not become a contextual pronoun');count++;
 assert.equal(resolve({...facts,requestedWorkId:'work-b'}).ok,false,title+' remains forbidden');count++;
}

for(const text of ['不要暂停这个报告项目；暂停 work-a','Do not cancel This report; do not pause it; thanks']) {
 const facts={userText:text,explicitWorkIds:text.includes('work-a')?['work-a']:[],referencedWorkIds:[],selectedWorkId:'work-a',linkedWorkIds:[],openWorks:[{workId:'work-a',title:'Alpha report'},{workId:'work-b',title:text.startsWith('不要')?'这个报告项目':'This report'}],openWorksComplete:true,requestedWorkId:'work-a',requestedAction:'pause'};
 assert.equal(resolve(facts).ok,text.startsWith('不要'),text);count++;
}
console.log('PASS '+count+' negative/action target checks');

// Restricted repair/change wording must not authorize negated or broadened instructions.
for (const prefix of ['不要','别','不必','不用','无需','不能','不应','不该','禁止','不许','不得','不','并非','并不','绝非','非','绝不','决不']) {
 for(const action of ['只修','仅修','只改','仅改']) {
  const text=`${prefix}${action}历史读取，不动长期记忆`;
  const facts={userText:text,explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'a',title:'历史读取优化'},{workId:'b',title:'长期记忆优化'}],openWorksComplete:true,requestedWorkId:'a',requestedAction:'amend'};
  assert.equal(resolve(facts).ok,false,text);count++;
 }
}
for(const action of ['只修','仅修','只改','仅改']) {
 const facts={userText:`这轮${action}历史读取，不动长期记忆`,explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'a',title:'历史读取优化'},{workId:'b',title:'长期记忆优化'}],openWorksComplete:true,requestedWorkId:'a',requestedAction:'amend'};
 assert.equal(resolve(facts).ok,true,facts.userText);count++;
 assert.equal(resolve({...facts,requestedAction:'pause'}).ok,false,'repair does not authorize pause');count++;
}
console.log('PASS '+count+' total negative/action target checks including restricted wording');
for(const title of ['不要修改报告','不仅是报告','禁止改动测试'])for(const action of ['只修','仅修','只改','仅改']){
 const facts={userText:`${action}${title}，不动其他任务`,explicitWorkIds:[],referencedWorkIds:[],linkedWorkIds:[],openWorks:[{workId:'a',title}],openWorksComplete:true,requestedWorkId:'a',requestedAction:'amend'};
 assert.equal(resolve(facts).ok,true,facts.userText);count++;
 assert.equal(resolve({...facts,userText:`不要${action}${title}，不动其他任务`}).ok,false,'negative prefix outside opaque title');count++;
}
console.log('PASS '+count+' total checks including opaque restricted-action titles');