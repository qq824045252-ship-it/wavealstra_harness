/** Runs after real UI -> preload -> host -> native task completion in the settings dev harness. */
module.exports = async ({ evaluate, rpc, until, report, out, isolatedSql }) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const clickTab = label => evaluate(`[...document.querySelectorAll('.bot-view-tabs button')].find(button=>button.querySelector('span').textContent===${JSON.stringify(label)}).click()`);
  await evaluate(`document.querySelector('[aria-label="关闭 Bot 设置"]').click()`);
  await clickTab('进行中');
  await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length === 1`), 'real delegated Work appears in browser');
  await evaluate(`document.querySelector('.bot-work-card').click()`);
  await until(() => evaluate(`Boolean(document.querySelector('.bot-work-conversation-detail .bot-work-details'))`), 'real delegated Work details');
  assert(await evaluate(`document.querySelector('.bot-work-details').textContent.includes('后台原生界面成果')`), 'native task result appears in real details');
  await evaluate(`document.querySelector('[aria-label="关闭事项详情并返回进行中"]').click()`);
  await until(() => evaluate(`!document.querySelector('.bot-work-conversation-detail')`), 'dismiss details');
  report.actualControlChecks.push('actual pnpm dev settings -> message -> host -> native task -> Work browser -> real result details -> close');
  // Seed only this isolated database, with no dispatch/outbox rows. Renderer
  // must use its real preload/IPC/SQL page path; no store or API replacements.
  const original = (await evaluate(`window.api.botWork.queryWorks({scope:{kind:'all'},view:'all',pageSize:1})`)).works[0];
  assert(original.listSummary && original.deliverables.length === 0 && original.executions.length === 0, 'actual IPC list is summary-only');
  const columns = isolatedSql({statements:[],query:{sql:'PRAGMA table_info(works)'}}).map(row=>row.name);
  const statements = [];
  for(let index=0;index<72;index++) {
    const replacements = {work_id: '?',title:'?',updated_at:'?',goal_description:'?',criteria_json:"'[]'",active_execution_ids_json:"'[]'",accepted_deliverable_ids_json:"'[]'",lifecycle:"'active'",closure_conclusion:'NULL',closure_summary:'NULL',closed_at:'NULL',mode:"'once'",watch_rule_json:'NULL'};
    const values = columns.map(column=>replacements[column] ?? column);
    const parameters = [];
    for(const column of columns) if(replacements[column] === '?') parameters.push({work_id:'browser-fixture-'+index,title:'产品资料 '+index,updated_at:original.updatedAt-index-1,goal_description:'供应商 ACME 独立目标 '+index}[column]);
    parameters.push(original.workId);
    statements.push({sql:`INSERT INTO works(${columns.join(',')}) SELECT ${values.join(',')} FROM works WHERE work_id=?`,params:parameters});
  }
  isolatedSql({statements});
  await evaluate(`(async()=>{ const {useAppStore}=await import('/src/store/appStore.ts'); await useAppStore.getState().refreshBotWork(true); })()`);
  try {
    await until(() => evaluate(`document.querySelector('.bot-work-list-summary')?.textContent.includes('共 73 件') && document.querySelectorAll('.bot-work-card').length===24`), 'full application bounded list');
    await evaluate(`[...document.querySelectorAll('.bot-work-pagination button')].find(button=>button.textContent==='下一页').click()`);
    await until(() => evaluate(`document.querySelector('.bot-work-pagination')?.textContent.includes('第 2 / 4 页')`), 'full application pagination');
    await evaluate(`(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'ACME 71');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===1 && document.querySelector('.bot-work-card').dataset.workId==='browser-fixture-71'`), 'search reaches later page by goal');
    await evaluate(`document.querySelector('[aria-label="清除搜索"]').click()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===24`), 'clear search');
    await evaluate(`[...document.querySelectorAll('.bot-work-filters button')].find(button=>button.firstElementChild.textContent==='核对结果').click()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===1`), 'completed execution is separate from waiting fixtures');
    await evaluate(`document.querySelector('.bot-work-card').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('.bot-work-conversation-detail'))`), 'reopen real details');
    await evaluate(`document.querySelector('[aria-label="关闭事项详情并返回进行中"]').click()`);
    assert(await evaluate(`document.querySelector('.bot-work-filters [aria-pressed=true]').firstElementChild.textContent==='核对结果'`), 'closing details preserves filter');
    await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='重置筛选').click()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===24`), 'reset list');
    const shot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'bot-work-browser-full-app.png'),Buffer.from(shot.data,'base64'));
    await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:820,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('.bot-work-card').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('.bot-work-conversation-detail'))`), 'compact inline details');
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(() => evaluate(`!document.querySelector('.bot-work-conversation-detail')`), 'Escape closes compact details');
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'full application compact layout has no overflow');
    await clickTab('对话'); await clickTab('进行中');
    await until(() => evaluate(`document.querySelector('.bot-work-pagination')?.textContent.includes('第 1 / 4 页') && document.querySelector('input[type=search]').value===''`), 'tab return resets list');
    assert.equal(isolatedSql({statements:[],query:{sql:"SELECT count(*) AS n FROM work_dispatch_requests WHERE work_id LIKE 'browser-fixture-%'"}})[0].n,0,'scale rows never dispatch tasks');
    report.seededPresentationFacts.push('72 isolated SQLite Work rows, no jobs created; deleted with durable tombstones afterward');
    report.checks.push('actual pnpm dev + SQLite full-app list: 73 works, 24 per page, goal search beyond first page, filters, repeated real details open/close, Escape and 900px layout');
  } finally {
    isolatedSql({statements:[{sql:"DELETE FROM works WHERE work_id LIKE 'browser-fixture-%'"}]});
    await evaluate(`(async()=>{const {useAppStore}=await import('/src/store/appStore.ts');useAppStore.getState().setSelectedWorkId(null);await useAppStore.getState().refreshBotWork(true);})()`);
  }
  await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===1`), 'authoritative list restored');
};
