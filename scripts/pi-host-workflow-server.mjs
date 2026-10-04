import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { resolve, relative, join, isAbsolute } from 'node:path';
const workspace = resolve(process.argv[2]);
const repository = resolve(process.argv[3]);
// Audit is outside the tool-visible workspace; the verifier, not model text, counts actual writes.
const writeAudit = process.argv[4] ? resolve(process.argv[4]) : undefined;
const metrics = { activeReads: 0, maxReads: 0, activeWrites: 0, maxWrites: 0, writes: 0, cancelled: 0 };
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
function file(name) {
  const full = resolve(workspace, name), rel = relative(workspace, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Test workspace boundary violation');
  return full;
}
function delay(ms, signal) {
  return new Promise((yes, no) => {
    const cancel = () => { clearTimeout(timer); metrics.cancelled++; no(Error('Cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); yes(); }, ms);
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
  });
}
const server = new McpServer({ name: 'mybuddy-native-mcp-workflows', version: '1.0.0' });
server.registerTool('get_source_inventory', {
  description: 'Read the real TypeScript source tree and return file paths and sizes. No file content or credentials are read.',
  inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false },
}, async () => {
  const files = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push({ path: relative(repository, full).replaceAll('\\', '/'), bytes: (await fs.stat(full)).size });
    }
  }
  await walk(join(repository, 'src'));
  return result({ files, total: files.length, totalBytes: files.reduce((sum, item) => sum + item.bytes, 0) });
});
server.registerTool('read_file', { description: 'Read UTF-8 text from the isolated test workspace.', inputSchema: z.object({ path: z.string() }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ path }) => result({ text: await fs.readFile(file(path), 'utf8') }));
server.registerTool('read_delay', { description: 'Read a value after a bounded delay; used to verify real MCP concurrency and cancellation.', inputSchema: z.object({ value: z.number(), delayMs: z.number().min(0).max(5000).default(100) }), annotations: { readOnlyHint: true, openWorldHint: false } }, async ({ value, delayMs }, extra) => {
  metrics.activeReads++; metrics.maxReads = Math.max(metrics.maxReads, metrics.activeReads);
  try { await delay(delayMs, extra.signal); return result({ value }); } finally { metrics.activeReads--; }
});
server.registerTool('write_file', { description: 'Write UTF-8 text only within the isolated test workspace.', inputSchema: z.object({ path: z.string(), text: z.string() }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ path, text }) => {
  const target = file(path); await fs.mkdir(resolve(target, '..'), { recursive: true }); await fs.writeFile(target, text); metrics.writes++;
  if (writeAudit) await fs.appendFile(writeAudit, JSON.stringify({ operation: "write_file", path: relative(workspace, target).replaceAll("\\", "/"), bytes: Buffer.byteLength(text), at: Date.now() })+"\n");
  return result({ path, bytes: Buffer.byteLength(text) });
});
server.registerTool('increment_counter', { description: 'Read, increment and write counter.json within the test workspace. Must run serially.', inputSchema: z.object({ delayMs: z.number().min(0).max(5000).default(80) }), annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } }, async ({ delayMs }, extra) => {
  metrics.activeWrites++; metrics.maxWrites = Math.max(metrics.maxWrites, metrics.activeWrites);
  try {
    let value = 0; try { value = JSON.parse(await fs.readFile(file('counter.json'), 'utf8')).value; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(delayMs, extra.signal);
    if (extra.signal.aborted) throw Error('Cancelled before commit');
    await fs.writeFile(file('counter.json'), JSON.stringify({ value: value + 1 })); metrics.writes++;
    return result({ value: value + 1 });
  } finally { metrics.activeWrites--; }
});
server.registerTool('report_failure', { description: 'Return an explicit MCP application failure without modifying anything.', inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false } }, async () => ({ ...result({ code: 'EXPECTED_TEST_FAILURE', message: 'Deliberate non-mutating failure' }), isError: true }));
server.registerTool('get_metrics', { description: 'Return concurrency and write counters of this server process.', inputSchema: z.object({}), annotations: { readOnlyHint: true, openWorldHint: false } }, async () => result({ ...metrics }));
await fs.mkdir(workspace, { recursive: true });
await server.connect(new StdioServerTransport());
