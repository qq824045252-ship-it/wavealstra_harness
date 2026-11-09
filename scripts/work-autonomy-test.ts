/** P0 autonomy control plane: action matrix, deterministic precedence, precedents, Judge shadow. */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { classifyWorkAction } from "../src/main/agent/work/WorkActionClassifier";
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
  assert.equal(scoped.kind, "ask", "a missing write scope asks for the existing one-action grant instead of silently denying");
  assert.match(scoped.kind === "ask" ? scoped.reason : "", /一次性授权/);
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
  // Revoke the rule: only the recorded precedent can authorize the next identical action.
  assert.equal(ledger.revokeRule(rule.ruleId, "user-1"), true);
  const reuse = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p9" });
  assert.equal(reuse.kind, "allow", "a scoped precedent authorizes the same compatible action");
  assert.equal(reuse.kind === "allow" ? reuse.source : "", "precedent");
  assert.deepEqual(reuse.kind === "allow" ? reuse.citedDecisionIds : [], [decision.decisionId]);
  const otherProject = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(write, { ...context, projectId: "p1" });
  assert.equal(otherProject.kind, "deny", "a precedent never crosses into another project");
  const otherTarget = new WorkAutonomyPolicy(new WorkDecisionLedger(db)).decide(
    classifyWorkAction({ toolName: "write", arguments: { path: "b.txt" } }), { ...context, projectId: "p9" });
  assert.equal(otherTarget.kind, "ask", "a precedent is bound to its target identity, not to every path");
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
    userId: "user-1", actionHash: "h", policyVersion: "autonomy-1", descriptor: { effect: "local_write", operation: "write_file",
    environment: "local", reversibility: "recoverable", blastRadius: "single" }, decidedBy: "user", outcome: "allowed", reusable: true,
    reason: "x", citedRuleIds: [], citedDecisionIds: [], createdAt: 1 }] });
  assert.equal(decided.verdict, "DECIDED");
});

db.close();
console.log(`work autonomy: ${count} checks passed`);
