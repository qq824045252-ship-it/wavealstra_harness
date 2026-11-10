const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home})=>{
 await send('建立公开网页追踪测试：每分钟整点（UTC）用 fetch_content（mode=raw，完整读取原文，不用answer模式）访问 https://example.com/，读取网页标题和首段正文，在前台报告来源 URL、实际内容或真实失败原因；即使没有变化也报告每轮。现在不要提前检查。持续到我暂停，不写文件、不发送外部消息。标题“公开网页观察验收”。');
 await foregroundDone(); const works=await evaluate('window.api.botWork.listWorks(true)');assert.equal(works.length,1);const id=works[0].workId;
 const detail=()=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);let w=await detail();assert.equal(w.mode,'watch');report.rounds=[];
 for(let n=1;n<=2;n++){
  await until(async()=>{w=await detail();report.latestWork=w;report.history=await history();return report.history.messages.filter(m=>m.workFeedback?.kind==='result').length>=n;},'public web round '+n+' returns');
  report.rounds.push({at:Date.now(),work:w,messages:report.history.messages.filter(m=>m.workFeedback?.kind==='result')});assert.equal(w.lifecycle,'active');
 }
 await send(`暂停 ${id}，不要再检查。`);await foregroundDone();report.finalWork=await detail();assert.equal(report.finalWork.lifecycle,'paused');report.history=await history();
 if(process.env.BOT_WEB_EXPECT_SUCCESS==='1') {
  const Database=require('better-sqlite3');const db=new Database(path.join(home,'.mybuddy/app.db'),{readonly:true});
  try {
   const rows=db.prepare('SELECT binding_id,payload_json FROM work_native_inbox WHERE consumed_at IS NOT NULL').all();
   report.completeWebReceipts=rows.flatMap(row=>{const p=JSON.parse(row.payload_json);return p.status==='completed'?(p.readEvidence||[]).filter(r=>r.toolName==='fetch_content'&&r.kind==='web-content'&&!r.partial&&r.outputText?.includes('Example Domain')).map(r=>({bindingId:row.binding_id,source:r.target,outputHash:r.outputHash,at:r.at})):[];});
   assert(new Set(report.completeWebReceipts.map(r=>r.bindingId)).size>=2,'two real native complete webpage receipts, not model claims');
   assert(report.history.messages.filter(m=>m.workFeedback?.kind==='result'&&m.text.includes('Example Domain')).length>=2,'both successful observations returned to original conversation');
  } finally {db.close();}
 }
 report.checks.push('real public webpage watch: two scheduled results returned; source success/failure recorded without assuming web equality/semantic completion; remains active until paused');
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'web-watch.png'),Buffer.from(shot.data,'base64'));
};
