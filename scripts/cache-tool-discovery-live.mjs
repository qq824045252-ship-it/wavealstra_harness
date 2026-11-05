import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Type } from 'typebox';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, createToolSearchExtension, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { registerMyBuddyProviders } from '../src/main/agent/providers/index.ts';
import { magpieResponsesModel } from '../src/main/agent/providers/magpie.ts';

const headerKey = randomBytes(32);
const headerDigest = value => createHmac('sha256', headerKey).update(JSON.stringify(value)).digest('hex');

// Opt-in live regression. The provider sees generated data, never an existing task.
const args = process.argv.slice(2);
const live = args.includes('--live');
const rounds = Number(args.find(value => value.startsWith('--rounds='))?.split('=')[1] ?? 3);
assert(Number.isInteger(rounds) && rounds >= 1 && rounds <= 5);
if (!live) {
  console.log(JSON.stringify({ live: false, plannedRounds: rounds, arms: ['legacy-declarations', 'product'], expectedCalls: rounds * 10, maxCalls: rounds * 16, requires: '--live' }));
  process.exit(0);
}
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const configPath = join(homedir(), '.mybuddy/models.json');
const configText = readFileSync(configPath, 'utf8');
const gateway = JSON.parse(configText).providers?.magpie;
const selected = gateway?.models?.find(model => model.id === 'codex/gpt-6.1-terra');
assert(selected && selected.api === 'openai-responses', 'Configured Terra Responses route is required; no fallback');
const out = resolve('out/diagnostics/pi15-cache-fix', 'session-live-' + new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(out, { recursive: true });
const nativeFetch = globalThis.fetch;
const report = {
  startedAt: new Date().toISOString(), live, rounds,
  piVersion: JSON.parse(readFileSync(resolve('node_modules/@earendil-works/pi-ai/package.json'), 'utf8')).version,
  scriptSha: sha(readFileSync(resolve('scripts/cache-tool-discovery-live.mjs'), 'utf8')),
  model: { provider: 'magpie', id: selected.id, api: selected.api, endpointHash: sha(gateway.baseUrl) },
  design: {
    engine: 'Real AgentSession, production provider registration, native tool_search and real fixture file reads',
    comparison: 'Incremental declaration compat is the treatment. Independent sessionIds and random system salts separate client histories, but do not guarantee an upstream cold start. Initial calls are reported separately.',
    order: 'Interleave each turn across arms; rotate arm order by round.',
    retries: 0, maxRequestsPerArm: 8, requestTimeoutMs: 90000,
    retention: 'short', transport: 'sse',
    limitations: 'Not desktop IPC/renderer acceptance. Finite samples cannot guarantee upstream hits. Header evidence is SDK-visible, not gateway-to-upstream wire. Cold requests and explicit misses remain in results.',
  },
  runs: [],
};
const persist = () => writeFileSync(join(out, 'results.json'), JSON.stringify(report, null, 2));
const redact = value => String(value).replaceAll(gateway.apiKey ?? randomUUID(), '[redacted]');
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const terminalKinds = new Set(['response.completed', 'response.incomplete', 'response.failed']);

async function boot(round, arm) {
  const root = join(out, `round-${round}-${arm}`);
  mkdirSync(root, { recursive: true });
  const values = Array.from({ length: 240 }, (_, index) => (index * 17 + round * 31) % 997);
  const fixture = { values, gain: 3, offset: 19 };
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(fixture));
  const run = { round, arm, calls: [], executedTools: [], searches: [], turns: [], passed: false };
  report.runs.push(run);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(root, 'models-cache.json'), allowModelNetwork: false, refreshOnCreate: false });
  registerMyBuddyProviders(runtime);
  const definition = arm === 'product' ? selected : { ...selected, compat: { ...selected.compat, supportsAdditionalTools: false, supportsMidConvoSystemMessages: false } };
  runtime.registerProvider('magpie', { ...gateway, models: [definition] });
  const model = runtime.getModel('magpie', selected.id);
  assert(model?.api === 'openai-responses');
  const effectiveCompat = magpieResponsesModel(model).compat;
  run.effectiveToolCompat = { additional: effectiveCompat?.supportsAdditionalTools, midSystem: effectiveCompat?.supportsMidConvoSystemMessages };
  assert.equal(run.effectiveToolCompat.additional, arm === 'product', 'Configured product route explicitly opts out of incremental tools');
  assert.equal(run.effectiveToolCompat.midSystem, arm === 'product');
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  let session;
  let previousBody;
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (requestModel, context, options) => {
    assert(run.calls.length < 8, 'Per-arm request budget exceeded');
    const call = { number: run.calls.length + 1, startedAt: new Date().toISOString(), http: [] };
    run.calls.push(call);
    const response = streamSimple(requestModel, context, {
      ...options, cacheRetention: 'short', transport: 'sse', maxTokens: 512, timeoutMs: 90000, maxRetries: 0,
      signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000),
      onProviderStreamEvent: async (event, currentModel) => {
        if (isRecord(event) && terminalKinds.has(event.type) && isRecord(event.response)) {
          call.rawTerminal = event.type;
          call.responseHash = typeof event.response.id === 'string' ? sha(event.response.id) : undefined;
          call.rawUsage = structuredClone(event.response.usage ?? null);
        }
        await options?.onProviderStreamEvent?.(event, currentModel);
      },
      fetch: async (input, init) => {
        assert.equal(call.http.length, 0, 'Unexpected transport retry');
        const request = new Request(input, init);
        const wire = await request.clone().text();
        const body = JSON.parse(wire);
        const headers = [...request.headers.entries()].sort(([a], [b]) => a.localeCompare(b));
        const itemHashes = (body.input ?? []).map(sha);
        const currentFields = { ...body }; delete currentFields.input;
        const priorFields = previousBody ? { ...previousBody } : undefined;
        if (priorFields) delete priorFields.input;
        const before = previousBody?.input ?? [];
        const capture = {
          endpointHash: sha(request.url), wireHash: sha(wire), wireBytes: Buffer.byteLength(wire),
          jsonHash: sha(body), headersHash: headerDigest(headers), headerCount: headers.length,
          inputCount: itemHashes.length, itemHashes,
          previousPrefix: previousBody ? before.length <= itemHashes.length && before.every((item, index) => sha(item) === itemHashes[index]) : null,
          changedFields: priorFields ? [...new Set([...Object.keys(priorFields), ...Object.keys(currentFields)])].filter(key => JSON.stringify(priorFields[key]) !== JSON.stringify(currentFields[key])) : [],
          topTools: body.tools?.map(tool => tool.name ?? tool.type) ?? [],
          additionalTools: (body.input ?? []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools?.map(tool => tool.name) ?? []),
          cacheKeyHash: body.prompt_cache_key ? sha(body.prompt_cache_key) : null,
          bodyFile: `round-${round}-${arm}/request-${call.number}.json`,
        };
        writeFileSync(join(root, `request-${call.number}.json`), JSON.stringify(body, null, 2));
        call.http.push(capture);
        previousBody = body;
        persist();
        const result = await nativeFetch(request);
        capture.status = result.status;
        return result;
      },
    });
    void response.result().then(message => {
      call.finishedAt = new Date().toISOString();
      call.stopReason = message.stopReason;
      call.usage = message.usage;
      call.totalInput = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
      call.hitRate = call.totalInput > 0 ? message.usage.cacheRead / call.totalInput : null;
      if (message.errorMessage) call.error = redact(message.errorMessage);
      persist();
    });
    return response;
  };
  const parameters = Type.Object({ dataset: Type.Literal('fixture.json') }, { additionalProperties: false });
  const probe = (name, exposure) => ({
    name, label: name, exposure, parameters,
    description: name === 'fixture_sum' ? 'Read fixture.json and return SUM, the sum of its values.' : 'Read fixture.json and return WEIGHTED, the sum of each value multiplied by gain plus offset once.',
    execute: async (_id, input) => {
      assert.equal(input.dataset, 'fixture.json');
      const data = JSON.parse(readFileSync(join(root, input.dataset), 'utf8'));
      const sum = data.values.reduce((total, value) => total + value, 0);
      const answer = name === 'fixture_sum' ? `SUM=${sum}` : `WEIGHTED=${sum * data.gain + data.offset}`;
      run.executedTools.push(name);
      return { content: [{ type: 'text', text: answer }], details: {} };
    },
  });
  const systemPrompt = [
    `Synthetic verification ${randomUUID()}. Follow the user's tool instructions exactly. Never compute fixture contents yourself. Reply only with the exact label and number returned by the requested tool.`,
    ...Array.from({ length: 480 }, (_, index) => `Reference ${index}: item=${(index * 37 + round) % 1009}; archival test context. This reference does not contain fixture.json and cannot substitute for reading the fixture.`),
  ].join('\n');
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [createToolSearchExtension()], agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: () => systemPrompt, appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, thinkingLevel: 'low',
    resourceLoader: loader, sessionManager: SessionManager.create(root, join(root, 'sessions')), settingsManager: settings,
    noTools: 'builtin', customTools: [probe('fixture_sum', 'direct'), probe('fixture_weighted', 'deferred')],
  }));
  await session.bindExtensions({});
  session.subscribe(event => {
    if (event.type === 'tool_execution_end' && event.toolName === 'tool_search') {
      run.searches.push({ resultHash: sha(event.result), foundWeighted: JSON.stringify(event.result).includes('fixture_weighted'), isError: event.isError });
    }
  });
  session.setActiveToolsByName(['fixture_sum', 'tool_search']);
  assert(!session.getActiveToolNames().includes('fixture_weighted'));
  run.sessionHash = sha(session.sessionId);
  return { run, session, sum: values.reduce((total, value) => total + value, 0), fixture };
}

