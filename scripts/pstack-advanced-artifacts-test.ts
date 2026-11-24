import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { checkAdvancedArtifact, inspectAdvancedArtifact, inspectAdvancedFile, validateVideoVisualReviews, type CheckSnapshots, type FormalManifest, type VideoManifest } from "../src/main/agent/pstack/PstackAdvancedArtifacts";
import { inspectVideoArtifact } from "../src/main/agent/pstack/PstackVideoInspection";
import type { PstackCheckReceipt } from "../src/main/agent/pstack/PstackVerificationEvidence";

const exec = promisify(execFile), cwd = await mkdtemp(join(tmpdir(), "mybuddy-pstack-artifacts-"));
const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const write = async (path: string, content: string | Buffer) => { await mkdir(join(cwd, path, ".."), { recursive: true }); await writeFile(join(cwd, path), content); };
async function commandResult() {
  try { const result = await exec(process.execPath, ["verification/check.cjs"], { cwd, windowsHide: true }); return { exitCode: 0, output: result.stdout + result.stderr }; }
  catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return { exitCode: result.code, output: result.stdout + result.stderr }; }
}
function receipt(id: number, fingerprint: string, result: Awaited<ReturnType<typeof commandResult>>, checkout: string): PstackCheckReceipt {
  return { checkIdentity: { version: 1, workflowRun: 10, operationTaskId: id, toolTaskId: id + 100, shell: "bash",
    beforeFingerprint: fingerprint, afterFingerprint: fingerprint, beforeCheckoutSha: checkout, afterCheckoutSha: checkout, checkoutSha: checkout, executionId: "native-" + id }, command: "node verification/check.cjs",
    toolTaskId: id + 100, passed: result.exitCode === 0, exitCode: result.exitCode, unchanged: true, emptySuite: false, fingerprint,
    output: { output: result.output, truncated: false }, ...(result.exitCode === 0 ? { outcome: "passed" as const } : { outcome: "command_failed" as const, error: "The assertion failed." }) };
}
try {
  await exec("git", ["init", "-q", "-b", "main"], { cwd, windowsHide: true });
  const original = "exports.next = n => n + 1;\n", broken = "exports.next = n => n - 1;\n";
  await write("src/counter.cjs", original);
  const secondaryCheck = "exports.property = value => value === 2;\n";
  await write("verification/secondary-check.cjs", secondaryCheck);
  await exec("git", ["add", "."], { cwd, windowsHide: true });
  await exec("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "fixture"], { cwd, windowsHide: true });
  const head = (await exec("git", ["rev-parse", "HEAD"], { cwd, windowsHide: true })).stdout.trim();
  await write("verification/check.cjs", "require('node:assert/strict').equal(require('../src/counter.cjs').next(1), 2, 'COUNTER_PROPERTY'); console.log('1 property checked');\n");
  await write("skills/check-counter/SKILL.md", "---\nname: check-counter\ndescription: Check the counter property against real implementation.\n---\nRun `node verification/check.cjs`. Sync commit: " + head + "\n");
  await write("src/counter.cjs", broken);
  const red = receipt(20, sha(broken), await commandResult(), head);
  assert.equal(red.exitCode, 1); assert.match(red.output.output, /COUNTER_PROPERTY/);
  await write("src/counter.cjs", original);
  const green = receipt(30, sha(original), await commandResult(), head);
  assert.equal(green.exitCode, 0);
  const helpers = { "verification/check.cjs": sha(await readFile(join(cwd, "verification/check.cjs"))) };
  const snapshots: CheckSnapshots = {
    [red.toolTaskId]: { fingerprint: red.fingerprint, coverageComplete: true, checkoutSha: head, fileDigests: { ...helpers, "src/counter.cjs": sha(broken) } },
    [green.toolTaskId]: { fingerprint: green.fingerprint, coverageComplete: true, checkoutSha: head, fileDigests: helpers },
  };
  const formal: FormalManifest = { version: 1, kind: "formal-verification", skillPath: "skills/check-counter/SKILL.md", syncCommit: head,
    tool: "Node assertion over actual implementation", toolVersion: process.versions.node, command: green.command,
    properties: ["next(1)=2"], bounds: ["one finite input; not a proof over all integers"], assumptions: ["synchronous function"],
    sources: [{ path: "src/counter.cjs", digest: sha(original), symbols: ["next"] }], verificationFiles: ["verification/check.cjs", "verification/secondary-check.cjs"],
    cleanCheckTaskId: green.toolTaskId, mutation: { checkTaskId: red.toolTaskId, sourcePath: "src/counter.cjs", description: "Subtract instead of adding", failureEvidence: "COUNTER_PROPERTY" } };
  const artifact = ".artifacts/formal.json";
  await write(artifact, JSON.stringify(formal));
  const options = { cwd, skillId: "create-formal-verification-skill", artifact, workflowRun: 10, checkReceipts: [red, green], checkSnapshots: snapshots };
  const checked = await inspectAdvancedArtifact(options);
  assert.equal(checked.formal?.cleanCheckTaskId, green.toolTaskId);
  assert.equal(checked.files.find(file => file.path === "src/counter.cjs")?.role, "input");
  await checkAdvancedArtifact(checked, { cwd });
  await assert.rejects(inspectAdvancedArtifact({ ...options, checkReceipts: [green] }), /native verify receipt/);
  await assert.rejects(inspectAdvancedArtifact({ ...options, checkSnapshots: { ...snapshots, [red.toolTaskId]: { ...snapshots[red.toolTaskId], fileDigests: helpers } } }), /actual mutation/);
  await assert.rejects(inspectAdvancedArtifact({ ...options, checkReceipts: [{ ...red, checkIdentity: { ...red.checkIdentity, executionId: undefined } }, green] }), /native verify receipt/);
  await assert.rejects(inspectAdvancedArtifact({ ...options, checkReceipts: [{ ...red, output: { output: "ModuleNotFoundError COUNTER_PROPERTY", truncated: false } }, green] }), /missing dependency/);
  await write("src/counter.cjs", broken);
  await assert.rejects(checkAdvancedArtifact(checked, { cwd }), /Verified pstack file changed/);
  await write(artifact, JSON.stringify({ ...formal, sources: [{ ...formal.sources[0], digest: sha(broken) }] }));
  await assert.rejects(inspectAdvancedArtifact(options), /File changed after the clean check/, "Updating the manifest cannot attach an old clean check to new source bytes omitted from the delta.");
  await write("src/counter.cjs", original);
  await write(artifact, JSON.stringify(formal));
  const originalCheck = await readFile(join(cwd, "verification/check.cjs"), "utf8");
  await write("verification/check.cjs", "console.log('an unconditional pass is not the checked helper');\n");
  await assert.rejects(inspectAdvancedArtifact(options), /File changed after the clean check/, "A check script changed after green must be rejected too.");
  await assert.rejects(inspectAdvancedArtifact({ ...options, checkSnapshots: { ...snapshots, [green.toolTaskId]: { ...snapshots[green.toolTaskId], fileDigests: {} } } }), /No checked Git file version/, "An untracked helper absent from the delta has no verified input version.");
  await write("verification/check.cjs", originalCheck);
  await write("verification/secondary-check.cjs", "exports.property = () => true;\n");
  await assert.rejects(inspectAdvancedArtifact(options), /File changed after the clean check/, "A tracked helper absent from the delta must be compared with its checked Git blob.");
  await write("verification/secondary-check.cjs", secondaryCheck);
  await write(artifact, JSON.stringify({ ...formal, verificationFiles: ["src/counter.cjs"] }));
  await assert.rejects(inspectAdvancedArtifact(options), /cannot relabel/);
  await write(artifact, JSON.stringify(formal));
  await assert.rejects(inspectAdvancedFile(cwd, "../escape.json", "artifact"), /相对路径/);
  const outside = await mkdtemp(join(tmpdir(), "mybuddy-pstack-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "not an authorized artifact");
    try {
      await symlink(outside, join(cwd, "redirect"), "dir");
      await assert.rejects(inspectAdvancedFile(cwd, "redirect/secret.txt", "artifact"), /redirected|路径越界/);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; }
  } finally { await rm(outside, { recursive: true, force: true }); }
  await write(".artifacts/fake-statechart.json", JSON.stringify({ version: 1, kind: "statechart", executionTaskId: 1234, scope: "Counter", assumptions: ["one input"], interpretation: "claimed pass" }));
  await assert.rejects(inspectAdvancedArtifact({ cwd, artifact: ".artifacts/fake-statechart.json", skillId: "statechart", workflowRun: 10 }));

  const mediaAvailable = await Promise.all(["ffmpeg", "ffprobe"].map(command => exec(command, ["-version"], { windowsHide: true }).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error;
  })));
  if (mediaAvailable.every(Boolean)) {
    await mkdir(join(cwd, ".artifacts/video"), { recursive: true });
    for (const [index, color, label] of [[1, "red", "Saved retry behavior"], [2, "blue", "Verified successful recovery"]] as const) {
      await exec("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=640x360`, "-vf", `drawbox=x=0:y=300:w=640:h=60:color=black:t=fill,drawtext=text='${label}':fontcolor=white:fontsize=24:x=20:y=320`, "-frames:v", "1", "-threads", "1", `.artifacts/video/slide-${index}.png`], { cwd, windowsHide: true });
    }
    await exec("ffmpeg", ["-v", "error", "-loop", "1", "-t", "3", "-i", ".artifacts/video/slide-1.png", "-loop", "1", "-t", "3", "-i", ".artifacts/video/slide-2.png", "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0,format=yuv420p[v]", "-map", "[v]", "-an", "-c:v", "libx264", "-threads", "1", ".artifacts/video/summary.mp4"], { cwd, windowsHide: true });
    const video: VideoManifest = { version: 1, kind: "ketchup-video", video: ".artifacts/video/summary.mp4", slides: [
      { image: ".artifacts/video/slide-1.png", subtitle: "Saved retry behavior", onScreenText: "Retry preserved", startSeconds: 0, endSeconds: 3 },
      { image: ".artifacts/video/slide-2.png", subtitle: "Verified successful recovery", onScreenText: "Recovery succeeded", startSeconds: 3, endSeconds: 6 },
    ] };
    const videoArtifact = ".artifacts/video/manifest.json";
    await write(videoArtifact, JSON.stringify(video));
    const inspected = await inspectVideoArtifact({ cwd, artifact: videoArtifact, workflowRun: 10, taskId: 500 });
    assert.equal(inspected.frames.length, 2); assert.ok(inspected.duration >= 6); assert.equal(inspected.width, 640);
    assert.ok(inspected.frames.every(frame => frame.matchedSeconds >= 2.6));
    await assert.rejects(inspectAdvancedArtifact({ cwd, artifact: videoArtifact, skillId: "ketchup-video", workflowRun: 10, videoReceipt: inspected }), /exact video/);
    const reviews = inspected.frames.map((frame, index) => ({ frame: frame.path, readTaskId: 600 + index, note: "Subtitle visible and separated below actual slide." }));
    await write(videoArtifact, JSON.stringify({ ...video, inspectionTaskId: 500, visualReview: reviews }));
    const accepted = await inspectAdvancedArtifact({ cwd, artifact: videoArtifact, skillId: "ketchup-video", workflowRun: 10, videoReceipt: inspected });
    assert.equal(accepted.video?.taskId, 500);
    const entries = inspected.frames.flatMap((frame, index) => {
      const toolTaskId = reviews[index].readTaskId, callId = "image-" + index;
      return [{ id: index * 2 + 1, conversationId: 7, byTaskId: toolTaskId - 1, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", name: "read", id: callId, arguments: { path: frame.path } }] }] },
        { id: index * 2 + 2, conversationId: 7, byTaskId: toolTaskId, kind: "pi.tool-result", model: [{ role: "toolResult", toolName: "read", toolCallId: callId, isError: false,
          content: [{ type: "image", mimeType: "image/png", data: "fixture" }], details: { executionReceipt: { version: 1, taskId: "media-fixture", conversationId: 7,
            toolTaskId, callId, toolName: "read", executionId: "read-" + index, assistantMessageId: "assistant-" + index, status: "passed", transport: "returned", settlement: "consumed",
            verifierId: "native-read", verifierVersion: 1, checkedAt: 1, fileReadAttempt: { target: join(cwd, frame.path), contentSha256: frame.digest },
            fileRead: { target: join(cwd, frame.path), outputHash: frame.digest, returnedChars: 0, images: 1, partial: false } } } }] }];
    }) as unknown as EntryRecord[];
    validateVideoVisualReviews(entries, cwd, "media-fixture", inspected, reviews);
    assert.throws(() => validateVideoVisualReviews(entries.filter(entry => entry.kind !== "pi.assistant"), cwd, "media-fixture", inspected, reviews), /actual decoded image/);
    assert.throws(() => validateVideoVisualReviews(entries, cwd, "different-task", inspected, reviews), /actual decoded image/);
    assert.throws(() => validateVideoVisualReviews(entries, cwd, "media-fixture", { ...inspected, frames: [{ ...inspected.frames[0], digest: "f".repeat(64) }, inspected.frames[1]] }, reviews), /actual decoded image/);
    await write(videoArtifact, JSON.stringify({ ...video, slides: [{ ...video.slides[0], endSeconds: 0.1 }, { ...video.slides[1], startSeconds: 0.1 }] }));
    await assert.rejects(inspectVideoArtifact({ cwd, artifact: videoArtifact, workflowRun: 10, taskId: 501 }), /hold for at least/);
    await write(videoArtifact, JSON.stringify({ ...video, slides: [{ ...video.slides[0], image: video.slides[1].image }, { ...video.slides[1], image: video.slides[0].image }] }));
    await assert.rejects(inspectVideoArtifact({ cwd, artifact: videoArtifact, workflowRun: 10, taskId: 502 }), /Actual video frames/);
    console.log("PASS real video: ffprobe container/audio/geometry checks, ffmpeg slide matching and decoded PNGs, timing and paired image-read identity gates");
  } else console.log("SKIP real MP4 fixture: ffmpeg/ffprobe missing; production inspection returns the specific missing dependency.");
  console.log("PASS advanced artifacts: real negative/clean check pair, source version binding, forged receipt rejection, workspace and symlink boundaries");
} finally { await rm(cwd, { recursive: true, force: true }); }
