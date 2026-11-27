import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ArtifactProtocol } from "../src/main/artifact/ArtifactProtocol";
import { WebArtifactRuntime } from "../src/main/artifact/WebArtifactRuntime";
import { readWorkspaceFile } from "../src/main/workspace/WorkspaceService";
import { artifactImageUrl } from "../src/shared/artifact-ipc";
import { createArtifactDomain } from "../src/main/artifact/ArtifactDomainSetup";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader, RuntimeAuditUnknownOperationError, type RuntimeArtifactMutation } from "../src/main/platform/runtime-audit";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-core-artifacts-")));
const database = join(root, "app.duckdb");
const storage = join(root, "artifacts");
const workspace = join(root, "workspace");
mkdirSync(workspace);
const file = join(workspace, "result.md");
const dependency = join(workspace, "included.md");
writeFileSync(file, "# Workspace output");
writeFileSync(dependency, "# Included");
const open = (coreRole?: "background-service") => new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole });
let ui = open();
const host = open("background-service");
const openDomain = (reader: RuntimeAuditReader, created?: (event: { artifactId: string }) => void) =>
  createArtifactDomain(undefined, { created }, reader, storage).service;

try {
  const now = Date.now();
  for (const id of ["task-a", "task-b", "task-files"]) {
    assert.equal((await ui.upsertTaskRecord({ id, title: id, at: now, preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
  }
  const published: string[] = [];
  const desktop = openDomain(ui, event => published.push(event.artifactId));
  await desktop.flushWrites();
  const writeManaged = ui.writeManagedArtifact.bind(ui);
  let committed!: Parameters<typeof ui.writeManagedArtifact>;
  let worker!: ReturnType<typeof openDomain>;
  ui.writeManagedArtifact = async (...args) => {
    assert.equal(committed, undefined, "The receipt should settle without reissuing the write");
    const status = await writeManaged(...args);
    assert.deepEqual(status, { status: "saved", revision: 1 });
    committed = args;
    worker = openDomain(host);
    await worker.flushWrites();
    await worker.register({ taskId: "task-a", id: "second", kind: "markdown", content: "# Second" });
    throw new RuntimeAuditUnknownOperationError("lost-reply", "writeManagedArtifact");
  };
  const first = await desktop.register({ taskId: "task-a", id: "first", kind: "markdown", content: "# First" });
  ui.writeManagedArtifact = writeManaged;
  assert.deepEqual(published, ["first"]);
  assert.equal((await worker.readContent(first.id))?.content, "# First");
  const firstPath = desktop.entryPathOfDescriptor(first)!;
  assert.equal(readFileSync(firstPath, "utf8"), "# First");
  assert.deepEqual(await host.artifactWriteReceipt("task-a", committed[1]), { revision: 1 });
  assert.equal(await host.artifactWriteReceipt("task-b", committed[1]), null);
  assert.deepEqual((await desktop.readTaskArtifacts("task-a")).map(item => item.id), ["first", "second"]);
  assert.match(JSON.stringify(await host.writeManagedArtifact(committed[0], committed[1], committed[2], { kind: "text", content: "changed" })), /另一笔写入/);
  console.log("PASS another client attaching and committing a later write preserves the original receipt");

  const delivered = new Set<RuntimeArtifactMutation["kind"]>();
  const discardFirstReply = (reader: RuntimeAuditReader) => {
    const original: RuntimeAuditReader["writeArtifact"] = reader.writeArtifact.bind(reader);
    reader.writeArtifact = async <T>(taskId: string, operationId: string, mutation: RuntimeArtifactMutation) => {
      const result = await original<T>(taskId, operationId, mutation);
      if (result !== undefined && !delivered.has(mutation.kind)) {
        delivered.add(mutation.kind);
        throw new RuntimeAuditUnknownOperationError("lost-reply", "writeArtifact");
      }
      return result;
    };
  };
  discardFirstReply(ui);
  discardFirstReply(host);
  const [one, two] = await Promise.all([desktop, worker].map((service, index) => service.registerWorkspaceOutput({
    taskId: "task-a", kind: "markdown", workspaceFile: { rootDir: workspace, entryFile: file },
    producerMessageId: `message-${index}`, producerToolCallId: `tool-${index}`,
  })));
  assert.equal(one.id, two.id);
  assert.deepEqual((await desktop.readTaskSnapshots(["task-a"])).map(result => [result.revision, result.artifacts.length]), [[3, 3]]);
  const provenance = await worker.readMessageRefs("task-a", { artifactId: one.id });
  assert.deepEqual(provenance.map(ref => ref.messageId).sort(), ["message-0", "message-1"]);
  assert.deepEqual(provenance.map(ref => ref.relation).sort(), ["created", "updated"]);
  await assert.rejects(host.batch3Write({ kind: "artifactSetFileDependencies", artifactId: one.id, taskId: "task-b",
    dependencies: [{ filePath: dependency, dependencyKind: "runtime" }], createdAt: now }));
  assert.deepEqual(await desktop.readFileDependencies(one.id), []);
  assert.deepEqual(await host.batch3Write({ kind: "artifactSetFileDependencies", artifactId: one.id, taskId: "task-a",
    dependencies: [{ filePath: dependency, dependencyKind: "runtime" }], createdAt: now }), { revision: 4 });
  const refreshed = await desktop.markFilesChanged({ taskId: "task-a", cwd: workspace, changedFiles: [dependency], messageId: "refresh" });
  assert.deepEqual(refreshed.map(event => [event.artifactId, event.version, event.revision]), [[one.id, 2, 5]]);
  assert.equal(await worker.remove(one.id), true);
  assert.equal(await desktop.readDescriptor(one.id), null);
  assert.deepEqual(await desktop.readMessageRefs("task-a", { artifactId: one.id }), []);
  assert.deepEqual(await desktop.readFileDependencies(one.id), []);
  const second = await desktop.readDescriptor("second");
  assert(second);
  const secondPath = desktop.entryPathOfDescriptor(second)!;
  assert.equal(await worker.remove(second.id), true);
  assert.equal(existsSync(secondPath), false);
  assert.deepEqual([...delivered], ["registerWorkspaceOutput", "refresh", "remove"]);
  console.log("PASS workspace registration and its references converge across clients; deletion removes the references and dependencies");

  let release!: () => void;
  let arrived!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { arrived = resolve; });
  const started: string[] = [];
  ui.writeManagedArtifact = async (...args) => {
    started.push(args[2].id);
    if (args[2].id === "held") {
      arrived();
      await barrier;
    }
    return writeManaged(...args);
  };
  const held = desktop.register({ taskId: "task-a", id: "held", kind: "markdown", content: "# Held" });
  await entered;
  const next = desktop.register({ taskId: "task-a", id: "next", kind: "markdown", content: "# Next" });
  const independent = desktop.register({ taskId: "task-b", id: "independent", kind: "markdown", content: "# Independent" });
  try {
    await Promise.race([independent, delay(5000, undefined, { ref: false }).then(() => { throw new Error("Unrelated artifact write was blocked"); })]);
    assert.deepEqual(started, ["held", "independent"]);
  } finally {
    release();
    await Promise.allSettled([held, next, independent]);
    ui.writeManagedArtifact = writeManaged;
  }
  assert.equal((await next).id, "next");
  assert.deepEqual(started, ["held", "independent", "next"]);
  console.log("PASS unrelated task writes proceed while edits to the same task wait");

  await Promise.all([ui.close(), host.close()]);
  await shutdownCoreWorker(root, database);
  ui = open();
  assert.deepEqual(await ui.writeManagedArtifact(...committed), { status: "saved", revision: 1 });
  assert.deepEqual(await ui.artifactWriteReceipt("task-a", committed[1]), { revision: 1 });
  assert.deepEqual(await ui.batch2Write({ kind: "deleteTask", id: "task-a" }), { ok: true });
  assert.equal(await ui.artifactById(first.id), null);
  assert.equal(await ui.artifactWriteReceipt("task-a", committed[1]), null);
  assert.match(JSON.stringify(await ui.writeManagedArtifact(...committed)), /所属任务不存在/);
  assert.equal(existsSync(firstPath), true);
  assert.equal((await ui.artifactById("independent"))?.taskId, "task-b");
  const reopened = openDomain(ui);
  await reopened.flushWrites();
  assert.equal(existsSync(join(storage, "task-a")), false);
  assert.equal((await reopened.readContent("independent"))?.content, "# Independent");
  console.log("PASS receipts replay after Core restart; task deletion fences stale writes and startup GC preserves unrelated output");
  await verifyArtifactFiles(reopened, ui);
} finally {
  await Promise.allSettled([ui.close(), host.close()]);
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function verifyArtifactFiles(service: ReturnType<typeof openDomain>, reader: RuntimeAuditReader): Promise<void> {
  const outside = join(root, "outside-artifact-store");
  mkdirSync(outside);
  const outsideFile = join(outside, "source.txt");
  writeFileSync(outsideFile, "工作区文件保留");
  const orphanLink = join(storage, "orphan-link");
  symlinkSync(outside, orphanLink, "junction");
  const abandoned = join(storage, "abandoned", "draft");
  mkdirSync(abandoned, { recursive: true });
  writeFileSync(join(abandoned, "index.html"), "<html>未登记</html>");
  writeFileSync(join(abandoned, ".mybuddy-artifact-write"), "interrupted write");
  assert.deepEqual(await reader.cleanupArtifactFiles(storage, { kind: "selected", paths: ["orphan-link/source.txt"] }),
    { removed: [], failed: ["orphan-link/source.txt"] });
  const gc = await service.orphanGC();
  assert.deepEqual(gc.failed, []);
  assert.deepEqual(gc.removed, []);
  assert.equal(readFileSync(join(abandoned, "index.html"), "utf8"), "<html>未登记</html>");
  assert.equal(existsSync(orphanLink), true);
  assert.equal(readFileSync(outsideFile, "utf8"), "工作区文件保留");
  console.log("PASS automatic cleanup preserves unowned artifact bytes and never traverses a junction");

  const large = await service.register({ taskId: "task-files", kind: "html", content: "<html/>" });
  const raster = await service.register({ taskId: "task-files", kind: "image", content: "data:image/png;base64,AA==" });
  const mib = 1024 * 1024;
  const textBytes = Buffer.alloc(21 * mib + 17, "a");
  Buffer.from("\ufeff开头", "utf8").copy(textBytes);
  Buffer.from("中文🙂", "utf8").copy(textBytes, mib - 1);
  Buffer.from("跨块🚀", "utf8").copy(textBytes, 13 * mib - 3);
  Buffer.from([0xf0, 0x9f]).copy(textBytes, 19 * mib - 1);
  Buffer.from("结束", "utf8").copy(textBytes, textBytes.length - Buffer.byteLength("结束"));
  writeFileSync(service.entryPathOfDescriptor(large)!, textBytes);
  const imageBytes = Buffer.alloc(21 * mib + 128, "A");
  imageBytes.write("data:image/png;base64,");
  writeFileSync(service.entryPathOfDescriptor(raster)!, imageBytes);

  const [chunked, preview] = await Promise.all([
    service.readContent(large.id),
    service.readContent(raster.id, { inline: true }),
  ]);
  assert(chunked);
  const expected = textBytes.toString("utf8");
  assert.equal(chunked.content.length, expected.length);
  assert.equal(createHash("sha256").update(chunked.content).digest("hex"),
    createHash("sha256").update(expected).digest("hex"));
  assert.equal(chunked.content.charCodeAt(0), 0xfeff);
  assert.match(chunked.content, /中文🙂/);
  assert.match(chunked.content, /跨块🚀/);
  assert.deepEqual(preview, { content: artifactImageUrl(raster.id, "full", { version: 1 }), kind: "image", artifactVersion: 1 });
  assert.equal(raster.source.type, "managed-content");
  assert.deepEqual(await reader.readManagedArtifact(storage, raster.source.storagePath, true), { status: "raster" });
  console.log("PASS Core preserves split UTF-8 and reads image headers for artifacts over 20 MiB");

  const previewRoot = join(root, "workspace-preview");
  mkdirSync(previewRoot);
  const previewText = join(previewRoot, "记录.md");
  const heading = "\ufeff# 记录\n";
  const prefix = heading + "a".repeat(256 * 1024 - Buffer.byteLength(heading) - 1);
  const body = prefix + "中🙂";
  writeFileSync(previewText, body);
  assert.deepEqual(await readWorkspaceFile(previewRoot, "记录.md", true, reader), {
    path: previewText, name: "记录.md", kind: "code",
    content: prefix.slice(1), bytes: Buffer.byteLength(body), truncated: true,
  });
  writeFileSync(previewText, Buffer.from([0x61, 0x00]));
  await assert.rejects(readWorkspaceFile(previewText, "", true, reader), /包含二进制内容/);
  writeFileSync(previewText, Buffer.from([0xe4, 0xb8]));
  await assert.rejects(readWorkspaceFile(previewRoot, "记录.md", true, reader), /不是有效的 UTF-8/);
  symlinkSync(outside, join(previewRoot, "outside"), "junction");
  await assert.rejects(readWorkspaceFile(previewRoot, join("outside", "source.txt"), true, reader), /不在当前工作区/);
  await assert.rejects(readWorkspaceFile(previewRoot, join("outside", "source.txt"), true), /不在当前工作区/);
  assert.deepEqual(await reader.workspaceFilePreview(previewRoot, "missing.txt", "text"), { status: "missing" });
  console.log("PASS workspace text previews preserve complete characters and enforce the workspace boundary");

  const previewImage = join(previewRoot, "截图.png");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jW9kAAAAASUVORK5CYII=", "base64");
  const imageLength = 6 * mib;
  writeFileSync(previewImage, png);
  truncateSync(previewImage, imageLength);
  const imageArtifact = await service.register({
    taskId: "task-files", kind: "image",
    workspaceFile: { entryFile: previewImage, rootDir: previewRoot },
  });
  assert.deepEqual(await reader.workspaceFilePreview(previewRoot, "截图.png", "imageHeader"), {
    status: "imageHeader", base64: png.subarray(0, 32).toString("base64"), bytes: imageLength,
  });
  const baseUrl = `mybuddy-artifact://local/${imageArtifact.id}/?`;
  assert.deepEqual(await service.readContent(imageArtifact.id, { inline: true }), {
    artifactVersion: 1, content: baseUrl + "variant=full&mime=image%2Fpng&bytes=6291456&w=1&h=1&v=1",
    kind: "image", path: previewImage, bytes: imageLength, language: "png", width: 1, height: 1,
    thumbnail: { mimeType: "image/png", bytes: imageLength, width: 1, height: 1, url: baseUrl + "variant=thumb&v=1" },
  });
  console.log("PASS inline PNG metadata carries the byte size and artifact protocol URL");

  const protocol = new ArtifactProtocol(new WebArtifactRuntime({
    filePathOf: () => null, rootOf: () => null,
    contentOf: async () => null,
  }), (id, variant, options) => service.openImageVariant(id, variant, options));
  const originalUrl = baseUrl + "variant=full&v=1";
  const head = await protocol.handle(new Request(originalUrl, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(head.headers.get("content-length"), "6291456");

  const original = await protocol.handle(new Request(originalUrl));
  assert.equal(original.status, 200);
  assert.equal(original.headers.get("content-type"), "image/png");
  assert.equal(original.headers.get("cache-control"), "private, max-age=31536000, immutable");
  const correctBytes = Buffer.alloc(imageLength);
  png.copy(correctBytes);
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), correctBytes);

  const aborted = new AbortController();
  const abortedResponse = await protocol.handle(new Request(originalUrl, { signal: aborted.signal }));
  const abortedBody = abortedResponse.body!.getReader();
  assert.deepEqual(Buffer.from((await abortedBody.read()).value!).subarray(0, png.length), png);
  aborted.abort(new Error("预览已取消"));
  await assert.rejects(abortedBody.read(), /预览已取消/);

  const changed = await protocol.handle(new Request(originalUrl));
  const changedBody = changed.body!.getReader();
  assert.deepEqual(Buffer.from((await changedBody.read()).value!).subarray(0, png.length), png);
  truncateSync(previewImage, imageLength - 1);
  await assert.rejects(changedBody.read(), /内容已变化/);

  const linkedImage = await service.register({
    taskId: "task-files", kind: "image",
    workspaceFile: { entryFile: join(previewRoot, "outside", "source.txt"), rootDir: previewRoot },
  });
  const denied = await protocol.handle(new Request(`mybuddy-artifact://local/${linkedImage.id}/?variant=full&v=1`));
  assert.equal(denied.status, 404);
  console.log("PASS original images stream on demand with HEAD, cancellation and file-change detection");

  const managedImage = await service.register({
    taskId: "task-files", kind: "image", content: "data:image/png;base64,AA==",
  });
  const managedPath = service.entryPathOfDescriptor(managedImage)!;
  const expectedImage = Buffer.concat([correctBytes, Buffer.from([0xfb, 0xff])]);
  const encodedImage = expectedImage.toString("base64url") + "=";
  writeFileSync(managedPath, "\ufeff DATA:image/png;BASE64," + " ".repeat(mib)
    + encodedImage.slice(0, mib - 5) + "\r\n" + encodedImage.slice(mib - 5));
  const managedUrl = `mybuddy-artifact://local/${managedImage.id}/?variant=full&v=1`;
  const managedHead = await protocol.handle(new Request(managedUrl, { method: "HEAD" }));
  assert.equal(managedHead.status, 200);
  assert.equal(managedHead.headers.get("content-type"), "image/png");
  assert.equal(managedHead.body, null);
  const managedResponse = await protocol.handle(new Request(managedUrl));
  assert.equal(managedResponse.status, 200);
  assert.deepEqual(Buffer.from(await managedResponse.arrayBuffer()), expectedImage);

  const changedManagedResponse = await protocol.handle(new Request(managedUrl));
  const changedManagedBody = changedManagedResponse.body!.getReader();
  assert.deepEqual(Buffer.from((await changedManagedBody.read()).value!).subarray(0, png.length), png);
  truncateSync(managedPath, 2 * mib);
  await assert.rejects(changedManagedBody.read(), /内容已变化/);

  const legacySvg = await service.register({
    taskId: "task-files", kind: "image", content: "data:image/svg+xml,%3Csvg%2F%3E",
  });
  const svg = await protocol.handle(new Request(`mybuddy-artifact://local/${legacySvg.id}/?variant=full&v=1`));
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get("content-type"), "image/svg+xml");
  assert.equal(await svg.text(), "<svg/>");
  console.log("PASS managed image streams decode chunked Base64 and SVG and detect file changes");
}
