import assert from "node:assert/strict";
import { PcmStreamPlayer } from "../src/renderer/src/lib/PcmStreamPlayer";
import { SpeechStreamRegistry } from "../src/renderer/src/lib/speechStreams";
import type { SpeechAudioEvent } from "../src/shared/speech-stream";

class FakeSource {
  buffer?: { duration: number };
  onended: (() => void) | null = null;
  startAt?: number;
  stopped = false;
  disconnected = false;
  connect() {}
  disconnect() { this.disconnected = true; }
  start(when: number) { this.startAt = when; }
  stop() { this.stopped = true; }
  finish() { this.onended?.(); }
}
class FakeAudioContext {
  currentTime = 10;
  destination = {};
  resumed = 0;
  suspended = 0;
  closed = 0;
  sources: FakeSource[] = [];
  buffers: Float32Array[] = [];
  async resume() { this.resumed++; }
  async suspend() { this.suspended++; }
  async close() { this.closed++; }
  createBuffer(_channels: number, length: number, rate: number) {
    const values = new Float32Array(length); this.buffers.push(values);
    return { duration: length / rate, getChannelData: () => values };
  }
  createBufferSource() { const source = new FakeSource(); this.sources.push(source); return source; }
}
const contexts: FakeAudioContext[] = [];
const makePlayer = (maxFrames?: number) => new PcmStreamPlayer(24_000, () => {
  const context = new FakeAudioContext(); contexts.push(context); return context as unknown as AudioContext;
}, maxFrames);
const pcm = new Uint8Array([0, 128, 0, 0, 255, 127, 0, 64]);

const player = makePlayer();
player.append(pcm);
assert.equal(contexts.length, 0, "receiving audio never creates or autoplays an AudioContext");
assert.equal(player.getSnapshot().status, "idle");
await player.play();
const context = contexts[0];
assert.equal(player.getSnapshot().status, "playing");
assert.deepEqual([...context.buffers[0]], [-1, 0, 32767 / 32768, 0.5], "PCM is signed little-endian 16-bit");
player.append(pcm);
assert(Math.abs(context.sources[1].startAt! - context.sources[0].startAt! - 4 / 24_000) < 1e-8, "chunks share the audio clock without overlap");
player.pause();
assert.equal(player.getSnapshot().status, "paused");
assert.equal(context.suspended, 1);
player.append(pcm);
assert.equal(context.sources.length, 2, "new chunks remain silent while paused");
await player.play();
assert.equal(context.sources.length, 3);
context.sources.forEach(source => source.finish());
assert.equal(player.getSnapshot().status, "buffering", "network gaps have an explicit state");
context.currentTime = 20;
player.append(pcm);
assert.equal(context.sources[3].startAt, 20.025, "late audio resumes from the current audio clock");
player.complete();
assert.equal(player.getSnapshot().status, "playing", "remote completion does not cut queued audio short");
context.sources[3].finish();
assert.equal(player.getSnapshot().status, "ended");
assert.equal(player.retainedPcmBytes, 0, "consumed samples are released for long-running synthesis");
await player.play();
assert.equal(contexts.length, 1, "completed live samples are replayed from the saved WAV, not retained forever");
player.stop();
assert.equal(player.getSnapshot().status, "stopped");
assert.equal(context.closed, 1);
player.dispose();

const stopped = makePlayer();
stopped.append(pcm);
await stopped.play();
const stoppedContext = contexts.at(-1)!;
stopped.stop();
assert(stoppedContext.sources.every(source => source.stopped && source.disconnected));
stopped.append(pcm);
assert.equal(stoppedContext.sources.length, 1, "new chunks cannot restart stopped playback");
stopped.dispose();

const incomplete = makePlayer();
incomplete.append(new Uint8Array([1]));
assert.equal(incomplete.getSnapshot().status, "error");
assert.match(incomplete.getSnapshot().error!, /不完整/);
const bounded = makePlayer(2);
bounded.append(pcm);
assert.equal(bounded.getSnapshot().status, "error");
assert.match(bounded.getSnapshot().error!, /缓冲上限/);

let releaseResume!: () => void;
const waitingContext = new FakeAudioContext();
waitingContext.resume = () => new Promise<void>(resolve => { releaseResume = resolve; });
const waiting = new PcmStreamPlayer(24_000, () => waitingContext as unknown as AudioContext);
waiting.append(pcm);
const starting = waiting.play();
waiting.stop();
releaseResume();
await starting;
assert.equal(waitingContext.sources.length, 0, "a delayed resume cannot resurrect stopped playback");
waiting.dispose();

const registry = new SpeechStreamRegistry(() => makePlayer());
const scope = { taskId: "task-a", messageId: "message-a", toolCallId: "tool-a", streamId: "stream-a" };
const start: SpeechAudioEvent = { ...scope, kind: "start", format: "pcm_s16le", sampleRate: 24_000, channels: 1 };
const chunk: SpeechAudioEvent = { ...scope, kind: "chunk", sequence: 0, pcmBase64: Buffer.from(pcm).toString("base64") };
registry.ingest(chunk);
assert.equal(registry.get(scope), undefined, "a chunk cannot create a stream without a host start");
registry.ingest(start);
const entry = registry.get(scope)!;
registry.ingest({ ...chunk, taskId: "task-other" });
assert.equal(entry.bytes, 0, "events from another task cannot reach this player");
assert.equal(registry.get({ ...scope, messageId: "wrong" }), undefined);
registry.ingest(chunk);
registry.ingest(chunk);
assert.equal(entry.bytes, pcm.length, "duplicates do not repeat audible samples");
registry.ingest({ ...chunk, sequence: 2 });
assert.equal(entry.transport, "streaming", "a local preview failure does not claim remote synthesis has stopped");
assert.equal(entry.player.getSnapshot().status, "error");
assert.match(entry.player.getSnapshot().error!, /片段缺失/);
registry.ingest({ ...start, taskId: "another-task" });
assert.equal(registry.get(scope), entry, "stream ids cannot be rebound to another task");
registry.clear();

registry.ingest(start);
registry.ingest({ ...chunk, sequence: 1 });
assert.equal(registry.get(scope)!.player.getSnapshot().status, "error", "a missing first PCM chunk is never treated as a valid preview");
registry.clear();

registry.ingest(start);
registry.ingest(chunk);
const beforeCompletion = registry.get(scope)!;
registry.ingest({ ...scope, kind: "complete" });
assert.equal(beforeCompletion.player.getSnapshot().status, "idle", "a completed background stream never autoplays");
registry.ingest({ ...chunk, sequence: 1 });
assert.equal(beforeCompletion.bytes, pcm.length, "late chunks cannot alter a completed preview");
registry.clear();

registry.ingest(start);
registry.ingest(chunk);
const cancelled = registry.get(scope)!;
registry.ingest({ ...scope, kind: "cancelled" });
assert.equal(cancelled.transport, "cancelled");
assert.equal(cancelled.bytes, 0);
assert.match(cancelled.player.getSnapshot().error!, /已取消/);
registry.clear();
console.log("PASS speech stream player: gesture-only playback, PCM conversion, clock scheduling, pause/resume/replay/stop, cancellation races, strict scope and ordered bounded buffering");
