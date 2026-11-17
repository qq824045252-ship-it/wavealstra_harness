export function upgradePage(original) {
  if (original.includes('id="calendarFrom"')) return original;
  function replace(source, before, after) {
    if (!source.includes(before)) throw new Error('原界面结构已变化，请重新读取源码：' + before.slice(0, 60));
    return source.replace(before, after);
  }
  let html = replace(original.replace(/\r\n/g,'\n'), '</style>', `
  .calendar-controls { display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:8px 14px; border-bottom:1px solid var(--line); font-size:12px; }
  .app { grid-template-rows:auto auto auto minmax(0,1fr) auto; }
  .calendar-controls button,.calendar-controls input,.calendar-controls select { border:1px solid var(--line); background:var(--pane); color:var(--text); border-radius:5px; padding:5px 8px; font:inherit; }
  .calendar-controls label { display:flex; align-items:center; gap:5px; }
  #calendarStatus { margin-left:auto; color:var(--dim); }
</style>`);
  html = replace(html, '  <div class="cols">', `  <nav class="calendar-controls" aria-label="日历显示窗口">
    <button id="calendarPrev" type="button" aria-label="上一段日期">上一段</button>
    <button id="calendarToday" type="button">今天</button>
    <button id="calendarNext" type="button" aria-label="下一段日期">下一段</button>
    <button id="calendarHistory" type="button">最近历史</button>
    <label>起始日期 <input id="calendarFrom" type="date" required></label>
    <label>显示 <select id="calendarDays"><option value="7">7 天</option><option value="14">14 天</option><option value="31">31 天</option><option value="42">42 天</option></select></label>
    <span id="calendarStatus" role="status" aria-live="polite"></span>
  </nav>
  <div class="cols">`);
  html = replace(html, "const OUTBOX_KEY = 'atk.outbox.v1';", `
const todayKey = () => Temporal.Now.plainDateISO(TZ).toString();
const shiftDay = (day, offset) => Temporal.PlainDate.from(day).add({days:offset}).toString();
const zonedDay = value => Temporal.Instant.from(value).toZonedDateTimeISO(TZ).toPlainDate().toString();
const view = { from:todayKey(), days:7, events:null, epoch:0 };
let uiSave=Promise.resolve();
const OUTBOX_KEY = 'atk.outbox.v1';`);
  html=replace(html,"function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }",`function save(k,v) {
  try{localStorage.setItem(k,JSON.stringify(v))}catch{}
  if(window.gadget){const snapshot=structuredClone(v);uiSave=uiSave.catch(()=>{}).then(()=>gadget.storage.set(k,snapshot)).catch(error=>showErr('本地状态保存失败：'+error.message));}
}`);
  const loadStart = html.indexOf('async function loadData(force) {');
  const loadEnd = html.indexOf('/* ---------------- timeline ---------------- */', loadStart);
  if (loadStart < 0 || loadEnd < 0) throw new Error('缺少数据加载入口');
  html = html.slice(0, loadStart) + `async function loadData(force) {
  const data = window.gadget
    ? await gadget.call('calendar.read')
    : await fetch('./data.json?t='+Date.now(),{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('读取快照失败');return response.json()});
  if (!force && state.data && state.data.generatedAt===data.generatedAt && JSON.stringify(state.data.calendarSync)===JSON.stringify(data.calendarSync)) return false;
  state.data=data;
  await loadWindowEvents();
  return true;
}
async function loadWindowEvents() {
  const epoch=++view.epoch;
  if (window.gadget && (state.data?.events||[]).some(event=>event.recurrence||event.recurringEventId)) {
    const result=await gadget.call('calendar.view',{from:view.from,to:shiftDay(view.from,view.days-1)});
    if(epoch!==view.epoch)return;
    view.events=result.events;
  } else { view.events=null; }
}
function eventOnDay(event, key) {
  if (!event.start || event.status==='cancelled') return false;
  const start=event.allDay ? event.start.slice(0,10) : zonedDay(event.start);
  if(event.allDay) return key>=start && key<(event.end?.slice(0,10)||shiftDay(start,1));
  const startOfDay=Temporal.PlainDate.from(key).toZonedDateTime(TZ).epochMilliseconds;
  const endOfDay=Temporal.PlainDate.from(shiftDay(key,1)).toZonedDateTime(TZ).epochMilliseconds;
  const from=Date.parse(event.start),to=event.end?Date.parse(event.end):from+1;
  return from<endOfDay && to>startOfDay;
}
async function changeWindow(from,days=view.days) {
  from=Temporal.PlainDate.from(from).toString();
  if(![7,14,31,42].includes(days))throw Error('显示窗口无效');
  view.from=from;view.days=days;view.events=null;
  document.getElementById('calendarFrom').value=from;
  document.getElementById('calendarDays').value=String(days);
  renderAll();
  try {
    await loadWindowEvents();renderAll();
    if(window.gadget)await gadget.config.set('calendar.display',{from,days});
  } catch(error){showErr(error.message);}
}

` + html.slice(loadEnd);
  html = replace(html, "  return dkey(new Date(ev.start));", '  return zonedDay(ev.start);');
  html = replace(html, '  const today = dkey(new Date());', '  const today = todayKey();');
  const groupStart = html.indexOf('  for (let i = 0; i < 7; i++) days.push');
  const groupEnd = html.indexOf('  const html = days.map', groupStart);
  if (groupStart < 0 || groupEnd < 0) throw new Error('未找到固定七天渲染范围');
  html = html.slice(0,groupStart)+`  for(let i=0;i<view.days;i++)days.push(shiftDay(view.from,i));
  const byDay=new Map(days.map(key=>[key,(view.events||d.events||[]).filter(event=>eventOnDay(event,key))]));
`+html.slice(groupEnd);
  html = replace(html, "    const date = new Date(k + 'T00:00:00');", '    const date = Temporal.PlainDate.from(k);');
  html = replace(html, "(idx === 1 ? '明天' : WEEK[date.getDay()])", "(k === shiftDay(today,1) ? '明天' : WEEK[date.dayOfWeek % 7])");
  html = replace(html, "esc(md(k + 'T00:00:00'))", 'esc(k.slice(5).replace("-","/"))');
  html = replace(html, "  const d = new Date(iso);\n  return pad(d.getMonth() + 1) + '/' + pad(d.getDate());", "  const key = /^\\d{4}-\\d{2}-\\d{2}$/.test(iso) ? iso : zonedDay(iso);\n  return key.slice(5).replace('-','/');");
  const reloadStart = html.indexOf("document.getElementById('reload').addEventListener('click'");
  const reloadEnd = html.indexOf("document.getElementById('copyBtn').addEventListener", reloadStart);
  if(reloadStart<0||reloadEnd<0)throw Error('缺少刷新入口');
  html=html.slice(0,reloadStart)+`document.getElementById('reload').addEventListener('click',async()=>{
  const button=document.getElementById('reload');button.disabled=true;button.textContent='同步中…';
  try {
    if(!window.gadget)throw Error('请在 MyBuddy 中打开以同步 Google 日历');
    await gadget.call('calendar.sync');await loadData(true);renderAll();
  }catch(error){showErr(error.message);}
  finally{button.disabled=false;button.textContent='同步日历';}
});
document.getElementById('calendarPrev').addEventListener('click',()=>changeWindow(shiftDay(view.from,-view.days)));
document.getElementById('calendarNext').addEventListener('click',()=>changeWindow(shiftDay(view.from,view.days)));
document.getElementById('calendarToday').addEventListener('click',()=>changeWindow(todayKey()));
document.getElementById('calendarHistory').addEventListener('click',()=>{
  const dates=(state.data?.events||[]).filter(event=>event.start&&eventDay(event)<todayKey()).map(eventDay).sort();
  const latest=dates.at(-1);
  if(latest){const day=Temporal.PlainDate.from(latest);changeWindow(day.subtract({days:day.dayOfWeek-1}).toString(),7);}
});
document.getElementById('calendarFrom').addEventListener('change',event=>{if(event.target.value)changeWindow(event.target.value)});
document.getElementById('calendarDays').addEventListener('change',event=>changeWindow(view.from,Number(event.target.value)));

`+html.slice(reloadEnd);
  const errStart=html.indexOf('function showErr(msg) {');
  const errEnd=html.indexOf('function renderAll()',errStart);
  if(errStart<0||errEnd<0)throw Error('未找到错误展示');
  html=html.slice(0,errStart)+`function showErr(msg) {
  const status=document.getElementById('calendarStatus');
  status.textContent=msg+'；保留上次完整数据';status.style.color='var(--warn)';
}

`+html.slice(errEnd);
  html=replace(html,"  const gen = new Date(d.generatedAt);",`  const gen = new Date(d.generatedAt);
  const shown=(view.events||d.events||[]).filter(event=>Array.from({length:view.days},(_,i)=>shiftDay(view.from,i)).some(key=>eventOnDay(event,key))).length;
  const status=document.getElementById('calendarStatus');
  status.style.color=d.calendarSync?.error?'var(--warn)':'';
  status.textContent=d.calendarSync?.error?d.calendarSync.error.message:'显示 '+view.from+' 至 '+shiftDay(view.from,view.days-1)+' · 本窗 '+shown+' / 本地 '+(d.events||[]).length+' 条日程 · 同步覆盖全部历史与未来';
  document.getElementById('calendarFrom').value=view.from;
  document.getElementById('calendarDays').value=String(view.days);`);
  html=replace(html,'    await loadData(true);',`    if(window.gadget){
      const savedQueue=await gadget.storage.get(OUTBOX_KEY),savedDone=await gadget.storage.get(DONE_KEY);
      if(Array.isArray(savedQueue))state.outbox=[...new Map([...savedQueue,...state.outbox].map(item=>[JSON.stringify(item),item])).values()];
      if(Array.isArray(savedDone))state.done=new Set([...savedDone,...state.done]);
      await gadget.storage.set(OUTBOX_KEY,state.outbox);await gadget.storage.set(DONE_KEY,[...state.done]);
      const saved=await gadget.config.get('calendar.display');
      if(saved&&typeof saved.from==='string'&&[7,14,31,42].includes(saved.days)){view.from=Temporal.PlainDate.from(saved.from).toString();view.days=saved.days;}
    }
    document.getElementById('reload').textContent='同步日历';
    await loadData(true);`);
  return html;
}
