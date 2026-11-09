/** P0 autonomy control plane: action matrix, deterministic precedence, precedents, Judge shadow. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { classifyWorkAction, targetsInsideWorkspace } from "../src/main/agent/work/WorkActionClassifier";
import { WorkDecisionLedger } from "../src/main/agent/work/WorkDecisionLedger";
import { WorkAutonomyPolicy, type AutonomyContext } from "../src/main/agent/work/WorkAutonomyPolicy";
import { WorkDecisionJudge } from "../src/main/agent/work/WorkDecisionJudge";
import { isHardGateAction } from "../src/shared/bot-work-action";

let count = 0;
const check = (name: string, run: () => void | Promise<void>) => Promise.resolve(run()).then(() => {
  count += 1; console.log(`PASS ${count}: ${name}`);
});
const db = new Database(":memory:");
const context: AutonomyContext = { userId: "user-1", botId: "bot-1", workId: "work-1", bindingId: "binding-1",
  actionHash: "hash-1", projectId: "p1", workspaceId: "ws-1", repo: "owner/repo", delegatedScope: ["workspace:read", "workspace:write"],
  permissionMode: "auto" };

await check("progress reporting is internal mutation, never an implicit read or write grant", () => {
  const args = { expectedStateVersion: 1, expectedIntentRevision: 1, expectedOwnerEpoch: 1, status: "active", progressSummary: "done" };
  assert.equal(classifyWorkAction({ toolName: "conversation_goal_update", arguments: args }).effect, "work_progress");
  for (const arguments_ of [{ ...args, status: "paused" }, { ...args, criterionUpdates: [{ id: "c1", status: "met" }] },
    { ...args, title: "new requirements" }, { ...args, unexpected: true }])
    assert.notEqual(classifyWorkAction({ toolName: "conversation_goal_update", arguments: arguments_ }).effect, "work_progress");
});

await check("only registered conversation goal getter is a trusted read", () => {
  const getter = classifyWorkAction({ toolName: "conversation_goal_get", arguments: { workId: "work-current" } });
  assert.equal(getter.effect, "read"); assert.equal(getter.target, "work-current");
  assert.equal(getter.operation, "inspect_work_goal");
  for (const toolName of ["conversation_goal_create", "conversation_goal_update", "conversation_goal_close", "conversation_goal_get_other", "untrusted_get"]) {
    assert.notEqual(classifyWorkAction({ toolName, arguments: {} }).effect, "read", toolName);
  }
});

await check("action matrix: read/local write/repo/protected/force/publish/delete/message/credential/physical/unknown", () => {
  const read = classifyWorkAction({ toolName: "read", arguments: { path: "a.txt" } });
  assert.equal(read.effect, "read"); assert.equal(read.hardGate, false);
  const shellRead = classifyWorkAction({ toolName: "bash", arguments: { command: "ls -l ./a.txt; echo $?" } });
  assert.equal(shellRead.effect, "read", "scoped read-only shell stays read");
  const write = classifyWorkAction({ toolName: "write", arguments: { path: "a.txt", content: "x" } });
  assert.equal(write.effect, "local_write"); assert.equal(write.operation, "write_file");
  const shellWrite = classifyWorkAction({ toolName: "bash", arguments: { command: "printf x > a.txt" } });
  assert.equal(shellWrite.effect, "local_write", "shell redirection is never read");
  const commit = classifyWorkAction({ toolName: "bash", arguments: { command: "git commit -m x" } });
  assert.equal(commit.operation, "git_commit"); assert.equal(commit.hardGate, false);
  const push = classifyWorkAction({ toolName: "bash", arguments: { command: "git push origin feature/x" } });
  assert.equal(push.operation, "git_push"); assert.equal(push.hardGate, false);
  const protectedPush = classifyWorkAction({ toolName: "bash", arguments: { command: "git push origin main" } });
  assert.equal(protectedPush.operation, "git_push_protected"); assert.equal(protectedPush.hardGate, true);
  const forcePush = classifyWorkAction({ toolName: "bash", arguments: { command: "git push --force origin feature/x" } });
  assert.equal(forcePush.operation, "git_force_push"); assert.equal(isHardGateAction(forcePush), true);
  for (const command of ["git push origin HEAD:main", "git push origin feature:refs/heads/main", "git push origin :main", "git push origin +feature:main"]) {
    assert.equal(classifyWorkAction({ toolName: "bash", arguments: { command } }).hardGate, true, command);
  }
  const merge = classifyWorkAction({ toolName: "bash", arguments: { command: "gh pr merge 12 --squash" } });
  assert.equal(merge.operation, "pr_merge"); assert.equal(merge.hardGate, true);
  const publish = classifyWorkAction({ toolName: "bash", arguments: { command: "npm publish --access public" } });
  assert.equal(publish.effect, "publish"); assert.equal(publish.hardGate, true);
  const remove = classifyWorkAction({ toolName: "bash", arguments: { command: "rm -rf build" } });
  assert.equal(remove.effect, "delete"); assert.equal(remove.hardGate, true);
  const message = classifyWorkAction({ toolName: "call", arguments: { channel: "#team" },
    mcp: { providerId: "slack", server: "slack", tool: "send_message" } });
  assert.equal(message.effect, "message"); assert.equal(message.provider, "slack");
  const mcpDelete = classifyWorkAction({ toolName: "call", arguments: {}, mcp: { providerId: "github", server: "github", tool: "delete_repo" } });
  assert.equal(mcpDelete.effect, "delete"); assert.equal(mcpDelete.hardGate, true);
  const credential = classifyWorkAction({ toolName: "bash", arguments: { command: "cat ~/.ssh/id_ed25519" } });
  assert.equal(credential.effect, "credential"); assert.equal(credential.hardGate, true);
  const physical = classifyWorkAction({ toolName: "computer_exec", arguments: { action: "click" } });
  assert.equal(physical.effect, "physical_input");
  const unknown = classifyWorkAction({ toolName: "bash", arguments: { command: "frobnicate --now" } });
  assert.equal(unknown.effect, "external_write", "unknown shell must not degrade to read");
  assert.equal(unknown.tags.includes("unclassified"), true);
  const unknownTool = classifyWorkAction({ toolName: "mystery_tool", arguments: {} });
  assert.equal(unknownTool.effect, "external_write"); assert.equal(unknownTool.source, "fallback");
});

await check("policy precedence: hard gate, deny>allow, readonly, scope mismatch, expiry", () => {
  const ledger = new WorkDecisionLedger(db);
  const policy = new WorkAutonomyPolicy(ledger);
  const write = classifyWorkAction({ toolName: "write", arguments: { path: "a.txt" } });
  ledger.addRule({ userId: "user-1", decision: "allow", reason: "project allows writes",
    scope: { projectId: "p1", effect: ["local_write"] }, createdBy: "user" });
  assert.equal(policy.decide(write, context).kind, "allow");
  assert.equal(policy.decide(write, { ...context, projectId: "p2" }).kind, "ask", "another project is not covered");
  ledger.addRule({ userId: "user-1", decision: "deny", reason: "no writes in p1",
    scope: { projectId: "p1", effect: ["local_write"] }, createdBy: "user" });
  const denied = policy.decide(write, context);
  assert.equal(denied.kind, "deny", "explicit deny wins over allow");
  assert.equal(policy.decide(write, { ...context, permissionMode: "readonly" }).kind, "deny", "readonly stays a hard boundary");
  const scoped = policy.decide(write, { ...context, delegatedScope: ["workspace:read"] });
  assert.equal(scoped.kind, "deny", "explicit deny also wins over missing scope");
  assert.equal(policy.decide(write, { ...context, projectId: "p2", delegatedScope: ["workspace:read"] }).kind, "ask");
  const protectedPush = classifyWorkAction({ toolName: "bash", arguments: { command: "git push origin main" } });
  const hard = policy.decide(protectedPush, context);
  assert.equal(hard.kind, "ask"); assert.equal(hard.kind === "ask" && hard.hardGate, true);
  const expired = new WorkDecisionLedger(new Database(":memory:"));
  expired.addRule({ userId: "user-1", decision: "allow", reason: "expired", scope: { effect: ["local_write"], expiresAt: 1 }, createdBy: "user" });
  assert.equal(new WorkAutonomyPolicy(expired).decide(write, context).kind, "ask", "expired rules never match");
});

await check("precedent: only reusable, in-scope, non-superseded decisions are reused", () => {
  const ledger = new WorkDecisionLedger(db);
  const policy = new WorkAutonomyPolicy(ledger);
  const write = classifyWorkAction({ toolName: "write", arguments: { path: "a.txt" } });
  const allowed = policy.decide(write, { ...context, projectId: "p9" });
  const rule = ledger.addRule({ userId: "user-1", decision: "allow", reason: "p9 allows local writes",
    scope: { projectId: "p9", effect: ["local_write"] }, createdBy: "user" });
  assert.equal(rule.decision, "allow");
  const verdict = policy.decide(write, { ...context, projectId: "p9" });
  assert.equal(verdict.kind, "allow");
  if (verdict.kind !== "allow") return;
  const decision = policy.record(verdict, write, { ...context, projectId: "p9" }, verdict.reason);
  assert.equal(decision.reusable, true);
  // 先例只在引用来源仍然有效时才能复用：规则仍在，因此下一个同作用域动作直接命中规则。
  const scoped = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p9" });
  assert.equal(scoped.kind, "allow");
  assert.equal(scoped.kind === "allow" ? scoped.source : "", "policy");
  const otherProject = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p1" });
  assert.equal(otherProject.kind, "deny", "a rule never crosses into another project");
  // 撤销源规则：引用它的历史记录不能再作为放行依据。
  assert.equal(ledger.revokeRule(rule.ruleId, "user-1"), true);
  const revoked = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p9" });
  assert.equal(revoked.kind, "ask", "revoking the source rule invalidates the recorded decision");
  assert.equal(new WorkDecisionLedger(db).precedentFor("user-1", write, { effect: "local_write", operation: "write_file", provider: "builtin",
    environment: "local", projectId: "p9", workspaceId: "ws-1", repo: "owner/repo", botId: "bot-1" }), undefined,
    "revoked rules never support a precedent");
  // 引用来源仍有效但规则不再匹配本次动作时，先例才是真正的判定路径；撤销后又回到询问。
  const unrelated = ledger.addRule({ userId: "user-1", decision: "allow", reason: "repo writes",
    scope: { projectId: "p9", effect: ["repo_write"] }, createdBy: "user" });
  const referenced = ledger.record({ userId: "user-1", actionHash: "hash-2", policyVersion: "autonomy-1",
    decidedBy: "policy", outcome: "allowed", reusable: true, reason: "covered by rule",
    scope: { projectId: "p9", workspaceId: "ws-1", repo: "owner/repo", botId: "bot-1" }, citedRuleIds: [unrelated.ruleId], citedDecisionIds: [],
    descriptor: { effect: "local_write", operation: "write_file", provider: "builtin", target: "a.txt", environment: "local",
      reversibility: "recoverable", blastRadius: "single" } });
  const precedent = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p9" });
  assert.equal(precedent.kind, "allow", "an in-scope precedent with a live source rule authorizes the exact action");
  assert.equal(precedent.kind === "allow" ? precedent.source : "", "precedent");
  assert.deepEqual(precedent.kind === "allow" ? precedent.citedDecisionIds : [], [referenced.decisionId]);
  assert.equal(new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(
    classifyWorkAction({ toolName: "write", arguments: { path: "b.txt" } }), { ...context, projectId: "p9" }).kind,
    "ask", "a precedent is bound to its target identity, not to every path");
  assert.equal(ledger.revokeRule(unrelated.ruleId, "user-1"), true);
  assert.equal(new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p9" }).kind,
    "ask", "a precedent whose cited rule was revoked never re-authorizes the action");
  // ignore/expired never become reusable precedents.
  const ignored = ledger.record({ userId: "user-1", actionHash: "h2", policyVersion: "autonomy-1", decidedBy: "user",
    outcome: "ignored", reusable: false, reason: "dismissed",
    descriptor: { effect: "local_write", operation: "write_file", environment: "local", reversibility: "recoverable", blastRadius: "single" },
    citedRuleIds: [], citedDecisionIds: [] });
  assert.equal(ignored.reusable, false);
  assert.equal(ledger.listDecisions("user-1").some(item => item.outcome === "ignored" && item.reusable), false);
  // Superseding a decision removes it from precedent reuse.
  const corrected = ledger.record({ userId: "user-1", actionHash: "hash-1", policyVersion: "autonomy-1", decidedBy: "user",
    outcome: "denied", reusable: false, reason: "owner corrected", supersedes: decision.decisionId,
    descriptor: "descriptor" in decision ? decision.descriptor : { effect: "local_write", operation: "write_file", environment: "local", reversibility: "recoverable", blastRadius: "single" },
    citedRuleIds: [], citedDecisionIds: [] });
  assert.equal(corrected.outcome, "denied");
  assert.equal(ledger.listDecisions("user-1").some(item => item.decisionId === decision.decisionId && item.supersededBy), true,
    "the corrected decision is kept as history, not deleted");
  void allowed;
});

await check("readonly: proven reads stay allowed, writes and shell commands are denied", () => {
  const ledger = new WorkDecisionLedger(new Database(":memory:"));
  const policy = new WorkAutonomyPolicy(ledger);
  const readonly = { ...context, permissionMode: "readonly" as const, scopeGranted: true };
  const read = classifyWorkAction({ toolName: "read", arguments: { path: "a.txt" } });
  assert.equal(policy.decide(read, readonly).kind, "allow", "readonly never blocks a proven read");
  const shellRead = classifyWorkAction({ toolName: "bash", arguments: { command: "ls -l; echo $?" } });
  assert.equal(policy.decide(shellRead, readonly).kind, "allow");
  const write = classifyWorkAction({ toolName: "write", arguments: { path: "a.txt" } });
  const denied = policy.decide(write, readonly);
  assert.equal(denied.kind, "deny");
  assert.match(denied.kind === "deny" ? denied.reason : "", /local_write/);
  const unknown = classifyWorkAction({ toolName: "bash", arguments: { command: "frobnicate --now" } });
  assert.equal(policy.decide(unknown, readonly).kind, "deny");
});

await check("authorized workspace: routine read/write is allowed by scope, boundaries still ask", () => {
  const policy = new WorkAutonomyPolicy(new WorkDecisionLedger(new Database(":memory:")));
  const scoped = { ...context, scopeGranted: true };
  const read = classifyWorkAction({ toolName: "read", arguments: { path: "a.txt" } });
  const readVerdict = policy.decide(read, scoped);
  assert.equal(readVerdict.kind, "allow");
  assert.equal(readVerdict.kind === "allow" ? readVerdict.source : "", "scope");
  const write = classifyWorkAction({ toolName: "write", arguments: { path: "docs/a.txt" } });
  assert.equal(policy.decide(write, { ...scoped, targetInsideWorkspace: true }).kind, "allow",
    "a proven in-workspace write needs no fresh approval");
  assert.equal(policy.decide(write, { ...scoped, targetInsideWorkspace: false }).kind, "ask",
    "an unproven write target still asks the owner");
  assert.equal(policy.decide(write, { ...scoped, scopeGranted: false, targetInsideWorkspace: true }).kind, "ask",
    "a missing Work scope still asks for the one-time grant");
  const push = classifyWorkAction({ toolName: "bash", arguments: { command: "git push origin main" } });
  const pushed = policy.decide(push, { ...scoped, targetInsideWorkspace: true });
  assert.equal(pushed.kind, "ask"); assert.equal(pushed.kind === "ask" && pushed.hardGate, true);
  const unknown = classifyWorkAction({ toolName: "bash", arguments: { command: "frobnicate --now" } });
  assert.equal(policy.decide(unknown, scoped).kind, "ask", "unclassified effects are never routine");
  const delegated = classifyWorkAction({ toolName: "subagent", arguments: {} });
  assert.equal(policy.decide(delegated, { ...scoped, targetInsideWorkspace: true }).kind, "ask", "delegation is not a routine write");
  // 范围放行不能被记录成可复用先例。
  const decision = policy.record(readVerdict as Extract<typeof readVerdict, { kind: "allow" }>, read, scoped, "routine read");
  assert.equal(decision.reusable, false, "scope-based grants never become reusable precedents");
});

await check("shell counterexamples never classify as read", () => {
  const read = (command: string) => classifyWorkAction({ toolName: "bash", arguments: { command } }).effect === "read";
  for (const command of ["ls -l", "cat a.txt", "grep -n foo a.txt | head -5", "ls -l ./a.txt; echo $?", "git status --short",
    "gh pr view 12", "gh issue list --state open", "gh api repos/o/r/issues", "curl -s https://api.github.com/repos/o/r",
    "curl 'https://wttr.in/Beijing?format=3'", "git branch --list", "git remote -v", "wget -q -O - https://example.com"]) {
    assert.equal(read(command), true, `proven read: ${command}`);
  }
  for (const command of ["echo x > file", "ls >out", "cat $(rm x)", "cat `rm x`", "find . -exec rm {} \\;",
    "find . -delete", "awk 'BEGIN{system(\"rm x\")}'", "echo hi | tee file", "pwd\ntouch injected", "ls & rm x",
    "cat < a", "sed -i s/a/b/ file", "cp a b", "mkdir docs", "bash -c 'rm x'", "xargs rm",
    "gh pr merge 12", "gh api -X POST repos/o/r/issues", "curl -X POST https://x", "curl -o out.txt https://x",
    "git branch -D topic", "git remote add evil https://example.com", "wget https://example.com",
    "curl --data-binary x https://example.com", "curl --json x https://example.com", "curl -K config https://example.com",
    "git diff --ext-diff", "git log --textconv", "gh pr view 1 --web", "rg --pre evil text .",
    "git log --output=log.txt", "awk -i inplace '{print}' a.txt", "grep -n foo a.txt --output out.txt"]) {
    assert.equal(read(command), false, `never read: ${command}`);
  }
});

await check("workspace target proof refuses lexical and symlink escapes", async () => {
  const base = await mkdtemp(join(tmpdir(), "work-target-proof-"));
  const root = join(base, "root"), outside = join(base, "outside");
  try {
    await mkdir(root); await mkdir(outside);
    await symlink(outside, join(root, "link"));
    await symlink(join(outside, "not-created.txt"), join(root, "dangling"));
    assert.equal(targetsInsideWorkspace(root, "write", { path: "dangling" }), false);
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "printf x > dangling" }), false);
    assert.equal(targetsInsideWorkspace(root, "write", { path: "docs/a.md" }), true);
    assert.equal(targetsInsideWorkspace(root, "write", { path: join(root, "docs/b.md") }), true);
    assert.equal(targetsInsideWorkspace(root, "write", { path: "../outside/a.md" }), false);
    assert.equal(targetsInsideWorkspace(root, "write", { path: "link/a.md" }), false,
      "a symlink inside the workspace is not proof of an in-workspace write");
    assert.equal(targetsInsideWorkspace(root, "write", { path: join(outside, "a.md") }), false);
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "mkdir -p docs/nested" }), true);
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "mkdir -p docs && printf '%s' 'hello world' > docs/a.txt && echo done > docs/b.txt" }), true);
    for (const command of ['echo x > "$?"', "mkdir ok && arbitrary-command", "mkdir ok; curl --data x https://x", "echo x > link", "echo x > ../outside/a", "printf x > link/a", "mkdir ok && cd /tmp", "mkdir ok && touch $HOME/x"]) {
      assert.equal(targetsInsideWorkspace(root, "bash", { command }), false, command);
    }
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "mkdir -p link/docs" }), false);
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "cp /etc/passwd docs/x" }), false);
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "mv a ../b" }), false);
    assert.equal(targetsInsideWorkspace(root, "bash", { command: "touch $HOME/x" }), false);
    assert.equal(targetsInsideWorkspace(undefined, "write", { path: "a.md" }), false);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await check("explicit denies precede readonly and hard-gate asks; MCP deletion is not message", () => {
  const ledger = new WorkDecisionLedger(new Database(":memory:"));
  const policy = new WorkAutonomyPolicy(ledger);
  ledger.addRule({ userId: context.userId, decision: "deny", reason: "owner denies", scope: {}, createdBy: "user" });
  for (const descriptor of [classifyWorkAction({ toolName: "read", arguments: {} }),
    classifyWorkAction({ toolName: "bash", arguments: { command: "git push --force origin main" } })]) {
    for (const permissionMode of ["readonly", "auto", "default"] as const) {
      assert.equal(policy.decide(descriptor, { ...context, permissionMode }).kind, "deny");
    }
  }
  const deletion = classifyWorkAction({ toolName: "call", arguments: { channel: "C1" },
    mcp: { providerId: "slack", server: "slack", tool: "delete_channel" } });
  assert.equal(deletion.effect, "delete"); assert.equal(deletion.hardGate, true);
  assert.notEqual(classifyWorkAction({ toolName: "call", arguments: { channel: "C1" },
    mcp: { providerId: "slack", tool: "publish_release" } }).effect, "message");
  assert.equal(classifyWorkAction({ toolName: "call", arguments: {}, effect: "read",
    mcp: { providerId: "slack", tool: "history" } }).effect, "read");
});

await check("decision provenance: expiry, missing sources, foreign sources and cycles invalidate", () => {
  let now = 100;
  const ledger = new WorkDecisionLedger(new Database(":memory:"), () => now);
  const rule = ledger.addRule({ userId: "u", decision: "allow", reason: "limited", createdBy: "user", scope: { expiresAt: 200 } });
  const descriptor = { effect: "local_write", operation: "write_file", provider: "builtin", target: "a", environment: "local", reversibility: "recoverable", blastRadius: "single" };
  const base = { userId: "u", descriptor, actionHash: "h", policyVersion: "autonomy-1", decidedBy: "policy" as const,
    outcome: "allowed" as const, reusable: true, reason: "test", citedRuleIds: [] as string[], citedDecisionIds: [] as string[] };
  ledger.record({ ...base, decisionId: "root", citedRuleIds: [rule.ruleId] });
  ledger.record({ ...base, decisionId: "child", citedDecisionIds: ["root"] });
  assert.equal(ledger.isDecisionValid("child", "u"), true);
  assert.equal(ledger.isDecisionValid("child", "other"), false);
  ledger.record({ ...base, decisionId: "missing", citedDecisionIds: ["absent"] });
  assert.equal(ledger.isDecisionValid("missing", "u"), false);
  ledger.record({ ...base, decisionId: "cycle-a", citedDecisionIds: ["cycle-b"] });
  ledger.record({ ...base, decisionId: "cycle-b", citedDecisionIds: ["cycle-a"] });
  assert.equal(ledger.isDecisionValid("cycle-a", "u"), false);
  now = 201;
  assert.equal(ledger.isDecisionValid("child", "u"), false);
});

await check("judge: shadow only, hard gate never decided, invalid or fabricated citations hold", async () => {
  let calls = 0;
  const judge = new WorkDecisionJudge({ mode: "shadow", timeoutMs: 500, transport: async () => {
    calls += 1; return { verdict: "DECIDED", answer: "yes", reason: "covered", citedDecisionIds: ["decision-x", "fabricated"] };
  } });
  const write = classifyWorkAction({ toolName: "write", arguments: { path: "a.txt" } });
  const hard = classifyWorkAction({ toolName: "bash", arguments: { command: "git push --force origin main" } });
  const held = await judge.predict({ descriptor: hard, question: "allow?", precedents: [], policies: [] });
  assert.equal(held.verdict, "HOLD"); assert.equal(calls, 0, "hard gate never reaches the model");
  const none = await judge.predict({ descriptor: write, question: "allow?", precedents: [], policies: [] });
  assert.equal(none.verdict, "HOLD");
  const fabricated = await judge.predict({ descriptor: write, question: "allow?",
    precedents: [{ decisionId: "decision-x", userId: "user-1", actionHash: "h", policyVersion: "autonomy-1",
      descriptor: { effect: "local_write", operation: "write_file", environment: "local", reversibility: "recoverable", blastRadius: "single" },
      decidedBy: "user", outcome: "allowed", reusable: true, reason: "x", citedRuleIds: [], citedDecisionIds: [], createdAt: 1 }],
    policies: [] });
  assert.equal(fabricated.verdict, "HOLD", "unknown citations are rejected");
  const failing = new WorkDecisionJudge({ transport: async () => { throw new Error("429"); } });
  assert.equal((await failing.predict({ descriptor: write, question: "allow?", precedents: [{ decisionId: "decision-x", userId: "user-1",
    actionHash: "h", policyVersion: "autonomy-1", descriptor: { effect: "local_write", operation: "write_file", environment: "local",
    reversibility: "recoverable", blastRadius: "single" }, decidedBy: "user", outcome: "allowed", reusable: true, reason: "x",
    citedRuleIds: [], citedDecisionIds: [], createdAt: 1 }], policies: [] })).verdict, "HOLD", "judge failure never allows");
  const valid = new WorkDecisionJudge({ transport: async () => ({ verdict: "DECIDED", answer: "yes", reason: "same scope",
    citedDecisionIds: ["decision-x"] }) });
  const decided = await valid.predict({ descriptor: write, question: "allow?", policies: [], precedents: [{ decisionId: "decision-x",
    userId: "user-1", actionHash: "h", policyVersion: "autonomy-1", descriptor: { effect: "local_write", operation: "write_file", provider: "builtin",
    environment: "local", reversibility: "recoverable", blastRadius: "single" }, decidedBy: "user", outcome: "allowed", reusable: true,
    reason: "x", citedRuleIds: [], citedDecisionIds: [], createdAt: 1 }] });
  assert.equal(decided.verdict, "DECIDED");
});

db.close();
console.log(`work autonomy: ${count} checks passed`);
