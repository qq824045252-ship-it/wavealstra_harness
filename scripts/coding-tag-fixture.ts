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
  ["minimal", "auto"], ["bugfix-test", "bug-fix"], ["feature-dev", "feature"], ["refactor", "refactoring"],
  ["add-tests", "skill:principle-test-behavior-not-implementation"], ["code-review", "skill:interrogate"],
  ["plan-design", "skill:architect"], ["readonly-explain", "investigation"], ["web-html", "feature"],
] as const;
const readOnly = (id: string) => ["code-review", "plan-design", "readonly-explain"].includes(id);
const write = (path: string, content: string): Call => ["write", { path, content }];

export function seedTagCase(id: string, cwd: string) {
  writeFileSync(join(cwd, "value.cjs"), "module.exports = n => n + n;\n");
  if (id === "code-review") {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, windowsHide: true });
    git("init", "-q", "-b", "main"); git("add", "value.cjs");
    git("-c", "user.name=fixture", "-c", "user.email=fixture@invalid", "commit", "-qm", "baseline");
  }
  if (["bugfix-test", "feature-dev", "code-review"].includes(id)) writeFileSync(join(cwd, "value.cjs"), "module.exports = n => n;\n");
  if (id !== "add-tests" && id !== "code-review") writeFileSync(join(cwd, "check.cjs"), id === "web-html" ?
    "require('node:test')('native dialog markup',()=>{const a=require('node:assert/strict');const html=require('node:fs').readFileSync('index.html','utf8');a.match(html,/<dialog aria-label=\"Details\">/);a.match(html,/showModal\\(\\)/);a.match(html,/<form method=\"dialog\">/)});" : test);
}

function tagActions(id: string): Call[] {
  const calls: Call[] = [workflow("status"), workflow("start", id === "minimal" ? { skill: "principle-prove-it-works" } : {}), ["read", { path: "value.cjs" }]];
  if (readOnly(id)) calls.push(write("forbidden.txt", "must not be written"), workflow("review"));
  if (["bugfix-test", "feature-dev", "refactor"].includes(id)) calls.push(verify(), write("value.cjs", "module.exports = n => 2 * n;\n"), verify());
  if (id === "add-tests") calls.push(write("check.cjs", test));
  if (id === "web-html") {
    if (process.env.MYBUDDY_TAG_HTML_GUIDE) calls.push(["read",{path:"dialog-guide.md"}]);
    calls.push(write("index.html", button), verify());
  }
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
    const findings = {verdict:"revise", findings:["value.cjs:1 returns the input instead of twice the input."],
      checks:Object.fromEntries(THERMOS_CRITERIA.map(c => [c.id, "Read value.cjs line 1 and compared its return value with the baseline."]))};
    return {answer:id === "code-review" ? JSON.stringify(findings) : "Inspected value.cjs and checked the caller.", call:entries(body).length ? undefined : ["read",{path:"value.cjs"}]};
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
  if (id === "add-tests" && session.triedCompletion && !session.verified) {
    session.verified = true; return { call: verify(), answer };
  }
  if (id === "code-review" && session.triedCompletion && !session.verified) {
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
  const finished = outputs.find(v => v?.phase === "complete");
  assert.equal(finished?.playbook, preferred === "auto" ? "skill:principle-prove-it-works" : preferred, id + ": " + JSON.stringify(outputs.at(-1)).slice(0,350));
  assert.equal(existsSync(join(cwd,"forbidden.txt")), false, id);
  if (readOnly(id)) assert(!parent[0].tools.some((t: {name:string}) => ["write","edit","powershell","bash"].includes(t.name)), id + " write tools");
  if (id === "code-review") {
    assert.equal(finished.review.passed, false);
    assert.match(finished.thermosOutcome,/待修复/);
    assert(outputs.some(v => typeof v === "string" && v.includes("Independent Thermos review required")));
    assert(outputs.some(v => v?.originals?.["value.cjs"]?.includes("n + n") && v.originals["value.cjs"].includes("After:")));
    assert(bodies.some(b => b.model !== "cron" && JSON.stringify(b).includes("Changed excerpts at the selected baseline") && JSON.stringify(b).includes("n + n")));
  }
  if (id === "plan-design") assert.deepEqual(finished.steps, ["ground","sketch","synthesize"]);
  if (["bugfix-test","feature-dev","refactor","add-tests","web-html"].includes(id)) assert.equal(finished.verification?.passed,true,id);
  if (["bugfix-test","feature-dev"].includes(id)) assert(outputs.some(v => v?.passed === false && v.exitCode === 1),id);
  if (id === "add-tests") assert(outputs.some(v => typeof v === "string" && v.includes("successful verification")));
  if (id === "web-html") {
    assert.equal(readFileSync(join(cwd,"index.html"),"utf8"),button);
    if (process.env.MYBUDDY_TAG_HTML_GUIDE) assert(outputs.some(v=>typeof v === "string" && v.includes("Use the native `<dialog>` element")));
  }
  console.log("PASS coding tag",id,finished.playbook,"complete");
}
