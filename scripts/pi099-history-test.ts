import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { loadTaskHistoryFromSession } from '../src/main/agent/session-history';
const root=mkdtempSync(join(tmpdir(),'pi099-history-'));
try {
  const manager=SessionManager.create(root,join(root,'sessions'));
  manager.appendMessage({role:'user',content:'Read, then verify a failure',timestamp:Date.now()} as any);
  manager.appendMessage({role:'assistant',content:[{type:'toolCall',id:'parent',name:'codemode',arguments:{code:'fixture'}}],timestamp:Date.now()} as any);
  manager.appendMessage({role:'toolResult',toolCallId:'parent',toolName:'codemode',isError:false,content:[{type:'text',text:'Handled business error'}],timestamp:Date.now(),nestedCalls:{complete:false,calls:[
    {id:'parent/1',name:'mcp__fixture__read_file',arguments:{path:'safe.txt'},status:'ok',durationMs:3},
    {id:'parent/2',name:'mcp__fixture__report_failure',arguments:{},status:'error',error:'EXPECTED_TEST_FAILURE',durationMs:1},
    {id:'parent/3',name:'mcp__fixture__increment_counter',arguments:{},status:'cancelled',durationMs:2},
  ]}} as any);
  manager.appendMessage({role:'assistant',content:[{type:'text',text:'Done'}],timestamp:Date.now()} as any);
  const file=manager.getSessionFile()!,hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex');const before=hash();
  const history=loadTaskHistoryFromSession(file,root);const tools=history.messages.flatMap(m=>m.tools??[]);
  assert.equal(tools.length,4);assert.equal(tools.find(t=>t.id==='parent/1')?.parentToolCallId,'parent');
  assert.equal(tools.find(t=>t.id==='parent/1')?.status,'success');assert.equal(tools.find(t=>t.id==='parent/2')?.status,'error');
  assert.equal(tools.find(t=>t.id==='parent/2')?.output,'EXPECTED_TEST_FAILURE');assert.equal(tools.find(t=>t.id==='parent/3')?.output,'已取消');
  assert.match(tools.find(t=>t.id==='parent')?.output??'',/记录不完整/);assert.equal(hash(),before);
  mkdirSync(resolve('artifacts/pi099-migration'),{recursive:true});writeFileSync(resolve('artifacts/pi099-migration/history.json'),JSON.stringify({passed:true,toolCount:tools.length,originalTranscriptUnchanged:true,childErrorsPreserved:true,incompleteWarning:true},null,2));
  console.log('PASS native nested-call history reload, error/cancel state, incomplete warning and immutable transcript');
} finally {rmSync(root,{recursive:true,force:true});}
