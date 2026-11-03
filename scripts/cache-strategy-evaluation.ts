/** Assessment only. No product behavior changes. Offline by default; opt in to live tasks.
 * Captures the ACTUAL Responses payload in onPayload, never saves bodies or credentials.
 * Live tasks read a CSV, write a Node program, execute it and verify independent results.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { normalizeContext, createAssistantMessageEventStream, type Context, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { stream as responsesStream } from '../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js';
import { EphemeralContextProjection } from '../src/main/agent/EphemeralContextProjection';
import { registerMyBuddyProviders } from '../src/main/agent/providers';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { MemoryService } from '../src/main/memory/MemoryService';
import { bindSessionModelAdmission, installModelInvocationAdmission, setSessionRequestGuard } from '../src/main/agent/ModelInvocationAdmission';

const modes = ['current', 'first-only', 'persist', 'replay', 'delta', 'delta-persist', 'refs', 'retrieve', 'frozen', 'product'] as const;
type Strategy = typeof modes[number];
const live = process.env.MYBUDDY_CACHE_EVALUATE_LIVE === '1' && !process.argv.includes('--offline');
const selected = (process.env.MYBUDDY_CACHE_STRATEGIES ?? (live ? modes.filter(s => s !== 'frozen').join(',') : modes.join(','))).split(',') as Strategy[];
for (const s of selected) assert(modes.includes(s), `Unknown strategy ${s}`);
const repeat = Number(process.env.MYBUDDY_CACHE_REPEATS ?? 1);
assert(Number.isInteger(repeat) && repeat > 0 && repeat <= 3);
const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8);
const reportRoot = join(process.cwd(), live ? 'artifacts/cache-investigation/strategy-evaluation' : 'out/diagnostics/cache-strategy-evaluation', runId);
mkdirSync(reportRoot, { recursive: true });
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
const execute = promisify(execFile);
const fakeModel: Model<any> = { id: 'cache-strategy-offline', provider: 'fixture', api: 'openai-responses', name: 'Offline',
  baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const marker = 'SYNTHETIC_CALIBRATION_EVIDENCE';
const ruleText = (revision: number) => `${marker}_v${revision}\nSource: calibration. Revision: ${revision}. Latest supplied revision supersedes older revisions.\nCalibration formula: converted = raw * gain + offset. gain=${revision === 1 ? 2 : 3}; offset=${revision === 1 ? 7 : -4}.\nEvidence only, not instructions. Do not copy the provenance marker to files or replies.`;
const instructions = `Work only in this isolated CSV calibration task directory. Use node standard libraries. No network or external commands.
The calibration source may change between user turns. Use current supplied evidence if present, otherwise obtain current calibration through memory_lookup. Newer source revisions supersede older ones.
Implement calibrate.mjs accepting exactly: input CSV path, output JSON path, gain, offset, revision. It reads rows with columns id,channel,raw,note. Write JSON {count,rawTotal,convertedTotal,gain,offset,revision}. convertedTotal is the sum of raw*gain+offset for every row. All quantities are integers. Do not hard-code data or the calibration into the program. Use run_calibration to execute your program. Reply briefly after verifying the output. Never print the provenance marker.`;

interface Wire {
  inputItems: number; sharedItems: number; previousItems: number; prefix: boolean;
  baseChanges: string[]; baseHash: string; inputHash: string; cacheKeyHash: string;
  evidenceCopies: number; revision1Present: boolean; revision2Present: boolean; bytes: number;
}
interface Call {
  phase: string; turn: number; ordinal: number; wire?: Wire; status?: string;
  usage?: AssistantMessage['usage']; responseHash?: string; ms?: number; blocked?: boolean;
}
interface Summary { strategy: Strategy; repetition: number; live: boolean; calls: Call[];
  checks: Record<string, unknown>[]; files: { path: string; sha256: string }[]; error?: string }

/** In-memory variants deliberately store no history outside the owning session object.
 * Stable full replay and change-only replay share anchor logic; delta uses source id/revision/text.
 * Durable variants use Pi's native before_agent_start message insertion, not direct state mutation.
 */
