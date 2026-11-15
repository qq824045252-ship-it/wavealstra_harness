import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeepSeekSpeechProvider, deepSeekSpeechCharacterCount } from "../src/main/capabilities/providers/DeepSeekSpeechProvider";
import { createDeepSeekOcrAdapter } from "../src/main/capabilities/providers/DeepSeekOcrProvider";
import { ApiProviderError, type ApiProviderOptions, type ResolvedApiConnection } from "../src/main/capabilities/providers/ApiServiceConnection";
import type { ToolExecutionContext } from "../src/main/capabilities/BuiltinCapabilityRuntime";

function wav(durationMs = 1_000, sampleRate = 16_000, channels = 1): Buffer {
  const length = Math.round(durationMs / 1_000 * sampleRate) * channels * 2;
  const bytes = Buffer.alloc(44 + length);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(length, 40);
  return bytes;
}
function oggPage(payload: Buffer, flags: number, granule: bigint, sequence: number): Buffer {
  assert(payload.length < 255);
  const header = Buffer.alloc(28);
  header.write("OggS"); header[5] = flags; header.writeBigUInt64LE(granule, 6);
  header.writeUInt32LE(1, 14); header.writeUInt32LE(sequence, 18); header[26] = 1; header[27] = payload.length;
  return Buffer.concat([header, payload]);
}
function opus(durationMs = 1_000): Buffer {
  const head = Buffer.alloc(19); head.write("OpusHead"); head[8] = 1; head[9] = 1;
  head.writeUInt16LE(312, 10); head.writeUInt32LE(48_000, 12);
  return Buffer.concat([oggPage(head, 2, 0n, 0), oggPage(Buffer.from([0xf8, 0xff, 0xfe]), 4, BigInt(durationMs * 48 + 312), 1)]);
}

const temporary = await mkdtemp(join(tmpdir(), "mybuddy-deepseek-media-"));
const taskRoot = join(temporary, "task"); await mkdir(taskRoot);
const context: ToolExecutionContext = { taskId: "fixture-task", taskRoot, toolCallId: "fixture-tool" };
const captures: Array<{ url: string; init: RequestInit }> = [];
let responder: (url: string, init: RequestInit) => Promise<Response> = async () => { throw new Error("Unexpected fetch"); };
const connection: ResolvedApiConnection = { id: "api-deepseek-fixture", label: "DeepSeek fixture", protocol: "deepseek", baseUrl: "https://api.deepseek.com", timeoutMs: 2_000,
  headers: { Authorization: "Bearer fixture-key-never-log" } };
