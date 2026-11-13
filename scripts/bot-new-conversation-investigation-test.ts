import assert from 'node:assert/strict';
import {createBotConversationActions,createBotConversationState} from '../src/renderer/src/store/app/slices/botConversation';
import {mergeBotMessageEvent} from '../src/renderer/src/store/app/slices/botMessageStream';
const message:any={messageId:'m',botId:'a',conversationId:'old',requestId:'r',ordinal:1,role:'assistant',status:'completed',text:'preserve me',workIds:[],createdAt:1,updatedAt:1};
const history=(id='old',teamId?:string):any=>({botId:'a',teamId,conversationId:id,revision:1,archived:false,messages:id?[{...message,conversationId:id}]:[]});
function deferred(){let resolve!:(x:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {resolve,promise};}
function fixture(teamId?:string) {
 const scope=teamId?'team:'+teamId:'a';
 const state:any={...createBotConversationState(),botHistories:{[scope]:history('old',teamId)},activeBotId:'a',activeTeam:teamId?{templateId:teamId}:null,botDraft:'keep draft',botWorks:[{workId:'keep-work'}],botNavigationEpoch:0};
 let archived=false;let online=true;
 let archive=async()=>{archived=true};let read=async(_request?:any):Promise<any>=>history('',teamId);
 const api:any={botWork:{archiveConversation:(..._args:any[])=>archive(),history:(request:any)=>read(request),listBots:async()=>[{botId:'a'},{botId:'b'}]}};
 Object.assign(state,createBotConversationActions({get:()=>state,set:(next:any)=>Object.assign(state,typeof next==='function'?next(state):next),getApi:()=>online?api:undefined} as any));
 return {state,scope,archived:()=>archived,offline:()=>{online=false},archive:(fn:typeof archive)=>archive=fn,read:(fn:typeof read)=>read=fn};
}
{
 const f=fixture();await f.state.archiveBotConversation('a');assert(f.archived());assert.equal(f.state.botHistories.a.conversationId,'');assert.deepEqual(f.state.botHistories.a.messages,[]);assert.equal(f.state.botDraft,'keep draft');assert.equal(f.state.botWorks[0].workId,'keep-work');
 console.log('PASS confirmed archive retires transcript, preserves draft and Work');
}
{
 const f=fixture();f.offline();await assert.rejects(f.state.archiveBotConversation('a'));assert(!f.archived());assert.equal(f.state.botHistories.a.messages[0].text,'preserve me');
 const g=fixture();g.archive(async()=>{throw Error('IPC rejected')});await assert.rejects(g.state.archiveBotConversation('a'));assert.equal(g.state.botHistories.a.conversationId,'old');
 console.log('PASS offline and archive rejection preserve unarchived content and reject');
}
{
 const f=fixture();f.read(async()=>{throw Error('read failed')});await f.state.archiveBotConversation('a');assert(f.archived());assert.equal(f.state.botHistories.a.conversationId,'');assert.equal(f.state.botConversationErrors.a,'read failed');assert.equal(mergeBotMessageEvent(f.state.botHistories.a,{botId:'a',conversationId:'old',revision:10,message}),f.state.botHistories.a);
 console.log('PASS history failure cannot leave archived messages visible; late stream rejected');
}
{
 const f=fixture();const old=deferred();let n=0;f.read(()=>++n===1?old.promise:Promise.resolve(history('')));const pending=f.state.refreshBotHistory('a');await f.state.archiveBotConversation('a');old.resolve(history());await pending;assert.equal(f.state.botHistories.a.conversationId,'');
 console.log('PASS late old refresh cannot restore archived transcript');
}
{
 const f=fixture();const wait=deferred();f.archive(()=>wait.promise);const pending=f.state.archiveBotConversation('a');f.state.botHistories.a=history('newer');wait.resolve(undefined);await pending;assert.equal(f.state.botHistories.a.conversationId,'newer');
 console.log('PASS newer conversation chosen during archive IPC is not cleared');
}
{
 const f=fixture();const wait=deferred();f.archive(()=>wait.promise);const pending=f.state.archiveBotConversation('a');f.state.activeBotId='b';f.state.botHistories.b={...history('b-current'),botId:'b'};wait.resolve(undefined);await pending;assert.equal(f.state.activeBotId,'b');assert.equal(f.state.botHistories.b.conversationId,'b-current');assert.equal(f.state.botHistories.a.conversationId,'');
 const team=fixture('t');await team.state.archiveBotConversation('a','t');assert.equal(team.state.botHistories['team:t'].conversationId,'');assert.equal(team.state.activeTeam.templateId,'t');
 console.log('PASS Bot switch and team scope preserved');
}
console.log('PASS new-conversation archive boundary regression tests; synthetic store only, no real user data');
{
 const f=fixture();f.state.botHistories.a.before=10;const old=deferred();let n=0;f.read(()=>++n===1?old.promise:Promise.resolve(history('')));const pending=f.state.loadOlderBotHistory('a');assert.equal(f.state.botHistoryPages.a.loading,true);await f.state.archiveBotConversation('a');old.resolve(history());await pending;assert.equal(f.state.botHistories.a.conversationId,'');assert.equal(f.state.botHistoryPages.a.loading,false);
 console.log('PASS late older page cannot restore archived transcript or loading state');
}
{
 const f=fixture();const late=deferred();const started=deferred();f.read((request:any)=>{if(request.conversationId==='old'){started.resolve(undefined);return late.promise;}return Promise.resolve(history(''));});
 const notify=f.state.openNotificationConversation({botId:'a',conversationId:'old'}).then(()=>false,()=>true);await started.promise;await f.state.archiveBotConversation('a');late.resolve(history());assert.equal(await notify,true);assert.equal(f.state.botHistories.a.conversationId,'');
 console.log('PASS delayed pre-archive notification read cannot restore retired conversation');
}
{
 const f=fixture();const archive=deferred();f.archive(()=>archive.promise);const pending=f.state.archiveBotConversation('a');f.state.botNavigationEpoch++;const newer=f.state.botNavigationEpoch;archive.resolve(undefined);await pending;assert.equal(f.state.botNavigationEpoch,newer);
 console.log('PASS newer navigation epoch is not cancelled by older archive completion');
}
