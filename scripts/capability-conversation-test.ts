import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BACKGROUND_CONTEXT as durableContext } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { Models } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import type { CapabilityResult } from "../src/shared/capability-result";
import type { SpeechAudioEvent } from "../src/shared/speech-stream";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { BuiltinCapabilityRuntime, type SpeechCapabilityProvider, type ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { SpeechStreamService } from "../src/main/capabilities/SpeechStreamService";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";

interface Result { isError?: boolean; details?: unknown; content?: Array<{ type: string; text?: string }> }
interface Tool { name: string; execute(id: string, input: Record<string, unknown>, signal?: AbortSignal, update?: (result: Result) => void): Promise<Result> }
type SpeechResult = Extract<CapabilityResult, { kind: "speech" }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${name} timed out`)), 10_000); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(check: () => Promise<boolean>, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  do {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.fail(`${name} did not appear`);
}

const pcm = Buffer.from([0x19, 0x01, 0x37, 0x02, 0x55, 0x03, 0x73, 0x04]);
const wav = Buffer.alloc(44 + pcm.length);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
const root = await mkdtemp(join(tmpdir(), "mybuddy-capability-conversation-"));
const initialContext: ToolExecutionContext = { taskId: "task", taskRoot: root, producerMessageId: "message", toolCallId: "call" };
const terminal = (events: SpeechAudioEvent[]) => events.filter(event => ["complete", "error", "cancelled"].includes(event.kind));

async function fixture(name: string) {
  const taskRoot = join(root, name); await mkdir(taskRoot);
  const dbPath = join(taskRoot, "artifacts.db");
  const db = new Database(dbPath);
  const repository = new ArtifactRepository(db);
  const storage = new ArtifactStorage(join(taskRoot, "artifact-storage"));
  const service = new ArtifactService(storage, repository, new ArtifactRegistry());
  let config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  config.connections = {}; config.mediaBindings = {};
  config.ocr = { enabled: false }; config.web.enabled = false; config.vision.enabled = false;
  config.imageGeneration.enabled = false; config.videoGeneration.enabled = false; config.speechToText.enabled = false;
  config.browser.enabled = false; config.subagent.enabled = false; config.multiModelConsult.enabled = false;
  config.execution = { terminalEnabled: false, codeExecutionEnabled: false }; config.diagnostics = { enabled: false };
  config.textToSpeech = { enabled: true, provider: "speech-fixture", voice: "stella", transport: "websocket" };
  const runtime = new BuiltinCapabilityRuntime({ store: { read: () => config, write: value => { config = value; return value; } },
    credentials: { has: () => false, get: () => null, set: () => {}, clear: () => {} } });
  const entered = deferred<ToolExecutionContext>();
  const release = deferred<void>();
  let calls = 0;
  const provider: SpeechCapabilityProvider = {
    id: "speech-fixture", label: "Isolated streaming speech", supportsAudioStreaming: true,
    async textToSpeech(_input, context) {
      calls++;
      context.audioStream!({ type: "start", format: "pcm_s16le", sampleRate: 24_000, channels: 1 });
      context.audioStream!({ type: "chunk", audio: new Uint8Array(pcm) });
      entered.resolve(context);
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error("Fixture speech cancelled"));
        context.signal?.addEventListener("abort", aborted, { once: true });
        release.promise.then(() => { context.signal?.removeEventListener("abort", aborted); resolve(); }, reject);
        if (context.signal?.aborted) aborted();
      });
      context.signal?.throwIfAborted();
      context.audioStream!({ type: "finish" });
      return { provider: "speech-fixture", items: [{ bytes: new Uint8Array(wav), mimeType: "audio/wav", fileName: "speech.wav", durationSeconds: pcm.length / 48_000 }],
        metadata: { voice: "stella", transport: "websocket", billableCharacters: 5 } };
    },
  };
  runtime.registerProvider("speech", provider);
  const events: SpeechAudioEvent[] = [];
  runtime.speechStreams.onAudio(event => events.push(event));
  const extension = createBuiltinCapabilityExtension({ taskId: name, taskRoot, runtime, nativeExecution: true,
    browser: { available: false } as never, artifactService: () => service,
    getProducerMessageId: () => `${name}-message`, getIsolationLevel: () => "guarded" });
  const tools = new Map<string, Tool>();
  await extension({ registerTool: (tool: Tool) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  const speech = tools.get("text_to_speech")!; assert(speech);
  return { taskRoot, dbPath, db, repository, storage, service, runtime, entered, release, events, extension, speech, calls: () => calls,
    close() { release.resolve(); runtime.speechStreams.close(); db.close(); } };
}

let passed = 0;
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  await check("Stream service preserves scope and defers completion until the artifact transaction commits", async () => {
    const service = new SpeechStreamService(); const events: SpeechAudioEvent[] = [];
    service.onAudio(event => events.push(event));
    const stream = service.start(initialContext);
    stream.audioStream({ type: "start", format: "pcm_s16le", sampleRate: 24_000, channels: 1 });
    stream.audioStream({ type: "chunk", audio: pcm }); stream.audioStream({ type: "finish" });
    assert.deepEqual(events.map(event => event.kind), ["start", "chunk"]);
    assert.equal(events[0].messageId, "message"); assert.equal(events[1].taskId, "task");
    assert.equal(events[1].kind === "chunk" && events[1].sequence, 0);
    assert.equal(events[1].kind === "chunk" && events[1].pcmBase64, pcm.toString("base64"));
    stream.complete(); stream.complete(); stream.fail(new Error("late failure"));
    assert.deepEqual(terminal(events).map(event => event.kind), ["complete"]);
    assert.equal(service.cancel(stream.scope), false); service.close();
  });

  await check("Cancellation checks task and call scope and emits exactly one terminal event", async () => {
    const service = new SpeechStreamService(); const events: SpeechAudioEvent[] = [];
    service.onAudio(event => events.push(event));
    const one = service.start(initialContext), two = service.start({ ...initialContext, toolCallId: "other" });
    assert.equal(service.cancel({ ...one.scope, taskId: "another-task" }), false);
    assert.equal(service.cancel({ ...one.scope, toolCallId: "other" }), false);
    assert.equal(service.cancel(one.scope), true); assert.equal(service.cancel(one.scope), false);
    one.fail(new Error("cancelled")); one.complete();
    assert.equal(one.signal.aborted, true); assert.equal(two.signal.aborted, false);
    assert.deepEqual(terminal(events).map(event => event.kind), ["cancelled"]);
    two.fail(new Error("late service failure"));
    assert.equal(terminal(events).length, 2); service.close();
  });

  await check("Real speech tool publishes early progress, then saves WAV with durable artifact provenance", async () => {
    const f = await fixture("extension-success");
    try {
      const updates: Result[] = [];
      let settled = false;
      const pending = f.speech.execute("extension-call", { text: "hello" }, undefined, update => updates.push(update)).then(value => { settled = true; return value; });
      await bounded(f.entered.promise, "speech start");
      assert.equal(settled, false); assert.deepEqual(f.events.map(event => event.kind), ["start", "chunk"]);
      const progress = (updates[0].details as { capabilityResult: SpeechResult }).capabilityResult;
      assert.equal(progress.stream?.toolCallId, "extension-call"); assert.deepEqual(progress.artifacts, []);
      f.release.resolve();
      const result = await bounded(pending, "speech save"); assert.notEqual(result.isError, true);
      const details = result.details as { items: string[]; capabilityResult: SpeechResult };
      assert.deepEqual(await readFile(details.items[0]), wav); assert.equal(details.capabilityResult.artifacts.length, 1);
      assert.deepEqual(details.capabilityResult.stream, progress.stream);
      assert.deepEqual(terminal(f.events).map(event => event.kind), ["complete"]);
      assert(!JSON.stringify(result).includes("pcmBase64")); assert(!JSON.stringify(result).includes('"type":"chunk"'));
      const reopenedDb = new Database(f.dbPath);
      try {
        const restored = new ArtifactService(f.storage, new ArtifactRepository(reopenedDb), new ArtifactRegistry());
        const artifact = restored.get(details.capabilityResult.artifacts[0].id)!;
        assert.equal(artifact.mimeType, "audio/wav"); assert.equal(artifact.createdByToolCallId, "extension-call");
        assert.equal(artifact.createdByMessageId, "extension-success-message");
        const refs = restored.listMessageRefs("extension-success"); assert.equal(refs.length, 1); assert.equal(refs[0].artifactId, artifact.id);
      } finally { reopenedDb.close(); }
    } finally { f.close(); }
  });

  await check("Artifact save failure emits error and removes staged audio without a false complete", async () => {
    const f = await fixture("save-failure");
    try {
      f.service.register = async () => { throw new Error("Fixture artifact store unavailable"); };
      const pending = f.speech.execute("failed-call", { text: "hello" });
      await bounded(f.entered.promise, "speech start"); f.release.resolve();
      const result = await bounded(pending, "save failure"); assert.equal(result.isError, true);
      assert.deepEqual(terminal(f.events).map(event => event.kind), ["error"]);
      assert.deepEqual(await readdir(join(f.taskRoot, "generated", "audio")), []);
      assert.equal(f.service.hydrateTask("save-failure").artifacts.length, 0);
    } finally { f.close(); }
  });

  await check("Cancelling through the real tool prevents persistence and leaves the parent task signal active", async () => {
    const f = await fixture("extension-cancel");
    try {
      const parent = new AbortController();
      const pending = f.speech.execute("cancel-call", { text: "hello" }, parent.signal);
      const context = await bounded(f.entered.promise, "speech start");
      assert.equal(f.runtime.speechStreams.cancel(f.events[0]), true);
      const result = await bounded(pending, "speech cancel"); assert.equal(result.isError, true);
      assert.equal(context.signal?.aborted, true); assert.equal(parent.signal.aborted, false);
      assert.deepEqual(terminal(f.events).map(event => event.kind), ["cancelled"]);
      assert.equal(f.service.hydrateTask("extension-cancel").artifacts.length, 0);
    } finally { f.close(); }
  });

  for (const mode of ["native", "codemode"] as const) {
    await check(`${mode} Durable execution presents live speech details and restores the saved card without replay`, async () => {
      const f = await fixture(`durable-${mode}`);
      let runtime: Awaited<ReturnType<typeof DurableBotRuntime.open>> | undefined;
      let generations = 0;
      const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
        input: ["text"], contextWindow: 128_000, maxTokens: 1_024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      const models = { getAuth: async () => undefined, getModel: () => model, streamSimple: () => {
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const first = generations++ === 0;
          const message = { role: "assistant", content: first ? [{ type: "toolCall", id: `speak-${mode}`, name: mode === "native" ? "text_to_speech" : "codemode",
            arguments: mode === "native" ? { text: "hello" } : { code: 'const result = await tools.text_to_speech({text:"hello"}); text(result);' } }] : [{ type: "text", text: "Speech saved" }],
            stopReason: first ? "toolUse" : "stop", api: model.api, model: model.id, provider: model.provider, timestamp: Date.now(),
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "done", reason: message.stopReason, message } as never); stream.end();
        });
        return stream;
      } } as unknown as Models;
      const domain = await durableDomainTools([f.extension]);
      const options = { directory: join(f.taskRoot, "durable-state"), cwd: f.taskRoot, model: { provider: "fixture", modelId: "fixture" },
        models, toolMode: mode, tools: domain.tools, instructions: () => "Isolated speech integration", onSnapshot: () => {} };
      try {
        runtime = await DurableBotRuntime.open(options);
        const submission = await runtime.submit("Read hello", `speech-request-${mode}`);
        await bounded(f.entered.promise, "durable speech start");
        await eventually(async () => {
          await runtime!.refresh();
          return runtime!.snapshot.messages.some(message => message.tools?.some(tool => tool.tool === "text_to_speech" && tool.capabilityResult?.kind === "speech" && Boolean(tool.capabilityResult.stream)));
        }, `${mode} live speech card`);
        assert.deepEqual(f.events.map(event => event.kind), ["start", "chunk"]);
        f.release.resolve();
        assert.equal((await bounded(submission.wait(durableContext), "durable completion")).status, "done");
        await runtime.conversation.waitForIdle(durableContext); await runtime.refresh();
        const row = runtime.snapshot.messages.flatMap(message => message.tools ?? []).find(tool => tool.tool === "text_to_speech" && tool.capabilityResult?.kind === "speech");
        const card = row?.capabilityResult as SpeechResult | undefined;
        assert(card); assert.equal(card.artifacts.length, 1); assert.equal(card.stream?.streamId, f.events[0].streamId);
        assert(f.service.get(card.artifacts[0].id)); assert.equal(f.calls(), 1);
        const entries = await runtime.harness.commit(tx => tx.scanEntries({ conversationId: runtime!.conversation.id }, 500), durableContext);
        assert(!JSON.stringify(entries).includes("pcmBase64"), "PCM must remain ephemeral, outside durable entries");
        assert.deepEqual(terminal(f.events).map(event => event.kind), ["complete"]);
        await runtime.close(); runtime = undefined;
        const before = generations;
        runtime = await DurableBotRuntime.open(options); await runtime.refresh();
        const restored = runtime.snapshot.messages.flatMap(message => message.tools ?? []).find(tool => tool.tool === "text_to_speech" && tool.capabilityResult?.kind === "speech")?.capabilityResult;
        assert.deepEqual(restored, card); assert.equal(generations, before); assert.equal(f.calls(), 1);
      } finally {
        f.release.resolve(); if (runtime) await runtime.close(); f.close();
      }
    });
  }
  console.log(`Capability conversation: ${passed} integration groups passed`);
} finally { await rm(root, { recursive: true, force: true }); }
