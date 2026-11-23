import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { cases, seedCase } from "./pstack-live-cases";
import { admitLiveCase, limitLiveRequests } from "./pstack-live-admission.mjs";
import { restrictLivePaths } from "./pstack-live-scope";
import { readLiveCompletion } from "./pstack-live-lineage.mjs";

const [route, arm, destination, ...extra] = process.argv.slice(2);
const previousRun = extra[0] && !extra[0].startsWith("--") ? extra.shift() : undefined;
if (extra.length && (extra.length !== 2 || extra[0] !== "--match-run")) throw Error("Use [previous run directory] [--match-run reference directory].");
const sibling = destination && join(destination, "native-" + route);
const referencePath = extra[1] ?? (!previousRun && arm === "control" && sibling && existsSync(join(sibling,"run.json")) ? sibling : undefined);
if (route === "authoring-readback") {
  const { verifyAuthoredSkill } = await import("./pstack-live-authoring-evidence");
  await verifyAuthoredSkill(arm, destination);
  process.exit(0);
}
if (!Object.hasOwn(cases, route) || !["native", "original", "control"].includes(arm) || !destination)
  throw Error("Supply a playbook, native/original/control, and an evidence directory.");
const output = resolve(destination, arm + "-" + route);
const profile = join(homedir(), ".mybuddy");
const sharedTemp = tmpdir();
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const saved = json(join(profile, "settings.json"));
const previous = previousRun && json(join(previousRun, "run.json"));
const defaultModel = saved.defaultProvider + "/" + saved.defaultModel;
const modelId = process.env.PSTACK_LIVE_MODEL || previous?.modelId || defaultModel;
const replacementFile = process.env.PSTACK_LIVE_ROLE_PROFILE;
const replacement: Record<string,string[]> | undefined = replacementFile ? json(replacementFile) : undefined;
if (replacement && (!["fast","strong","diverse"].every(k=>Array.isArray(replacement[k]) && replacement[k].length) ||
    Object.values(replacement).flat().some(id=>!saved.enabledModels?.includes(id)))) throw Error("Replacement roles must use enabled MyBuddy model IDs.");
if (modelId !== defaultModel && !saved.enabledModels?.includes(modelId) && !json(join(profile, "subagent.json")).allowedModels?.includes(modelId))
  throw Error("The selected live model must belong to MyBuddy's actual configured candidate list.");
if (existsSync(output)) throw Error("Evidence directory already exists: " + output);
if (previous && (previous.route !== route || previous.arm !== arm || dirname(previous.root) !== tmpdir() ||
  !basename(previous.root).startsWith("mb-workflow-") || !(readLiveCompletion(previousRun!, previous).result || existsSync(join(previousRun!, "interrupted.json")))))
  throw Error("Only a settled, matching acceptance case in its isolated profile can resume.");
mkdirSync(output, { recursive: false });
writeFileSync(join(output,"queue.json"),JSON.stringify({route,arm,modelId,pid:process.pid,queued:new Date().toISOString()}));
await admitLiveCase(modelId !== defaultModel, arm === "original");
const source = join(profile, "plugins", "skills", "poteto-mode", "playbooks", route + ".md");
const original = readFileSync(source, "utf8");
const sourceHash = createHash("sha256").update(original).digest("hex");
if (previous && previous.sourceHash !== sourceHash) throw Error("The installed original has changed since this comparison started.");
const reference = referencePath ? json(join(referencePath,"run.json")) : undefined;
if (reference && (reference.route !== route || reference.sourceHash !== sourceHash || typeof reference.request !== "string" ||
    dirname(reference.root) !== sharedTemp || !basename(reference.root).startsWith("mb-workflow-") ||
    !resolve(reference.cwd).startsWith(resolve(reference.root,"workspace") + sep))) {
  throw Error("The comparison must use the same installed playbook and a recorded disposable task workspace.");
}
const root = previous?.root ?? mkdtempSync(join(tmpdir(), "mb-workflow-"));
const config = join(root, ".mybuddy");
mkdirSync(config, { recursive: true });
const jsonFile = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2));
// Isolate all writable application data. The actual model registry stays at
// its configured location, and credentials never enter the evidence directory.
if (["babysit", "shipping", "opening-a-pr", "worktree-cleanup"].includes(route) && !process.env.GH_CONFIG_DIR) {
  const ghConfig = process.env.APPDATA ? join(process.env.APPDATA, "GitHub CLI") : join(homedir(), ".config", "gh");
  if (existsSync(ghConfig)) process.env.GH_CONFIG_DIR = ghConfig;
}
for (const [variable, folder] of Object.entries({ TMP: "tmp", TEMP: "tmp", TMPDIR: "tmp", XDG_CONFIG_HOME: ".config",
  APPDATA: "AppData/Roaming", LOCALAPPDATA: "AppData/Local" })) {
  const path = join(root, folder);
  mkdirSync(path, { recursive: true });
  process.env[variable] = path;
}
process.env.HOME = process.env.USERPROFILE = root;
if (process.env.HOMEDRIVE) process.env.HOMEPATH = root.slice(process.env.HOMEDRIVE.length);
process.env.PI_CODING_AGENT_DIR = config;
jsonFile(join(config, "settings.json"), { defaultProvider: saved.defaultProvider, defaultModel: saved.defaultModel,
  enabledModels: saved.enabledModels, disabledModelIds: saved.disabledModelIds, modelThinkingLevels: saved.modelThinkingLevels,
  defaultThinkingLevel: saved.defaultThinkingLevel, permissionMode: "auto", memoryEnabled: false });
