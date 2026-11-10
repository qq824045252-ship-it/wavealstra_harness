import { createRoot } from 'react-dom/client';
import { BotWorkDetails } from '../src/renderer/src/components/pages/BotWorkDetails';
import type { WorkProjectionDto } from '../src/shared/bot-work';
import '../src/renderer/src/components/pages/BotWorkspacePage.css';
const summary = JSON.stringify({format:'bot-team-report-v1', conclusions:[{text:'完成两份对照报告'}]});
const work: WorkProjectionDto = {workId:'detail-fixture',title:'团队整理产品资料并核对缺口', mode:'once',lifecycle:'closed',closureConclusion:'succeeded',closureSummary:summary,
ownerBotId:'owner',ownerEpoch:1,intentRevision:1,sourceVersion:1,stateVersion:1,inputSnapshotId:'input',inputSnapshotBound:true,goalSources:[],criteria:[],acceptedDeliverableIds:[],blockers:[],executions:[],notifications:[],subscriptionIds:[],uncoveredScope:[],nextSteps:[],updatedAt:1,
deliverables:[{deliverableId:'result',workId:'detail-fixture',producerBotId:'owner',executionId:'binding',intentRevision:1,ownerEpoch:1,inputSnapshotId:'input',status:'accepted',summary,artifactRefs:[],evidenceRefs:[],uncoveredScope:['第三方资料无法访问'],uncoveredCriterionIds:[],isSpeculation:false,hasWriteConflicts:false,createdAt:1,presentation:{structured:{version:1,conclusions:[{text:'## 核对结果\n\n完成两份对照报告。第三方资料未能核实，缺口已保留。',requestMessageId:'request',requestText:'核对产品资料',sources:[{ref:'binding','label':'资料员 · 整理产品资料'}]}],observations:['下次可补充原始资料']},teamFacts:[{displayName:'核对员',responsibility:'第三方资料核验',executionStatus:'failed',failureReason:'服务器拒绝连接',sourceRefs:['binding']}]}}]};
const root=createRoot(document.getElementById('root')!);
const render=(patch: Partial<WorkProjectionDto>={})=>root.render(<BotWorkDetails work={{...work,...patch}} ownerName="负责人" includeClosed />);
Object.assign(window,{renderDetailFixture:render}); render();
