const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./desktop-dev-harness.cjs');
const { initializeGitFixture, verifyGitWorkbench, verifyRustWorker } = require('./canban-review-desktop-cases.cjs');

const original = [
  '// 保留本地手工补充的运费说明',
  'const price = 6;',
  '',
  'export function shippingFee(quantity: number) {',
  '  if (quantity <= 0) return 0;',
  '  return quantity * price;',
  '}',
  '',
  'export function label(quantity: number) {',
  '  return `运费 ¥${shippingFee(quantity)}`;',
  '}',
  '',
].join('\r\n');
const revised = original.replace('const price = 6;', 'const price = 9;');
const accepted = 'export const kept = true;\n';
const removed = '这行来自用户的工作目录。\r\n';
const requests = {
  FIRST: [
    ['edit', { path: '报价.ts', edits: [{oldText:'const price = 6;',newText:'const price = 9;'}] }],
    ['write', { path: 'keep.ts', content: accepted }],
  ],
  REJECT: [
    ['write', { path: 'created.ts', content: 'export const transient = true;\n' }],
    ['write', { path: 'conflict.ts', content: 'export const mine = 2;\n' }],
    process.platform === 'win32'
      ? ['powershell', { command: "Remove-Item -LiteralPath 'obsolete.txt'" }]
      : ['bash', { command: "rm -- 'obsolete.txt'" }],
  ],
  ACCEPT: [
    ['write', { path: 'batch-a.ts', content: 'export const a = 1;\n' }],
    ['write', { path: 'batch-b.ts', content: 'export const b = 2;\n' }],
  ],
};
const prompts = {
  FIRST:'请更新报价里的单件运费，并保留本地说明。',
  REJECT:'补充运费测试，并移除过期的说明文件。',
  ACCEPT:'补充两份批量报价示例。',
};

