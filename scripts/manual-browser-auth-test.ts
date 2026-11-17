import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpRuntimeService } from '../src/main/mcp/McpRuntimeService';

// No network, credentials, browser process or real user profile is used.
const root = mkdtempSync(join(tmpdir(), 'manual-auth-'));
const service = new McpRuntimeService({agentDir:root, configService:{loadRuntimeConfig:()=>({mcpServers:{fixture:{url:'https://example.invalid/mcp'}}})} as any});
let finish!:()=>void;
let calls=0;
(service as any).controller=async()=>({signIn:async(_name:string,prompt:any)=>{
  calls++;
  prompt.showAuthorizationUrl(new URL('https://example.invalid/authorize?state=fixture'));
  await new Promise<void>(resolve=>{finish=resolve;});
}});
const result=await service.authStart('fixture');
assert.equal(result.ok,true);
assert.equal(result.details?.authorizationUrl,'https://example.invalid/authorize?state=fixture');
assert.equal(calls,1);
assert.equal((await service.authStart('fixture')).ok,false,'pending manual flow prevents duplicate sign-in');
finish();
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal((service as any).authFlows.size,0,'completed callback settles the original manual flow');
service.dispose();
console.log('PASS manual MCP authorization URL, duplicate reservation and completion');