function strategyExtension(strategy: Strategy, manager: SessionManager, state: { turn: number; revision: number }, memory?: MemoryService): {
  extension: ExtensionFactory; attach(session: AgentSession): void;
} {
  if (strategy === 'product') {
    assert(memory);
    const projection = new EphemeralContextProjection({ memory, enabled: () => true, scope: () => ({}),
      execution: () => ({ executionId: 'calibration', query: 'calibration' }), supplementalEvidence: () => [],
      registerRequestGuard: setSessionRequestGuard, log: () => {} });
    return { extension: projection.extension, attach: session => { projection.attach(session); bindSessionModelAdmission(session); } };
  }
  if (strategy === 'current' || strategy === 'first-only') {
    // Frozen historical control: 'current' means the 0.1.76 request-only policy.
    // It must not silently track the new implementation and invalidate old comparisons.
    let turnId = '', text = '';
    return { attach() {}, extension: pi => {
      pi.on('context', event => {
        const user = [...manager.getBranch()].reverse().find(e => e.type === 'message' && e.message.role === 'user');
        if (!user || user.type !== 'message' || user.message.role !== 'user') return;
        if (turnId !== user.id) {
          turnId = user.id;
          text = strategy === 'first-only' && state.turn !== 1 ? '' : ruleText(state.revision);
        }
        if (!text) return;
        const messages = [...event.messages];
        const userMessage = user.message;
        const index = messages.findIndex(m => m.role === 'user' && m.timestamp === userMessage.timestamp && JSON.stringify(m.content) === JSON.stringify(userMessage.content));
        messages.splice(index + 1, 0, { role: 'custom', customType: 'assessment.legacy-capsule', content: text, display: false, timestamp: user.message.timestamp });
        return { messages };
      });
      pi.on('cache_warming_decision', () => ({ action: 'stop' }));
    } };
  }
  let emitted = '';
  const records: { key: string; text: string; timestamp: number; content: unknown }[] = [];
  if (strategy === 'refs') {
    for (const entry of manager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== 'assessment.evidence-ref') continue;
      const ref = entry.data as { anchor: string; revision: number; textHash: string; renderer: number };
      // Prototype source store can retrieve immutable versions. Production must verify scope,
      // revocation, historical availability and renderer identity BEFORE hydrating a reference.
      assert.equal(ref.renderer, 1, 'Unknown rendering version: rebuild context, never silently change historical bytes');
      const anchor = manager.getEntry(ref.anchor);
      assert(anchor?.type === 'message' && anchor.message.role === 'user');
      assert([1, 2].includes(ref.revision), 'Historical source version unavailable: rebuild context');
      const text = ruleText(ref.revision);
      assert.equal(sha(text), ref.textHash, 'Historical source/render mismatch: fail closed');
      records.push({ key: ref.anchor, text, content: anchor.message.content, timestamp: anchor.message.timestamp });
      emitted = text;
    }
  }
  const extension: ExtensionFactory = pi => {
    pi.on('cache_warming_decision', () => ({ action: 'stop' }));
    pi.on('session_compact', () => { emitted = ''; records.length = 0; });
    if (strategy === 'refs') pi.on('before_agent_start', () => ({ message: {
      customType: 'assessment.source-version', display: false,
      content: `Current source manifest: calibration revision ${state.revision}. Use the matching evidence already supplied; other revisions are historical.`,
    } }));
    if (strategy === 'persist' || strategy === 'delta-persist') {
      // Recover the last persisted evidence on reopen so unchanged revisions don't duplicate.
      for (const entry of manager.getBranch()) {
        if (entry.type === 'custom_message' && entry.customType === 'assessment.evidence') emitted = String(entry.content);
      }
      pi.on('before_agent_start', () => {
        const text = ruleText(state.revision);
        if (strategy === 'delta-persist' && emitted === text) return;
        emitted = text;
        return { message: { customType: 'assessment.evidence', content: text, display: false } };
      });
    } else if (strategy !== 'retrieve') {
      pi.on('context', event => {
        const latest = [...manager.getBranch()].reverse().find(e => e.type === 'message' && e.message.role === 'user');
        if (!latest || latest.type !== 'message' || latest.message.role !== 'user') return;
        const text = ruleText(state.revision);
        if (!records.some(r => r.key === latest.id) && (strategy === 'replay' ||
          ((strategy === 'delta' || strategy === 'refs') && text !== emitted) || (strategy === 'frozen' && records.length === 0))) {
          records.push({ key: latest.id, text, content: latest.message.content, timestamp: latest.message.timestamp });
          if (strategy === 'refs') manager.appendCustomEntry('assessment.evidence-ref', {
            anchor: latest.id, source: 'calibration', revision: state.revision, textHash: sha(text), renderer: 1,
          });
          emitted = text;
        }
        const messages = [...event.messages];
        for (const record of records) {
          const index = messages.findIndex(m => m.role === 'user' && m.timestamp === record.timestamp &&
            JSON.stringify(m.content) === JSON.stringify(record.content));
          // Compaction already changes the prefix: release records whose anchors were compacted.
          if (index < 0) continue;
          messages.splice(index + 1, 0, { role: 'custom', customType: 'assessment.evidence', display: false,
            content: record.text, timestamp: record.timestamp });
        }
        return { messages };
      });
    }
  };
  return { extension, attach() {} };
}

