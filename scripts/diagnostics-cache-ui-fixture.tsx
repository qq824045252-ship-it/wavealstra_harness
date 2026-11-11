import { createRoot } from 'react-dom/client';
import { TaskDiagnosticsView } from '../src/renderer/src/components/chat/TaskDiagnosticsPanel';
import type { ModelRequestDiagnostic, TaskDiagnosticsDto } from '../src/shared/task-diagnostics';
import '../src/renderer/src/styles/global.css';
const request = (id:string, index:number, read:number, sourceKind:'main'|'subagent'='main'):ModelRequestDiagnostic => ({
  id, taskId:'fixture', executionId:id, executionScope:'task', conversationId:sourceKind==='main'?'main':'child', generationTaskId:index,
  sourceKind, provider:'fixture',model:'fixture', startedAt:100000+index*10000, firstResponseAt:100500+index*10000, finishedAt:101000+index*10000,modelMs:1000,
  status:'completed',outcome:'stop',error:null,usage:{input:10000-read,output:500,cacheRead:read,cacheWrite:0},usageSource:'provider',knownCostUsd:0.01,costComplete:true,costSource:'provider-reported',
  attempts:[],cacheContext:{previousRequestId:null,prefixStable:true,changedFields:[],coverage:'complete'},
});
const value:TaskDiagnosticsDto={taskId:'fixture',capturedAt:200000,offset:0,truncated:false,requests:[request('cold',0,0),request('warm',1,9000),request('drop',2,0),request('child',3,0,'subagent')],tools:[],waits:[],totals:{modelMs:4000,toolMs:0,waitingMs:0,knownCostUsd:0.04,costComplete:true,unknownUsageRequests:0}};
createRoot(document.getElementById('root')!).render(<TaskDiagnosticsView value={value}/>);
