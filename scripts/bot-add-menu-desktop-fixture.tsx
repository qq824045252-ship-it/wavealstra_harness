import "./bot-conversation-concurrent-desktop-fixture";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { updateExternalAgentCatalog } from "../src/renderer/src/lib/externalAgentCatalog";
import { collectBotConversationFiles } from "../src/renderer/src/lib/botConversationFiles";
const state = useAppStore.getState();
const history = structuredClone(state.botHistories.bot);
history.messages.push({messageId:"attachment-message",botId:"bot",conversationId:"chat",requestId:"attachment",ordinal:1,role:"user",text:"已提供资料",attachments:[{name:"conversation.txt",path:"/fixture/conversation.txt"}],status:"completed",workIds:[],createdAt:1,updatedAt:1});
useAppStore.setState({botHistories:{bot:history}, refreshBotHistory:async()=>{}, tasks:[{id:"source",title:"源任务",updatedAt:1,messages:[{role:"user",blocks:[{type:"text",text:"引用上下文验证"}]}],fileChanges:[]}, {id:"ordinary",title:"不应泄漏的普通对话",messages:[{role:"user",attachments:[{name:"unrelated.txt",path:"/other/unrelated.txt"}]}],fileChanges:[]}] as never,activeTaskId:"ordinary",spaces:[],models:[{id:"model-a",name:"Model A"}] as never});
let configured = true;
Object.assign(window.api!.agent, {getBuiltinCapabilities:async()=>({config:{multiModelConsult:{enabled:configured,participants:[{modelId:"fixture/a"},{modelId:"fixture/b"}]}}})});
Object.assign(window.api!, {pickLocalFile:async()=>({name:"picked.txt",path:"/fixture/picked.txt"})});
updateExternalAgentCatalog([{id:"fixture-acp",name:"Fixture ACP",description:"Test external agent",enabled:true,available:true}] as never);
Object.assign(window, {addMenuFixture:{store:useAppStore,configure:(value:boolean)=>{configured=value;},files:collectBotConversationFiles,
  switchTeam:()=>{useAppStore.setState({activeTeam:{templateId:"team-a",ownerBotId:"bot",name:"团队",members:[]} as never,botHistories:{...useAppStore.getState().botHistories,"team:team-a":{...history,teamId:"team-a",conversationId:"team-chat",messages:[]}},botDraft:""});},
}});