async function run(strategy: Strategy, repetition: number): Promise<Summary> {
  const root = mkdtempSync(join(tmpdir(), 'mybuddy-cache-strategy-'));
  const task = join(root, 'task'); mkdirSync(task);
  const sessions = join(root, 'sessions'); mkdirSync(sessions);
  const state = { turn: 1, revision: 1 };
  const productDb = strategy === 'product' ? new AppDatabase(join(root, 'memory.db')) : undefined;
  const productMemory = productDb ? new MemoryService(productDb, { semantic: false }) : undefined;
  const productSource = productMemory?.create({ kind: 'constraint', title: 'calibration', content: ruleText(1), scopeType: 'global', sourceType: 'user', explicit: true });
  let phase = 'task';
  const result: Summary = { strategy, repetition, live, calls: [], checks: [], files: [] };
  let previous: { input: string[]; base: Record<string, string> } | undefined;
  let session: AgentSession | undefined;
  let model = fakeModel;
  let manager: SessionManager;
  let summaryCalls = 0, offlineCallInTurn = 0, nativeNetworkAttempts = 0, denyRevoked = false;
  let memoryCalls = 0;
  const runtime = live ? await ModelRuntime.create({ modelsPath: join(root, 'models.json'), authPath: join(root, 'auth.json'),
    allowModelNetwork: false, refreshOnCreate: false }) : {} as ModelRuntime;
  if (live) {
    const config = JSON.parse(readFileSync(join(homedir(), '.mybuddy/models.json'), 'utf8')).providers.magpie;
    const wanted = process.env.MYBUDDY_CACHE_LIVE_MODEL ?? 'codex/gpt-6.1-terra';
    const configured = config.models.find((m: { id: string }) => m.id === wanted);
    assert(configured, 'Configured model required; no automatic fallback');
    registerMyBuddyProviders(runtime);
    runtime.registerProvider('magpie', { ...config, models: [configured] });
    model = runtime.getModel('magpie', wanted)!;
  } else {
    Object.assign(runtime, { hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: 'offline' } }), getModel: () => model });
  }
  const original = live ? runtime.streamSimple.bind(runtime) : undefined;
  const response = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({
    role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  function capture(payload: any, call: Call) {
    const { input, ...base } = payload;
    assert(Array.isArray(input));
    const hashes = input.map(sha);
    const baseHashes: Record<string, string> = Object.fromEntries(Object.entries(base).map(([k,v]) => [k,sha(v)]));
    let shared = 0;
    while (previous && shared < previous.input.length && previous.input[shared] === hashes[shared]) shared++;
    const body = JSON.stringify(input);
    call.wire = { inputItems: input.length, sharedItems: shared, previousItems: previous?.input.length ?? 0,
      prefix: !previous || shared === previous.input.length,
      baseChanges: previous ? [...new Set([...Object.keys(previous.base), ...Object.keys(baseHashes)])]
        .filter(k => previous!.base[k] !== baseHashes[k]) : [],
      baseHash: sha(base), inputHash: sha(input), cacheKeyHash: sha(base.prompt_cache_key),
      evidenceCopies: body.split(marker).length - 1, revision1Present: body.includes(`${marker}_v1`),
      revision2Present: body.includes(`${marker}_v2`), bytes: Buffer.byteLength(JSON.stringify(payload)) };
    if (denyRevoked) { call.blocked = true; throw new Error('ASSESSMENT_REVOKED_SOURCE: abort before network; historical derivatives require context rebuild'); }
    previous = { input: hashes, base: baseHashes };
  }
  runtime.streamSimple = (_model, context, options) => {
    const output = createAssistantMessageEventStream();
    const call: Call = { phase, turn: state.turn, ordinal: result.calls.length + 1 };
    result.calls.push(call);
    const start = Date.now();
    void (async () => {
      try {
        assert(result.calls.length <= 45, 'Per-scenario request budget exceeded');
        if (live) {
          const stream = original!(_model, context, { ...options, maxTokens: 4096,
            onPayload: async (body, selectedModel) => {
              const replacement = await options?.onPayload?.(body, selectedModel);
              capture(replacement ?? body, call);
              // observation only: do not return a replacement or edit request parameters
              return replacement;
            } });
          for await (const event of stream) {
            if (event.type === 'done' || event.type === 'error') {
              const message = event.type === 'done' ? event.message : event.error;
              call.status = message.stopReason; call.usage = message.usage; call.responseHash = sha(message.responseId ?? '');
            }
            output.push(event);
          }
        } else {
          let caught = false;
          const serialized = await responsesStream(model, normalizeContext(context), { apiKey: 'offline', sessionId: manager.getSessionId(),
            onPayload: async payload => { await options?.onPayload?.(payload, model); capture(payload, call); caught = true; throw new Error('OFFLINE_CAPTURE'); },
            fetch: async () => { nativeNetworkAttempts++; throw new Error('NETWORK_FORBIDDEN'); } }).result();
          if (!caught) throw new Error(call.blocked ? 'ASSESSMENT_REVOKED_SOURCE' : `Missing offline payload: ${serialized.errorMessage}`);
          let message: AssistantMessage;
          if (phase === 'compact') { summaryCalls++; message = response([{ type: 'text', text: `Earlier calibration evidence: ${marker}_v1. A summary can retain derived private facts.` }], 'stop'); }
          else if (offlineCallInTurn++ === 0) {
            message = response([{ type: 'toolCall', id: `read-${state.turn}-${result.calls.length}`,
              name: strategy === 'retrieve' ? 'memory_lookup' : 'read', arguments: strategy === 'retrieve' ? {} : { path: 'readings.csv' } }], 'toolUse');
          } else message = response([{ type: 'text', text: 'Finished offline structural step.' }], 'stop');
          call.status = message.stopReason;
          output.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        }
      } catch (error) {
        call.status = 'error';
        if (!live && !denyRevoked) console.error(String(error));
        output.push({ type: 'error', reason: 'error', error: { ...response([], 'error'), errorMessage: String(error) } });
      } finally { call.ms = Date.now() - start; output.end(); }
    })();
    return output;
  };
  if (strategy === 'product') {
    runtime.stream ??= runtime.streamSimple as typeof runtime.stream;
    installModelInvocationAdmission(runtime, () => session!.settingsManager);
  }
  const boot = async (file?: string) => {
    manager = file ? SessionManager.open(file) : SessionManager.create(task, sessions);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 }, retry: { enabled: false } });
    const strategyHooks = strategyExtension(strategy, manager, state, productMemory);
    const loader = new DefaultResourceLoader({ cwd: task, agentDir: root, settingsManager: settings, noContextFiles: true,
      noSkills: true, noExtensions: true, noThemes: true, noPromptTemplates: true,
      systemPrompt: instructions, extensionFactories: [strategyHooks.extension,
        pi => { pi.on('cache_warming_decision', () => ({ action: 'stop' })); }],
    });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const created = await createAgentSession({ cwd: task, agentDir: root, model, modelRuntime: runtime,
      sessionManager: manager, settingsManager: settings, resourceLoader: loader, thinkingLevel: live ? 'low' : 'off',
      tools: ['read', 'write', 'memory_lookup', 'run_calibration'],
      customTools: [{ name: 'memory_lookup', label: 'Read current calibration', description: 'Read the current revision of the calibration source.', parameters: Type.Object({}),
        execute: async () => { memoryCalls++; return { content: [{ type: 'text', text: ruleText(state.revision) }], details: { revision: state.revision } }; } },
      { name: 'run_calibration', label: 'Run local calibration program', description: 'Run calibrate.mjs on readings.csv. Writes the selected output JSON. Returns actual Node stdout and exit status.',
        parameters: Type.Object({ output: Type.String({ pattern: '^result-[1-4]\\.json$' }), gain: Type.Integer(), offset: Type.Integer(), revision: Type.Integer() }),
        execute: async (_id, args) => {
          const params = args as { output: string; gain: number; offset: number; revision: number };
          assert(/^result-[1-4]\.json$/.test(params.output));
          const execution = await execute(process.execPath, [join(task, 'calibrate.mjs'), 'readings.csv', params.output, String(params.gain), String(params.offset), String(params.revision)],
            { cwd: task, timeout: 10000, maxBuffer: 128000 });
          return { content: [{ type: 'text', text: JSON.stringify({ exitCode: 0, stdout: execution.stdout, stderr: execution.stderr }) }], details: {} };
        } }],
    });
    session = created.session; strategyHooks.attach(session); await session.bindExtensions({ mode: 'rpc' });
    return manager!.getSessionFile()!;
  };
  function seedData(turn: number) {
    const rows = Array.from({ length: 160 + turn }, (_, i) => ({ id: `S${i + 1}`, channel: `C${i % 4}`,
      raw: ((i * 37 + turn * 19) % 900) - 100, note: `batch-${turn}-observation-${createHash('sha256').update(`row-${turn}-${i}`).digest('hex').slice(0,24)}` }));
    writeFileSync(join(task, 'readings.csv'), 'id,channel,raw,note\n' + rows.map(r => `${r.id},${r.channel},${r.raw},${r.note}`).join('\n') + '\n');
    const gain = state.revision === 1 ? 2 : 3, offset = state.revision === 1 ? 7 : -4;
    return { count: rows.length, rawTotal: rows.reduce((s,r) => s + r.raw, 0), convertedTotal: rows.reduce((s,r) => s + r.raw * gain + offset, 0), gain, offset, revision: state.revision };
  }
  let file = '';
  try {
    file = await boot();
    for (state.turn = 1; state.turn <= 4; state.turn++) {
      state.revision = state.turn >= 3 ? 2 : 1;
      if (state.turn === 3 && productMemory && productSource) productMemory.update({ id: productSource.id, content: ruleText(2) });
      if (state.turn === 4) { session!.dispose(); file = await boot(file); }
      const expected = seedData(state.turn);
      offlineCallInTurn = 0;
      const start = result.calls.length, lookupsBefore = memoryCalls;
      const timeout = setTimeout(() => void session!.abort(), 150000);
      try {
        await session!.prompt(`Process batch ${state.turn} from readings.csv using the current calibration. ${state.turn === 1 ? 'Read the CSV, create calibrate.mjs with the required interface, then run it.' : 'The CSV has been replaced with a new batch. Reuse your program, read the new CSV and run it.'} Write result-${state.turn}.json. Verify the actual file before responding. Calibration values come only from evidence or memory_lookup.`);
      } finally { clearTimeout(timeout); }
      const calls = result.calls.slice(start);
      assert(calls.length >= 2, 'Must actually use tools');
      assert(calls.every(c => c.status !== 'error' && c.status !== 'aborted'), 'Model or execution failed');
      const wire = calls[0].wire!;
      if (live) {
        const outputPath = join(task, `result-${state.turn}.json`);
        const actual = existsSync(outputPath) ? JSON.parse(readFileSync(outputPath, 'utf8')) : null;
        const correct = actual && Object.entries(expected).every(([key, value]) => actual[key] === value);
        if (strategy === 'product') assert(correct, 'Production projection task must produce the independently verified result');
        result.checks.push({ turn: state.turn, correct: Boolean(correct), expected, actual, calls: calls.length,
          memoryLookups: memoryCalls - lookupsBefore, prefix: wire.prefix, baseChanges: wire.baseChanges });
        if (existsSync(outputPath)) {
          const destination = `${strategy}-${repetition}-result-${state.turn}.json`;
          writeFileSync(join(reportRoot, destination), readFileSync(outputPath));
          result.files.push({ path: destination, sha256: sha(readFileSync(outputPath, 'utf8')) });
        }
      } else {
        result.checks.push({ turn: state.turn, prefix: wire.prefix, baseChanges: wire.baseChanges,
          evidenceCopies: wire.evidenceCopies, revision2Present: wire.revision2Present });
        const shouldBreak = (state.turn === 2 && (strategy === 'current' || strategy === 'first-only')) ||
          (state.turn === 3 && strategy === 'current') ||
          (state.turn === 4 && ['current', 'replay', 'delta', 'frozen'].includes(strategy));
        if (state.turn > 1) assert.equal(wire.prefix, !shouldBreak, `${strategy} turn ${state.turn} prefix`);
        if (state.turn === 3 && ['persist', 'replay', 'delta', 'delta-persist', 'refs', 'current'].includes(strategy)) assert(wire.revision2Present);
        if (state.turn === 3 && strategy === 'frozen') assert(!wire.revision2Present, 'Frozen snapshot has stale evidence');
        for (const call of calls.slice(1)) assert(call.wire!.prefix, 'Within-turn continuations must remain stable');
      }
      console.log(`${live ? 'LIVE' : 'OFFLINE'} ${strategy} r${repetition} turn${state.turn}: calls=${calls.length} prefix=${wire.prefix} evidence=${wire.evidenceCopies}`);
      writeFileSync(join(reportRoot, `${strategy}-${repetition}.json`), JSON.stringify(result, null, 2));
    }
    result.checks.push({ sourceMarkerPersisted: readFileSync(file, 'utf8').includes(marker),
      persistedSnapshotEntries: manager!.getBranch().filter(e => e.type === 'custom_message' && e.customType === 'assessment.evidence').length,
      persistedReferenceEntries: manager!.getBranch().filter(e => e.type === 'custom' && ['assessment.evidence-ref', 'mybuddy.context-ledger'].includes(e.customType)).length,
      privacyLimit: 'Absence of a source marker does not imply absence of derived facts in messages, code or summaries.' });
    if (live && existsSync(join(task, 'calibrate.mjs'))) writeFileSync(join(reportRoot, `${strategy}-${repetition}-calibrate.mjs`), readFileSync(join(task, 'calibrate.mjs')));
    if (!live) {
      // Compaction is a distinct operation; summaries can retain revoked facts independently of capsules.
      phase = 'compact'; await session!.compact(); assert(summaryCalls > 0);
      phase = 'post-compact'; offlineCallInTurn = 0;
      const start = result.calls.length;
      await session!.prompt('Continue after native compaction.');
      assert(result.calls.slice(start).every(c => c.status !== 'error'));
      const afterCompaction = result.calls[start].wire!;
      if (['current', 'persist', 'replay', 'delta', 'delta-persist', 'refs'].includes(strategy)) assert(afterCompaction.revision2Present, 'Current evidence must be restored after native compaction');
      result.checks.push({ nativeCompaction: true, summaryRetainsOldFact: afterCompaction.revision1Present,
        currentEvidenceAfterCompaction: afterCompaction.revision2Present });
      phase = 'revoke'; denyRevoked = true;
      const before = result.calls.length;
      await session!.prompt('This source is now revoked; the host must reject before dispatch.');
      assert(result.calls.slice(before).some(c => c.blocked));
      assert.equal(nativeNetworkAttempts, 0);
      result.checks.push({ prototypeRevocationGuardBlocked: true, networkAttempts: nativeNetworkAttempts });
    }
  } catch (error) {
    result.error = String(error);
    console.error(`${strategy}: ${result.error}`);
  } finally {
    session?.dispose();
    productDb?.close();
    writeFileSync(join(reportRoot, `${strategy}-${repetition}.json`), JSON.stringify(result, null, 2));
    rmSync(root, { recursive: true, force: true });
  }
  return result;
}

