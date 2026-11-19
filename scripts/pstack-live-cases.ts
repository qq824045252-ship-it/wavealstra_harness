import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Each goal is given to the foreground agent as a user request. The driver
// never issues stage advances, worker verdicts, or completion receipts.
export const cases: Record<string, string> = {
  "runtime-forensics": "Diagnose hot.cjs by collecting a live Node CPU profile. Use the repository's profile-summary.cjs on the actual capture and confirm the mechanism using the same program with a smaller input. Deliver the capture paths and a concise cited diagnosis in chat. Keep all source intact; only the captures need to be saved.",
  investigation: "Read-only: explain how labels.cjs normalizes blanks and removes duplicates. Give file and line evidence and a real example.",
  "trace-forensics": "Analyze capture.cpuprofile, a fixed capture of hot.cjs. Use the supplied profile-summary.cjs to count samples by frame, identify the hot frame and cite its source location. No paired capture exists. Return the diagnosis in chat and leave the capture and all source untouched.",
  "session-pickup": "Resume from handoff.md. Verify its claim against Git and the current check. Report the next action without reimplementing completed work.",
  "pause-safely": "Please pause safely now. Preserve the pending local edit in a local WIP commit and put an off-context resume note in resume.md.",
  feature: "Add an optional limit to the labels function. With limit 1, [' a','b'] must yield ['a']. Preserve existing calls and add a regression check.",
  "bug-fix": "The provided check fails on repeated trimmed labels. Reproduce it, fix the bug, and get the identical check green. 严格检查代码质量。",
  refactoring: "Characterize current case-sensitive behavior, then simplify the linear membership search in labels.cjs while preserving order and all outputs.",
  "perf-issue": "Measure bench.cjs before and after replacing the costly linear membership lookup in labels.cjs. Use identical inputs and confirm the checks stay green.",
  hillclimb: "Improve median elapsed time for bench.cjs by at least 30% on identical inputs without changing outputs. Log measured attempts and stop when the predicate is met.",
  prototype: "Use two runnable disposable CLI prototypes to decide between joining labels with a bare comma and serializing a JSON array. Feed both ['a,b','c'] and ['a','b,c'] to both programs and compare their output. Deliver only those two small CLI files and your recommendation in chat. The format decision needs no additional feature or report file.",
  "visual-parity": "Match target.svg to frozen reference.svg at 64x64. Run the supplied node --test pixels.test.cjs before and after the edit. It captures both actual browser renderings, decodes their pixels, and reports the number of differences. Change only target.svg, keep the baseline and complete comparison harness frozen, and report the measurements in chat.",
  eval: "Blindly compare two independent explanations of how to clean a list of team names. Keep judges and candidates independent, use the configured rubric size, and persist rubric.json and the anonymized outputs.",
  "authoring-a-skill": "Create a reusable local skill for triaging ambiguous team-label imports. Decide when to ask about aliases versus preserving distinct teams, cite which source row supports the choice, and prepare a handoff for the data steward. Exercise both 'Core / Core Team (confirmed alias)' and 'North / North (two owners)'. The named deliverable is a disabled local MyBuddy skill in this disposable profile. Use the authoring tools to assess existing skills, then reuse one if suitable or create it; local creation including force_create is authorized. Verify discovery and both cases.",
  "multi-phase-plan": "Design a three-step migration from newline input to JSON arrays, preserving compatibility. Provide a runnable prototype, a validated handoff plan at the location in settings if present, and evidence for each work item. Do not implement the migration.",
  "worktree-cleanup": "Inventory only the worktrees belonging to this disposable repository. Keep the dirty sibling with its uncommitted note and report which clean merged worktree can be removed. Do not actually delete either.",
  "autonomous-run": "Work autonomously until labels.cjs handles duplicate trimmed strings and node --test check.cjs exits zero. Keep a decision trail. Finish in this session without a background schedule.",
  "opening-a-pr": "Prepare the local change as a PR and write its body in pr.md. This fixture has no writable remote and no authorization to publish. Verify local commits and report the exact boundary before publication.",
  babysit: "Read-only: inspect qq824045252-ship-it/wavealstra_harness PR 23 as a one-shot snapshot. Determine whether anything remains for this PR. Do not post or change anything on the forge.",
  shipping: "Check the shipping frontier for qq824045252-ship-it/wavealstra_harness PR 23. Read-only access only. Report its actual state; do not post verdicts or change anything on the forge.",
  "autopilot-full": "Coordinate two independent local changes: document input blanks in blanks.md and duplicate handling in duplicates.md. Verify work by each owner. The fixture has no writable remote; stop at the first necessary remote write.",
  "autopilot-stack": "Prepare a two-layer stack locally: first the stable unique-label contract, then a CLI consuming it. Verify owner results. The fixture has no writable remote; identify the first external dependency.",
  orchestrate: "Coordinate two local units, first documenting the labels contract in contract.md and then a dependent example in example.md. Register units, use real workers, verify each artifact and drain the board. No external publication.",
};

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe", encoding: "utf8", windowsHide: true });
}
function writeFixture(id: string, cwd: string, fixedTrace?: string) {
  const put = (file: string, value: string) => writeFileSync(join(cwd, file), value + "\n");
  const buggy = ["bug-fix", "autonomous-run"].includes(id);
  put("labels.cjs", `module.exports = function labels(values) {
  const result = [];
  for (const value of values) {
    const label = value.trim();
    if (label && !result.includes(${buggy ? "value" : "label"})) result.push(label);
  }
  return result;
};`);
  put("check.cjs", "const assert=require('node:assert/strict');const labels=require('./labels.cjs');assert.deepEqual(labels([' A','', ' A ', 'b','B']),['A','b','B']);assert.deepEqual(labels([]),[]);");
  put("bench.cjs", "const labels=require('./labels.cjs');const data=Array.from({length:12000},(_,i)=>' t'+(i%6000));const samples=Number(process.argv[2]||5);if(!Number.isSafeInteger(samples)||samples<1)throw Error('positive sample count required');const times=[];for(let i=0;i<samples;i++){const t=performance.now();if(labels(data).length!==6000)throw Error('wrong output');times.push(performance.now()-t)}const sorted=[...times].sort((a,b)=>a-b);console.log(JSON.stringify({medianMs:(sorted[Math.floor((samples-1)/2)]+sorted[Math.floor(samples/2)])/2,times}));");
  put("hot.cjs", "function fold(limit){let total=0;for(let k=0;k<limit;k++) total+=Math.sqrt(k%111);return total;}\nconsole.log(fold(Number(process.argv[2]||80000000)));");
  if (["runtime-forensics","trace-forensics"].includes(id)) put("profile-summary.cjs", `const fs = require('node:fs');
const profile = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const counts = new Map();
for (const id of profile.samples) counts.set(id, (counts.get(id)||0)+1);
const frames = [...counts].sort((a,b)=>b[1]-a[1]).slice(0,8).map(([id, samples]) => {
  const {functionName,url,lineNumber} = profile.nodes.find(node=>node.id===id).callFrame;
  return {functionName,url,line:lineNumber+1,samples};
});
console.log(JSON.stringify({durationMicroseconds:profile.endTime-profile.startTime,totalSamples:profile.samples.length,frames}));
`);
  put("handoff.md", "The previous worker finished preserving case and blank filtering in labels.cjs. Verified with node --test check.cjs. The next task is documenting the JSON input format. No documentation was written.");
  if (id === "trace-forensics") {
    if (fixedTrace) copyFileSync(fixedTrace, join(cwd,"capture.cpuprofile"));
    else execFileSync(process.execPath, ["--cpu-prof", "--cpu-prof-name=capture.cpuprofile", "hot.cjs"], { cwd, windowsHide: true });
  }
  if (id === "visual-parity") {
    put("reference.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3166b2"/></svg>');
    put("target.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#3167b2"/></svg>');
    const electron = createRequire(import.meta.url)("electron");
    put("render.cjs", `const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
if(!process.versions.electron){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  require('node:child_process').execFileSync(${JSON.stringify(electron)},[__filename,...process.argv.slice(2)],{env,windowsHide:true,timeout:30000,stdio:'inherit'});
}else{
  const {app,BrowserWindow}=require('electron');
  app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'label-electron-')));
  app.disableHardwareAcceleration();app.commandLine.appendSwitch('force-device-scale-factor','1');
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:64,height:64,useContentSize:true,frame:false,show:false,webPreferences:{offscreen:true,backgroundThrottling:false}});
    const html='<style>html,body{padding:0;margin:0}svg{display:block}</style>'+fs.readFileSync(process.argv[2],'utf8');
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    await win.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const image=await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});
    if(image.isEmpty()||image.getSize().width!==64||image.getSize().height!==64)throw Error('Expected a 64x64 browser capture');
    fs.writeFileSync(process.argv[3],image.toPNG());app.exit(0);
  }).catch(error=>{console.error(error);app.exit(1)});
}`);
    put("pixels.test.cjs", `const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'label-captures-'));
const files=['reference','target'].map(name=>{const png=path.join(out,name+'.png');execFileSync(process.execPath,['render.cjs',name+'.svg',png],{windowsHide:true});return png;});
const compare="from PIL import Image,ImageChops; import sys; a,b=[Image.open(f).convert('RGB') for f in sys.argv[1:]]; assert a.size==b.size==(64,64); print(sum(rgb!=(0,0,0) for rgb in ImageChops.difference(a,b).getdata()))";
const count=Number(execFileSync('python',['-c',compare,...files],{encoding:'utf8'}));console.log(JSON.stringify({files,differentPixels:count}));assert.equal(count,0);
`);
  }
}

export function seedCase(id: string, cwd: string, fixedTrace?: string, matchCwd?: string) {
  if (matchCwd) {
    const initial = git(matchCwd, "rev-list", "--first-parent", "--max-parents=0", "HEAD").trim();
    if (!/^[a-f0-9]{40,64}$/.test(initial)) throw Error("Expected one recorded fixture root commit.");
    for (const entry of git(matchCwd, "ls-tree", "-rz", initial).split("\0").filter(Boolean)) {
      const match = /^100644 blob ([0-9a-f]{40,64})\t([\w.-]+)$/.exec(entry);
      if (!match) throw Error("Expected a regular top-level fixture file.");
      const [,blob,file] = match;
      if (file === ".mybuddy-task.json") continue;
      if (file.startsWith(".")) throw Error("Unexpected hidden file in the initial fixture.");
      writeFileSync(join(cwd,file), execFileSync("git", ["-C",matchCwd,"cat-file","blob",blob], {windowsHide:true}));
    }
  } else writeFixture(id, cwd, fixedTrace);
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "Initial fixture");
  if (id === "worktree-cleanup") {
    git(cwd, "worktree", "add", "-qb", "finished", cwd + "-clean");
    git(cwd, "worktree", "add", "-qb", "in-use", cwd + "-dirty");
    writeFileSync(join(cwd + "-dirty", "pending.md"), "Keep this draft.\n");
  }
  if (["pause-safely", "opening-a-pr"].includes(id)) writeFileSync(join(cwd,"format.md"), "Accepts a newline-delimited list.\n");
}
