import { createLibraryExtension } from "../src/main/library/library-extension";
import { LibraryProtocol } from "../src/main/library/LibraryProtocol";
import { runLibraryNoteOperation } from "../src/main/library/LibraryNoteOperations";
import { ProjectDocumentImporter } from "../src/main/project/ProjectDocumentImporter";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, readdirSync, watch,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  AppDatabase,
  CURRENT_DATABASE_SCHEMA_VERSION,
} from "../src/main/db/AppDatabase";
import {
  initializeCoreDatabase,
  shutdownCoreWorker,
} from "../src/main/platform/core-client";
import {
  TaskExecutionWorkspace,
  getTaskDirectoryName,
} from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor } from "../src/main/project/ProjectEventIngestor";
import { ProjectEventPromoter } from "../src/main/project/ProjectEventPromoter";
import { emptyProjectPolicies } from "../src/shared/project-domain";
import { LibraryService } from "../src/main/library/LibraryService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-core-check-"));
const exe = resolve(
  process.argv[2] ??
    (process.platform === "win32"
      ? "out/native/win-x64/mybuddy-runtime-audit.exe"
      : "out/native/linux-x64/mybuddy-runtime-audit"),
);
const path = join(root, "app.duckdb");
await initializeCoreDatabase(exe, root, path, CURRENT_DATABASE_SCHEMA_VERSION);
const db = await AppDatabase.open(path, {
  runtimeAuditExecutable: exe,
  runtimeAuditSupervised: true,
});
try {
  const ws = new TaskExecutionWorkspace(join(root, "task-workspaces"));
  const lifecycle = new TaskExecutionWorkspaceLifecycle({
    db,
    workspace: ws,
    trashRoot: join(root, "trash"),
  });
  const id = "isolated-example";
  const dir = ws.ensureTaskExecutionWorkspace(id);
  writeFileSync(join(dir, "content"), "preserved");
  const library = new LibraryService(db, {
    libraryRoot: join(root, "library"),
  });
  const reader = db.runtimeAuditReader!;
  const source = join(root, "seed.mynotes");
  const item = {
    id: "check-note",
    spaceId: "personal",
    collectionId: null,
    kind: "markdown",
    title: "check",
    filename: "check.md",
    mimeType: "text/markdown",
    sizeBytes: 4,
    owner: "test",
    favorite: false,
    createdAt: 1,
    updatedAt: 1,
    lastVisitedAt: null,
  };
  writeFileSync(
    source,
    gzipSync(
      JSON.stringify({
        format: "mybuddy-notes",
        version: 1,
        folders: [],
        items: [
          { item, body: Buffer.from("seed").toString("base64"), history: [] },
        ],
      }),
    ),
  );
  const cases: Array<[string, () => Promise<void>]> = [
    [
      "adopt",
      async () => {
        assert.equal(
          (await lifecycle.adoptOrphan(getTaskDirectoryName(id), id)).taskId,
          id,
        );
      },
    ],
    [
      "shared directory",
      async () => {
        const other = "sharing-example";
        const peerDir = ws.ensureTaskExecutionWorkspace(other);
        await lifecycle.adoptOrphan(getTaskDirectoryName(other), other);
        assert.equal(
          (
            await reader.writeDurableTaskProjection({
              kind: "bindBot",
              taskId: other,
              directory: peerDir,
              cwd: dir,
            })
          )?.status,
          "applied",
        );
        await assert.rejects(lifecycle.trash(id), /其他补跑任务使用/);
        assert.equal(readFileSync(join(dir, "content"), "utf8"), "preserved");
        await lifecycle.trash(other);
      },
    ],
    [
      "trash",
      async () => {
        const result = await lifecycle.trash(id);
        assert.equal(
          readFileSync(join(result.trashPath!, "content"), "utf8"),
          "preserved",
        );
        assert.ok(!existsSync(dir));
      },
    ],
    [
      "restore",
      async () => {
        await lifecycle.restoreFromTrash(id);
        assert.equal(readFileSync(join(dir, "content"), "utf8"), "preserved");
      },
    ],
    ["first personal library creation preserves the user's welcome-note deletion", async () => {
      const personal = {type:"personal"} as const;
      assert.equal((await library.readSnapshot({owner:personal})).spaces.length,0);
      const first = await library.ensureOwnedSpaceAsync(personal);
      assert.equal(first.id,"personal");
      const notes = (await library.readSnapshot({owner:personal})).items;
      assert.equal(notes.length,1);
      assert.match((await library.readContentAsync(notes[0].id)).content,/一分钟玩转资料库/);
      await library.deleteItemAsync(notes[0].id);
      assert.equal((await library.ensureOwnedSpaceAsync(personal)).id,first.id);
      assert.deepEqual((await library.readSnapshot({owner:personal})).items,[]);
    }],
    [
      "restore notes",
      async () => {
        assert.deepEqual(
          await library.importNoteBackup({ type: "personal" }, source),
          { restored: 1, skipped: 0 },
        );
      },
    ],
    [
      "write notes",
      async () => {
        assert.equal(
          (await library.writeContentAsync({ id: item.id, content: "edited" }))
            .sizeBytes,
          6,
        );
      },
    ],
    [
      "export notes",
      async () => {
        await library.exportNoteBackup(
          { type: "personal" },
          join(root, "export.mynotes"),
        );
        assert.ok(existsSync(join(root, "export.mynotes")));
      },
    ],
    [
      "inspect backup",
      async () => {
        const archive = JSON.parse(
          gunzipSync(readFileSync(join(root, "export.mynotes"))).toString(),
        );
        assert.equal(
          Buffer.from(archive.items[0].body, "base64").toString(),
          "edited",
        );
        assert.equal(
          Buffer.from(archive.items[0].history[0].body, "base64").toString(),
          "seed",
        );
      },
    ],
    [
      "delete and restore",
      async () => {
        await library.deleteItemAsync(item.id);
        assert.equal(
          (await library.readSnapshot({ itemId: item.id })).items.length,
          0,
        );
        assert.deepEqual(
          await library.importNoteBackup(
            { type: "personal" },
            join(root, "export.mynotes"),
          ),
          { restored: 1, skipped: 0 },
        );
        assert.equal(
          readFileSync(
            join(root, "library", "personal", "check-note.md"),
            "utf8",
          ),
          "edited",
        );
      },
    ],
    [
      "create bound folder",
      async () => {
        assert.ok(
          await reader.batch2Write({
            kind: "upsertSpaceRaw",
            id: "ws",
            name: "test",
            hasParent: false,
            hasSortOrder: false,
            at: 1,
          }),
        );
        assert.ok(
          await reader.batch3Write({
            kind: "libraryInsertSpace",
            id: "ws-lib",
            name: "owned",
            spaceKind: "team",
            workspaceId: "ws",
            createdAt: 1,
            updatedAt: 1,
          }),
        );
        await library.createWorkspaceFolder("ws", "ws-lib", "folder");
        const catalog = await library.readSnapshot({ spaceId: "ws-lib" });
        assert.equal(catalog.collections.length, 1);
        assert.ok(
          JSON.stringify(await reader.workspaceBindingSnapshot("ws")).includes(
            catalog.collections[0].id,
          ),
        );
        await assert.rejects(
          library.createWorkspaceFolder("ws", "personal", "foreign"),
          /自有资料/,
        );
        assert.equal(
          (await library.readSnapshot({ spaceId: "personal" })).collections
            .length,
          0,
        );
      },
    ],
    [
      "create managed text",
      async () => {
        for (const [kind, extension] of [
          ["markdown", "md"],
          ["html", "html"],
          ["csv", "csv"],
        ] as const) {
          const note = await library.createItemAsync({
            kind,
            spaceId: "personal",
            title: "created",
            content: "fresh",
          });
          assert.equal(
            readFileSync(
              join(library.root, "personal", note.id + "." + extension),
              "utf8",
            ),
            "fresh",
          );
          await library.deleteItemAsync(note.id);
        }
      },
    ],
    [
      "lost restore acknowledgement",
      async () => {
        await library.deleteItemAsync(item.id);
        const restore = reader.restoreLibraryBackup.bind(reader);
        reader.restoreLibraryBackup = async (...args) => {
          const reply = await restore(...args);
          assert.equal(reply?.status, "restored");
          throw Object.assign(new Error("lost acknowledgement"), {
            code: "RUNTIME_OPERATION_UNKNOWN",
          });
        };
        try {
          const receipt = await library.importNoteBackup(
            { type: "personal" },
            source,
          );
          assert.deepEqual(receipt, { restored: 1, skipped: 0 });
          assert.equal(
            readFileSync(
              join(root, "library", "personal", "check-note.md"),
              "utf8",
            ),
            "seed",
          );
        } finally {
          reader.restoreLibraryBackup = restore;
        }
      },
    ],
    [
      "ingest and archive project document",
      async () => {
        const projectId = "check-project";
        const project = {
          id: projectId,
          name: "Project",
          createdAt: 1,
          updatedAt: 1,
          resourceBudgetChars: 128000,
        };
        assert.equal(
          await reader.writeProject("check-create-project", {
            kind: "create",
            project,
            policiesJson: JSON.stringify(emptyProjectPolicies()),
            resources: [],
          }),
          "changed",
        );
        const memory = new MemoryService(db, { semantic: false });
        const projects = new ProjectService(
          new ProjectRepository(db.fixtureConnection, reader),
          memory,
        );
        const ingestor = new ProjectEventIngestor(projects);
        const source = join(root,"project-input.md");
        writeFileSync(source, "# imported text");
        const importer = new ProjectDocumentImporter(projects, library, ingestor);
        const imported = await importer.importFile(projectId, source);
        assert.equal(imported.event.body, "# imported text");
        assert.equal(imported.item?.sourceType, "uploaded");
        assert.equal((await importer.importFile(projectId, source)).event.id, imported.event.id);
        const promoter = new ProjectEventPromoter(projects, library);
        const document = { title: "Text", body: "source bytes" };
        const event = await ingestor.ingestDocumentAsync(projectId, document);
        assert.equal(
          (await ingestor.ingestDocumentAsync(projectId, document)).id,
          event.id,
        );
        const request = {
          targetKind: "library" as const,
          libraryTitle: "Saved",
          libraryContent: document.body,
        };
        const promotion = await promoter.promoteAsync(event.id, request);
        assert.equal(promotion.reused, false);
        const duplicate = await promoter.promoteAsync(event.id, request);
        assert.equal(duplicate.targetId, promotion.targetId);
        assert.equal(duplicate.reused, true);
        assert.equal(duplicate.targetMissing, false);
        const saved = (
          await library.readSnapshot({ itemId: promotion.targetId })
        ).items[0];
        assert.equal(
          readFileSync(
            join(library.root, saved.spaceId, saved.id + ".md"),
            "utf8",
          ),
          document.body,
        );
        await memory.flushWrites();
      },
    ],
    [
      "Core import: linked binary, streamed text, folder transaction, scoped ownership and dropped reply",
      async () => {
        const sourceDir = join(root, "imports");
        mkdirSync(join(sourceDir,"empty"), {recursive:true});
        writeFileSync(join(sourceDir,"notice.md"), "[附件](report.zip)");
        const attachment = Buffer.from([255,0,1,128]);
        writeFileSync(join(sourceDir,"report.zip"), attachment);
        const send = reader.writeLibraryNote.bind(reader);
        reader.writeLibraryNote = async change => {
          const result = await send(change);
          if (change.kind === "import") throw Object.assign(new Error("lost committed reply"), { code:"RUNTIME_OPERATION_UNKNOWN" });
          return result as never;
        };
        try {
          const imported = await library.importFileAsync({spaceId:"personal", sourcePath:join(sourceDir,"notice.md")});
          const saved = await library.readSnapshot({spaceId:"personal"});
          const linked = saved.items.find(i=>i.filename==="report.zip")!;
          assert.ok(readFileSync(join(library.root,"personal",imported.id+".md"),"utf8").includes(linked.id));
          assert.deepEqual(readFileSync(join(library.root,"personal",linked.id+".zip")), attachment);
          await library.checkFolderImportDestination({type:"personal"},"personal",null);
          const restored = await library.importFolder({owner:{type:"personal"},spaceId:"personal", collectionId:null, sourcePath:sourceDir});
          assert.equal(restored.fileCount,2);
          const snap = await library.readSnapshot({spaceId:"personal"});
          assert(snap.collections.some(f=>f.parentId===restored.folder.id && f.name==="empty"));
          const notes=snap.items.filter(i=>i.collectionId===restored.folder.id);
          assert.equal(notes.length,2);
          assert(readFileSync(join(library.root,"personal",notes.find(i=>i.filename==="notice.md")!.id+".md"),"utf8")
            .includes(notes.find(i=>i.filename==="report.zip")!.id));
        } finally { reader.writeLibraryNote=send; }
        await assert.rejects(library.importFolder({owner:{type:"project",projectId:"check-project"},spaceId:"personal",collectionId:null,sourcePath:sourceDir}));
        const before = await library.readSnapshot({spaceId:"personal"});
        const beforeFiles = readdirSync(join(library.root,"personal")).sort();
        reader.writeLibraryNote = async change => {
          if (change.kind === "import") change.batch.files[1].kind = "bad_test_kind";
          return send(change) as never;
        };
        try { await assert.rejects(library.importFolder({owner:{type:"personal"},spaceId:"personal",collectionId:null,sourcePath:sourceDir})); }
        finally { reader.writeLibraryNote=send; }
        await library.recoverLibraryRestores();
        const after = await library.readSnapshot({spaceId:"personal"});
        assert.deepEqual(after.items,before.items);
        assert.deepEqual(after.collections,before.collections);
        assert.deepEqual(readdirSync(join(library.root,"personal")).sort(),beforeFiles);
        const content = "Core import data\n".repeat(70000);
        const large = join(root,"large.html");
        writeFileSync(large,content);
        const item = await library.importFileAsync({spaceId:"personal",sourcePath:large});
        assert.equal(readFileSync(join(library.root,"personal",item.id+".html"),"utf8"), content);
      },
    ],
    [
      "worker crash after publishing first folder file rolls back metadata and cleanup preserves prior contents",
      async () => {
        const directory = join(root,"crash-import");
        mkdirSync(directory);
        writeFileSync(join(directory,"a.md"),"first before crash");
        writeFileSync(join(directory,"z.html"),"Core transactional import.\n".repeat(180000));
        const owned = join(library.root,"personal");
        const old = readdirSync(owned).sort();
        const before = await library.readSnapshot({spaceId:"personal"});
        const worker = JSON.parse(readFileSync(join(root,"core.json"),"utf8")).workerPid;
        let killed = false;
        const watcher = watch(owned, (_event,name) => {
          if (!killed && name && name.endsWith(".md") && !old.includes(name)) {
            killed = true;
            process.kill(worker,"SIGKILL");
          }
        });
        try { await assert.rejects(library.importFolder({owner:{type:"personal"},spaceId:"personal",collectionId:null,sourcePath:directory})); }
        finally { watcher.close(); }
        assert(killed);
        const deadline = Date.now()+30000;
        let replacement:number|undefined;
        while (Date.now()<deadline) {
          try { replacement = JSON.parse(readFileSync(join(root,"core.json"),"utf8")).workerPid; } catch { replacement=undefined; }
          if (replacement && replacement!==worker) break;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        assert.ok(replacement && replacement!==worker, "supervisor must replace the killed worker");
        await library.recoverLibraryRestores();
        const recovered = await library.readSnapshot({spaceId:"personal"});
        assert.deepEqual(before.items,recovered.items);
        assert.deepEqual(before.collections,recovered.collections);
        assert.deepEqual(old,readdirSync(owned).sort());
        const result = await library.importFolder({owner:{type:"personal"},spaceId:"personal",collectionId:null,sourcePath:directory});
        assert.equal(result.fileCount,2);
      },
    ],
    [
      "note images pasted, picked, linked and served via Core",
      async () => {
        const owner = {type:"personal"} as const;
        const note = await library.createItemAsync({spaceId:"personal",kind:"markdown",title:"图片笔记",content:"正文"});
        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQxkAAAAASUVORK5CYII=", "base64");
        const add = {type:"addImage",owner,id:note.id,name:"图.png",mime:"image/png",bytes:png} as const;
        const run = (req: Parameters<typeof runLibraryNoteOperation>[3]) => runLibraryNoteOperation(library,{} as never,null,req);
        const url = await run(add);
        assert.equal(typeof url,"string");
        const href = String(url);
        await library.writeContentAsync({id:note.id,content:"![图]("+href+") ![图](图.png)"});
        assert.equal(await run({type:"noteImage",id:note.id,href}),href);
        assert.equal(await run({type:"noteImage",id:note.id,href:"图.png"}),href);
        await assert.rejects(run({...add,mime:"image/jpeg"}));
        await assert.rejects(run({...add,bytes:Buffer.alloc(20*1024*1024+1)}));
        await assert.rejects(run({...add,owner:{type:"workspace",workspaceId:"unrelated"}}));
        await assert.rejects(run({type:"noteImage",id:note.id,href:"unlinked.png"}));
        const response = await new LibraryProtocol(library).handle(new Request(href));
        assert.equal(response.status,200);
        assert.equal(response.headers.get("content-type"),"image/png");
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
        const path = join(root,"picked.png"), invalid = join(root,"invalid.jpg");
        writeFileSync(path,png); writeFileSync(invalid,png);
        const selected = await runLibraryNoteOperation(library,{} as never,null,{type:"pickImages",owner,id:note.id}, undefined,
          async () => ({canceled:false,filePaths:[path,invalid]})) as {images:Array<{url:string}>;errors:string[]};
        assert.equal(selected.images.length,1);
        assert.equal(selected.errors.length,1);
        assert.deepEqual(Buffer.from(await (await new LibraryProtocol(library).handle(new Request(selected.images[0].url))).arrayBuffer()),png);
        await library.writeContentAsync({id:note.id,content:"不再引用图片"});
        const [previous] = await library.readVersions(note.id);
        assert.equal(await run({type:"noteImage",id:note.id,href,version:previous.version}),href);
        await assert.rejects(run({type:"noteImage",id:note.id,href}));
        // The picker may stay open while the user trashes the destination note.
        const moved = await runLibraryNoteOperation(library,{} as never,null,{type:"pickImages",owner,id:note.id}, undefined,
          async () => { await library.trashNotes(owner,[note.id]); return {canceled:false,filePaths:[path]}; }) as typeof selected;
        assert.equal(moved.images.length,0);
        assert.equal(moved.errors.length,1);
        await assert.rejects(library.addNoteImageAsync(owner,"personal",null,"stale.png","image/png",png,note.id));

      },
    ],
    [
      "registered note operations, version restore, managed attachment protocol",
      async () => {
        const owner = {type:"personal"} as const;
        const note = await library.createItemAsync({spaceId:"personal",kind:"markdown",title:"version-check",content:"version zero"});
        const changed = await library.writeContentAsync({id:note.id,content:"version one"});
        const versions = await library.readVersions(note.id);
        assert.ok(versions.length);
        const request = {type:"restoreVersion",owner,id:note.id,version:versions[0].version,expectedContentHash:changed.contentHash} as const;
        await assert.rejects(runLibraryNoteOperation(library,{} as never,null,{...request,owner:{type:"project",projectId:"check-project"}}));
        assert.equal((await library.readContentAsync(note.id)).content,"version one");
        const historical = await new LibraryProtocol(library).handle(new Request(library.previewUrl(note.id)+"?rev="+versions[0].version));
        assert.equal(historical.status,200);
        assert.equal(await historical.text(),"version zero");
        await runLibraryNoteOperation(library, {} as never, null, request).catch(error => { throw new Error(request.type, {cause:error}); });
        assert.equal((await library.readContentAsync(note.id)).content,"version zero");
        const body = Buffer.from("%PDF-1.7 test");
        const source = join(root,"fixture.pdf");
        writeFileSync(source,body);
        const imported=await library.importFileAsync({sourcePath:source,spaceId:"personal"});
        const data = await runLibraryNoteOperation(library,{} as never,null,{type:"attachment",id:imported.id});
        assert.equal(data,"data:application/pdf;base64,"+body.toString("base64"));
        const protocol = new LibraryProtocol(library);
        const response = await protocol.handle(new Request(library.previewUrl(imported.id)));
        assert.equal(response.status,200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);
      },
    ],
    ["note operations enforce owner and retain merged body, tags and sources", async () => {
      const owner = { type: "personal" } as const;
      const run = (request: import("../src/shared/library-ipc").LibraryNoteOperation) =>
        runLibraryNoteOperation(library, {} as never, null, request).catch(error => { throw new Error(request.type, {cause:error}); });
      const first = await library.createItemAsync({ spaceId: "personal", kind: "markdown", title: "First", content: "one" });
      const second = await library.createItemAsync({ spaceId: "personal", kind: "markdown", title: "Second", content: "two" });
      await run({ type:"metadata", owner, id:first.id, tags:["alpha"], pinned:true });
      await run({ type:"metadata", owner, id:second.id, tags:["beta"] });
      assert.equal((await library.readSnapshot({itemId:first.id})).items[0].pinned,true);
      await assert.rejects(run({ type:"trash", owner:{type:"project",projectId:"foreign"}, ids:[first.id] }));
      await assert.rejects(run({ type:"move",owner,ids:[first.id],collectionId:"missing-folder" }));
      const folder = await library.importFolder({ owner, spaceId:"personal",collectionId:null,sourcePath:folderFixture() });
      await run({type:"move", owner, ids:[first.id,second.id], collectionId:folder.folder.id});
      assert.equal((await library.readSnapshot({itemId:first.id})).items[0].collectionId,folder.folder.id);
      await run({ type:"trash",owner,ids:[first.id,second.id] });
      const trash = await run({type:"trashList",owner}) as import("../src/shared/library-ipc").LibraryItemDto[];
      assert.ok(trash.some(i=>i.id===first.id) && trash.some(i=>i.id===second.id));
      await run({ type:"restore",owner,ids:[first.id,second.id] });
      const merged = await run({ type:"merge",owner,ids:[second.id,first.id] }) as import("../src/shared/library-ipc").LibraryItemDto;
      assert.equal((await library.readContentAsync(merged.id)).content,"two\n\n---\n\none");
      assert.deepEqual(merged.tags,["beta","alpha"]);
      assert.equal(merged.collectionId,folder.folder.id);
      assert.equal((await library.readContentAsync(first.id)).content,"one");
      function folderFixture() {
        const folder = join(root,"merge-folder");
        mkdirSync(folder);
        writeFileSync(join(folder,"folder.txt"),"file");
        return folder;
      }
    }],
    ["desktop saveArtifact preserves source, refreshes versions, verifies ownership and receipt", async () => {
      const {createArtifactDomain} = await import("../src/main/artifact/ArtifactDomainSetup");
      const domain = createArtifactDomain(undefined,undefined,reader,join(root,"test-artifacts"));
      await db.writeTaskRecord({id:"library-art-task",title:"source task",updatedAt:Date.now()});
      const src = await domain.service.register({taskId:"library-art-task", kind:"markdown",title:"Reference",content:"# initial"});
      const req = {spaceId:"personal",artifactId:src.id,owner:{type:"personal"}} as const;
      const first = await library.saveArtifactAsync(req);
      assert.equal(first.sourceArtifactId,src.id);
      assert.equal(first.sourceTaskId,"library-art-task");
      assert.equal((await library.readContentAsync(first.id)).content,"# initial");
      assert.equal((await library.saveArtifactAsync(req)).id,first.id);
      assert.equal((await library.readVersions(first.id)).length,0);
      assert.ok(src.source.type === "managed-content");
      writeFileSync(join(src.source.rootDir,src.source.storagePath),"# refreshed");
      const send = reader.writeLibraryNote.bind(reader);
      reader.writeLibraryNote = async (...args) => {
        const reply = await send(...args);
        if (args[0].kind === "saveArtifact") return undefined;
        return reply as never;
      };
      try { assert.equal((await library.saveArtifactAsync(req)).id,first.id); }
      finally { reader.writeLibraryNote=send; }
      assert.equal((await library.readContentAsync(first.id)).content,"# refreshed");
      assert.equal(await library.readVersionBody(first.id,1),"# initial");
      await assert.rejects(library.saveArtifactAsync({...req,owner:{type:"project",projectId:"other"}}));
      const file=join(root,"output.bin");
      const bytes=Buffer.from([0,255,3,14]);
      writeFileSync(file,bytes);
      const binary=await domain.service.register({taskId:"library-art-task",kind:"code",workspaceFile:{entryFile:file,rootDir:root}});
      const binaryReq={...req,artifactId:binary.id};
      const binaryItem=await library.saveArtifactAsync(binaryReq);
      const copied=await library.readPreview(binaryItem.id,"");
      assert.ok(copied);
      assert.deepEqual(readFileSync(copied.path),bytes);
      const replacement=Buffer.from([0xfe,0xff,0x00,0xaf]);
      writeFileSync(file,replacement);
      assert.equal((await library.saveArtifactAsync(binaryReq)).id,binaryItem.id);
      assert.deepEqual(readFileSync(copied.path),replacement);
      const [binaryVersion]=await library.readVersions(binaryItem.id);
      assert.deepEqual(readFileSync(binaryVersion.path),bytes);
      await db.writeTaskRecord({id:"library-art-task",title:"source task",projectId:"check-project",updatedAt:Date.now()});
      await assert.rejects(library.saveArtifactAsync(req));
      const {createLibraryExtension} = await import("../src/main/library/library-extension");
      async function registeredSave(taskId:string) {
        type Tool={name:string;execute(callId:string,params:{artifactId:string;spaceId?:string}):Promise<{isError?:boolean;details:{item?:typeof first}}>};
        const tools = new Map<string,Tool>();
        await createLibraryExtension({service:library,taskId,resolveProjectId:()=>"check-project"})({
          registerTool:(tool:Tool)=>tools.set(tool.name,tool),
        } as never);
        return (params:{artifactId:string;spaceId?:string})=>tools.get("library_save_artifact")!.execute("test",params);
      }
      await db.writeTaskRecord({id:"sibling-in-project",title:"sibling",projectId:"check-project",updatedAt:Date.now()});
      const tool = await registeredSave("sibling-in-project");
      const result = await tool({artifactId:src.id});
      assert.equal(result.isError,undefined);
      assert.equal(result.details.item?.sourceArtifactId,src.id);
      assert.equal((await tool({artifactId:src.id,spaceId:"personal"})).isError,true);
      assert.equal((await (await registeredSave("missing-task"))({artifactId:src.id})).isError,true);
      await db.writeTaskRecord({id:"unowned-artifact-task",title:"private",updatedAt:Date.now()});
      const foreign=await domain.service.register({taskId:"unowned-artifact-task",kind:"markdown",content:"Private"});
      assert.equal((await tool({artifactId:foreign.id})).isError,true);
      assert.equal((await (await registeredSave("unowned-artifact-task"))({artifactId:foreign.id})).isError,true);
      console.log("PASS Pi library_save_artifact permits a same-project source; rejects foreign source, inherited fallback and personal writes");

    }],
    ["desktop create URL writes canonical metadata and rejects invalid destinations", async () => {
      const req = {spaceId:"personal",collectionId:null,url:"https://EXAMPLE.test/中文?x=1",title:"收藏"};
      const item = await library.createUrlAsync(req);
      assert.equal(item.kind,"url");
      assert.equal(item.url,new URL(req.url).href);
      assert.equal(item.sourceType,"url");
      assert.equal((await library.readItemAsync(item.id))?.url,item.url);
      await assert.rejects(library.createUrlAsync({...req,url:"file:///forbidden"}),/http/);
      await assert.rejects(library.createUrlAsync({...req,collectionId:"other-folder"}));
    }],
    ["desktop clip and export retain source, tags, managed image bytes and portable links", async () => {
      const owner = {type:"personal"} as const;
      const url = "https://clip.example.test/page";
      const body = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR1sAAAAASUVORK5CYII=", "base64");
      const wc = {
        isDestroyed: () => false, getURL: () => url, isLoadingMainFrame: () => false,
        executeJavaScriptInIsolatedWorld: async () => ({url,base:url,title:"Clip title",html:'<p>Original quote</p><img src="/inline.png" alt="photo">'}),
        session: { fetch: async () => new Response(body, {headers:{"content-type":"image/png"}}) },
      };
      const browser = {activeTabId:"tab", getTabHost: () => ({inspectionWebContents:wc,captureVersion:1})} as never;
      const request = {type:"clip",owner,spaceId:"personal",collectionId:null,tags:[" tag ","tag"],tabId:"tab",selection:true} as const;
      const clip = await runLibraryNoteOperation(library,browser,null,{...request,tags:[...request.tags]}) as
        import("../src/shared/library-ipc").LibraryNoteOperationResults["clip"];
      assert.deepEqual(clip.failedImages, []);
      const note = (await library.readContentAsync(clip.item.id));
      assert.equal(note.item.clipSource?.url,url);
      assert.deepEqual(note.item.tags,["tag"]);
      assert.match(note.content,/Original quote/);
      assert.match(note.content,/mybuddy-library:/);
      const output = join(root,"clip.md");
      const saved = await runLibraryNoteOperation(library,browser,null,{type:"export",ids:[clip.item.id],format:"markdown"},
        async () => ({filePath:output,canceled:false}));
      assert.equal(saved,true);
      const markdown = readFileSync(output,"utf8");
      const linked = /clip\.assets\/([a-z0-9-]+\.png)/i.exec(markdown)?.[1];
      assert.ok(linked);
      assert.deepEqual(readFileSync(join(root,"clip.assets",linked)),body);
      const htmlPath = join(root,"clip.html");
      const html = '<p>Original quote</p><img src="' + library.previewUrl(linked.slice(0,-4)) + '">';
      assert.equal(await runLibraryNoteOperation(library,browser,null,
        {type:"export",ids:[clip.item.id],format:"html",html}, async () => ({filePath:htmlPath,canceled:false})),true);
      assert.ok(readFileSync(htmlPath,"utf8").includes(body.toString("base64")));
      const zipPath = join(root,"clip.zip");
      const companion = await library.createItemAsync({spaceId:"personal",kind:"markdown",title:"Collection",content:"second"});
      assert.equal(await runLibraryNoteOperation(library,browser,null,
        {type:"export",ids:[clip.item.id,companion.id],format:"markdown"},async () => ({filePath:zipPath,canceled:false})),true);
      const zip = await (await import("jszip")).default.loadAsync(readFileSync(zipPath));
      assert.deepEqual(await zip.file("assets/"+linked)?.async("nodebuffer"),body);
      assert.equal(await zip.file("Collection-"+companion.id+".md")?.async("string"),"second");
      await assert.rejects(runLibraryNoteOperation(library,browser,null,{...request,tags:[],owner:{type:"workspace",workspaceId:"foreign"}}));
      await library.deleteItemAsync(clip.item.id);
    }],
    [
      "desktop attach, current task scope, idempotent receipt and detach",
      async () => {
        const taskId="attachment-task";
        await db.writeTaskRecord({id:taskId,title:"Active",updatedAt:Date.now()});
        const note=await library.createItemAsync({spaceId:"personal",kind:"markdown",title:"attachment",content:"specific item"});
        const input={taskId,itemId:note.id};
        await assert.rejects(library.attachToTaskAsync(input,true));
        const receipt=await library.attachToTaskAsync(input);
        assert.equal(receipt.itemId,note.id);
        assert.deepEqual(await library.attachToTaskAsync(input),receipt);
        assert.deepEqual((await library.readTaskReferences(taskId)).items.map(row=>row.id),[note.id]);
        const projectItem=(await library.readSnapshot({owner:{type:"project",projectId:"check-project"}})).items[0];
        assert(projectItem);
        await assert.rejects(async()=>library.attachToTaskAsync({taskId,itemId:projectItem.id}));
        await library.detachFromTaskAsync(input);
        assert.deepEqual((await library.readTaskReferences(taskId)).items,[]);
        const projectTask = "project-reference-task";
        await db.writeTaskRecord({id:projectTask,title:"Project task",projectId:"check-project",updatedAt:Date.now()});
        type Tool = {name:string; execute(id:string, args:{id:string}): Promise<{isError?:boolean}>};
        const tools=new Map<string,Tool>();
        createLibraryExtension({service:library,taskId:projectTask})({registerTool:(tool:Tool)=>tools.set(tool.name,tool)} as never);
        const attach=tools.get("library_attach_to_task")!, detach=tools.get("library_detach_from_task")!;
        assert.equal((await attach.execute("cross",{id:note.id})).isError,true);
        assert.ok(!(await attach.execute("add",{id:projectItem.id})).isError);
        assert.deepEqual((await library.readTaskReferences(projectTask)).items.map(row=>row.id),[projectItem.id]);
        assert.ok(!(await detach.execute("del",{id:projectItem.id})).isError);
        assert.deepEqual((await library.readTaskReferences(projectTask)).items,[]);
      },
    ],
    ["desktop catalog spaces, nested folders, item edits and guarded rollback", async () => {
      const own = await library.createSpaceAsync({name:"User space"});
      assert.equal((await library.renameSpaceAsync(own.id,"Renamed")).name,"Renamed");
      assert.equal((await library.ensureOwnedSpaceAsync({type:"personal"})).id,"personal");
      await assert.rejects(library.renameSpaceAsync("personal","Forbidden"));
      await db.writeWorkspaceUpsert({id:"catalog-owner",name:"Catalog owner"});
      const scope = {type:"workspace",workspaceId:"catalog-owner"} as const;
      const [space, same] = await Promise.all([library.ensureOwnedSpaceAsync(scope),library.ensureOwnedSpaceAsync(scope)]);
      assert.equal(space.id,same.id);
      assert.equal(space.workspaceName,"Catalog owner");
      const folder = await library.createCollectionAsync({spaceId:space.id,name:"Parent"});
      const child = await library.createCollectionAsync({spaceId:space.id,parentId:folder.id,name:"Child"});
      await assert.rejects(library.moveCollectionAsync({id:folder.id,parentId:child.id}));
      assert.equal((await library.renameCollectionAsync({id:child.id,name:"Revised"})).name,"Revised");
      assert.equal((await library.moveCollectionAsync({id:child.id,parentId:null})).parentId,null);
      const other = await library.createCollectionAsync({spaceId:own.id,name:"Foreign"});
      await assert.rejects(library.moveCollectionAsync({id:child.id,parentId:other.id}));
      const saved = await library.createItemAsync({spaceId:space.id,kind:"markdown",title:"Original",content:"body remains"});
      await assert.rejects(library.updateItemAsync({id:saved.id,title:"partial",collectionId:other.id}));
      assert.equal((await library.readSnapshot({itemId:saved.id})).items[0].title,"Original");
      const renamed = await library.updateItemAsync({id:saved.id,title:"Final",collectionId:child.id});
      assert.deepEqual([renamed.title,renamed.filename,renamed.collectionId],["Final","Final.md",child.id]);
      assert.equal((await library.readContentAsync(saved.id)).content,"body remains");
      assert.equal((await library.readSnapshot({owner:scope})).items[0].id,saved.id);
    }],
    [
      "recover restores",
      async () => {
        await library.recoverLibraryRestores();
      },
    ],
  ];
  for (const [name, run] of cases) {
    try {
      await run();
      console.log("PASS", name);
    } catch (err) {
      console.error("FAIL", name, err);
      process.exitCode = 1;
    }
  }
  assert.ok(!existsSync(join(root, "app.db")));
} finally {
  await db.runtimeAuditReader?.close();
  await shutdownCoreWorker(root, path);
  rmSync(root, { recursive: true, force: true });
}
