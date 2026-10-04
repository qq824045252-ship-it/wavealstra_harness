/**
 * Workspace Resolver Foundation — Deterministic Resolver Tests
 * Covers: candidate ordering, archived exclusion, explicit precedence,
 * hierarchy/ancestors, sibling isolation, fallback, attach path via DB contract,
 * plus P2 fixes: cycle/self-loop, missing parent, duplicate candidates,
 * active context gate, toAttachRequest strict.
 *
 * Run: pnpm run test:workspace-resolver
 */
import assertStrict from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import {
  resolveTaskSpace,
  listCandidateSpaces,
  getSpaceAncestorsDeterministic,
  isSpaceValidForResolver,
  toAttachRequest,
  getInheritedContextSpaces,
  canUseImplicitContext,
} from "../src/shared/workspace-resolver";
import { buildSpaceEffectiveMap } from "../src/shared/workspace-tree";
import type { SpaceDto, TaskDto } from "../src/shared/agent-ipc";

let passed = 0;
let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  try {
    assertStrict.deepStrictEqual(actual, expected);
    passed++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${label}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual  : ${JSON.stringify(actual)}`);
  }
}

async function main(): Promise<void> {
  console.log("== 1) explicit task.spaceId wins over home/draft ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 },
      { id: "a1", name: "A1", parentId: "a", sortOrder: 1000, createdAt: 4 },
    ];
    const res = resolveTaskSpace({
      spaces,
      taskSpaceId: "a1",
      homeSpaceId: "b",
      draftSpaceId: "a",
    });
    assert(res.resolvedSpaceId === "a1", `explicit a1 wins over b/home and a/draft, got ${res.resolvedSpaceId}`);
    assert(res.reason === "explicit" && res.confidence === "high", "explicit reason/conf high");
    assert(res.explicit === true, "explicit flag true");
    assert(res.advisory === true, "advisory true");
    // candidates: a1 + ancestors [a, root]
    assertEqual(res.candidates.map((c) => c.spaceId), ["a1", "a", "root"], "explicit candidates = primary + ancestors");
    assert(res.candidates[0]!.reason === "explicit", "primary reason explicit");
    assert(res.candidates[1]!.reason === "ancestor", "ancestor reason");
  }

  console.log("== 2) explicit null (standalone) wins and is advisory standalone ==");
  {
    const spaces: SpaceDto[] = [{ id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 }];
    const res = resolveTaskSpace({ spaces, taskSpaceId: null, homeSpaceId: "root" });
    assert(res.resolvedSpaceId === null, "explicit null wins");
    assert(res.reason === "explicit", "explicit null reason");
    assert(res.candidates.length === 1 && res.candidates[0]!.spaceId === null, "single null candidate");
  }

  console.log("== 3) draft precedence over home when both valid ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 },
    ];
    const res = resolveTaskSpace({ spaces, homeSpaceId: "b", draftSpaceId: "a" });
    assert(res.resolvedSpaceId === "a", `draft a wins over home b, got ${res.resolvedSpaceId}`);
    assert(res.reason === "draft", "reason draft");
  }

  console.log("== 4) home valid when no explicit/draft ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
    ];
    const res = resolveTaskSpace({ spaces, homeSpaceId: "a" });
    assert(res.resolvedSpaceId === "a", "home a resolved");
    assert(res.reason === "active-home", "active-home reason");
    assertEqual(res.candidates.map((c) => c.spaceId), ["a", "root"], "home candidates a->root");
  }

  console.log("== 5) archived/effectiveArchived exclusion ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1, archived: false },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2, archived: false },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3, archived: true },
      { id: "a1", name: "A1", parentId: "a", sortOrder: 1000, createdAt: 4, archived: false },
      { id: "archChild", name: "ArchChild", parentId: "a", sortOrder: 2000, createdAt: 5, archived: true },
    ];
    // effective check: b archived, archChild archived, but a1 not archived
    // home = b (archived) should be excluded, fallback to none
    const res1 = resolveTaskSpace({ spaces, homeSpaceId: "b" });
    assert(res1.resolvedSpaceId === null && res1.reason === "none", "archived home excluded -> fallback none");
    assert(res1.candidates.length === 0, "no candidates when archived home");

    // explicit archived should be excluded and fallback
    const res2 = resolveTaskSpace({ spaces, taskSpaceId: "b", homeSpaceId: "a" });
    assert(res2.resolvedSpaceId === "a", `explicit archived b invalid, fallback to home a, got ${res2.resolvedSpaceId}`);
    assert(res2.reason === "active-home", "fallback to active-home");

    // effectiveArchived: archive parent a, then a1 effectiveArchived
    const spaces2: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2, archived: true },
      { id: "a1", name: "A1", parentId: "a", sortOrder: 1000, createdAt: 3, archived: false },
    ];
    const eff = buildSpaceEffectiveMap(spaces2);
    assert(eff.get("a1") === true, "a1 effectiveArchived via parent");
    const res3 = resolveTaskSpace({ spaces: spaces2, homeSpaceId: "a1" });
    assert(res3.reason === "none", "effectiveArchived child excluded");

    // isSpaceValidForResolver should reflect same
    assert(isSpaceValidForResolver("a1", spaces2) === false, "isValid false for effectiveArchived");
    assert(isSpaceValidForResolver("b", spaces) === false, "isValid false for explicit archived");
    assert(isSpaceValidForResolver("a", spaces) === true, "isValid true for non-archived");

    // listCandidateSpaces excludes archived/effective
    const listed = listCandidateSpaces(spaces);
    assert(!listed.some((s) => s.id === "b"), "list excludes archived b");
    assert(!listed.some((s) => s.id === "archChild"), "list excludes archChild");
    assert(listed.some((s) => s.id === "a") && listed.some((s) => s.id === "a1"), "list includes valid a,a1");

    const listed2 = listCandidateSpaces(spaces2);
    assert(!listed2.some((s) => s.id === "a1"), "list excludes effectiveArchived a1");
    assert(!listed2.some((s) => s.id === "a"), "list excludes archived a");

    // includeArchived=true should include them
    const listedInc = listCandidateSpaces(spaces, { includeArchived: true });
    assert(listedInc.some((s) => s.id === "b"), "includeArchived includes b");
  }

  console.log("== 6) hierarchy / ancestor semantics: child inherits ancestors, ancestors order ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "a1", name: "A1", parentId: "a", sortOrder: 1000, createdAt: 3 },
      { id: "a1x", name: "A1X", parentId: "a1", sortOrder: 1000, createdAt: 4 },
    ];
    const chain = getSpaceAncestorsDeterministic("a1x", spaces);
    assertEqual(chain, ["a1", "a", "root"], "ancestor chain a1x->a1->a->root");
    const res = resolveTaskSpace({ spaces, homeSpaceId: "a1x" });
    assertEqual(res.candidates.map((c) => c.spaceId), ["a1x", "a1", "a", "root"], "resolver candidates inherit ancestors depth order");
    // depths
    assertEqual(res.candidates.map((c) => c.depth), [0, 1, 2, 3], "depths 0..3");
    // inherited context helper
    assertEqual(getInheritedContextSpaces("a1x", spaces), ["a1x", "a1", "a", "root"], "inherited context includes self+ancestors");
    assertEqual(getInheritedContextSpaces(null, spaces), [], "null inherited empty");

    // Parent does not automatically include child
    const parentChain = getSpaceAncestorsDeterministic("a", spaces);
    assertEqual(parentChain, ["root"], "parent a's ancestors does not include child a1");
    const resParent = resolveTaskSpace({ spaces, homeSpaceId: "a" });
    assert(!resParent.candidates.some((c) => c.spaceId === "a1"), "parent candidates does not include child (no upward promotion)");
    assert(!resParent.candidates.some((c) => c.spaceId === "a1x"), "parent does not include grandchild");
  }

  console.log("== 7) sibling isolation: no cross-sibling leakage ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 },
      { id: "a1", name: "A1", parentId: "a", sortOrder: 1000, createdAt: 4 },
      { id: "b1", name: "B1", parentId: "b", sortOrder: 1000, createdAt: 5 },
    ];
    const resA = resolveTaskSpace({ spaces, homeSpaceId: "a" });
    assert(!resA.candidates.some((c) => c.spaceId === "b"), "home a does not leak sibling b");
    assert(!resA.candidates.some((c) => c.spaceId === "b1"), "home a does not leak sibling's child b1");
    assert(resA.candidates.some((c) => c.spaceId === "a"), "home a includes self");
    assert(resA.candidates.some((c) => c.spaceId === "root"), "home a includes ancestor root");

    const resA1 = resolveTaskSpace({ spaces, homeSpaceId: "a1" });
    assert(!resA1.candidates.some((c) => c.spaceId === "b1"), "a1 does not leak cousin b1");
    assert(!resA1.candidates.some((c) => c.spaceId === "b"), "a1 does not leak uncle b");
    // explicit a1 should also not leak b
    const resExplicitA1 = resolveTaskSpace({ spaces, taskSpaceId: "a1" });
    assert(!resExplicitA1.candidates.some((c) => c.spaceId === "b"), "explicit a1 no sibling b");

    // listCandidateSpaces is global ordered, but resolver's advisory candidates must not include siblings
    // So we verify that resolver's candidates length for leaf is only ancestors, not global list
    assert(resA.candidates.length === 2, `home a candidates length 2 (a,root), got ${resA.candidates.length}`);
  }

  console.log("== 8) deterministic ordering and stable tie-breaking ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 10 },
      { id: "s1", name: "S1", parentId: "root", sortOrder: 1000, createdAt: 1 },
      { id: "s2", name: "S2", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "s3", name: "S3", parentId: "root", sortOrder: 2000, createdAt: 3 },
    ];
    // Same input twice yields identical ordering
    const r1 = resolveTaskSpace({ spaces, homeSpaceId: "s1" });
    const r2 = resolveTaskSpace({ spaces, homeSpaceId: "s1" });
    assertEqual(r1.candidates.map((c) => c.spaceId), r2.candidates.map((c) => c.spaceId), "deterministic: same input same candidates order");

    // listCandidateSpaces deterministic ordering: sortOrder ASC, createdAt ASC, id ASC
    const listed = listCandidateSpaces(spaces);
    const expectedOrder = [...spaces].sort((a, b) => {
      if ((a.sortOrder ?? 0) !== (b.sortOrder ?? 0)) return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if ((a.createdAt ?? 0) !== (b.createdAt ?? 0)) return (a.createdAt ?? 0) - (b.createdAt ?? 0);
      return a.id.localeCompare(b.id);
    }).map((s) => s.id);
    assertEqual(listed.map((s) => s.id), expectedOrder, `deterministic global order ${expectedOrder.join(",")}`);

    // Two different runs with shuffled input order must yield same deterministic output (stable sort)
    const shuffled: SpaceDto[] = [spaces[2]!, spaces[0]!, spaces[3]!, spaces[1]!];
    const listedShuffled = listCandidateSpaces(shuffled);
    assertEqual(listedShuffled.map((s) => s.id), expectedOrder, "shuffled input still deterministic same order");

    // Ancestor chain deterministic: repeated calls same result
    const anc1 = getSpaceAncestorsDeterministic("s1", spaces);
    const anc2 = getSpaceAncestorsDeterministic("s1", spaces);
    assertEqual(anc1, anc2, "ancestor deterministic");
  }

  console.log("== 9) fallback / no-candidate behavior ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
    ];
    // No context at all
    const resNone = resolveTaskSpace({ spaces });
    assert(resNone.resolvedSpaceId === null && resNone.reason === "none" && resNone.confidence === "none", "no context => none");
    assert(resNone.candidates.length === 0, "no context => empty candidates");
    assert(resNone.advisory === true, "none still advisory");

    // Invalid home (non-existent)
    const resInvalidHome = resolveTaskSpace({ spaces, homeSpaceId: "missing" });
    assert(resInvalidHome.reason === "none", "invalid home => none");

    // All spaces archived -> no valid candidate even with home
    const archivedSpaces: SpaceDto[] = [{ id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1, archived: true }];
    const resArch = resolveTaskSpace({ spaces: archivedSpaces, homeSpaceId: "root" });
    assert(resArch.reason === "none", "all archived => none");

    // Explicit invalid should fallback to valid home
    const resFallback = resolveTaskSpace({ spaces, taskSpaceId: "missing", homeSpaceId: "a" });
    assert(resFallback.resolvedSpaceId === "a" && resFallback.reason === "active-home", "explicit missing fallback to home");

    // toAttachRequest should return null for none — now requires currentSpaceId
    const attachNone1 = toAttachRequest(resNone, "t1", null);
    assert(attachNone1 === null, "toAttachRequest null for none (current null)");
    const attachNone2 = toAttachRequest(resNone, "t1", "a");
    assert(attachNone2 === null, "toAttachRequest null for none (current a)");

    // toAttachRequest should return null if already at target
    const resExplicit = resolveTaskSpace({ spaces, taskSpaceId: "a" });
    const attachNoop = toAttachRequest(resExplicit, "t1", "a");
    assert(attachNoop === null, "toAttachRequest null if already at target (no silent reparent)");

    // toAttachRequest valid case
    const resHome = resolveTaskSpace({ spaces, homeSpaceId: "a" });
    const attach = toAttachRequest(resHome, "t1", null);
    assert(attach !== null && attach.targetSpaceId === "a" && attach.taskId === "t1", "toAttachRequest valid");
  }

  console.log("== 10) advisory by default: never silently reparent, must go through move contract ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 },
    ];
    const res = resolveTaskSpace({ spaces, homeSpaceId: "b" });
    assert(res.advisory === true, "advisory true");
    const currentSpaceId = "a";
    const attach = toAttachRequest(res, "tX", currentSpaceId);
    assert(attach !== null && attach.targetSpaceId === "b", "advisory suggests b but caller must decide");
    assert(toAttachRequest(res, "tX", "b") === null, "already in b => no attach");

    const spacesArch: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "b", name: "B", parentId: "root", sortOrder: 1000, createdAt: 2, archived: true },
    ];
    const resArch = resolveTaskSpace({ spaces: spacesArch, homeSpaceId: "b" });
    assert(resArch.reason === "none", "archived home not suggested");
    assert(toAttachRequest(resArch, "tX", "a") === null, "no attach for archived suggestion");
  }

  console.log("== 11) attach path via existing moveTaskInWorkspaceTree contract (real DB) ==");
  {
    const dir = mkdtempSync(join(tmpdir(), "resolver-attach-"));
    const dbPath = join(dir, "test.db");
    try {
      const db = new AppDatabase(dbPath);
      db.createSpace({ id: "root", name: "Root" });
      db.createSpace({ id: "a", name: "A", parentId: "root" });
      db.createSpace({ id: "a1", name: "A1", parentId: "a" });
      db.createSpace({ id: "b", name: "B", parentId: "root" });
      db.upsertTask({ id: "t1", title: "task1", updatedAt: 1, spaceId: "a" });
      db.upsertTask({ id: "t2", title: "standalone", updatedAt: 2, spaceId: null });
      const spaces = db.listSpaces();
      const tasks = db.listTasks();
      // Advisory: explicit lookup for t1 => explicit a
      const resExplicit = resolveTaskSpace({ spaces, tasks, taskId: "t1" });
      assert(resExplicit.resolvedSpaceId === "a", `DB t1 explicit a, got ${resExplicit.resolvedSpaceId}`);
      assert(resExplicit.candidates[0]!.spaceId === "a", "t1 candidates primary a");

      // For t2 (standalone via DB, spaceId maps to undefined via mapTaskRow), no explicit; home b is implicit — gate blocks non-active
      const resExplicitNull = resolveTaskSpace({ spaces, tasks, taskId: "t2", homeSpaceId: "b" });
      assert(resExplicitNull.reason === "none" && resExplicitNull.resolvedSpaceId === null, "t2 standalone + home b non-active => none (gate blocks)");
      const resActiveT2 = resolveTaskSpace({ spaces, tasks, taskId: "t2", homeSpaceId: "b", activeTaskId: "t2" });
      assert(resActiveT2.resolvedSpaceId === "b" && resActiveT2.reason === "active-home", "t2 active => home b allowed");

      // New task (no taskId) with home b => should advise b (gate allows new task)
      const resHomeNew = resolveTaskSpace({ spaces, homeSpaceId: "b" });
      assert(resHomeNew.resolvedSpaceId === "b", `new task home b => b, got ${resHomeNew.resolvedSpaceId}`);
      const attachReq = toAttachRequest(resHomeNew, "t2", null);
      assert(attachReq !== null && attachReq.targetSpaceId === "b", "attach request for t2 (null->b) via new-task home");
      if (attachReq) {
        db.moveTaskInWorkspaceTree({ taskId: attachReq.taskId, targetSpaceId: attachReq.targetSpaceId });
        const after = db.getTask("t2");
        assert(after?.spaceId === "b", `DB after move t2->b, got ${after?.spaceId}`);
      }
      // Archived guard: archive b, then advisory should not propose b, and DB move should be rejected
      db.archiveSpace("b", true);
      const spacesAfterArch = db.listSpaces();
      const resAfterArch = resolveTaskSpace({ spaces: spacesAfterArch, homeSpaceId: "b" });
      assert(resAfterArch.reason === "none", "after archive b, home b not valid");
      const attachArch = toAttachRequest(resAfterArch, "t1", "a");
      assert(attachArch === null, "no attach when archived");

      let threw = false;
      try {
        db.moveTaskInWorkspaceTree({ taskId: "t1", targetSpaceId: "b" });
      } catch (e) {
        threw = true;
        assert(String(e).includes("归档"), `DB archived guard throws with 归档, got ${String(e)}`);
      }
      assert(threw, "DB move to archived throws");
      assert(db.getTask("t1")?.spaceId === "a", "t1 still in a after failed archived move");

      const spacesOrig = [db.getSpace("root")!, db.getSpace("a")!, db.getSpace("a1")!, { id: "b", name: "B", parentId: "root", sortOrder: 3000, createdAt: 999, archived: false } as SpaceDto];
      const resOrigA1 = resolveTaskSpace({ spaces: spacesOrig, homeSpaceId: "a1" });
      assert(!resOrigA1.candidates.some((c) => c.spaceId === "b"), "DB sibling b not in a1 candidates");

      db.close();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }

  console.log("== 12) deterministic no-random heuristics: confidence/reason explicit ==");
  {
    const spaces: SpaceDto[] = [{ id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 }];
    const r1 = resolveTaskSpace({ spaces, homeSpaceId: "root" });
    const r2 = resolveTaskSpace({ spaces, homeSpaceId: "root" });
    assertEqual(r1, r2, "repeated calls produce identical result (deterministic, no random)");
    assert(r1.confidence === "high" && r1.reason === "active-home", "home has high/active-home metadata");
    const rNone = resolveTaskSpace({ spaces });
    assert(rNone.confidence === "none" && rNone.reason === "none", "none has explicit none metadata, not hidden heuristic");

    const rExplicit = resolveTaskSpace({ spaces, taskSpaceId: "root" });
    assert(rExplicit.confidence === "high" && rExplicit.reason === "explicit", "explicit has high/explicit");

    const spaces2: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
    ];
    const rDraft = resolveTaskSpace({ spaces: spaces2, draftSpaceId: "a", homeSpaceId: "root" });
    assert(rDraft.reason === "draft" && rDraft.confidence === "high", "draft high/draft");
  }

  console.log("== 13) taskId lookup via tasks array fallback ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
    ];
    const tasks: TaskDto[] = [{ id: "t1", title: "t", spaceId: "a", updatedAt: 1 }];
    const res = resolveTaskSpace({ spaces, tasks, taskId: "t1" });
    assert(res.resolvedSpaceId === "a" && res.reason === "explicit", "taskId lookup resolves to tasks' spaceId a");
    // Without tasks array, taskId + home is gated: without activeTaskId should be none
    const resNoTasksBlocked = resolveTaskSpace({ spaces, taskId: "t1", homeSpaceId: "root" });
    assert(resNoTasksBlocked.reason === "none" && resNoTasksBlocked.resolvedSpaceId === null, "taskId without active gate blocks home => none");
    // With matching activeTaskId, home is allowed via gate
    const resNoTasksAllowed = resolveTaskSpace({ spaces, taskId: "t1", homeSpaceId: "root", activeTaskId: "t1" });
    assert(resNoTasksAllowed.resolvedSpaceId === "root" && resNoTasksAllowed.reason === "active-home", "matching activeTaskId allows home");
  }

  console.log("== 14) cycle/self-loop/missing parent/candidates deduplication ==");
  {
    // self-loop a→a
    const selfSpaces: SpaceDto[] = [{ id: "a", name: "A", parentId: "a", sortOrder: 1000, createdAt: 1 }];
    const selfChain = getSpaceAncestorsDeterministic("a", selfSpaces);
    assertEqual(selfChain, [], "self-loop a->a ancestor must be empty, not containing itself");
    const selfRes = resolveTaskSpace({ spaces: selfSpaces, homeSpaceId: "a" });
    assertEqual(selfRes.candidates.map((c) => c.spaceId), ["a"], "self-loop candidates only primary, no duplicate self");
    assertEqual(selfRes.candidates.map((c) => c.depth), [0], "self-loop depth only 0");
    assert(selfRes.candidates.length === new Set(selfRes.candidates.map((c) => String(c.spaceId))).size, "self-loop no duplicate candidates");
    assertEqual(getInheritedContextSpaces("a", selfSpaces), ["a"], "self-loop inherited only self, not duplicate");

    // two-cycle A→B→A
    const twoSpaces: SpaceDto[] = [
      { id: "A", name: "A", parentId: "B", sortOrder: 1000, createdAt: 1 },
      { id: "B", name: "B", parentId: "A", sortOrder: 1000, createdAt: 2 },
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 0 },
    ];
    const chainA = getSpaceAncestorsDeterministic("A", twoSpaces);
    assertEqual(chainA, ["B"], "two-cycle A->B->A: A ancestors only [B], not [B,A]");
    const chainB = getSpaceAncestorsDeterministic("B", twoSpaces);
    assertEqual(chainB, ["A"], "two-cycle B->A->B: B ancestors only [A]");
    const resA = resolveTaskSpace({ spaces: twoSpaces, homeSpaceId: "A" });
    assertEqual(resA.candidates.map((c) => c.spaceId), ["A", "B"], "two-cycle A candidates [A,B] no duplicate primary");
    assert(resA.candidates.length === 2, "two-cycle A candidates length 2");
    assertEqual(resA.candidates.map((c) => c.depth), [0, 1], "two-cycle depths 0,1");
    const resB = resolveTaskSpace({ spaces: twoSpaces, homeSpaceId: "B" });
    assertEqual(resB.candidates.map((c) => c.spaceId), ["B", "A"], "two-cycle B candidates [B,A]");

    // three-cycle A->B->C->A
    const threeSpaces: SpaceDto[] = [
      { id: "A", name: "A", parentId: "C", sortOrder: 1000, createdAt: 1 },
      { id: "B", name: "B", parentId: "A", sortOrder: 1000, createdAt: 2 },
      { id: "C", name: "C", parentId: "B", sortOrder: 1000, createdAt: 3 },
    ];
    assertEqual(getSpaceAncestorsDeterministic("A", threeSpaces), ["C", "B"], "three-cycle A ancestors [C,B]");
    assertEqual(getSpaceAncestorsDeterministic("B", threeSpaces), ["A", "C"], "three-cycle B ancestors [A,C]");
    assertEqual(getSpaceAncestorsDeterministic("C", threeSpaces), ["B", "A"], "three-cycle C ancestors [B,A]");

    // missing parent break
    const missingSpaces: SpaceDto[] = [
      { id: "x", name: "X", parentId: "missing", sortOrder: 1000, createdAt: 1 },
      { id: "y", name: "Y", parentId: "x", sortOrder: 1000, createdAt: 2 },
    ];
    assertEqual(getSpaceAncestorsDeterministic("x", missingSpaces), [], "missing parent x->missing => []");
    assertEqual(getSpaceAncestorsDeterministic("y", missingSpaces), ["x"], "y->x->missing => [x] stops at missing");
    const resMissing = resolveTaskSpace({ spaces: missingSpaces, homeSpaceId: "y" });
    assertEqual(resMissing.candidates.map((c) => c.spaceId), ["y", "x"], "missing parent candidates y->x only");
    assert(resMissing.candidates.length === 2, "missing parent candidates length 2, no infinite");

    // candidatesFromPrimary must not produce duplicate primary — verified above and also via explicit path
    const dupCheckSpaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
    ];
    const dupRes = resolveTaskSpace({ spaces: dupCheckSpaces, taskSpaceId: "a" });
    const dupIds = dupRes.candidates.map((c) => c.spaceId);
    assert(dupRes.candidates.length === new Set(dupIds.map(String)).size, "candidates no duplicate spaceId");
    assert(dupIds[0] === "a" && dupIds[1] === "root", "candidates primary + ancestor deterministic");
    // explicit self-loop via taskSpaceId
    const selfExplicitRes = resolveTaskSpace({ spaces: selfSpaces, taskSpaceId: "a" });
    assertEqual(selfExplicitRes.candidates.map((c) => c.spaceId), ["a"], "explicit self-loop no duplicate");

    // getInheritedContextSpaces cycle safety
    assertEqual(getInheritedContextSpaces("A", twoSpaces), ["A", "B"], "inherited two-cycle A->[A,B] not [A,B,A]");
    assertEqual(getInheritedContextSpaces("B", twoSpaces), ["B", "A"], "inherited two-cycle B->[B,A]");
    assertEqual(getInheritedContextSpaces("x", missingSpaces), ["x"], "inherited missing parent x->[x]");
  }

  console.log("== 15) active context gate: draft/home only for new task or activeTaskId ===");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 },
    ];
    const tasks: TaskDto[] = [
      { id: "t1", title: "t1", spaceId: null, updatedAt: 1 }, // standalone
      { id: "t2", title: "t2", spaceId: "a", updatedAt: 2 },
    ];

    // Helper direct tests
    assert(canUseImplicitContext(undefined, null) === true, "canUseImplicitContext undefined => true (new task)");
    assert(canUseImplicitContext(undefined, "x") === true, "new task with activeTaskId still true");
    assert(canUseImplicitContext("t1", null) === false, "concrete taskId with null active => false");
    assert(canUseImplicitContext("t1", undefined) === false, "concrete taskId with undefined active => false");
    assert(canUseImplicitContext("t1", "other") === false, "mismatch active => false");
    assert(canUseImplicitContext("t1", "t1") === true, "matching active => true");

    // non-active task + home/draft => none
    const resNonActiveHome = resolveTaskSpace({ spaces, taskId: "t1", homeSpaceId: "b" });
    assert(resNonActiveHome.reason === "none" && resNonActiveHome.resolvedSpaceId === null, "non-active task (no activeTaskId) + home => none");
    assert(resNonActiveHome.candidates.length === 0, "non-active home candidates empty");

    const resNonActiveDraft = resolveTaskSpace({ spaces, taskId: "t1", draftSpaceId: "a", homeSpaceId: "b" });
    assert(resNonActiveDraft.reason === "none", "non-active task + draft => none (not leaked)");

    const resMismatch = resolveTaskSpace({ spaces, taskId: "t1", homeSpaceId: "b", draftSpaceId: "a", activeTaskId: "other" });
    assert(resMismatch.reason === "none", "activeTaskId mismatch => none");

    const resNullActive = resolveTaskSpace({ spaces, taskId: "t1", homeSpaceId: "b", activeTaskId: null });
    assert(resNullActive.reason === "none", "activeTaskId null => none for concrete task");

    // active task => draft>home
    const resActiveDraftWins = resolveTaskSpace({ spaces, taskId: "t1", activeTaskId: "t1", draftSpaceId: "a", homeSpaceId: "b" });
    assert(resActiveDraftWins.resolvedSpaceId === "a" && resActiveDraftWins.reason === "draft", "active task draft wins over home");

    const resActiveHomeOnly = resolveTaskSpace({ spaces, taskId: "t1", activeTaskId: "t1", homeSpaceId: "b" });
    assert(resActiveHomeOnly.resolvedSpaceId === "b" && resActiveHomeOnly.reason === "active-home", "active task home allowed");

    const resActiveFallback = resolveTaskSpace({
      spaces: [{ id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 }, { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2, archived: true }, { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 }],
      taskId: "t1",
      activeTaskId: "t1",
      draftSpaceId: "a",
      homeSpaceId: "b",
    });
    assert(resActiveFallback.resolvedSpaceId === "b" && resActiveFallback.reason === "active-home", "active task draft archived => fallback to home");

    // explicit taskSpaceId / taskId lookup still priority even when gate blocks
    const resExplicitBypass = resolveTaskSpace({ spaces, tasks, taskId: "t2", homeSpaceId: "b", activeTaskId: "other" });
    assert(resExplicitBypass.resolvedSpaceId === "a" && resExplicitBypass.reason === "explicit", "explicit lookup bypasses gate (t2=>a even though home blocked)");

    const resExplicitNullBypass = resolveTaskSpace({ spaces, taskSpaceId: null, taskId: "t1", homeSpaceId: "b", activeTaskId: "other" });
    assert(resExplicitNullBypass.resolvedSpaceId === null && resExplicitNullBypass.reason === "explicit", "explicit null bypasses gate");

    const resExplicitViaTaskSpaceId = resolveTaskSpace({ spaces, taskSpaceId: "a", taskId: "t1", homeSpaceId: "b", activeTaskId: null });
    assert(resExplicitViaTaskSpaceId.resolvedSpaceId === "a" && resExplicitViaTaskSpaceId.reason === "explicit", "explicit taskSpaceId bypasses gate");

    // new task (no taskId) can use draft/home
    const resNewDraft = resolveTaskSpace({ spaces, draftSpaceId: "a", homeSpaceId: "b" });
    assert(resNewDraft.resolvedSpaceId === "a" && resNewDraft.reason === "draft", "new task (no taskId) draft usable");

    const resNewHome = resolveTaskSpace({ spaces, homeSpaceId: "b" });
    assert(resNewHome.resolvedSpaceId === "b" && resNewHome.reason === "active-home", "new task (no taskId) home usable");

    const resNewWithActive = resolveTaskSpace({ spaces, draftSpaceId: "a", activeTaskId: "something" });
    assert(resNewWithActive.resolvedSpaceId === "a", "new task with activeTaskId still allows draft");

    // explicit invalid falls back but gate still blocks draft/home
    const resExplicitInvalidBlocked = resolveTaskSpace({ spaces, taskSpaceId: "missing", taskId: "t1", homeSpaceId: "b", activeTaskId: "other" });
    assert(resExplicitInvalidBlocked.reason === "none", "explicit invalid + non-active => home blocked => none");

    const resExplicitInvalidAllowed = resolveTaskSpace({ spaces, taskSpaceId: "missing", taskId: "t1", homeSpaceId: "b", activeTaskId: "t1" });
    assert(resExplicitInvalidAllowed.resolvedSpaceId === "b" && resExplicitInvalidAllowed.reason === "active-home", "explicit invalid + active => home allowed");
  }

  console.log("== 16) toAttachRequest strict currentSpaceId contract & same-position no-op ==");
  {
    const spaces: SpaceDto[] = [
      { id: "root", name: "Root", parentId: null, sortOrder: 1000, createdAt: 1 },
      { id: "a", name: "A", parentId: "root", sortOrder: 1000, createdAt: 2 },
      { id: "b", name: "B", parentId: "root", sortOrder: 2000, createdAt: 3 },
    ];

    // same-position no-op: explicit a, current a => null
    const resA = resolveTaskSpace({ spaces, taskSpaceId: "a" });
    assert(toAttachRequest(resA, "t1", "a") === null, "toAttachRequest same position explicit a vs a => null");

    // same-position null standalone no-op
    const resNull = resolveTaskSpace({ spaces, taskSpaceId: null });
    assert(resNull.resolvedSpaceId === null && resNull.reason === "explicit", "explicit null setup");
    assert(toAttachRequest(resNull, "t1", null) === null, "same null standalone => null (no-op)");
    // moving standalone null to explicit null? same => no-op, moving from a to null should be request
    const attachToNull = toAttachRequest(resNull, "t1", "a");
    assert(attachToNull !== null && attachToNull.targetSpaceId === null, "a -> null standalone is not no-op, returns request");

    // different current => request
    const resB = resolveTaskSpace({ spaces, homeSpaceId: "b" });
    assert(toAttachRequest(resB, "t1", "a") !== null, "different current a vs target b => request");
    assertEqual(toAttachRequest(resB, "t1", "a"), { taskId: "t1", targetSpaceId: "b" }, "attach request shape correct");
    assert(toAttachRequest(resB, "t1", null) !== null, "null -> b is request");

    // reason/confidence none still null regardless of currentSpaceId
    const resNone = resolveTaskSpace({ spaces });
    assert(resNone.reason === "none" && resNone.confidence === "none", "none setup");
    assert(toAttachRequest(resNone, "t1", null) === null, "none with current null => null");
    assert(toAttachRequest(resNone, "t1", "a") === null, "none with current a => null");
    assert(toAttachRequest(resNone, "t1", "b") === null, "none with current b => null");

    // confidence none but reason also none — both gate
    const fakeNone: any = { resolvedSpaceId: "a", reason: "none", confidence: "none" };
    assert(toAttachRequest(fakeNone, "t1", null) === null, "fake none reason => null even if target differs");
    const fakeConfNone: any = { resolvedSpaceId: "a", reason: "explicit", confidence: "none" };
    assert(toAttachRequest(fakeConfNone, "t1", null) === null, "confidence none => null");

    // explicit null vs different target already tested; also test home resolved vs same
    const resHomeA = resolveTaskSpace({ spaces, homeSpaceId: "a" });
    assert(toAttachRequest(resHomeA, "tX", "a") === null, "home a same position => null");
    assert(toAttachRequest(resHomeA, "tX", "b") !== null && toAttachRequest(resHomeA, "tX", "b")!.targetSpaceId === "a", "home a vs b => request to a");

    // draft vs same
    const resDraft = resolveTaskSpace({ spaces, draftSpaceId: "a", homeSpaceId: "b" });
    assert(toAttachRequest(resDraft, "t1", "a") === null, "draft a same => null");
    assert(toAttachRequest(resDraft, "t1", "b") !== null, "draft a vs b => request");
  }

  console.log(`\n结果: passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
