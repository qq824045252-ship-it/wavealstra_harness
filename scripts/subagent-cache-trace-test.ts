/** Real Pi RPC worker, local Responses fixture, isolated HOME; no cloud calls. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { SubagentRuntime } from '../src/main/capabilities/subagent/runtime';
import { buildContextBlock, buildSystemPromptContent } from '../src/main/capabilities/subagent/context';

const appArg = process.argv.indexOf('--app-dir');
const appDir = appArg >= 0 ? resolve(process.argv[appArg + 1]!) : undefined;
const entryRoot = appDir ? join(appDir, 'resources/app.asar.unpacked/out/main') : resolve('src/main');
const launcher = join(entryRoot, 'capabilities/subagent/worker-launcher.mjs');
const cli = appDir ? join(entryRoot, 'capabilities/subagent/runtime/pi-runtime.mjs') : resolve('node_modules/@earendil-works/pi-coding-agent/dist/cli.js');
const work = mkdtempSync(join(tmpdir(), 'subagent-cache-fixture-'));
const agent = join(homedir(), '.mybuddy');
mkdirSync(agent, { recursive: true });
const marker = 'PRIVATE_SUBAGENT_BODY_MUST_NOT_BE_LOGGED';
const apiKey = 'PRIVATE_LOCAL_API_KEY_MUST_NOT_BE_LOGGED';
const parent = 'trace-parent-fixture';
const bodies: any[] = [];
let sends = 0, response = 0, disabled = false;
let serverError: unknown;
const server = createServer(async (req, res) => {
  try {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body); sends++;
    assert(req.url?.endsWith('/responses'));
    if (!disabled && sends === 2) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after-ms': '1' }); res.end('{"error":{"message":"retry fixture"}}'); return; }
    const n = ++response;
    const output = !disabled && n < 3
      ? [{ type: 'function_call', id: 'fc_' + n, call_id: 'call_' + n, name: 'read',
          arguments: JSON.stringify({ path: join(work, 'fixture.txt'), offset: 1, limit: 5 }) }]
      : [{ type: 'message', id: 'msg_' + n, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Fixture complete', annotations: [] }] }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const item of output) {
      res.write('data: ' + JSON.stringify({ type: 'response.output_item.added', output_index: 0, item }) + '\n\n');
      res.write('data: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item }) + '\n\n');
    }
    res.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp_child_' + n,
      model: 'child-fixture', status: 'completed', output,
      usage: { input_tokens: 100000, output_tokens: 10, input_tokens_details: { cached_tokens: n === 2 ? 99000 : 0 } } } }) + '\n\n');
  } catch (error) { serverError = error; res.writeHead(500); res.end('{}'); }
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const port = (server.address() as { port: number }).port;
writeFileSync(join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-responses',
  baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, models: [{ id: 'child-fixture', name: 'Child fixture',
    reasoning: false, input: ['text'], contextWindow: 500000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
writeFileSync(join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'child-fixture', enabledModels: ['fixture/child-fixture'] }));
writeFileSync(join(agent, 'auth.json'), '{}');
writeFileSync(join(work, 'fixture.txt'), marker + '\n' + 'fresh data\n'.repeat(10));
const prompt = join(work, 'reviewer.md');
writeFileSync(prompt, buildSystemPromptContent('Review only fixture.txt. ' + marker, buildContextBlock({ cwd: work,
  roleName: 'reviewer', roleDescription: 'fixture', tools: ['read'], permissionMode: 'readonly', deniedTools: ['write', 'edit'], depth: 1 })));
const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agent, MYBUDDY_CACHE_TRACE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const runtime = new SubagentRuntime({ baseDir: join(work, 'subagent'), env,
  resolveInvocation: () => ({ command: process.execPath, args: [launcher, cli] }) });
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const logRecords = () => {
  const dir = join(agent, 'logs');
  return readdirSync(dir).filter(f => /^cache-requests-/.test(f)).flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n'))
    .filter(l => l.includes('[cache-trace] ')).map(l => JSON.parse(l.split('[cache-trace] ')[1]!));
};
try {
  const child = runtime.ensureSubagent({ scope: parent, subagentId: 'reviewer-cache-fixture', role: 'reviewer', roleSource: 'user',
    roleDescription: 'fixture', project: work, depth: 1, model: 'fixture/child-fixture' });
  const outcome = await runtime.runPrompt(child.subagentId, { task: marker, timeoutMs: 90000, model: 'fixture/child-fixture',
    systemPromptFile: prompt, permissionMode: 'readonly', toolArgs: { tools: ['read'], excludeTools: [] } });
  assert.equal(outcome.status, 'completed', JSON.stringify(outcome));
  assert.equal(serverError, undefined); assert.equal(response, 3); assert.equal(sends, 4);
  assert.equal(runtime.get(child.subagentId), undefined, 'normal disposable cleanup still runs');
  assert.equal(outcome.usage.turns, 4, 'three successes plus the native retry error; diagnostics are not replies');
  assert(bodies[0].input.some((p: any) => JSON.stringify(p).includes('读取与审查范围')), 'bounded-read guidance reaches the actual native worker prompt');
  assert.deepEqual(bodies[1], bodies[2], 'retry resends the same request');
  for (const [a, b] of [[bodies[0], bodies[1]], [bodies[2], bodies[3]]]) {
    assert.deepEqual(b.input.slice(0, a.input.length), a.input, 'repeated file reads cannot rewrite previous history');
  }
  const records = logRecords().filter(r => r.parentSessionHash === hash(parent));
  assert(records.length > 0, 'host persists traces after child cleanup');
  assert(records.every(r => r.source === 'subagent' && r.sessionHash === hash(child.subagentId)));
  assert(!JSON.stringify(records).includes(marker)); assert(!JSON.stringify(records).includes(apiKey));
  assert(!JSON.stringify(records).includes(work)); assert(!JSON.stringify(records).includes(parent));
  const { summarizeCacheTraces } = await import(pathToFileURL(resolve('scripts/cache-trace-audit.mjs')).href);
  const report = summarizeCacheTraces(records);
  assert.equal(report.calls, 4);
  assert.equal(report.classificationCounts['raw-cache-usage-missing'], 3);
  assert.equal(report.classificationCounts['request-failed'], 1);
  assert(report.requests.every((r: any) => r.cacheReadState === 'missing' && r.rawUsage === null),
    'child workers have no raw provider-event hook; normalized zero is not evidence of explicit raw zero');
  assert.deepEqual(report.requests.map((r: any) => r.usage.cacheRead), [0, 0, 99000, 0],
    'raw telemetry gaps must preserve native normalized accounting');
  assert(report.requests.every((r: any) => !r.retryChanged && r.adapterMatches.every((v: boolean) => v === true)));
  assert.deepEqual(report.requests.map((r: any) => r.httpStatuses), [[200], [503], [200], [200]]);
  assert.equal(report.requests[1].historyUncachedTokens, null, 'an unbilled provider error is not a cache loss');
  assert.equal(report.requests[3].historyUncachedTokens, null, 'unobserved raw cache usage cannot establish historical cache loss');
  const parentReport = JSON.parse(execFileSync(process.execPath, ['scripts/cache-trace-audit.mjs', '--session', parent], { encoding: 'utf8' }));
  assert.equal(parentReport.calls, 4, 'parent lookup finds children without preserving child session files');
  assert(parentReport.requests.every((r: any) => r.source === 'subagent' && r.parentSessionHash === hash(parent)));
  console.log('PASS real child RPC: repeated reads, unchanged prefixes, 503 retry, preserved usage, raw telemetry gaps, correlation and cleanup');
  const before = logRecords().length;
  disabled = true; env.MYBUDDY_CACHE_TRACE = '0';
  const off = runtime.ensureSubagent({ scope: parent, subagentId: 'reviewer-trace-disabled', role: 'reviewer', roleSource: 'user',
    roleDescription: 'fixture', project: work, depth: 1, model: 'fixture/child-fixture' });
  const offResult = await runtime.runPrompt(off.subagentId, { task: 'Trace disabled fixture', timeoutMs: 90000,
    model: 'fixture/child-fixture', permissionMode: 'readonly', toolArgs: { tools: [], excludeTools: [] } });
  assert.equal(offResult.status, 'completed', JSON.stringify(offResult));
  assert.equal(logRecords().length, before, 'opt-out still permits inference but emits no diagnostics');
  console.log('PASS trace opt-out: native child completes without diagnostic records');
} finally {
  runtime.cleanupTask(parent); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r()));
}
