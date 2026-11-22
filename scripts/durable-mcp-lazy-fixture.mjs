import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { access, appendFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { z } from 'zod';
const audit = process.argv[2];
await appendFile(audit, JSON.stringify({ event: 'start', cwd: process.cwd() }) + '\n');
const ready = process.argv[3];
if (ready) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try { await access(ready); break; }
    catch (error) {
      if (error.code !== 'ENOENT' || Date.now() >= deadline) throw error;
      await wait(20);
    }
  }
}
const server = new McpServer({ name: 'durable-lazy-fixture', version: '1.0.0' });
if (ready) server.registerTool('publish', { description: 'Record a release revision in the isolated fixture audit.', inputSchema: z.object({ revision: z.string() }) }, async ({ revision }) => {
  await appendFile(audit, JSON.stringify({ event: 'publish', revision }) + '\n');
  return { content: [{ type: 'text', text: 'published ' + revision }] };
});
server.registerTool('read_cwd', { description: 'Read this task-bound process directory.', inputSchema: z.object({ label: z.string() }) }, async ({ label }) => {
  await appendFile(audit, JSON.stringify({ event: 'call', cwd: process.cwd(), label }) + '\n');
  return { content: [{ type: 'text', text: JSON.stringify({ cwd: process.cwd(), label }) }] };
});
server.registerTool('hidden_tool', { inputSchema: z.object({}) }, async () => {
  await appendFile(audit, JSON.stringify({ event: 'hidden' }) + '\n');
  return { content: [{ type: 'text', text: 'must not run' }] };
});
server.registerResource('fixture', 'fixture://cwd', {}, async uri => ({ contents: [{ uri: uri.href, text: process.cwd() }] }));
await server.connect(new StdioServerTransport());