try {
  for (let round = 1; round <= rounds; round++) {
    const arms = round % 2 ? ['legacy-declarations', 'product'] : ['product', 'legacy-declarations'];
    const states = [];
    try {
      for (const arm of arms) states.push(await boot(round, arm));
      for (let turn = 1; turn <= 2; turn++) {
        for (const state of states) {
          if (state.run.error) continue;
          try {
            const firstCall = state.run.calls.length;
            await state.session.prompt(turn === 1
              ? 'Call fixture_sum once with dataset="fixture.json". Reply only with its exact SUM=number result.'
              : 'Use tool_search to find fixture_weighted. Call fixture_weighted once with dataset="fixture.json". Reply only with its exact WEIGHTED=number result.');
            const text = state.session.messages.filter(message => message.role === 'assistant').at(-1)?.content.filter(part => part.type === 'text').map(part => part.text).join('').trim();
            const expected = turn === 1 ? `SUM=${state.sum}` : `WEIGHTED=${state.sum * state.fixture.gain + state.fixture.offset}`;
            assert.equal(text, expected);
            assert.deepEqual(state.run.executedTools, turn === 1 ? ['fixture_sum'] : ['fixture_sum', 'fixture_weighted']);
            for (const call of state.run.calls.slice(firstCall)) {
              assert.equal(call.http.length, 1);
              assert.equal(call.http[0].status, 200);
              assert.equal(call.rawTerminal, 'response.completed');
              assert.equal(typeof call.rawUsage?.input_tokens_details?.cached_tokens, 'number');
              assert.equal(call.rawUsage.input_tokens_details.cached_tokens, call.usage.cacheRead);
              assert.equal(call.rawUsage.input_tokens, call.totalInput);
              assert(!call.error, call.error);
            }
            state.run.turns.push({ turn, expected, actual: text, calls: state.run.calls.length - firstCall, passed: true });
            if (turn === 2) {
              assert(state.session.getActiveToolNames().includes('fixture_weighted'));
              assert(state.run.searches.some(search => search.foundWeighted && !search.isError), 'Native tool_search must discover the deferred tool');
              const wires = state.run.calls.flatMap(call => call.http);
              if (state.run.arm === 'product') {
                assert(wires.every(wire => wire.topTools.length === 0));
                assert(wires[0].additionalTools.includes('fixture_sum'));
                assert(!wires[0].additionalTools.includes('fixture_weighted'));
                assert(wires.at(-1).additionalTools.includes('fixture_weighted'));
              } else {
                assert(wires[0].topTools.includes('fixture_sum'));
                assert(!wires[0].topTools.includes('fixture_weighted'));
                assert(wires.at(-1).topTools.includes('fixture_weighted'));
              }
              state.run.protocolPassed = true;
            }
            console.log(JSON.stringify({ round, arm: state.run.arm, turn, cached: state.run.calls.slice(firstCall).map(call => call.usage.cacheRead) }));
          } catch (error) { state.run.error = redact(error.stack ?? error); }
          persist();
        }
      }
      for (const state of states) {
        state.run.functionalPassed = !state.run.error && state.run.turns.length === 2;
        state.run.passed = state.run.functionalPassed && state.run.protocolPassed === true;
        state.run.initialCall = state.run.calls[0]?.rawUsage ?? null;
        state.run.continuationZeros = state.run.calls.slice(1).filter(call => call.rawUsage?.input_tokens_details?.cached_tokens === 0).map(call => call.number);
        state.run.stableZeros = state.run.calls.slice(1).filter((call, index) => {
          const wire = call.http[0], prior = state.run.calls[index].http[0];
          return call.rawUsage?.input_tokens_details?.cached_tokens === 0 && wire?.previousPrefix === true
            && wire.changedFields.length === 0 && wire.headersHash === prior?.headersHash && wire.endpointHash === prior?.endpointHash;
        }).map(call => call.number);
        state.run.cacheOutcome = state.run.continuationZeros.length ? 'zero-observed' : 'no-continuation-zero-in-sample';
      }
    } finally { for (const state of states) state.session.dispose(); persist(); }
  }
} finally {
  report.finishedAt = new Date().toISOString();
  report.configUnchanged = readFileSync(configPath, 'utf8') === configText;
  report.networkRequests = report.runs.flatMap(run => run.calls).reduce((total, call) => total + call.http.length, 0);
  report.passed = report.runs.length === rounds * 2 && report.runs.every(run => run.passed);
  persist();
  console.log(JSON.stringify({ output: join(out, 'results.json'), passed: report.passed, networkRequests: report.networkRequests }));
}
if (!report.passed) process.exitCode = 1;
