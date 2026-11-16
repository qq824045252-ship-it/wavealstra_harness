/** The only simulated boundary in fixture mode is the OpenAI-compatible HTTP provider. */
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const messageText = message => typeof message?.content === 'string' ? message.content
  : (message?.content || []).map(part => part.text || '').join('\n');
function createModel({ seed, mode = 'fixture' }) {
  assert(['fixture', 'live'].includes(mode), 'BOT_TASK_REPLY_MODEL_MODE must be fixture or live');
  const live = mode === 'live';
  const liveBase = process.env.BOT_TASK_REPLY_LIVE_BASE_URL;
  const modelId = live ? process.env.BOT_TASK_REPLY_LIVE_MODEL : 'task-reply-fixture';
  assert(!live || liveBase && modelId, 'Live mode requires explicit BOT_TASK_REPLY_LIVE_BASE_URL and BOT_TASK_REPLY_LIVE_MODEL; fixture is never a live fallback.');
  const tasks = ['A', 'B'].map(letter => ({ letter, marker: `BTR_${letter}_${seed}`, result: `RESULT_${letter}_${seed}`,
    followup: `STATUS_${letter}_${seed}`, followupResult: `STATUS_REPLY_${letter}_${seed}`,
    title: `回复验收 ${letter} ${seed}` }));
  const ping = `PING_${seed}`;
  const gates = new Map();
  const records = [], errors = [], pending = new Set();
  for (const task of tasks) for (const lane of ['execution', 'review']) {
    let release; const promise = new Promise(resolve => { release = resolve; });
    gates.set(`${lane}:${task.letter}`, { promise, release, opened: false, hits: 0 });
  }
  const release = (lane, letter) => { const gate = gates.get(`${lane}:${letter}`); gate.opened = true; gate.release(); };
  const waitGate = async (lane, task, response) => {
    const gate = gates.get(`${lane}:${task.letter}`); gate.hits++;
    if (gate.opened) return;
    let abort, timer;
    try {
      await Promise.race([gate.promise, new Promise((_, reject) => {
        abort = () => reject(Error('provider client disconnected while response was held'));
        response.once('close', abort);
        timer = setTimeout(() => reject(Error(`provider gate timeout: ${lane}:${task.letter}`)), 120000);
      })]);
    } finally { clearTimeout(timer); response.removeListener('close', abort); }
  };
  async function handleRequest(request, response) {
    let record;
    try {
      assert.equal(request.method, 'POST'); assert.match(request.url, /\/chat\/completions$/);
      let raw = '';
      for await (const bytes of request) { raw += bytes; assert(raw.length < 8 * 1024 * 1024, 'bounded test model request'); }
      const body = JSON.parse(raw), messages = body.messages || [];
      const names = (body.tools || []).map(tool => tool.function?.name);
      const userIndex = messages.findLastIndex(message => message.role === 'user');
      const input = messageText(messages[userIndex]);
      let context; try { context = JSON.parse(input); } catch {}
      const foreground = names.includes('work_create');
      const review = !foreground && context?.reviewTarget && context?.executionFacts;
      // Every fixture composer request is one line. The host appends time and
      // frozen-source text after it; quoted older tasks cannot select this turn.
      const foregroundInput = input.split(/\r?\n/, 1)[0];
      const followupTask = foreground ? tasks.find(item => foregroundInput.includes(`[${item.followup}]`)) : undefined;
      const task = followupTask ?? tasks.find(item => review ? context.title?.includes(item.title)
        : (foreground ? foregroundInput : input).includes(item.marker));
      const followup = Boolean(followupTask);
      const lane = foreground ? 'foreground' : review ? 'review' : 'execution';
      assert(foreground || task, 'native request must identify its own test task');
      record = { id: randomUUID(), lane, task: task?.letter, startedAt: new Date().toISOString(), model: body.model,
        tools: names, mode, request: body, followup: Boolean(followup) };
      records.push(record);
      assert(records.length <= 40, 'unexpected repeated model work; refusing a runaway test');
      if (live) {
        if (!foreground) await waitGate(lane, task, response);
        const controller = new AbortController(), disconnected = () => controller.abort();
        response.once('close', disconnected);
        try {
          const headers = { 'content-type': 'application/json' };
          if (process.env.BOT_TASK_REPLY_LIVE_API_KEY) headers.authorization = `Bearer ${process.env.BOT_TASK_REPLY_LIVE_API_KEY}`;
          const upstream = await fetch(liveBase.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers, body: raw,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]) });
          record.upstreamStatus = upstream.status;
          response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' });
          for await (const bytes of upstream.body) response.write(bytes);
          response.end();
        } finally { response.removeListener('close', disconnected); }
      } else {
        const afterUser = messages.slice(userIndex + 1);
        const needsTool = foreground && task && !afterUser.some(message => message.role === 'tool');
        const requestedWorkId = followup ? foregroundInput.slice(foregroundInput.indexOf(`[${task.followup}]`) + task.followup.length + 2)
          .match(/^\s+\[WORK_ID=([^\]\s]+)\]/)?.[1] : undefined;
        if (followup) {
          assert(requestedWorkId, 'status followup names an exact persisted Work ID');
          assert(names.includes('work_query_status'), 'status followup requires the real query tool');
          if (!needsTool) assert(afterUser.some(message => message.role === 'tool' && messageText(message).includes(requestedWorkId)),
            'status followup requires a tool result for the requested Work');
        }
        const tool = needsTool ? followup ? { name: 'work_query_status', arguments: JSON.stringify({ workId: requestedWorkId }) }
          : { name: 'work_create', arguments: JSON.stringify({ requestedOutcome: 'one_time', mode: 'once',
            title: task.title, goalDescription: `在后台独立回复 ${task.result}。`, sourceMessageIds: [], independentGoal: true }) } : undefined;
        let text;
        if (review) {
          assert.equal(context.executionFacts.outputReceived, true, 'fixture review requires a real delivered native result');
          assert(context.results.some(result => result.summary.includes(task.result)), 'fixture review reads the matching result evidence');
          text = JSON.stringify({ decision: 'deliver', outcome: 'completed', reply: `已核对：${task.result}`, artifactRefs: [], missing: [] });
        } else if (foreground) {
          text = followup ? `已读取原任务 ${requestedWorkId} 的执行状态。${task.followupResult}`
            : foregroundInput.includes(ping) ? `快答完成 ${ping}` : `已接收 ${task?.marker}，独立后台任务正在推进。\n\n`
            + Array.from({ length: 12 }, (_, index) => `验收说明 ${index + 1}：这是本地模型夹具产生的对话正文，用于检查实际滚动和原回复归属。`).join('\n\n');
        } else text = `后台实际模型传输结果：${task.result}`;
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const chunk = value => response.write(`data: ${JSON.stringify({ id: record.id, object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000), model: modelId, ...value })}\n\n`);
        chunk({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        if (!foreground) { record.heldAt = new Date().toISOString(); await waitGate(lane, task, response); }
        const delta = tool ? { tool_calls: [{ index: 0, id: `call-${record.id}`, type: 'function', function: tool }] } : { content: text };
        chunk({ choices: [{ index: 0, delta, finish_reason: null }] });
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
        response.end('data: [DONE]\n\n');
      }
      record.finishedAt = new Date().toISOString();
    } catch (error) {
      if (record) record.error = String(error);
      errors.push(String(error.stack || error));
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    }
  }
  const server = http.createServer((request, response) => {
    const requestWork = handleRequest(request, response); pending.add(requestWork);
    requestWork.then(() => pending.delete(requestWork), () => pending.delete(requestWork));
  });
  return {
    tasks, ping, modelId, records, errors, mode, release,
    hits: (lane, letter) => gates.get(`${lane}:${letter}`).hits,
    async start() {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      return `http://127.0.0.1:${server.address().port}/v1`;
    },
    async close() {
      for (const gate of gates.values()) gate.release();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...pending]);
    },
  };
}
module.exports = { createModel };
