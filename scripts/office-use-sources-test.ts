import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SavedArtifactActions } from "../src/main/artifact/SavedArtifactActions";
import { resolveCadCraftFile } from "../src/main/artifact/CadCraftFile";
import type { ArtifactService } from "../src/main/artifact/ArtifactService";
import type { LibraryService } from "../src/main/library/LibraryService";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import type { OfficeOpen } from "../src/shared/office-use";
import { digest, OfficeFile } from "../src/main/office-use/OfficeFile";
import { resolveOfficeTarget, saveOfficeAs } from "../src/main/office-use/OfficeSources";

async function run(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mybuddy-office-sources-"));
  try {
    const fixture = resolve("fixtures/artifacts/synthetic/office");
    const original = await readFile(join(fixture, "xlsx-simple.xlsx"));
    const edited = await readFile(join(fixture, "xlsx-formula.xlsx"));
    const storage = join(root, "app");
    const workspace = join(root, "workspace");
    await Promise.all([mkdir(storage), mkdir(workspace)]);
    const drafts = join(storage, "drafts");
    const filePath = join(workspace, "original.xlsx");
    const managed = join(storage, "managed.bin");
    const draftSave = join(workspace, "recovered.xlsx");
    await writeFile(filePath, original);
    const prefix = "data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,";
    await writeFile(managed, prefix + original.toString("base64"));
    let descriptor: ArtifactDescriptor = {
      id: "artifact", kind: "office", taskId: "task-a", title: "Original",
      version: 1, createdAt: 1, updatedAt: 1, capabilities: { originalKind: "xlsx" },
      source: { type: "workspace-file", rootDir: workspace, entryFile: filePath },
    };
    let destination: string | undefined;
    let actionOnChoose: (() => Promise<void>) | undefined;
    let published = 0;
    const owner = { type: "personal" } as const;
    let collectionId = "folder";
    const copies: Buffer[] = [];
    const artifactApi = {
      get: () => descriptor,
      entryPathOf: () => descriptor.source.type === "workspace-file" ? descriptor.source.entryFile : managed,
      notifyHtmlSaved: () => { published++; },
    };
    const libraryApi = {
      absolutePath: () => join(storage, "library.xlsx"),
      resolveOfficeItem: (_id: string, requestedOwner: unknown, _reference?: unknown, write?: boolean) => {
        assert.deepEqual(requestedOwner, owner);
        if (write && collectionId !== "folder") throw new Error("Scope changed");
        return { id: "item", filename: "file.xlsx", spaceId: "library", collectionId };
      },
      importFile: (request: { sourcePath: string; spaceId: string; collectionId: string }) => {
        assert.equal(request.spaceId, "library");
        assert.equal(request.collectionId, "folder");
        const fs = require("node:fs") as typeof import("node:fs");
        copies.push(fs.readFileSync(request.sourcePath));
        return { filename: "copy.xlsx" };
      },
    };
    const choose = async () => { await actionOnChoose?.(); return destination; };
    const ports = {
      storageRoot: storage, choose,
      artifacts: artifactApi as unknown as ArtifactService,
      library: libraryApi as unknown as LibraryService,
      saved: new SavedArtifactActions({ storageRoot: storage, exportRoot: workspace,
        chooseDestination: choose, openPath: async () => "" }),
    };
    const request: OfficeOpen = { source: { type: "artifact", id: "artifact", taskId: "task-a" }, name: "ignored.docx" };
    await assert.rejects(resolveOfficeTarget({ ...request, source: { type: "artifact", id: "artifact", taskId: "other" } }, ports), /不属于/);
    const workspaceTarget = await resolveOfficeTarget(request, ports);
    assert.equal(workspaceTarget.kind, "excel");
    const workspaceFile = new OfficeFile(workspaceTarget, drafts);
    assert.deepEqual(await workspaceFile.open(), original);
    assert.deepEqual(await workspaceFile.write(edited, false), { message: "已保存", saved: true });
    assert.deepEqual(await readFile(filePath), edited);
    assert.equal(published, 1);
    await writeFile(filePath, original);
    await assert.rejects(workspaceFile.write(edited, false), /原文件已被修改/);
    destination = draftSave;
    assert.equal(await saveOfficeAs(edited, workspaceTarget, ports), draftSave);
    assert.deepEqual(await readFile(draftSave), edited);
    assert.deepEqual(await readFile(filePath), original);
    destination = join(storage, "blocked.xlsx");
    await assert.rejects(saveOfficeAs(edited, workspaceTarget, ports), /存储目录/);
    destination = filePath;
    await assert.rejects(saveOfficeAs(edited, workspaceTarget, ports), /其他 Office 文件名/);
    destination = draftSave;
    await assert.rejects(saveOfficeAs(original, workspaceTarget, ports, async () => {
      await writeFile(draftSave, Buffer.from("concurrent write"));
    }), /目标文件发生变化/);
    assert.equal((await readFile(draftSave)).toString(), "concurrent write");

    descriptor = { ...descriptor, source: { type: "workspace-file", rootDir: workspace, entryFile: managed } };
    await assert.rejects(resolveOfficeTarget(request, ports), /支持 DOCX|离开登记目录/);
    const privateOffice = join(storage, "private.xlsx");
    await writeFile(privateOffice, original);
    descriptor = { ...descriptor, source: { type: "workspace-file", rootDir: storage, entryFile: privateOffice } };
    await assert.rejects(resolveOfficeTarget(request, ports), /受保护存储目录/);
    const botWorkspace = join(storage, "bot-workspaces", "bot-a");
    const botOffice = join(botWorkspace, "original.xlsx");
    await mkdir(botWorkspace, { recursive: true });
    await writeFile(botOffice, original);
    descriptor = { ...descriptor, source: { type: "workspace-file", rootDir: botWorkspace, entryFile: botOffice } };
    const botFile = new OfficeFile(await resolveOfficeTarget(request, ports), drafts);
    await botFile.open();
    await botFile.write(edited, false);
    assert.deepEqual(await readFile(botOffice), edited);
    descriptor = { ...descriptor, source: { type: "managed-content", rootDir: storage, storagePath: "managed.bin" } };
    const managedFile = new OfficeFile(await resolveOfficeTarget(request, ports), drafts);
    assert.deepEqual(await managedFile.open(), original);
    await managedFile.write(edited, false);
    assert.equal(await readFile(managed, "utf8"), prefix + edited.toString("base64"));

    const snapshotDirectory = join(storage, "durable", "a".repeat(64), "artifacts");
    await mkdir(snapshotDirectory, { recursive: true });
    const snapshotPath = join(snapshotDirectory, digest(original) + ".xlsx");
    await writeFile(snapshotPath, original);
    const workRequest: OfficeOpen = { name: "not an escape.docx",
      source: { type: "work", file: { snapshotPath, name: "work.xlsx" } } };
    const workFile = new OfficeFile(await resolveOfficeTarget(workRequest, ports), drafts);
    assert.deepEqual(await workFile.open(), original);
    const workOpenTarget = await resolveOfficeTarget(workRequest, ports);
    const verifySnapshot = ports.saved.verifiedSnapshot.bind(ports.saved);
    ports.saved.verifiedSnapshot = async file => {
      const snapshot = await verifySnapshot(file);
      await writeFile(snapshot.path, edited);
      return snapshot;
    };
    try {
      assert.deepEqual(await new OfficeFile(workOpenTarget, drafts).open(), original);
    } finally {
      ports.saved.verifiedSnapshot = verifySnapshot;
      await writeFile(snapshotPath, original);
    }
    destination = join(workspace, "work-copy.xlsx");
    assert.match((await workFile.write(edited, false)).message, /已保存副本/);
    assert.deepEqual(await readFile(snapshotPath), original);
    assert.deepEqual(await readFile(destination), edited);
    destination = join(workspace, "work-race.xlsx");
    actionOnChoose = () => writeFile(snapshotPath, edited);
    await assert.rejects(workFile.write(edited, false), /完整性/);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    actionOnChoose = undefined;

    const dxf = (version: string) => "0\nSECTION\n2\nHEADER\n999\n" + version + "\n0\nENDSEC\n0\nEOF\n";
    const drawing = dxf("ORIGINAL");
    const drawingPath = join(snapshotDirectory, digest(drawing) + ".dxf");
    await writeFile(drawingPath, drawing);
    const savedDrawing = { type: "work", file: { snapshotPath: drawingPath, name: "plan.dxf" } } as const;
    const cadPorts = { ...ports, locateCli: async () => { throw new Error("DXF must open without conversion"); } };
    const cad = await resolveCadCraftFile(savedDrawing, cadPorts);
    assert.equal((await cad.open()).toString(), drawing);
    await writeFile(drawingPath, dxf("REPLACED"));
    await assert.rejects(cad.open(), /完整性校验失败/);

    const libraryRequest: OfficeOpen = { name: "library.xlsx", source: { type: "library", id: "item", owner } };
    await writeFile(libraryApi.absolutePath(), original);
    const libraryTarget = await resolveOfficeTarget(libraryRequest, ports);
    const libraryFile = new OfficeFile(libraryTarget, drafts);
    await libraryFile.open();
    assert.match((await libraryFile.write(edited, false)).message, /已保存资料副本/);
    assert.deepEqual(copies, [edited]);
    assert.deepEqual(await readFile(libraryTarget.path), original);
    collectionId = "another";
    await assert.rejects(libraryFile.write(edited, false), /资料位置已变化/);
    assert.deepEqual(copies, [edited]);
    const reference = { spaceId: "library", itemId: "item" };
    const scopedReference = await resolveOfficeTarget({ ...libraryRequest,
      source: { type: "library", id: "item", owner, reference } }, ports);
    assert.equal(scopedReference.readOnly, true);
  } finally {
    const checked = resolve(root);
    assert.equal(checked.startsWith(resolve(tmpdir(), "mybuddy-office-sources-")), true);
    await rm(checked, { recursive: true, force: true });
  }
  console.log("Office Use source identity and save tests passed");
}

void run();
