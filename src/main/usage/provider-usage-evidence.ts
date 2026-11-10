import {emptyUsageEvidence,type ProviderUsageEvidence} from '../../shared/provider-usage-evidence';
const number=(value:unknown):number|null=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
/** Only usage counters are retained; never content, headers or credentials. */
export function observeRawUsage(state:ProviderUsageEvidence,event:unknown,api:string):void {
  if(!event || typeof event!=='object')return;
  const item=event as Record<string,any>;
  const raw=item.usage??item.response?.usage??item.message?.usage??item.choices?.find((choice:any)=>choice.usage)?.usage;
  if(!raw || typeof raw!=='object')return;
  state.observed=true;
  const update=(key:keyof Pick<ProviderUsageEvidence,'inputTokens'|'outputTokens'|'cacheReadTokens'|'cacheWriteTokens'|'totalInputTokens'>,value:unknown)=>{const n=number(value);if(n!==null)state[key]=n;};
  if(api==='openai-completions'){
    update('totalInputTokens',raw.prompt_tokens);update('outputTokens',raw.completion_tokens);
    update('cacheReadTokens',raw.prompt_tokens_details?.cached_tokens??raw.prompt_cache_hit_tokens??raw.cached_tokens);
    update('cacheWriteTokens',raw.prompt_tokens_details?.cache_write_tokens);
  }else if(api==='openai-responses'){
    update('totalInputTokens',raw.input_tokens);update('outputTokens',raw.output_tokens);
    update('cacheReadTokens',raw.input_tokens_details?.cached_tokens);update('cacheWriteTokens',raw.input_tokens_details?.cache_write_tokens);
  }else if(api==='anthropic-messages'){
    update('inputTokens',raw.input_tokens);update('outputTokens',raw.output_tokens);
    update('cacheReadTokens',raw.cache_read_input_tokens);update('cacheWriteTokens',raw.cache_creation_input_tokens);
    if(state.inputTokens!==null&&state.cacheReadTokens!==null&&state.cacheWriteTokens!==null)
      state.totalInputTokens=state.inputTokens+state.cacheReadTokens+state.cacheWriteTokens;
    return;
  }
  if(state.totalInputTokens!==null&&state.cacheReadTokens!==null&&state.cacheWriteTokens!==null)
    state.inputTokens=Math.max(0,state.totalInputTokens-state.cacheReadTokens-state.cacheWriteTokens);
}
export const supportsUsageObservation=(api:string)=>['openai-completions','openai-responses','anthropic-messages'].includes(api);
/** Identity transform: preserves bytes, cancellation and backpressure. Bounded parsing only. */
export function withUsageEvidence(fetcher:typeof fetch,state:ProviderUsageEvidence,api:string):typeof fetch {
  return async (request,init)=>{
    const response=await fetcher(request,init);
    if(!response.ok||!response.body)return response;
    Object.assign(state,emptyUsageEvidence());
    const decoder=new TextDecoder();let pending='';let oversized=false;
    const json=response.headers.get('content-type')?.includes('application/json');
    const consume=(text:string)=>{try{observeRawUsage(state,JSON.parse(text),api);}catch{ /* telemetry must not fail inference */ }};
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({
      transform(chunk,controller){controller.enqueue(chunk);if(oversized)return;pending+=decoder.decode(chunk,{stream:true});
        if(pending.length>1024*1024){pending='';oversized=true;return;}
        if(!json){let newline;while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline).trim();pending=pending.slice(newline+1);if(line.startsWith('data:'))consume(line.slice(5).trim());}}
      },flush(){if(oversized)return;pending+=decoder.decode();if(json)consume(pending);else if(pending.trim().startsWith('data:'))consume(pending.trim().slice(5).trim());}
    })),{status:response.status,statusText:response.statusText,headers:response.headers});
  };
}
