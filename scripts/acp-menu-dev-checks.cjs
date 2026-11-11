/** Real pnpm dev/Electron menu; seeded catalog, no ACP CLI or model invocation. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ evaluate, rpc, until, report, out }) => {
  const taskId = 'acp-menu-style-fixture';
  const agents = [
    { id: 'codex', name: 'Codex', availability: 'adapter' },
    { id: 'grok', name: 'Grok', model: 'Grok 4.6' },
    { id: 'opencode', name: 'OpenCode', model: 'opencode/MiMo-V2.6-Flash Free' },
    { id: 'agy', name: 'Antigravity', model: 'Gemini 3.8 Flash (High)', availability: 'adapter' },
    { id: 'claude', name: 'Claude', available: false, availability: 'missing' },
    { id: 'cline', name: 'Disabled agent', enabled: false },
  ].map(({model, ...agent}) => ({ available: true, enabled: true, protocol: 'acp', availability: 'ready', commandLabel: 'Fixture only', ...agent,
    ...(model ? { configSelections: {model: 'selected'}, configOptions: [{id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'selected', options: [{value: 'selected', name: model}]}] } : {}) }));
  report.seededPresentationFacts.push('ACP catalog: 4 available native/adapter agents with short/long models, 1 unavailable, 1 disabled; no real ACP call');
  await evaluate(`(async()=>{
    const {useAppStore:s}=await import('/src/store/appStore.ts'); window.acpMenuStore=s;
    const task={id:${JSON.stringify(taskId)},title:'ACP 菜单样式验收',updatedAt:Date.now(),welcomeMode:'coding',messages:[]};
    await window.api.db.upsertTask(task);
    s.setState({page:'chat',activeBotId:null,activeTaskId:task.id,draft:null,welcomeMode:'coding',tasks:[task],sidebarCollapsed:true,panelOpen:false});
    (await import('/src/lib/externalAgentCatalog.ts')).updateExternalAgentCatalog(${JSON.stringify(agents)});
  })()`);
  await until(() => evaluate('Boolean(document.querySelector("button[title=添加]"))'), 'chat composer');
  const point = selector => evaluate(`(()=>{const e=${selector};if(!e)throw Error('missing menu target');e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  const click = async selector => {
    const p = await point(selector);
    await rpc('Input.dispatchMouseEvent', {type:'mouseMoved', ...p});
    await rpc('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...p});
    await rpc('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...p});
  };
  const clickOutside = async () => {
    const p = {x: 12, y: 880};
    assert(await evaluate(`!document.querySelector('.add-menu-portal-root').contains(document.elementFromPoint(12,880))`));
    await rpc('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...p});
    await rpc('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...p});
  };
  const menuTrigger = 'document.querySelector("button[title=添加]")';
  const row = name => `[...document.querySelectorAll('.add-menu-flyout-row')].find(e=>e.querySelector('.add-menu-flyout-text')?.textContent===${JSON.stringify(name)})`;
  const open = async () => {
    await click(menuTrigger);
    const p = await point(`[...document.querySelectorAll('.add-menu-item')].find(e=>e.textContent.trim()==='外部 Agent')`);
    await rpc('Input.dispatchMouseEvent', {type:'mouseMoved',...p});
    await until(() => evaluate('document.querySelectorAll(".add-menu-flyout-row").length === 5'), 'ACP menu catalog');
  };
  const closed = () => until(() => evaluate('!document.querySelector(".add-menu-portal-root")'), 'menu dismissed');
  const screenshot = async name => {
    const shot = await rpc('Page.captureScreenshot', {format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(out, name+'.png'), Buffer.from(shot.data,'base64'));
  };
  for (const theme of ['light','dark']) for (const width of [1280,760]) {
    await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    await open();
    const metrics = await evaluate(`Array.from(document.querySelectorAll('.add-menu-flyout-row'), row=>{
      const button=row.querySelector('.add-menu-flyout-item'),name=button.querySelector('.add-menu-flyout-text'),meta=button.querySelector('.add-menu-item-meta'),icon=button.querySelector('svg'),pin=row.querySelector('.add-menu-flyout-pin');
      const r=row.getBoundingClientRect(),n=name.getBoundingClientRect(),m=meta.getBoundingClientRect();
      return {name:name.textContent,disabled:button.disabled,color:getComputedStyle(name).color,metaColor:getComputedStyle(meta).color,opacity:Number(getComputedStyle(button).opacity),nameWidth:n.width,iconWidth:icon.getBoundingClientRect().width,
        metaWidth:m.width,metaOverflow:meta.scrollWidth>meta.clientWidth,metaEllipsis:getComputedStyle(meta).textOverflow,metaTitle:meta.title,metaText:meta.textContent,hasPin:!!pin,overlap:n.right>m.left+0.5,
        overflowing:row.scrollWidth>row.clientWidth+1,left:r.left,right:r.right,viewport:innerWidth};
    })`);
    report.checks.push({theme,width,rows:metrics});
    await screenshot(`acp-menu-${theme}-${width}`);
    assert.equal(metrics.length,5,'disabled-by-settings agent is omitted');
    const color=metrics[0].color;
    for (const item of metrics) {
      assert(item.nameWidth>20 && item.iconWidth>=13,`${item.name}: long model must not collapse name or icon`);
      assert(!item.overlap && !item.overflowing && item.left>=0 && item.right<=item.viewport,`${item.name}: row stays bounded and pin does not overlap`);
      assert.equal(item.color,color,'same primary label color for every row');
      assert.equal(item.metaColor,color,'model/status text inherits the label color');
      assert.equal(item.metaTitle,item.metaText,'truncated model is available in a tooltip');
      if(item.disabled){assert(item.opacity<1);assert(!item.hasPin);assert(item.metaText.includes('未就绪'));}
      else {assert.equal(item.opacity,1);assert(item.hasPin);}
    }
    const long=metrics.find(item=>item.name==='OpenCode');
    assert(long.metaOverflow && long.metaEllipsis==='ellipsis','long model truncates, not the agent identity');
    await click(`${row('Claude')}.querySelector('.add-menu-flyout-item')`);
    assert(await evaluate('!!document.querySelector(".add-menu-portal-root")'),'unavailable click leaves menu open');
    assert.equal(await evaluate('document.querySelector("[aria-label^=\\"Remove external agent\\"]")?.getAttribute("aria-label") ?? null'),null);
    await clickOutside(); await closed();
  }
  for(const name of ['Codex','Grok','OpenCode','Antigravity']){
    await open(); await click(`${row(name)}.querySelector('.add-menu-flyout-item')`); await closed();
    await until(()=>evaluate(`!!document.querySelector(${JSON.stringify(`[aria-label="Remove external agent ${name}"]`)})`),'selected '+name);
    await click(`document.querySelector(${JSON.stringify(`[aria-label="Remove external agent ${name}"]`)})`);
    await until(()=>evaluate('!document.querySelector("[aria-label^=\\"Remove external agent\\"]")'),'selection removed');
  }
  await open(); await click(`${row('OpenCode')}.querySelector('.add-menu-flyout-pin')`); await closed();
  await until(()=>evaluate('document.querySelector(".acp-pin-trigger")?.textContent.includes("OpenCode")'),'pin selected');
  assert.equal(await evaluate(`window.acpMenuStore.getState().tasks.find(t=>t.id===${JSON.stringify(taskId)}).externalAgentPin.id`),'opencode');
  await click('document.querySelector(".acp-pin-trigger")');
  await click(`[...document.querySelectorAll('.acp-pin-menu button')].find(e=>e.textContent.includes('解除固定'))`);
  await until(()=>evaluate('!document.querySelector(".acp-pin-trigger")'),'unpin');
  await open(); await click(menuTrigger); await closed(); await open();
  await clickOutside(); await closed();
  report.actualControlChecks.push('Electron mouse input: select/remove all four agents, disabled row blocks selection, pin/unpin, outside dismiss, repeated reopen');
  report.checks.push('light/dark, 1280/760 viewport; visible identity/icon, same available text color, bounded long metadata, real disabled state retained');
};
