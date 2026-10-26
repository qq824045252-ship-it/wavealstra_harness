import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { LibraryService } from "../src/main/library/LibraryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor } from "../src/main/project/ProjectEventIngestor";
import {
  ProjectDocumentImporter,
  ProjectDocumentImportPartialStateError,
} from "../src/main/project/ProjectDocumentImporter";

const root = mkdtempSync(join(tmpdir(), "mybuddy-import-tx-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
db.connection.prepare(`INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','P1',1,1),('p2','P2',1,1),('p3','P3',1,1),('p4','P4',1,1)`).run();
let clock = 2000;
const ingestor = new ProjectEventIngestor(projects, { now: () => ++clock });
const importer = new ProjectDocumentImporter(projects, library, ingestor);

function source(name: string, body: string): string {
  const path = join(root, name);
  writeFileSync(path, body, "utf8");
  return path;
}

async function main(): Promise<void> {
try {
  // 1. Event ingest failure after Library item creation -> item and newly-created space both roll back.
  const path1 = source("ingest-fail.md", "one");
  const realIngest = ingestor.ingest.bind(ingestor);
  (ingestor as any).ingest = () => { throw new Error("fixture ingest failure"); };
  await assert.rejects(() => importer.importFile("p1", path1), /fixture ingest failure/);
  (ingestor as any).ingest = realIngest;
  assert.equal(library.listProjectSpaces("p1").length, 0, "failed import removes the lazily-created empty Library Space");
  assert.equal(projects.listProjectEvents("p1").length, 0);

  // 2. Pre-existing Library Space survives, but failed item is removed.
  const existing = library.createSpace({ name: "existing", projectId: "p2" });
  const path2 = source("existing-space.md", "two");
  (ingestor as any).ingest = () => { throw new Error("fixture existing-space ingest failure"); };
  await assert.rejects(() => importer.importFile("p2", path2), /fixture existing-space ingest failure/);
  (ingestor as any).ingest = realIngest;
  assert(library.getSpace(existing.id));
  assert.equal(library.listItems(existing.id).length, 0, "only the failed item is removed from a pre-existing space");

  // 3. True async loser scenario: another import wins while this importer is extracting.
  const path3 = source("race.md", "same bytes for race");
  const hash3 = createHash("sha256").update(Buffer.from("same bytes for race")).digest("hex");
  const realExtract = library.getExtractedText.bind(library);
  let winnerItemId = "";
  let injected = false;
  (library as any).getExtractedText = async (item: any) => {
    if (!injected) {
      injected = true;
      const winner = library.importFile({ spaceId: item.spaceId, sourcePath: path3 });
      winnerItemId = winner.id;
      realIngest("p3", {
        source: "document",
        kind: "note",
        title: basename(path3),
        body: "winner",
        ref: hash3,
        payload: { libraryItemId: winner.id, sizeBytes: Buffer.byteLength("same bytes for race"), extractStatus: "extracted", extractTruncated: false },
      });
    }
    return { status: "extracted", text: "same bytes for race", truncated: false } as any;
  };
  const race = await importer.importFile("p3", path3);
  (library as any).getExtractedText = realExtract;
  assert.equal(race.reused, true, "loser importer reports durable event reuse");
  assert.equal(race.item?.id, winnerItemId, "result returns the item actually referenced by the durable event");
  const p3space = library.listProjectSpaces("p3")[0]!;
  const p3items = library.listItems(p3space.id);
  assert.deepEqual(p3items.map((item) => item.id), [winnerItemId], "loser Library item is compensated; exactly the winner remains");
  assert.equal(projects.findProjectEventByRef("p3", "document", hash3)?.payload?.libraryItemId, winnerItemId);

  // 4. Library import failure after lazy space creation must not leave an empty space.
  const path4 = source("library-fail.md", "four");
  const realImportFile = library.importFile.bind(library);
  (library as any).importFile = () => { throw new Error("fixture library import failure"); };
  await assert.rejects(() => importer.importFile("p4", path4), /fixture library import failure/);
  (library as any).importFile = realImportFile;
  assert.equal(library.listProjectSpaces("p4").length, 0, "Library import failure cleans up newly-created empty project space");

  // 5. Rollback failure is explicit and points at the residual item.
  const path5 = source("rollback-fail.md", "five");
  const p4space = library.createSpace({ name: "p4 residual", projectId: "p4" });
  (ingestor as any).ingest = () => { throw new Error("fixture event failure before rollback"); };
  const realDeleteItem = library.deleteItem.bind(library);
  (library as any).deleteItem = () => { throw new Error("fixture item rollback failure"); };
  let partial: ProjectDocumentImportPartialStateError | undefined;
  try {
    await importer.importFile("p4", path5);
  } catch (error) {
    if (error instanceof ProjectDocumentImportPartialStateError) partial = error;
    else throw error;
  }
  (library as any).deleteItem = realDeleteItem;
  (ingestor as any).ingest = realIngest;
  assert(partial, "rollback failure must surface typed partial state");
  assert.equal(partial!.spaceId, p4space.id);
  assert(partial!.itemId && library.getItem(partial!.itemId), "typed error identifies the residual Library item");
  realDeleteItem(partial!.itemId!);

  console.log("project document import transaction: PASS (event rollback, space ownership, async loser cleanup, explicit partial state)");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
}

void main().catch((error) => {
  console.error("project-file-import-transaction-test: FAILED", error);
  process.exitCode = 1;
});
