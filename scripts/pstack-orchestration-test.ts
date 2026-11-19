import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { auditPstackWorktrees } from "../src/main/agent/pstack/PstackWorktreeAudit";
import { auditSchedule, inspectPrBody, ownerReports } from "../src/main/agent/pstack/PstackDelivery";

const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "mybuddy-worktree-audit-"));
try {
  const main = join(dir, "primary"), other = join(dir, "path with spaces");
  await mkdir(main);
  const git = (...args: string[]) => exec("git", ["-C", main, ...args], { windowsHide: true });
  await git("init", "-q", "-b", "main");
  await writeFile(join(main, "note.txt"), "committed\n");
  await git("add", ".");
  await git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "baseline");
  await git("worktree", "add", "-qb", "feature", other);
  const first = await auditPstackWorktrees(main, { baseRef: "main", sizes: true });
  assert.equal(first.worktrees.length, 2);
  const feature = first.worktrees.find(w => w.branch === "feature")!;
  assert.equal(resolve(feature.path), await realpath(other));
  assert.equal(feature.reachableFromBase, true);
  assert.equal(feature.bytes, (await stat(join(other, "note.txt"))).size);
  assert.equal(feature.reason, "merged-locally");
  const held = await auditPstackWorktrees(main, { root: other, sizes: false, tasks: [
    { id: "pinned", cwd: other, updatedAt: 1, pinned: true, active: false },
    { id: "running", cwd: join(other, "src"), updatedAt: 2, pinned: false, active: true },
    { id: "sibling", cwd: other + "-fork", updatedAt: Date.now(), pinned: true, active: true },
  ] });
  assert.equal(held.worktrees[0].reason, "pinned-or-active-task");
  assert.deepEqual(held.worktrees[0].protectedTasks, [{ id: "pinned", pinned: true, active: false }, { id: "running", pinned: false, active: true }]);
  assert.equal(held.worktrees[0].lastTaskActivity, 2);
  const local = await auditPstackWorktrees(main, { sizes: false });
  assert.equal(local.ref, "main");
  assert.ok(local.volume.available > 0);
  await writeFile(join(main, ".git", "info", "exclude"), "scratch.tmp\n");
  await writeFile(join(other, "scratch.tmp"), "untracked user work\n");
  const ignored = await auditPstackWorktrees(main, { root: other, sizes: false });
  assert.deepEqual(ignored.worktrees.map(w => [w.ignored, w.tracked, w.untracked, w.reason]), [[1, 0, 0, "ignored-files"]]);
  await writeFile(join(other, "note.txt"), "in progress\n");
  await writeFile(join(other, "private scratch.txt"), "pending\n");
  const changed = await auditPstackWorktrees(main, { baseRef: "absent", root: other });
  assert.deepEqual(changed.worktrees.map(w => [w.branch, w.tracked, w.untracked, w.reason, w.reachableFromBase]), [["feature", 1, 1, "uncommitted", null]]);
  assert.equal(changed.github, "not requested");
  await writeFile(join(main, "pr.md"), "Why\r\n\r\nVerification passed\r\n");
  const body = await inspectPrBody(main, undefined, 3);
  assert.equal(body.lines, 3);
  await assert.rejects(inspectPrBody(main, undefined, 2), /has 3 lines/);
  await writeFile(join(main, "pr.md"), "Why\nVerification passed");
  assert.notEqual((await inspectPrBody(main, "pr.md", 2)).digest, body.digest);
  await assert.rejects(inspectPrBody(main, "../path with spaces/note.txt", 40), /workspace/);
  const reports = { results: [{ subagentId: "A", messages: [{ role: "user", timestamp: 100 },
    { role: "toolResult", timestamp: 200, toolName: "write", isError: true },
    { role: "toolResult", timestamp: 65_100, toolName: "edit", isError: false }] }, { subagentId: "B", messages: [] },
    { subagentId: "C", messages: [{ role: "assistant", timestamp: 500, stopReason: "stop", content: [{ type: "text", text: "C completed first" }] }] }] };
  assert.deepEqual(ownerReports(reports, 50, 70_000, 1).map(r => [r.owner, r.firstReportDue, r.firstReport, r.late, r.kind]),
    [["A", 60_100, 65_100, true, "edit"], ["B", 60_050, 70_000, true, "returned-report"], ["C", 60_050, 500, false, "returned-report"]]);
  assert.ok(ownerReports(reports, 50, 70_000, 2).every(r => !r.late));
  assert.equal(auditSchedule({ playbook: "autopilot-stack", run: 42 }, 7).schedule_expr, "7m");
  console.log("PASS real Git worktree audit: paths with spaces, measured size, missing base, local status, scoped roots, no network or cleanup");
} finally { await rm(dir, { recursive: true, force: true }); }
