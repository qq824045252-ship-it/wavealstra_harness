/** Isolated real pnpm dev Electron Sidebar comparison. Synthetic scale; second-rAF is a paint-opportunity proxy, not physical presentation. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),net=require('node:net'),os=require('node:os');
const sourceRoot=path.resolve(__dirname,'..');
const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'sbd-src-'));
const baselineRef=process.env.SIDEBAR_BASE_REF||'c8d951597edb9580b3d06e1b7bc2fbf9e349143a';
cp.execFileSync('git',['archive',baselineRef],{cwd:sourceRoot,stdio:['ignore',fs.openSync(path.join(fixtureRoot,'source.tar'),'w'),'inherit']});
cp.execFileSync('tar',['-xf',path.join(fixtureRoot,'source.tar'),'-C',fixtureRoot]);
fs.mkdirSync(path.join(fixtureRoot,'node_modules'));
for(const name of fs.readdirSync(path.join(sourceRoot,'node_modules'))) if(!['.vite','.vite-temp','.cache'].includes(name))fs.symlinkSync(path.join(sourceRoot,'node_modules',name),path.join(fixtureRoot,'node_modules',name));
for(const name of ['.vite','.vite-temp']){
 const own=path.join(fixtureRoot,'node_modules',name);fs.mkdirSync(own);
 assert(!fs.lstatSync(own).isSymbolicLink());assert.equal(fs.realpathSync(own),own);
}
function cacheInventory(){
 const crypto=require('node:crypto');const dirs=['.vite','.vite-temp'].map(name=>path.join(fs.realpathSync(path.join(sourceRoot,'node_modules')),name));const records=[];
 const walk=p=>{if(!fs.existsSync(p)){records.push([p,'absent']);return;}const st=fs.lstatSync(p,{bigint:true});if(st.isSymbolicLink()){records.push([p,'symlink',fs.readlinkSync(p)]);return;}records.push([p,st.isDirectory()?'dir':'file',String(st.size),String(st.mtimeNs),st.isFile()?crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null]);if(st.isDirectory())for(const name of fs.readdirSync(p).sort())walk(path.join(p,name));};dirs.forEach(walk);return{paths:dirs,entries:records.length,digest:crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex')};
}
const cacheBefore=cacheInventory();
const root=fixtureRoot;
// Pin Vite's generated cache explicitly: dependency symlinks must stay read-only.
const viteConfigPath=path.join(root,'electron.vite.config.ts');
const viteConfig=fs.readFileSync(viteConfigPath,'utf8');
assert(viteConfig.includes('  renderer: {'));
fs.writeFileSync(viteConfigPath,viteConfig.replace('  renderer: {','  renderer: {\n    cacheDir: resolve(__dirname, "out/sidebar-projection-vite-cache"),'));
assert.equal(process.platform,'linux');assert(process.env.WAYLAND_DISPLAY||process.env.DISPLAY,'Real desktop required');
const out=path.join(sourceRoot,'out/diagnostics/sidebar-projection-dev-'+Date.now());fs.mkdirSync(out,{recursive:true});
const home=fs.mkdtempSync(path.join(os.tmpdir(),'sbd-')),agentDir=path.join(home,'.mybuddy');fs.mkdirSync(agentDir,{recursive:true});
let processDev,socket,sequence=0,log,electronExecutable,devDebugPort,launcherIdentity,electronWatch,electronSeenAt;
const ownedElectronMains=new Map(),pending=new Map();
const report={status:'running',home,displayMode:'real desktop session',inputMode:'CDP input and DOM activation',validatesNativeDesktopInput:false,checks:[],rendererErrors:[],measurements:[],snapshots:[],sourceRoot,fixtureRoot,baselineRef,cacheBefore,mode:process.env.SIDEBAR_SMALL_PARITY?'behavior-parity':process.env.SIDEBAR_NAV_ONLY?'navigation-refresh':'interaction',metric:process.env.SIDEBAR_SMALL_PARITY?'Exact real-app state, projection, DOM and search behavior comparison; no latency claim':process.env.SIDEBAR_NAV_ONLY?'Actual workspaceNavigation IPC start to second requestAnimationFrame in real navigation hook, including IPC/store/render work and excluding scheduled debounce; not user-input latency':'CDP click event timestamp to second requestAnimationFrame after handler; Event Timing presentation duration where emitted; not physical input or photodiode presentation'};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,label)=>{const end=Date.now()+120000;while(!await fn()){if(Date.now()>end)throw Error('timeout: '+label);await wait(100);}};
const freePort=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
function linuxProcessState(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { pid, parent: Number(fields[1]), startedAt: fields[19],
      args: fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean) };
  } catch { return undefined; } // The process may have exited between proc reads.
}
const observedDescendants = new Map();
function isTestElectronMain(state) {
  if (!state || observedDescendants.get(state.pid) !== state.startedAt) return false;
  // Electron rewrites Linux argv into one space-separated entry and clears its
  // initial environ. Bind executable/cwd, launcher ancestry, unique debug port
  // and PID start-time rather than relying on NUL-separated argv or HOME.
  const command = state.args.join(' ');
  if (/(?:^|\s)--type(?:=|\s)/.test(command)
    || !new RegExp('(?:^|\\s)--remote-debugging-port=' + devDebugPort + '(?:\\s|$)').test(command)) return false;
  try { return fs.realpathSync('/proc/'+state.pid+'/exe') === electronExecutable
    && fs.realpathSync('/proc/'+state.pid+'/cwd') === fs.realpathSync(root); }
  catch { return false; }
}
function trackTestElectronMains() {
  if (!launcherIdentity) return;
  const launcher = linuxProcessState(launcherIdentity.pid);
  if (!launcher || launcher.startedAt !== launcherIdentity.startedAt) return;
  const queue = [launcher], seen = new Set();
  while (queue.length) {
    const state = queue.shift(); if (seen.has(state.pid)) continue; seen.add(state.pid);
    observedDescendants.set(state.pid, state.startedAt);
    if (isTestElectronMain(state)) ownedElectronMains.set(state.pid, state.startedAt);
    let children;try { children=fs.readFileSync('/proc/'+state.pid+'/task/'+state.pid+'/children','utf8').trim().split(/\s+/).filter(Boolean); }catch{continue;}
    for(const id of children){const child=linuxProcessState(Number(id));if(child?.parent===state.pid)queue.push(child);}
  }
}
async function stopTestElectronMains() {
  if (process.platform !== 'linux') return;
  trackTestElectronMains();
  const stillOwned = (pid, startedAt) => {
    const state = linuxProcessState(pid);
    return state?.startedAt === startedAt && isTestElectronMain(state);
  };
  for (const [pid, startedAt] of ownedElectronMains) if (stillOwned(pid, startedAt)) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  // Only the main process receives a signal. Let Electron close its GPU/renderers
  // itself; PID start time and the isolated profile prevent unrelated-process kills.
  const deadline = Date.now() + 3000;
  while ([...ownedElectronMains].some(([pid, startedAt]) => stillOwned(pid, startedAt)) && Date.now() < deadline) await wait(50);
}
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const value = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (value.exceptionDetails) throw Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
  return value.result?.value;
}
const sidebarPath=path.join(root,'src/renderer/src/components/Sidebar.tsx');
const source=fs.readFileSync(sidebarPath,'utf8');
const marker='  const visibleRows = useMemo((): VisibleRow[] => {';
assert(source.includes(marker));
const expectedCandidate=source.replace(marker,marker+'\n    let tasksById: Map<string, Task> | undefined;').replace('          const task = tasks.find((t) => t.id === n.id);',`          if (!tasksById) {
            tasksById = new Map<string, Task>();
            for (const task of tasks) if (!tasksById.has(task.id)) tasksById.set(task.id, task);
          }
          const task = tasksById.get(n.id);`);
const candidate=fs.readFileSync(path.join(sourceRoot,'src/renderer/src/components/Sidebar.tsx'),'utf8');
assert.equal(candidate,expectedCandidate,'Actual source must match the task-only first-match candidate measured against pinned baseline');
assert.notEqual(candidate,source);
fs.writeFileSync(path.join(out,'baseline-Sidebar.tsx'),source);
assert(!/tasksById/.test(source.slice(source.indexOf(marker),source.indexOf('  const [popup'))),'Baseline must not contain candidate');
fs.writeFileSync(path.join(out,'candidate-Sidebar.tsx'),candidate);
report.projectionEquivalence=require('./sidebar-projection-dev-equivalence.cjs')(source,candidate);
let instrumentSequence=0;
function instrument(value,variant){
 const moduleSequence=++instrumentSequence;
 return ('(window as any).__sbModuleVariant = '+JSON.stringify(variant)+';\n(window as any).__sbModuleSequence = '+moduleSequence+';\n'+value).replace(marker,marker+'\n    const __sbStarted = performance.now();')
 .replace('    walk(tree, 0);\n    return rows;',`    walk(tree, 0);
    ((window as any).__sbProjection ||= []).push({ variant: ${JSON.stringify(variant)}, ms: performance.now() - __sbStarted, rows: rows.length });
    (window as any).__sbRows = rows;
    return rows;`);
}
fs.writeFileSync(sidebarPath,instrument(source,'baseline'));
if(process.env.SIDEBAR_NAV_ONLY){
 const navPath=path.join(root,'src/renderer/src/hooks/useBotWorkspaceNavigation.ts');
 let nav=fs.readFileSync(navPath,'utf8');
 nav=nav.replace('      const result: BotWorkspaceNavigationDto = await api.workspaceNavigation();',`      const __sbNavStart=performance.now();
      const result: BotWorkspaceNavigationDto = await api.workspaceNavigation();
      const __sbNavIpcEnd=performance.now();
      (window as any).__sbProjection=[];`);
 nav=nav.replace('    } catch (error) {',`      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        ((window as any).__sbNavSamples ||= []).push({start:__sbNavStart,ipcMs:__sbNavIpcEnd-__sbNavStart,toSecondRaf:performance.now()-__sbNavStart,projections:((window as any).__sbProjection||[]).slice(),conversations:result.conversations,requests:result.foregroundRequests});
      }));
    } catch (error) {`);
 fs.writeFileSync(navPath,nav);
 const mainPath=path.join(root,'src/renderer/src/main.tsx');fs.writeFileSync(mainPath,fs.readFileSync(mainPath,'utf8').replace('ReactDOM.createRoot','useAppStore.setState({page:"bot"});\nReactDOM.createRoot'));
}

const rendererProbe=`
window.__sbEvents=[];
window.__sbEventObserver=new PerformanceObserver(list=>window.__sbEvents.push(...list.getEntries().map(e=>({name:e.name,startTime:e.startTime,duration:e.duration,processingStart:e.processingStart,processingEnd:e.processingEnd,interactionId:e.interactionId}))));
try{window.__sbEventObserver.observe({type:'event',buffered:true,durationThreshold:16});}catch(e){}
window.__sbArm=label=>{window.__sbClickResult=null; window.__sbArmLabel=label;window.__sbProjection=[];window.__sbEvents=[];};
document.addEventListener('click',event=>{
 if(!window.__sbArmLabel)return;
 const label=window.__sbArmLabel;window.__sbArmLabel=null;
 const start=event.timeStamp,capture=performance.now();
 requestAnimationFrame(()=>{const firstRaf=performance.now();requestAnimationFrame(()=>{
  window.__sbClickResult={label,start,capture,firstRaf,end:performance.now(),toFirstRaf:firstRaf-start,toSecondRaf:performance.now()-start,queueMs:capture-start,projections:window.__sbProjection.slice()};
 });});
},true);
window.__sbSnapshot=()=>({
 rows:window.__sbRows.map(r=>({key:r.key,kind:r.kind,depth:r.depth,collapsed:r.collapsed,hasChildren:r.hasChildren,task:r.task&&{id:r.task.id,title:r.task.title,spaceId:r.task.spaceId,status:r.task.status,archived:r.task.archived,isFavorited:r.task.isFavorited,updatedAt:r.task.updatedAt,spaceSortOrder:r.task.spaceSortOrder,doneAckedAt:r.task.doneAckedAt},space:r.space&&{id:r.space.id,name:r.space.name,parentId:r.space.parentId,sortOrder:r.space.sortOrder,createdAt:r.space.createdAt,archived:r.space.archived,effectiveArchived:r.space.effectiveArchived},conversation:r.conversation,request:r.request,expanded:r.expanded,count:r.count,remaining:r.remaining})),
 dom:[...document.querySelectorAll('.sidebar-section-list .task-item, .sidebar-pinned .task-item,.space-header')].map(e=>({text:e.querySelector('.task-item-title')?.textContent??e.textContent,className:e.className,title:e.classList.contains('task-item')?null:e.getAttribute('title'),depth:e.getAttribute('data-depth'),badges:[...e.querySelectorAll('.task-badge,.task-status-running,.task-status-done,.task-pin-badge')].map(b=>({text:b.textContent,title:b.title,className:b.className}))})),
 counts:[...document.querySelectorAll('.sidebar-section-count,.sidebar-pinned .section-title')].map(e=>e.textContent),
 state:{expanded:window.__sbStore.getState().expandedSpaceIds,status:window.__sbStore.getState().taskFilterStatus,time:window.__sbStore.getState().taskFilterTime}
});`;
async function settle(){await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await wait(80);}
async function activate(expression,label,record=true){
 const point=await evaluate(`(()=>{const e=${expression};if(!e)throw Error('Missing target ${label}');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
 await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...point});await settle();
 await evaluate(`window.__sbArm(${JSON.stringify(label)})`);
 await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
 await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
 await until(()=>evaluate('Boolean(window.__sbClickResult)'),label+' frame');
 await wait(80);
 const result=await evaluate('({...window.__sbClickResult,events:window.__sbEvents.filter(e=>e.name==="click"&&Math.abs(e.startTime-window.__sbClickResult.start)<20),taskNodes:document.querySelectorAll(".task-item").length})');
 if(record){report.measurements.push(result);console.log(JSON.stringify(result));fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
 return result;
}
const button=label=>`[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(label)})`;
const chevron=`[...document.querySelectorAll('.space-header')].find(e=>e.querySelector('.space-name')?.textContent==='Benchmark workspace').querySelector('.space-chevron')`;
async function resetSize(size,expanded=false){
 await evaluate(`window.__sbStore.setState({tasks:window.__sbAllTasks.slice(0,${size}),spaces:window.__sbAllSpaces,expandedSpaceIds:${expanded?'["sb-root","sb-nested","sb-other"]':'[]'},taskFilterStatus:'all',taskFilterTime:'all',activeTaskId:null,page:'chat',searchOpen:false,draft:null})`);await settle();
}
function summarize(list){const values=list.map(x=>x.toSecondRaf).sort((a,b)=>a-b);const projections=list.map(x=>x.projections.reduce((n,p)=>n+p.ms,0)).sort((a,b)=>a-b);return{n:values.length,median:values[Math.floor(values.length/2)],min:values[0],max:values.at(-1),projectionMedian:projections[Math.floor(projections.length/2)]};}
async function phase(variant){
 for(const size of [20,1000,5000]){
  await resetSize(size);
  await activate(chevron,variant+':'+size+':warm-expand',false);await activate(chevron,variant+':'+size+':warm-collapse',false);
  for(let i=0;i<5;i++){
   await activate(chevron,variant+':'+size+':expand');
   if(i===0)report.snapshots.push({variant,size,case:'expanded',snapshot:await evaluate('window.__sbSnapshot()')});
   await activate(chevron,variant+':'+size+':collapse');
  }
  report.snapshots.push({variant,size,case:'collapsed',snapshot:await evaluate('window.__sbSnapshot()')});
  await activate(`document.querySelector('.icon-btn[title="筛选"]')`,variant+':'+size+':open-filter-collapsed');
  await activate(button('已完成'),variant+':'+size+':filter-completed-collapsed');
  report.snapshots.push({variant,size,case:'filter-collapsed',snapshot:await evaluate('window.__sbSnapshot()')});
  await activate(button('重置筛选条件'),variant+':'+size+':reset-filter-collapsed');
  await resetSize(size,true);
  await activate(`document.querySelector('.icon-btn[title="筛选"]')`,variant+':'+size+':open-filter-expanded');
  for(let i=0;i<3;i++){
   await activate(button('已完成'),variant+':'+size+':filter-completed-expanded');
   if(i===0)report.snapshots.push({variant,size,case:'filter-expanded',snapshot:await evaluate('window.__sbSnapshot()')});
   await activate(button('全部状态'),variant+':'+size+':filter-all-expanded');
  }
  await activate(`document.querySelector('.icon-btn[title="筛选"]')`,variant+':'+size+':close-filter',false);
  await activate(`document.querySelector('.icon-btn[title="搜索 (Ctrl+K)"]')`,variant+':'+size+':search-open');
  assert(await evaluate('window.__sbStore.getState().searchOpen'));
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await settle();
  await activate(`document.querySelector('.sidebar-pinned .task-item')||document.querySelector('.task-item')`,variant+':'+size+':task-select');
  assert(await evaluate('Boolean(window.__sbStore.getState().activeTaskId)'));
  console.log('SUMMARY '+variant+' '+size+' '+JSON.stringify(Object.fromEntries(['expand','collapse','filter-completed-expanded','filter-all-expanded'].map(op=>[op,summarize(report.measurements.filter(x=>x.label===variant+':'+size+':'+op))]))));
 }
}


async function switchVariant(variant){
 await evaluate('window.__sbProjection=[]');
 fs.writeFileSync(sidebarPath,instrument(variant==='candidate'?candidate:source,variant));
 const expectedModuleSequence=instrumentSequence;
 await until(()=>evaluate(`window.__sbModuleVariant===${JSON.stringify(variant)}&&window.__sbModuleSequence===${expectedModuleSequence}`),'hot module loaded '+variant);
 await evaluate('window.__sbStore.setState(s=>({expandedSpaceIds:s.expandedSpaceIds.slice()}))');
 await until(()=>evaluate(`window.__sbProjection.some(p=>p.variant===${JSON.stringify(variant)})`),'hot projection applied '+variant);await settle();
}
async function smallParityPhases(){
 await evaluate('window.__sbStore.setState({page:"chat",activeTaskId:null,expandedSpaceIds:window.__sbAllSpaces.map(s=>s.id)})');await settle();
 async function pair(name,action){
  await switchVariant('baseline');if(action)await action();await settle();
  const before=await evaluate('window.__sbSnapshot()');
  await switchVariant('candidate');const after=await evaluate('window.__sbSnapshot()');
  assert.deepEqual(after,before,'small live parity '+name);report.snapshots.push({case:name,baseline:before,candidate:after});report.checks.push('Exact live row/DOM parity: '+name);console.log('PARITY '+name);
 }
 await pair('initial nested groups, counts, order and statuses');
 await pair('dynamic status via real store command and DB IPC',async()=>{
  await evaluate(`window.__sbStore.getState().setTaskStatus('sb-task-00004','in_progress')`);
  await until(()=>evaluate(`window.api.db.listTasks().then(tasks=>tasks.find(t=>t.id==='sb-task-00004').status==='in_progress')`),'status persisted');
 });
 await pair('rename and recency order',()=>evaluate(`window.__sbStore.getState().renameTask('sb-task-00019','Sidebar renamed needle')`));
 await pair('group move via real workspace command and IPC',async()=>{assert((await evaluate(`window.__sbStore.getState().moveTaskInWorkspaceTree({taskId:'sb-task-00019',targetSpaceId:'sb-nested',targetIndex:0})`)).ok);});
 await pair('explicit sibling order preserves current selector behavior',async()=>{assert((await evaluate(`window.__sbStore.getState().moveTaskInWorkspaceTree({taskId:'sb-task-00019',targetSpaceId:'sb-nested',targetIndex:1})`)).ok);});
 await pair('pin and pinned section through actual command',()=>evaluate(`window.__sbStore.getState().togglePinTask('sb-task-00019')`));
 for(const [value,label] of [['in_progress','进行中'],['completed','已完成'],['failed','失败'],['pending','待处理'],['planning','规划中'],['all','全部状态']]){
  await pair('filter '+value,async()=>{
   if(!await evaluate('Boolean(document.querySelector(".filter-popup"))'))await activate(`document.querySelector('.icon-btn[title="筛选"]')`,'parity:open-filter',false);
   await activate(button(label),'parity:filter:'+value,false);
  });
 }
 await activate(`document.querySelector('.icon-btn[title="筛选"]')`,'parity:close-filter',false);
 await pair('collapse group',()=>activate(chevron,'parity:collapse',false));
 await pair('expand group',()=>activate(chevron,'parity:expand',false));
 await pair('foreground conversation expansion and 20-row limit',()=>activate(`document.querySelector('[data-conversation-id="sbd-conversation-0"]')`,'parity:conversation',false));
 await pair('foreground show-more appends remaining requests',()=>activate(`[...document.querySelectorAll('.workspace-foreground-row')].find(e=>e.textContent.includes('再看 30'))`,'parity:show-more',false));
 const searches=[];
 for(const variant of ['baseline','candidate']){
  await switchVariant(variant);
  await activate(`document.querySelector('.icon-btn[title="搜索 (Ctrl+K)"]')`,'parity:'+variant+':search',false);
  await evaluate('document.querySelector(".search-modal-input").focus()');await rpc('Input.insertText',{text:'renamed needle'});await settle();
  const results=await evaluate('[...document.querySelectorAll(".search-modal-item-title")].map(e=>e.textContent)');assert.deepEqual(results,['Sidebar renamed needle']);searches.push({variant,query:'renamed needle',results});
  await activate(`document.querySelector('.search-modal-item')`,'parity:'+variant+':select-result',false);
  await until(()=>evaluate(`window.__sbStore.getState().activeTaskId==='sb-task-00019'&&!window.__sbStore.getState().searchOpen`),'search result selection');
 }
 report.searches=searches;report.checks.push('CDP typed search query and selected identical single result in both variants');
 await candidateMountedActions();
}

/** Exercise updates with candidate mounted throughout; no HMR or unrelated rerender between actions. */
async function candidateMountedActions(){
 await switchVariant('candidate');
 await evaluate(`import('/src/utils/taskFilters.ts').then(m=>window.__sbMatchesTaskFilter=m.matchesTaskFilter)`);
 await evaluate('window.__sbStore.getState().resetTaskFilters();window.__sbStore.setState({page:"chat",activeTaskId:null,searchOpen:false,expandedSpaceIds:window.__sbStore.getState().spaces.map(s=>s.id)})');
 await settle();
 const moduleSequence=await evaluate('window.__sbModuleSequence');
 const targetId='sb-task-00004';
 await evaluate(`window.__sbImmediateSnapshot=()=>{
  const state=window.__sbStore.getState(),task=state.tasks.find(t=>t.id===${JSON.stringify(targetId)});
  const row=window.__sbRows.find(r=>r.kind==='task'&&r.task.id===task.id);
  const items=[...document.querySelectorAll('.sidebar .task-item')];
  const element=items.find(e=>e.querySelector('.task-item-title')?.textContent===task.title);
  const filtered=state.tasks.filter(t=>!t.archived&&window.__sbMatchesTaskFilter(t,state.taskFilterStatus,state.taskFilterTime));
  const pinned=t=>Boolean(t.isFavorited)||state.pinnedTaskIds.includes(t.id);
  return{moduleSequence:window.__sbModuleSequence,variant:window.__sbModuleVariant,
   task:{id:task.id,title:task.title,status:task.status,spaceId:task.spaceId??null,isFavorited:Boolean(task.isFavorited),updatedAt:task.updatedAt},
   row:row?{title:row.task.title,status:row.task.status,spaceId:row.task.spaceId??null,isFavorited:Boolean(row.task.isFavorited),depth:row.depth}:null,
   element:element?{title:element.querySelector('.task-item-title').textContent,statusClasses:[...element.classList].filter(c=>c.startsWith('status-')),pinned:element.classList.contains('pinned'),inPinnedSection:Boolean(element.closest('.sidebar-pinned')),runningDot:Boolean(element.querySelector('.task-status-running')),doneDot:Boolean(element.querySelector('.task-status-done'))}:null,
   actualTitles:items.map(e=>e.querySelector('.task-item-title').textContent).sort(),expectedTitles:filtered.map(t=>t.title).sort(),
   actualCounts:[...document.querySelectorAll('.sidebar-scroll .sidebar-section-count')].map(e=>Number(e.textContent)),
   expectedCounts:[filtered.filter(t=>t.spaceId==null&&!pinned(t)).length,filtered.filter(t=>t.spaceId!=null&&!pinned(t)).length+27],filter:state.taskFilterStatus};
 }`);
 report.candidateMountedActions=[];
 async function inspect(label){
  // Two frame opportunities allow the actual external-store subscription to commit. No forced store update.
  const value=await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(window.__sbImmediateSnapshot()))))');
  assert.equal(value.variant,'candidate');assert.equal(value.moduleSequence,moduleSequence,'no hot reload during candidate actions');
  assert.deepEqual(value.actualTitles,value.expectedTitles,label+' immediate visible titles');
  assert.deepEqual(value.actualCounts,value.expectedCounts,label+' immediate section counts');
  if(value.element){assert(value.row,label+' projected row exists');assert.equal(value.row.title,value.task.title);assert.equal(value.row.status,value.task.status);assert.equal(value.row.spaceId,value.task.spaceId);assert.equal(value.row.isFavorited,value.task.isFavorited);}
  report.candidateMountedActions.push({label,...value});console.log('CANDIDATE ACTION '+label);return value;
 }
 for(const [status,statusClasses] of [['pending',[]],['in_progress',['status-running']],['completed',['status-done']]]){
  await evaluate(`window.__sbStore.getState().setTaskStatus(${JSON.stringify(targetId)},${JSON.stringify(status)})`);
  const value=await inspect('status '+status);assert.equal(value.task.status,status);assert(value.element);
  assert.deepEqual(value.element.statusClasses,statusClasses);
  assert.equal(value.element.runningDot,status==='in_progress');assert.equal(value.element.doneDot,status==='completed');
  await until(()=>evaluate(`window.api.db.listTasks().then(tasks=>tasks.find(t=>t.id===${JSON.stringify(targetId)}).status===${JSON.stringify(status)})`),'candidate status persisted '+status);
 }
 await evaluate(`window.__sbStore.getState().renameTask(${JSON.stringify(targetId)},'Candidate immediate renamed')`);
 const renamed=await inspect('rename visible task');assert.equal(renamed.element.title,'Candidate immediate renamed');assert(!renamed.actualTitles.includes('Synthetic task 00004'));
 for(const desired of [true,false]){
  await evaluate(`window.__sbStore.getState().togglePinTask(${JSON.stringify(targetId)})`);
  const value=await inspect(desired?'pin':'unpin');assert.equal(value.task.isFavorited,desired);assert.equal(value.element.pinned,desired);assert.equal(value.element.inPinnedSection,desired);
  await until(()=>evaluate(`window.api.db.listTasks().then(tasks=>Boolean(tasks.find(t=>t.id===${JSON.stringify(targetId)}).isFavorited)===${desired})`),'candidate pin persisted');
 }
 for(const targetSpaceId of ['sb-other',null]){
  assert((await evaluate(`window.__sbStore.getState().moveTaskInWorkspaceTree({taskId:${JSON.stringify(targetId)},targetSpaceId:${JSON.stringify(targetSpaceId)},targetIndex:0})`)).ok);
  const value=await inspect(targetSpaceId?'move to other group':'move to independent group');assert.equal(value.task.spaceId,targetSpaceId);assert.equal(value.row.spaceId,targetSpaceId);
  await until(()=>evaluate(`window.api.db.listTasks().then(tasks=>(tasks.find(t=>t.id===${JSON.stringify(targetId)}).spaceId??null)===${JSON.stringify(targetSpaceId)})`),'candidate group persisted');
 }
 await activate(`document.querySelector('.icon-btn[title="筛选"]')`,'candidate-actions:open-filter',false);
 for(const [status,label,visible] of [['pending','待处理',false],['completed','已完成',true],['in_progress','进行中',false],['all','全部状态',true]]){
  await activate(button(label),'candidate-actions:filter:'+status,false);const value=await inspect('filter '+status);assert.equal(value.filter,status);assert.equal(Boolean(value.element),visible);
 }
 await activate(`document.querySelector('.icon-btn[title="筛选"]')`,'candidate-actions:close-filter',false);
 assert.equal(await evaluate('window.__sbModuleSequence'),moduleSequence);
 report.checks.push('Candidate stayed mounted without HMR while pending/running/completed status, rename, pin/unpin, group moves and filters updated actual rows/DOM/counts immediately; status/pin/group persistence read back through IPC');
 report.checks.push('Existing pending-status-only appearance preserved: no pending badge unless approval/interaction messages exist; running and completed indicators update normally');
}

