import { createRoot } from "react-dom/client";
import BotWorkspacePage from "../src/renderer/src/components/pages/BotWorkspacePage";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { works, bots } from "./bot-activity-fixtures";
import type { BotMessageDto } from "../src/shared/bot-conversation";
import type { WorkProjectionDto } from "../src/shared/bot-work";
const work: WorkProjectionDto = {...works[0], title:"核对团队报告与保存成果", executions:[],generatedArtifacts:[{bindingId:"binding",path:"/work/report.md",snapshotPath:"/saved/report-v1.md",digest:"abc",sizeBytes:28} as NonNullable<WorkProjectionDto['generatedArtifacts']>[number]]};
const messages: BotMessageDto[] = Array.from({length:16},(_,i)=>({messageId:`m${i}`,conversationId:"c",botId:"owner",requestId:`q${i}`,ordinal:i,role:"assistant",text:`第 ${i+1} 个请求的回复\n\n`+"这段文字用于验证返回时保留原消息和滚动位置。".repeat(6),status:"completed",workIds:i===4?["work"]:i===5?["history"]:i===6?["foreign"]:[],createdAt:1,updatedAt:1}));
const teamWork: WorkProjectionDto = {...work,workId:"linked-team",title:"临时学习团队的报告",team:{workId:"linked-team",ownerBotId:"owner",ownerResponsibility:"汇总",members:[{botId:"member",responsibility:"核验",delegatedScope:["workspace:read"]}],state:"completed",executions:[],createdAt:1,intentRevision:1,inputSnapshotId:"input",ownerEpoch:1}};
const teamMessages = messages.map((m,i)=>i===4?{...m,workIds:["linked-team"]}:m);
const events:string[]=[];
Object.assign(window,{api:{botWork:{listBotExpertVersions:async()=>[]},openFolder:async(path:string)=>events.push(path)},detailEvents:events,
  detailFixture:{team:()=>useAppStore.setState({activeTeam:null,activeBotId:"owner",selectedWorkId:null,botWorks:[work,teamWork],botHistories:{owner:{botId:"owner",conversationId:"c",revision:1,archived:false,messages:teamMessages}}}),
    otherBot:()=>useAppStore.setState({activeBotId:"unrelated",selectedWorkId:null,botHistories:{unrelated:{botId:"unrelated",conversationId:"other",revision:1,archived:false,messages:teamMessages.map(m=>({...m,botId:"unrelated",conversationId:"other"}))}}}),
    otherConversation:()=>useAppStore.setState({selectedWorkId:null,botHistories:{owner:{botId:"owner",conversationId:"new",revision:1,archived:false,messages}}}),
    selectLinked:()=>useAppStore.setState({selectedWorkId:"linked-team"}),
    blocked:()=>useAppStore.setState({botWorks:[{...work,blockers:[{blockerId:"ask",kind:"operational",status:"open",reason:"补充原始文件",waitingForUserInput:true} as never]}]}),selectWork:()=>useAppStore.setState({selectedWorkId:"work"}),switchTeam:()=>useAppStore.setState({activeTeam:{templateId:"other",name:"另一团队",ownerBotId:"owner",members:[]} as never}),
    resolve:()=>{useAppStore.setState({botWorks:[work,{...work,workId:"history"}],botWorkCursor:{scope:"all",epoch:"fixture",sequence:1}});},
    reset:()=>useAppStore.setState({activeTeam:null,botWorks:[work],selectedWorkId:null}),
    remove:()=>useAppStore.setState({botWorks:[]}),
    update:()=>useAppStore.setState({botWorks:[{...work,lifecycle:"closed",closureConclusion:"succeeded",nextSteps:[]}]})}});
useAppStore.setState({activeBotId:"owner",activeTeam:null,botIdentities:bots.map(bot=>({...bot,status:"active",authorization:{allowedScopes:[]}} as never)),botWorks:[work],botHistories:{owner:{botId:"owner",conversationId:"c",revision:1,archived:false,messages}},
 botHostStatus:{online:true} as never,refreshBotHistory:async()=>{},refreshBotWork:async()=>{}});
createRoot(document.getElementById('root')!).render(<BotWorkspacePage/>);
