import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, InMemoryAuthStorageBackend, McpOAuthCredentialStore } from '@earendil-works/pi-coding-agent';
import { McpRuntimeService } from '../src/main/mcp/McpRuntimeService';
import { McpConfigService } from '../src/main/mcp/McpConfigService';

const temp=mkdtempSync(join(tmpdir(),'mybuddy-pi099-oauth-')),home=join(temp,'home'),agentDir=join(home,'.mybuddy');mkdirSync(agentDir,{recursive:true});
const report:any={kind:'local OAuth integration fixture; no external account authorization',startedAt:new Date().toISOString(),tests:[]};
const reportPath=resolve('artifacts/pi099-migration/oauth.json');mkdirSync(resolve('artifacts/pi099-migration'),{recursive:true});
const save=()=>writeFileSync(reportPath,JSON.stringify(report,null,2));
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>boolean){const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw Error('OAuth state timeout');await wait(25);}}
async function body(req:IncomingMessage){const chunks:Buffer[]=[];for await(const chunk of req){chunks.push(Buffer.from(chunk));if(chunks.reduce((n,b)=>n+b.length,0)>200000)throw Error('Request too large');}return Buffer.concat(chunks).toString();}
let origin='',currentToken='',refreshToken='';let tokenVersion=0;const codes=new Map<string,{challenge:string;redirectUri:string}>();
const counters={registrations:0,authorizations:0,codeExchanges:0,refreshes:0,authenticatedCalls:0};
const http=createServer((req,res)=>{void(async()=>{
  const url=new URL(req.url??'/',origin);
  const json=(code:number,value:unknown,headers:Record<string,string>={})=>{res.writeHead(code,{'content-type':'application/json',...headers});res.end(JSON.stringify(value));};
  if(url.pathname==='/.well-known/oauth-protected-resource'||url.pathname==='/.well-known/oauth-protected-resource/mcp')return json(200,{resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['read']});
  if(url.pathname==='/.well-known/oauth-authorization-server')return json(200,{issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],scopes_supported:['read']});
  if(url.pathname==='/register'){const client=JSON.parse(await body(req));counters.registrations++;return json(201,{...client,client_id:'local-pi099-fixture',client_id_issued_at:Math.floor(Date.now()/1000)});}
  if(url.pathname==='/authorize'){
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');const code=randomUUID();const redirectUri=url.searchParams.get('redirect_uri')!;
    codes.set(code,{challenge:url.searchParams.get('code_challenge')!,redirectUri});counters.authorizations++;
    const redirect=new URL(redirectUri);redirect.searchParams.set('code',code);redirect.searchParams.set('state',url.searchParams.get('state')!);
    res.writeHead(302,{location:redirect.href});res.end();return;
  }
  if(url.pathname==='/token'){
    const params=new URLSearchParams(await body(req));
    if(params.get('grant_type')==='authorization_code'){
      const code=params.get('code')!,pending=codes.get(code);assert(pending,'Unknown authorization code');codes.delete(code);
      assert.equal(params.get('redirect_uri'),pending.redirectUri);assert.equal(createHash('sha256').update(params.get('code_verifier')!).digest('base64url'),pending.challenge);
      counters.codeExchanges++;
    }else{assert.equal(params.get('grant_type'),'refresh_token');assert.equal(params.get('refresh_token'),refreshToken);counters.refreshes++;}
    currentToken='local-fixture-token-'+(++tokenVersion);refreshToken='local-fixture-refresh-'+tokenVersion;
    return json(200,{access_token:currentToken,token_type:'Bearer',refresh_token:refreshToken,expires_in:3600,scope:'read'});
  }
  if(url.pathname==='/mcp'){
    if(!currentToken||req.headers.authorization!=='Bearer '+currentToken)return json(401,{error:'authorization_required'},{'www-authenticate':`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", scope="read"`});
    if(req.method!=='POST'){res.writeHead(405);res.end();return;}
    const request=JSON.parse(await body(req));if(request.id==null){res.writeHead(202);res.end();return;}
    let result:unknown;
    if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'oauth-fixture',version:'1.0.0'}};
    else if(request.method==='tools/list')result={tools:[{name:'read_authorized',description:'Read a marker from the authenticated local test server.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,openWorldHint:false}}]};
    else if(request.method==='tools/call'){counters.authenticatedCalls++;result={content:[{type:'text',text:'authorized-local-fixture'}],structuredContent:{authorized:true}};}
    else if(request.method==='ping')result={};
    else return json(200,{jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}});
    return json(200,{jsonrpc:'2.0',id:request.id,result});
  }
  json(404,{error:'not_found'});
})().catch(error=>{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:String(error)}));});});
await new Promise<void>(r=>http.listen(0,'127.0.0.1',r));origin='http://127.0.0.1:'+(http.address() as any).port;
const configPath=join(agentDir,'mcp.json');writeFileSync(configPath,JSON.stringify({mcpServers:{auth:{url:origin+'/mcp',oauth:{scope:'read'},timeout:5}}}));
const store=new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
const service=new McpRuntimeService({agentDir,configService:new McpConfigService({homeDir:home,appGlobalPath:configPath}),credentials:store});
let task:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
async function test(name:string,run:()=>Promise<unknown>){try{const details=await run();report.tests.push({name,passed:true,details});console.log('PASS '+name);}catch(error){report.tests.push({name,passed:false,error:error instanceof Error?error.stack:String(error)});console.error('FAIL '+name+': '+String(error));}save();}
try{
  await test('native manager reports needs-auth without starting a browser flow',async()=>{
    assert(await service.ensureHeadlessSession());await until(()=>service.getServerStatus('auth')?.status==='needs-auth');
    assert.equal(counters.authorizations,0);assert.equal(service.hasCredentials('auth'),false);return {state:service.getServerStatus('auth')?.status};
  });
  await test('explicit manager sign-in completes real PKCE exchange through authComplete',async()=>{
    const started=await service.authStart('auth');assert(started.ok,started.error);assert.equal(started.details?.runtime,'pi-native');
    const url=String(started.details?.authorizationUrl);assert(url.startsWith(origin+'/authorize'));
    const authorize=await fetch(url,{redirect:'manual'});assert.equal(authorize.status,302);
    const callback=authorize.headers.get('location')!;await wait(20);
    const complete=await service.authComplete('auth',callback);assert(complete.ok,complete.error);
    await until(()=>service.getServerStatus('auth')?.status==='connected');assert(service.hasCredentials('auth'));assert.equal(counters.codeExchanges,1);
    return {pkceValidated:true,exchanges:counters.codeExchanges};
  });
  await test('task uses the manager credentials and performs an authenticated MCP read',async()=>{
    const settings=SettingsManager.inMemory({});const loader=new DefaultResourceLoader({cwd:temp,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,
      eventBus:service.createEventBus('oauth-task'),extensionFactories:service.getInlineExtensions({welcomeMode:'coding',sessionLabel:'oauth-task'})});
    await loader.reload();const result=await createAgentSession({cwd:temp,agentDir,settingsManager:settings,sessionManager:SessionManager.inMemory(temp),resourceLoader:loader});task=result.session;
    service.attachSession('oauth-task',result.extensionsResult);await task.bindExtensions({});await until(()=>service.getServerStatus('auth','oauth-task')?.status==='connected');
    const value:any=await task.getToolDefinition('mcp__auth__read_authorized')!.execute('auth-read',{},undefined,undefined,task.extensionRunner!.createToolContext('auth-read',undefined));
    assert.equal(value.structuredContent.structuredContent.authorized,true);assert.equal(counters.codeExchanges,1);
    return {authenticatedCalls:counters.authenticatedCalls,additionalLoginRequired:false};
  });
  await test('401 triggers native refresh, preserving usable shared credentials',async()=>{
    assert(task);currentToken='force-refresh-now';
    const value:any=await task!.getToolDefinition('mcp__auth__read_authorized')!.execute('auth-refresh',{},undefined,undefined,task!.extensionRunner!.createToolContext('auth-refresh',undefined));
    assert.equal(value.structuredContent.structuredContent.authorized,true);assert(counters.refreshes>=1);assert(service.hasCredentials('auth'));
    return {refreshes:counters.refreshes};
  });
  await test('manager logout removes shared credentials and invalidates the task connection',async()=>{
    const result=await service.logout('auth');assert(result.ok,result.error);assert(!service.hasCredentials('auth'));
    assert.notEqual(service.getServerStatus('auth','oauth-task')?.status,'connected');
    assert.equal((await service.connect('auth','oauth-task')).ok,false);
    return {manager:service.getServerStatus('auth')?.status,task:service.getServerStatus('auth','oauth-task')?.status};
  });
  await test('logout during browser sign-in cancels the flow without restoring credentials',async()=>{
    const started=await service.authStart('auth');assert(started.ok,started.error);assert(started.details?.authorizationUrl);
    await wait(20);const result=await service.logout('auth');assert(result.ok,result.error);
    assert(!service.hasCredentials('auth'));assert.equal((await service.authComplete('auth','http://127.0.0.1/callback?code=late')).ok,false);
    return {pendingSignInCancelled:true,credentialsAbsent:true};
  });
}finally{if(task){await task.extensionRunner?.emit({type:'session_shutdown',reason:'quit'});task.dispose();}service.dispose();http.closeAllConnections();await new Promise<void>(r=>http.close(()=>r()));rmSync(temp,{recursive:true,force:true});report.finishedAt=new Date().toISOString();report.counters=counters;save();process.exitCode=report.tests.some((t:any)=>!t.passed)?1:0;}