if (!previous) copyFileSync(join(profile, "subagent.json"), join(config, "subagent.json"));
if (replacement) {
  const roleFile = join(config,"subagent.json"), current = json(roleFile);
  jsonFile(roleFile,{...current,allowedModels:[...new Set(Object.values(replacement).flat())],roles:{...current.roles,...replacement}});
}
const roleDefinitions: Record<string,string> = {};
for (const directory of ["plugins/agents","agents"]) {
  const installed = join(previous && previous.roleDefinitions ? config : profile,directory);
  if (!existsSync(installed)) continue;
  mkdirSync(join(config,directory), {recursive:true});
  for (const name of readdirSync(installed).filter(n => n.endsWith(".md"))) {
    const bytes = readFileSync(join(installed,name));
    roleDefinitions[directory+"/"+name] = createHash("sha256").update(bytes).digest("hex");
    if (installed !== join(config,directory)) writeFileSync(join(config,directory,name),bytes);
  }
}
const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
const { AgentService } = await import("../src/main/agent/AgentService");
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { TerminalHost } = await import("../src/main/terminal/TerminalHost");
const { TaskTerminalService } = await import("../src/main/terminal/TaskTerminalService");
const { CronService } = await import("../src/main/cron/CronService");
const { normalizePstackSettings } = await import("../src/shared/pstack");
const { openDurablePassiveStorage } = await import("../src/main/agent/durable/DurableStorage");
const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
const db = new AppDatabase(join(root, "app.db"));
const ws = new TaskExecutionWorkspace(join(root, "workspace"));
const taskId = "work-item";
const cwd = ws.ensureTaskExecutionWorkspace(taskId);
if (!previous) seedCase(route, cwd, process.env.PSTACK_LIVE_TRACE, reference?.cwd);
const models = await ModelRuntime.create({ authPath: join(profile, "auth.json"), modelsPath: join(profile, "models.json"),
  refreshOnCreate: false, allowModelNetwork: false });
limitLiveRequests(models, sharedTemp);
const agent = new AgentService(db, ws, { models });
restrictLivePaths(agent,root,cwd,dirname(profile));
const terminalHost = new TerminalHost({ resolveCwd: () => cwd });
const cron = new CronService(db, agent);
agent.setLocalWorkflowServices({ cron, terminal: new TaskTerminalService(terminalHost) });
let error = "";
const settings = normalizePstackSettings(existsSync(join(profile, "modes/coding/policy.json"))
  ? json(join(profile, "modes/coding/policy.json")).pstackThermos : undefined);
