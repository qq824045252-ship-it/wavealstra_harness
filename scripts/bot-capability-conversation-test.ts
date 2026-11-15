import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import { botCapabilityTaskId, type BotSendReceipt } from "../src/shared/bot-conversation";
import type { SpeechAudioEvent } from "../src/shared/speech-stream";
import type { CapabilityResult } from "../src/shared/capability-result";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService } from "../src/main/agent/work/WorkService";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { createBotCapabilityTools } from "../src/main/agent/work/BotCapabilityTools";
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { BuiltinCapabilityRuntime, type SpeechCapabilityProvider, type ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { MediaCapabilityServices } from "../src/main/capabilities/MediaCapabilityServices";
import { VideoGenerationJobs } from "../src/main/capabilities/VideoGenerationJobs";
import { createHttpSpeechProvider } from "../src/main/capabilities/HttpSpeechProvider";

type SpeechCard = Extract<CapabilityResult, { kind: "speech" }>;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function wait(check: () => boolean, name: string): Promise<void> {
  const until = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out: ${name}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const root = await mkdtemp(join(tmpdir(), "mybuddy-bot-capabilities-"));
const cwd = join(root, "workspace"); await mkdir(cwd);
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
const works = new WorkService(db.connection, { bots });
const artifactStorage = new ArtifactStorage(join(root, "artifacts"));
const artifacts = new ArtifactService(artifactStorage, new ArtifactRepository(db.connection), new ArtifactRegistry());
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
let modelCalls = 0, generation = 0;
let plan: { tool: "text_to_speech" | "speech_to_text"; args: () => ToolCall["arguments"] };
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "front", name: "front", reasoning: false, input: ["text"], contextWindow: 128_000, maxTokens: 2_048,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: model => {
    modelCalls++;
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const first = generation++ === 0;
      const message: AssistantMessage = { role: "assistant", content: first
        ? [{ type: "toolCall", id: "same-tool-call", name: plan.tool, arguments: plan.args() }]
        : [{ type: "text", text: "本次工具调用已处理。" }],
      stopReason: first ? "toolUse" : "stop", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }); stream.end();
    });
    return stream;
  } });

const pcm = Buffer.alloc(4_800, 1);
const wav = Buffer.alloc(44 + pcm.length);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24); wav.writeUInt32LE(48_000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(pcm.length, 40); pcm.copy(wav, 44);
let config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
config.ocr = { enabled: false }; config.web.enabled = false; config.vision.enabled = false;
config.imageGeneration.enabled = false; config.videoGeneration.enabled = false; config.browser.enabled = false;
config.subagent.enabled = false; config.multiModelConsult.enabled = false;
config.execution = { terminalEnabled: false, codeExecutionEnabled: false }; config.diagnostics = { enabled: false };
config.speechToText = { enabled: true }; config.textToSpeech = { enabled: true, transport: "websocket" };
config.connections = { "api-deepseek": { name: "DeepSeek fixture", protocol: "deepseek", presetId: "deepseek", baseUrl: "https://api.deepseek.com",
  auth: "api-key", credentialRef: "fixture-asr-key", timeoutMs: 2_000 } };
config.mediaBindings = { "text-to-speech": { connectionId: "registered:fixture-speech" }, "speech-to-text": { connectionId: "api-deepseek" } };
const runtime = new BuiltinCapabilityRuntime({ store: { read: () => config, write: value => { config = value; return value; } },
  credentials: { has: key => key === "fixture-asr-key", get: key => key === "fixture-asr-key" ? "never-use-real-key" : null, set: () => {}, clear: () => {} } });
const speechCalls: Array<{ text: string; context: ToolExecutionContext; release: () => void }> = [];
const speech: SpeechCapabilityProvider = { id: "fixture-speech", label: "Isolated bot speech", supportsAudioStreaming: true,
  async textToSpeech(input, context) {
    const gate = deferred<void>(); speechCalls.push({ text: input.text, context, release: gate.resolve });
    context.audioStream!({ type: "start", format: "pcm_s16le", sampleRate: 24_000, channels: 1 });
    context.audioStream!({ type: "chunk", audio: pcm });
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(new Error("Fixture speech cancelled"));
      context.signal?.addEventListener("abort", aborted, { once: true });
      gate.promise.then(() => { context.signal?.removeEventListener("abort", aborted); resolve(); }, reject);
      if (context.signal?.aborted) aborted();
    });
    context.signal?.throwIfAborted(); context.audioStream!({ type: "finish" });
    return { provider: "fixture-speech", items: [{ bytes: new Uint8Array(wav), mimeType: "audio/wav", fileName: "speech.wav", durationSeconds: 0.1 }],
      metadata: { transport: "websocket", voice: "stella", billableCharacters: input.text.length } };
  } };
