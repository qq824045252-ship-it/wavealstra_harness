// Real SDK queue/preflight/abort semantics, isolated provider and session.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';

const root = mkdtempSync(join(tmpdir(), 'mybuddy-stop-regenerate-'));
const model: any = { id: 'fixture', provider: 'fixture', api: 'openai-completions', name: 'fixture', baseUrl: 'http://invalid.invalid', reasoning: false, input: ['text'], contextWindow: 100000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
let started!: () => void;
let providerStarted = new Promise<void>(resolve => { started = resolve; });
let hold = true;
let calls = 0;
const runtime: any = {
  hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: 'fixture' } }), getModel: () => model,
  streamSimple: (_model: unknown, _context: unknown, options: any) => {
    calls++;
    const stream = createAssistantMessageEventStream();
    const finish = (aborted: boolean) => {
      const response: any = { role: 'assistant', content: aborted ? [] : [{ type: 'text', text: 'Recovered' }], api: model.api, provider: model.provider, model: model.id, stopReason: aborted ? 'aborted' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push(aborted ? { type: 'error', reason: 'aborted', error: response } : { type: 'done', reason: 'stop', message: response });
      stream.end();
    };
    if (hold) options.signal.addEventListener('abort', () => finish(true), { once: true });
    else finish(false);
    started();
    return stream;
  },
};
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true });
await loader.reload();
const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings, sessionManager: SessionManager.create(root, root), resourceLoader: loader, noTools: 'builtin' });
await session.bindExtensions({ mode: 'rpc' });
try {
  for (const behavior of ['steer', 'followUp'] as const) {
    hold = true;
    providerStarted = new Promise<void>(resolve => { started = resolve; });
    const running = session.prompt(`running ${behavior}`);
    await providerStarted;
    let accepted = false;
    const text = `queued ${behavior}`;
    await session.prompt(text, { streamingBehavior: behavior, preflightResult: disposition => { accepted = disposition === "queued"; } });
    assert(accepted, 'SDK preflight succeeds before queued input is consumed');
    assert(!session.getUserMessagesForForking().some(user => user.text === text));
    session.clearQueue();
    await session.abort();
    await running;
    assert(!session.isStreaming);
    assert(!session.getUserMessagesForForking().some(user => user.text === text), 'stopping leaves no session user entry to regenerate by index');
    hold = false;
    await session.prompt(text);
    assert.equal(session.getLastAssistantText(), 'Recovered');
    assert.equal(session.getUserMessagesForForking().filter(user => user.text === text).length, 1);
  }
  assert.equal(calls, 4);
  console.log('PASS real SDK: steer/followUp preflight acceptance -> stop -> original request replay (4 provider calls)');
} finally { session.dispose(); }
