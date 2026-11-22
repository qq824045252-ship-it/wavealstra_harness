import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodeReviewGitList } from "../src/shared/code-review";
import { GitCodeReview } from "../src/main/agent/GitCodeReview";

const temp = mkdtempSync(join(tmpdir(), "mybuddy-git-review-"));
const cwd = join(temp, "repository");
mkdirSync(cwd);
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (path: string, content: string | Buffer) => writeFileSync(join(cwd, path), content);
const stage = (...paths: string[]) => git("add", "--", ...paths);
const find = (list: CodeReviewGitList, path: string, section?: string) => {
  const result = list.files.find(file => file.path === path && (!section || file.section === section));
  assert(result, `${path} missing from ${section ?? "comparison"}`);
  return result;
};

try {
  assert.equal(await GitCodeReview.open(cwd), null);
  git("init", "-b", "main");
  git("config", "user.name", "Review Fixture");
  git("config", "user.email", "review@example.invalid");
  git("config", "core.autocrlf", "false");
  git("config", "commit.gpgsign", "false");
  const repo = await GitCodeReview.open(cwd);
  assert(repo);
  write("initial.txt", "root\n");
  stage("initial.txt");
  const initial = find(await repo.list(), "initial.txt", "staged");
  assert.equal((await repo.detail(initial))?.after, "root\n");
  assert.match((await repo.detail(initial))?.patch ?? "", /\+root/);
  assert.equal((await repo.refs()).head, null);

  mkdirSync(join(cwd, "nested"));
  write("nested/reverted.txt", "-- original\n");
  write("nested/rename me.txt", "rename contents\n");
  stage("nested");
  git("commit", "-m", "Initial commit");
  const initialSha = git("rev-parse", "HEAD");
  const root = await repo.list({ mode: "compare", base: `${initialSha}^`, compare: initialSha });
  assert.equal(find(root, "initial.txt").kind, "added");
  assert.equal(root.commits[0]?.sha, initialSha);

  git("switch", "-c", "review");
  write("nested/committed.txt", "commit-only change\n");
  stage("nested/committed.txt");
  git("commit", "-m", "Review commit");
  const reviewSha = git("rev-parse", "HEAD");
  git("switch", "main");
  write("main-only.txt", "other branch\n");
  stage("main-only.txt");
  git("commit", "-m", "Separate main commit");
  git("switch", "review");

  write("nested/reverted.txt", "++ staged\n");
  stage("nested/reverted.txt");
  write("nested/reverted.txt", "-- original\n");
  git("mv", "--", "nested/rename me.txt", "nested/改名 文件.txt");
  write("nested/未跟踪 文件.txt", "user edit\n");
  write("nested/二进制.bin", Buffer.from([0, 2, 4]));
  write("outside.txt", "outside nested review\n");
  const refs = await repo.refs();
  assert.equal(refs.branch, "review");
  assert.equal(refs.head, reviewSha);
  assert.equal(refs.defaultBase, "main");
  assert(refs.refs.includes("review"));
  const before = git("status", "--porcelain=v1", "-z");
  const list = await repo.list();
  const staged = find(list, "nested/reverted.txt", "staged");
  const unstaged = find(list, "nested/reverted.txt", "unstaged");
  assert.notEqual(staged.id, unstaged.id);
  assert.deepEqual([staged.additions, staged.deletions, unstaged.additions, unstaged.deletions], [1, 1, 1, 1]);
  const stagedDetail = await repo.detail(staged);
  const unstagedDetail = await repo.detail(unstaged);
  assert.deepEqual([stagedDetail?.before, stagedDetail?.after, unstagedDetail?.before, unstagedDetail?.after],
    ["-- original\n", "++ staged\n", "++ staged\n", "-- original\n"]);
  assert.match(stagedDetail?.patch ?? "", /--- original\n\+\+\+ staged/);
  assert.match(unstagedDetail?.patch ?? "", /-\+\+ staged\n\+-- original/);
  assert.equal(staged.canReject, false);

  const renamed = find(list, "nested/改名 文件.txt", "staged");
  assert.equal(renamed.kind, "renamed");
  assert.equal(renamed.oldPath, "nested/rename me.txt");
  assert.equal((await repo.detail(renamed))?.before, "rename contents\n");
  const untracked = find(list, "nested/未跟踪 文件.txt", "unstaged");
  assert.equal(untracked.untracked, true);
  assert.match((await repo.detail(untracked))?.patch ?? "", /\+user edit/);
  assert.equal((await repo.detail(find(list, "nested/二进制.bin")))?.patch, undefined);

  const nested = await GitCodeReview.open(join(cwd, "nested"));
  assert(nested);
  const restricted = await nested.list();
  assert(!restricted.files.some(file => file.path.includes("outside.txt")));
  assert.match((await nested.detail(find(restricted, "未跟踪 文件.txt")))?.patch ?? "", /\+user edit/);

  const three = await repo.list({ mode: "compare", base: "main", compare: "HEAD" });
  assert.equal(three.baseSha, initialSha);
  assert.deepEqual(three.files.map(file => file.path), ["nested/committed.txt"]);
  assert.equal(three.commits[0]?.subject, "Review commit");
  assert.match((await repo.detail(three.files[0]))?.patch ?? "", /\+commit-only change/);
  const two = await repo.list({ mode: "compare", base: "main", compare: "HEAD", threeDot: false });
  assert.equal(find(two, "main-only.txt").kind, "deleted");
  const tree = await repo.list({ mode: "compare", base: "main", compare: "WORKDIR" });
  assert.equal(find(tree, "nested/未跟踪 文件.txt").untracked, true);
  assert.equal(git("status", "--porcelain=v1", "-z"), before);
  write("nested/reverted.txt", "++ newer!\n");
  const changedWorking = find(await repo.list(), "nested/reverted.txt", "unstaged");
  assert.deepEqual([changedWorking.additions, changedWorking.deletions], [unstaged.additions, unstaged.deletions]);
  assert.notEqual(changedWorking.id, unstaged.id);
  assert.equal(await repo.detail(unstaged), null);
  stage("nested/reverted.txt");
  const changedIndex = find(await repo.list(), "nested/reverted.txt", "staged");
  assert.notEqual(changedIndex.id, staged.id);
  assert.equal(await repo.detail(staged), null);
  await assert.rejects(repo.list({ mode: "compare", base: "--help", compare: "HEAD" }), /无效/);
  assert.equal(await nested.detail({ ...untracked, path: "../outside.txt" }), null);
  console.log("PASS git-code-review (Canban status/comparison/splitter backed by Git)");
} finally {
  rmSync(temp, { recursive: true, force: true });
}
