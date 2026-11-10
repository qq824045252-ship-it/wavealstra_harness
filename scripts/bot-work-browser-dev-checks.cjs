/** Runs after real UI -> preload -> host -> native task completion in the settings dev harness. */
module.exports = async ({ evaluate, rpc, until, report, out }) => {
  const assert = require('node:assert/strict');
  const fs = require('node:fs');
  const path = require('node:path');
  const clickTab = label => evaluate(`[...document.querySelectorAll('.bot-view-tabs button')].find(button=>button.querySelector('span').textContent===${JSON.stringify(label)}).click()`);
  await evaluate(`document.querySelector('[aria-label="关闭 Bot 设置"]').click()`);
  await clickTab('进行中');
  await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length === 1`), 'real delegated Work appears in browser');
  await evaluate(`document.querySelector('.bot-work-card').click()`);
  await until(() => evaluate(`Boolean(document.querySelector('.bot-inspector[open] .bot-work-details'))`), 'real delegated Work details');
  assert(await evaluate(`document.querySelector('.bot-work-details').textContent.includes('后台原生界面成果')`), 'native task result appears in real details');
  await evaluate(`document.querySelector('[aria-label="关闭详情"]').click()`);
  await until(() => evaluate(`!document.querySelector('.bot-inspector[open]')`), 'dismiss details');
  report.actualControlChecks.push('actual pnpm dev settings -> message -> host -> native task -> Work browser -> real result details -> close');
  // Scale fixtures change only this isolated renderer. They do not create jobs or
  // fabricate durable runtime evidence. Restore authoritative sync afterward.
  await evaluate(`(async()=>{ const {useAppStore}=await import('/src/store/appStore.ts'); await useAppStore.getState().refreshBotWork(true); window.browserSmokeStore=useAppStore; window.browserSmokeRefresh=useAppStore.getState().refreshBotWork; const original=useAppStore.getState().botWorks[0]; window.browserSmokeOriginal=original; useAppStore.setState({refreshBotWork:async()=>{},selectedWorkId:null,botWorks:[original,...Array.from({length:72},(_,index)=>({...original,workId:'browser-fixture-'+index,title:'产品资料 '+index,updatedAt:original.updatedAt-index-1,criteria:[{...original.criteria[0],text:'供应商 ACME 独立目标 '+index}],deliverables:[],cards:[],executions:[],generatedArtifacts:[]}))]});})()`);
  try {
    await until(() => evaluate(`document.querySelector('.bot-work-list-summary').textContent.includes('共 73 件') && document.querySelectorAll('.bot-work-card').length===24`), 'full application bounded list');
    await evaluate(`[...document.querySelectorAll('.bot-work-pagination button')].find(button=>button.textContent==='下一页').click()`);
    await until(() => evaluate(`document.querySelector('.bot-work-pagination').textContent.includes('第 2 / 4 页')`), 'full application pagination');
    await evaluate(`(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'ACME 71');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===1 && document.querySelector('.bot-work-card').dataset.workId==='browser-fixture-71'`), 'search reaches later page by goal');
    await evaluate(`document.querySelector('[aria-label="清除搜索"]').click()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===24`), 'clear search');
    await evaluate(`[...document.querySelectorAll('.bot-work-filters button')].find(button=>button.firstElementChild.textContent==='核对结果').click()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===1`), 'completed execution is separate from waiting fixtures');
    await evaluate(`document.querySelector('.bot-work-card').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('.bot-inspector[open]'))`), 'reopen real details');
    await evaluate(`document.querySelector('[aria-label="关闭详情"]').click()`);
    assert(await evaluate(`document.querySelector('.bot-work-filters [aria-pressed=true]').firstElementChild.textContent==='核对结果'`), 'closing details preserves filter');
    await evaluate(`[...document.querySelectorAll('button')].find(button=>button.textContent==='重置筛选').click()`);
    await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===24`), 'reset list');
    const shot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'bot-work-browser-full-app.png'),Buffer.from(shot.data,'base64'));
    await rpc('Emulation.setDeviceMetricsOverride',{width:900,height:820,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.querySelector('.bot-work-card').click()`);
    await until(() => evaluate(`Boolean(document.querySelector('.bot-inspector.is-drawer[open]'))`), 'compact native dialog');
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(() => evaluate(`!document.querySelector('.bot-inspector[open]')`), 'Escape closes compact details');
    assert(await evaluate(`document.documentElement.scrollWidth<=innerWidth`), 'full application compact layout has no overflow');
    await clickTab('对话'); await clickTab('进行中');
    await until(() => evaluate(`document.querySelector('.bot-work-pagination').textContent.includes('第 1 / 4 页') && document.querySelector('input[type=search]').value===''`), 'tab return resets list');
    report.seededPresentationFacts.push('72 synthetic Work projections only in isolated renderer, no jobs created; cleared afterward');
    report.checks.push('actual pnpm dev full-app list: 73 works, 24 per page, goal search beyond first page, filters, repeated real details open/close, Escape and 900px layout');
  } finally {
    await evaluate(`window.browserSmokeStore.setState({refreshBotWork:window.browserSmokeRefresh,selectedWorkId:null});window.browserSmokeRefresh(true)`);
  }
  await until(() => evaluate(`document.querySelectorAll('.bot-work-card').length===1`), 'authoritative list restored');
};