const options: ApiProviderOptions = { getConnection: () => connection, fetch: (async (url, init) => {
  captures.push({ url: String(url), init: init! }); return responder(String(url), init!);
}) as typeof fetch };
const speech = createDeepSeekSpeechProvider(options);
const ocr = createDeepSeekOcrAdapter(options);
let passed = 0;
async function check(name: string, run: () => Promise<void>) {
  captures.length = 0;
  await run(); passed++; console.log(`PASS ${name}`);
}
async function rejectsCode(run: Promise<unknown>, code: string) {
  await assert.rejects(run, error => error instanceof ApiProviderError && error.code === code);
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const audio = (bytes = wav(1_000, 24_000)) => new Response(new Uint8Array(bytes), { headers: { "content-type": "audio/wav", "x-request-id": "tts-fixture" } });
const goodOcr = (purpose: "text_recognition" | "rich_layout_recognition" = "text_recognition") => ({ id: "ocr-fixture", object: "ocr.result", purpose, page_count: 2,
  pages: [{ index: 0, text: "<｜ref｜>Title<｜/ref｜><｜box｜>[[1, 2, 990, 1000]]<｜/box｜>", finish_reason: "stop" }, { index: 1, text: "Second page", finish_reason: "length" }],
  usage: { input_tokens: 100, output_tokens: 25, total_tokens: 125 } });

try {
  await writeFile(join(taskRoot, "voice.wav"), wav());
  await writeFile(join(taskRoot, "voice.ogg"), opus());
  await writeFile(join(taskRoot, "document.pdf"), "%PDF-1.7\nfixture document for a mocked OCR service\n%%EOF");
  await writeFile(join(taskRoot, "picture.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=", "base64"));

  await check("ASR sends file only, needs no model and preserves returned timing", async () => {
    responder = async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/v1/tools/asr");
      assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-key-never-log");
      assert(init.body instanceof FormData); assert.deepEqual([...init.body.keys()], ["file"]);
      const file = init.body.get("file") as File; assert.equal(file.name, "audio.wav"); assert.equal(file.type, "audio/wav");
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), wav());
      return json({ text: "你好", duration_ms: 1_000, request_id: "asr-fixture" });
    };
    const result = await speech.speechToText!({ audioPath: "voice.wav" }, context);
    assert.equal(result.text, "你好"); assert.equal(result.metadata?.durationMs, 1_000); assert.equal(result.metadata?.requestId, "asr-fixture");
    assert.equal(result.language, undefined); assert.equal(result.segments, undefined); assert.equal(captures.length, 1);
  });
  await check("ASR accepts Ogg Opus and rejects incomplete or wrong-codec Ogg before uploading", async () => {
    responder = async (_url, init) => { assert.equal((init.body as FormData).get("file") instanceof File, true); return json({ text: "Opus", duration_ms: 1_000, request_id: "opus" }); };
    await speech.speechToText!({ audioPath: "voice.ogg" }, context);
    const incomplete = opus(); incomplete[47 + 5] = 0; await writeFile(join(taskRoot, "incomplete.ogg"), incomplete);
    await rejectsCode(speech.speechToText!({ audioPath: "incomplete.ogg" }, context), "format");
    const vorbis = opus(); vorbis.write("vorbis!!", 28); await writeFile(join(taskRoot, "vorbis.ogg"), vorbis);
    await rejectsCode(speech.speechToText!({ audioPath: "vorbis.ogg" }, context), "format"); assert.equal(captures.length, 1);
  });
  await check("ASR validates actual PCM format, duration and 8 MiB size", async () => {
    await writeFile(join(taskRoot, "long.wav"), wav(120_001));
    await rejectsCode(speech.speechToText!({ audioPath: "long.wav" }, context), "limit");
    const floats = wav(); floats.writeUInt16LE(3, 20); await writeFile(join(taskRoot, "float.wav"), floats);
    await rejectsCode(speech.speechToText!({ audioPath: "float.wav" }, context), "format");
    await writeFile(join(taskRoot, "large.wav"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await rejectsCode(speech.speechToText!({ audioPath: "large.wav" }, context), "limit"); assert.equal(captures.length, 0);
  });
  await check("ASR rejects unsupported prompt/language and honors task paths", async () => {
    await rejectsCode(speech.speechToText!({ audioPath: "voice.wav", language: "zh" }, context), "unsupported");
    await rejectsCode(speech.speechToText!({ audioPath: "voice.wav", prompt: "names" }, context), "unsupported");
    await writeFile(join(temporary, "outside.wav"), wav());
    await rejectsCode(speech.speechToText!({ audioPath: "../outside.wav" }, context), "policy"); assert.equal(captures.length, 0);
  });
  await check("ASR does not report a provider error or malformed transcript as success", async () => {
    responder = async () => json({ error: { message: "private-key-never-echo" } });
    await assert.rejects(speech.speechToText!({ audioPath: "voice.wav" }, context), error => error instanceof ApiProviderError && !error.message.includes("private-key"));
    responder = async () => json({ text: "ok", duration_ms: "1000" });
    await rejectsCode(speech.speechToText!({ audioPath: "voice.wav" }, context), "response");
  });
  await check("TTS uses native fields and returns a complete playable WAV artifact", async () => {
    responder = async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/v1/tools/tts");
      assert.deepEqual(JSON.parse(String(init.body)), { text: "你好, world", voice_id: "tide", format: "wav", filter_markdown: true });
      return audio();
    };
    const result = await speech.textToSpeech!({ text: "你好, world", voice: "tide" }, context);
    assert.equal(result.items[0].mimeType, "audio/wav"); assert.equal(result.items[0].durationSeconds, 1);
    assert.equal(result.requestId, "tts-fixture"); assert.equal(result.model, undefined); assert.equal(result.metadata?.billableCharacters, 11);
  });
  await check("TTS defaults to Stella and rejects unsupported voice/speed/container without a request", async () => {
    responder = async (_url, init) => { assert.equal(JSON.parse(String(init.body)).voice_id, "stella"); return audio(); };
    await speech.textToSpeech!({ text: "hello" }, context); assert.equal(captures.length, 1);
    await rejectsCode(speech.textToSpeech!({ text: "hello", voice: "alloy" }, context), "unsupported");
    await rejectsCode(speech.textToSpeech!({ text: "hello", rate: "1.5" }, context), "unsupported");
    await rejectsCode(speech.textToSpeech!({ text: "hello", format: "mp3" }, context), "unsupported"); assert.equal(captures.length, 1);
  });
  await check("TTS enforces billed character count and detects truncated WAV", async () => {
    assert.equal(deepSeekSpeechCharacterCount("中A🙂"), 4);
    await rejectsCode(speech.textToSpeech!({ text: "中".repeat(5_001) }, context), "limit"); assert.equal(captures.length, 0);
    responder = async () => audio(wav().subarray(0, 100));
    await rejectsCode(speech.textToSpeech!({ text: "hello" }, context), "format");
    responder = async () => new Response("{\"error\":{}}", { headers: { "content-type": "application/json" } });
    await rejectsCode(speech.textToSpeech!({ text: "hello" }, context), "response");
  });
  await check("TTS accepts sample-aligned streamed WAV and rejects partial samples", async () => {
    const bytes = wav(); bytes.writeUInt32LE(0xffffffff, 4); bytes.writeUInt32LE(0xffffffff, 40);
    responder = async () => audio(bytes);
    assert.equal((await speech.textToSpeech!({ text: "hello" }, context)).items[0].durationSeconds, 1);
    responder = async () => audio(bytes.subarray(0, bytes.length - 1));
    await rejectsCode(speech.textToSpeech!({ text: "hello" }, context), "format");
  });
  await check("OCR sends purpose then file only and retains page truncation and normalized tokens", async () => {
    responder = async (url, init) => {
      assert.equal(url, "https://api.deepseek.com/v1/tools/ocr"); assert(init.body instanceof FormData);
      assert.deepEqual([...init.body.keys()], ["purpose", "file"]); assert.equal(init.body.get("purpose"), "text_recognition");
      const file = init.body.get("file") as File; assert.equal(file.name, "document.pdf"); assert.equal(file.type, "application/pdf");
      return new Response(`\n\n${JSON.stringify(goodOcr())}`, { headers: { "content-type": "application/json" } });
    };
    const result = await ocr.recognize("document.pdf", context);
    assert.equal(result.pageCount, 2); assert.equal(result.truncated, true); assert.equal(result.pages?.[1].finishReason, "length");
    assert(result.text.includes("Page 2 (incomplete)")); assert(result.pages?.[0].text.includes("<｜box｜>")); assert.equal(result.boxes, undefined);
    assert.equal(result.metadata?.coordinateSpace, "page-normalized-0-1000"); assert.equal(result.metadata?.billablePages, 2);
  });
  await check("OCR uses selected rich-layout purpose and validates bytes before upload", async () => {
    responder = async (_url, init) => { assert.equal((init.body as FormData).get("purpose"), "rich_layout_recognition"); return json(goodOcr("rich_layout_recognition")); };
    await createDeepSeekOcrAdapter({ ...options, purpose: () => "rich_layout_recognition" }).recognize("picture.png", context);
    await writeFile(join(taskRoot, "fake.pdf"), "not a PDF");
    await rejectsCode(ocr.recognize("fake.pdf", context), "format"); assert.equal(captures.length, 1);
  });
  await check("OCR uploads real Word and PowerPoint fixtures using native file input", async () => {
    for (const [name, mime] of [
      ["docx-simple.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
      ["pptx-simple.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ]) {
      await copyFile(join("fixtures/artifacts/synthetic/office", name), join(taskRoot, name));
      responder = async (_url, init) => {
        const file = (init.body as FormData).get("file") as File;
        assert.equal(file.type, mime); assert.equal(file.name, `document.${name.split(".").at(-1)}`);
        return json({ ...goodOcr(), page_count: 1, pages: [{ index: 0, text: "Office document", finish_reason: "stop" }] });
      };
      const result = await ocr.recognize(name, context); assert.equal(result.truncated, false); assert.equal(result.pageCount, 1);
    }
    assert.equal(captures.length, 2);
  });
  await check("OCR never turns HTTP 200 error into empty success", async () => {
    responder = async () => json({ error: { code: "gateway_timeout_error", message: "fixture-key-never-log" } });
    await assert.rejects(ocr.recognize("document.pdf", context), error => error instanceof ApiProviderError && /gateway_timeout_error/.test(error.message) && !error.message.includes("fixture-key"));
  });
  await check("OCR rejects duplicate/missing pages and mismatched purpose", async () => {
    const duplicate = goodOcr(); duplicate.pages[1].index = 0; responder = async () => json(duplicate);
    await rejectsCode(ocr.recognize("document.pdf", context), "response");
    responder = async () => json({ ...goodOcr(), page_count: 3 }); await rejectsCode(ocr.recognize("document.pdf", context), "response");
    responder = async () => json(goodOcr("rich_layout_recognition")); await rejectsCode(ocr.recognize("document.pdf", context), "response");
  });
  await check("Cancellation before upload makes no request, during OCR does not claim remote cancellation", async () => {
    const already = new AbortController(); already.abort();
    await rejectsCode(ocr.recognize("document.pdf", { ...context, signal: already.signal }), "cancelled"); assert.equal(captures.length, 0);
    const pending = new AbortController();
    responder = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); pending.abort();
    });
    await assert.rejects(ocr.recognize("document.pdf", { ...context, signal: pending.signal }), error => error instanceof ApiProviderError && error.code === "cancelled" && /may still finish/.test(error.message));
    assert.equal(captures.length, 1);
  });
  await check("Speech cancellation after a response arrives cannot produce a transcript or artifact", async () => {
    const ttsCancelled = new AbortController();
    responder = async () => { ttsCancelled.abort(); return audio(); };
    await rejectsCode(speech.textToSpeech!({ text: "hello" }, { ...context, signal: ttsCancelled.signal }), "cancelled");
    const asrCancelled = new AbortController();
    responder = async () => { asrCancelled.abort(); return json({ text: "complete response", duration_ms: 1_000 }); };
    await rejectsCode(speech.speechToText!({ audioPath: "voice.wav" }, { ...context, signal: asrCancelled.signal }), "cancelled");
    assert.equal(captures.length, 2);
  });
  await check("OCR timeout reports that the received request may still finish remotely", async () => {
    responder = async (_url, init) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new Error("fixture-key-never-log")), { once: true });
    });
    const timed = createDeepSeekOcrAdapter({ ...options, getConnection: () => ({ ...connection, timeoutMs: 10 }) });
    await assert.rejects(timed.recognize("document.pdf", context), error => error instanceof ApiProviderError && error.code === "timeout" && /may still finish/.test(error.message) && !error.message.includes("fixture-key"));
    assert.equal(captures.length, 1);
  });
  await check("HTTP errors and body-stream interruption never produce success artifacts", async () => {
    responder = async () => new Response("unauthorized", { status: 401 });
    await rejectsCode(speech.textToSpeech!({ text: "hello" }, context), "authentication");
    responder = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(wav().subarray(0, 60))); controller.error(new Error("fixture-key-never-log")); } }), { headers: { "content-type": "audio/wav" } });
    await rejectsCode(speech.textToSpeech!({ text: "hello" }, context), "transport");
  });
  console.log(`DeepSeek native media: ${passed} behavior groups passed`);
} finally { await rm(temporary, { recursive: true, force: true }); }