async function navigationPhases(){
 await evaluate('window.__sbStore.setState({page:"bot",activeTaskId:null,expandedSpaceIds:[]})');await settle();
 for(const [round,variant] of ['baseline','candidate','candidate','baseline'].entries()){
  await switchVariant(variant);
  for(const size of [20,1000,5000]){
   await evaluate(`window.__sbStore.setState({tasks:window.__sbAllTasks.slice(0,${size}),page:'bot',activeTaskId:null,expandedSpaceIds:[]})`);await settle();
   for(let i=0;i<6;i++){
    await evaluate('window.__sbNavSamples=[];window.__sbProjection=[]');
    await evaluate(`window.api.botWork.archiveConversation('bot-mybuddy-default','sbd-conversation-0').then(()=>{window.__sbNavTriggered=performance.now();window.dispatchEvent(new Event('mybuddy:teams-refresh'))})`);
    await until(()=>evaluate('window.__sbNavSamples.some(s=>s.start>window.__sbNavTriggered&&s.projections.length>0)'),'real navigation refresh');
    const result=await evaluate(`(()=>{const s=window.__sbNavSamples.find(s=>s.start>window.__sbNavTriggered&&s.projections.length>0);return{label:'nav:'+${JSON.stringify(variant)}+':'+${size}+':round'+${round},round:${round},size:${size},variant:${JSON.stringify(variant)},ipcMs:s.ipcMs,toSecondRaf:s.toSecondRaf,triggerToSecondRaf:s.start-window.__sbNavTriggered+s.toSecondRaf,projections:s.projections,requests:s.requests.length,conversations:s.conversations.length,hidden:document.hidden,taskNodes:document.querySelectorAll('.task-item').length}})()`);
    if(i>0){report.measurements.push(result);console.log(JSON.stringify(result));fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));}
   }
  }
 }
 report.checks.push('Navigation timing uses real archive IPC on isolated fixture, application refresh event, unchanged 500ms debounce, actual main snapshot/preload/store/hooks, hidden ordinary-task DOM; timing is IPC-start-to-second-rAF, not user input');
}

