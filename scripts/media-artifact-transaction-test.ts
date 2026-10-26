import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { computerAutomationService } from "../src/main/capabilities/ComputerAutomationService";
import { computerUseRunCoordinator } from "../src/main/capabilities/ComputerUseRunCoordinator";
import {
  MediaArtifactMaterializer,
  MediaMaterializationPartialStateError,
} from "../src/main/capabilities/MediaArtifactMaterializer";

const root = await mkdtemp(join(tmpdir(), "mybuddy-media-tx-"));
const context = { taskId: "task", taskRoot: root, toolCallId: "tool", producerMessageId: "msg" };
const png = (name: string) => ({ bytes: Buffer.from(`png:${name}`), mimeType: "image/png", fileName: `${name}.png` });

function serviceFixture(options: { failRegisterAt?: number; failRemove?: boolean; afterRegister?: (artifact: any) => Promise<void> } = {}) {
  let registerCount = 0;
  const registered = new Map<string, any>();
  const removed: string[] = [];
  const service = {
    register: async (registration: any) => {
      registerCount += 1;
      if (options.failRegisterAt === registerCount) throw new Error(`fixture register failure ${registerCount}`);
      const artifact = {
        id: `art-${registerCount}`,
        taskId: registration.taskId,
        kind: registration.kind,
        version: 1,
        capabilities: registration.capabilities ?? {},
        source: { type: "workspace-file", ...registration.workspaceFile },
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      registered.set(artifact.id, artifact);
      await options.afterRegister?.(artifact);
      return artifact;
    },
    remove: (id: string) => {
      if (options.failRemove) throw new Error("fixture remove failure");
      removed.push(id);
      return registered.delete(id);
    },
  };
  return { service, registered, removed, registerCount: () => registerCount };
}

async function generatedFiles(): Promise<string[]> {
  const dir = join(root, "generated", "image");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((name) => !name.endsWith(".partial"));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("media cancellation fixture did not settle within 2 seconds")), 2_000);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cancellationTransaction(stage: "bytes" | "register"): Promise<void> {
  const taskId = `media-cancel-${stage}`;
  const entered = deferred<string>();
  const release = deferred<void>();
  const parent = new AbortController();
  const fixture = serviceFixture({
    afterRegister: stage === "register" ? async (artifact) => {
      entered.resolve(artifact.source.entryFile);
      await release.promise;
    } : undefined,
  });
  let visionCalls = 0;
  let emitted = 0;
  const config: Record<string, any> = { execution: { terminalEnabled: false, codeExecutionEnabled: false } };
  for (const capability of ["web", "vision", "imageGeneration", "videoGeneration", "speechToText", "textToSpeech", "browser", "diagnostics", "subagent", "multiModelConsult"]) config[capability] = { enabled: false };
  config.browser.enabled = true;
  config.vision.enabled = true;
  const tools: any[] = [];
  createBuiltinCapabilityExtension({
    taskId, taskRoot: root,
    runtime: {
      config: () => config,
      visionProvider: () => ({ id: "fixture", label: "Vision cancellation fixture", describe: async () => { visionCalls += 1; return { provider: "fixture", descriptions: [] }; } }),
    } as never,
    browser: { available: false } as never,
    artifactService: () => fixture.service as never,
    markArtifactEmitted: () => { emitted += 1; },
    getProducerMessageId: () => "msg",
    getIsolationLevel: () => "guarded",
  })({ registerTool: (tool: any) => tools.push(tool), on: () => undefined } as never);
  const tool = tools.find((candidate) => candidate.name === "computer_exec");
  if (!tool) {
    // computer_exec 是「Windows 原生 Computer Use」扩展（UIA / PrintWindow / WGC），
    // 依赖 computerAutomationService.available；在 Linux/macOS 上合法地不存在。
    if (process.platform !== "win32") {
      console.log("SKIP  media-artifact-transaction: 需要 Windows computer_exec 扩展，本平台不提供");
      process.exit(0);
    }
    throw new Error("Real computer_exec extension must register for this Windows fixture");
  }
  const originalExecute = computerAutomationService.execute;
  const fsPromises = createRequire(import.meta.url)("node:fs/promises") as typeof import("node:fs/promises");
  const originalWrite = fsPromises.writeFile;
  let running: Promise<any> | undefined;
  try {
    computerAutomationService.execute = async (input, signal) => {
      assert(signal && !signal.aborted, "Screenshot result must begin inside the live CU scope");
      return { action: input.action, screenshot: Buffer.from("png:CU screenshot"), artifactFileName: `${stage}-cancelled.png` };
    };
    if (stage === "bytes") {
      fsPromises.writeFile = (async (...args: Parameters<typeof originalWrite>) => {
        await originalWrite(...args);
        entered.resolve(String(args[0]));
        await release.promise;
      }) as typeof originalWrite;
      syncBuiltinESMExports();
    }
    // Use the real extension's materialize -> Vision chain. The text-only model
    // would invoke delegated Vision if a cancelled materialization escaped.
    running = tool.execute(`tool-${stage}`, { action: "screenshot" }, parent.signal, undefined, { model: { input: ["text"] } });
    const written = await bounded(entered.promise);
    assert(existsSync(written), "Cancellation must occur after actual bytes have reached the filesystem");
    assert.equal(fixture.registered.size, stage === "register" ? 1 : 0, "Register cancellation must pause after the actual registration side effect");
    computerUseRunCoordinator.cancel(taskId);
    release.resolve();
    const result = await bounded(running);
    assert.equal(result.isError, true, "Real CU extension must return a recoverable cancellation tool error");
    assert.match(result.content.map((item: any) => item.text ?? "").join("\n"), /停止本轮 Computer Use/);
    assert.equal(parent.signal.aborted, false, "Media cancellation must preserve the parent Agent signal");
    assert.equal(visionCalls, 0, "Cancelled materialization must never enter delegated Vision");
    assert.equal(emitted, 0, "Cancelled screenshots must not be emitted as committed artifacts");
    assert.equal(fixture.registered.size, 0, "Cancelled transaction must roll back every registered artifact");
    assert.deepEqual(fixture.removed, stage === "register" ? ["art-1"] : []);
    assert.deepEqual(await readdir(join(root, "generated", "image")), [], "Cancellation must remove final files and .partial files");
  } finally {
    release.resolve();
    if (running) await bounded(running).catch(() => undefined);
    computerAutomationService.execute = originalExecute;
    fsPromises.writeFile = originalWrite;
    syncBuiltinESMExports();
    computerUseRunCoordinator.endTask(taskId, "failed");
  }
}

