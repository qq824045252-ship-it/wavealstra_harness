import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve(process.argv[2]);
const server=new McpServer({name:'codemode-auto-fixture',version:'1.0.0'});
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value});
server.registerTool('read_seed',{description:'Read the random seed and numbers from the disposable scene-test workspace.',inputSchema:z.object({}),annotations:{readOnlyHint:true,openWorldHint:false}},async()=>{
  await appendFile(join(root,'mcp-audit.jsonl'),JSON.stringify({tool:'read_seed',at:Date.now()})+'\n');
  return result(JSON.parse(await readFile(join(root,'seed.json'),'utf8')));
});
server.registerTool('save_result',{description:'Save a calculated answer only to the disposable scene-test workspace.',inputSchema:z.object({nonce:z.string(),sum:z.number()}),annotations:{readOnlyHint:false,openWorldHint:false}},async value=>{
  await writeFile(join(root,'result.json'),JSON.stringify(value));
  await appendFile(join(root,'mcp-audit.jsonl'),JSON.stringify({tool:'save_result',value,at:Date.now()})+'\n');
  return result(value);
});
await server.connect(new StdioServerTransport());
