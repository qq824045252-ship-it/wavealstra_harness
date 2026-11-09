import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileResource, resourceOwnerKey, WorkResourceGate, type ResourceAdmission, type WorkResourceOwner } from "../src/main/agent/work/WorkResourceGate";
import { WorkToolResourcePolicy, type ToolResourceCall } from "../src/main/agent/work/WorkToolResourcePolicy";
import { workShellRead } from "../src/main/agent/work/WorkShellRead";
import { classifyMcpToolCall } from "../src/main/security/McpSideEffectPolicy";
import { directoryContentVersion } from "../src/main/platform/resource-identity";
import { directorySymlinkType } from "../src/main/platform/paths";
import { prepareSubagentWorkspace, repositoryAllowsGitIsolation } from "../src/main/capabilities/subagent/worktree";

const directory = mkdtempSync(join(tmpdir(), "work-phase3-resources-"));
const path = join(directory, "resources.db");
const a = new Database(path), b = new Database(path);
let clock = Date.now();
const options = { hostId: "same-host", now: () => clock };
const gateA = new WorkResourceGate(a, options), gateB = new WorkResourceGate(b, options);
const owner = (id: string): WorkResourceOwner => ({ taskId: id, durableStoreKey: `store:${id}`, conversationId: "1", workspaceBinding: directory, workId: `work:${id}`, bindingId: `binding:${id}` });
const granted = (result: ResourceAdmission) => { assert(result.ok, result.ok ? "" : result.reason); return result.lease; };
const file = join(directory, "proof.txt"), other = join(directory, "other.txt");
writeFileSync(file, "original"); writeFileSync(other, "other");
const context = (id: string) => ({ taskId: id, conversationId: "1", nativeTaskId: `native:${id}`, taskRoot: directory });
const call = (id: string, toolId: string, name: string, args: ToolResourceCall["call"]["arguments"], sideEffect: boolean, paths: string[] = []): ToolResourceCall => ({
  call: { type: "toolCall", id: toolId, name, arguments: args }, context: context(id), sideEffect, paths,
});
try {
  const original = fileResource(file, "write");
  const one = granted(gateA.acquire({ actionId: "one", owner: owner("one"), resources: [original] }));
  assert.equal(gateB.acquire({ actionId: "two", owner: owner("two"), resources: [fileResource(file, "write")] }).ok, false);
  const independent = granted(gateB.acquire({ actionId: "independent", owner: owner("two"), resources: [fileResource(other, "write")] }));
  assert.equal(gateA.live().length, 2, "unrelated mutable resources admitted simultaneously across independent connections");
  // Neither action can write until both have reached the barrier with their own live lease.
  await Promise.all([Promise.resolve().then(() => { assert.equal(gateA.validate(one), undefined); writeFileSync(file, "one"); }),
    Promise.resolve().then(() => { assert.equal(gateB.validate(independent), undefined); writeFileSync(other, "independent"); })]);
  assert.equal(readFileSync(file, "utf8"), "one"); assert.equal(readFileSync(other, "utf8"), "independent");
  gateA.release(one, "confirmed"); gateB.release(independent, "confirmed");

  // Both resources are granted atomically; the reversed contender never owns a half-set.
  const group = granted(gateA.acquire({ actionId: "group", owner: owner("one"), resources: [fileResource(file, "write"), fileResource(other, "write")] }));
  assert.equal(gateB.acquire({ actionId: "reverse", owner: owner("two"), resources: [fileResource(other, "write"), fileResource(file, "write")] }).ok, false);
  assert.equal(gateA.live().length, 1); gateA.release(group, "confirmed");
  const reversed = granted(gateB.acquire({ actionId: "reverse", owner: owner("two"), resources: [fileResource(other, "write"), fileResource(file, "write")] }));
  gateB.release(reversed, "confirmed");

  const hardlink = join(directory, "hardlink.txt"); linkSync(file, hardlink);
  const alias = granted(gateA.acquire({ actionId: "hard-a", owner: owner("one"), resources: [fileResource(file, "write")] }));
  assert.equal(gateB.acquire({ actionId: "hard-b", owner: owner("two"), resources: [fileResource(hardlink, "write")] }).ok, false);
  gateA.release(alias, "confirmed");
  const parent = join(directory, "tree"), similar = join(directory, "tree-other"); mkdirSync(parent); mkdirSync(similar);
  const link = join(directory, "alias"); symlinkSync(parent, link, directorySymlinkType());
  const subtree = granted(gateA.acquire({ actionId: "subtree", owner: owner("one"), resources: [fileResource(parent, "write", true)] }));
  assert.equal(gateB.acquire({ actionId: "newchild", owner: owner("two"), resources: [fileResource(join(link, "new.txt"), "write")] }).ok, false);
  const disjoint = granted(gateB.acquire({ actionId: "similar", owner: owner("two"), resources: [fileResource(join(similar, "new.txt"), "write")] }));
  gateA.release(subtree, "confirmed"); gateB.release(disjoint, "confirmed");
  const newTarget = granted(gateA.acquire({ actionId: "newtarget", owner: owner("one"), resources: [fileResource(join(link, "new.txt"), "write")] }));
  rmSync(link); symlinkSync(similar, link, directorySymlinkType());
  assert.match(gateA.validateVersions(newTarget) ?? "", /version_conflict/); gateA.release(newTarget, "not_started");

  const policyA = new WorkToolResourcePolicy(gateA, input => owner(input.taskId));
  const policyB = new WorkToolResourcePolicy(gateB, input => owner(input.taskId));
  const readA = call("read-a", "read", "read", { path: file }, false);
  const readB = call("read-b", "read", "read", { path: hardlink }, false);
  assert.equal(policyA.before(readA), undefined); policyA.after(readA, "consumed");
  assert.equal(policyB.before(readB), undefined); policyB.after(readB, "consumed");
  const writeA = call("read-a", "write", "write", { path: file, content: "accepted A" }, true);
  assert.equal(policyA.before(writeA), undefined); writeFileSync(file, "accepted A"); policyA.after(writeA, "consumed");
  const staleB = call("read-b", "write", "write", { path: file, content: "stale B" }, true);
  assert.match(policyB.before(staleB) ?? "", /version_conflict/, "hard-link original reads survive canonical path changes");
  assert.equal(readFileSync(file, "utf8"), "accepted A");
  const midReadPath = join(directory, "mid-read.txt"); writeFileSync(midReadPath, "observed-before-read");
  const midRead = call("mid-read", "read", "read", { path: midReadPath }, false);
  assert.equal(policyA.before(midRead), undefined);
  assert.equal(readFileSync(midReadPath, "utf8"), "observed-before-read");
  writeFileSync(midReadPath, "externally-changed-during-read"); policyA.after(midRead, "consumed");
  assert.match(policyA.before(call("mid-read", "stale-write", "write", { path: midReadPath, content: "stale" }, true)) ?? "", /version_conflict/);
  const reread = call("mid-read", "fresh-read", "read", { path: midReadPath }, false);
  assert.equal(policyA.before(reread), undefined); policyA.after(reread, "consumed");
  const freshWrite = call("mid-read", "fresh-write", "write", { path: midReadPath, content: "fresh" }, true);
  assert.equal(policyA.before(freshWrite), undefined); writeFileSync(midReadPath, "fresh"); policyA.after(freshWrite, "consumed");
  const aliasSource = join(parent, "source.txt"), aliasDestination = join(similar, "source.txt");
  writeFileSync(aliasSource, "source A"); writeFileSync(aliasDestination, "source B");
  rmSync(link); symlinkSync(parent, link, directorySymlinkType());
  const aliasReadPath = join(link, "source.txt"), aliasRead = call("redirected-read", "read", "read", { path: aliasReadPath }, false);
  assert.equal(policyA.before(aliasRead), undefined); assert.equal(readFileSync(aliasReadPath, "utf8"), "source A"); policyA.after(aliasRead, "consumed");
  rmSync(link); symlinkSync(similar, link, directorySymlinkType());
  assert.match(policyA.before(call("redirected-read", "write", "write", { path: aliasReadPath, content: "stale A" }, true)) ?? "", /version_conflict/);
  assert.equal(readFileSync(aliasDestination, "utf8"), "source B");
  const aliasReread = call("redirected-read", "reread", "read", { path: aliasReadPath }, false);
  assert.equal(policyA.before(aliasReread), undefined); policyA.after(aliasReread, "consumed");
  const aliasFresh = call("redirected-read", "fresh-write", "write", { path: aliasReadPath, content: "new B" }, true);
  assert.equal(policyA.before(aliasFresh), undefined); writeFileSync(aliasReadPath, "new B"); policyA.after(aliasFresh, "consumed");

  // Same mtime/size cannot hide external changes from the content digest.
  const pre = fileResource(file, "write"), previousTimes = statSync(file); writeFileSync(file, "external B"); utimesSync(file, previousTimes.atime, previousTimes.mtime);
  const external = granted(gateA.acquire({ actionId: "external", owner: owner("external"), resources: [pre] }));
  assert.match(gateA.validateVersions(external) ?? "", /version_conflict/); gateA.release(external, "not_started");
  const beforeManifest = directoryContentVersion(parent); writeFileSync(join(parent, "untracked.txt"), "dirty");
  assert.notEqual(directoryContentVersion(parent), beforeManifest);

  const waitHolder = granted(gateA.acquire({ actionId: "wait-holder", owner: owner("holder"), resources: [fileResource(other, "write")] }));
  const waitCall = call("waiter", "waiting-write", "write", { path: other, content: "later" }, true);
  const controller = new AbortController();
  const waiting = policyB.beforeWait(waitCall, controller.signal);
  await new Promise<void>(done => setImmediate(done));
  assert(gateA.waiting("work:waiter").length > 0);
  controller.abort(); assert.match(await waiting ?? "", /已取消/);
  assert.deepEqual(gateA.waiting("work:waiter"), []);
  const secondWait = call("waiter", "second-write", "write", { path: other, content: "after release" }, true);
  const admittedAfterRelease = policyB.beforeWait(secondWait);
  await new Promise<void>(done => setImmediate(done));
  gateA.release(waitHolder, "confirmed"); assert.equal(await admittedAfterRelease, undefined);
  policyB.after(secondWait, "released");

  // Unknown Shell/MCP cannot use a model path assertion to evade the host-level boundary.
  const shell = call("shell", "shell", "bash", { command: "some unknown writer", path: other }, true);
  assert.equal(policyA.before(shell), undefined);
  const ordinary = new WorkToolResourcePolicy(gateB, input => ({ ...owner(input.taskId), workId: undefined, bindingId: undefined }));
  const ordinaryWrite = call("ordinary-task", "write", "write", { path: other, content: "bypass" }, true);
  assert.match(ordinary.before(ordinaryWrite) ?? "", /等待共享资源/);
  policyA.after(shell, "consumed");
  assert.match(policyB.before(call("shell", "later-unbounded-write", "bash", { command: "some later writer" }, true)) ?? "", /范围未核实|不受限修改/);
  assert.match(policyB.before(call("shell", "stale-existing", "write", { path: other, content: "from opaque output" }, true)) ?? "", /可信读取/);
  // An explicit path is not enough to classify arbitrary commands or flags as trusted reads.
  for (const [index, command] of ["wc --files0-from=secrets", 'wc --files0-from "./proof.txt"', "ls -R", 'ls -R "./tree"', 'cat -n "./proof.txt"', 'ls -- "./tree"'].entries()) {
    assert.equal(workShellRead("bash", { command }), undefined);
    const unsupportedRead = call("shell", `unsupported-read-${index}`, "bash", { command }, true);
    const reason = policyB.before(unsupportedRead);
    assert(reason);
    assert.match(reason, /范围未核实/);
    assert.match(reason, /内置 read.*明确文件路径/);
    assert.match(reason, /完整内容上统计.*分段读完/);
    assert.match(reason, /ls -l "\.\/dir"/);
    assert.match(reason, /wc -c.*单个明确字面路径/);
    assert.match(reason, /内置 write\/edit.*逐个重新读取.*不会解除任意 Shell 命令限制/);
    assert.equal(policyB.refuse(unsupportedRead, reason), true);
    assert.equal(policyA.wasNotStarted(unsupportedRead), true, "another SQLite connection sees the durable not-started proof");
    assert.deepEqual(a.prepare("SELECT reason FROM work_resource_denials WHERE action_id=?").get(
      `resource:${resourceOwnerKey(owner("shell"))}:${unsupportedRead.context.nativeTaskId}:${unsupportedRead.call.id}`), { reason });
  }
  for (const [index, command] of [`wc -c "${other}"; echo $?`, `stat "${other}"`, `ls -l "${other}"`, `sha256sum "${other}"`].entries()) {
    const verify = call("shell", `verify-${index}`, "bash", { command }, false);
    assert.equal(policyB.before(verify), undefined, "scoped verification remains available after opaque output");
    const verificationLease = gateB.live().find(lease => lease.owner.taskId === "shell"); assert(verificationLease);
    assert(verificationLease.resources.every(resource => resource.kind === "host" && !resource.path && !resource.expectedVersion),
      "verification uses a conservative read lease, not a race-prone pathname content hash");
    assert.match(policyA.before(call("concurrent-writer", `write-during-verify-${index}`, "write", { path: other, content: "race" }, true)) ?? "", /等待共享资源/);
    policyB.after(verify, "consumed");
    assert.match(policyB.before(call("shell", `write-after-verify-${index}`, "write", { path: other, content: "not read" }, true)) ?? "", /可信读取/,
      "metadata/hash/count output cannot authorize overwrite without content reread");
  }
  const externalVerify = call("shell", "external-verify", "bash", { command: `wc -c "${join(directory, "..", "outside.txt")}"` }, false);
  assert.match(policyB.before(externalVerify) ?? "", /工作区|ENOENT/, "scope rejection precedes resource content hashing");
  const directoryRead = call("shell", "trusted-directory-read", "bash", { command: 'ls "./"' }, false);
  assert.deepEqual(workShellRead("bash", directoryRead.call.arguments), { path: "./", directory: true });
  assert.equal(policyB.before(directoryRead), undefined); policyB.after(directoryRead, "consumed");
  assert.match(policyB.before(call("shell", "write-after-list", "write", { path: other, content: "not reread" }, true)) ?? "",
    /内置 read.*重新读取目标版本.*内置 write\/edit.*列目录不能代替/);
  const trustedAfterOpaque = call("shell", "trusted-current-read", "read", { path: other }, false);
  assert.equal(policyB.before(trustedAfterOpaque), undefined); policyB.after(trustedAfterOpaque, "consumed");
  const scopedAfterOpaque = call("shell", "scoped-write", "write", { path: other, content: "fresh after opaque" }, true);
  assert.equal(policyB.before(scopedAfterOpaque), undefined); writeFileSync(other, "fresh after opaque"); policyB.after(scopedAfterOpaque, "consumed");
  assert.match(policyB.before(call("shell", "other-target-not-reread", "write", { path: file, content: "outside reread target" }, true)) ?? "", /可信读取/,
    "rereading one file does not authorize overwriting another existing file");
  assert.match(policyB.before(call("shell", "still-unbounded", "bash", { command: 'awk "END{print NR}" "./other.txt"' }, true)) ?? "", /不会解除任意 Shell 命令限制/,
    "a scoped reread/write cannot clear the original opaque command boundary");
  const newAfterOpaque = call("shell", "new-file", "write", { path: join(directory, "new-after-opaque.txt"), content: "new target" }, true);
  assert.equal(policyB.before(newAfterOpaque), undefined); writeFileSync(join(directory, "new-after-opaque.txt"), "new target"); policyB.after(newAfterOpaque, "consumed");

  writeFileSync(join(directory, "sequence.txt"), "sequence proof");
  const sequenceRead = call("sequence-reader", "sequence", "bash", { command: 'ls -la; echo "---"; cat sequence.txt' }, false);
  assert.equal(policyA.before(sequenceRead), undefined);
  const sequenceLease = gateA.live().find(lease => lease.owner.taskId === "sequence-reader");
  assert(sequenceLease);
  assert.equal(gateB.acquire({ actionId: "writer-during-sequence", owner: owner("sequence-writer"), resources: [fileResource(other, "write")] }).ok, false,
    "a bounded multi-target read still excludes managed writers for the whole sequence");
  policyA.after(sequenceRead, "consumed");
  assert.equal(gateA.live().filter(lease => lease.owner.taskId === "sequence-reader").length, 0);
  const childRoot = join(directory, "sequence-root"); mkdirSync(childRoot);
  symlinkSync(other, join(childRoot, "outside-link"));
  for (const target of ["../other.txt", "outside-link"]) {
    const escaped = call("sequence-escape", target, "bash", { command: `ls -la; cat ${target}` }, false);
    escaped.context.taskRoot = childRoot;
    assert.throws(() => policyA.before(escaped), /工作区/);
    assert.equal(gateA.live().filter(lease => lease.owner.taskId === "sequence-escape").length, 0, "preflight refuses every escaped leaf before acquiring a lease");
  }

  const unclassified = call("opaque-mcp", "read", "mcp__fixture__opaque_reader", { path: other }, false);
  assert.match(policyA.before(unclassified) ?? "", /缺少可信路径适配器/, "opaque path claims cannot create an unguarded read-modify-write premise");
  const classified = classifyMcpToolCall("mcp__fixture__read_file", { path: other }); assert(classified);
  assert.deepEqual(classified.decision.paths, [other]); assert.equal(classified.sideEffect, false);
  const mcpRead = call("mcp", "read", "mcp__fixture__read_file", { path: other }, false, classified.decision.paths);
  assert.equal(policyA.before(mcpRead), undefined); policyA.after(mcpRead, "consumed");
  writeFileSync(other, "external after MCP read");
  assert.match(policyA.before(call("mcp", "stale-edit", "mcp__fixture__edit_file", { path: other }, true, [other])) ?? "", /version_conflict/);
  const mcpFresh = call("mcp", "reread", "mcp__fixture__read_file", { path: other }, false, [other]);
  assert.equal(policyA.before(mcpFresh), undefined); policyA.after(mcpFresh, "consumed");
  const shellRead = call("shell-reader", "read", "shell_exec", { command: `Get-Content -LiteralPath '${other}'` }, true);
  assert.equal(policyA.before(shellRead), undefined); assert.equal(readFileSync(other, "utf8"), "external after MCP read"); policyA.after(shellRead, "consumed");
  writeFileSync(other, "external after Shell read");
  assert.match(policyA.before(call("shell-reader", "write", "shell_exec", { command: "unclassified arbitrary writer" }, true)) ?? "", /version_conflict/);

  const finalMcpRead = call("mcp", "read-current", "mcp__fixture__read_file", { path: other }, false, [other]);
  assert.equal(policyA.before(finalMcpRead), undefined); policyA.after(finalMcpRead, "consumed");
  const mcp = call("mcp", "edit", "mcp__fixture__edit_file", { path: other }, true, [other]);
  assert.equal(policyA.before(mcp), undefined); writeFileSync(other, "trusted MCP"); policyA.after(mcp, "consumed");
  assert.equal(policyA.before(call("code", "container", "execute_code", { code: "nested calls" }, true)), undefined);
  assert.equal(gateA.live().length, 0, "containers hold no resource needed by their own nested children");

  const desktop = { kind: "desktop", scope: "physical-input", key: "host-session", mode: "write" } satisfies Parameters<typeof gateA.acquire>[0]["resources"][number];
  const down = call("input-a", "down", "computer_exec", { action: "key_down", key: "CTRL" }, true);
  assert.equal(policyA.before(down), undefined); policyA.after(down, "consumed");
  assert.equal(gateB.acquire({ actionId: "other-input", owner: owner("input-b"), resources: [desktop] }).ok, false);
  const up = call("input-a", "up", "computer_exec", { action: "key_up", key: "CTRL" }, true);
  assert.equal(policyA.before(up), undefined); policyA.after(up, "consumed");
  assert.equal(gateA.live().length, 0);
  const lost = granted(gateA.acquire({ actionId: "lost", owner: owner("lost"), resources: [desktop], leaseMs: 100 }));
  clock += 101;
  assert.equal(gateB.acquire({ actionId: "takeover", owner: owner("new"), resources: [desktop] }).ok, false);
  assert.match(gateA.validate(lost) ?? "", /fencing/);
  assert.equal(gateB.reconcileQuarantine(lost.token, { executionStopped: true, queueDrained: false, inputReleased: true, effectKnown: true, receipt: "stop-is-not-drain" }), false);
  a.close();
  const reopened = new Database(path), replacement = new WorkResourceGate(reopened, { hostId: "replacement", now: () => clock });
  assert.equal(replacement.acquire({ actionId: "takeover", owner: owner("new"), resources: [desktop] }).ok, false, "restart never clears uncertain held inputs");
  assert.equal(replacement.reconcileQuarantine(lost.token, { executionStopped: true, queueDrained: true, inputReleased: true, effectKnown: true, receipt: "actual-backend-receipt" }), true);
  const next = granted(replacement.acquire({ actionId: "takeover", owner: owner("new"), resources: [desktop] }));
  assert(next.token > lost.token);
  assert.equal(replacement.release(lost, "confirmed"), false, "old holder cannot settle a new host generation");
  assert.equal(replacement.validate(next), undefined); replacement.release(next, "confirmed"); reopened.close();

  // The guard is present before the real creation boundary, even when called without Durable planning.
  const noGit = join(directory, "no-git"); mkdirSync(noGit);
  writeFileSync(join(noGit, "AGENTS.md"), "Git workflow: use main as the only active local branch. Do not create additional branches or worktrees.");
  assert.equal(await repositoryAllowsGitIsolation(noGit), false);
  await assert.rejects(prepareSubagentWorkspace({ cwd: noGit, isolation: "worktree", parallel: true, writable: true, baseDir: join(directory, "forbidden") }), /禁止创建分支/);
  await assert.rejects(prepareSubagentWorkspace({ cwd: parent, isolation: "worktree", parallel: true, writable: true,
    baseDir: join(directory, "forbidden"), authorizeGitIsolation: () => false }), /禁止创建分支/);
  console.log("Phase3 resources passed: independent SQLite connections, real writes, atomic groups, alias/versions, ordinary/Shell/MCP boundaries, held input/fencing/reopen and actual Git creation guards.");
} finally { if (a.open) a.close(); if (b.open) b.close(); rmSync(directory, { recursive: true, force: true }); }
