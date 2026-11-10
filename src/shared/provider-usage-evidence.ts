/** Raw provider-reported values. Null means the field was absent, not zero. */
export interface ProviderUsageEvidence {
  source: 'provider-http'; observed: boolean;
  inputTokens: number|null; totalInputTokens: number|null; outputTokens: number|null;
  cacheReadTokens: number|null; cacheWriteTokens: number|null;
}
export interface ProviderUsagePresence { input:boolean; totalInput:boolean; output:boolean; cacheRead:boolean; cacheWrite:boolean }
export function usagePresence(value:ProviderUsageEvidence):ProviderUsagePresence {
  return {input:value.inputTokens!==null,totalInput:value.totalInputTokens!==null,output:value.outputTokens!==null,
    cacheRead:value.cacheReadTokens!==null,cacheWrite:value.cacheWriteTokens!==null};
}
export function emptyUsageEvidence():ProviderUsageEvidence {
  return {source:'provider-http',observed:false,inputTokens:null,totalInputTokens:null,outputTokens:null,cacheReadTokens:null,cacheWriteTokens:null};
}
