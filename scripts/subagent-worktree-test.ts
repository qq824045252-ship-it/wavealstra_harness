import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  prepareSubagentWorkspace,
  SubagentWorkspaceProvisionError,
} from "../src/main/capabilities/subagent/worktree.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

async function main(): Promise<void> {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "subagent worktree test ")));
  const repository = path.join(temporary, "source repo");
  const baseDir = path.join(temporary, "retained worktrees");
  const cwd = path.join(repository, "nested directory");
  try {
    await mkdir(cwd, { recursive: true });
    git(repository, "init");
    git(repository, "config", "user.email", "subagent-test@example.invalid");
    git(repository, "config", "user.name", "Subagent test");
    git(repository, "config", "commit.gpgsign", "false");
    git(repository, "config", "core.autocrlf", "false");
    await writeFile(path.join(cwd, "shared.txt"), "original\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "fixture");
    const head = git(repository, "rev-parse", "HEAD");
    const branch = git(repository, "symbolic-ref", "HEAD");
    const options = { cwd, baseDir, parallel: true, writable: true };

    const [first, second] = await Promise.all([
      prepareSubagentWorkspace(options),
      prepareSubagentWorkspace(options),
    ]);
    assert.equal(first.kind, "worktree");
    assert.equal(second.kind, "worktree");
    if (first.kind !== "worktree" || second.kind !== "worktree") throw new Error("Expected worktrees");
    assert.notEqual(first.root, second.root);
    assert.notEqual(first.branch, second.branch);
    for (const workspace of [first, second]) {
      assert.equal(workspace.repository, await realpath(repository));
      assert.equal(workspace.baseCommit, head);
      assert.equal(workspace.root, await realpath(workspace.root));
      assert.equal(workspace.cwd, path.join(workspace.root, "nested directory"));
      assert.equal(git(workspace.cwd, "rev-parse", "HEAD"), head);
      assert.equal(git(workspace.cwd, "branch", "--show-current"), workspace.branch);
      const receipt = JSON.parse(await readFile(workspace.receiptPath, "utf8"));
      assert.equal(receipt.state, "ready");
      assert.equal(receipt.cwd, workspace.cwd);
      assert.equal(receipt.root, workspace.root);
      assert.equal(receipt.baseCommit, head);
    }
    await Promise.all([
      writeFile(path.join(first.cwd, "shared.txt"), "first worker\n"),
      writeFile(path.join(second.cwd, "shared.txt"), "second worker\n"),
    ]);
    assert.equal(await readFile(path.join(first.cwd, "shared.txt"), "utf8"), "first worker\n");
    assert.equal(await readFile(path.join(second.cwd, "shared.txt"), "utf8"), "second worker\n");
    assert.equal(await readFile(path.join(cwd, "shared.txt"), "utf8"), "original\n");
    assert.equal(git(repository, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(git(repository, "rev-parse", "HEAD"), head);
    assert.equal(git(repository, "symbolic-ref", "HEAD"), branch);

    const alias = path.join(temporary, "repository alias");
    await symlink(repository, alias, "junction");
    const aliasCwd = path.join(alias, "nested directory");
    assert.deepEqual(await prepareSubagentWorkspace({ ...options, cwd: aliasCwd, writable: false }), { kind: "shared", cwd });
    const explicit = await prepareSubagentWorkspace({ ...options, cwd: aliasCwd, isolation: "worktree", parallel: false, writable: false });
    assert.equal(explicit.kind, "worktree");
    if (explicit.kind !== "worktree") throw new Error("Expected explicit worktree override");
    assert.equal(explicit.repository, repository);
    assert.equal(explicit.cwd, await realpath(explicit.cwd));
    assert.equal(explicit.baseCommit, head);

    const allocationCount = readdirSync(baseDir).length;
    assert.deepEqual(await prepareSubagentWorkspace({ ...options, writable: false }), { kind: "shared", cwd });
    assert.deepEqual(await prepareSubagentWorkspace({ ...options, parallel: false }), { kind: "shared", cwd });
    assert.deepEqual(await prepareSubagentWorkspace({ ...options, isolation: "shared" }), { kind: "shared", cwd });
    assert.equal(readdirSync(baseDir).length, allocationCount);

    await writeFile(path.join(cwd, "untracked.txt"), "do not lose me");
    await assert.rejects(prepareSubagentWorkspace(options), /clean repository, including untracked files/);
    assert.deepEqual(await prepareSubagentWorkspace({ ...options, isolation: "shared" }), { kind: "shared", cwd });
    assert.equal(readdirSync(baseDir).length, allocationCount);
    assert.equal(await readFile(path.join(cwd, "untracked.txt"), "utf8"), "do not lose me");
    await rm(path.join(cwd, "untracked.txt"));
    await writeFile(path.join(cwd, "shared.txt"), "dirty tracked\n");
    await assert.rejects(prepareSubagentWorkspace({ ...options, isolation: "worktree" }), /clean repository/);
    assert.equal(await readFile(path.join(cwd, "shared.txt"), "utf8"), "dirty tracked\n");
    await writeFile(path.join(cwd, "shared.txt"), "original\n");

    const nonrepo = path.join(temporary, "not a repo");
    await mkdir(nonrepo);
    await assert.rejects(prepareSubagentWorkspace({ ...options, cwd: nonrepo }), /requires a Git working tree/);
    await assert.rejects(prepareSubagentWorkspace({ ...options, cwd: nonrepo, isolation: "worktree", writable: false }), /requires a Git working tree/);
    assert.deepEqual(await prepareSubagentWorkspace({ ...options, cwd: nonrepo, writable: false }), { kind: "shared", cwd: nonrepo });
    assert.equal(readdirSync(baseDir).length, allocationCount);

    const preAborted = new AbortController();
    preAborted.abort(new Error("cancel before allocation"));
    await assert.rejects(prepareSubagentWorkspace({ ...options, signal: preAborted.signal }), /cancel before allocation/);
    assert.equal(readdirSync(baseDir).length, allocationCount);

    const hooks = path.join(temporary, "hooks directory");
    const hookScript = path.join(temporary, "observe intent.cjs");
    const marker = path.join(temporary, "hook started.txt");
    const failHook = path.join(temporary, "fail hook.txt");
    await mkdir(hooks);
    await writeFile(hookScript, `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const receiptPath = path.join(process.cwd(), '..', 'receipt.json');
const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
assert.equal(receipt.state, 'intent');
assert.equal(fs.realpathSync(receipt.root), fs.realpathSync(process.cwd()));
fs.writeFileSync(${JSON.stringify(marker)}, receiptPath);
setTimeout(() => process.exit(fs.existsSync(${JSON.stringify(failHook)}) ? 17 : 0), 300);
`);
    const shellQuote = (value: string): string => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;
    await writeFile(path.join(hooks, "post-checkout"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(hookScript)}\n`, { mode: 0o755 });
    git(repository, "config", "core.hooksPath", hooks.replaceAll("\\", "/"));

    const controller = new AbortController();
    const cancellation = prepareSubagentWorkspace({ ...options, signal: controller.signal });
    const cancellationCheck = assert.rejects(cancellation, (error: unknown) => {
      assert.ok(error instanceof SubagentWorkspaceProvisionError);
      assert.ok(existsSync(error.root));
      const receipt = JSON.parse(readFileSync(error.receiptPath, "utf8"));
      assert.equal(receipt.state, "cancelled");
      assert.match(receipt.error, /cancel during provisioning/);
      assert.equal(readFileSync(path.join(error.root, "nested directory", "shared.txt"), "utf8"), "original\n");
      assert.ok(error.message.includes(error.root));
      assert.ok(error.message.includes(error.receiptPath));
      return true;
    });
    for (let attempt = 0; !existsSync(marker) && attempt < 1000; attempt += 1) await delay(5);
    assert.ok(existsSync(marker), "Git post-checkout hook must observe the durable intent");
    controller.abort(new Error("cancel during provisioning"));
    await cancellationCheck;
    await delay(350);

    writeFileSync(failHook, "fail");
    await assert.rejects(prepareSubagentWorkspace(options), (error: unknown) => {
      assert.ok(error instanceof SubagentWorkspaceProvisionError);
      const receipt = JSON.parse(readFileSync(error.receiptPath, "utf8"));
      assert.equal(receipt.state, "failed");
      assert.match(receipt.error, /git worktree failed/);
      assert.ok(existsSync(error.root));
      return true;
    });
    assert.equal(git(repository, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.equal(git(repository, "rev-parse", "HEAD"), head);
    assert.equal(git(repository, "symbolic-ref", "HEAD"), branch);
    console.log("PASS subagent worktree isolation, receipts, failures and cancellation in real temporary repositories");
  } finally {
    assert.ok(path.dirname(temporary) === await realpath(tmpdir()) && path.basename(temporary).startsWith("subagent worktree test "));
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

await main();
