/** Real SettingsModal and compaction IPC, no production data or model request. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
module.exports = async ({evaluate, rpc, until, report, out, getOwnedElectronPids}) => {
  assert(process.platform==='linux' && process.env.HYPRLAND_INSTANCE_SIGNATURE, 'Native settings layout acceptance requires a real Hyprland session');
  const pause = () => new Promise(resolve => setTimeout(resolve, 150));
  const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
  const button = label => `[...document.querySelectorAll('.compaction-settings button')].find(e=>(e.getAttribute('aria-label')||e.textContent).trim()===${JSON.stringify(label)})`;
  const click = async expression => {
    await evaluate(`(${expression}).scrollIntoView({block:'nearest'})`);
    const p = await evaluate(`(()=>{const e=${expression};if(!e||e.disabled||e.closest('fieldset[disabled]'))throw Error('Disabled/missing control');const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Control is occluded');return {x,y}})()`);
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
    await pause();
  };
  const input = async value => {
    await click(q('#compaction-absolute'));
    await rpc('Input.dispatchKeyEvent',{type:'rawKeyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2});
    await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:process.platform==='darwin'?4:2});
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
    if(value)await rpc('Input.insertText',{text:value});
    await pause();
  };
  const open = async () => {
    await evaluate(`window.compactionTestStore.getState().setSettingsOpen(true,'system')`);
    await until(()=>evaluate(`!!document.querySelector('.compaction-settings fieldset:not([disabled])')`),'settings loaded');
    await evaluate(`document.querySelector('.compaction-settings').closest('section').scrollIntoView({block:'start'})`);
    await pause();
  };
  const close = async () => {
    await click(q('.settings-content-head .icon-btn'));
    await until(()=>evaluate(`!document.querySelector('.settings-modal')`),'settings closed');
  };
  const save = async () => {
    await click(button('保存压缩设置'));
    await until(()=>evaluate(`document.querySelector('.compaction-save-state')?.textContent.includes('已保存')`),'settings IPC save');
    return await evaluate(`window.api.agent.getAppSettings()`);
  };
  await evaluate(`(async()=>{
    const {useAppStore:s}=await import('/src/store/appStore.ts');window.compactionTestStore=s;
    await window.api.agent.updateAppSettings({compactionEngine:'billion-context',compactionTriggerRatio:0.8,compactionTriggerTokens:500000});
    const m=s.getState().models.find(m=>m.id==='fixture/fixture');if(!m)throw Error('Fixture model missing');
    s.setState({activeTaskId:null,activeModelId:m.id,models:[{...m,name:'DeepSeek V4.1 Flash Eco · Open Design · 长模型名称布局验收',contextWindow:1000000}],theme:'light'});
  })()`);
  report.seededPresentationFacts.push('Synthetic 1M-token model with a long name; production settings component and real settings IPC in isolated HOME; zero model calls.');
  await open();
  assert(await evaluate(`document.querySelector('.compaction-summary-trigger strong').textContent==='500K'`));
  await click(button('按比例压缩（Pi 原生）'));
  await click(button('50%'));
  await click(button('64K'));
  let saved=await save();
  assert.equal(saved.compactionEngine,'native');assert.equal(saved.compactionTriggerRatio,0.5);assert.equal(saved.compactionTriggerTokens,64000);
  await close();await open();
  assert(await evaluate(`document.querySelector('[aria-label="按比例压缩（Pi 原生）"]').getAttribute('aria-pressed')==='true' && document.querySelector('#compaction-absolute').value==='64'`));
  await click(button('启用绝对压缩阈值'));
  assert(await evaluate(`document.querySelector('#compaction-absolute').disabled && [...document.querySelectorAll('[aria-label="上下文用量预设"] button')].every(e=>e.disabled)`));
  saved=await save();assert.equal(saved.compactionTriggerTokens,null);
  await click(button('启用绝对压缩阈值'));
  await input('');
  assert(await evaluate(`document.querySelector('#compaction-absolute').getAttribute('aria-invalid')==='true' && document.querySelector('.compaction-footer button').disabled`));
  await input('100001');
  assert(await evaluate(`document.querySelector('.compaction-footer button').disabled`));
  await input('1.0001');
  assert(await evaluate(`document.querySelector('.compaction-footer button').disabled`),'fractional tokens remain invalid');
  await input('1.001');saved=await save();assert.equal(saved.compactionTriggerTokens,1001);
  assert(await evaluate(`document.querySelector('.compaction-feedback--warning').textContent.includes('不是硬性用量上限')`));
  await click(button('分层摘要（billion-context）'));await click(button('80%'));await input('500');await save();
  await close();await open();
  await click(button('30%'));await close();await open();
  assert(await evaluate(`document.querySelector('#compaction-ratio').value==='80'`),'discarded edits do not become persisted settings');
  // Keyboard-operated slider uses the real native range control, then restores 80%.
  await evaluate(`document.querySelector('#compaction-ratio').focus()`);
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowLeft',code:'ArrowLeft',windowsVirtualKeyCode:37});
  await until(()=>evaluate(`(()=>{const e=document.querySelector('#compaction-ratio'),s=getComputedStyle(e);return e.matches(':focus-visible') && s.outlineStyle!=='none' && parseFloat(s.outlineWidth)>0})()`),'keyboard range focus remains visible');
  // Fractional display scaling can quantize a declared 2px outline below 2 CSS px.
  report.checks.push({keyboardFocus:await evaluate(`(()=>{const e=document.querySelector('#compaction-ratio'),s=getComputedStyle(e);return {focusVisible:e.matches(':focus-visible'),style:s.outlineStyle,width:s.outlineWidth,color:s.outlineColor}})()`)});
  await until(()=>evaluate(`document.querySelector('#compaction-ratio').value==='75'`),'keyboard range adjustment');
  await click(button('80%'));await save();
  report.actualControlChecks.push('Electron mouse/keyboard: engine switch, ratio and absolute presets, save/reopen persistence, disabled absolute threshold, empty/oversized/fractional token validation, low-threshold warning, discard/reopen, keyboard range. Actual preload and Main settings IPC, no mock save.');
  await rpc('Emulation.clearDeviceMetricsOverride');
  const clients=()=>JSON.parse(cp.execFileSync('hyprctl',['clients','-j'],{encoding:'utf8'}));
  const ownWindows=clients().filter(w=>getOwnedElectronPids().includes(w.pid));
  assert.equal(ownWindows.length,1,'exactly one verified test window');
  const {pid,address}=ownWindows[0];
  assert(/^0x[0-9a-f]+$/i.test(address),'valid compositor window address');
  const ownedWindow=()=>{assert(getOwnedElectronPids().includes(pid),'test process identity remains valid');const w=clients().find(w=>w.pid===pid&&w.address===address);assert(w,'owned compositor window exists');return w;};
  const dispatch=operation=>{ownedWindow();cp.execFileSync('hyprctl',['eval',`hl.dispatch(hl.dsp.window.${operation})`]);};
  dispatch(`float({action="on",window="address:${address}"})`);
  dispatch(`move({x=20,y=40,relative=false,window="address:${address}"})`);
  for(const [width,height,theme,uiFontSize] of [[1440,1000,'light',15],[1120,820,'dark',15],[960,640,'light',15],[960,740,'dark',20]]) {
    dispatch(`resize({x=${width},y=${height},relative=false,window="address:${address}"})`);
    await until(()=>evaluate(`outerWidth===${width} && outerHeight===${height}`),'real native window resize');
    await evaluate(`(async()=>{window.compactionTestStore.setState({theme:${JSON.stringify(theme)}});(await import('/src/lib/fontSettings.ts')).applyFontSettings({uiFontSize:${uiFontSize}})})()`);
    await pause();
    await evaluate(`document.querySelector('.compaction-settings').closest('section').scrollIntoView({block:'start'})`);
    await pause();
    const layout=await evaluate(`(()=>{const c=document.querySelector('.compaction-settings'),body=document.querySelector('.settings-content-body');return {width:innerWidth,height:innerHeight,sectionWidth:c.clientWidth,left:c.getBoundingClientRect().left,right:c.getBoundingClientRect().right,overflow:c.scrollWidth>c.clientWidth+1,bodyOverflow:body.scrollWidth>body.clientWidth+1,cards:[...document.querySelectorAll('.compaction-engine-option')].map(e=>({width:e.clientWidth,overflow:e.scrollWidth>e.clientWidth+1})),textColor:getComputedStyle(c).color,theme:document.documentElement.dataset.theme}})()`);
    assert(!layout.overflow&&!layout.bodyOverflow&&layout.cards.every(c=>!c.overflow),'no horizontal overflow: '+JSON.stringify(layout));
    assert(layout.sectionWidth>250 && layout.left>=0 && layout.right<=layout.width+1,'usable bounded narrow layout: '+JSON.stringify(layout));
    const native=ownedWindow();
    assert.deepEqual(native.size,[width,height],'compositor confirms native dimensions');
    assert.equal(layout.theme,theme,'theme applied');
    report.checks.push({requested:{width,height,theme,uiFontSize},nativeBounds:{pid,address,size:native.size},layout});
    const capture=async suffix=>fs.writeFileSync(path.join(out,`context-${theme}-${width}-${uiFontSize}-${suffix}.png`),Buffer.from((await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
    await capture('top');
    await click(button('50%'));await save();await capture('saved');
    await click(button('80%'));await save();
  }
  await evaluate(`(async()=>{(await import('/src/lib/fontSettings.ts')).applyFontSettings({uiFontSize:15})})()`);await close();await open();await close();
  report.actualControlChecks.push('Real native Electron window bounds 1440×1000, 1120×820, 960×640 and 960×740; light/dark, supported 15px/20px UI typography, no overflow, save hit-testing and repeated close/reopen. Screenshots include scrollable top and saved footer. No viewport emulation for layout evidence.');
};
