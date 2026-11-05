/**
 * Runtime Skill Policy 硬门禁回归测试（P1-A / P1-B）。
 *
 * 验证不变量：SDK ResourceLoader 最终加载的技能集合 === RuntimePolicy 最终允许的技能集合。
 *
 * 用真实 AgentService.createSession 装配链（Mode → Project → Tag → Expert/Connector 候选
 * → skillPolicy → Final Allowed Set），在 SDK 边界拦截 createAgentSession，直接读取
 * DefaultResourceLoader.getSkills()（AgentSession/system prompt 的唯一技能来源），断言：
 *
 * [1] Global Skill 允许 → loader 包含
 * [2] Global Skill 被 Tag 拒绝 → loader 不存在（且 SDK 技能 XML 不含）
 * [3] Expert Private Skill 允许 → loader 包含
 * [4] Expert Private Skill 被拒绝 → loader 不存在（Expert 不拥有权限）
 * [5] Connector Private Skill 允许 → loader 包含
 * [6] Connector Private Skill 被拒绝 → loader 不存在（Connector 不拥有权限）
 * [7] Expert 无法越权：附带 X+Y，Tag 只允许 X → loader = [X]
 * [8] 切 Tag 后 runtime fingerprint 变化 → 旧 session 释放重建 → 新 loader 只含新允许集
 *
 * 以及 matcher 收敛（P3）纯函数语义回归。
 *
 * 运行：pnpm test:runtime-skill-loader
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatSkillsForPrompt,
  ModelRuntime,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "mybuddy-skill-loader-"));
process.env.USERPROFILE = root;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy"), { recursive: true });

const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { AgentService } = await import("../src/main/agent/AgentService");
const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
const { ExpertService } = await import("../src/main/experts/ExpertService");
const { ConnectorService } = await import("../src/main/connectors/ConnectorService");
const { SkillsService } = await import("../src/main/skills/SkillsService");
const { MemoryService } = await import("../src/main/memory/MemoryService");
const { matchesSkillPolicyNeedles, matchesSkillIdentityNeedles } = await import("../src/shared/runtime-policy");
const { skillMatchesPolicy, nameMatchesPolicy } = await import("../src/shared/mode-access-filter");
// 插件目录已迁移到 ~/.mybuddy/plugins/**（PluginStorage v1）。测试必须写入真实目录 getter，
// 否则文件落在迁移前的旧路径上，ConnectorService/SkillsService 永远找不到。
const { getSkillsDir, getConnectorMarketDir } = await import("../src/main/paths");

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n# ${name}\n\nbody\n`;
}

async function main(): Promise<void> {
  console.log("[runtime-skill-loader-test] sandbox:", root);

  const db = new AppDatabase(join(root, "app.db"));
  const governanceMemory = new MemoryService(db, { semantic: false });
  const learnedSkillsService = new SkillsService();
  const installGovernedLearnedSkill = (input: {
    slug: string;
    title: string;
    description: string;
    instructions: string;
    scopeType: "global" | "workspace" | "project";
    scopeId?: string;
  }) => {
    const procedure = governanceMemory.create({
      kind: "procedure",
      title: input.title,
      content: input.instructions,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      sourceType: "manual",
      explicit: true,
      confidence: 1,
    });
    governanceMemory.refreshSkillCandidates(); // Explicit user review flow; creating memory does not auto-promote skills.
    const candidate = governanceMemory.listSkillCandidates().find((item) => item.sourceMemoryIds.includes(procedure.id));
    if (!candidate) throw new Error(`missing governance candidate for ${input.slug}`);
    const installed = learnedSkillsService.installLearnedSkill({
      candidateId: candidate.id,
      slug: input.slug,
      title: input.title,
      description: input.description,
      instructions: input.instructions,
      sourceMemoryIds: candidate.sourceMemoryIds,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
    });
    governanceMemory.learning.markMaterialized(candidate.id, installed.id);
    return learnedSkillsService.setEnabled(installed.id, true);
  };

  /* ---------- 磁盘 fixture ---------- */
  // Global skills（~/.mybuddy/plugins/skills）：g-ok 允许，g-deny 被 Tag 拒绝
  write(join(getSkillsDir(), "g-ok", "SKILL.md"), skillMd("g-ok"));
  write(join(getSkillsDir(), "g-deny", "SKILL.md"), skillMd("g-deny"));
  const learnedInstalled = installGovernedLearnedSkill({
    slug: "learned-runtime-ok",
    title: "Learned Runtime OK",
    description: "learned runtime policy fixture",
    instructions: "# Learned Runtime OK\n\nUse this learned runtime workflow.",
    scopeType: "global",
  });

  // Expert demo-expert：private skills e-ok（允许）/ e-deny（拒绝）
  const pkgDir = join(root, "expert-pkg");
  write(
    join(pkgDir, ".codebuddy-plugin", "plugin.json"),
    JSON.stringify({ name: "demo-expert", displayName: { zh: "演示专家" } }),
  );
  write(join(pkgDir, "agents", "demo-expert.md"), "---\nname: demo-expert\ndescription: demo\n---\n# Demo\n");
  write(join(pkgDir, "skills", "e-ok", "SKILL.md"), skillMd("e-ok"));
  write(join(pkgDir, "skills", "e-deny", "SKILL.md"), skillMd("e-deny"));
  new ExpertService().installByPath(pkgDir);

  // Connector demo-connector：private skills c-ok（允许）/ c-deny（拒绝）
  const connDir = join(getConnectorMarketDir(), "connectors", "demo-connector");
  write(join(connDir, "connector-meta.json"), JSON.stringify({ name: "演示连接器" }));
  write(join(connDir, "skills", "c-ok", "SKILL.md"), skillMd("c-ok"));
  write(join(connDir, "skills", "c-deny", "SKILL.md"), skillMd("c-deny"));
  new ConnectorService().install("demo-connector");

  /* ---------- AgentService + SDK 边界 seam ---------- */
  db.upsertTask({
    id: "skill-task",
    title: "Skill runtime",
    updatedAt: 1,
    welcomeMode: "coding",
  });

  let sdkCalls = 0;
  const capturedLoaders: Array<DefaultResourceLoader | null> = [];
  const capturedSessions: unknown[] = [];
  let submittedPrompt = "";
  let rejectNextPreflight = false;
  const makeFakeSession = (sdkOptions: CreateAgentSessionOptions) => {
    let subscriber: ((event: any) => void) | null = null;
    let pendingPromptReject: ((error: Error) => void) | null = null;
    const session = {
      sessionManager: sdkOptions.sessionManager ?? {},
      settingsManager: sdkOptions.settingsManager,
      modelRuntime: sdkOptions.modelRuntime,
      agent: { streamFunction: () => { throw new Error("fixture must not invoke a provider"); } },
      compact: async () => ({}),
      abortCompaction: () => {},
      refreshContext: () => {},
      navigateTree: async () => ({}),
      isStreaming: false,
      model: undefined,
      messages: [],
      sessionFile: join(root, "skill-session.jsonl"),
      prompt: async (text: string, options?: { preflightResult?: (disposition: "started") => void }) => {
        submittedPrompt = text;
        if (rejectNextPreflight) {
          rejectNextPreflight = false;
          throw new Error("fixture preflight rejected");
        }
        options?.preflightResult?.("started");
      },
      abort: async () => {
        const reject = pendingPromptReject;
        pendingPromptReject = null;
        reject?.(new Error("fixture team aborted"));
      },
      clearQueue: () => ({ steering: [], followUp: [] }),
      getLastAssistantText: () => "[]",
      setModel: async () => {},
      setThinkingLevel: () => {},
      getContextUsage: () => null,
      bindExtensions: async () => {},
      subscribe: (cb: (event: any) => void) => { subscriber = cb; return () => { subscriber = null; }; },
      emitEvent: (event: any) => subscriber?.(event),
      dispose: () => {},
      getActiveToolNames: () => [],
      getAllTools: () => [],
      setActiveToolsByName: () => {},
    };
    return session;
  };
  const createSessionAtSdkBoundary = async (
    options: CreateAgentSessionOptions = {},
  ): Promise<CreateAgentSessionResult> => {
    sdkCalls += 1;
    const session = makeFakeSession(options);
    capturedSessions.push(session);
    capturedLoaders.push(options.resourceLoader ?? null);
    return {
      session: session as unknown as CreateAgentSessionResult["session"],
      extensionsResult: {
        extensions: [],
        errors: [],
        runtime: {},
      } as unknown as CreateAgentSessionResult["extensionsResult"],
    };
  };

  const agent = new AgentService(
    db,
    new TaskExecutionWorkspace(join(root, "task-workspaces")),
    { createAgentSession: createSessionAtSdkBoundary },
  );

  (agent as any).modelRuntime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });

  const baseProfile = agent.getModeProfile("coding");
  const savePreset = (preset: {
    id: string;
    label: string;
    skillPolicy: { prefer: string[]; demote: string[]; hide: string[]; allow: string[] };
    recommendedExpertIds?: string[];
    expertPolicy?: { allow: string[]; deny: string[]; recommended: string[] };
    connectorPolicy?: { allow: string[]; deny: string[]; recommended: string[] };
  }): void => {
    // 同名 preset 替换（resolveModePreset 取首个命中，不能靠追加覆盖）
    const rest = (baseProfile.policy.presets ?? []).filter((p) => p.id !== preset.id);
    agent.saveModePolicy("coding", {
      ...baseProfile.policy,
      presets: [...rest, preset],
    });
  };

  const loaderNames = (): string[] =>
    (capturedLoaders[capturedLoaders.length - 1]?.getSkills().skills ?? []).map((s) => s.name).sort();

  const prompt = (modePresetId: string): Promise<{ queued: boolean }> =>
    agent.prompt({
      taskId: "skill-task",
      text: "run",
      assistantMessageId: `a-${sdkCalls + 1}`,
      userMessageId: `u-${sdkCalls + 1}`,
      welcomeMode: "coding",
      modePresetId,
      expertId: "demo-expert",
      connectorIds: ["demo-connector"],
    });

  /* ================= [1][2] Global Skill：允许进入 / 拒绝消失 ================= */
  console.log("\n[1][2] Global Skill 硬门禁");
  {
    savePreset({
      id: "skill-gate",
      label: "Skill Gate",
      skillPolicy: { prefer: [], demote: [], hide: [], allow: ["g-ok", "e-ok", "c-ok", "learned-runtime-ok"] },
    });
    const result = await prompt("skill-gate");
    assert(result.queued === false, "第一次 prompt 进入 createSession（SDK seam 被调用）");
    assert(sdkCalls === 1, "createSession 恰好一次");
    const names = loaderNames();
    assert(names.includes("g-ok"), "[1] 允许的 Global Skill g-ok 进入 SDK loader");
    assert(!names.includes("g-deny"), "[2] 被 Tag 拒绝的 Global Skill g-deny 不在 loader");
    const xml = formatSkillsForPrompt(capturedLoaders[capturedLoaders.length - 1]!.getSkills().skills);
    assert(
      !xml.includes("g-deny"),
      "[2] SDK 技能 XML（system prompt 素材）不含 g-deny",
    );
  }

  {
    const exposure = db.connection.prepare(
      "SELECT * FROM memory_skill_effectiveness WHERE task_id='skill-task' AND assistant_message_id='a-1' AND skill_id='learned-runtime-ok'",
    ).get() as { invoked_at: number | null; outcome: string } | undefined;
    assert(Boolean(exposure), "[E1] enabled + allowed learned Skill 在 Pi preflight 接受后记录 exposure");
    assert(exposure?.invoked_at == null, "[E1] exposure 不等于 invocation");
    assert(exposure?.outcome === "completed", "[E1] accepted turn 收敛 completed outcome");
    const firstSession = capturedSessions[0] as { emitEvent: (event: any) => void };
    firstSession.emitEvent({
      type: "tool_execution_start",
      toolCallId: "learned-read-1",
      toolName: "read",
      args: { path: learnedInstalled.filePath },
    });
    firstSession.emitEvent({
      type: "tool_execution_end",
      toolCallId: "learned-read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "learned skill body" }] },
      isError: false,
    });
    const invoked = db.connection.prepare(
      "SELECT invocation_kind,tool_call_id FROM memory_skill_effectiveness WHERE task_id='skill-task' AND assistant_message_id='a-1' AND skill_id='learned-runtime-ok'",
    ).get() as { invocation_kind: string | null; tool_call_id: string | null } | undefined;
    assert(invoked?.invocation_kind === "read", "[E1b] 成功 read learned SKILL.md 才升级为 read invocation");
    assert(invoked?.tool_call_id === "learned-read-1", "[E1b] read invocation 保留真实 toolCallId");
    const loadoutObs = db.connection.prepare(
      "SELECT outcome,used_skill_ids_json FROM agent_loadout_observations WHERE task_id='skill-task' AND assistant_message_id='a-1'",
    ).get() as { outcome: string; used_skill_ids_json: string } | undefined;
    assert(Boolean(loadoutObs), "[L1] accepted prompt records Loadout observation");
    assert(loadoutObs?.outcome === "completed", "[L1] Loadout observation follows turn outcome");
    assert(JSON.parse(loadoutObs?.used_skill_ids_json ?? "[]").includes("learned-runtime-ok"), "[L1] real read marks Skill actually-used in Loadout telemetry");
    db.connection.prepare(`INSERT INTO memory_skill_effectiveness (
      id,task_id,assistant_message_id,skill_id,candidate_id,source_memory_ids_json,exposed_at,invoked_at,invocation_kind,outcome,outcome_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      "eff-ordinary-collision", "skill-task", "a-collision", "g-ok", "old-learned-candidate", "[]", 1, 2, "command", "completed", 3, 3,
    );
    const inspection = agent.inspectRuntimeContext("skill-task");
    assert(inspection.loadout.basis === "recommendation_only", "[L4] Runtime Inspector exposes Loadout as recommendation-only projection");
    const actualLearned = inspection.loadout.capabilities.find((item) => item.kind === "skill" && item.id === "learned-runtime-ok");
    assert(actualLearned?.actual === true, "[L4] Inspector Loadout is grounded in authoritative actual assembly");
    const ordinary = inspection.loadout.capabilities.find((item) => item.kind === "skill" && item.id === "g-ok");
    assert(!ordinary?.evidence.some((item) => item.source === "effectiveness"), "[L5] ordinary Skill never inherits historical learned-Skill effectiveness by id collision");
  }

  /* ================= [3][4][5][6] Expert / Connector Private Skill ================= */
  console.log("\n[3][4][5][6] Private Skill 进入 runtime 且仍受 Tag Policy 控制");
  {
    const names = loaderNames();
    assert(names.includes("e-ok"), "[3] Expert Private Skill e-ok（Tag 允许）进入 loader");
    assert(!names.includes("e-deny"), "[4] Expert Private Skill e-deny（Tag 拒绝）不在 loader");
    assert(names.includes("c-ok"), "[5] Connector Private Skill c-ok（Tag 允许）进入 loader");
    assert(!names.includes("c-deny"), "[6] Connector Private Skill c-deny（Tag 拒绝）不在 loader");
    assert(
      JSON.stringify(names) === JSON.stringify(["c-ok", "e-ok", "g-ok", "learned-runtime-ok"]),
      "[7] loader 技能集合 == 最终允许集（唯一 source of truth）",
    );
    const xml = formatSkillsForPrompt(capturedLoaders[capturedLoaders.length - 1]!.getSkills().skills);
    assert(!xml.includes("e-deny") && !xml.includes("c-deny"), "SDK 技能 XML 不含任何被拒私有技能");
  }

  /* ================= [8] 切 Tag → fingerprint 变化 → 重建 → 新 loader ================= */
  console.log("\n[8] Tag 变化后 Session Runtime 重建");
  {
    const beforeHash = agent.registry.get("skill-task")?.runtimeAssemblyHash;
    const beforeSession = capturedSessions[0];
    // 同一 preset id，allow 收窄为 g-ok only
    savePreset({
      id: "skill-gate",
      label: "Skill Gate",
      skillPolicy: { prefer: [], demote: [], hide: [], allow: ["g-ok"] },
    });
    const result = await prompt("skill-gate");
    assert(result.queued === false, "第二次 prompt 完成");
    assert(sdkCalls === 2, "Tag 变更触发 session 重建（createSession 再次执行）");
    const afterHash = agent.registry.get("skill-task")?.runtimeAssemblyHash;
    assert(beforeHash !== afterHash, "runtime fingerprint 随允许技能集变化");
    assert(capturedSessions[1] !== beforeSession, "旧 session 被释放，新 session 对象生效");
    const names = loaderNames();
    assert(
      JSON.stringify(names) === JSON.stringify(["g-ok"]),
      "[8] 重建后 loader 只含新的允许集（g-ok）",
    );
    assert(!names.includes("e-ok") && !names.includes("c-ok"), "[8] 重建后私有技能随 Tag 收窄消失");
    assert(
      !formatSkillsForPrompt(capturedLoaders[capturedLoaders.length - 1]!.getSkills().skills).includes(
        "e-ok",
      ),
      "[8] 重建后 SDK 技能 XML 不含被移除技能",
    );
  }

  {
    const hiddenExposure = db.connection.prepare(
      "SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE task_id='skill-task' AND assistant_message_id='a-2' AND skill_id='learned-runtime-ok'",
    ).get() as { n: number };
    assert(hiddenExposure.n === 0, "[E2] learned Skill 被 Tag 隐藏后不记录 exposure");

    savePreset({
      id: "skill-gate",
      label: "Skill Gate",
      skillPolicy: { prefer: [], demote: [], hide: [], allow: ["g-ok", "learned-runtime-ok"] },
    });
    rejectNextPreflight = true;
    let rejected = false;
    try {
      await agent.prompt({
        taskId: "skill-task",
        text: "run rejected",
        assistantMessageId: "a-preflight-reject",
        userMessageId: "u-preflight-reject",
        welcomeMode: "coding",
        modePresetId: "skill-gate",
      });
    } catch (error) {
      rejected = String(error).includes("fixture preflight rejected");
    }
    assert(rejected, "[E3] fixture 确实走 Pi preflight reject");
    const rejectedExposure = db.connection.prepare(
      "SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE task_id='skill-task' AND assistant_message_id='a-preflight-reject'",
    ).get() as { n: number };
    assert(rejectedExposure.n === 0, "[E3] preflight reject 不产生 learned Skill exposure/invocation");
    const rejectedLoadout = db.connection.prepare(
      "SELECT COUNT(1) n FROM agent_loadout_observations WHERE task_id='skill-task' AND assistant_message_id='a-preflight-reject'",
    ).get() as { n: number };
    assert(rejectedLoadout.n === 0, "[L2] preflight reject 不产生 Loadout observation");

    const commandResult = await agent.prompt({
      taskId: "skill-task",
      text: "/skill:learned-runtime-ok run explicitly",
      assistantMessageId: "a-command",
      userMessageId: "u-command",
      welcomeMode: "coding",
      modePresetId: "skill-gate",
    });
    assert(commandResult.queued === false, "[E4] /skill:name prompt 被 Pi 接受");
    const commandInvocation = db.connection.prepare(
      "SELECT invocation_kind,outcome FROM memory_skill_effectiveness WHERE task_id='skill-task' AND assistant_message_id='a-command' AND skill_id='learned-runtime-ok'",
    ).get() as { invocation_kind: string | null; outcome: string } | undefined;
    assert(commandInvocation?.invocation_kind === "command", "[E4] 显式 /skill:name 记录 command invocation");
    assert(commandInvocation?.outcome === "completed", "[E4] command invocation 与 turn outcome 收敛");
    const commandLoadout = db.connection.prepare(
      "SELECT used_skill_ids_json FROM agent_loadout_observations WHERE task_id='skill-task' AND assistant_message_id='a-command'",
    ).get() as { used_skill_ids_json: string } | undefined;
    assert(JSON.parse(commandLoadout?.used_skill_ids_json ?? "[]").includes("learned-runtime-ok"), "[L3] /skill:name marks Skill actually-used in Loadout telemetry");
  }

  /* ================= [T1] Removed Expert Team namespace is a hard API boundary ================= */
  console.log("\n[T1] Removed Expert Team API boundary");
  {
    const callsBefore = sdkCalls;
    let message = "";
    try {
      await agent.prompt({
        taskId: "skill-task", text: "legacy team request", assistantMessageId: "a-legacy-team", userMessageId: "u-legacy-team",
        welcomeMode: "coding", expertId: "team:legacy-review-team",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert(message.includes("Expert teams are no longer supported"), "[T1] direct prompt with team:* is explicitly rejected");
    assert(sdkCalls === callsBefore, "[T1] rejected team:* request never reaches SDK session creation");
  }

  /* ================= [L7] Learned Skill reusable scope is a hard runtime boundary ================= */
  console.log("\n[L7] Learned Skill scope isolation");
  {
    db.upsertSpace({ id: "scope-root", name: "Scope Root", archived: false, updatedAt: Date.now() });
    db.upsertSpace({ id: "scope-a", name: "Scope A", parentId: "scope-root", archived: false, updatedAt: Date.now() });
    db.upsertSpace({ id: "scope-a-child", name: "Scope A Child", parentId: "scope-a", archived: false, updatedAt: Date.now() });
    db.upsertSpace({ id: "scope-b", name: "Scope B", parentId: "scope-root", archived: false, updatedAt: Date.now() });
    db.connection.prepare(`INSERT INTO projects (id,name,description,instructions,created_at,updated_at,archived,resource_budget_chars)
      VALUES (?,?,?,?,?,?,0,128000)`).run("scope-proj-a", "Scope Project A", null, null, Date.now(), Date.now());
    db.connection.prepare(`INSERT INTO projects (id,name,description,instructions,created_at,updated_at,archived,resource_budget_chars)
      VALUES (?,?,?,?,?,?,0,128000)`).run("scope-proj-b", "Scope Project B", null, null, Date.now(), Date.now());

    installGovernedLearnedSkill({
      slug: "learned-scope-ws", title: "Workspace Scoped",
      description: "workspace-only learned skill", instructions: "# Workspace Scoped\n\nUse only in workspace A lineage.",
      scopeType: "workspace", scopeId: "scope-a",
    });
    installGovernedLearnedSkill({
      slug: "learned-scope-project", title: "Project Scoped",
      description: "project-only learned skill", instructions: "# Project Scoped\n\nUse only in project A.",
      scopeType: "project", scopeId: "scope-proj-a",
    });

    savePreset({
      id: "scope-gate", label: "Scope Gate",
      skillPolicy: { prefer: ["learned-scope-ws", "learned-scope-project"], demote: [], hide: [], allow: ["g-ok", "learned-scope-ws", "learned-scope-project"] },
    });

    db.upsertTask({ id: "scope-task-b", title: "Sibling task", spaceId: "scope-b", projectId: "scope-proj-b", updatedAt: Date.now(), welcomeMode: "coding" });
    await agent.prompt({
      taskId: "scope-task-b", text: "run scoped workflow", assistantMessageId: "a-scope-b", userMessageId: "u-scope-b",
      welcomeMode: "coding", modePresetId: "scope-gate",
    });
    let scopedNames = loaderNames();
    assert(!scopedNames.includes("learned-scope-ws"), "[L7] sibling Workspace cannot see another Workspace learned Skill");
    assert(!scopedNames.includes("learned-scope-project"), "[L7] different Project cannot see Project learned Skill");

    db.upsertTask({ id: "scope-task-child", title: "Child task", spaceId: "scope-a-child", projectId: "scope-proj-a", updatedAt: Date.now(), welcomeMode: "coding" });
    await agent.prompt({
      taskId: "scope-task-child", text: "run scoped workflow", assistantMessageId: "a-scope-child", userMessageId: "u-scope-child",
      welcomeMode: "coding", modePresetId: "scope-gate",
    });
    scopedNames = loaderNames();
    assert(scopedNames.includes("learned-scope-ws"), "[L7] child Workspace inherits parent Workspace learned Skill");
    assert(scopedNames.includes("learned-scope-project"), "[L7] same Project sees Project learned Skill");
    const childInspection = agent.inspectRuntimeContext("scope-task-child");
    assert(childInspection.loadout.capabilities.some((item) => item.id === "learned-scope-ws"), "[L7] Inspector uses the same learned-scope boundary as runtime");
    const siblingInspection = agent.inspectRuntimeContext("scope-task-b");
    assert(!siblingInspection.loadout.capabilities.some((item) => item.id === "learned-scope-ws"), "[L7] Loadout does not recommend out-of-scope learned Skill to sibling Workspace");
  }

  /* ================= [L8] Scope eligibility must happen before first-wins collision ================= */
  console.log("\n[L8] Learned scope before first-wins collision");
  {
    const collisionCwd = join(root, "collision-project-b");
    db.upsertSpace({ id: "scope-collision-space", name: "Collision B", path: collisionCwd, archived: false, updatedAt: Date.now() });
    const outOfScope = scopedSkillsForCollision();
    function scopedSkillsForCollision() {
      return installGovernedLearnedSkill({
        slug: "scope-collision", title: "Out of scope collision",
        description: "project A learned collision", instructions: "# Out of scope\n\nProject A only.",
        scopeType: "project", scopeId: "scope-proj-a",
      });
    }
    write(join(collisionCwd, ".pi", "skills", "scope-collision", "SKILL.md"), skillMd("scope-collision"));
    savePreset({
      id: "scope-collision-gate", label: "Scope Collision Gate",
      skillPolicy: { prefer: ["scope-collision"], demote: [], hide: [], allow: ["scope-collision"] },
    });
    db.upsertTask({
      id: "scope-collision-task", title: "Collision task B", spaceId: "scope-collision-space", projectId: "scope-proj-b",
      modePresetId: "scope-collision-gate", updatedAt: Date.now(), welcomeMode: "coding",
    });
    await agent.prompt({
      taskId: "scope-collision-task", text: "run collision workflow", assistantMessageId: "a-scope-collision", userMessageId: "u-scope-collision",
      welcomeMode: "coding", modePresetId: "scope-collision-gate",
    });
    const collisionSkill = capturedLoaders[capturedLoaders.length - 1]?.getSkills().skills.find((skill) => skill.name === "scope-collision");
    assert(Boolean(collisionSkill), "[L8] same-named Project skill survives when Global learned Skill is out of scope");
    assert(collisionSkill?.filePath.toLowerCase().includes(join(".pi", "skills", "scope-collision").toLowerCase()), "[L8] loader selects Project skill, not out-of-scope learned winner");
    assert(collisionSkill?.filePath !== outOfScope.filePath, "[L8] out-of-scope learned Skill never occupies first-wins slot");
    const collisionInspection = agent.inspectRuntimeContext("scope-collision-task");
    assert(collisionInspection.loadout.capabilities.some((item) => item.kind === "skill" && item.id === "scope-collision"), "[L8] Loadout shares scope-before-collision semantics");
  }

  /* ================= [L9] Explicit recommendation of missing resources stays observable ================= */
  console.log("\n[L9] Missing recommended resources remain observable");
  {
    savePreset({
      id: "missing-loadout", label: "Missing Loadout",
      skillPolicy: { prefer: [], demote: [], hide: [], allow: ["g-ok"] },
      recommendedExpertIds: ["missing-review-expert", "team:legacy-review-team"],
      connectorPolicy: { allow: [], deny: [], recommended: ["missing-github-connector"] },
    });
    db.upsertTask({
      id: "missing-loadout-task", title: "Inspect missing recommendations", modePresetId: "missing-loadout",
      updatedAt: Date.now(), welcomeMode: "coding",
    });
    const missingInspection = agent.inspectRuntimeContext("missing-loadout-task");
    const missingExpert = missingInspection.loadout.capabilities.find((item) => item.kind === "expert" && item.id === "missing-review-expert");
    const missingConnector = missingInspection.loadout.capabilities.find((item) => item.kind === "connector" && item.id === "missing-github-connector");
    assert(missingExpert?.recommended === true && missingExpert.blocked === true && missingExpert.blockReason === "not_installed", "[L9] missing recommended Expert is visible as blocked:not_installed");
    assert(missingConnector?.recommended === true && missingConnector.blocked === true && missingConnector.blockReason === "not_installed", "[L9] missing recommended Connector is visible as blocked:not_installed");
    assert(!missingInspection.loadout.capabilities.some((item) => item.kind === "expert" && item.id.startsWith("team:")), "[L9] legacy team:* policy recommendation never re-enters Loadout candidates");
  }

  /* ================= [L10] Runtime Audit governance clears both projections ================= */
  console.log("\n[L10] Unified Runtime Audit clear");
  {
    const beforeSnapshots = agent.listRuntimeContextSnapshots("skill-task", 200).length;
    const beforeLoadout = agent.listAgentLoadoutObservations("skill-task", 200).length;
    assert(beforeSnapshots > 0 && beforeLoadout > 0, "[L10] fixture has both Runtime snapshots and Loadout observations");
    const cleared = agent.clearRuntimeAudit("skill-task");
    assert(cleared.runtimeSnapshots === beforeSnapshots, "[L10] unified clear removes Runtime snapshots");
    assert(cleared.loadoutObservations === beforeLoadout, "[L10] unified clear removes Loadout observations");
    assert(cleared.total === cleared.runtimeSnapshots + cleared.loadoutObservations, "[L10] clear result total is auditable");
    assert(agent.listRuntimeContextSnapshots("skill-task", 10).length === 0 && agent.listAgentLoadoutObservations("skill-task", 10).length === 0, "[L10] both histories are empty after clear");
  }

  /* ================= Matcher 收敛（P3）纯函数语义 ================= */
  console.log("\nMatcher 语义（matchesSkillPolicyNeedles 唯一实现）");
  {
    const ref = { id: "alpha", name: "Alpha Skill", description: "desc alpha" };
    assert(matchesSkillPolicyNeedles(ref, ["alpha"]), "exact id 命中");
    assert(matchesSkillPolicyNeedles(ref, ["ALPHA"]), "id 大小写不敏感");
    assert(matchesSkillPolicyNeedles(ref, ["alpha skill"]), "name 精确命中");
    assert(matchesSkillPolicyNeedles(ref, ["Alpha Skill"]), "name 大小写不敏感");
    assert(matchesSkillPolicyNeedles(ref, ["desc"]), "description 子串命中（旧语义）");
    assert(!matchesSkillPolicyNeedles(ref, []), "空 needles → false");
    assert(!matchesSkillPolicyNeedles(ref, ["zzz"]), "无关 needle 不命中");
    const withCmd = { id: "x", name: "y", command: "alpha", description: "" };
    assert(matchesSkillPolicyNeedles(withCmd, ["alpha"]), "command 精确命中（UI 侧旧语义）");
    assert(
      matchesSkillPolicyNeedles({ id: "a", name: "b", description: "c" }, ["review"]) ===
        skillMatchesPolicy({ id: "a", name: "b", description: "c" }, ["review"]),
      "skillMatchesPolicy 与 matchesSkillPolicyNeedles 行为一致（无 command）",
    );
    assert(
      matchesSkillPolicyNeedles(withCmd, ["alpha"]) ===
        skillMatchesPolicy({ id: "x", name: "y", command: "alpha", description: "" }, ["alpha"]),
      "skillMatchesPolicy 与 matchesSkillPolicyNeedles 行为一致（含 command）",
    );
    assert(nameMatchesPolicy("serena", ["serena"]), "nameMatchesPolicy exact");
    assert(nameMatchesPolicy("my-serena", ["serena"]), "nameMatchesPolicy includes");
    assert(!nameMatchesPolicy("serena", ["penpot"]), "nameMatchesPolicy 不命中");
  }

  /* ================= 硬名单不再被子串扩散（Phase 1） ================= */
  console.log("\n硬名单语义（matchesSkillIdentityNeedles / skillMatchesPolicy）");
  {
    const egoBrowser = { id: "ego-browser", name: "ego-browser", description: "Browser automation for logged-in sites" };
    const archify = { id: "archify", name: "archify", description: "Architecture and workflow diagrams" };
    assert(
      !matchesSkillIdentityNeedles(egoBrowser, ["bro"]),
      "allow 里的短 ID `bro` 不再子串命中 ego-browser",
    );
    assert(
      !matchesSkillIdentityNeedles(archify, ["architect"]),
      "allow 里的 `architect` 不再子串命中 archify",
    );
    assert(
      matchesSkillPolicyNeedles(archify, ["architect"]),
      "prefer/demote 关键词仍保留子串语义",
    );
    assert(
      matchesSkillIdentityNeedles({ id: "bro", name: "Bro", description: "restate" }, ["BRO"]),
      "硬名单 id 精确命中且大小写不敏感",
    );
    assert(
      matchesSkillIdentityNeedles({ id: "git-review", name: "Git Review" }, ["git review"]),
      "硬名单 name 精确命中",
    );
    assert(
      matchesSkillIdentityNeedles({ id: "x", name: "y", command: "alpha" }, ["alpha"]),
      "硬名单 command 精确命中",
    );
    assert(
      !matchesSkillIdentityNeedles(archify, ["arch"]),
      "硬名单不默认子串",
    );
    assert(
      matchesSkillIdentityNeedles(archify, ["keyword:arch"]),
      "显式 keyword: 前缀保留子串（旧配置可迁移）",
    );
    assert(
      !matchesSkillIdentityNeedles(archify, ["keyword:"]),
      "空 keyword 前缀不命中",
    );
    assert(
      !skillMatchesPolicy(egoBrowser, ["bro"]),
      "UI + 菜单可见性与主进程一致（硬名单身份匹配）",
    );
    assert(
      matchesSkillIdentityNeedles(egoBrowser, ["EGO-BROWSER"]),
      "硬名单 id 大小写不敏感（ego-browser）",
    );
  }

  console.log(`\n[runtime-skill-loader-test] passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

await main().catch((err) => {
  console.error(err);
  process.exit(1);
});
try {
  rmSync(root, { recursive: true, force: true });
} catch {
  /* keep temp on failure for debugging */
}
