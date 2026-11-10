import { subagentHeaderMetrics, type HeaderUsage } from '@/lib/subagentHeaderMetrics';
import './SubagentChatHeader.css';

/** Shared metric grid for native subagents and Work executions; never reads global state. */
export function ExecutionUsageMetrics({usage,elapsed,elapsedTitle,scope='本子代理累计',finishedAt}:{
  usage?:HeaderUsage;elapsed?:string;elapsedTitle:string;scope?:string;finishedAt?:number;
}) {
  return <dl className="subagent-detail-metrics" aria-label={`${scope}用量与耗时`}>
    {subagentHeaderMetrics(usage,scope).map(metric=><div key={metric.key} data-metric={metric.key} title={metric.title}><dt>{metric.label}</dt><dd>{metric.value}</dd></div>)}
    <div data-metric="elapsed" title={elapsedTitle}><dt>耗时</dt><dd>{elapsed??'—'}</dd></div>
    {finishedAt!==undefined && <div data-metric="finished" title={new Date(finishedAt).toLocaleString()}><dt>结束时间</dt><dd>{new Date(finishedAt).toLocaleTimeString()}</dd></div>}
  </dl>;
}
