import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Compare the evidence from the two installed entry points. A matched input
// and a terminal reply are necessary observations; neither is a quality verdict.
const [destination, ...extra] = process.argv.slice(2);
if (!destination) throw Error("Usage: node scripts/pstack-live-pairs.mjs <batch> [additional evidence directories...]");
const batch = resolve(destination);
const read = file => JSON.parse(readFileSync(file, "utf8"));
const inventory = read(join(batch, "original-catalog.json"));
const fixtures = new Map();
function initialFixture(cwd) {
  if (!fixtures.has(cwd)) {
    const git = (...args) => execFileSync("git", ["--no-optional-locks", "-C", cwd, ...args], {encoding:"utf8", windowsHide:true});
    const initial = git("rev-list", "--first-parent", "--max-parents=0", "HEAD").trim();
    // The per-task identity record contains the absolute disposable workspace.
    // All other tracked objects (including the original CPU profile) must match.
    const files = git("ls-tree", "-rz", initial).split("\0").filter(line => line && !line.endsWith("\t.mybuddy-task.json"));
    const hash = createHash("sha256").update(files.join("\0")).digest("hex");
    fixtures.set(cwd, {hash, files:files.length});
  }
  return fixtures.get(cwd);
}
const attempts = [], visited = new Set();
function visit(dir) {
  if (visited.has(dir)) return;
  visited.add(dir);
  if (!existsSync(join(dir, "run.json"))) {
    for (const child of readdirSync(dir, {withFileTypes:true})) if (child.isDirectory()) visit(join(dir, child.name));
    return;
  }
  const run = read(join(dir, "run.json"));
  if (!inventory.some(r => r.playbook === run.route)) return;
  const path = relative(batch, dir).replaceAll("\\", "/");
  const result = existsSync(join(dir, "evidence.json")) ? read(join(dir, "evidence.json")) : undefined;
  const stop = existsSync(join(dir, "interrupted.json")) ? read(join(dir, "interrupted.json")) : undefined;
  const records = result?.records ?? [];
  const rootId = records.reduce((id, r) => Math.min(id, r.conversation), Infinity);
  const root = records.filter(r => r.conversation === rootId).sort((a,b) => a.entry - b.entry);
  const reply = root.filter(r => r.role === "assistant").at(-1);
  const workflow = result?.workflow;
  const status = !result ? stop ? "interrupted" : "running" : result.operatorRequired ? "operator" :
    result.expired ? "timeout" : result.error || reply?.stop === "error" ? "error" :
    workflow?.phase ?? (reply?.stop === "stop" ? "returned" : "unfinished");
  const readCalls = root.flatMap(r => r.calls).filter(c => c.name === "read" &&
    String(c.args.path).replaceAll("\\", "/").endsWith("/poteto-mode/playbooks/" + run.route + ".md"));
  const directRead = readCalls.some(c => root.some(r => r.tool === "read" && !r.failed && r.callId === c.id));
  const fixture = ["complete", "returned", "blocked"].includes(status) ? initialFixture(run.cwd) : undefined;
  attempts.push({
    route:run.route, arm:run.arm, path, status, request:run.request, source:run.sourceHash,
    start:run.start, end:result?.end, model:run.modelId, referenceMode:run.referenceMode,
    models:[...new Set(records.filter(r => r.role === "assistant" && r.model && !r.error).map(r => r.provider + "/" + r.model))],
    roleFiles:Object.keys(run.roleDefinitions ?? {}).length, directRead, fixture,
    stop:reply?.stop, localProof:workflow?.verification?.command, thermos:workflow?.thermosOutcome,
    reviewed:workflow?.review?.passed, reviewModels:workflow?.review?.receipt?.models,
    blocked:workflow?.block ?? result?.operatorRequired ?? stop?.block, providerError:reply?.error ?? result?.error ?? stop?.error,
    publishedPr:workflow?.publishedPr
  });
}
for (const dir of [batch, ...extra.map(d => resolve(d))]) visit(dir);
const groups = inventory.map(({playbook, sha256}) => {
  const entries = attempts.filter(a => a.route === playbook && a.source === sha256);
  const native = entries.filter(a => a.arm === "native" && ["complete","blocked"].includes(a.status) && a.stop === "stop" &&
    !(playbook === "opening-a-pr" && a.status === "complete" && !a.publishedPr));
  const original = entries.filter(a => a.arm === "original" && a.status === "returned");
  const matches = native.flatMap(n => original.filter(o => n.request === o.request && n.fixture?.hash === o.fixture?.hash).map(o => ({
    native:n.path, original:o.path, fixture:n.fixture.hash,
    score:(n.status === "complete" ? 64 : 0) + (o.directRead ? 16 : 0) + (o.roleFiles ? 8 : 0) + (n.model === o.model ? 2 : 0),
    last:n.start > o.start ? n.start : o.start
  }))).sort((a,b) => b.score - a.score || b.last.localeCompare(a.last));
  return {playbook, source:sha256, matches, attempts:entries};
});
writeFileSync(join(batch,"paired-inputs.json"), JSON.stringify(groups,null,2));
for (const g of groups) console.log(g.playbook, g.matches.length ? g.matches[0].native + " ↔ " + g.matches[0].original : "no settled same-input pair");
