/** Real Durable/SQLite lifecycle and final provider messages; no network/model/GUI. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import type { AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { buildBaseOptions } from '@earendil-works/pi-ai/api/simple-options';
import { DurableSubagentIdentity } from '../src/main/agent/durable/DurableSubagents';
import { estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/compat';
import { DurableBotRuntime, type DurableBotOptions } from '../src/main/agent/durable/DurableBotRuntime';
import type { DurableContextManager } from '../src/main/agent/durable/context/DurableContextManager';

const windows = [128_000, 272_000, 1_000_000];
const text = (messages: readonly Message[]) => JSON.stringify(messages);
const tokens = (messages: readonly Message[]) => messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
function answer(content: string, model = 'w128000', input = 0, timestamp = Date.now()): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'text', text: content }], timestamp, api: 'openai-completions', provider: 'fixture', model, stopReason: 'stop',
    usage: { input, output: 8, cacheRead: 0, cacheWrite: 0, totalTokens: input + 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function history(size: number): Message[] {
  const count = Math.max(12, Math.ceil(size / 2000));
  return Array.from({ length: count + count % 2 }, (_, i) => {
    const value = `WINDOW_ORIGINAL_${i}: /archive/${i}.txt ERROR_WINDOW\n` + 'Archive observation and original measurement. '.repeat(Math.ceil(size * 3.5 / count / 46));
    return i % 2 ? answer(value, 'w1000000', 0, i + 1) : { role: 'user', content: value, timestamp: i + 1 };
  });
}
// Synthetic metadata only; never overrides a live provider model.
function fixture(maxTokens = 4096) {
  const catalog: Model<'openai-completions'>[] = windows.map(contextWindow => ({ id: `w${contextWindow}`, provider: 'fixture', api: 'openai-completions', name: 'Window fixture', baseUrl: 'http://invalid.invalid', reasoning: false, input: ['text'], contextWindow, maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  const requests: { model: string; window: number; outputBudget: number; messages: readonly Message[] }[] = [];
  let summaries = 0;
  const models = { getModel: (_provider: string, id: string) => catalog.find(model => model.id === id), getAuth: async () => undefined,
    completeSimple: async () => { summaries++; return answer('Previous archive observations preserve paths, measurements and errors. Original entries remain available for exact retrieval.'); },
    streamSimple: (model: typeof catalog[number], input: { messages: readonly Message[] }) => {
      const effective = buildBaseOptions(model, normalizeContext({ messages: [...input.messages] }), {}, 'offline-fixture').maxTokens!;
      assert(effective > 0 && effective <= model.maxTokens);
      assert(tokens(input.messages) + effective + 4096 <= model.contextWindow, 'final provider messages plus output and safety margin must fit');
      requests.push({ model: model.id, window: model.contextWindow, outputBudget: effective, messages: structuredClone(input.messages) });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: 'done', reason: 'stop', message: answer('Acknowledged.', model.id, tokens(input.messages)) }); stream.end(); });
      return stream;
    } } as unknown as DurableBotOptions['models'];
  return { models, requests, summaries: () => summaries };
}
const manager = (runtime: DurableBotRuntime) => (runtime as unknown as { contextManager: DurableContextManager }).contextManager;
async function turn(runtime: DurableBotRuntime, key: string) {
  const result = await (await runtime.submit('Continue the current archive task.', key)).wait(ctx);
  assert.equal(result.status, 'done', JSON.stringify(result));
  await runtime.conversation.waitForIdle(ctx); await manager(runtime).flush(ctx);
  assert.notEqual(runtime.contextManagementStatus()?.phase, 'failed');
}
const root = await mkdtemp(join(tmpdir(), 'durable-window-matrix-'));
try {
  for (const window of windows) for (const absoluteTokens of [30_000, null]) {
    const directory = join(root, `${window}-${absoluteTokens}`); await mkdir(directory);
    const source = fixture(); const policy = { ratio: 0.2, absoluteTokens };
    const threshold = Math.min(window * policy.ratio, absoluteTokens ?? Infinity);
    const options: DurableBotOptions = { directory, cwd: directory, models: source.models, model: { provider: 'fixture', modelId: `w${window}` }, toolMode: 'native', instructions: () => '', onSnapshot: () => {},
      initialHistory: { messages: history(threshold * 1.6), context: [] }, contextManagement: { policy: () => policy, engine: () => 'billion-context', toolEstimateTokens: () => 0 } };
    let runtime = await DurableBotRuntime.open(options);
    try {
      await turn(runtime, 'first');
      const status = runtime.contextManagementStatus()!; const request = source.requests.at(-1)!;
      assert.equal(status.contextWindow, window); assert.equal(status.triggerTokens, threshold);
      assert.equal(request.model, `w${window}`); assert.equal((await runtime.conversation.agent(ctx)).model?.modelId, request.model);
      assert(source.summaries() > 0); assert(tokens(request.messages) < window - 4096);
      assert(!text(request.messages).includes('WINDOW_ORIGINAL_0:'), 'folded original must not remain in outgoing messages');
      const calls = source.summaries(); await runtime.close();
      runtime = await DurableBotRuntime.open({ ...options, initialHistory: undefined });
      await turn(runtime, 'reopened');
      assert.equal(runtime.contextManagementStatus()!.contextWindow, window);
      assert.equal(runtime.contextManagementStatus()!.triggerTokens, threshold);
      assert.equal(source.requests.at(-1)!.model, `w${window}`);
      assert.equal(source.summaries(), calls, 'cold reopen must reuse summaries rather than recompute');
      console.log(`PASS Durable window=${window} absolute=${absoluteTokens} threshold=${threshold}: outbound, state, cold reopen`);
    } finally { await runtime.close(); }
  }
  const directory = join(root, 'hot-shrink'); await mkdir(directory); const source = fixture();
  const policy = { ratio: 0.8, absoluteTokens: null as number | null };
  const options: DurableBotOptions = { directory, cwd: directory, models: source.models, model: { provider: 'fixture', modelId: 'w1000000' }, toolMode: 'native', instructions: () => '', onSnapshot: () => {},
    initialHistory: { messages: history(180_000), context: [] }, contextManagement: { policy: () => policy, engine: () => 'billion-context', toolEstimateTokens: () => 0 } };
  let runtime = await DurableBotRuntime.open(options);
  try {
    await turn(runtime, 'large'); const large = source.requests.at(-1)!;
    assert(tokens(large.messages) > 128_000, 'fixture must prove old view cannot fit smaller window');
    for (const window of [272_000, 128_000]) {
      await runtime.configure({ provider: 'fixture', modelId: `w${window}` }, 'native'); await turn(runtime, `switch-${window}`);
      const request = source.requests.at(-1)!; const status = runtime.contextManagementStatus()!;
      assert.equal(request.model, `w${window}`); assert.equal(status.contextWindow, window); assert.equal(status.triggerTokens, window * 0.8);
      assert(tokens(request.messages) + 4096 < window, 'no stale oversized provider input after model shrink');
    }
    policy.ratio = 0.2; policy.absoluteTokens = 20_000; await turn(runtime, 'hot-policy');
    assert.equal(runtime.contextManagementStatus()!.triggerTokens, 20_000);
    await runtime.close(); runtime = await DurableBotRuntime.open({ ...options, initialHistory: undefined });
    await turn(runtime, 'reopen-small');
    assert.equal(source.requests.at(-1)!.model, 'w128000', 'persisted configured model wins over opening default');
    assert.equal(runtime.contextManagementStatus()!.contextWindow, 128_000); assert.equal(runtime.contextManagementStatus()!.triggerTokens, 20_000);
    console.log('PASS 1M→272K→128K same-runtime model switch, small outbound, hot policy, cold persisted model');
  } finally { await runtime.close(); }
  // Large declared output is fitted by the actual SDK, not hardcoded to 4096.
  const largeOutputDir = join(root, 'native-large-output'); await mkdir(largeOutputDir);
  const largeOutput = fixture(64_000);
  const largeOutputRuntime = await DurableBotRuntime.open({ ...options, directory: largeOutputDir, cwd: largeOutputDir,
    models: largeOutput.models, model: { provider: 'fixture', modelId: 'w128000' },
    initialHistory: { messages: [{ role: 'user', content: 'Window boundary observation. '.repeat(11_000), timestamp: 1 }], context: [] },
    contextManagement: { policy: () => ({ ratio: 0.99, absoluteTokens: null }), engine: () => 'native', toolEstimateTokens: () => 0 } });
  try {
    await turn(largeOutputRuntime, 'large-output-native');
    const request = largeOutput.requests.at(-1)!;
    assert(tokens(request.messages) > 64_000, 'input must require actual SDK output clipping');
    assert(request.outputBudget > 0 && request.outputBudget < 64_000, 'declared 64K output must shrink to remaining window');
    assert(tokens(request.messages) + request.outputBudget + 4096 <= 128_000);
    assert.equal(largeOutput.summaries(), 0, 'below native trigger: output fitting must not fabricate a compaction');
    console.log(`PASS native128K/declared64K output: input=${tokens(request.messages)} effectiveOutput=${request.outputBudget}, no fixed4096 cap`);
  } finally { await largeOutputRuntime.close(); }
  const childDir = join(root, 'different-child'); await mkdir(childDir); const childSource = fixture();
  const parent = await DurableBotRuntime.open({ ...options, directory: childDir, cwd: childDir, models: childSource.models, initialHistory: undefined });
  try {
    const parentAgent = await parent.conversation.agent(ctx);
    const child = await parent.harness.createConversation({ ownership: { kind: 'ownerless' }, init: async (tx, id) => {
      const identity = await tx.doc(DurableSubagentIdentity, id); identity.value = { role: 'window-child' } as never;
      for (const message of history(180_000)) await tx.appendEntry(id, { kind: message.role === 'user' ? 'pi.user' : 'pi.assistant', model: [message] });
    } }, ctx);
    await child.configure({ model: { provider: 'fixture', modelId: 'w128000' }, tools: [...parentAgent.callable] }, ctx);
    const submission = await child.submit({ type: 'input', content: 'Continue the child archive task.' }, ctx);
    assert.equal((await submission.wait(ctx)).status, 'done');
    const request = childSource.requests.at(-1)!; assert.equal(request.model, 'w128000'); assert(tokens(request.messages) + 8192 < 128_000);
    assert(childSource.summaries() > 0);
    assert.equal((await parent.conversation.agent(ctx)).model?.modelId, 'w1000000');
    console.log('PASS child128K under parent1M uses its own projected window/model without changing parent');
  } finally { await parent.close(); }
} finally { await rm(root, { recursive: true, force: true }); }