const controls: Record<string, unknown> = {};
if (arm !== "original") {
  // A/B controls change one setting with the same user request and fixture.
  if (route === "investigation") settings.thermos.onRequest = arm !== "control";
  if (route === "prototype") settings.thermos.changedLines = arm === "control" ? 200 : 0;
  if (route === "multi-phase-plan") settings.playbooks[route].parameters.planPath = arm === "control" ? "handoff/plan.md" : "rollout.md";
  if (route === "eval") settings.playbooks[route].parameters.rubricCount = arm === "control" ? 3 : 5;
  if (route === "perf-issue") settings.skills["benchmark-checklist"].parameters.samplesPerVariant = arm === "control" ? 7 : 3;
  if (["autopilot-full", "autopilot-stack"].includes(route) && arm === "control") {
    settings.playbooks[route].parameters.firstReportMinutes = 1;
    settings.playbooks[route].parameters.auditMinutes = 1;
  }
  if (["babysit","shipping"].includes(route)) settings.playbooks[route].parameters.statusOnly = true;
  if (route === "babysit") settings.playbooks[route].parameters.pretty = arm !== "control";
  Object.assign(controls, { thermos: settings.thermos, route: settings.playbooks[route].parameters,
    ...(route === "perf-issue" && { samplesPerVariant: settings.skills["benchmark-checklist"].parameters.samplesPerVariant }) });
}
const request = previous?.request ?? (reference && reference.request) ?? (cases[route] + (route === "investigation" ? " 请独立审查结论。" : ""));
function originalPreset() {
  const presetFile = process.env.PSTACK_LIVE_ORIGINAL_PRESET;
  if (presetFile) return json(presetFile);
  for (const directory of [config, profile]) {
    const policyFile = join(directory, "modes/coding/policy.json");
    const tag = existsSync(policyFile) && json(policyFile).presets?.find(p => p.id === "pstack-thermos");
    if (tag) return tag;
  }
  const backups = join(profile, "backups");
  for (const folder of (existsSync(backups) ? readdirSync(backups) : []).filter(name => name.startsWith("coding-tags-")).sort().reverse()) {
    const file = join(backups, folder, "original-preset.json");
    if (existsSync(file) && json(file).id === "pstack-thermos") return json(file);
  }
  throw Error("Set PSTACK_LIVE_ORIGINAL_PRESET to the saved original tag JSON.");
}
const personal = arm === "original" ? originalPreset() : undefined;
if (arm === "original" && !previous) {
  const skills = join(config, "plugins", "skills");
  mkdirSync(skills, {recursive:true});
  for (const id of personal.skillPolicy.allow) {
    const from = join(profile, "plugins", "skills", id);
    if (existsSync(from)) cpSync(from, join(skills, id), { recursive: true, dereference: true,
      filter: file => !/[\\/]\.git(?:[\\/]|$)|\.bak(?:-|$)/i.test(file) });
  }
  mkdirSync(join(root, ".agents"));
  symlinkSync(skills, join(root, ".agents", "skills"), "junction");
  const rolesDoc = join(profile, "..", ".agents", "pstack-models.md");
  if (existsSync(rolesDoc)) copyFileSync(rolesDoc, join(root, ".agents", "pstack-models.md"));
}
const instructions = arm === "original" ? "Open the installed original playbook at " +
  join(config, "plugins", "skills", "poteto-mode", "playbooks", route + ".md") + " and follow it using the selected original preset."
  : "Use the selected built-in " + route + " playbook, including its configured workers and completion gates.";
const text = (replacement ? "The operator has replaced unavailable models in this isolated MyBuddy task. Current role pools: " + JSON.stringify(replacement) + ". Earlier quota failures describe the old pool. Resume and actually dispatch the pending configured role on this input before judging its availability. For a stage reviewer use pstack_delegate(purpose=stage, role=the required role); use purpose=thermos when the Thermos gate is due. Preserve completed artifacts and the required reviewer count. Report the result concisely.\n" : "") +
  (previous ? "Continue the same interrupted task using its existing receipts and files. Read the current stage and finish; retain verified work.\n" : "") +
  request + "\n" + instructions + "\nDisposable task directory: " + cwd + ". Isolated MyBuddy profile: " + config +
  ". Use these paths only. For a local skill use the registered authoring tools in this profile. Only create the requested artifacts. Put explanations in the reply. Local commits are authorized. No remote writes, uploads, external comments or publication. Only read the named PR where relevant. If external publication is the remaining prerequisite, record the block. Work with real tools and report concise evidence.";
const initial = { attemptId: randomUUID(), route, arm, cwd, root, sourceHash, roleDefinitions, modelId, configuredDefault:defaultModel, request, controls, previousRun, matchedRun: referencePath,
  ...(route === "trace-forensics" && {captureSha256:createHash("sha256").update(readFileSync(join(cwd,"capture.cpuprofile"))).digest("hex")}),
  referenceMode: arm === "original" ? "installed-preset-file-read" : "compiled-tools",
  sharedTmpGuard: true, replacementRoles: replacement,
  applicationBundleSha256: createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"),
  start: new Date().toISOString() };
