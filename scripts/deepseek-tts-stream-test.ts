import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { MessageEvent } from "undici";
import type { SpeechProviderAudioEvent } from "../src/shared/speech-stream";
import type { ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { ApiProviderError, type ResolvedApiConnection } from "../src/main/capabilities/providers/ApiServiceConnection";
import { createDeepSeekSpeechProvider, type DeepSeekSpeechProviderOptions } from "../src/main/capabilities/providers/DeepSeekSpeechProvider";
import {
  createDeepSeekTtsSocket, DEEPSEEK_TTS_MAX_PCM_BYTES, deepSeekTtsTextChunks,
  type DeepSeekTtsSocket, type DeepSeekTtsSocketFactory,
} from "../src/main/capabilities/providers/DeepSeekTtsStream";

// An actual local RFC 6455 peer; no paid service, external network, or transitive ws dependency.
function frame(opcode: number, data: Buffer, declaredLength = data.length): Buffer {
  const header = Buffer.alloc(declaredLength < 126 ? 2 : declaredLength < 65_536 ? 4 : 10);
  header[0] = 0x80 | opcode;
  if (header.length === 2) header[1] = declaredLength;
  else if (header.length === 4) { header[1] = 126; header.writeUInt16BE(declaredLength, 2); }
  else { header[1] = 127; header.writeBigUInt64BE(BigInt(declaredLength), 2); }
  return Buffer.concat([header, data]);
}

class Peer {
  readonly messages: Array<{ event: string; text?: string }> = [];
  onFinishText?: () => void;
  onPong?: () => void;
  private buffered = Buffer.alloc(0);
  constructor(readonly socket: Socket, readonly request: IncomingMessage, head: Buffer) {
    socket.on("data", data => this.receive(data));
    socket.on("error", () => undefined);
    if (head.length) this.receive(head);
  }
  text(value: unknown): void { this.socket.write(frame(1, Buffer.from(JSON.stringify(value)))); }
  rawText(value: string): void { this.socket.write(frame(1, Buffer.from(value))); }
  audio(value: Buffer): void { this.socket.write(frame(2, value)); }
  finish(code = "success", message?: string): void { this.text({ event: "finish", code, message }); }
  close(): void { this.socket.end(frame(8, Buffer.from([0x03, 0xe8]))); }
  private receive(bytes: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, bytes]);
    while (this.buffered.length >= 2) {
      const mask = Boolean(this.buffered[1] & 0x80);
      let size = this.buffered[1] & 0x7f;
      let offset = 2;
      if (size === 126) { if (this.buffered.length < 4) return; size = this.buffered.readUInt16BE(2); offset = 4; }
      else if (size === 127) { if (this.buffered.length < 10) return; size = Number(this.buffered.readBigUInt64BE(2)); offset = 10; }
      assert(mask, "Client messages must be masked");
      if (this.buffered.length < offset + 4 + size) return;
      const key = this.buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffered.subarray(offset + 4, offset + 4 + size));
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      const opcode = this.buffered[0] & 0xf;
      this.buffered = this.buffered.subarray(offset + 4 + size);
      if (opcode === 1) {
        const message = JSON.parse(payload.toString()) as { event: string; text?: string };
        this.messages.push(message);
        if (message.event === "finish_text") this.onFinishText?.();
      } else if (opcode === 8) {
        if (!this.socket.writableEnded) this.socket.end(frame(8, payload));
      } else if (opcode === 10) this.onPong?.();
      else assert.fail(`Unexpected client opcode ${opcode}`);
    }
  }
}

