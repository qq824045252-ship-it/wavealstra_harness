import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { readOnlyCodingTag } from "../../../shared/pstack/coding-tags";
import { checked, failure, owner, runSettings, state, success, type WorkflowOptions } from "./PstackState";
import { digest, guardedWorkspaceTarget } from "./PstackDecisionFile";
import { checkAdvancedArtifact, currentAdvancedMethod, inspectAdvancedFile, videoManifestSchema, videoPlanDigest, videoReceiptMemo, videoReceiptSchema, type AdvancedFile, type VideoInspectionReceipt } from "./PstackAdvancedArtifacts";

const exec = promisify(execFile), width = 160, height = 90, stride = width * height * 3, fps = 3, maxDuration = 300;
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const words = (text: string) => [...segmenter.segment(text)].filter(segment => segment.isWordLike).length;

async function media(command: "ffmpeg" | "ffprobe", args: string[], signal?: AbortSignal, maxBuffer = 4 * 1024 * 1024) {
  try {
    return (await exec(command, args, { encoding: "buffer", windowsHide: true, timeout: 120000, maxBuffer, signal })).stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw Error(command + " is unavailable. Install ffmpeg with ffprobe and make both available to MyBuddy, then rerun inspection.");
    throw error;
  }
}

async function saveFrame(cwd: string, path: string, bytes: Buffer, signal?: AbortSignal): Promise<AdvancedFile> {
  const target = await guardedWorkspaceTarget(cwd, path, true);
  if (!target.info) {
    const handle = await open(target.path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { signal?.throwIfAborted(); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  const file = await inspectAdvancedFile(cwd, path, "artifact", { signal });
  if (file.digest !== digest(bytes)) throw Error("An existing frame was preserved: " + path + ". Start a new inspection.");
  return { path: file.path, digest: file.digest, role: "artifact" };
}

/** Decode the actual video, classify its frames against the composed slide
 * images, and measure the longest matching interval for each slide. This is
 * media evidence only; the caller must still read the full-resolution frames. */
export async function inspectVideoArtifact(options: {
  cwd: string; artifact: string; workflowRun: number; taskId: number; signal?: AbortSignal;
}): Promise<VideoInspectionReceipt> {
  const { cwd, signal } = options;
  const manifestFile = await inspectAdvancedFile(cwd, options.artifact, "artifact", { signal, text: true });
  const manifest = videoManifestSchema.parse(JSON.parse(manifestFile.text!));
  if (!/\.mp4$/i.test(manifest.video)) throw Error("The delivered ketchup video must be an MP4.");
  const video = await inspectAdvancedFile(cwd, manifest.video, "artifact", { signal });
  const probe = JSON.parse((await media("ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "mov", "-show_streams", "-show_format", "-of", "json", video.absolutePath], signal)).toString("utf8")) as {
    streams?: { codec_type?: string; width?: number; height?: number }[]; format?: { duration?: string; format_name?: string };
  };
  const tracks = probe.streams?.filter(stream => stream.codec_type === "video") ?? [], stream = tracks[0], duration = Number(probe.format?.duration);
  if (tracks.length !== 1 || !stream?.width || !stream.height || stream.width <= stream.height || !Number.isFinite(duration) || duration <= 0 || duration > maxDuration ||
    !probe.format?.format_name?.split(",").includes("mp4") || probe.streams?.some(track => track.codec_type === "audio"))
    throw Error("Expected one playable landscape video track, no audio, MP4 container and a duration of at most 300 seconds.");
  const files: AdvancedFile[] = [{ path: video.path, digest: video.digest, role: "artifact" }], references: Buffer[] = [], minimums: number[] = [];
  let end = 0;
  for (const [index, slide] of manifest.slides.entries()) {
    const minimum = Math.max(1, words(slide.subtitle + " " + slide.onScreenText) / 3);
    if (Math.abs(slide.startSeconds - end) > 0.05 || slide.endSeconds <= slide.startSeconds || slide.endSeconds - slide.startSeconds + 0.01 < minimum)
      throw Error("Slide " + (index + 1) + " must continue the timeline and hold for at least " + minimum.toFixed(2) + " seconds for its new text.");
    if (words(slide.subtitle) > 18) throw Error("Keep slide " + (index + 1) + " subtitle short (about 10 words; at most 18).");
    if (!/\.png$/i.test(slide.image)) throw Error("Use the final composed PNG, including the subtitle, for each slide.");
    const image = await inspectAdvancedFile(cwd, slide.image, "artifact", { signal, maxBytes: 32 * 1024 * 1024 });
    if (files.some(file => file.digest === image.digest)) throw Error("Each slide needs its own composed visual, including its subtitle.");
    const pixels = await media("ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "image2", "-pattern_type", "none", "-c:v", "png", "-i", image.absolutePath, "-vf", `scale=${width}:${height}`, "-frames:v", "1", "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], signal);
    if (pixels.length !== stride) throw Error("Cannot decode slide " + (index + 1) + ".");
    references.push(pixels); minimums.push(minimum); files.push({ path: image.path, digest: image.digest, role: "artifact" }); end = slide.endSeconds;
  }
  if (Math.abs(end - duration) > 1 / fps + 0.01) throw Error("The slide timeline does not cover the actual video duration.");
  const decoded = await media("ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", video.absolutePath, "-an", "-vf", `fps=${fps},scale=${width}:${height}`, "-threads", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], signal, Math.ceil((maxDuration + 1) * fps * stride));
  if (decoded.length % stride || decoded.length < stride) throw Error("The video did not decode into complete frames.");
  const count = decoded.length / stride, matches = new Int16Array(count).fill(-1);
  for (let frame = 0; frame < count; frame++) {
    if (frame % 20 === 0) await yieldToLoop();
    signal?.throwIfAborted();
    let closest = -1, error = Infinity;
    for (let slide = 0; slide < references.length; slide++) {
      let sum = 0;
      const reference = references[slide];
      for (let pixel = 0; pixel < stride; pixel++) sum += Math.abs(decoded[frame * stride + pixel] - reference[pixel]);
      const mean = sum / stride;
      if (mean < error) { error = mean; closest = slide; }
    }
    if (error <= 12) matches[frame] = closest;
  }
  const frames: VideoInspectionReceipt["frames"] = [];
  const parent = dirname(manifestFile.path).replaceAll("\\", "/"), prefix = (parent === "." ? "" : parent + "/") + "inspection-" + options.taskId;
  for (const [slideIndex, slide] of manifest.slides.entries()) {
    let bestStart = -1, bestLength = 0, start = -1;
    const first = Math.max(0, Math.floor(slide.startSeconds * fps)), last = Math.min(count, Math.ceil(slide.endSeconds * fps));
    for (let i = first; i <= last; i++) {
      if (i < last && matches[i] === slideIndex) {
        if (start < 0) start = i;
        if (i - start + 1 > bestLength) { bestStart = start; bestLength = i - start + 1; }
      } else start = -1;
    }
    const matchedSeconds = bestLength / fps;
    if (!bestLength || matchedSeconds + 1 / fps + 0.01 < minimums[slideIndex])
      throw Error("Actual video frames do not show slide " + (slideIndex + 1) + " long enough: matched " + matchedSeconds.toFixed(2) + "s, required " + minimums[slideIndex].toFixed(2) + "s. Inspect the render and transitions.");
    const seconds = Math.min(duration - 0.01, (bestStart + bestLength / 2) / fps);
    const png = await media("ffmpeg", ["-v", "error", "-nostdin", "-ss", seconds.toFixed(6), "-protocol_whitelist", "file,pipe", "-f", "mov", "-i", video.absolutePath, "-frames:v", "1", "-threads", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"], signal, 32 * 1024 * 1024);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error("Frame decoding did not produce a real PNG.");
    const frame = await saveFrame(cwd, prefix + "/slide-" + (slideIndex + 1) + ".png", png, signal);
    files.push(frame); frames.push({ path: frame.path, digest: frame.digest, slide: slideIndex, seconds, matchedSeconds });
  }
  const receipt: VideoInspectionReceipt = { version: 1, kind: "video-inspection", workflowRun: options.workflowRun, taskId: options.taskId,
    video: video.path, slidePlanDigest: videoPlanDigest(manifest), duration, width: stream.width, height: stream.height, files, frames };
  await checkAdvancedArtifact(receipt, { cwd, signal });
  return receipt;
}

export function createPstackVideoInspectTool(options: WorkflowOptions): ToolRegistration {
  return defineTool({ name: "pstack_video_inspect", replay: "safe", executionMode: "sequential",
    description: "Probe a real ketchup-video MP4, decode it, match the composed slides and measure readable hold times. Writes a full-resolution decoded PNG for each slide and returns its path. This verifies media integrity, not visual readability: read every returned image and record its real read task id in the manifest visualReview before delivery. Requires ffmpeg and ffprobe.",
    parameters: Type.Object({ artifact: Type.String({ description: "Task-relative version=1 ketchup-video JSON manifest with video and slide images/subtitles/onScreenText/startSeconds/endSeconds." }) }),
    async execute({ artifact }, api, ctx) {
      try {
        checked(options, ctx); await owner(api, ctx);
        const run = await state(api, ctx);
        if (!run || run.task !== options.taskId || run.phase !== "running" || readOnlyCodingTag(run.tagId) || !runSettings(run).skills["ketchup-video"]?.enabled || currentAdvancedMethod(run) !== "ketchup-video")
          throw Error("Video inspection requires an active owned workflow with ketchup-video enabled.");
        const cached = await api.memo<VideoInspectionReceipt>(videoReceiptMemo, ctx);
        if (cached) {
          const receipt = videoReceiptSchema.parse(cached);
          if (receipt.workflowRun !== run.run || receipt.taskId !== api.taskId) throw Error("The video receipt belongs to a different workflow.");
          await checkAdvancedArtifact(receipt, { cwd: options.cwd, signal: ctx.abortSignal });
          return success(receipt);
        }
        const receipt = await inspectVideoArtifact({ cwd: options.cwd, artifact, workflowRun: run.run, taskId: Number(api.taskId), signal: ctx.abortSignal });
        checked(options, ctx);
        const current = await state(api, ctx);
        if (current?.run !== run.run || current.task !== options.taskId || current.phase !== "running") throw Error("The owning workflow changed during video inspection.");
        await api.memo(videoReceiptMemo, receipt, ctx);
        return success(receipt);
      } catch (error) { ctx.abortSignal?.throwIfAborted(); return failure(error); }
    },
  });
}