async function main() {
  if (!live) {
    for (const damage of ['hash', 'renderer', 'version'] as const) {
      const manager = SessionManager.inMemory();
      const anchor = manager.appendMessage({ role: 'user', content: 'Synthetic reference test', timestamp: 1 });
      manager.appendCustomEntry('assessment.evidence-ref', { anchor, revision: damage === 'version' ? 99 : 1,
        renderer: damage === 'renderer' ? 99 : 1, textHash: damage === 'hash' ? sha('changed') : sha(ruleText(1)) });
      assert.throws(() => strategyExtension('refs', manager, { turn: 2, revision: 2 }), /Historical|rendering/);
    }
    console.log('PASS reference failures: changed content, missing version and unknown renderer reject hydration');
  }
  const results: Summary[] = [];
  // Alternate ordering on repeats to avoid always warming one strategy before another.
  for (let n = 1; n <= repeat; n++) {
    for (const strategy of n % 2 ? selected : [...selected].reverse()) results.push(await run(strategy, n));
  }
  const summary = { runId, live, results, limits: [
    'Provider onPayload, not gateway-to-vendor wire. Unknown routing and cache eviction remain.',
    'Generated CSV engineering task; real native read/write and Node execution. Isolated SDK host, not desktop UI.',
    'Memory source is controlled test data. The product arm uses real MemoryService/SQLite, production projection and admission; other arms are prototypes.',
    'Rate is descriptive; shared global system/tool prefixes and provider variability prevent guaranteed hit rates.',
  ] };
  writeFileSync(join(reportRoot, 'report.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(reportRoot, 'done.json'), JSON.stringify({ failed: results.filter(r => r.error).length, scenarios: results.length }));
  console.log(`Report: ${reportRoot}`);
  if (results.some(r => r.error)) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
