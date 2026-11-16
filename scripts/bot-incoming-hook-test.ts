import {renderToStaticMarkup} from 'react-dom/server';
import assert from 'node:assert/strict';import {createElement} from 'react';import {act} from 'react';import {createRoot} from 'react-dom/client';import {parseHTML} from 'linkedom';import {mergeIncomingMessages,useBotIncomingMessages} from '../src/renderer/src/hooks/useBotIncomingMessages';
const {window,document}=parseHTML('<html><body><div id="root"></div></body></html>');Object.assign(globalThis,{window,document,IS_REACT_ACT_ENVIRONMENT:true});Object.defineProperty(document,'hidden',{value:false});let poll:any;globalThis.setInterval=((f:any)=>{poll=f;return 1}) as any;globalThis.clearInterval=(()=>{}) as any;
let pending:any[]=[];window.api={botWork:{incomingMessages:(q:any)=>new Promise(r=>pending.push({q,r}))}} as any;
let current:any;function App({id,members='a,b'}:{id:string;members?:string}){current=useBotIncomingMessages(id,members);return createElement('div',{'data-initial-loading':String(current.initialLoading)},current.items.map((x:any)=>createElement('span',{key:x.message.messageId},x.message.text)));}const root=createRoot(document.getElementById('root')!);
const item=(id:string,t:number)=>({message:{messageId:id,createdAt:t,text:id,kind:'request'},collaboration:{collaborationId:'c'},cursor:id});
assert.match(renderToStaticMarkup(createElement(App,{id:'a'})),/data-initial-loading="true"/,'SSR before effects must not claim empty');
await act(async()=>root.render(createElement(App,{id:'a'})));assert.equal(pending.length,1);assert.equal(current.initialLoading,true);await act(async()=>pending.shift().r({items:[item('new',30)],nextCursor:'old-cursor'}));
assert.equal(current.initialLoading,false);await act(async()=>{void current.more();});assert.equal(pending[0].q.before,'old-cursor');await act(async()=>poll());assert.equal(pending.length,1,'no concurrent polling race');await act(async()=>pending.shift().r({items:[item('old',10),item('new',30)],nextCursor:null}));assert.deepEqual(current.items.map((x:any)=>x.message.messageId),['old','new']);
await act(async()=>poll());assert.equal(pending[0].q.after,'new');await act(async()=>pending.shift().r({items:[item('newest',40)],nextCursor:null}));assert.deepEqual(current.items.map((x:any)=>x.message.messageId),['old','new','newest']);
assert.deepEqual(pending[0].q.refreshIds,['old','new'],'request-only rows are refreshed');
await act(async()=>pending.shift().r({items:[{...item('new',30),collaboration:{collaborationId:'c',updatedAt:100,status:'started',workId:'work-1'}}],nextCursor:null}));
assert.ok(current.items.every((x:any)=>x.collaboration.workId==='work-1'),'relation snapshot updates every loaded row');
const oldActions=current;

await act(async()=>poll());const stale=pending.shift();await act(async()=>root.render(createElement(App,{id:'b'})));assert.equal(current.initialLoading,true);await act(async()=>{void oldActions.more();void oldActions.retry();void oldActions.retrySummary('new');});assert.equal(pending.length,1,'old scope actions cannot operate on the new Bot');await act(async()=>stale.r({items:[item('wrong',50)],nextCursor:null}));assert.equal(current.items.length,0);await act(async()=>pending.shift().r({items:[item('b-only',60)],nextCursor:null}));assert.deepEqual(current.items.map((x:any)=>x.message.messageId),['b-only']);await act(async()=>poll());const preDelete=pending.shift();await act(async()=>root.render(createElement(App,{id:'b',members:'b'})));assert.equal(current.items.length,0);await act(async()=>preDelete.r({items:[item('deleted-return',70)],nextCursor:null}));assert.equal(current.items.length,0);await act(async()=>pending.shift().r({items:[],nextCursor:null}));assert.equal(current.items.length,0);assert.equal(current.initialLoading,false);await act(async()=>poll());await act(async()=>pending.shift().r({items:[{...item('reply',80),message:{...item('reply',80).message,kind:'reply'}}],nextCursor:null}));
await act(async()=>poll());assert.equal(pending[0].q.after,'reply');await act(async()=>pending.shift().r({items:[],nextCursor:null}));assert.deepEqual(pending[0].q.refreshIds,['reply']);
await act(async()=>pending.shift().r({items:[{...item('reply',80),message:{...item('reply',80).message,kind:'reply'},summary:{text:'Concise',status:'completed'}}],nextCursor:null}));assert.equal(current.items[0].summary.text,'Concise');
await act(async()=>poll());assert.equal(pending[0].q.after,'reply');await act(async()=>pending.shift().r({items:[],nextCursor:null}));assert.deepEqual(pending[0].q.refreshIds,['reply']);await act(async()=>pending.shift().r({items:[{...item('reply',80),message:{...item('reply',80).message,kind:'reply'}}],nextCursor:null}));assert.equal(current.items[0].summary,undefined,'removed completed summary does not persist as stale snapshot');
// A stale refresh response, not only a stale pagination response, must be fenced.
await act(async()=>poll());await act(async()=>pending.shift().r({items:[],nextCursor:null}));
const staleRefresh=pending.shift();await act(async()=>root.render(createElement(App,{id:'rotation'})));
await act(async()=>staleRefresh.r({items:[item('leak',999)],nextCursor:null}));assert.equal(current.items.length,0);
const many=Array.from({length:205},(_,i)=>item('r'+i,i));
await act(async()=>pending.shift().r({items:many,nextCursor:'older'}));
const seen=new Set<string>();
for(let i=0;i<3;i++){
 await act(async()=>poll());await act(async()=>pending.shift().r({items:[],nextCursor:null}));
 const refresh=pending.shift();assert.equal(refresh.q.refreshIds.length,100);
 refresh.q.refreshIds.forEach((id:string)=>seen.add(id));
 await act(async()=>refresh.r({items:[],nextCursor:null}));
}
assert.equal(seen.size,205,'bounded rotation eventually refreshes every request');
const recent={...item('recent',2),collaboration:{collaborationId:'c',updatedAt:200,status:'started'}};
const ancient={...item('ancient',1),collaboration:{collaborationId:'c',updatedAt:100,status:'sent'}};
assert.ok(mergeIncomingMessages([recent] as any,[ancient] as any,true).every(x=>x.collaboration.status==='started'));
const equal={...ancient,collaboration:{...ancient.collaboration,updatedAt:200}};
assert.ok(mergeIncomingMessages([recent] as any,[equal] as any,true).every(x=>x.collaboration.status==='started'),'older pages cannot regress equal timestamp snapshots');
await act(async()=>root.unmount());console.log('PASS React incoming pagination/poll serialization, dedup, catchup, stale Bot switch');

// React DOM/Node retains MessagePorts after unmount; all assertions above are awaited.
process.exit(0);
