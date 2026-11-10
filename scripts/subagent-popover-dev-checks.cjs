/** Real pnpm dev/Electron renderer, seeded presentation facts; no LLM or user profile.
 * Run: SUBAGENT_POPOVER_DEV=1 pnpm exec node scripts/bot-settings-dev-test.cjs
 * Use a writable TMPDIR when the desktop /tmp quota is full.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ evaluate, rpc, until, report, out }) => {
  report.seededPresentationFacts.push('30 completed subagents with long names/paths; renderer-only task fixture');
  await evaluate(`(async()=>{
    const {useAppStore:s}=await import('/src/store/appStore.ts'); window.overlapStore=s;
    const results=Array.from({length:30},(_,i)=>({subagentId:'item-'+i,agent:'scout',displayName:'子代理 '+i+' 长名称验证',task:'只读核对资料',status:'completed',exitCode:0,resolvedModel:'fixture/fixture',workspace:{kind:'shared',cwd:'C:/Users/servi/Documents/GitHub/wavealstra_harness/a/very/long/path'},usage:{input:100,output:50,cacheRead:40000,cacheWrite:0,cost:0,contextTokens:42000,turns:2},messages:[{role:'assistant',content:[{type:'text',text:'核对完成'}],timestamp:Date.now()}]}));
    s.setState({page:'chat',activeBotId:null,activeTaskId:'overlap-fixture',draft:null,welcomeMode:'coding',tasks:[{id:'overlap-fixture',title:'截图复现：子代理弹层与右侧概览',updatedAt:Date.now(),welcomeMode:'coding',messages:[{id:'m-fixture',role:'assistant',createdAt:Date.now(),blocks:[{type:'text',content:'这是一段验证遮挡的对话正文。'},{type:'tool',toolCall:{id:'tc-fixture',tool:'subagent',summary:'30 个子代理',status:'done',detail:JSON.stringify({mode:'parallel',results})}}]}]}]});
  })()`);
  await until(()=>evaluate('Boolean(document.querySelector(".subagent-chip"))'),'seeded subagent chip');
  for (const [width,height,sidebar,panel] of [[2048,1256,false,true],[2048,1256,false,false],[1280,800,false,true],[760,620,true,false],[440,520,true,false]]) {
    await rpc('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.overlapStore.setState({sidebarCollapsed:${sidebar},panelOpen:${panel},panelMode:'overview',panelWidth:400,extensionFlyoutOpen:false,extensionView:'overview'})`);
    await evaluate(`if(!document.querySelector('.subagent-popover'))document.querySelector('.subagent-chip').click()`);
    await until(()=>evaluate(`(()=>{let p=document.querySelector('.subagent-popover');if(!p)return false;let r=p.getBoundingClientRect();return r.width>0&&r.right<=innerWidth-7&&r.bottom<=innerHeight-7&&r.left>=7})()`),'popover bounded '+width);
    const result=await evaluate(`(()=>{const p=document.querySelector('.subagent-popover'),r=p.getBoundingClientRect(),head=p.querySelector('.subagent-popover-head'),h=head.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,scroll:p.scrollHeight>p.clientHeight,portal:p.parentElement===document.body,topmost:p.contains(document.elementFromPoint(r.right-10,h.top+h.height/2)),horizontalOverflow:p.scrollWidth>p.clientWidth}})()`);
    assert(result.portal&&result.topmost&&!result.horizontalOverflow&&result.scroll,JSON.stringify(result));
    report.checks.push({viewportWidth:width,viewportHeight:height,sidebar,panel,...result});
    const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,`popover-${width}-${panel}.png`),Buffer.from(shot.data,'base64'));
    // Portal remains interactive, supports its own scroll, and Escape dismissal.
    await evaluate(`document.querySelector('.subagent-popover').scrollTop=10000`);
    assert(await evaluate(`document.querySelector('.subagent-popover').scrollTop>0`));
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
    await until(()=>evaluate('!document.querySelector(".subagent-popover")'),'Escape dismiss');
  }
  await evaluate(`document.querySelector('.subagent-chip').click()`);
  await until(()=>evaluate('Boolean(document.querySelector(".subagent-popover-row"))'),'reopen');
  const point=await evaluate(`(()=>{let r=document.querySelector('.subagent-popover-row').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()`);
  await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
  await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
  await until(()=>evaluate('Boolean(window.overlapStore.getState().subagentView)'),'row opens child view');
  assert(await evaluate('!document.querySelector(".subagent-popover")'));
  report.checks.push('portal row navigation, scrolling, Escape close; 30 long-path rows');
};
