import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { LibraryRepository } from "../src/main/library/LibraryRepository";
import type { LibraryEvidenceJudge } from "../src/main/library/LibraryDeepSearch";
import type { LibraryOwnerScope } from "../src/shared/library-ipc";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-library-deep-search-"));
  const db = new AppDatabase(join(root, "test.db"));
  const library = new LibraryService(db, { libraryRoot: join(root, "library") });
  try {
    db.connection.exec(`INSERT INTO projects(id,name,created_at,updated_at)
      VALUES ('local','Local',1,1),('foreign','Foreign',1,1);
      INSERT INTO tasks(id,title,status,updated_at,project_id) VALUES ('task','Task','pending',1,'local');`);
    const owner: LibraryOwnerScope = { type: "project", projectId: "local" };
    const other: LibraryOwnerScope = { type: "project", projectId: "foreign" };
    const space = library.ensureOwnedSpace(owner);
    const external = library.ensureOwnedSpace(other);
    const docs = library.createCollection({ spaceId: space.id, name: "Evidence" });
    const add = (spaceId: string, title: string, content: string, collectionId?: string) => {
      const item = library.createItem({ spaceId, collectionId, kind: "markdown", title });
      library.writeContent({ id: item.id, content });
      return item.id;
    };
    const seed = add(space.id, "Index", "Norlite service follows rule BX-73.", docs.id);
    const bridge = add(space.id, "Routing", "BX-73 delegates entitlement to ALTA-86.", docs.id);
    const finalText = `${"other ".repeat(200)}ALTA-86 coverage lasts 45 days.`;
    const final = add(space.id, "Policy", finalText, docs.id);
    const outside = add(external.id, "Private", "Norlite BX-73 ALTA-86 is confidential.");
    const filtered = add(space.id, "Outside folder", "Norlite BX-73 is outside the selected folder.");
    const short = add(space.id, "Short keyword", "撤销适用于这一条记录。", docs.id);
    const titleOnly = add(space.id, "Omega handbook", "Use form K23 for renewal.", docs.id);
    const repo = new LibraryRepository(db.connection);
    assert.deepEqual([...repo.deepSearchTermFrequencies({ spaceIds: new Set(), collectionIds: new Set([docs.id]) },
      ["norlite", "confidential"])], [["norlite", 1], ["confidential", 0]]);
    // Only "Norlite" seeds the test. The bridge and final document use different vocabulary.
    const request = { owner, query: "Norlite warranty period?", reference: { spaceId: space.id, collectionId: docs.id } };
    let calls = 0;
    const judge: LibraryEvidenceJudge = async ({ previousEvidence, candidates }, signal, validate) => {
      assert.equal(signal.aborted, false);
      validate();
      assert.equal(previousEvidence.length, calls);
      const expected = ["Index", "Routing", "Policy"][calls++];
      assert.deepEqual(candidates.map((passage) => passage.title), [expected]);
      // Both expansions must be discovered from the original passages with score-only replies.
      return JSON.stringify({ judgments: [{ id: 0, score: expected === "Policy" ? 3 : 2 }] });
    };
    const result = await library.deepSearchOwnedScope(request, async () => judge);
    assert.equal(result.rounds, 3);
    assert.deepEqual(result.hits.map(({ itemId }) => itemId), [final, seed, bridge]);
    const hit = result.hits[0]!;
    assert.ok(hit.source.startOffset > 0);
    assert.equal(hit.text, finalText.slice(hit.source.startOffset, hit.source.endOffset));
    assert.deepEqual(library.readOwnedEvidence({ ...request, itemId: hit.itemId, source: hit.source }), { text: hit.text });
    assert.throws(() => library.readOwnedEvidence({ owner: other, itemId: hit.itemId, source: hit.source }), /资料范围/);

    const shortResult = await library.deepSearchOwnedScope({ ...request, query: "撤销" }, async () => async ({ candidates }) => {
      assert.deepEqual(candidates.map(({ title }) => title), ["Short keyword"]);
      return JSON.stringify({ judgments: [{ id: 0, score: 3, terms: [] }] });
    });
    assert.deepEqual(shortResult.hits.map(({ itemId }) => itemId), [short]);
    const titleResult = await library.deepSearchOwnedScope({ ...request, query: "Omega" }, async () => async ({ candidates }) => {
      assert.deepEqual(candidates.map(({ title }) => title), ["Omega handbook"]);
      return JSON.stringify({ judgments: [{ id: 0, score: 3, terms: [] }] });
    });
    assert.deepEqual(titleResult.hits.map(({ itemId }) => itemId), [titleOnly]);

    const taskJudge: LibraryEvidenceJudge = async ({ candidates }) => {
      assert.ok(candidates.every(({ title }) => title !== "Private"));
      return JSON.stringify({ judgments: candidates.map(({ id }) => ({ id, score: 2 })) });
    };
    const taskScope = () => library.resolveTaskScope("task");
    const taskResult = await library.deepSearchInTaskScope(request.query, undefined, taskScope, async () => taskJudge);
    assert.deepEqual(taskResult.hits.map(({ itemId }) => itemId).sort(), [seed, bridge, final, filtered].sort());
    assert.ok(!taskResult.hits.some(({ itemId }) => itemId === outside));

    await assert.rejects(library.deepSearchOwnedScope(request, async () => { throw new Error("判断模型未配置"); }), /判断模型未配置/);
    await assert.rejects(library.deepSearchOwnedScope(request, async () => async () => "{}"), /无效的证据评分/);
    const abort = new AbortController();
    await assert.rejects(library.deepSearchInTaskScope(request.query, undefined, taskScope, async () =>
      async () => { abort.abort(); return "{}"; }, abort.signal), { name: "AbortError" });
    await assert.rejects(library.deepSearchInTaskScope(request.query, undefined, taskScope, async () =>
      async (_input, _signal, validate) => {
        db.connection.prepare("UPDATE tasks SET project_id = 'foreign' WHERE id = 'task'").run();
        validate();
        assert.fail("must stop before dispatch");
      }), /资料范围或索引已变化/);
    library.writeContent({ id: final, content: "The policy has changed." });
    assert.throws(() => library.readOwnedEvidence({ ...request, itemId: hit.itemId, source: hit.source }), /片段已更新/);
    console.log("library-deep-search-test: ok");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
