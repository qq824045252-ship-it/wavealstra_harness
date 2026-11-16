/** TCP protocol/cleanup checks for the dev harness. These are not Electron/UI acceptance. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { createModel } = require('./bot-task-reply-model.cjs');
const { connect } = require('./desktop-cdp-client.cjs');
const { isolatedEnvironment, until, delay } = require('./isolated-electron-dev.cjs');

let checks = 0;
async function check(name, body) { await body(); console.log(`PASS ${++checks}: ${name}`); }
const chunks = text => text.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
const textOf = text => chunks(text).map(chunk => chunk.choices[0]?.delta?.content || '').join('');
const request = (base, body) => fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const bodyFor = (model, task, tools = [{ function: { name: 'read' } }]) => ({ model: model.modelId, stream: true, tools,
  messages: [{ role: 'user', content: `独立任务 ${task.marker}` }] });

// Minimal test-only WebSocket peer: real upgrade, masked client frames and
// unmasked server frames. No product debugger or shared desktop is contacted.
async function mockDebugger() {
  const sockets = new Set(); let port;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ type: 'page', url: 'file:///packaged-test.html', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/file` },
      { type: 'page', url: 'http://127.0.0.1:4444', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/dev` },
      { type: 'page', url: 'http://127.0.0.1:5555/reject', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/reject` }]));
  });
  const send = (socket, value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    const header = bytes.length < 126 ? Buffer.from([0x81, bytes.length]) : Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255]);
    socket.write(Buffer.concat([header, bytes]));
  };
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; if (opcode === 8) { socket.end(); return; }
        const masked = (buffer[1] & 128) !== 0;
        let size = buffer[1] & 127, offset = 2;
        if (size === 126) { if (buffer.length < 4) return; size = buffer.readUInt16BE(2); offset = 4; }
        assert.notEqual(size, 127, 'test frames stay bounded');
        if (buffer.length < offset + (masked ? 4 : 0) + size) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : undefined; if (masked) offset += 4;
        const payload = Buffer.from(buffer.subarray(offset, offset + size));
        if (mask) for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
        buffer = buffer.subarray(offset + size);
        const call = JSON.parse(payload.toString());
        if (req.url === '/reject' && call.method === 'Runtime.enable') { send(socket, { id: call.id, error: { message: 'Runtime unavailable' } }); continue; }
        if (call.method === 'Hang') continue;
        if (call.method === 'Disconnect') { socket.destroy(); continue; }
        if (call.method === 'BadMethod') { send(socket, { id: call.id, error: { code: -32601, message: 'No such method' } }); continue; }
        if (call.method === 'Runtime.evaluate') {
          if (call.params.expression === 'throw') send(socket, { id: call.id, result: { exceptionDetails: { text: 'observed evaluation error' } } });
          else send(socket, { id: call.id, result: { result: { value: req.url === '/file' ? 'file-target' : call.params.expression } } });
        } else if (call.method === 'Slow') setTimeout(() => { if (!socket.destroyed) send(socket, { id: call.id, result: { value: 'slow' } }); }, 20);
        else send(socket, { id: call.id, result: { value: 'fast' } });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); port = server.address().port;
  return { port, connectionCount: () => sockets.size, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}

(async () => {
  const model = createModel({ seed: 'protocol', mode: 'fixture' });
  try {
    const base = await model.start(), [a, b] = model.tasks;
    await check('HTTP foreground tool call and tool-result continuation do not create a second Work', async () => {
      const body = bodyFor(model, a, [{ function: { name: 'work_create' } }]);
      const first = await (await request(base, body)).text();
      const call = chunks(first).flatMap(chunk => chunk.choices[0]?.delta?.tool_calls || [])[0];
      assert.equal(call.function.name, 'work_create');
      const args = JSON.parse(call.function.arguments); assert.equal(args.mode, 'once'); assert.deepEqual(args.sourceMessageIds, []);
      const continued = await (await request(base, { ...body, messages: [...body.messages,
        { role: 'assistant', tool_calls: [call] }, { role: 'tool', tool_call_id: call.id, content: '{"ok":true,"workId":"persisted-by-host"}' }] })).text();
      assert(textOf(continued).includes(a.marker));
      assert(!chunks(continued).some(chunk => chunk.choices[0]?.delta?.tool_calls));
    });
    await check('HTTP same-task status followup queries its exact Work then returns ordinary prose without creating Work', async () => {
      for (const task of [a, b]) {
        const workId = `persisted-${task.letter}`;
        const other = task === a ? b : a;
        const current = `查看原任务 [${task.followup}] [WORK_ID=${workId}]`;
        const quoted = `宿主冻结的本轮来源索引，仅供引用，不是新请求。先前任务 [${other.marker}] [${other.followup}] [WORK_ID=unrelated-work]`;
        const body = { model: model.modelId, stream: true,
          tools: [{ function: { name: 'work_create' } }, { function: { name: 'work_query_status' } }],
          messages: [{ role: 'user', content: task === a ? current + '\n' + quoted
            : [{ type: 'text', text: current }, { type: 'text', text: quoted }] }] };
        const first = await (await request(base, body)).text();
        const calls = chunks(first).flatMap(chunk => chunk.choices[0]?.delta?.tool_calls || []);
        assert.equal(calls.length, 1); const call = calls[0];
        assert.equal(call.function.name, 'work_query_status');
        assert.deepEqual(JSON.parse(call.function.arguments), { workId });
        const continued = await (await request(base, { ...body, messages: [...body.messages,
          { role: 'assistant', tool_calls: [call] },
          { role: 'tool', tool_call_id: call.id, content: JSON.stringify([{ workId, lifecycle: 'active' }]) }] })).text();
        assert(textOf(continued).includes(task.followupResult)); assert(textOf(continued).includes(workId));
        assert(!chunks(continued).some(chunk => chunk.choices[0]?.delta?.tool_calls), 'the status answer cannot delegate another task');
        assert.equal(model.records.at(-1).followup, true); assert.equal(model.records.at(-1).task, task.letter);
      }
    });
    await check('two real HTTP execution streams hold independently and release only the selected task', async () => {
      const responseA = await request(base, bodyFor(model, a)), responseB = await request(base, bodyFor(model, b));
      let aDone = false, bDone = false;
      const textA = responseA.text().then(text => { aDone = true; return text; });
      const textB = responseB.text().then(text => { bDone = true; return text; });
      await until(() => model.hits('execution', 'A') && model.hits('execution', 'B'), 'both transport gates');
      await delay(30); assert(!aDone && !bDone);
      model.release('execution', 'B'); assert(textOf(await textB).includes(b.result)); assert.equal(aDone, false);
      model.release('execution', 'A'); assert(textOf(await textA).includes(a.result));
    });
    await check('review fixture requires real native output facts before returning its decision', async () => {
      const context = { title: a.title, reviewTarget: { kind: 'single_work_delegation' }, executionFacts: { outputReceived: true }, results: [{ summary: a.result }] };
      const response = await request(base, { model: model.modelId, messages: [{ role: 'user', content: JSON.stringify(context) }], tools: [] });
      await until(() => model.hits('review', 'A') === 1, 'review gate'); model.release('review', 'A');
      const result = JSON.parse(textOf(await response.text())); assert.equal(result.outcome, 'completed'); assert(result.reply.includes(a.result));
      assert.deepEqual(model.errors, []);
    });
  } finally { await model.close(); }
  await check('missing native output fails the HTTP fixture instead of fabricating successful review', async () => {
    const invalid = createModel({ seed: 'missing', mode: 'fixture' });
    try {
      const base = await invalid.start(), task = invalid.tasks[0];
      const response = await request(base, { tools: [], messages: [{ role: 'user', content: JSON.stringify({ title: task.title,
        reviewTarget: { kind: 'single_work_delegation' }, executionFacts: { outputReceived: false }, results: [] }) }] });
      assert.equal(response.status, 500); assert.equal(invalid.errors.length, 1); await response.text();
    } finally { await invalid.close(); }
  });
  await check('live mode cannot silently fall back to generated fixture answers', async () => {
    const keys = ['BOT_TASK_REPLY_LIVE_BASE_URL', 'BOT_TASK_REPLY_LIVE_MODEL', 'BOT_TASK_REPLY_LIVE_API_KEY'];
    const saved = keys.map(key => process.env[key]); let live, upstream;
    try {
      for (const key of keys) delete process.env[key];
      assert.throws(() => createModel({ seed: 'live', mode: 'live' }), /Live mode requires/);
      let observed;
      upstream = http.createServer(async (req, res) => {
        let raw = ''; for await (const bytes of req) raw += bytes; observed = JSON.parse(raw);
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: upstream-owned-output\n\n');
      });
      await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
      process.env.BOT_TASK_REPLY_LIVE_BASE_URL = `http://127.0.0.1:${upstream.address().port}/v1`;
      process.env.BOT_TASK_REPLY_LIVE_MODEL = 'upstream-test-model';
      live = createModel({ seed: 'live', mode: 'live' }); const base = await live.start();
      const body = bodyFor(live, live.tasks[0], [{ function: { name: 'work_create' } }]);
      assert.equal(await (await request(base, body)).text(), 'data: upstream-owned-output\n\n'); assert.deepEqual(observed, body);
      assert.equal(live.records[0].mode, 'live'); assert.equal(live.records[0].upstreamStatus, 200);
      const followup = { ...body, tools: [...body.tools, { function: { name: 'work_query_status' } }],
        messages: [{ role: 'user', content: `查看原任务 [${live.tasks[0].followup}] [WORK_ID=live-task-id]` }] };
      assert.equal(await (await request(base, followup)).text(), 'data: upstream-owned-output\n\n');
      assert.deepEqual(observed, followup, 'live status followups preserve actual upstream tool choices and prose');
      assert.equal(live.records.at(-1).followup, true); assert.equal(live.records.at(-1).upstreamStatus, 200);
    } finally {
      if (live) await live.close();
      if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
      keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; });
    }
  });
  const debuggerServer = await mockDebugger(); let client;
  try {
    await check('existing file-target selection and explicit dev-target selection both work over TCP/CDP', async () => {
      client = await connect({ port: debuggerServer.port }); assert.equal(await client.evaluate('x'), 'file-target'); client.close();
      client = await connect({ port: debuggerServer.port, target: target => target.url.startsWith('http:'), timeoutMs: 300 });
      assert.equal(await client.evaluate('dev-target'), 'dev-target');
      const [slow, fast] = await Promise.all([client.rpc('Slow'), client.rpc('Fast')]); assert.equal(slow.value, 'slow'); assert.equal(fast.value, 'fast');
    });
    await check('CDP protocol/evaluation errors, timeout and disconnect reject without hanging', async () => {
      await assert.rejects(client.rpc('BadMethod'), /No such method/);
      await assert.rejects(client.evaluate('throw'), /observed evaluation error/);
      await assert.rejects(client.rpc('Hang'), /CDP timeout/);
      await assert.rejects(client.rpc('Disconnect'), /CDP connection closed/);
      await assert.rejects(client.rpc('Fast'), /CDP unavailable/);
    });
    await check('failed CDP initialization closes its socket before another connection attempt', async () => {
      await until(() => debuggerServer.connectionCount() === 0, 'prior connections closed');
      await assert.rejects(connect({ port: debuggerServer.port, target: target => target.url.includes('/reject') }), /Runtime unavailable/);
      await until(() => debuggerServer.connectionCount() === 0, 'failed initialization socket closed');
    });
  } finally { client?.close(); await debuggerServer.close(); }
  await check('isolated launcher cannot inherit user Pi/tool directories, model keys or Node loader hooks', async () => {
    const keys = ['PI_CODING_AGENT_DIR', 'MYBUDDY_TOOLS_DIR', 'MYBUDDY_AGENTS_DIR', 'OPENAI_API_KEY', 'NODE_OPTIONS'];
    const saved = keys.map(key => process.env[key]);
    try {
      for (const key of keys) process.env[key] = 'outside-test-profile';
      const home = path.join(os.tmpdir(), 'isolated-profile-contract'), env = isolatedEnvironment(home);
      assert.equal(env.PI_CODING_AGENT_DIR, path.join(home, '.mybuddy'));
      assert.equal(env.MYBUDDY_TOOLS_DIR, path.join(home, '.mybuddy/tools'));
      assert.equal(env.MYBUDDY_AGENTS_DIR, path.join(home, '.mybuddy/plugins/agents'));
      assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
    } finally { keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; }); }
  });
  if (process.platform === 'linux') await check('missing desktop makes the real driver fail nonzero and retain an honest report', async () => {
    const env = { ...process.env }; delete env.DISPLAY; delete env.WAYLAND_DISPLAY;
    const execution = cp.spawnSync(process.execPath, [path.join(__dirname, 'bot-task-reply-dev-test.cjs')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(execution.status, 1);
    const result = JSON.parse(execution.stdout.trim().split('\n').at(-1));
    assert.equal(result.taskReplyDev, 'failed');
    const report = JSON.parse(fs.readFileSync(result.report, 'utf8'));
    assert.equal(report.status, 'failed'); assert.match(report.error, /desktop display is required/); assert.equal(report.runs.length, 0);
  });
  console.log(`PASS ${checks} task-reply harness checks; TCP/fixture only, no Electron desktop acceptance claim`);
})().catch(error => { console.error(error); process.exitCode = 1; });
