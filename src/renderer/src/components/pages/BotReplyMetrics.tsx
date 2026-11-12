import type { BotMessageDto } from '@shared/bot-conversation';
import { formatTokenCount } from '@shared/token-format';
import { GenerationSpeedDisplay } from '../chat/GenerationSpeed';
import './BotReplyMetrics.css';

export function BotReplyMetrics({message}:{message:BotMessageDto}) {
  if(message.role!=='assistant' || message.workFeedback) return null;
  const metrics=message.metrics;
  const count=(value:number|null|undefined)=>value==null?'—':formatTokenCount(value);
  const exact=(value:number|null|undefined)=>value==null?"未报告":value.toLocaleString()+" tokens";
  const total=metrics?.totalInputTokens??null;
  const rate=total && metrics?.cacheReadTokens!=null ? metrics.cacheReadTokens/total : null;
  const context=metrics?.contextTokens, window=metrics?.contextWindow;
  return <details className="bot-reply-metrics" aria-label="本条回复用量与速度">
    <summary>用量与速度</summary>
    <div className="bot-reply-metrics-grid">
    <span title={`${exact(total)}；本条前台回复所有已报告模型调用的输入，包括缓存读写；不是整个会话累计。`}>输入 {count(total)}</span>
    <span data-metric="cacheRead" title={`${exact(metrics?.cacheReadTokens)}；供应商实际报告的缓存读取，不由缓存率反推；缺失显示 —。`}>缓存读取 {count(metrics?.cacheReadTokens)}</span>
    <span title={`${exact(metrics?.outputTokens)}；供应商已报告输出，缺失显示 —。`}>输出 {count(metrics?.outputTokens)}</span>
    <span title={`缓存读取 ${count(metrics?.cacheReadTokens)} · 缓存写入 ${count(metrics?.cacheWriteTokens)} · 未缓存 ${count(metrics?.inputTokens)}`}>缓存率 {rate==null?'—':`${(rate*100).toFixed(1)}%`}</span>
    {message.status==='running' || (metrics?.generation?.phase==='complete' && metrics.generation.tps!=null) ? <span title="速度来自主机接收到流式快照的观测时钟，受传输与采样延迟影响；不是供应商内部计时。">观测 <GenerationSpeedDisplay stats={metrics?.generation} streaming={message.status==='running'} createdAt={message.createdAt} approval={false}/></span> : <span title="未取得完整生成时序，不以文字长度或总耗时猜测速度">速度 —</span>}
    <span title="本请求最近一次模型上下文占用，不是整个 Bot 历史之和；≈ 表示快照估算，— 表示未取得。">上下文 {context==null?'—':`${metrics?.contextEstimated?'≈':''}${count(context)}`}{window ? ` / ${count(window)}${context!=null?` (${(context/window*100).toFixed(1)}%)`:''}`:''}</span>
    {metrics?.durationMs!=null && <span>耗时 {(metrics.durationMs/1000).toFixed(1)}s</span>}
    </div>
  </details>;
}
