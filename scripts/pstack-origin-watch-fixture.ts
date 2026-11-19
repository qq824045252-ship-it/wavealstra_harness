import assert from "node:assert/strict";
import { normalizePstackSettings } from "../src/shared/pstack";
import { monitorPullRequests } from "../src/main/agent/pstack/watch/monitor";
import type { OriginCommand } from "../src/main/agent/pstack/watch/origin";

// Field shapes from Cursor's public Origin OpenAPI and origin pr thread list --json help.
export async function checkOriginWatcher() {
  const target = { owner: "acme", repo: "rocket", pr: 17 }, repository = "acme/rocket", head = "a".repeat(40);
  const membership = (n: number) => ({ number: String(n), repository: { name: "rocket", owner: { slug: "acme" } } });
  let frozen = false, elapsed = 0, threadIds: string[] = [], mergeAfter = Infinity, draft = false, verdict = "mergeable",
    block = "", wrongHead = false;
  const calls: string[][] = [];
  const pull = (n: number) => ({ number: String(n), title: "Origin change", body: "Reviewed", webUrl: "https://cursor.com/codebase/acme/rocket/pull/" + n,
    head: { ref: "change-" + n, sha: head }, base: { ref: n === 17 ? "change-16" : "main", sha: "b".repeat(40) },
    state: elapsed >= mergeAfter || n === 16 ? "closed" : "open", merged: elapsed >= mergeAfter || n === 16, draft,
    stack: { id: "stk_members", ...(n === 17 && { parentPullRequest: membership(16) }) } });
  const command: OriginCommand = async args => {
    calls.push(args);
    if (args[0] === "repo") {
      assert.deepEqual(args, ["repo", "from-github", "acme/rocket", "--json", "found,org,name,mirrorStatus"]);
      return { found: true, org: "acme", name: "rocket", mirrorStatus: "outbound" };
    }
    if (args[0] === "pr") {
      assert.deepEqual(args, ["pr", "thread", "list", "17", "-R", repository, "--unresolved", "--json", "id"]);
      return threadIds.map(id => ({ id }));
    }
    assert.equal(args[0], "api"); assert.deepEqual(args.slice(2), ["-X", "GET"]);
    const path = args[1];
    if (path.includes("?")) {
      const url = new URL(path, "https://example.invalid"), params = url.searchParams;
      assert.equal(params.get("state"), "all"); assert.equal(params.get("stackId"), "stk_members");
      return params.has("pageToken") ? { pullRequests: [pull(16)] } : { pullRequests: [pull(17)], nextPageToken: "second" };
    }
    if (path.endsWith("mergeability")) return { pullRequest: membership(17), headSha: wrongHead ? "e".repeat(40) : head,
      verdict, blockers: block ? [{ kind: "required_checks", message: "CI is " + block, requiredChecks: { state: block } }] : [] };
    assert.match(path, /^\/repos\/acme\/rocket\/pulls\/(16|17)$/);
    return pull(Number(path.split("/").at(-1)));
  };
  const clock = { now: () => elapsed, observedAt: () => new Date(elapsed * 1000).toISOString(), sleep: async (s: number) => { elapsed += s; } };
  const adapter = { origin: command, clock, active: () => true, freeze: async (scope: { repository: string; prs: number[] }) => {
    assert.deepEqual(scope, { repository, prs: [16, 17] }); frozen = true; return scope; } };
  const observe = (book: "shipping" | "babysit", p: Record<string, unknown> = {}) =>
    monitorPullRequests(normalizePstackSettings({ playbooks: { [book]: { parameters: { forge: "origin", maxQueryErrors: 1, ...p } } } }), book, target, adapter);
  const snapshot = await observe("babysit", { forge: "auto", statusOnly: true, watchMode: "queued-stack" });
  assert.ok(frozen); assert.equal(snapshot.forge, "origin"); assert.equal(snapshot.verdict.kind, "ORIGIN_STATUS");
  assert.deepEqual(JSON.parse(snapshot.output).rows.map((r: {status: string}) => r.status), ["merged", "mergeable"]);
  assert.equal(snapshot.mergedSnapshot, false); assert.equal(calls.filter(x => x[0] === "repo").length, 1);
  assert.equal((await observe("babysit")).verdict.kind, "ORIGIN_MERGEABLE");
  threadIds = ["thread_x"];
  assert.match((await observe("babysit", { pretty: true })).output, /ORIGIN_BLOCKED[\s\S]*1 unresolved review threads/);
  threadIds = []; draft = true;
  assert.equal((await observe("babysit")).allowed, false);
  assert.equal((await observe("babysit", { allowDraft: true })).allowed, true);
  draft = false; verdict = "future-new-verdict";
  assert.equal((await observe("babysit")).verdict.kind, "ORIGIN_BLOCKED");
  verdict = "blocked"; block = "failing";
  assert.match((await observe("babysit", { pretty: true })).output, /CI is failing/);
  block = "pending";
  assert.equal((await observe("babysit", { timeoutSeconds: 3, intervalSeconds: 7 })).verdict.kind, "ORIGIN_TIMEOUT");
  assert.equal(elapsed, 3);
  wrongHead = true;
  assert.match((await observe("babysit")).output, /different PR or head/);
  wrongHead = false; verdict = "mergeable"; block = ""; mergeAfter = 9;
  assert.equal((await observe("shipping", { watchMode: "queued-stack", intervalSeconds: 3 })).verdict.kind, "ORIGIN_MERGED");
  assert.equal(elapsed, 9);
  assert.equal((await observe("shipping", { statusOnly: true })).mergedSnapshot, true);
}