const sockets = new Set<Socket>();
const peers: Peer[] = [];
let onPeer: (peer: Peer) => void = () => undefined;
let onUpgrade: (() => void) | undefined;
let handshake: "accept" | "hang" | "unauthorized" | "redirect" = "accept";
const server = createServer();
server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
server.on("upgrade", (request, socket, head) => {
  onUpgrade?.();
  if (handshake === "hang") return;
  if (handshake === "unauthorized") { socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"); return; }
  if (handshake === "redirect") { socket.end("HTTP/1.1 302 Found\r\nLocation: https://example.invalid/key\r\nContent-Length: 0\r\n\r\n"); return; }
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const peer = new Peer(socket as Socket, request, head);
  peers.push(peer);
  onPeer(peer);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const port = (server.address() as AddressInfo).port;

const connection: ResolvedApiConnection = {
  id: "api-deepseek-stream", label: "DeepSeek fixture", protocol: "deepseek", baseUrl: "https://api.deepseek.com",
  timeoutMs: 2_000, headers: { authorization: "Bearer fixture-secret-never-log" },
};
const context: ToolExecutionContext = { taskId: "tts-task", taskRoot: "/isolated-unused", toolCallId: "tts-call" };
let socketCalls = 0;
let fetchCalls = 0;
let lastSocketUrl = "";
const socketFactory: DeepSeekTtsSocketFactory = (url, options) => {
  socketCalls++;
  lastSocketUrl = url;
  assert.equal(options.maxPayloadBytes, 24_000 * 2 * 30 * 60);
  const parsed = new URL(url);
  assert.equal(parsed.origin, "wss://api.deepseek.com");
  return createDeepSeekTtsSocket(`ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`, options);
};
function provider(overrides: Partial<DeepSeekSpeechProviderOptions> = {}) {
  return createDeepSeekSpeechProvider({
    getConnection: () => connection, transport: () => "websocket", createWebSocket: socketFactory,
    fetch: (async () => { fetchCalls++; throw new Error("No HTTP fallback is allowed"); }) as typeof fetch,
    ...overrides,
  });
}
function speak(text = "Hello from DeepSeek.", overrides: Partial<ToolExecutionContext> = {}, options: Partial<DeepSeekSpeechProviderOptions> = {}) {
  return provider(options).textToSpeech!({ text }, { ...context, ...overrides });
}
function collect() {
  const events: SpeechProviderAudioEvent[] = [];
  return { events, audioStream: (event: SpeechProviderAudioEvent) => events.push(event) };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, error => error instanceof ApiProviderError && error.code === code && !error.message.includes("fixture-secret"));
}
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  handshake = "accept"; onUpgrade = undefined; onPeer = () => undefined; peers.length = 0; socketCalls = 0; fetchCalls = 0;
  await run();
  assert.equal(fetchCalls, 0, "WebSocket failures must not issue a duplicate HTTP request");
  passed++; console.log(`PASS ${name}`);
}

try {
  await check("Unicode text chunks round-trip without splitting code points", async () => {
    const text = "中🙂a\n".repeat(1_000);
    const chunks = deepSeekTtsTextChunks(text);
    assert(chunks.length > 1); assert.equal(chunks.join(""), text);
    for (const chunk of chunks) { assert(Buffer.byteLength(chunk) <= 1_024); assert(!/[\uD800-\uDBFF]$/.test(chunk)); }
  });

  await check("Authenticated real WebSocket emits early aligned PCM and materializes a complete WAV", async () => {
    const text = "你好 🙂 and hello. ".repeat(200).trim();
    const audio = Buffer.alloc(65_536);
    for (let offset = 0; offset < audio.length; offset += 2) audio.writeInt16LE((offset % 32_768) - 16_384, offset);
    let finish!: () => void;
    const chunks: Buffer[] = [];
    const events: SpeechProviderAudioEvent[] = [];
    let firstChunk!: () => void;
    const first = new Promise<void>(resolve => { firstChunk = resolve; });
    let complete = false;
    onPeer = peer => { peer.onFinishText = () => {
      assert.equal(peer.request.headers.authorization, "Bearer fixture-secret-never-log");
      assert.equal(peer.request.headers["sec-websocket-protocol"], undefined);
      assert.equal(peer.messages.filter(item => item.event === "finish_text").length, 1);
      assert.equal(peer.messages.filter(item => item.event === "text").map(item => item.text).join(""), text);
      assert(peer.messages.length > 2);
      peer.audio(audio.subarray(0, 1)); peer.audio(audio.subarray(1, 4)); peer.audio(audio.subarray(4));
      finish = () => peer.finish();
    }; };
    const active = provider().textToSpeech!({ text, voice: "tide" }, { ...context, audioStream(event) {
      events.push(event);
      if (event.type === "chunk") {
        assert.equal(event.audio.length % 2, 0); assert(event.audio.length <= 48 * 1024);
        chunks.push(Buffer.from(event.audio)); event.audio.fill(0); firstChunk();
      }
    } }).then(value => { complete = true; return value; });
    await first;
    assert.equal(complete, false, "Audio must be available before synthesis finishes");
    assert.equal(new URL(lastSocketUrl).searchParams.get("voice_id"), "tide");
    assert.equal(new URL(lastSocketUrl).searchParams.get("format"), "pcm");
    assert.equal(new URL(lastSocketUrl).searchParams.get("filter_markdown"), "true");
    assert(!lastSocketUrl.includes("fixture-secret"));
    finish();
    const result = await active;
    const wav = Buffer.from(result.items[0].bytes!);
    assert.equal(wav.toString("ascii", 0, 4), "RIFF"); assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt "); assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16); assert.equal(wav.readUInt32LE(40), audio.length);
    assert.deepEqual(wav.subarray(44), audio); assert.deepEqual(Buffer.concat(chunks), audio);
    assert.equal(result.items[0].durationSeconds, audio.length / 48_000); assert.equal(result.items[0].mimeType, "audio/wav");
    assert.equal(result.metadata?.transport, "websocket"); assert.equal(events[0].type, "start"); assert.equal(events.at(-1)?.type, "finish");
    assert.equal(socketCalls, 1);
  });

  await check("Server ping is answered while synthesis is pending", async () => {
    let pong = false;
    onPeer = peer => { peer.onFinishText = () => {
      peer.onPong = () => { pong = true; peer.audio(Buffer.from([1, 0])); peer.finish(); };
      peer.socket.write(frame(9, Buffer.from("keepalive")));
    }; };
    await speak(); assert.equal(pong, true);
  });

  await check("Normal close without a finish event is a failed synthesis", async () => {
    const events = collect();
    onPeer = peer => { peer.onFinishText = () => { peer.audio(Buffer.from([1, 0])); peer.close(); }; };
    await rejectsCode(speak(undefined, events), "response");
    assert.equal(events.events.at(-1)?.type, "error"); assert(!events.events.some(event => event.type === "finish"));
  });

  await check("An abrupt disconnect after audio cannot produce a success artifact", async () => {
    onPeer = peer => { peer.onFinishText = () => { peer.audio(Buffer.from([1, 0])); peer.socket.destroy(); }; };
    await assert.rejects(speak(), error => error instanceof ApiProviderError && ["transport", "response"].includes(error.code));
  });

  await check("A late upstream error fails the stream without disclosing its message", async () => {
    const events = collect();
    onPeer = peer => { peer.onFinishText = () => { peer.audio(Buffer.from([1, 0])); peer.finish("content_filter", "fixture-secret-never-log"); }; };
    await rejectsCode(speak(undefined, events), "content_filter");
    assert(events.events.some(event => event.type === "chunk"));
    assert(!JSON.stringify(events.events).includes("fixture-secret"));
    assert.equal(events.events.at(-1)?.type, "error"); assert.equal(socketCalls, 1);
  });

  await check("Empty and partial-sample success messages are rejected", async () => {
    onPeer = peer => { peer.onFinishText = () => peer.finish(); };
    await rejectsCode(speak(), "format");
    onPeer = peer => { peer.onFinishText = () => { peer.audio(Buffer.from([1, 2, 3])); peer.finish(); }; };
    await rejectsCode(speak(), "format");
  });

  await check("Malformed and unknown terminal control messages remain failures", async () => {
    for (const message of ["{", "[]", '{"event":"other"}', '{"event":"finish","code":"__proto__","message":"fixture-secret"}']) {
      onPeer = peer => { peer.onFinishText = () => peer.rawText(message); };
      await rejectsCode(speak(), "response");
    }
  });

  await check("Pre-cancelled requests and cancellation during resolution create no sockets", async () => {
    const first = new AbortController(); first.abort("fixture-secret");
    await rejectsCode(speak(undefined, { signal: first.signal }), "cancelled");
    const resolving = new AbortController();
    await rejectsCode(speak(undefined, { signal: resolving.signal }, { getConnection: async () => { resolving.abort(); return connection; } }), "cancelled");
    assert.equal(socketCalls, 0);
  });

  await check("Cancellation stops an incomplete handshake", async () => {
    handshake = "hang";
    const controller = new AbortController();
    onUpgrade = () => controller.abort("fixture-secret");
    const events = collect();
    await rejectsCode(speak(undefined, { ...events, signal: controller.signal }), "cancelled");
    assert.equal(events.events.at(-1)?.type, "error");
  });

  await check("Cancellation destroys a socket whose TLS handshake has not finished", async () => {
    const controller = new AbortController();
    let accepted: Socket | undefined;
    let closed!: () => void;
    const close = new Promise<void>(resolve => { closed = resolve; });
    const tcp = createTcpServer(socket => {
      accepted = socket;
      socket.on("error", () => undefined);
      socket.once("close", closed);
      // Read ClientHello but deliberately never send ServerHello.
      socket.once("data", () => controller.abort());
    });
    tcp.listen(0, "127.0.0.1"); await once(tcp, "listening");
    try {
      const tlsPort = (tcp.address() as AddressInfo).port;
      await rejectsCode(speak(undefined, { signal: controller.signal }, {
        createWebSocket: (_url, options) => createDeepSeekTtsSocket(`wss://127.0.0.1:${tlsPort}/v1/tools/tts`, options),
      }), "cancelled");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([close, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Cancelled TLS socket remained open")), 500); })]);
      } finally { clearTimeout(timer); }
    } finally {
      accepted?.destroy();
      await new Promise<void>(resolve => tcp.close(() => resolve()));
    }
  });

  await check("Cancelling one request leaves another concurrent stream usable", async () => {
    const controller = new AbortController();
    const firstEvents = collect();
    onPeer = peer => { peer.onFinishText = () => {
      peer.audio(Buffer.from([1, 0, 2, 0]));
      if (peer.messages.some(message => message.text === "second")) peer.finish();
    }; };
    const first = speak("first", { signal: controller.signal, audioStream(event) {
      firstEvents.audioStream(event);
      if (event.type === "chunk") controller.abort();
    } });
    const second = speak("second");
    await rejectsCode(first, "cancelled");
    assert.equal((await second).items[0].durationSeconds, 2 / 24_000);
    assert(!firstEvents.events.some(event => event.type === "finish")); assert.equal(socketCalls, 2);
  });

  await check("Handshake and post-audio timeouts terminate the request", async () => {
    const timed = { getConnection: () => ({ ...connection, timeoutMs: 50 }) };
    handshake = "hang"; await rejectsCode(speak(undefined, {}, timed), "timeout");
    handshake = "accept";
    const events = collect();
    onPeer = peer => { peer.onFinishText = () => peer.audio(Buffer.from([1, 0])); };
    await rejectsCode(speak(undefined, events, timed), "timeout");
    assert(events.events.some(event => event.type === "chunk")); assert.equal(events.events.at(-1)?.type, "error");
  });

  await check("Authentication failures and redirects do not fall back or disclose credentials", async () => {
    handshake = "unauthorized"; await rejectsCode(speak(), "transport");
    handshake = "redirect"; await rejectsCode(speak(), "transport"); assert.equal(socketCalls, 2);
  });

  await check("Protocol payload caps reject an oversized declared audio frame before buffering it", async () => {
    onPeer = peer => { peer.onFinishText = () => peer.socket.write(frame(2, Buffer.alloc(0), DEEPSEEK_TTS_MAX_PCM_BYTES + 1)); };
    await assert.rejects(speak(), error => error instanceof ApiProviderError && ["limit", "transport"].includes(error.code));
  });

  await check("Text limits, unsupported format, and unofficial roots fail before opening a socket", async () => {
    await rejectsCode(speak("中".repeat(5_001)), "limit");
    await rejectsCode(provider().textToSpeech!({ text: "hello", format: "mp3" }, context), "unsupported");
    await rejectsCode(speak("hello", {}, { getConnection: () => ({ ...connection, baseUrl: "http://api.deepseek.com" }) }), "configuration");
    assert.equal(socketCalls, 0);
  });

  await check("Playback callback failure closes synthesis and does not echo the callback error", async () => {
    onPeer = peer => { peer.onFinishText = () => { peer.audio(Buffer.from([1, 0])); peer.finish(); }; };
    await rejectsCode(speak(undefined, { audioStream(event) { if (event.type === "chunk") throw new Error("fixture-secret"); } }), "playback");
  });

  await check("Accumulated PCM is bounded across many individually valid frames", async () => {
    let disposed = 0;
    const factory: DeepSeekTtsSocketFactory = () => {
      const socket: DeepSeekTtsSocket = {
        binaryType: "arraybuffer", readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null,
        close() {}, send(text) {
          if (JSON.parse(text).event === "finish_text") queueMicrotask(() => {
            const chunk = new ArrayBuffer(1024 * 1024);
            for (let i = 0; i <= DEEPSEEK_TTS_MAX_PCM_BYTES / chunk.byteLength && socket.onmessage; i++) socket.onmessage(new MessageEvent("message", { data: chunk }));
          });
        },
      };
      queueMicrotask(() => socket.onopen?.(new Event("open")));
      return { socket, dispose() { disposed++; } };
    };
    await rejectsCode(speak(undefined, {}, { createWebSocket: factory }), "limit"); assert.equal(disposed, 1);
  });

  await check("Streaming support reflects the selected mode while HTTP WAV remains available", async () => {
    let transport: "http" | "websocket" = "http";
    const wav = Buffer.alloc(46); wav.write("RIFF", 0); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24_000, 24);
    wav.writeUInt32LE(48_000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40);
    let httpCalls = 0;
    const speech = provider({ transport: () => transport, fetch: (async () => { httpCalls++; return new Response(wav, { headers: { "content-type": "audio/wav" } }); }) as typeof fetch });
    const events = collect();
    assert.equal(speech.supportsAudioStreaming, false);
    assert.equal((await speech.textToSpeech!({ text: "Hello" }, { ...context, ...events })).items[0].mimeType, "audio/wav");
    assert.equal(httpCalls, 1); assert.equal(events.events.length, 0); assert.equal(socketCalls, 0);
    transport = "websocket"; assert.equal(speech.supportsAudioStreaming, true);
  });

  console.log(`DeepSeek streaming TTS: ${passed} behavior groups passed`);
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