runtime.registerProvider("speech", speech);
let asrCalls = 0;
runtime.attachMediaServices(new MediaCapabilityServices({ runtime, getMagpieConfig: () => undefined,
  videoJobs: new VideoGenerationJobs(join(root, "videos.json")), fetch: (async (url, init) => {
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/asr"); asrCalls++;
    assert(init?.body instanceof FormData);
    assert.deepEqual(Buffer.from(await (init.body.get("file") as File).arrayBuffer()), wav);
    return new Response(JSON.stringify({ text: "来自不可变附件的转写", duration_ms: 100 }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch }));
const events: SpeechAudioEvent[] = []; runtime.speechStreams.onAudio(event => events.push(event));
const capabilityInputs: Array<{ messageId: string; cwd: string; inputFilePaths: readonly string[] }> = [];
const makeService = () => new BotConversationService({ db: db.connection, bots, works, models, directory: join(root, "foreground"), userId: LOCAL_USER_ID,
  defaultModel: () => "fixture/front", isAuthority: () => true, memorySearch: () => [], schedule: () => {}, wake: () => {},
  messageSettings: () => ({ profile: bots.activeSnapshot(DEFAULT_BOT_ID)!, settings: {
    botId: DEFAULT_BOT_ID, workspacePath: cwd, effectiveWorkspacePath: cwd, modelId: "fixture/front", expertId: "", skillIds: [], mcpIds: [], connectorIds: [], revision: 0, spaceId: "fixture" } }),
  composerTools: async () => ({ tools: [], instructions: "", close: async () => {} }),
  capabilityTools: async (taskRoot, messageId, inputFilePaths) => {
    capabilityInputs.push({ messageId, cwd: taskRoot, inputFilePaths });
    return createBotCapabilityTools({ cwd: taskRoot, messageId, inputFilePaths, models, runtime, browser: { available: false } as never,
      artifactService: () => artifacts, getIsolationLevel: () => "guarded" });
  } });
let service = makeService();
const receipts: BotSendReceipt[] = [];
let attachmentSnapshot = "";
const terminalEvents = (messageId: string) => events.filter(event => event.messageId === messageId && ["complete", "error", "cancelled"].includes(event.kind));
const card = (receipt: BotSendReceipt) => service.messages.message(receipt.assistantMessageId)?.tools?.find(tool => tool.tool === "text_to_speech")?.capabilityResult as SpeechCard | undefined;
let passed = 0;
async function check(name: string, run: () => Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }
try {
  for (const name of ["first", "second"] as const) {
    await check(`${name} Bot request persists its own live card and saved artifact even with repeated tool call IDs`, async () => {
      generation = 0; plan = { tool: "text_to_speech", args: () => ({ text: name }) };
      const receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: name, text: `Read ${name}` }); receipts.push(receipt);
      await wait(() => speechCalls.some(call => call.context.producerMessageId === receipt.assistantMessageId), "streaming provider start");
      await wait(() => Boolean(card(receipt)?.stream), "live Bot speech card persisted");
      const pending = service.messages.message(receipt.assistantMessageId)!;
      assert.equal(pending.status, "running"); assert.equal(pending.toolTaskId, botCapabilityTaskId(receipt.assistantMessageId));
      assert.equal(card(receipt)?.stream?.messageId, receipt.assistantMessageId); assert.equal(card(receipt)?.artifacts.length, 0);
      assert.equal(terminalEvents(receipt.assistantMessageId).length, 0);
      if (name === "second") assert.equal(card(receipts[0])?.artifacts.length, 1, "prior card must stay finalized while the next call streams");
      speechCalls.find(call => call.context.producerMessageId === receipt.assistantMessageId)!.release();
      await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "completed", "Bot final speech answer");
      const result = card(receipt)!; assert.equal(result.artifacts.length, 1);
      const artifact = artifacts.get(result.artifacts[0].id)!;
      assert.equal(artifact.taskId, botCapabilityTaskId(receipt.assistantMessageId)); assert.equal(artifact.createdByMessageId, receipt.assistantMessageId);
      assert.equal(artifact.createdByToolCallId, "same-tool-call"); assert.equal(artifact.source.type, "workspace-file");
      if (artifact.source.type === "workspace-file") assert.deepEqual(await readFile(artifact.source.entryFile), wav);
      assert.deepEqual(terminalEvents(receipt.assistantMessageId).map(event => event.kind), ["complete"]);
      assert(!JSON.stringify(service.messages.message(receipt.assistantMessageId)).includes("pcmBase64"));
    });
  }
  assert.notEqual(card(receipts[0])?.stream?.streamId, card(receipts[1])?.stream?.streamId);
  assert.notEqual(card(receipts[0])?.artifacts[0].id, card(receipts[1])?.artifacts[0].id);

  await check("Bot ASR reads only the attached immutable snapshot outside its workspace", async () => {
    const original = join(root, "original.wav"); await writeFile(original, wav);
    let receipt!: BotSendReceipt;
    generation = 0; plan = { tool: "speech_to_text", args: () => ({ audio_path: service.messages.message(receipt.userMessageId)!.attachments![0].path }) };
    receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: "attached-asr", text: "Transcribe the attached WAV", attachments: [{ name: "voice.wav", path: original }] }); receipts.push(receipt);
    const snapshot = service.messages.message(receipt.userMessageId)!.attachments![0].path;
    attachmentSnapshot = snapshot;
    assert.notEqual(snapshot, original); assert(relative(cwd, snapshot).startsWith(".."));
    await writeFile(original, "source changed after submission");
    assert.deepEqual(await readFile(snapshot), wav);
    await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "completed", "ASR Bot answer");
    assert.equal(asrCalls, 1);
    assert.deepEqual(capabilityInputs.find(input => input.messageId === receipt.assistantMessageId)?.inputFilePaths, [snapshot]);
    const transcript = service.messages.message(receipt.assistantMessageId)?.tools?.find(tool => tool.tool === "speech_to_text");
    assert.equal(transcript?.status, "success"); assert.equal(transcript?.capabilityResult?.kind, "transcript");
    if (transcript?.capabilityResult?.kind === "transcript") assert.equal(transcript.capabilityResult.text, "来自不可变附件的转写");
  });

  await check("A follow-up can transcribe the same conversation's verified attachment without reattaching it", async () => {
    generation = 0; plan = { tool: "speech_to_text", args: () => ({ audio_path: attachmentSnapshot }) };
    const receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: "follow-up-asr", text: "Transcribe the same attached WAV again" }); receipts.push(receipt);
    await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "completed", "follow-up ASR answer");
    assert.equal(asrCalls, 2);
    assert(capabilityInputs.find(input => input.messageId === receipt.assistantMessageId)?.inputFilePaths.includes(attachmentSnapshot));
    assert.equal(service.messages.message(receipt.assistantMessageId)?.tools?.find(tool => tool.tool === "speech_to_text")?.capabilityResult?.kind, "transcript");
  });

  await check("An unrelated outside audio path is rejected before any ASR upload", async () => {
    const unrelated = join(root, "unrelated.wav"); await writeFile(unrelated, wav);
    generation = 0; plan = { tool: "speech_to_text", args: () => ({ audio_path: unrelated }) };
    const receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: "outside-asr", text: "Try unrelated outside audio" }); receipts.push(receipt);
    await wait(() => service.messages.message(receipt.assistantMessageId)?.status === "completed", "rejected ASR tool answer");
    assert.equal(asrCalls, 2); const tool = service.messages.message(receipt.assistantMessageId)?.tools?.find(tool => tool.tool === "speech_to_text");
    assert.equal(tool?.status, "error"); assert.match(tool?.output ?? "", /policy|attached|附件|工作目录/);
  });

  await check("The same host path guard covers generic HTTP ASR, including its direct file reader", async () => {
    let uploads = 0;
    const http = createServer(async (request, response) => {
      uploads++;
      for await (const _chunk of request) { /* Drain the actual multipart upload. */ }
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ text: "Generic HTTP transcript" }));
    });
    http.listen(0, "127.0.0.1"); await once(http, "listening");
    try {
      runtime.registerProvider("speech", createHttpSpeechProvider(runtime));
      config.services = { "generic-asr": { adapter: "http-asr", endpoint: `http://127.0.0.1:${(http.address() as AddressInfo).port}/asr`,
        model: "fixture", location: "local", dataPolicy: "allow-cloud", timeoutMs: 2_000 } };
      config.mediaBindings!["speech-to-text"] = { connectionId: "legacy:generic-asr" };
      generation = 0; plan = { tool: "speech_to_text", args: () => ({ audio_path: attachmentSnapshot }) };
      const good = service.send({ botId: DEFAULT_BOT_ID, requestId: "generic-attached", text: "Read the previously attached WAV with HTTP ASR" }); receipts.push(good);
      await wait(() => service.messages.message(good.assistantMessageId)?.status === "completed", "generic attached ASR");
      assert.equal(uploads, 1, "valid attached snapshot must reach the real generic adapter");
      const transcript = service.messages.message(good.assistantMessageId)?.tools?.find(tool => tool.tool === "speech_to_text");
      assert.equal(transcript?.status, "success");
      generation = 0; plan = { tool: "speech_to_text", args: () => ({ audio_path: join(root, "unrelated.wav") }) };
      const blocked = service.send({ botId: DEFAULT_BOT_ID, requestId: "generic-outside", text: "Try an unrelated outside audio path with HTTP ASR" }); receipts.push(blocked);
      await wait(() => service.messages.message(blocked.assistantMessageId)?.status === "completed", "generic outside ASR refusal");
      assert.equal(uploads, 1, "generic direct read must not bypass host input scoping");
      assert.equal(service.messages.message(blocked.assistantMessageId)?.tools?.find(tool => tool.tool === "speech_to_text")?.status, "error");
    } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
  });

  await check("Bot cancellation settles the card and stream without creating an artifact", async () => {
    generation = 0; plan = { tool: "text_to_speech", args: () => ({ text: "cancel" }) };
    const receipt = service.send({ botId: DEFAULT_BOT_ID, requestId: "cancel", text: "Read until cancelled" }); receipts.push(receipt);
    await wait(() => Boolean(card(receipt)?.stream), "cancellable Bot stream");
    await service.cancel(DEFAULT_BOT_ID, receipt.requestId);
    const message = service.messages.message(receipt.assistantMessageId)!;
    assert.equal(message.status, "cancelled"); assert(message.tools?.every(tool => tool.status !== "running"));
    assert.equal(artifacts.hydrateTask(botCapabilityTaskId(receipt.assistantMessageId)).artifacts.length, 0);
    assert.deepEqual(terminalEvents(receipt.assistantMessageId).map(event => event.kind), ["cancelled"]);
  });

  await check("Reopening the Bot repository preserves current-request cards without regenerating speech", async () => {
    const expected = receipts.map(receipt => service.messages.message(receipt.assistantMessageId));
    await service.close(); const before = { modelCalls, speech: speechCalls.length, asrCalls };
    service = makeService(); service.recover();
    assert.deepEqual(receipts.map(receipt => service.messages.message(receipt.assistantMessageId)), expected);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual({ modelCalls, speech: speechCalls.length, asrCalls }, before);
    for (const receipt of receipts) assert(service.messages.message(receipt.assistantMessageId)?.tools?.every(tool => tool.status !== "running"));
  });
  console.log(`Bot capability conversation: ${passed} integration groups passed`);
} finally {
  for (const call of speechCalls) call.release();
  await service.close(); runtime.speechStreams.close(); db.close(); await rm(root, { recursive: true, force: true });
}
