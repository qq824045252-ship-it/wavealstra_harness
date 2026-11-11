import "../src/renderer/src/styles/global.css";
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
const linkQuestion: BotMessageDto = { messageId:"link-user", conversationId:"c", botId:"owner", requestId:"link-request", ordinal:1, role:"user", text:"继续做", status:"completed", workIds:["work"], createdAt:1, updatedAt:1 };
const linkAnswer: BotMessageDto = { ...linkQuestion, messageId:"link-answer", ordinal:2, role:"assistant", text:"已开始做，正文保留。", status:"completed" };
function linkCase(kind: string) {
  let rows: BotMessageDto[] = [structuredClone(linkQuestion), structuredClone(linkAnswer)];
  if (["queued", "running", "unknown", "failed", "cancelled"].includes(kind)) rows[1].status = kind as BotMessageDto["status"];
  if (kind === "extra") rows[1].workIds = ["work", "other", "other"];
  if (kind === "distinct") rows[1].workIds = ["other"];
  if (kind === "partial") rows = [rows[1]];
  if (kind === "different-request") rows[1].requestId = "another-request";
  if (kind === "feedback") rows[1].workFeedback = { workId:"work", eventId:"fresh-result", kind:"closure", category:"decision" };
  if (kind === "next-turn") rows.push({ ...linkQuestion, messageId:"next-user", requestId:"next", ordinal:3 }, { ...linkAnswer, messageId:"next-answer", requestId:"next", ordinal:4, text:"下一轮的独立回答。" });
  const team = kind === "team" ? {templateId:"team",name:"产品团队",ownerBotId:"owner",members:[]} : null;
  if (team) rows = rows.map(message => ({...message,teamId:team.templateId}));
  useAppStore.setState({activeBotId:"owner",activeTeam:team as never,selectedWorkId:null,
    botWorks:[work,{...work,workId:"other"}],botHistories:{[team ? "team:team" : "owner"]:{botId:"owner",teamId:team?.templateId,conversationId:"c",revision:2,archived:false,messages:rows}}});
  return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function listCase(scope: "personal" | "team", state: "active" | "completed" | "closed") {
  const team = scope === "team" ? {templateId:"list-team",name:"验收团队",ownerBotId:"owner",members:[]} : null;
  const rows: WorkProjectionDto[] = Array.from({length:60}, (_, i) => ({
    ...work, workId:`list-${scope}-${state}-${i}`, title:`${i < 55 ? "保留" : "其他"}事项 ${String(i).padStart(2,"0")}`,
    updatedAt:1000+i, lifecycle:state === "active" ? "active" : "closed",
    closureConclusion:state === "active" ? undefined : "succeeded",
    archive:state === "closed" ? {archivedAt:2000} as WorkProjectionDto["archive"] : undefined,
    team:team ? {...teamWork.team!,workId:`list-${scope}-${state}-${i}`,teamId:team.templateId} : undefined,
  }));
  useAppStore.setState({activeBotId:"owner",activeTeam:team as never,selectedWorkId:null,botWorks:rows,
    botWorkCursor:{scope:"all",epoch:"fixture",sequence:1},
    botHistories:{[team ? "team:list-team" : "owner"]:{botId:"owner",teamId:team?.templateId,conversationId:"list-c",revision:1,archived:false,messages:[]}}});
}
const events:string[]=[];
Object.assign(window,{api:{botWork:{listBotExpertVersions:async()=>[],getSettings:async()=>({settings:{botId:"owner",revision:0,workspacePath:"",effectiveWorkspacePath:"/fixture",spaceId:"fixture",modelId:"",expertId:"",skillIds:[],mcpIds:[],connectorIds:[]},models:[],experts:[],skills:[],mcps:[],connectors:[]})},openFolder:async(path:string)=>events.push(path)},detailEvents:events,
  detailFixture:{listCase, refreshListHistory:()=>useAppStore.setState({botHistories:{owner:{botId:"owner",conversationId:"list-refreshed",revision:2,archived:false,messages:[]}}}), selectListWork:()=>useAppStore.setState({selectedWorkId:useAppStore.getState().botWorks[0]?.workId}), updateSelected:()=>useAppStore.setState(s=>({botWorks:s.botWorks.map(w=>w.workId === s.selectedWorkId ? {...w,lifecycle:"closed",closureConclusion:"succeeded",archive:{archivedAt:3000} as WorkProjectionDto["archive"]} : w)})), linkCase, original:()=>useAppStore.setState({activeBotId:"owner",activeTeam:null,botWorks:[work],selectedWorkId:null,botHistories:{owner:{botId:"owner",conversationId:"c",revision:1,archived:false,messages}}}),team:()=>useAppStore.setState({activeTeam:null,activeBotId:"owner",selectedWorkId:null,botWorks:[work,teamWork],botHistories:{owner:{botId:"owner",conversationId:"c",revision:1,archived:false,messages:teamMessages}}}),
    otherBot:()=>useAppStore.setState({activeBotId:"unrelated",selectedWorkId:null,botHistories:{unrelated:{botId:"unrelated",conversationId:"other",revision:1,archived:false,messages:teamMessages.map(m=>({...m,botId:"unrelated",conversationId:"other"}))}}}),
    otherConversation:()=>useAppStore.setState({selectedWorkId:null,botHistories:{owner:{botId:"owner",conversationId:"new",revision:1,archived:false,messages}}}),
    selectLinked:()=>useAppStore.setState({selectedWorkId:"linked-team"}),
    blocked:()=>useAppStore.setState({botWorks:[{...work,blockers:[{blockerId:"ask",kind:"operational",status:"open",reason:"补充原始文件",waitingForUserInput:true} as never]}]}),selectWork:()=>useAppStore.setState({selectedWorkId:"work"}),switchTeam:()=>useAppStore.setState({activeTeam:{templateId:"other",name:"另一团队",ownerBotId:"owner",members:[]} as never}),
    resolve:()=>{useAppStore.setState({botWorks:[work,{...work,workId:"history"}],botWorkCursor:{scope:"all",epoch:"fixture",sequence:1}});},
    reset:()=>useAppStore.setState({activeTeam:null,botWorks:[work],selectedWorkId:null}),
    remove:()=>useAppStore.setState({botWorks:[]}),
    update:()=>useAppStore.setState({botWorks:[{...work,lifecycle:"closed",closureConclusion:"succeeded",nextSteps:[]}]})}});
useAppStore.setState({activeBotId:"owner",activeTeam:null,botIdentities:bots.map(bot=>({...bot,status:"active",authorization:{allowedScopes:[]}} as never)),botWorks:[work],botHistories:{owner:{botId:"owner",conversationId:"c",revision:1,archived:false,messages}},
 botHostStatus:{online:true} as never,refreshModelConfiguration:async()=>{},refreshBotHistory:async()=>{},refreshBotWork:async()=>{}});
createRoot(document.getElementById('root')!).render(<BotWorkspacePage/>);