(async()=>{try{
 const seed=path.join(out,'seed.cjs');await require('esbuild').build({entryPoints:[path.join(sourceRoot,'scripts/sidebar-projection-dev-seed.ts')],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:seed});
 cp.execFileSync(process.execPath,[seed],{cwd:sourceRoot,env:{...process.env,HOME:home,SIDEBAR_PROJECTION_HOME:home,TMPDIR:home},stdio:'inherit'});
 fs.writeFileSync(path.join(agentDir,'models.json'),JSON.stringify({providers:{fixture:{api:'openai-completions',apiKey:'synthetic-not-a-secret',baseUrl:'http://127.0.0.1:1/v1',models:[{id:'fixture',name:'Synthetic sidebar fixture',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
 fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture',enabledModels:['fixture/fixture'],memoryEnabled:false,memoryGatewayEnabled:false,remoteAccessEnabled:false,closeToTray:false,theme:'light',permissionMode:'readonly'}));
 const port=await freePort();devDebugPort=port;electronExecutable=fs.realpathSync(require('electron'));
 const env={...process.env,HOME:home,USERPROFILE:home,TMPDIR:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),XDG_DATA_HOME:path.join(home,'.local/share'),XDG_STATE_HOME:path.join(home,'.local/state'),REMOTE_DEBUGGING_PORT:String(port),ELECTRON_CLI_ARGS:JSON.stringify(['--remote-debugging-address=127.0.0.1','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--enable-logging=stderr'])};delete env.ELECTRON_RUN_AS_NODE;
 log=fs.openSync(path.join(out,'dev.log'),'w');processDev=cp.spawn('pnpm',['dev'],{cwd:root,env,stdio:['ignore',log,log]});
 launcherIdentity=linuxProcessState(processDev.pid);trackTestElectronMains();electronWatch=setInterval(trackTestElectronMains,100);electronWatch.unref();
 let target;await until(async()=>{if(processDev.exitCode!==null)throw Error('pnpm dev exited '+processDev.exitCode);try{target=(await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)}).then(r=>r.json())).find(t=>t.type==='page'&&/localhost|127\.0\.0\.1/.test(t.url));return Boolean(target);}catch{return false;}},'dev renderer');
 socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 socket.addEventListener('message',event=>{const v=JSON.parse(event.data);if(v.method==='Runtime.exceptionThrown')report.rendererErrors.push(v.params);const call=pending.get(v.id);if(!call)return;pending.delete(v.id);clearTimeout(call.timer);v.error?call.reject(Error(JSON.stringify(v.error))):call.resolve(v.result);});
 await rpc('Runtime.enable');await rpc('Page.enable');await rpc('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});await rpc('Page.bringToFront');
 await until(()=>evaluate('Boolean(window.api?.db&&document.querySelector(".sidebar-user-main"))'),'App and preload');
 await evaluate(`import('/src/store/appStore.ts').then(m=>window.__sbStore=m.useAppStore)`);
 const expectedTasks=process.env.SIDEBAR_SMALL_PARITY?20:5000;
 await until(()=>evaluate('window.__sbStore.getState().tasks.length==='+expectedTasks),expectedTasks+' real bootstrapped tasks');
 await evaluate('window.__sbAllTasks=window.__sbStore.getState().tasks;window.__sbAllSpaces=window.__sbStore.getState().spaces');
 await evaluate(rendererProbe);await wait(2000);
 report.environment=await evaluate('({userAgent:navigator.userAgent,eventTypes:PerformanceObserver.supportedEntryTypes,hidden:document.hidden,focus:document.hasFocus(),tasks:window.__sbAllTasks.length,spaces:window.__sbAllSpaces.length})');
 report.fixture={databaseTasks:expectedTasks,bootstrappedTasks:expectedTasks,rendererTaskCounts:process.env.SIDEBAR_SMALL_PARITY?[20]:[20,1000,5000],rendererTaskSource:'Actual bootstrapped Task objects sliced into the unchanged app store; DB stays fixed across sizes',spaces:report.environment.spaces,foregroundRequests:process.env.SIDEBAR_NAV_ONLY?27:0,foregroundConversations:process.env.SIDEBAR_NAV_ONLY?3:0,ordinaryTaskDom:process.env.SIDEBAR_NAV_ONLY&&!process.env.SIDEBAR_SMALL_PARITY?'0; Bot page hides tree JSX': 'actual current visible task rows'};

 if(process.env.SIDEBAR_SMALL_PARITY) await smallParityPhases();
 else if(process.env.SIDEBAR_NAV_ONLY) await navigationPhases();
 else {
 await phase('baseline');
 if(!process.env.SIDEBAR_BASELINE_ONLY){
  await switchVariant('candidate');await resetSize(20);
  await phase('candidate');
  for(const b of report.snapshots.filter(x=>x.variant==='baseline')){const c=report.snapshots.find(x=>x.variant==='candidate'&&x.size===b.size&&x.case===b.case);assert.deepEqual(c.snapshot,b.snapshot,`snapshot ${b.size}/${b.case}`);}
  report.checks.push('Exact row keys, row order, depths, task/space data, collapsed state, DOM text/classes and counts match for 20/1k/5k expanded, collapsed and filtered states');
 }
 }
 assert.deepEqual(report.rendererErrors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=String(error.stack||error);console.error(error);process.exitCode=1;}
finally{
 if(electronWatch)clearInterval(electronWatch);
 if(socket){try{await rpc('Browser.close');}catch{}socket.close();}
 await stopTestElectronMains();if(processDev){await wait(1000);if(processDev.exitCode===null)processDev.kill('SIGTERM');}
 report.cacheAfter=cacheInventory();report.sharedGeneratedCacheUnchanged=report.cacheAfter.digest===report.cacheBefore.digest;
 if(!report.sharedGeneratedCacheUnchanged){report.status='failed';report.cacheError='Shared generated cache changed during isolated run';process.exitCode=1;}
 report.ownedElectronMains=[...ownedElectronMains];report.remainingOwnedMains=[...ownedElectronMains].filter(([pid,start])=>linuxProcessState(pid)?.startedAt===start&&isTestElectronMain(linuxProcessState(pid)));
 if(report.remainingOwnedMains.length){report.status='failed';process.exitCode=1;}
 if(log!==undefined)fs.closeSync(log);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log('Sidebar projection dev: '+report.status+'; '+path.join(out,'report.json'));
}})();
