/** Real Electron dev app; synthetic content in a disposable profile, actual IPC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({evaluate, rpc, until, report, out, home}) => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const shot = async name => fs.writeFileSync(path.join(out,name+'.png'), Buffer.from((await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  const click = async expression => {
    await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});})()`);
    await wait(100); // Let the real scroll event finish before native input opens a menu.
    const p=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing click target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Click target is obscured: '+e.textContent);return {x,y}})()`);
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
    await wait(120);
  };
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const menuButton = text => `[...document.querySelectorAll('.gadget-action-menu-popover button')].find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
  const key = async (key,code,n) => {await rpc('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:n});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:n});await wait(80);};
  const verify = async label => {
    await until(()=>evaluate(`!!document.querySelector('.gadget-action-menu-popover') && getComputedStyle(document.querySelector('.gadget-action-menu-popover')).visibility!=='hidden'`),'menu '+label);
    const g=await evaluate(`(()=>{const m=document.querySelector('.gadget-action-menu-popover'),r=m.getBoundingClientRect(),b=document.querySelector('.gadget-status-badge'),br=b.getBoundingClientRect();return {menu:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},viewport:{width:innerWidth,height:innerHeight},badgeHeight:br.height,badgeLineHeight:parseFloat(getComputedStyle(b).lineHeight),buttons:[...m.querySelectorAll('button')].map(e=>{const r=e.getBoundingClientRect();return {text:e.textContent.trim(),visible:r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}})}})()`);
    await shot(label);
    assert(g.buttons.every(b=>b.visible),label+' every action is visible and clickable: '+JSON.stringify(g));
    assert(g.menu.left>=0&&g.menu.top>=0&&g.menu.right<=g.viewport.width&&g.menu.bottom<=g.viewport.height,label+' menu stays within viewport');
    assert(g.badgeHeight<=24,label+' status remains on one line');
    report.checks.push({label,...g});
  };
  await rpc('Page.bringToFront');
  await rpc('Emulation.setDeviceMetricsOverride',{width:1600,height:980,deviceScaleFactor:1,mobile:false});
  const workspace=path.join(home,'gadget-workspace');fs.mkdirSync(workspace);
  await evaluate(`(async()=>{const {useAppStore:s}=await import('/src/store/appStore.ts');window.gadgetTestStore=s;
    const space={id:'gadget-menu-space',name:'Gadget menu workspace',path:${JSON.stringify(workspace)},createdAt:Date.now(),updatedAt:Date.now()};
    const task={id:'gadget-menu-task',title:'Gadget menu task',spaceId:space.id,updatedAt:Date.now(),modelId:'fixture/fixture',welcomeMode:'working',messages:[{id:'fixture-message',role:'assistant',createdAt:Date.now(),blocks:[{type:'text',content:'隔离的界面验收，无模型请求。'}]}]};
    await window.api.db.upsertSpace(space);await window.api.db.upsertTask(task);
    window.gadgetTestItem=await window.api.gadget.create({name:'bilibili 演示站',description:'B 站风格视频站演示界面：轮播、推荐流、排行榜、搜索筛选、视频详情弹层。全部为本地示例数据，不调用官方接口。',scope:{type:'global'},files:[{path:'index.html',content:'<!doctype html><h1>Gadget menu test</h1>'}]});
    s.setState({theme:'light',page:'gadgets',tasks:[task],spaces:[space],activeTaskId:task.id,activeBotId:null,draft:null,sidebarCollapsed:false,panelOpen:false});
  })()`);
  report.seededPresentationFacts.push('Disposable workspace/task and actual Gadget files created via IPC; no production data or model request.');
  await until(()=>evaluate(`!!document.querySelector('.gadget-more-btn')`),'global gadget');
  await click(q('.gadget-more-btn'));
  await verify('global-single');
  if(process.env.GADGET_MENU_REPRO==='1')return;
  // The same trigger toggles closed, repeated opening is stable, Escape and outside clicks dismiss.
  await click(q('.gadget-more-btn'));assert(!await evaluate(`!!document.querySelector('.gadget-action-menu-popover')`));
  await click(q('.gadget-more-btn'));await key('Escape','Escape',27);assert(!await evaluate(`!!document.querySelector('.gadget-action-menu-popover')`));
  await click(q('.gadget-more-btn'));await click(q('.gadget-page-header h1'));assert(!await evaluate(`!!document.querySelector('.gadget-action-menu-popover')`));
  await click(q('.gadget-more-btn'));
  await rpc('Emulation.setDeviceMetricsOverride',{width:1200,height:760,deviceScaleFactor:1,mobile:false});
  await wait(150);await verify('menu-resize');await key('Escape','Escape',27);
  const search = value => evaluate(`(()=>{const e=document.querySelector('.gadget-search');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click(q('.gadget-more-btn'));await search('no matching gadget');
  await until(()=>evaluate(`!document.querySelector('.gadget-action-menu-popover')`),'filtered row dismisses menu');
  await search('');await until(()=>evaluate(`!!document.querySelector('.gadget-more-btn')`),'search reset');
  assert(!await evaluate(`!!document.querySelector('.gadget-action-menu-popover')`),'restored row never reopens a stale menu');
  // Opening each dialog must not lose the click to outside-dismiss on the portalled menu.
  for(const [action,dialog] of [['编辑名称与描述','.modal-overlay'],['编辑源码','.gadget-dialog'],['移动到…','.gadget-dialog'],['删除','.modal-overlay']]) {
    await click(q('.gadget-more-btn'));await click(menuButton(action));
    await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(dialog)})`),'dialog '+action);
    assert(!await evaluate(`!!document.querySelector('.gadget-action-menu-popover')`));
    await click(`[...document.querySelectorAll(${JSON.stringify(dialog+' button')})].find(e=>['取消','关闭'].includes(e.textContent.trim()))`);
    await until(()=>evaluate(`!document.querySelector(${JSON.stringify(dialog)})`),'cancel '+action);
  }
  const id=await evaluate('window.gadgetTestItem.id');
  assert((await evaluate(`window.api.gadget.list({scope:{type:'global'}})`)).some(g=>g.id===id&&g.name==='bilibili 演示站'),'cancel never mutates/deletes the Gadget');
  for(const [width,height,zoom] of [[1024,740,1],[760,640,1],[600,460,1],[1280,800,1.25]]) {
    await rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.body.style.zoom=${JSON.stringify(String(zoom))};window.gadgetTestStore.setState({sidebarCollapsed:true})`);await wait(150);
    await click(q('.gadget-more-btn'));await verify('global-'+width+'-zoom-'+zoom);await key('Escape','Escape',27);
  }
  await evaluate(`document.body.style.zoom='1'`);
  await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  await evaluate(`(async()=>{for(let i=0;i<12;i++)await window.api.gadget.create({name:'Repeated gadget '+i,scope:{type:'global'},description:'Long description '.repeat(20)});})()`);
  await until(()=>evaluate(`document.querySelectorAll('.gadget-more-btn').length===13`),'many gadget rows');
  await click(`[...document.querySelectorAll('.gadget-more-btn')].at(-1)`);await verify('global-bottom');
  await evaluate(`document.querySelector('.gadget-page-body').scrollTop=0`);
  await until(()=>evaluate(`!document.querySelector('.gadget-action-menu-popover')`),'scroll dismiss');
  // Workspace and task reuse the same cards/menu, including the constrained side panel.
  for(const page of ['workspace','task']) {
    await evaluate(`(async()=>{const scope=${page==='workspace'?"{type:'workspace',workspaceId:'gadget-menu-space'}":"{type:'task',taskId:'gadget-menu-task'}"};await window.api.gadget.create({name:'Scoped gadget',description:'Scoped description '.repeat(12),scope});window.gadgetTestStore.setState(${page==='workspace'?"{page:'workspace',activeWorkspaceId:'gadget-menu-space'}":"{page:'chat',activeTaskId:'gadget-menu-task',panelOpen:true,panelMode:'gadgets',panelWidth:340,panelExpanded:false}"});})()`);
    if(page==='workspace') {
      // Store fields differ across navigation revisions; use the actual workspace tab.
      await until(()=>evaluate(`!!document.querySelector('.workspace-detail-tab')`),'workspace tabs');
      await click(`[...document.querySelectorAll('.workspace-detail-tab')].find(e=>/Gadgets|工作台/.test(e.textContent))`);
    }
    await until(()=>evaluate(`!!document.querySelector('.gadget-more-btn')`),page+' gadget');
    await click(q('.gadget-more-btn'));await verify(page+'-menu');await key('Escape','Escape',27);
  }
  await evaluate(`window.gadgetTestStore.setState({theme:'dark'})`);await wait(100);
  await click(q('.gadget-more-btn'));await verify('task-dark');await key('Escape','Escape',27);
  report.actualControlChecks.push('Open-menu resize, search removal/restoration without stale anchors, and dark task menu.');
  report.actualControlChecks.push('Actual mouse input: open/toggle/reopen menus; Escape/outside/scroll dismissal; edit/source/move/delete dialogs and Cancel; all menu buttons hit-tested at 1600/1024/760/600 widths and 125% zoom; global/workspace/task lists.');
};
