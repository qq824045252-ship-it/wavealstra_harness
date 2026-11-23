import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { admitLiveCase, limitLiveRequests } from "./pstack-live-admission.mjs";
import { originalCaseStart, readLiveCompletion } from "./pstack-live-lineage.mjs";

function evaluateManualResult(final: string) {
  const fenced = [...final.matchAll(/\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}/gi)];
  const body = (fenced.length === 1 && !final.slice(fenced[0].index! + fenced[0][0].length).trim()) ? fenced[0][1] : final.trim();
  const result = JSON.parse(body) as {groups:string[][];handoff:string};
  assert.deepEqual(result.groups.map(rows=>rows.slice().sort().join(",")).sort(),["R104,R205","R309","R427"]);
  assert(result.handoff.includes("R820"), "The alias decision needs the authoritative registry row.");
  assert(/R309|R427|\bN1\b|\bN8\b/.test(result.handoff), "The steward handoff must identify the separately owned North records.");
  return result;
}

// Exercise a deliberately disabled package by explicitly reading it. Leave
// the installed flag alone and use a fresh foreground conversation.
export async function verifyAuthoredSkill(caseDirectory: string, variant?: string) {
  assert(!variant || variant === "team-ids");
  const destination = resolve(caseDirectory), realProfile = join(homedir(), ".mybuddy"), shared = tmpdir();
  const load = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const meta = load(join(destination, "run.json"));
  const { result: evidence, evidenceError } = readLiveCompletion(destination, meta);
  assert(evidence, evidenceError ?? "The authoring run has no terminal evidence.");
  const started = originalCaseStart(meta);
  assert(meta.route === "authoring-a-skill" && ["native","original"].includes(meta.arm) && meta.root === realpathSync(meta.root));
  assert.equal(dirname(meta.root), realpathSync(shared));
  assert(basename(meta.root).startsWith("mb-workflow-"));
  const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks","-C",meta.cwd,...args], {encoding:"utf8",windowsHide:true}).trim();
  const evidencePath = join(destination, variant ? "skill-readback-team-ids.json" : "skill-readback.json");
  const previous = existsSync(evidencePath) && load(evidencePath);
  const writeEvidence = (data: unknown) => writeFileSync(evidencePath, JSON.stringify(data, null, 2));
  const profile = join(meta.root, ".mybuddy"), beforeWork = git("status","--porcelain");
  const initialCommit = git("rev-list","--max-parents=0","HEAD").split("\n")[0];
  const workspace = { initialCommit, head:git("rev-parse","HEAD"), trackedChanges:git("diff","--name-status",initialCommit,"--"),
    untracked:git("ls-files","--others","--exclude-standard") };
  const saved = load(join(realProfile,"settings.json"));
  if (!previous?.final) await admitLiveCase(meta.modelId !== saved.defaultProvider + "/" + saved.defaultModel);
  process.env.HOME = process.env.USERPROFILE = meta.root;
  process.env.PI_CODING_AGENT_DIR = profile;
  for (const [key, subdir] of Object.entries({ TEMP: "tmp", TMP: "tmp", TMPDIR: "tmp", APPDATA: "AppData/Roaming", LOCALAPPDATA: "AppData/Local", XDG_CONFIG_HOME: ".config" }))
    process.env[key] = join(meta.root,subdir);
  const { SkillsService } = await import("../src/main/skills/SkillsService");
  const service = new SkillsService();
  const authored = service.listInstalled(meta.cwd).filter(s => {
    const marker = s.filePath && join(dirname(s.filePath),"_user_meta.json");
    if (!marker || !existsSync(marker)) return false;
    const installed = load(marker);
    return installed.source === "authoring" && installed.installedAt >= started;
  });
  const listed = authored.map(s => ({ id: s.id, description: s.description, file: s.filePath, enabled: s.enabled }));
  const createRecords = evidence.records.filter((r: {tool?: string; failed?: boolean}) => r.tool === "skill_authoring_create" && !r.failed);
  const base = { arm: meta.arm, caseDirectory:destination, root:meta.root, model:meta.modelId, initialSource:meta.sourceHash,
    discovery:listed, initialWorkspaceStatus:beforeWork, workspace, authorCalls:createRecords.map((r:{entry:number})=>r.entry) };
  if (!previous?.final) writeEvidence(base);
  assert.equal(authored.length, 1, "Expected one new skill installed by the authoring service in this isolated profile.");
  const skill = authored[0], file = realpathSync(skill.filePath!);
  assert(!relative(join(profile,"plugins","skills"),file).startsWith("..") && relative(meta.cwd,file).startsWith(".."));
  assert.equal(skill.enabled,false);
  const { SkillAuthoringService } = await import("../src/main/skills/SkillAuthoringService");
  const validation = new SkillAuthoringService().validateSkillPackage(dirname(file));
  assert(validation.valid, JSON.stringify(validation));
  const runtimeIds = () => service.resolveRuntimeSkills(meta.cwd).dtos.map(s=>s.id);
  assert(!runtimeIds().includes(skill.id), "Disabled skill leaked into automatic runtime selection");
  const authoredHash = hash(file);
  if (previous?.final) {
    assert(previous.file === file && previous.sha256 === authoredHash && previous.answeredBy === meta.modelId && !previous.timedOut && previous.unchanged);
    assert(previous.manualReadReceipts.some((r:{file:string})=>r.file===file));
    writeEvidence({...previous, validation, result:evaluateManualResult(previous.final), activeAfter:false, recheckedSavedAnswer:true});
    console.log("PASS rechecked the persisted real manual exercise and current disabled status",skill.id);
    return;
  }
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { AgentService } = await import("../src/main/agent/AgentService");
  const { AppDatabase } = await import("../src/main/db/AppDatabase");
  const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
  const { openDurablePassiveStorage } = await import("../src/main/agent/durable/DurableStorage");
  const { BACKGROUND_CONTEXT: ctx } = await import("@earendil-works/chord/context");
  const models = await ModelRuntime.create({ authPath:join(realProfile,"auth.json"),modelsPath:join(realProfile,"models.json"),refreshOnCreate:false,allowModelNetwork:false });
  limitLiveRequests(models,shared);
  const db = new AppDatabase(join(meta.root,"app.db")), workspaces = new TaskExecutionWorkspace(join(meta.root,"workspace"));
  const app = new AgentService(db, workspaces, { models });
  const taskId = "skill-exercise-" + randomUUID(), cwd = workspaces.ensureTaskExecutionWorkspace(taskId);
  const request = [
    "Read this particular installed SKILL.md using the native read tool: " + file,
    "This is a manual read-only exercise. Keep the skill disabled and use only the supplied data. Do not edit files.",
    "Four rows from a steward's export follow. Row R104: Core, owner Sofia, authoritative teamId C2. Row R205: Core Team, owner Sofia, authoritative teamId C2; steward registry row R820 confirms this as a historical name for C2.",
    "Row R309: North, owner Rui, authoritative teamId N1. Row R427: North, owner Inez, authoritative teamId N8. The registry lists the two IDs independently.",
    variant === "team-ids"
      ? 'Return one bare JSON object with groups and handoff. Each array in groups contains the source row IDs belonging to one distinct team identity after the exercise. A pair examined together can therefore occupy two separate arrays. The handoff is a short text explaining the decisions with source and registry row IDs. Omit any text outside the object.'
      : "Use the skill to group the four source rows by team and give a short data-steward handoff citing the relevant row IDs. Return one JSON object with groups (array of arrays of row IDs) and handoff (text).",
  ].join("\n");
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; void app.abort(taskId); }, 6 * 60_000);
  try {
    await app.init();
    const mode = { welcomeMode:"coding" as const, modePresetId:"minimal" };
    db.upsertTask({ id:taskId,title:"Exercise team triage",cwd,modelId:meta.modelId,...mode,updatedAt:Date.now() });
    await app.prompt({taskId,modelId:meta.modelId,...mode,text:request,userMessageId:randomUUID(),assistantMessageId:randomUUID()},{durableAdmissionOnly:false});
  } finally { clearTimeout(timeout); await app.closeDurableBots(); app.dispose(); db.close(); }
  const store = await openDurablePassiveStorage(join(profile,"durable",createHash("sha256").update(taskId).digest("hex")),ctx);
  assert(store);
  let final = "", answeredBy = "";
  const reads: {entry:number;file:string}[] = [];
  try {
    const chat = (await store.scanConversations({},20,undefined,ctx)).items.find(c=>!c.owner)!;
    const calls = new Map<string,string>();
    let cursor;
    do {
      const page = await store.scanEntries({conversationId:chat.id,order:"ascending"},100,cursor,ctx);
      for (const r of page.items) for (const m of r.model ?? []) {
        if (m.role === "assistant") {
          for (const c of m.content) if (c.type === "toolCall" && c.name === "read" && typeof c.arguments.path === "string") calls.set(c.id, resolve(cwd,c.arguments.path));
          if (m.stopReason === "stop") { final=m.content.flatMap(c=>c.type==="text"?[c.text]:[]).join("\n"); answeredBy=m.provider+"/"+m.model; }
        } else if (m.role==="toolResult" && m.toolName==="read" && !m.isError && calls.has(m.toolCallId)) reads.push({entry:r.id,file:calls.get(m.toolCallId)!});
      }
      cursor=page.next;
    } while(cursor);
  } finally { await store.close(ctx); }
  const unchanged = beforeWork === git("status","--porcelain") && hash(file)===authoredHash;
  const activeAfter = runtimeIds().includes(skill.id);
  const exercise = {...base, taskId, cwd, request, file, sha256:authoredHash, validation, manualReadReceipts:reads,timedOut,answeredBy,final,unchanged,activeAfter};
  writeEvidence(exercise);
  assert.equal(timedOut,false); assert.equal(answeredBy,meta.modelId);
  assert(reads.some(r=>r.file===file)); assert(unchanged); assert.equal(activeAfter,false);
  writeEvidence({...exercise,result:evaluateManualResult(final)});
  console.log("PASS disabled local skill discovered, absent from runtime selection, read manually, both groups verified",skill.id);
}
