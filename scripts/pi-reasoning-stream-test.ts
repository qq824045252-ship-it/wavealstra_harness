/** Native Pi Responses parser regression. Synthetic SSE uses the exact event shape
 * observed from CommandCode, without credentials or private reasoning fixtures.
 * A final snapshot alone is NOT a pass: deltas must arrive before output_item.done.
 */
import assert from 'node:assert/strict';
import { stream } from '@earendil-works/pi-ai/api/openai-responses';
import { normalizeContext, type Model } from '@earendil-works/pi-ai';
import { mapPiEventToPatches, type MapperContext } from '../src/shared/pi-event-mapper';
const model: Model<'openai-responses'> = {id:'fixture',name:'Fixture',provider:'commandcode',api:'openai-responses',baseUrl:'https://fixture.invalid/v1',reasoning:true,input:['text'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
let passed=0,failed=0;
async function check(name:string,reasoningType:string,withReasoning=true):Promise<void>{
 const thinking='先核对事件类型，再验证实时输出。';const chunks=['先核对事件类型，','再验证实时输出。'];const body='# 验证结果\n\n| 项目 | 状态 |\n|---|---|\n| 流式 | 正常 |\n';
 const ri={type:'reasoning',id:'rs_fixture',summary:[],content:[{type:'reasoning_text',text:thinking}]};
 const ti={type:'message',id:'msg_fixture',role:'assistant',status:'completed',content:[{type:'output_text',text:body,annotations:[]}]};
 const events:any[]=[{type:'response.created',response:{id:'resp_fixture'}}];
 if(withReasoning){events.push({type:'response.output_item.added',output_index:0,item:{type:'reasoning',id:ri.id,summary:[]}},...chunks.map(delta=>({type:reasoningType,output_index:0,content_index:0,item_id:ri.id,delta})),{type:'response.output_item.done',output_index:0,item:ri});}
 events.push({type:'response.output_item.added',output_index:1,item:{...ti,status:'in_progress',content:[]}},...['# 验证结果\n\n','| 项目 | 状态 |\n|---|---|\n','| 流式 | 正常 |\n'].map(delta=>({type:'response.output_text.delta',output_index:1,content_index:0,item_id:ti.id,delta})),{type:'response.output_item.done',output_index:1,item:ti},{type:'response.completed',response:{id:'resp_fixture',status:'completed',output:withReasoning?[ri,ti]:[ti],usage:{input_tokens:10,output_tokens:20,total_tokens:30}}});
 let reasoningDone=false;let earlyThinking=0;let earlyText=0;let textDone=false;
 const fetchFixture:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({async start(controller){const encoder=new TextEncoder();for(const event of events){if(event.type==='response.output_item.done'){if(event.output_index===0)reasoningDone=true;else textDone=true;}controller.enqueue(encoder.encode('data: '+JSON.stringify(event)+'\n\n'));await new Promise(r=>setTimeout(r,15));}controller.close();}}),{headers:{'content-type':'text/event-stream'}});
 const native=stream(model,normalizeContext({messages:[{role:'user',content:'test',timestamp:1}]}),{apiKey:'fixture-key',fetch:fetchFixture});
 const ctx:MapperContext={taskId:'fixture',messageId:'reply',startedAt:1};let uiThinking='',uiText='';const nativeThinking:string[]=[];
 for await(const event of native){if(event.type==='thinking_delta'){nativeThinking.push(event.delta);if(!reasoningDone)earlyThinking++;}if(event.type==='text_delta'&&!textDone)earlyText++;
  if('partial' in event){const mapped=event.type==='start'?{type:'message_start',message:event.partial}:{type:'message_update',message:event.partial,assistantMessageEvent:event};for(const p of mapPiEventToPatches(mapped as Parameters<typeof mapPiEventToPatches>[0],ctx)){if(p.type==='thinking_delta')uiThinking+=p.delta;if(p.type==='text_delta')uiText+=p.delta;}}
 }
 const result=await native.result();for(const p of mapPiEventToPatches({type:'message_end',message:result},ctx))if(p.type==='thinking_delta')uiThinking+=p.delta;
 assert.equal(result.stopReason,'stop',result.errorMessage);assert.equal(uiText,body,'Markdown must not be dropped or duplicated');assert.equal(uiThinking,withReasoning?thinking:'','thinking must agree with final snapshot');assert.equal(earlyText,3,'all text chunks must stream before completion');
 if(withReasoning){assert.equal(earlyThinking,2,'reasoning deltas were swallowed until the final snapshot');assert.equal(nativeThinking.join(''),thinking,'native delta text must be exact');}
 console.log('PASS '+name);
}
for(const [name,type,thinking] of [['CommandCode response.reasoning.delta','response.reasoning.delta',true],['standard response.reasoning_text.delta','response.reasoning_text.delta',true],['text-only response','response.reasoning.delta',false]] as const){try{await check(name,type,thinking);passed++;}catch(error){failed++;console.error('FAIL '+name+': '+String(error));}}
console.log(JSON.stringify({passed,failed}));if(failed)process.exitCode=1;