run(async ({ evaluate, rpc, until, report, out, home, restart, requests: modelRequests }) => {
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace);
  const disk = name => path.join(workspace, name);
  fs.writeFileSync(disk('报价.ts'), original);
  fs.writeFileSync(disk('obsolete.txt'), removed);
  fs.writeFileSync(disk('conflict.ts'), 'export const mine = 1;\n');
  const task = {id:'review-e2e-task', title:'更新报价与运费规则', spaceId:'review-e2e-space',
    updatedAt:Date.now(), cwd:workspace, status:'idle', executionBackend:'pi', welcomeMode:'working', messages:[]};
  const space = {id:task.spaceId, name:'审查验收', path:workspace, createdAt:Date.now(), updatedAt:Date.now()};
  const otherTask = {...task, id:'review-e2e-other', title:'另一个独立任务'};
  await evaluate(`(async()=>{
    const {useAppStore:store}=await import('/src/store/appStore.ts');
    const task=${JSON.stringify(task)}, other=${JSON.stringify(otherTask)}, space=${JSON.stringify(space)};
    await window.api.db.upsertSpace(space); await window.api.db.upsertTask(task); await window.api.db.upsertTask(other);
    store.setState({page:'chat',activeTaskId:task.id,tasks:[task,other],spaces:[space],activeModelId:store.getState().models[0].id,
      panelOpen:true,panelMode:'overview',panelExpanded:false,draft:null});
  })()`);
  async function prompt(round) {
    const input = {taskId:task.id,spaceId:space.id,modelId:'fixture/ui-fixture',text:prompts[round],
      userMessageId:'user-'+round,assistantMessageId:'assistant-'+round,welcomeMode:'working',permissionMode:'auto'};
    const result = await evaluate(`window.api.agent.prompt(${JSON.stringify(input)}).then(r=>r.receipt?window.api.agent.waitForSubmission(r.receipt):r)`);
    assert.equal(result?.error, undefined, JSON.stringify(result));
  }
  const query = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length)`;
  const action = (label, selector = 'button') => `[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.getClientRects().length && !el.disabled && (el.getAttribute("aria-label")===${JSON.stringify(label)} || el.textContent.trim()===${JSON.stringify(label)}))`;
  async function clickNode(expression, label) {
    const deadline = Date.now() + 12000;
    await until(async () => {
      if (await evaluate(`Boolean(${expression})`)) return true;
      if (Date.now() > deadline) throw Error('Missing '+label+'; '+await evaluate('document.body.innerText.slice(-2400)'));
      return false;
    }, label);
    if (await evaluate('document.hidden')) {
      // Chromium drops mouse input when Windows occludes the test window.
      await evaluate(`(()=>{const el=${expression};el.focus();el.click();})()`);
      report.inputMode='CDP with DOM activation while Electron is occluded';
      return;
    }
    let point;
    await until(async ()=>{
      const next=await evaluate(`(()=>{const el=${expression};if(!el)return null;el.scrollIntoView({block:'nearest',inline:'nearest'});const rect=el.getBoundingClientRect();const x=rect.x+rect.width/2,y=rect.y+rect.height/2;return el.contains(document.elementFromPoint(x,y))?{x,y}:null;})()`);
      const stable=next && point && Math.abs(next.x-point.x)<0.5 && Math.abs(next.y-point.y)<0.5;
      point=next;
      return stable;
    },label+' is reachable and stationary');
    await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
    for (const type of ['mousePressed','mouseReleased']) {
      await rpc('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...point});
    }
  }
  const button = label => clickNode(action(label), label);
  const card = name => '[data-review-file="'+name+'"]';
  const fileButton = (name,label) => clickNode(action(label+' '+name,card(name)+' button'),name+' '+label);
  const file = name => clickNode(query('.code-review-file[data-review-path="'+name+'"]'),name);
  const review = () => clickNode(query('button[aria-label="代码审查"]'),'代码审查');
  const overview = id => evaluate(`import('/src/store/appStore.ts').then(({useAppStore})=>{const state=useAppStore.getState();state.setActiveTask(${JSON.stringify(id)});useAppStore.getState().showOverview();})`);
  async function expectBadge(count) {
    const buttonSelector='button[aria-label="代码审查"]';
    await until(()=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(buttonSelector)});if(!el?.getClientRects().length)return false;
      const badge=el.querySelector('[data-testid="code-review-pending-badge"]');
      return ${count}===0 ? badge===null : badge?.textContent.trim()===String(${count}) && !!badge.getClientRects().length;})()`),'pending review badge '+count);
  }
  async function checkBadgeContrast() {
    const colors=await evaluate(`(()=>{const badge=document.querySelector('button[aria-label="代码审查"] [data-testid="code-review-pending-badge"]');
      const style=getComputedStyle(badge);return [style.color,style.backgroundColor]})()`);
    const luminance=color=>{
      const rgb=color.match(/\d+(?:\.\d+)?/g).slice(0,3).map(value=>Number(value)/255)
        .map(channel=>channel<=0.04045 ? channel/12.92 : ((channel+0.055)/1.055)**2.4);
      return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
    };
    const [left,right]=colors.map(luminance);
    const ratio=(Math.max(left,right)+0.05)/(Math.min(left,right)+0.05);
    assert.ok(ratio>=4.5,JSON.stringify({colors,ratio}));
  }
  async function settledCanvasWidth(label) {
    const metrics=()=>evaluate(`(()=>{
      const panel=document.querySelector('.artifact-panel');
      // An occluded Chromium window can pause width transitions at time zero.
      if(document.hidden) for(const animation of panel.getAnimations()) {
        if (['width','min-width','max-width'].includes(animation.transitionProperty)) animation.finish();
      }
      return { rendered:panel.getBoundingClientRect().width, target:parseFloat(panel.style.width) };
    })()`);
    await until(async ()=>{
      const {rendered,target}=await metrics();
      return target>500 && Math.abs(rendered-target)<1;
    },label+' expands beyond the narrow rail');
    return (await metrics()).rendered;
  }
  const expectBytes = (name, expected) => assert.deepEqual(fs.readFileSync(disk(name)),Buffer.from(expected),name);
  const files = () => evaluate(`window.api.codeReview.list(${JSON.stringify(task.id)})`);
  async function expectStatus(name, status) {
    await until(async ()=>(await files()).find(row=>row.path===name)?.status===status,name+' '+status);
  }

  await expectBadge(0);
  await prompt('FIRST');
  await expectBadge(2);
  await overview(otherTask.id);
  await expectBadge(0);
  await overview(task.id);
  await expectBadge(2);
  await checkBadgeContrast();
  expectBytes('报价.ts', revised);
  expectBytes('keep.ts', accepted);
  await clickNode(query('button[title="内置浏览器"]'), '网页');
  const browserWidth = await settledCanvasWidth('网页');
  await review();
  await file('报价.ts');
  const pricingDiff = JSON.stringify(card('报价.ts')+' .code-review-diff');
  await until(()=>evaluate(`document.querySelector(${pricingDiff})?.textContent.includes("const price = 9")`),'new code in diff');
  assert.match(await evaluate(`document.querySelector(${pricingDiff}).textContent`), /const price = 6/);
  const reviewWidth = await settledCanvasWidth('代码审查');
  await checkBadgeContrast();
  report.canbanWasmExports = await verifyRustWorker(rpc);
  assert.ok(Math.abs(reviewWidth-browserWidth)<=1,JSON.stringify({browserWidth,reviewWidth}));
  const layout = await evaluate(`(()=>{
    const left=document.querySelector('.code-review-file').getBoundingClientRect(), right=document.querySelector('.code-review-diff').getBoundingClientRect();
    return {leftEnd:left.right,rightStart:right.left,codeWidth:right.width};
  })()`);
  assert.ok(layout.leftEnd<=layout.rightStart+1 && layout.codeWidth>120,JSON.stringify(layout));
  report.layout={browserWidth,reviewWidth,...layout};
  const controls=await evaluate(`['全部接受','全部拒绝','接受 报价.ts','拒绝 报价.ts'].map(label=>{
    const el=document.querySelector('.code-review button[aria-label="'+label+'"]');
    return el&&{name:label,text:el.innerText.trim(),icon:!!el.querySelector('svg'),width:el.getBoundingClientRect().width};
  })`);
  assert.ok(controls.every(control=>control?.icon && control.text==='' && control.width>=24 && control.width<=44),JSON.stringify(controls));
  report.decisionIcons=controls;
  const shot=await rpc('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(out,'review.png'),Buffer.from(shot.data,'base64'));
  const hiddenLine = 'export function label(quantity: number)';
  const pricingText=()=>evaluate(`document.querySelector(${pricingDiff}).textContent`);
  assert.ok(!(await pricingText()).includes(hiddenLine));
  await clickNode(query(card('报价.ts')+' .code-review-fold-button'),'展开上下文');
  await until(async ()=>(await pricingText()).includes(hiddenLine),'upstream context expansion shows unchanged lines from the real file');
  await clickNode(query(card('报价.ts')+' button[aria-label="批注新第 2 行"]'),'对新增行写审查意见');
  await evaluate('document.querySelector(".code-review-note textarea").focus()');
  await rpc('Input.insertText',{text:'核实价格来源'});
  await button('保存到审查');
  await button('查看审查草稿');
  await button('发送审查');
  await until(()=>modelRequests.some(request=>request.messages.some(message=>message.role==='user'
    && ['### Code Review','#### Inline Comments','核实价格来源','报价.ts:2','const price = 9;']
      .every(part=>JSON.stringify(message.content).includes(part)))),'upstream review Markdown reaches the original task');
  await fileButton('报价.ts','拒绝');
  await button('确认拒绝');
  await expectStatus('报价.ts','rejected');
  await expectBadge(1);
  await until(()=>fs.readFileSync(disk('报价.ts'),'utf8')===original,'byte-exact Chinese CRLF restore');
  await file('keep.ts');
  await fileButton('keep.ts','接受');
  await expectStatus('keep.ts','accepted');
  await expectBadge(0);
  expectBytes('keep.ts',accepted);
  report.checks.push('Real Pi writes in a non-Git workspace, desktop two-column diff and single-file decisions.');

  await prompt('REJECT');
  await expectBadge(3);
  assert.equal(fs.existsSync(disk('obsolete.txt')),false);
  expectBytes('created.ts','export const transient = true;\n');
  fs.writeFileSync(disk('conflict.ts'),'export const mine = "user edited";\n');
  await clickNode(query('.desktop-rail-module[aria-label="任务看板"]'),'任务看板');
  await clickNode(query('.task-board-review'), '从任务看板审查改动');
  await file('created.ts');
  await button('全部拒绝');
  await button('确认拒绝');
  await expectStatus('obsolete.txt','rejected');
  await expectStatus('created.ts','rejected');
  await expectBadge(1);
  const conflict=(await files()).find(row=>row.path==='conflict.ts');
  assert.equal(conflict.status,'pending');
  await until(()=>!fs.existsSync(disk('created.ts'))&&fs.existsSync(disk('obsolete.txt')),'batch reverses creation and deletion');
  expectBytes('obsolete.txt',removed);
  expectBytes('conflict.ts','export const mine = "user edited";\n');
  expectBytes('keep.ts',accepted);
  report.checks.push('Bulk reject removed the created file, recovered the deleted file and preserved subsequent user changes.');

  await prompt('ACCEPT');
  await file('batch-a.ts');
  await expectBadge(3);
  await clickNode(query(card('batch-a.ts')+' button[aria-label="批注新第 1 行"]'),'保存重启前的行内意见');
  await evaluate('document.querySelector(".code-review-note textarea").focus()');
  await rpc('Input.insertText',{text:'重启后核对这一行'});
  await button('保存到审查');
  await button('查看审查草稿');
  await evaluate('document.querySelector(\'textarea[aria-label="总体审查意见"]\').focus()');
  await rpc('Input.insertText',{text:'重启后继续审查'});
  const readGitState=initializeGitFixture(workspace);
  const gitBefore=readGitState();
  await restart();
  await overview(task.id);
  await expectBadge(3);
  await review();
  await button('查看审查草稿');
  await until(()=>evaluate(`document.querySelector('.code-review-draft-content')?.innerText.includes('重启后核对这一行') &&
    document.querySelector('textarea[aria-label="总体审查意见"]')?.value==='重启后继续审查'`),'saved draft and anchored comment survive application restart');
  await button('收起草稿');
  await button('全部接受');
  await expectStatus('batch-a.ts','accepted');
  await expectStatus('batch-b.ts','accepted');
  await expectBadge(0);
  expectBytes('batch-a.ts','export const a = 1;\n');
  expectBytes('batch-b.ts','export const b = 2;\n');
  expectBytes('conflict.ts','export const mine = "user edited";\n');
  report.checks.push('Saved inline comment and summary survived restart. The review badge tracked pending files while closed, across task switches, conflicts, single and bulk decisions, and restart.');
  const persisted=Object.fromEntries((await files()).map(row=>[row.path,row.status]));
  assert.deepEqual(persisted,{
    '报价.ts':'rejected','keep.ts':'accepted','created.ts':'rejected','obsolete.txt':'rejected',
    'conflict.ts':'accepted','batch-a.ts':'accepted','batch-b.ts':'accepted',
  });
  expectBytes('报价.ts',original);
  expectBytes('conflict.ts','export const mine = "user edited";\n');
  await evaluate(`import('/src/store/appStore.ts').then(({useAppStore})=>{const store=useAppStore.getState();store.setActiveTask(${JSON.stringify(task.id)});useAppStore.getState().showChanges();})`);
  await verifyGitWorkbench({evaluate,until,rpc,query,clickNode,out,workspace});
  assert.deepEqual(readGitState(),gitBefore,'browsing Git review preserves HEAD, index and working files');
  report.checks.push('Canban Rust ran in the live review worker and submitted an anchored review to Pi. Real Git produced separate staged, unstaged, untracked and revision comparisons.');
  assert.deepEqual(report.rendererErrors,[]);
  report.checks.push('Decisions and restored files survived an isolated Electron restart.');
}, {
  name:'code-review-desktop',watchRenderer:false,rpcTimeoutMs:120000,settings:{permissionMode:'auto'},
  fixtureModel(request) {
    const user=request.messages.findLast(message=>message.role==='user');
    const round=Object.keys(requests).find(key=>JSON.stringify(user?.content).includes(prompts[key]));
    if (!round) return 'Ready';
    const count=request.messages.slice(request.messages.lastIndexOf(user)+1).filter(message=>message.role==='tool').length;
    const operation=requests[round][count];
    if (!operation) return '已完成';
    assert(request.tools.some(entry=>entry.function.name===operation[0]),'Missing native '+operation[0]);
    return {tool:{name:operation[0],arguments:operation[1]}};
  },
}).catch(error=>{console.error(error);process.exitCode=1;});
