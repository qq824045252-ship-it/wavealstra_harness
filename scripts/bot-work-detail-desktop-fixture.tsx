import { queryWorkFixture } from "./work-query-fixture";
import type { WorkQueryRequest } from "../src/shared/bot-work-query";
import { createRoot } from 'react-dom/client';
import { BotWorkBrowser } from '../src/renderer/src/components/pages/BotWorkBrowser';
import { BotWorkDetails } from '../src/renderer/src/components/pages/BotWorkDetails';
import type { WorkProjectionDto } from '../src/shared/bot-work';
import '../src/renderer/src/components/pages/BotWorkspacePage.css';
const summary = JSON.stringify({format:'bot-team-report-v1', conclusions:[{text:'完成两份对照报告'}]});
const work: WorkProjectionDto = {workId:'detail-fixture',goalDescription:'完整目标第一行\n第二行包含界面尾部目标标记，以及'+ 'LongUnbrokenGoal'.repeat(30),title:'团队整理产品资料并核对缺口', mode:'once',lifecycle:'closed',closureConclusion:'ended_unsuccessfully',closureSummary:summary,
ownerBotId:'owner',ownerEpoch:1,intentRevision:1,sourceVersion:1,stateVersion:1,inputSnapshotId:'input',inputSnapshotBound:true,goalSources:[],criteria:[],acceptedDeliverableIds:[],blockers:[],executions:[],notifications:[],subscriptionIds:[],uncoveredScope:[],nextSteps:[],updatedAt:1,
deliverables:[{deliverableId:'result',workId:'detail-fixture',producerBotId:'owner',executionId:'binding',intentRevision:1,ownerEpoch:1,inputSnapshotId:'input',status:'accepted',summary,artifactRefs:[],evidenceRefs:[],uncoveredScope:['第三方资料无法访问'],uncoveredCriterionIds:[],isSpeculation:false,hasWriteConflicts:false,createdAt:1,presentation:{structured:{version:1,conclusions:[{text:'## 核对结果\n\n完成两份对照报告。第三方资料未能核实，缺口已保留。',requestMessageId:'request',requestText:'核对产品资料',sources:[{ref:'binding','label':'资料员 · 整理产品资料'}]}],observations:['下次可补充原始资料']},teamFacts:[{displayName:'核对员',responsibility:'第三方资料核验',executionStatus:'failed',failureReason:'服务器拒绝连接',sourceRefs:['binding']}]}}]};
const publication = (summary: string, outcome: "completed" | "partial" | "unknown" = "partial"): NonNullable<WorkProjectionDto["publishedReport"]> => ({
  messageId: "review", createdAt: 1700000000000, executionId: "binding", intentRevision: 1, inputSnapshotId: "input",
  report: {title: work.title, summary, artifactRefs: [], reviewStatus: "proposed", current: true, notices: [],
    completion: {outcome, nextStep: "deliver"}}
});
work.publishedReport = publication("## 核对结果\n\n完成两份对照报告。第三方资料未能核实，缺口已保留。");
const collaborationBody = '## 核对结论\n\n**实际完成**，不是纯文本。\n\n| 检查 | 结果 |\n| --- | --- |\n| 字节数 | 31 |\n\n```js\nconsole.log("checked")\n```\n\n<script>window.collabInjected = true</script>\n\n[恶意链接](javascript:alert(1))';
const collaboration = {messageId:'collab-1',workId:work.workId,kind:'result' as const,senderBotId:'owner',senderKind:'bot' as const,userId:'user',recipientBotIds:['owner'],body:collaborationBody,artifactRefs:[],executionRefs:[],intentRevision:1,inputSnapshotId:'input',ownerEpoch:1,createdAt:1700000000000,versionGuard:{expectedStateVersion:1,expectedIntentRevision:1,expectedOwnerEpoch:1}};
work.phase3 = {subitems:[],continuations:[],gaps:[],settlingActions:0,pausedEventCount:0,handoffs:[],collaborationMessages:[collaboration,{...collaboration,messageId:'collab-2',createdAt:1700000001000},{...collaboration,messageId:'collab-3',body:'独有的后续发现不可丢失。'}]};
work.cards = [{cardKey:'card-history',semanticCardKey:'history',workId:work.workId,userId:'user',kind:'owner_summary',intentRevision:1,inputSnapshotId:'input',originOwnerEpoch:1,canonicalOutcomeHash:'hash',title:'历史汇总',summary:collaborationBody,deliverableIds:[],evidenceIds:[],sourceRefs:[],artifactRefs:[],unverifiedScope:['**旧缺口**','**旧缺口**'],createdAt:1700000000000,currency:'superseded',readVersion:0,notificationIds:[]}];
let originalCalls = 0;
Object.assign(window, { api: { botWork: { queryWorks: async (request: WorkQueryRequest) => queryWorkFixture(goalRows, request), getWork: async (workId: string) => {
  originalCalls++;
  return {...work, workId, originalDelegation: {descriptionOrigin:'assistant',messages:[{messageId:'original-user',text:'真实原委托，不能冒称助理目标。\n原文尾部标记',intentRevision:1,sourceVersion:1}],context:[{messageId:'clarification',role:'assistant',text:'上下文建议，不是用户授权'}]}};
}}}, originalCalls: () => originalCalls });
const root=createRoot(document.getElementById('root')!);
const render=(patch: Partial<WorkProjectionDto>={})=>root.render(<div className="bot-workspace"><BotWorkDetails work={{...work,...patch}} ownerName="负责人" includeClosed onReplyToBlocker={blocker => Object.assign(window, {replyTarget: blocker.blockerId})} /></div>);
const renderCase = (kind: string) => {
  const result = work.deliverables[0];
  if (kind === "long") {
    const text = "## 最终结论\n\n两份报告已完成。\n\n" + Array.from({length: 18}, (_, i) => `第 ${i + 1} 项核对保留了独立证据。`).join("\n\n") + "\n\n最后一条结论必须完整可读。";
    render({ closureConclusion: "succeeded", publishedReport: publication(text, "completed"), closureSummary: text, deliverables: [{...result, summary: text, presentation: undefined, uncoveredScope: []}] });
  } else if (kind === "versions") {
    render({ publishedReport: publication("负责人核对后的当前结论"), lifecycle: "active", closureSummary: undefined, deliverables: [
      {...result, summary: "当前负责人结论", presentation: undefined},
      {...result, deliverableId: "member", producerBotId: "member", createdAt: 20, summary: "成员的不同结论不能丢失", presentation: undefined},
      {...result, deliverableId: "old", inputSnapshotId: "old-input", createdAt: 30, summary: "旧输入成果不得冒充当前结论", presentation: undefined},
      {...result, deliverableId: "rejected", createdAt: 40, status: "rejected", summary: "未通过核验的原文", rejectedReason: "缺少依据", presentation: undefined},
      {...result, deliverableId: "superseded", createdAt: 50, status: "superseded", summary: "已替代版本原文", presentation: undefined},
    ] });
  } else if (kind === "closure") {
    render({ publishedReport: publication("最终只完成了部分内容，仍缺现场数据。"), closureConclusion: "ended_unsuccessfully", closureSummary: "最终只完成了部分内容，仍缺现场数据。" });
  } else if (kind === "blocked") {
    render({ publishedReport: publication("请补充原始文件"), lifecycle: "active", closureSummary: undefined, deliverables: [], blockers: [{workId: work.workId, blockerId: "question", kind: "operational", reason: "请补充原始文件", waitingForUserInput: true, status: "open", createdAt: 1}] });
  } else if (kind === "asked") {
    const review = publication("两份报告已保存。请补充原始文件");
    review.report.completion = {outcome: "partial", nextStep: "ask"};
    render({publishedReport: review, lifecycle: "active", closureSummary: undefined, blockers: [{workId: work.workId,
      blockerId: "specific-question", kind: "operational", reason: "请补充原始文件", waitingForUserInput: true, status: "open", createdAt: 1}]});
  } else if (kind === "answered") {
    const review = publication("旧的问题已回答，不应继续催问");
    review.report.completion = {outcome: "partial", nextStep: "ask"};
    render({publishedReport: review, lifecycle: "active", closureSummary: undefined, blockers: []});
  } else if (kind === "continuing") {
    const review = publication("已取得资料，接下来由 Bot 补齐校验。");
    review.report.completion = {outcome: "partial", nextStep: "continue"};
    render({publishedReport: review, lifecycle: "active", closureSummary: undefined});
  } else if (kind === "running") {
    render({ publishedReport: undefined, lifecycle: "active", closureSummary: undefined, deliverables: [], runtimeObservations: [{bindingId: "running", state: "running", reason: "正在整理资料"}] });
  } else if (kind === "no-review") {
    render({publishedReport: undefined, lifecycle: "active", closureSummary: undefined, nextSteps: ["待验收：内部检查", "安排后台执行"]});
  } else if (kind === "stale-review") {
    render({publishedReport: {...publication("旧输入的正式结论"), inputSnapshotId: "old-input"}, lifecycle: "active", closureSummary: undefined});
  } else if (kind === "internal") {
    render({publishedReport: undefined, lifecycle: "active", closureSummary: undefined, blockers: [{workId: work.workId,
      blockerId: "continuation:failure", kind: "operational", reason: "自动恢复尚未完成", waitingForUserInput: true, status: "open", createdAt: 1}]});
  } else if (kind === "paused") {
    render({publishedReport: undefined, lifecycle: "paused", closureSummary: undefined});
  } else if (kind === "watch") {
    render({mode: "watch", lifecycle: "active", closureSummary: undefined, phase4: {subscriptions: [], offlineGaps: [],
      causal: [], deadlineRevision: 1, host: {online: false}}});
  } else render();
};
const goalRows: WorkProjectionDto[] = Array.from({length:61},(_,i)=>({...work,workId:`goal-${i}`,title:`唯一标题 ${i}`,goalDescription:i===60?'完整目标独有尾部 FULLWIDTH ＡＢＣ':'其他目标',lifecycle:'active',closureConclusion:undefined,closureSummary:undefined,deliverables:[]}));
const renderGoalBrowser = () => root.render(<BotWorkBrowser scope={{kind:"all"}} view="active" onOpenWork={()=>{}} onConversation={()=>{}} />);
Object.assign(window,{renderDetailFixture:render,renderDetailCase:renderCase,renderGoalBrowser}); render();
