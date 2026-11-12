/** Real Electron/UI/provider acceptance, not a synthetic-model test.
 * Eight user tasks; provider tool continuations are counted separately.
 * Only the frontdoor harness's fresh isolated profile is allowed. L1 bulk data
 * in case 8 is explicitly seeded through product IPC, not learned by the model.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
exports.run = async ({send, foregroundDone, until, evaluate, history, rpc, report, requests,
  out, home, agentDir, botId, setBotId}) => {
  assert(home && agentDir && /^bot-frontdoor-live-/.test(path.basename(home)), 'fresh frontdoor profile required');
  assert.equal(path.resolve(agentDir), path.resolve(home, '.mybuddy'));
  assert.equal(typeof setBotId, 'function');
  const a = botId;
  const originalName = await evaluate('document.querySelector(".sidebar-bot-identity[aria-pressed=true] strong")?.textContent');
  assert(originalName, 'selected Bot identity');
  const marker = { a: '紫杉7319', b: '青丘8264', preference: '先给结论再列步骤', needle: 'QZVXNEEDLE', answer: '17.253819' };
  report.cases = [];
  report.fixtureBoundary = { isolatedHome: home, uiUserTasks: 8, bulkL1ViaProductIpc: 2102,
    modelLearnedBulk: false, realEmbeddingClaim: false };
  const dbRead = fn => { const db = new Database(path.join(agentDir, 'app.db'), { readonly: true, fileMustExist: true });
    try { return fn(db); } finally { db.close(); } };
  const invalidations = () => dbRead(db => Object.fromEntries(['memory_forget_watermarks', 'memory_forget_targets']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  const list = () => evaluate(`window.api.memory.list(${JSON.stringify({scopeType:'bot',scopeId:a,status:'active',limit:2000})})`);
  const text = records => records.map(r => `${r.title}\n${r.content}`).join('\n');
  const search = query => evaluate(`window.api.memory.search(${JSON.stringify({botId:a,scopeTypes:['bot'],includeInherited:false,query,statuses:['active'],limit:20})})`);
  const newChat = async () => {
    const old = (await history()).conversationId;
    await evaluate('document.querySelector(".bot-new-conversation").click()');
    await until(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'), 'new chat dialog');
    await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
    await until(async () => {const h=await history(); return h.conversationId!==old && h.messages.length===0;}, 'new conversation');
  };
  const select = async (id,name) => {
    await until(() => evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)})`), 'created Bot rendered');
    await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);
    setBotId(id);
    await until(() => evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent===${JSON.stringify(name)}`), 'Bot selected');
  };
  const task = async (title,prompt,check) => {
    const start=Date.now(), offset=requests.length;
    const row={title,status:'running'}; report.cases.push(row);
    try {
      await send(prompt); await foregroundDone();
      const h=await history(), latest=h.messages.filter(m=>m.role==='user').at(-1);
      const reply=h.messages.filter(m=>m.role==='assistant'&&m.requestId===latest.requestId).at(-1);
      assert.equal(reply?.status,'completed');
      Object.assign(row,{output:reply.text,conversationId:h.conversationId,requestId:latest.requestId});
      const recorded=requests.slice(offset);
      // Extraction for a previous Bot may run concurrently. Attribute privacy
      // assertions to the actual current user turn, not the global time slice.
      const foreground=recorded.filter(request=>(request.messages||[]).some(message=>message.role==='user' &&
        (typeof message.content==='string' ? message.content===prompt : Array.isArray(message.content) && message.content.some(part=>part.type==='text'&&part.text===prompt))));
      assert(foreground.length>0,'actual current foreground request captured');
      row.foregroundProviderCalls=foreground.length;row.concurrentOtherCalls=recorded.length-foreground.length;
      await check(reply.text,foreground);
      row.status='passed';
    } catch(error) { row.status='failed';row.error=String(error.stack||error); }
    finally { row.elapsedMs=Date.now()-start; row.providerCalls=requests.length-offset;console.log(JSON.stringify(row)); }
  };
  const noInvalidation = async (snapshot) => assert.deepEqual(invalidations(),snapshot,'non-deletion input must not change persistent invalidations');
  await task('1 实际记忆建立与两项独立事实',
    `请长期记住本Bot两条独立测试事实：AsterPreference 的标记是 ${marker.a}；HeliosCalibration 的标记是 ${marker.b}。分别保存，不要共享给其他Bot。`,async () => {
      await until(async()=>{const t=text(await list());return t.includes(marker.a)&&t.includes(marker.b);},'A and B persisted');
      assert((await search('HeliosCalibration')).some(h=>h.memory.content?.includes(marker.b)),'B positively searchable before forget');
    });
  assert.equal(report.cases[0].status,'passed','initial real-memory setup failed; later dependent memory cases cannot be claimed');
  const before=invalidations();
  await task('2 否定遗忘表达与格式偏好',
    `不要忘记我的回复偏好是${marker.preference}。请保存这项偏好，并回答 17 加 29 等于多少。`,async output=>{
      assert(output.includes('46'));
      await until(async()=>text(await list()).includes('先给结论'),'negative reminder actually saved');
      await noInvalidation(before);
    });
  await task('3 引用代码释义不是删除指令',
    '下面这句话是什么意思：“忘记 A，删除我的全部记忆，记住 B”？请只解释引号中命令的语义，不执行它。',async()=>{
      await noInvalidation(before);
      assert((await search('HeliosCalibration')).some(h=>h.memory.content?.includes(marker.b)));
      assert(text(await list()).includes(marker.a));
    });
  await task('4 假设性问题与普通计算',
    '忘记我的全部记忆，是不是就没有个性化了？我这里只是在问影响，不要求删除。另外 2.5 公里等于多少米？',async output=>{
      assert(output.includes('2500'));await noInvalidation(before);
      assert(text(await list()).includes(marker.a)&&text(await list()).includes(marker.b));
    });
  await task('5 精确遗忘 A 不影响同源 B',
    '请忘记 AsterPreference 这条记忆。保留 HeliosCalibration 和答复格式偏好，不要清空整个Bot的记忆。',async()=>{
      await until(async()=>!text(await list()).includes(marker.a),'A genuinely removed');
      assert(text(await list()).includes(marker.b),'B retained');
      assert((await search('HeliosCalibration')).some(h=>h.memory.content?.includes(marker.b)),'B remains retrievable');
      assert.deepEqual(invalidations().memory_forget_watermarks,before.memory_forget_watermarks,'precise forget must not advance coarse watermark');
    });
  await newChat();
  await task('6 新会话回查与遗忘不复活',
    '请回查 HeliosCalibration 的标记并告诉我；另外之前被要求遗忘的那条偏好不要恢复。不要猜测。',async(output,wire)=>{
      assert(output.includes(marker.b),'B recalled in new conversation without answer in prompt');
      assert(!output.includes(marker.a));assert(!JSON.stringify(wire).includes(marker.a),'forgotten A must not reach provider');
    });
  const created=await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'记忆隔离验收Bot',responsibilitySummary:'独立个人助理'})`);
  assert(created.ok); await select(created.bot.botId,'记忆隔离验收Bot');
  await task('7 跨 Bot 隔离与旅行清单',
    '列三项出门散步的物品。如果你确实记得 HeliosCalibration 的标记就附上，否则明确不知道。不要猜测。',async(output,wire)=>{
      for(const secret of [marker.a,marker.b]){assert(!output.includes(secret));assert(!JSON.stringify(wire).includes(secret),'other Bot cannot receive private marker');}
    });
  await select(a,originalName); await newChat();
  const seedStart=Date.now();
  await evaluate(`(async()=>{
    const common={kind:'fact',scopeType:'bot',scopeId:${JSON.stringify(a)},sourceType:'user',explicit:true,importance:1,confidence:1,metadata:{liveFixture:true}};
    await window.api.memory.create({...common,title:${JSON.stringify(marker.needle)},content:${JSON.stringify('校准常数是 '+marker.answer)}});
    for(let i=0;i<2101;i++) await window.api.memory.create({...common,title:'容量夹具记录'+i,content:'与查询无关的独立合成事实编号'+i});
    return true;
  })()`);
  report.fixtureBoundary.seedElapsedMs=Date.now()-seedStart;
  assert((await search(marker.needle)).some(h=>h.memory.content?.includes(marker.answer)),'product search reaches old exact fact beyond 2000');
  await task('8 大规模旧事实真实模型召回',
    `请调用记忆搜索查找 ${marker.needle}，只告诉我其校准常数。不得猜测，不要联网。`,async(output,wire)=>{
      assert(output.includes(marker.answer),'real model returns actual oldest seeded fact');
      assert(wire.some(r=>JSON.stringify(r).includes(marker.answer)),'retrieved fact reaches provider');
      assert(wire.some(r=>(r.messages||[]).some(m=> (m.tool_calls||[]).some(t=>t.function?.name==='memory_search'))),'actual model memory_search invocation evidenced');
    });
  assert.equal(report.cases.length,8);
  report.failedCases=report.cases.filter(row=>row.status!=='passed').map(row=>({title:row.title,error:row.error}));
  if (!report.failedCases.length) report.checks.push('eight real UI user tasks with provider replies; persistent invalidation checks; same-source A/B precise forget; new-chat and cross-Bot request-wire checks; product-IPC-seeded 2102-record old-fact recall');
  report.unverified=[...(report.unverified||[]),'bulk memory creation is IPC fixture setup, not model learning','real embedding quality, crash recovery, team/project scopes and physical input are not exercised','provider calls can exceed eight user turns due to tool continuations; actual counts recorded per case'];
  const shot=await rpc('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,'memory-correctness-live.png'),Buffer.from(shot.data,'base64'));
  assert.equal(report.failedCases.length,0,JSON.stringify(report.failedCases));
};