jsonFile(join(output, "run.json"), initial);
const directory = join(config, "durable", createHash("sha256").update(taskId).digest("hex"));
let expired = false;
let operatorRequired: string | undefined;
const startedAt = Date.now();
const watchdog = setInterval(() => {
  const interaction = agent.getConversationRuntimeSnapshot(taskId).interactions.find(item => item.status === "pending");
  if (interaction && !operatorRequired) {
    operatorRequired = JSON.stringify({ title: interaction.title, description: interaction.description,
      options: interaction.options.map(o => ({ id: o.id, label: o.label })) });
    void agent.abort(taskId);
    return;
  }
  const lastProgress = ["durable.sqlite", "durable.sqlite-wal"].reduce((latest, file) => {
    const stat = statSync(join(directory, file), { throwIfNoEntry: false });
    return Math.max(latest, stat?.mtimeMs ?? 0);
  }, startedAt);
  if (!expired && Date.now() - lastProgress > 12 * 60_000) {
    expired = true;
    void agent.abort(taskId);
  }
}, 30_000);
try {
  await agent.init();
  const coding = agent.getModeProfile("coding").policy;
  agent.saveModePolicy("coding", { ...coding, ...(arm === "original" && { presets: [...(coding.presets ?? []).filter(p=>p.id!==personal.id), personal] }),
    pstackThermosEnabled: arm !== "original", pstackThermos: settings });
  const selected = { welcomeMode: "coding" as const, modePresetId: arm === "original" ? personal.id : null };
  if (!previous) db.upsertTask({ id: taskId, title: route, modelId, cwd, ...selected, updatedAt: Date.now() });
  await agent.prompt({ taskId, modelId, ...selected, text, userMessageId: randomUUID(), assistantMessageId: randomUUID() }, { durableAdmissionOnly: false });
} catch (e) { error = e instanceof Error ? e.message : String(e); }
finally {
  clearInterval(watchdog);
  await agent.closeDurableBots();
  cron.stop(); agent.dispose(); terminalHost.dispose(); db.close();
}
const store = await openDurablePassiveStorage(directory, context);
const records: { conversation: number; entry: number; role: string; calls: unknown[]; text: string;
  callId?: string; model?: string; provider?: string; tool?: string; error?: string; failed?: boolean; stop?: string }[] = [];
let workflow;
if (store) {
  try {
    const conversations = await store.scanConversations({}, 500, undefined, context);
    for (const conversation of conversations.items) {
      const doc = await store.findDocument({ kind: "mybuddy.pstack-run", scope: { kind: "conversation", conversationId: conversation.id } }, "current", context);
      if (doc) {
        const data = await store.document(doc.id, "current", context);
        if (data?.value?.run) workflow = data.value.run;
      }
      let cursor;
      do {
        const page = await store.scanEntries({ conversationId: conversation.id, order: "ascending" }, 100, cursor, context);
        for (const entry of page.items) for (const message of entry.model ?? []) {
          if (message.role === "user") continue;
          const parts = Array.isArray(message.content) ? message.content : [];
          const extract = parts.flatMap(p => p.type === "text" ? [p.text] : []);
          records.push({ conversation: conversation.id, entry: entry.id, role: message.role,
            ...(message.role === "assistant" && { model: message.model, provider: message.provider, error: message.errorMessage, stop: message.stopReason }),
            ...(message.role === "toolResult" && { tool: message.toolName, callId: message.toolCallId, failed: message.isError }),
            calls: parts.filter(p => p.type === "toolCall").map(p => ({ id: p.id, name: p.name, args: p.arguments })),
            text: extract.join("\n").slice(0, 18000) });
        }
        cursor = page.next;
      } while (cursor);
    }
  } finally { await store.close(context); }
}
if (workflow) delete workflow.config;
const completionFile = join(output, "evidence.json");
jsonFile(completionFile + ".tmp", { ...initial, end: new Date().toISOString(), expired, operatorRequired, error, workflow, records });
renameSync(completionFile + ".tmp", completionFile);
console.log(route, arm, workflow?.phase, "messages", records.length, error);
const rootConversation = records.reduce((min,r) => Math.min(min,r.conversation),Infinity);
const lastRootReply = records.filter(r => r.conversation === rootConversation && r.role === "assistant").sort((a,b) => a.entry-b.entry).at(-1);
process.exitCode = error || expired || operatorRequired || lastRootReply?.stop !== "stop" ||
  (arm !== "original" && workflow?.phase !== "complete") ? 1 : 0;
