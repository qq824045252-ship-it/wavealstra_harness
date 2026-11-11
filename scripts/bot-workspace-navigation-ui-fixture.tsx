import "./bot-workspace-navigation-ui-env";
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {useAppStore} from '../src/renderer/src/store/appStore';
import Sidebar from '../src/renderer/src/components/Sidebar';
import WorkspaceDetail from '../src/renderer/src/components/workspace/WorkspaceDetail';
const spaces = [{id:'root-bot',name:'Bot',parentId:null},{id:'personal',name:'学习搭子',parentId:'root-bot'},{id:'root-team',name:'Bot团队',parentId:null},{id:'team',name:'产品团队',parentId:'root-team'}];
const requests=Array.from({length:35},(_,i)=>({id:'r'+i,spaceId:'personal',botId:'bot',conversationId:i===34?'new':'old',requestId:'r'+i,messageId:'m'+i,title:'个人任务'+i,status:'completed',createdAt:100-i,updatedAt:100-i,archived:true}));
requests.push({...requests[0],id:'team-r',spaceId:'team',requestId:'team-r',title:'团队任务',conversationId:'team-c',teamId:'team'} as any);
const conversations=[{conversationId:'old',spaceId:'personal',botId:'bot',title:'旧对话',archived:true,createdAt:1,updatedAt:1},{conversationId:'new',spaceId:'personal',botId:'bot',title:'新对话',archived:false,createdAt:2,updatedAt:2},{conversationId:'team-c',spaceId:'team',botId:'bot',teamId:'team',title:'团队对话',archived:false,createdAt:3,updatedAt:3}];
let eventListener: any;
(window as any).api={botWork:{workspaceNavigation:async()=>({spaces,taskSpaces:[],foregroundRequests:requests,conversations}),onMessageChanged:(fn:any)=>{eventListener=fn;return()=>{};},teamControl:async()=>({ok:true,templates:[]}),history:async(q:any)=>({conversationId:q.conversationId,botId:q.botId,teamId:q.teamId,revision:1,archived:true,messages:requests.filter(r=>r.conversationId===q.conversationId).flatMap(r=>[{messageId:r.messageId+'u',requestId:r.requestId,conversationId:r.conversationId,botId:'bot',ordinal:1,role:'user',text:r.title,status:'completed',workIds:r.requestId==='r0'?['shared-work']:[],createdAt:1,updatedAt:1},{messageId:r.messageId,requestId:r.requestId,conversationId:r.conversationId,botId:'bot',ordinal:2,role:'assistant',text:'## '+r.title+'结果',status:'completed',workIds:r.requestId==='r0'?['shared-work']:[],createdAt:1,updatedAt:1}])})},notifications:{list:async()=>[],unreadCount:async()=>0},db:{listSpaces:async()=>spaces}};
useAppStore.setState({spaces,tasks:[],page:'chat',activeWorkspaceId:null,expandedSpaceIds:spaces.map(s=>s.id),openWorkspaceDetail:(id:string)=>useAppStore.setState({activeWorkspaceId:id,page:'workspace'})});
function Fixture(){const page=useAppStore(state=>state.page);return <div style={{display:'flex'}}><Sidebar/><main style={{flex:1}}>{page==='workspace'&&<WorkspaceDetail/>}</main></div>}
const root=createRoot(document.getElementById('root')!);
(window as any).cleanupWorkspaceFixture=()=>root.unmount();
root.render(<StrictMode><Fixture/></StrictMode>);