try {
  const successFixture = serviceFixture();
  const success = await new MediaArtifactMaterializer(() => successFixture.service as any).materialize(
    "image",
    { provider: "fixture", items: [png("one"), png("two")] },
    context,
    "Fixture image",
  );
  assert.equal(success.paths.length, 2);
  assert.equal(success.artifacts.length, 2);
  assert(success.paths.every(existsSync));
  assert.equal(successFixture.registered.size, 2);
  for (const artifact of success.artifacts) successFixture.service.remove(artifact.id);
  for (const path of success.paths) await rm(path, { force: true });

  const secondInvalid = serviceFixture();
  await assert.rejects(
    new MediaArtifactMaterializer(() => secondInvalid.service as any).materialize(
      "image",
      { provider: "fixture", items: [png("first-ok"), { bytes: Buffer.from("bad"), mimeType: "image/tiff", fileName: "bad.tiff" }] },
      context,
      "Fixture image",
    ),
    /不支持|MIME/,
  );
  assert.deepEqual(secondInvalid.removed, ["art-1"], "already-registered earlier item is removed when a later batch item fails");
  assert.equal(secondInvalid.registered.size, 0);
  assert.deepEqual(await generatedFiles(), [], "all files created by the failed batch are rolled back");

  const registerFailure = serviceFixture({ failRegisterAt: 1 });
  await assert.rejects(
    new MediaArtifactMaterializer(() => registerFailure.service as any).materialize(
      "image",
      { provider: "fixture", items: [png("register-fails")] },
      context,
      "Fixture image",
    ),
    /fixture register failure/,
  );
  assert.equal(registerFailure.registered.size, 0);
  assert.deepEqual(await generatedFiles(), [], "workspace file is deleted when Artifact registration fails after file write");

  await cancellationTransaction("bytes");
  await cancellationTransaction("register");

  const rollbackFailure = serviceFixture({ failRemove: true });
  let partial: MediaMaterializationPartialStateError | undefined;
  try {
    await new MediaArtifactMaterializer(() => rollbackFailure.service as any).materialize(
      "image",
      { provider: "fixture", items: [png("must-remain"), { bytes: Buffer.from("bad"), mimeType: "image/tiff", fileName: "bad.tiff" }] },
      context,
      "Fixture image",
    );
  } catch (error) {
    if (error instanceof MediaMaterializationPartialStateError) partial = error;
    else throw error;
  }
  assert(partial, "failed Artifact rollback must be surfaced as typed partial state");
  assert.deepEqual(partial!.retainedArtifactIds, ["art-1"]);
  assert.equal(partial!.retainedPaths.length, 1);
  assert(existsSync(partial!.retainedPaths[0]), "file is deliberately retained when Artifact DB removal fails, avoiding a dangling Artifact row");
  assert.equal(rollbackFailure.registered.size, 1);

  console.log("media artifact transaction: PASS (batch/registration rollback, actual bytes-write and registration-await CU cancellation, no Vision or committed artifacts after Stop, parent Agent preserved, partial cleanup, conservative partial-state preservation)");
} finally {
  await rm(root, { recursive: true, force: true });
}
