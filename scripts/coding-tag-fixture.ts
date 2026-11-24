import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { THERMOS_CRITERIA } from "../src/shared/pstack";

type Call = [string, Record<string, unknown>];
const workflow = (action: string, args: Record<string, unknown> = {}): Call => ["pstack_workflow", { action, ...args }];
const verify = () => workflow("verify", { shell: process.platform === "win32" ? "powershell" : "bash", command: "node --test check.cjs" });
const test = "const assert=require('node:assert/strict');require('node:test')('twice accepts a positive and zero',()=>{const twice=require('./value.cjs');assert.equal(twice(3),6);assert.equal(twice(0),0)});";
const button = '<button type="button" onclick="document.querySelector(\'dialog\').showModal()">Open</button><dialog aria-label="Details"><form method="dialog"><button>Close</button></form></dialog>';
export const tagCases = [
  ["minimal", "auto"], ["web-html", "auto"],
  ["bugfix-test", "auto"], ["refactor", "auto"], ["add-tests", "auto"], ["feature-dev", "auto"],
  ["code-review", "auto"], ["plan-design", "auto"], ["readonly-explain", "auto"],
  ["thermos-review", "auto"], ["custom-route", "feature"],
] as const;
export const tagPresetId = (id: string) => id === "thermos-review" ? "minimal" : id;
const formerReadOnly = (id: string) => ["code-review", "plan-design", "readonly-explain"].includes(id);
const fixtureRoutes: Record<string, string> = {
  "bugfix-test": "bug-fix", refactor: "refactoring", "web-html": "feature", "custom-route": "feature",
  "thermos-review": "skill:thermo-nuclear-code-quality-review",
};
const routeFor = (id: string) => fixtureRoutes[id] ?? "skill:principle-prove-it-works";
const write = (path: string, content: string): Call => ["write", { path, content }];

export function seedTagCase(id: string, cwd: string) {
  writeFileSync(join(cwd, "value.cjs"), "module.exports = n => n + n;\n");
  if (id === "thermos-review") {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, windowsHide: true });
    git("init", "-q", "-b", "main"); git("add", "value.cjs");
    git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "baseline");
  }
  if (["bugfix-test", "thermos-review"].includes(id)) writeFileSync(join(cwd, "value.cjs"), "module.exports = n => n;\n");
  if (id !== "thermos-review") writeFileSync(join(cwd, "check.cjs"), id === "web-html" ?
    "require('node:test')('native dialog markup',()=>{const a=require('node:assert/strict');const html=require('node:fs').readFileSync('index.html','utf8');a.match(html,/<dialog aria-label=\"Details\">/);a.match(html,/showModal\\(\\)/);a.match(html,/<form method=\"dialog\">/)});" : test);
}

function tagActions(id: string): Call[] {
  const calls: Call[] = [workflow("status")];
  if (id !== "custom-route") calls.push(workflow("start", {playbook:"auto"}));
  calls.push(workflow("start", id === "custom-route" ? {} : { playbook: routeFor(id) }), ["read", { path: "value.cjs" }]);
  if (id === "thermos-review") return [...calls, workflow("review")];
  calls.push(write("authorized.txt", id + "\n"));
  if (formerReadOnly(id)) calls.push(["subagent", { agent: "pstack-feature", model: "fixture/observer", isolation: "shared",
    task: "CODING_TAG_CASE_" + id + " WRITE_RETIRED_TAG_CHILD Write child.txt with the text authorized child and a newline." }]);
  if (["bugfix-test", "refactor"].includes(id)) calls.push(verify(), write("value.cjs", "module.exports = n => 2 * n;\n"));
  if (id === "web-html") {
    if (process.env.MYBUDDY_TAG_HTML_GUIDE) calls.push(["read",{path:"dialog-guide.md"}]);
    calls.push(write("index.html", button));
  }
  calls.push(verify());
  return calls;
}

