/** Full actual visibleRows callback comparison; no React substitutes and no timing claim. */
const assert=require('node:assert/strict');
const esbuild=require('esbuild');
module.exports=function checkProjectionEquivalence(source,candidate){
 const names=['tree','spaces','tasks','expandedSpaceIds','foregroundRequests','foregroundConversations','foregroundLimits','expandedConversations'];
 function compile(text){const marker='  const visibleRows = useMemo((): VisibleRow[] => {';const start=text.indexOf(marker)+marker.length;assert(start>=marker.length);const end=text.indexOf('  }, [tree, spaces, tasks,',start);assert(end>start);const body=text.slice(start,end);return new Function(esbuild.transformSync(`function project(${names.join(',')}) {${body}}; return project;`,{loader:'ts',target:'es2022'}).code)();}
 const before=compile(source),after=compile(candidate);let cases=0,rows=0;
 const check=args=>{const mutationGuard=JSON.stringify(args);const a=before(...args),b=after(...args);assert.deepEqual(b,a);assert.equal(JSON.stringify(args),mutationGuard,'neither implementation mutates inputs');for(let i=0;i<a.length;i++)for(const key of ['task','space','node','request','conversation'])assert.equal(b[i][key],a[i][key],'same object identity: '+key);cases++;rows+=a.length;return b;};
 const taskIds=['first','last','dup','__proto__','constructor','missing'];
 const spaces=[{id:'root',name:'First root'},{id:'child',name:'Child',parentId:'root'},{id:'root',name:'Later duplicate root'},{id:'empty',name:'Empty'}];
 const tasks=taskIds.filter(id=>id!=='missing').map((id,i)=>({id,title:'First '+id,status:['pending','completed','planning'][i%3],updatedAt:100-i}));tasks.splice(3,0,{id:'dup',title:'Later duplicate task'});
 const node=id=>({kind:'task',id,title:'Tree '+id});
 const tree=[{kind:'space',id:'root',children:[{kind:'space',id:'child',children:taskIds.map(node)},...taskIds.map(node)]},{kind:'space',id:'missing-space',children:[node('first')]},{kind:'space',id:'empty',children:[]},...taskIds.map(node)];
 const conversations=[{conversationId:'chat',spaceId:'root',title:'Foreground'},{conversationId:'archived',spaceId:'root',archived:true},{conversationId:'child-chat',spaceId:'child'},{conversationId:'empty-chat',spaceId:'empty'},{conversationId:'orphan',spaceId:'missing-space'}];
 const requests=Array.from({length:55},(_,i)=>({id:'request-'+String(55-i).padStart(2,'0'),spaceId:'root',conversationId:i<50?'chat':'archived',createdAt:Math.floor(i/3),status:['queued','running','completed','failed','cancelled','unknown'][i%6]}));requests.push({id:'child-request',spaceId:'child',conversationId:'child-chat',createdAt:100,status:'completed'});
 for(const expanded of [[],['root'],['root','child','empty'],['child'],['empty']])for(const expandedChats of [{},{chat:true},{chat:true,archived:true,'child-chat':true,'empty-chat':true}])for(const limit of [undefined,0,1,20,50,100]){
  const result=check([tree,spaces,tasks,expanded,requests,conversations,limit===undefined?{}:{chat:limit},expandedChats]);
  for(const row of result){if(row.kind==='task'&&row.task.id==='dup')assert.equal(row.task.title,'First dup');if(row.kind==='space'&&row.space.id==='root')assert.equal(row.space.name,'First root');}
 }
 // Task index must not eagerly traverse the tasks array for a fully collapsed tree.
 const neverIterate=new Proxy(tasks,{get(target,key,receiver){if(key===Symbol.iterator)throw Error('collapsed tree scanned tasks');return Reflect.get(target,key,receiver);}});
 assert.deepEqual(after([tree[0]],spaces,neverIterate,[],requests,conversations,{},{}),before([tree[0]],spaces,neverIterate,[],requests,conversations,{},{}));cases++;
 let seed=91231;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
 for(let c=0;c<150;c++){
  const shuffled=tasks.slice().sort(()=>random()-.5);const selected=taskIds.filter(()=>random()>.35).map(node);const customTree=[{kind:'space',id:'root',children:selected},...selected];
  check([customTree,spaces,shuffled,random()>.5?['root']:[],requests.slice(0,Math.floor(random()*requests.length)),conversations,{chat:Math.floor(random()*55)},{chat:random()>.5}]);
 }
 return {cases,rows,checks:['exact full projection values and order','first duplicate task and space matches','missing task and space skip','original task/space/node/request/conversation identities','nested and collapsed spaces','conversation grouping and expansion','foreground ordering/status/limits/more rows','empty and archived conversations','no input mutation','collapsed tree avoids task indexing']};
};
