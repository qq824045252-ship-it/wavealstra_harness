import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHttpSpeechProvider, HTTP_ASR_MAX_BYTES, HTTP_ASR_MAX_SECONDS } from "../src/main/capabilities/HttpSpeechProvider";
import { createHttpOcrAdapter } from "../src/main/capabilities/HttpOcrProvider";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";

export async function checkHttpRecognition(root: string): Promise<void> {
  let calls = 0, status = 200, delay = false;
  const server = createServer(async (req, res) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    assert.equal(req.headers.authorization, "Bearer test-secret");
    if (req.url === "/asr") {
      assert(body.includes('name="language"\r\n\r\nzh'));
      assert(body.includes('name="prompt"\r\n\r\n洪彬 12.50'));
      assert(body.includes("RIFF"));
      assert(!body.includes(root));
    } else { assert.equal(JSON.parse(body).model, "mock"); }
    if (delay) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ text: "洪彬 Hello 12.50", language: "zh", segments: [{ start: 0, end: 1, text: "洪彬 Hello 12.50" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const store = new BuiltinCapabilityStore(join(root, "recognition-config.json"));
    const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    config.speechToText = { enabled: true, provider: "http-asr", serviceId: "test" };
    config.services = { test: { adapter: "http-asr", endpoint: `http://127.0.0.1:${port}/asr`, model: "mock", credentialRef: "test", location: "local", dataPolicy: "allow-cloud", timeoutMs: 1000 } };
    store.write(config);
    const runtime = new BuiltinCapabilityRuntime({ store: new BuiltinCapabilityStore(store.path), credentials: { has: () => true, get: () => "test-secret", set() {}, clear() {} } });
    const provider = createHttpSpeechProvider(runtime);
    const wav = Buffer.alloc(44 + 32000);
    wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32000, 40);
    const audioPath = join(root, "short.wav"); writeFileSync(audioPath, wav);
    const input = { audioPath, language: "zh", prompt: "洪彬 12.50" };
    const context = { taskId: "test", taskRoot: root, toolCallId: "test" };
    assert.equal((await provider.speechToText!(input, context)).text, "洪彬 Hello 12.50");
    assert.equal(runtime.config().services?.test.endpoint, config.services.test.endpoint, "restart preserves selected service");
    for (const code of [401, 429]) { status = code; await assert.rejects(provider.speechToText!(input, context), code === 401 ? /authentication/ : /rate-limit/); }
    status = 200;
    const before = calls;
    config.speechToText.enabled = false; store.write(config);
    await assert.rejects(provider.speechToText!(input, context), /disabled/);
    config.speechToText.enabled = true; config.services.test.dataPolicy = "local-only"; config.services.test.location = "cloud"; store.write(config);
    assert.throws(() => runtime.assertRecognitionAgentPolicy("speech-to-text"), /policy/);
    await assert.rejects(provider.speechToText!(input, context), /policy/);
    assert.equal(calls, before, "disabled/policy must upload nothing");
    config.speechToText.provider = "local-whisper"; store.write(config);
    assert.doesNotThrow(() => runtime.assertRecognitionAgentPolicy("speech-to-text"), "local-whisper ignores leftover recognition serviceId");
    config.speechToText.provider = "http-asr";
    config.services.test.dataPolicy = "allow-cloud"; config.services.test.location = "local"; store.write(config);
    const long = Buffer.alloc(44 + 32000 * (HTTP_ASR_MAX_SECONDS + 1)); wav.copy(long, 0, 0, 44); long.writeUInt32LE(long.length - 44, 40); writeFileSync(audioPath, long);
    await assert.rejects(provider.speechToText!(input, context), /120 seconds/);
    writeFileSync(audioPath, Buffer.alloc(HTTP_ASR_MAX_BYTES + 1)); await assert.rejects(provider.speechToText!(input, context), /10 MiB/);
    assert.equal(calls, before);
    writeFileSync(audioPath, wav);
    delay = true; config.services.test.timeoutMs = 30; store.write(config);
    await assert.rejects(provider.speechToText!(input, context), /timeout/);
    const abort = new AbortController(); abort.abort();
    await assert.rejects(provider.speechToText!(input, { ...context, signal: abort.signal }), /cancelled/);
    delay = false;
    config.ocr = { enabled: true, serviceId: "ocr" }; config.services.ocr = { ...config.services.test, adapter: "http-ocr", endpoint: `http://127.0.0.1:${port}/ocr`, timeoutMs: 1000 }; store.write(config);
    const image = join(root, "image.png"); writeFileSync(image, Buffer.from("mock image bytes"));
    const ocr = await createHttpOcrAdapter(runtime).recognize(image, context);
    assert.equal(ocr.text, "洪彬 Hello 12.50"); assert.equal(ocr.boxes, undefined, "never fabricate boxes");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
