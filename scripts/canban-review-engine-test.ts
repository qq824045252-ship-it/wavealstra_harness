import assert from "node:assert/strict";
import { snapshotGitDiff } from "../src/main/agent/CodeReviewSnapshotDiff";
import { getCanbanReviewRuntime } from "../vendor/canban-review/runtime";

const review = getCanbanReviewRuntime();
const canbanFixture = [
  "@@ -10,3 +10,4 @@ fn top_fn() {",
  " ctx1", "+added", " ctx2", " ctx3",
  "@@ -50,2 +51,2 @@ fn second_fn() {",
  "-old", "+new", " tail",
].join("\n");
const { hunks } = review.parse(canbanFixture);
assert.deepEqual(hunks.map((hunk) => [hunk.entryOld, hunk.entryNew, hunk.exitOld, hunk.exitNew]), [
  [10, 10, 13, 14],
  [50, 51, 52, 53],
]);
assert.equal(review.formatHunkHeader(hunks[1], 20), "@@ -30,22 +31,22 @@ fn second_fn() {");
assert.equal(review.contextStep, 20);

const fromTop = review.expandGap("between", 37, { fromTop: 0, fromBottom: 0 }, "down");
assert.deepEqual(fromTop, { fromTop: 20, fromBottom: 0 });
assert.deepEqual(review.expandGap("between", 37, fromTop, "up"), { fromTop: 20, fromBottom: 17 });
assert.deepEqual(review.expandGap("leading", 2, { fromTop: 0, fromBottom: 0 }, "all"), { fromTop: 0, fromBottom: 2 });
assert.deepEqual(review.expandGap("trailing", 21, { fromTop: 0, fromBottom: 0 }, "down"), { fromTop: 20, fromBottom: 0 });

const insertion = review.parse("@@ -10,0 +11,2 @@\n+a\n+b").hunks[0];
assert.deepEqual([insertion.entryOld, insertion.entryNew, insertion.exitOld, insertion.exitNew], [11, 11, 11, 13]);
assert.equal(review.parse(canbanFixture, "web/Dist/app.MIN.JS").autoFoldReason, "generated");
assert.equal(review.parse("@@ -0,0 +1,5000 @@\n" + "+x\n".repeat(5000)).autoFoldReason, 5001);
assert.equal(review.parse("Binary files before and after differ").hunks.length, 0);

const patch = await snapshotGitDiff("prefix\r\n-- 旧\nlast", "prefix\r\n++ 新\nlast", "patch");
assert(patch, "Git generated a unified patch from private task snapshots");
const changed = review.parse(patch).hunks[0];
assert.deepEqual(changed.lines, [
  { kind: " ", oldLine: 1, newLine: 1, text: "prefix" },
  { kind: "-", oldLine: 2, newLine: null, text: "-- 旧" },
  { kind: "+", oldLine: null, newLine: 2, text: "++ 新" },
  { kind: " ", oldLine: 3, newLine: 3, text: "last" },
  { kind: "\\", oldLine: null, newLine: null, text: "\\ No newline at end of file" },
]);
assert.equal(changed.endsWithNoNewline, true);
const files = review.gitPatchFiles(patch);
assert.deepEqual(files.map((file) => [file.additions, file.deletions]), [[1, 1]]);
assert.deepEqual(review.parse(files[0].patch).hunks[0].lines, changed.lines);

const gitStatus = review.gitStatus("MM src/x.ts\0R  src/new.ts\0src/old.ts\0?? 文件.txt\0UU conflict\0!! ignored\0");
assert.deepEqual(gitStatus.map((row) => [
  row.path, row.orig_path, row.staged, row.unstaged, row.untracked, row.conflicted,
]), [
  ["src/x.ts", null, true, true, false, false],
  ["src/new.ts", "src/old.ts", true, false, false, false],
  ["文件.txt", null, false, false, true, false],
  ["conflict", null, true, true, false, true],
]);
assert.deepEqual(review.gitCompareCommand("STAGED"), ["diff", "--cached", "--no-ext-diff", "--no-textconv", "-M", "--"]);

const markdown = review.formatPendingMarkdown("task", "  Fix ", [{
  path: "src/main.ts",
  section: "staged",
  line: 7,
  side: "LEFT",
  snippet: " old() ",
  body: "Revisit this\nwith coverage.",
}]);
assert.equal(markdown, [
  "### Code Review (task)", "", "Fix", "", "#### Inline Comments", "",
  "1. **`src/main.ts:7`** (old) (staged)", "   > `old()`",
  "   Revisit this", "   with coverage.", "",
].join("\n"));
console.log("Canban WASM diff, Git review, context expansion and comment formatting passed");
