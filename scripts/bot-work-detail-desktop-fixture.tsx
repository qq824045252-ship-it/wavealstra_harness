import { createRoot } from 'react-dom/client';
import { BotWorkBrowser } from '../src/renderer/src/components/pages/BotWorkBrowser';
import { BotWorkDetails } from '../src/renderer/src/components/pages/BotWorkDetails';
import type { WorkProjectionDto } from '../src/shared/bot-work';
import '../src/renderer/src/components/pages/BotWorkspacePage.css';
const summary = JSON.stringify({format:'bot-team-report-v1', conclusions:[{text:'完成两份对照报告'}]});
const work: WorkProjectionDto = {workId:'detail-fixture',goalDescription:'完整目标第一行\n第二行包含界面尾部目标标记，以及'+ 'LongUnbrokenGoal'.repeat(30),title:'团队整理产品资料并核对缺口', mode:'once',lifecycle:'closed',closureConclusion:'succeeded',closureSummary:summary,
ownerBotId:'owner',ownerEpoch:1,intentRevision:1,sourceVersion:1,stateVersion:1,inputSnapshotId:'input',inputSnapshotBound:true,goalSources:[],criteria:[],acceptedDeliverableIds:[],blockers:[],executions:[],notifications:[],subscriptionIds:[],uncoveredScope:[],nextSteps:[],updatedAt:1,
deliverables:[{deliverableId:'result',workId:'detail-fixture',producerBotId:'owner',executionId:'binding',intentRevision:1,ownerEpoch:1,inputSnapshotId:'input',status:'accepted',summary,artifactRefs:[],evidenceRefs:[],uncoveredScope:['第三方资料无法访问'],uncoveredCriterionIds:[],isSpeculation:false,hasWriteConflicts:false,createdAt:1,presentation:{structured:{version:1,conclusions:[{text:'## 核对结果\n\n完成两份对照报告。第三方资料未能核实，缺口已保留。',requestMessageId:'request',requestText:'核对产品资料',sources:[{ref:'binding','label':'资料员 · 整理产品资料'}]}],observations:['下次可补充原始资料']},teamFacts:[{displayName:'核对员',responsibility:'第三方资料核验',executionStatus:'failed',failureReason:'服务器拒绝连接',sourceRefs:['binding']}]}}]};
const collaborationBody = '## 核对结论\n\n**实际完成**，不是纯文本。\n\n| 检查 | 结果 |\n| --- | --- |\n| 字节数 | 31 |\n\n```js\nconsole.log("checked")\n```\n\n<script>window.collabInjected = true</script>\n\n[恶意链接](javascript:alert(1))';
const collaboration = {messageId:'collab-1',workId:work.workId,kind:'result' as const,senderBotId:'owner',senderKind:'bot' as const,userId:'user',recipientBotIds:['owner'],body:collaborationBody,artifactRefs:[],executionRefs:[],intentRevision:1,inputSnapshotId:'input',ownerEpoch:1,createdAt:1700000000000,versionGuard:{expectedStateVersion:1,expectedIntentRevision:1,expectedOwnerEpoch:1}};
work.phase3 = {subitems:[],continuations:[],gaps:[],settlingActions:0,pausedEventCount:0,handoffs:[],collaborationMessages:[collaboration,{...collaboration,messageId:'collab-2',createdAt:1700000001000},{...collaboration,messageId:'collab-3',body:'独有的后续发现不可丢失。'}]};
work.cards = [{cardKey:'card-history',semanticCardKey:'history',workId:work.workId,userId:'user',kind:'owner_summary',intentRevision:1,inputSnapshotId:'input',originOwnerEpoch:1,canonicalOutcomeHash:'hash',title:'历史汇总',summary:collaborationBody,deliverableIds:[],evidenceIds:[],sourceRefs:[],artifactRefs:[],unverifiedScope:['**旧缺口**','**旧缺口**'],createdAt:1700000000000,currency:'superseded',readVersion:0,notificationIds:[]}];
let originalCalls = 0;
Object.assign(window, { api: { botWork: { getWork: async (workId: string) => {
  originalCalls++;
  return {...work, workId, originalDelegation: {descriptionOrigin:'assistant',messages:[{messageId:'original-user',text:'真实原委托，不能冒称助理目标。\n原文尾部标记',intentRevision:1,sourceVersion:1}],context:[{messageId:'clarification',role:'assistant',text:'上下文建议，不是用户授权'}]}};
}}}, originalCalls: () => originalCalls });
const root=createRoot(document.getElementById('root')!);
const render=(patch: Partial<WorkProjectionDto>={})=>root.render(<BotWorkDetails work={{...work,...patch}} ownerName="负责人" includeClosed />);
const renderGoalBrowser = () => root.render(<BotWorkBrowser works={Array.from({length:61},(_,i)=>({...work,workId:`goal-${i}`,title:`唯一标题 ${i}`,goalDescription:i===60?'完整目标独有尾部 FULLWIDTH ＡＢＣ':'其他目标',lifecycle:'active',closureConclusion:undefined,closureSummary:undefined,deliverables:[]}))} view="active" loading={false} onOpenWork={()=>{}} onConversation={()=>{}} />);
Object.assign(window,{renderDetailFixture:render,renderGoalBrowser}); render();
