import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { originalCaseStart, readLiveCompletion } from "./pstack-live-lineage.mjs";

// Independent artifact checks use the submitted workspace, after the chat has
// settled. Keep external services out of these checks.
const batch = resolve(process.argv[2]);
const observations = JSON.parse(readFileSync(join(batch, "observations.json"), "utf8"));
const results = [];
const runs = new Map(observations.filter(o => o.directory).map(o => [
  o.directory, JSON.parse(readFileSync(join(o.directory,"run.json"),"utf8")),
]));
function command(program, args, cwd) {
  try { return { success: true, output: execFileSync(program, args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim() }; }
  catch (e) { return { success: false, output: String(e.stderr || e.stdout || e.message).slice(-1000) }; }
}
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
for (const obs of observations) {
  if (obs.status === "in-flight" || obs.status === "initializing" || !obs.directory) continue;
  const meta = runs.get(obs.directory);
  const {cwd, route} = meta;
  // A resumed case deliberately uses the same checkout. Today's files
  // cannot prove what an earlier, interrupted conversation produced.
  const successor = [...runs.entries()].find(([,m]) => m.root === meta.root && m.start > meta.start);
  if (successor) {
    results.push({route, arm:meta.arm, directory:obs.directory, status:obs.status, supersededWorkspace:successor[0]});
    continue;
  }
  const { result: run, evidenceError } = readLiveCompletion(obs.directory, meta);
  if (evidenceError) {
    results.push({ route, arm: meta.arm, directory: obs.directory, status: "evidence-mismatch", evidenceError });
    continue;
  }
  const firstConversation = run?.records.reduce((id, r) => Math.min(id, r.conversation), Infinity);
  const foreground = run?.records.filter(r => r.conversation === firstConversation).sort((a, b) => a.entry - b.entry) ?? [];
  const reply = foreground.filter(r => r.role === "assistant" && r.stop === "stop").at(-1)?.text ?? "";
  const git = (...args) => command("git", ["--no-optional-locks", "-C", cwd, ...args], cwd);
  const history = git("log", "--format=%h %s", "-n", "12").output;
  const head = git("rev-parse", "HEAD").output;
  const initial = git("rev-list", "--max-parents=0", "HEAD").output.split("\n")[0];
  const changed = git("diff", "--name-only", initial, "--").output;
  const files = git("ls-files", "-co", "--exclude-standard", "-z").output.split("\0").filter(Boolean);
  const conclusions = { route, arm: meta.arm, directory: obs.directory, status: obs.status,
    head, history, changed, files: files.slice(0, 150), goalChecks: {} };
  const checks = conclusions.goalChecks;
  if (["feature", "bug-fix", "autonomous-run", "refactoring", "hillclimb", "perf-issue", "session-pickup", "investigation"].includes(route)) {
    const probe = "const a=require('node:assert/strict'),f=require('./labels.cjs');a.deepEqual(f([' A','', ' A ', 'b','B']),['A','b','B']);a.deepEqual(f([]),[]);"
      + (route === "feature" ? "a.deepEqual(f([' a','b'],1),['a']);" : "");
    checks.fixtureContract = command(process.execPath, ["-e", probe], cwd);
  }
  if (route === "investigation") {
    checks.workspaceUntouched = changed === "" && !git("ls-files", "--others", "--exclude-standard").output;
    const approved = run?.workflow?.review?.passed && run.workflow.review.answerDraft;
    if (approved) {
      checks.reviewedAnswerSha256 = createHash("sha256").update(approved).digest("hex");
      checks.reviewedAnswerDelivered = reply.startsWith(approved);
    }
  }
  if (route === "session-pickup") {
    checks.handoffIntact = git("diff", "--quiet", initial, "--", "handoff.md").success;
    checks.referencedNextAction = /json|format\.md|input format/i.test(reply);
  }
  if (["perf-issue","hillclimb"].includes(route)) {
    const dir = mkdtempSync(join(tmpdir(),"mb-label-perf-"));
    const before = git("show", initial + ":labels.cjs");
    if (before.success) {
      writeFileSync(join(dir,"before.cjs"),before.output);
      writeFileSync(join(dir,"after.cjs"),readFileSync(join(cwd,"labels.cjs")));
      const probe = `const assert=require('node:assert/strict');
const versions=[require('./before.cjs'),require('./after.cjs')];
const data=Array.from({length:12000},(_,i)=>' t'+i%6000);
const expected=Array.from({length:6000},(_,i)=>'t'+i);const durations=[[],[]];
for(let i=0;i<8;i++)for(const k of i%2?[1,0]:[0,1]){
const t=performance.now(),out=versions[k](data),ms=performance.now()-t;
assert.deepEqual(out,expected);if(i)durations[k].push(ms)}
const med=durations.map(v=>[...v].sort((a,b)=>a-b)[3]);
console.log(JSON.stringify({samples:durations,medianMs:med,improvement:1-med[1]/med[0]}));`;
      const run = command(process.execPath,["-e",probe],dir);
      checks.repeatedPerformance = run.success ? JSON.parse(run.output) : run;
    }
  }
  if (route === "pause-safely") {
    checks.resumeNote = existsSync(join(cwd, "resume.md")) && !!readFileSync(join(cwd, "resume.md"), "utf8").trim();
    checks.wipCommit = /\bwip\b/i.test(history);
    checks.pendingEditPreserved = readFileSync(join(cwd, "format.md"), "utf8").trim() === "Accepts a newline-delimited list.";
  }
  if (route === "trace-forensics") {
    checks.originalCaptureIntact = git("diff", "--quiet", initial, "--", "capture.cpuprofile").success;
    const profile = JSON.parse(readFileSync(join(cwd, "capture.cpuprofile")));
    const bins = new Map();
    for (const id of profile.samples) bins.set(id, (bins.get(id) ?? 0) + 1);
    const hottest = [...bins].sort((a,b) => b[1] - a[1])[0];
    checks.primarySample = { frame: profile.nodes.find(n => n.id === hottest[0])?.callFrame, count: hottest[1], total: profile.samples.length };
  }
  if (route === "runtime-forensics") {
    checks.captures = files.filter(n => n.endsWith(".cpuprofile")).map(n => {
      const file = join(cwd,n), profile = JSON.parse(readFileSync(file));
      const bin = new Map();
      for (const id of profile.samples) bin.set(id, (bin.get(id) ?? 0) + 1);
      const frames = [...bin].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([id,samples])=>({
        frame:profile.nodes.find(node => node.id === id)?.callFrame.functionName, samples,
      }));
      return {file:n, sha256:digest(file), durationUs:profile.endTime-profile.startTime, frames};
    });
    checks.sourceIntact = git("diff", "--quiet", initial, "--", "hot.cjs").success;
  }
  if (route === "visual-parity") {
    checks.baselineAndRendererIntact = git("diff", "--quiet", initial, "--", "reference.svg", "render.cjs", "pixels.test.cjs").success;
    const out = mkdtempSync(join(tmpdir(), "mb-pixels-"));
    const ref = join(out, "reference.png"), target = join(out, "target.png");
    const render = f => command(process.execPath, ["render.cjs", f + ".svg", f === "reference" ? ref : target], cwd);
    const r = render("reference"), t = render("target");
    if (r.success && t.success) checks.pixelDifference = command("python", ["-c",
      "from PIL import Image, ImageChops; import sys; a,b=[Image.open(p).convert('RGB') for p in sys.argv[1:]]; assert a.size==b.size; n=sum(x!=(0,0,0) for x in ImageChops.difference(a,b).getdata()); print(a.size,n); sys.exit(n!=0)", ref, target], cwd);
    else checks.pixelDifference = { success: false, output: r.output + t.output };
  }
  if (route === "worktree-cleanup") {
    checks.cleanTreeRetained = existsSync(cwd + "-clean");
    checks.dirtyDraftPreserved = existsSync(join(cwd + "-dirty","pending.md")) && readFileSync(join(cwd + "-dirty","pending.md"), "utf8") === "Keep this draft.\n";
  }
  if (route === "authoring-a-skill") {
    const installed = join(meta.root, ".mybuddy/plugins/skills");
    const started = originalCaseStart(meta);
    checks.newDisabledSkills = existsSync(installed) ? readdirSync(installed).flatMap(n => {
      const status = join(installed, n, "_user_meta.json");
      if (!existsSync(status) || !existsSync(join(installed, n, "SKILL.md"))) return [];
      const m = JSON.parse(readFileSync(status, "utf8"));
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(join(installed, n, "SKILL.md"), "utf8"));
      return m.source === "authoring" && m.installedAt >= started && frontmatter && parseYaml(frontmatter[1])?.["disable-model-invocation"] === true ? [n] : [];
    }) : [];
  }
  if (route === "multi-phase-plan") checks.acceptedPath = obs.plan?.path && existsSync(join(cwd,obs.plan.path))
    && digest(join(cwd,obs.plan.path)) === obs.plan.digest ? obs.plan.path : null;
  if (route === "opening-a-pr") {
    const body = join(cwd,"pr.md");
    checks.prBody = existsSync(body) ? {lines:readFileSync(body,"utf8").trimEnd().split(/\r?\n/).length, sha256:digest(body)} : null;
    checks.remote = git("remote","-v").output;
    checks.publishedPr = run?.workflow?.publishedPr ?? null;
  }
  if (["autopilot-stack","autopilot-full","orchestrate","autonomous-run"].includes(route)) {
    const docs = route === "autopilot-full" ? ["blanks.md","duplicates.md"] : route === "orchestrate" ? ["contract.md","example.md"] : [];
    checks.requestedFiles = Object.fromEntries(docs.map(n => [n, files.includes(n) && digest(join(cwd,n))]));
    checks.ownerReports = run?.workflow?.delegates?.flatMap(d => d.ownerReports ?? []) ?? [];
    checks.trail = files.filter(n => n.endsWith(".tsv")).map(n => ({file:n, lines:readFileSync(join(cwd,n),"utf8").trimEnd().split(/\r?\n/).length}));
  }
  if (route === "prototype") {
    checks.submittedPrograms = files.filter(n => !["bench.cjs","hot.cjs","check.cjs","labels.cjs"].includes(n) && /\.(?:[cm]?js|py|ts)$/.test(n));
    checks.recommendedFormat = reply.match(/.{0,60}JSON.{0,90}/i)?.[0];
  }
  results.push(conclusions);
}
writeFileSync(join(batch, "artifact-checks.json"), JSON.stringify(results,null,2));
console.log("Independently inspected",results.length,"settled workspaces");
