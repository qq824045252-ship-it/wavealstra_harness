from pathlib import Path
root=Path(__file__).resolve().parent.parent
s=(root/'scripts/pi0992-desktop-live.cjs').read_text(encoding='utf-8')
s=s.replace("artifacts/pi0992-memory/desktop-live", "artifacts/pi0992-memory/memory-live").replace("'pi0992-desktop-'", "'pi0992-memory-live-'").replace("memoryEnabled:false", "memoryEnabled:true").replace("kind:'pi0992-real-model-packaged-desktop-composer'", "kind:'pi0992-real-model-memory-ipc-session'")
a=s.index('const cases=[');b=s.index('\n];',a)+3
s=s[:a]+'''const valuesForMemory={global:'G-'+crypto.randomBytes(6).toString('hex'),a:'A-'+crypto.randomBytes(6).toString('hex'),b:'B-'+crypto.randomBytes(6).toString('hex'),updated:'U-'+crypto.randomBytes(6).toString('hex'),private:'T-'+crypto.randomBytes(6).toString('hex')};
let fixtureIds;
const question='仅依据当前可访问的长期记忆回答：本项目的标定编号是什么？有记录就只输出编号，没有就只输出 UNKNOWN。不要搜索文件或网络，不要猜测。';
const cases=[
 {name:'global-memory-auto-recall',project:'a',prompt:'仅依据可访问的长期记忆回答：全局参考编号是什么？有就只输出编号，没有就只输出 UNKNOWN。不要调用工具。',expected:()=>valuesForMemory.global},
 {name:'project-a-recall-no-b-leak',project:'a',prompt:question,expected:()=>valuesForMemory.a,forbidden:()=>[valuesForMemory.b,valuesForMemory.private]},
 {name:'project-b-recall-no-a-leak',project:'b',prompt:question,expected:()=>valuesForMemory.b,forbidden:()=>[valuesForMemory.a,valuesForMemory.private]},
 {name:'updated-memory-new-task',project:'a',before:async()=>{await evaluate('window.api.memory.update('+JSON.stringify({id:fixtureIds.aMemory,content:'本项目的标定编号是 '+valuesForMemory.updated+'。',changedBy:'user'})+')');},prompt:question,expected:()=>valuesForMemory.updated,forbidden:()=>[valuesForMemory.a]},
 {name:'forgotten-memory-new-task-is-unknown',project:'a',before:async()=>{await evaluate('window.api.memory.forget('+JSON.stringify(fixtureIds.aMemory)+')');},prompt:question,expected:()=> 'UNKNOWN',forbidden:()=>[valuesForMemory.a,valuesForMemory.updated]},
 {name:'sibling-task-private-memory-isolated',project:'a',prompt:'仅依据当前可访问的长期记忆回答：任务专有检测编号是什么？有就只输出编号，没有就只输出 UNKNOWN。不要搜索文件或网络，不要猜测。',expected:()=> 'UNKNOWN',forbidden:()=>[valuesForMemory.private]},
 {name:'disabled-memory-not-auto-injected',project:'b',before:async()=>{await evaluate('window.api.agent.updateAppSettings({memoryEnabled:false})');},prompt:'仅依据当前可访问的长期记忆回答：全局参考编号是什么？有就只输出编号，没有就只输出 UNKNOWN。不要调用工具，不要猜测。',expected:()=> 'UNKNOWN',forbidden:()=>[valuesForMemory.global]},
];'''+s[b:]
# Set up only through actual app APIs, in a throwaway profile. No user memory touched.
a=s.index(' for(const task of cases')
seed=''' fixtureIds=await evaluate(`(async()=>{
  const a=await window.api.db.createProject({name:'Memory regression A'}),b=await window.api.db.createProject({name:'Memory regression B'});
  if(!a.ok||!b.ok)throw Error('Fixture project creation failed');
  const projectA=a.project.id,projectB=b.project.id;
  await window.api.db.upsertTask({id:'memory-private-owner',title:'Isolated private owner',projectId:projectA,updatedAt:Date.now()});
  const add=(title,content,scopeType,scopeId)=>window.api.memory.create({kind:'fact',title,content,scopeType,scopeId,explicit:true,sourceType:'user',importance:2,confidence:1});
  const global=await add('全局参考编号','全局参考编号是 '+${JSON.stringify(valuesForMemory.global)}+'。','global');
  const am=await add('本项目标定编号','本项目的标定编号是 '+${JSON.stringify(valuesForMemory.a)}+'。','project',projectA);
  const bm=await add('本项目标定编号','本项目的标定编号是 '+${JSON.stringify(valuesForMemory.b)}+'。','project',projectB);
  const tm=await add('任务专有检测编号','任务专有检测编号是 '+${JSON.stringify(valuesForMemory.private)}+'。','task','memory-private-owner');
  return {projectA,projectB,aMemory:am.id,bMemory:bm.id,globalMemory:global.id,privateMemory:tm.id};
 })()`);report.fixtureIds=fixtureIds;save();
'''
s=s[:a]+seed+s[a:]
a=s.index("   await evaluate('(()=>{const e=document.querySelector")
b=s.index('   let state;',a)
s=s[:a]+'''   if(task.before)await task.before();
   const taskId='memory-live-'+crypto.randomUUID(),messageId='assistant-'+crypto.randomUUID();
   const projectId=task.project==='a'?fixtureIds.projectA:fixtureIds.projectB;
   await evaluate('window.api.db.upsertTask('+JSON.stringify({id:taskId,title:task.name,projectId,updatedAt:Date.now(),permissionMode:'auto',modelId:'commandcode/deepseek/deepseek-v4.1-flash'})+')');
   const request={taskId,assistantMessageId:messageId,userMessageId:'user-'+crypto.randomUUID(),text:task.prompt,modelId:'commandcode/deepseek/deepseek-v4.1-flash',permissionMode:'auto'};
   await evaluate('(()=>{window.__pi099.current.taskId='+JSON.stringify(taskId)+';window.api.agent.prompt('+JSON.stringify(request)+').then(r=>{window.__pi099.current.promptResult=r;}).catch(e=>{window.__pi099.current.error=String(e);window.__pi099.current.done=true;});return true;})()');
'''+s[b:]
a=s.index('row.result=task.check(state);')
s=s[:a]+s[a:].replace('row.result=task.check(state);', '''assert(state.receivedText.includes(task.expected()),'Expected memory answer missing: '+task.name);
   for(const forbidden of task.forbidden?.()||[])assert(!state.receivedText.includes(forbidden),'Out-of-scope or stale memory leaked');
   row.result={expected:task.expected(),noForbiddenValues:true,toolsUsed:state.tools.length};''',1)
# Each fixture session must persist only canonical history, not the request supplement.
s=s.replace("assert.equal(controls.length,0,'retired host control message was persisted');", "assert.equal(controls.length,0,'retired host control message was persisted');assert(!rows.some(r=>r.message?.customType==='mybuddy.context-capsule'||r.customType==='mybuddy.context-capsule'),'request-only memory capsule was persisted');")
(root/'scripts/pi0992-memory-live.cjs').write_text(s,encoding='utf-8',newline='\n')
print('Created 7 actual-provider memory tests in isolated app profile: global/projects/update/forget/private scope/disabled memory.')