type Item = {type: string; output?: string};
const entries = (body: { input: Item[] }) => body.input.filter(item => item.type === "function_call_output").map(item => {
  try { return JSON.parse(item.output!); } catch { return item.output; }
});
type Session = { round: number; delegated: Set<string>; triedCompletion: boolean; verified: boolean };
const sessions = new Map<string, Session>();
export function tagFixtureReply(id: string, body: {model: string; input: Item[]}): {call?: Call; answer: string} {
  const answer = "TAG_CASE_FINISHED";
  if (body.model !== "cron") {
    if (JSON.stringify(body).includes("WRITE_RETIRED_TAG_CHILD"))
      return { answer: "Created child.txt within the authorized workspace.",
        call: entries(body).length ? undefined : write("child.txt", "authorized child\n") };
    const findings = {verdict:"revise", findings:["value.cjs:1 returns the input instead of twice the input."],
      checks:Object.fromEntries(THERMOS_CRITERIA.map(c => [c.id, "Read value.cjs line 1 and compared its return value with the baseline."]))};
    return {answer:id === "thermos-review" ? JSON.stringify(findings) : "Inspected value.cjs and checked the caller.", call:entries(body).length ? undefined : ["read",{path:"value.cjs"}]};
  }
  let session = sessions.get(id);
  if (!session) { session = {round:0, delegated:new Set(), triedCompletion:false, verified:false}; sessions.set(id,session); }
  const prefix = tagActions(id), round = session.round++;
  if (round < prefix.length) return { call: prefix[round], answer };
  const outputs = entries(body), run = outputs.findLast(value => value?.playbook && value?.phase);
  if (run && run.phase !== "running") return {answer};
  if (!run || round > 35) return { call: round > 36 ? undefined : workflow("block", {note:"Fixture could not progress."}), answer };
  if (run.current) {
    const stage = run.current;
    if (stage.roleId && !session.delegated.has(stage.id)) {
      session.delegated.add(stage.id);
      return {call:["pstack_delegate",{purpose:"stage",role:stage.roleId,tasks:["CODING_TAG_CASE_" + id + " Inspect value.cjs and report the relevant caller."]}],answer};
    }
    return { call: workflow("advance", {stage:stage.id,note:"Read value.cjs and checked the fixture result."}), answer };
  }
  if (id === "thermos-review" && session.triedCompletion && !session.verified) {
    session.verified = true;
    return {call:["pstack_delegate",{purpose:"thermos",role:"interrogate-reviewers",tasks:["Inspect value.cjs and its previous return value."]}],answer};
  }
  session.triedCompletion = true;
  return {call:workflow("complete"),answer};
}

export function assertTagCase(id: string, preferred: string, cwd: string, raw: string[]) {
  const bodies = raw.map(s => JSON.parse(s)), parent = bodies.filter(b => b.model === "cron");
  const outputs = parent.flatMap(entries);
  assert(outputs.some(v => v?.phase === "idle" && v.preferredPlaybook === preferred), id + " status");
  if (id !== "custom-route") {
    const routing=outputs.find(v => v?.phase === "routing");
    assert.equal(routing?.started,false,id + " auto routes without opening a workflow");
    assert.equal(routing.router?.id,"poteto-mode");
    assert(routing.playbooks.some((book:{id:string})=>book.id==="bug-fix"),id + " exposes enabled task routes");
  }
  const finished = outputs.find(v => v?.phase === "complete");
  assert.equal(finished?.playbook, routeFor(id), id + ": " + JSON.stringify(outputs.at(-1)).slice(0,350));
  if (id === "thermos-review") {
    assert.equal(finished.review.passed, false);
    assert.match(finished.thermosOutcome,/待修复/);
    assert(outputs.some(v => typeof v === "string" && v.includes("Independent Thermos review required")));
    assert(outputs.some(v => v?.originals?.["value.cjs"]?.includes("n + n") && v.originals["value.cjs"].includes("After:")));
    assert(bodies.some(b => b.model !== "cron" && JSON.stringify(b).includes("Original task baseline") && JSON.stringify(b).includes("n + n")),
      "The read-only Thermos reviewer must receive the selected baseline before-image");
    assert(bodies.filter(b => b.model !== "cron").every(b => !b.tools.some((tool: {name:string}) =>
      ["write", "edit", "bash", "powershell"].includes(tool.name))), "Thermos workers retain read-only tools under the minimal tag");
    assert.equal(readFileSync(join(cwd, "value.cjs"), "utf8"), "module.exports = n => n;\n", "A negative standalone review reports the defect without fixing it");
    assert.equal(existsSync(join(cwd, "authorized.txt")), false);
  } else {
    assert(parent[0].tools.some((tool: {name:string}) => tool.name === "write"), id + " has ordinary coding tools");
    assert.equal(readFileSync(join(cwd, "authorized.txt"), "utf8"), id + "\n", id + " permits authorized writes");
    assert.equal(finished.verification?.passed, true, id);
    if (formerReadOnly(id)) {
      assert.equal(readFileSync(join(cwd, "child.txt"), "utf8"), "authorized child\n", id + " does not leave a retired read-only constraint on child agents");
      assert(bodies.some(b => b.model !== "cron" && b.tools.some((tool: {name:string}) => tool.name === "write")), id + " child write tools");
    }
  }
  if (id === "bugfix-test") assert(outputs.some(v => v?.passed === false && v.exitCode === 1),id);
  if (id === "web-html") {
    assert.equal(readFileSync(join(cwd,"index.html"),"utf8"),button);
    if (process.env.MYBUDDY_TAG_HTML_GUIDE) assert(outputs.some(v=>typeof v === "string" && v.includes("Use the native `<dialog>` element")));
  }
  console.log("PASS coding tag",id,finished.playbook,"complete");
}
