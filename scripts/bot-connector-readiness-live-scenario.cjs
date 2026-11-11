const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const cases=[['mail','邮箱查询','怎样查询最新邮件而不把安装当作登录？'],['calendar','日程查重','怎样检查明天是否日程冲突？'],['files','文件检索','怎样搜索云盘合同？'],['tasks','待办整理','怎样查逾期待办？'],['contacts','联系人查找','怎样查找联系人的邮箱？'],['notes','资料总结','怎样读取笔记并总结？']];
exports.seed=agentDir=>{for(const [id,title]of cases){const dir=path.join(agentDir,'plugins/connector-market/connectors',`probe-${id}`);fs.mkdirSync(path.join(dir,'skills',`probe-${id}`),{recursive:true});fs.writeFileSync(path.join(dir,'connector-meta.json'),JSON.stringify({name:`probe-${id}`,description:title,type:'cli'}));fs.writeFileSync(path.join(dir,'cli.json'),JSON.stringify({auth:{command:'do-not-run-login'},init:{linux:'do-not-run-install'}}));fs.writeFileSync(path.join(dir,'skills',`probe-${id}`,'SKILL.md'),`---\nname: probe-${id}\ndescription: Isolated ${title} fixture instructions, not a connected real service.\n---\nThis is a local test instruction package only. No CLI or account is installed. The documentation marker is DOC_${id.toUpperCase()}_731. The service would use supported read-only status before a read operation. Never invent records. Do not run installation or login.\n`);}};
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,out,botId,modelKey})=>{
 report.cases=[];
 for(const[id,title,prompt]of cases){await evaluate(`window.api.agent.installConnector(${JSON.stringify('probe-'+id)})`);}
 await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().refreshConnectors())`);
 for(const[id,title,prompt]of cases){
  await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setBotComposerSelection(${JSON.stringify(botId)},${JSON.stringify({modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:['probe-'+id]})}))`);
  const start=Date.now(),offset=requests.length;
  await send(`这是${title}方案咨询，不执行外部动作，不创建后台任务。请先读取所选连接器技能文件，返回文档中的验证标记；然后简短回答：${prompt}目前是否已经验证登录？不要猜测真实账户数据。`);await foregroundDone();
  const answer=(await history()).messages.filter(m=>m.role==='assistant').at(-1);
  assert(answer.text.includes(`DOC_${id.toUpperCase()}_731`),'actual skill read marker');
  assert(/未验证|未.*登录|没有.*验证|尚未|未.*确认|not_verified|验证登录[^\n]*没有/.test(answer.text),'unverified not claimed ready');
  assert.equal(answer.workIds.length,0);
  const calls=requests.slice(offset);assert(JSON.stringify(calls).includes('Selected connector facts'),'native prompt has connector status');
  assert(JSON.stringify(calls).includes('read_skill'),'native skill tool path available');
  assert(await evaluate(`Array.from(document.querySelectorAll('[title]')).some(e=>e.title.includes('CLI/登录未验证'))`),'connector chip conveys status');
  const row={title,answer:answer.text,modelCalls:calls.length,elapsedMs:Date.now()-start};report.cases.push(row);console.log(JSON.stringify(row));
 }
 await evaluate(`document.querySelector('[aria-label="添加"]').click()`);await until(()=>evaluate(`!!document.querySelector('.add-menu')`),'menu');
 await evaluate(`[...document.querySelectorAll('.add-menu-item')].find(b=>b.textContent.trim()==='连接器').click()`);
 await until(()=>evaluate(`document.body.textContent.includes('CLI/登录未验证')`),'connector menu honesty');
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'connector-menu.png'),Buffer.from(shot.data,'base64'));
 report.checks.push('six real-model foreground task categories use actual read_skill files and unverified connector facts; real external accounts/CLI/auth intentionally not provided or claimed tested');
};
