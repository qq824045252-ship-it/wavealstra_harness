import type { WorkProjectionDto } from '@shared/bot-work';
import { ExecutionUsageMetrics } from '../chat/ExecutionUsageMetrics';
import { GenerationSpeedDisplay } from '../chat/GenerationSpeed';
import { formatTokenCount } from '@shared/token-format';
import { useAppStore } from '@/store/appStore';
import './WorkExecutionMetrics.css';

export function WorkExecutionMetrics({work}:{work:WorkProjectionDto}) {
  const identities=useAppStore(state=>state.botIdentities);
  if(!work.executions.length)return null;
  return <section className="bot-detail-section work-execution-metrics" aria-label="执行统计">
    <h3>执行统计</h3>
    <p className="work-execution-metrics-note">每次执行独立统计，含其原生子调用；速度和上下文仅对应本次执行主模型。未取得的数据显示 —。</p>
    {work.executions.map((execution,index)=>{
      const name=identities.find(bot=>bot.botId===execution.botId)?.displayName??'执行成员';
      const metrics=execution.metrics;
      const usage=metrics?{totalInput:metrics.totalInputTokens??undefined,input:metrics.inputTokens??undefined,output:metrics.outputTokens??undefined,cacheRead:metrics.cacheReadTokens??undefined,cacheWrite:metrics.cacheWriteTokens??undefined}:undefined;
      const active=['pending','submitted','running'].includes(execution.status);
      return <details key={execution.bindingId} className="work-execution-metrics-row" open={index===work.executions.length-1}>
        <summary>{name} · 第 {index+1} 次执行 <span>{active?'进行中':execution.status==='completed'?'执行结束':execution.status==='failed'?'执行失败':'已停止'}</span></summary>
        <ExecutionUsageMetrics scope="本次执行" usage={usage} elapsed={metrics?.durationMs==null?undefined:`${(metrics.durationMs/1000).toFixed(1)}s`} elapsedTitle="本次原生执行从受理到最后生成结束的耗时，包含工具等待，不用于计算生成速度" finishedAt={execution.settledAt}/>
        <div className="work-execution-metrics-extra">
          {metrics?.generation && (active || metrics.generation.tps!=null)?<span>主模型观测速度 <GenerationSpeedDisplay stats={metrics.generation} streaming={active&&execution.status==='running'} createdAt={execution.submittedAt??execution.admittedAt} approval={false}/></span>:<span>主模型速度 —</span>}
          <span title="本次执行主模型最近上下文快照，不含原生子调用；≈ 表示估算，不是计费用量">上下文 {metrics?.contextTokens==null?'—':`${metrics.contextEstimated?'≈':''}${formatTokenCount(metrics.contextTokens)}`}{metrics?.contextWindow?` / ${formatTokenCount(metrics.contextWindow)}`:''}</span>
        </div>
        <div className="work-execution-metrics-note">{execution.metrics?`${execution.metrics.reportedCalls} / ${execution.metrics.calls} 次调用已报告用量${active?' · 执行中，持续更新':execution.metrics.complete?'':' · 统计尚不完整'}`:'本次执行未采集到统计，不能视为零消耗。'}</div>
        <div className="work-execution-metrics-identity" title={execution.bindingId}>执行 ID：{execution.bindingId}</div>
      </details>;
    })}
  </section>;
}
