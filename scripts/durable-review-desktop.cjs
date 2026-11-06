const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ evaluate, until, send, rpc, report, out }) => {
  await send('BOT_GREETING review parent');
  await until(() => evaluate('window.__botEvents.some(e=>e.type==="durable_snapshot"&&!e.snapshot.busy&&e.snapshot.messages.at(-1)?.text==="DURABLE_DESKTOP_COMPLETE")'), 'parent answer');
  const parent = await evaluate('window.__botEvents.findLast(e=>e.type==="durable_snapshot").taskId');
  const branch = async () => {
    const before = await evaluate('window.api.db.listTasks().then(tasks=>tasks.map(task=>task.id))');
    await until(() => evaluate('Boolean(document.querySelector(".assistant-card button[title=从这里创建分支]"))'), 'assistant branch button');
    await evaluate('document.querySelector(".assistant-card button[title=从这里创建分支]").click()');
    let child;
    await until(async () => { child = (await evaluate('window.api.db.listTasks()')).find(task => !before.includes(task.id)); return Boolean(child); }, 'branch created through reply button');
    const info = await evaluate(`window.api.conversationBranch.getInfo(${JSON.stringify(child.id)})`);
    assert(info?.parentTitle);
    await until(() => evaluate(`document.querySelector('.conv-branch-chip:not(.conv-branch-children-toggle)')?.title.includes(${JSON.stringify('来自「' + info.parentTitle + '」')})`), 'created branch activated after IPC completes');
    assert((await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(child.id)})`)).messages.length > 0);
    return child.id;
  };
  const child = await branch();
  await send('BOT_GREETING child continuation');
  await until(() => evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(child)}).then(h=>!h.durable.busy&&h.messages.some(m=>m.text==='BOT_GREETING child continuation')&&h.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE')`), 'child continuation');
  assert.equal((await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(parent)})`)).messages.filter(row => row.role === 'user').length, 1);
  report.tests.push('real assistant branch button, child composer continuation and independent parent history');

  for (let batch = 0; batch < 12; batch++) {
    await evaluate(`(async()=>{for(let i=0;i<10;i++){
      const n=${batch}*10+i;
      const r=await window.api.agent.prompt({taskId:${JSON.stringify(child)},text:'BOT_GREETING history '+n,userMessageId:'review-user-'+n,assistantMessageId:'review-assistant-'+n});
      if(r.error)throw Error(JSON.stringify(r.error));
      while((await window.api.agent.loadTaskHistory(${JSON.stringify(child)})).durable.busy)await new Promise(r=>setTimeout(r,20));
    }return true})()`);
    console.log('review history turns', (batch + 1) * 10);
  }
  const latest = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(child)})`);
  assert(latest.messages.length <= 200 && latest.durable.historyBefore !== undefined);
  await until(() => evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent==="加载更早的消息")'), 'older history control');
  await evaluate('[...document.querySelectorAll("button")].find(button=>button.textContent==="加载更早的消息").click()');
  await until(() => evaluate('[...document.querySelectorAll("button")].some(button=>button.textContent==="返回最新消息")'), 'older page visible');
  const unchanged = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(child)})`);
  assert.deepEqual(unchanged.messages.map(row => row.id), latest.messages.map(row => row.id));
  const capture = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(out, 'review-history-page.png'), Buffer.from(capture.data, 'base64'));
  const historicalBranch = await branch();
  await send('BOT_GREETING confirm old reply branch');
  await until(() => evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(historicalBranch)}).then(h=>!h.durable.busy&&h.messages.some(m=>m.text==='BOT_GREETING confirm old reply branch')&&h.messages.at(-1)?.text==='DURABLE_DESKTOP_COMPLETE')`), 'older branch receives its own new answer');
  report.tests.push('120 new turns, bounded live history, independent older page, branch from an older reply');
  report.review = { parent, child, residentMessages: latest.messages.length, turnsAdded: 120 };
};
