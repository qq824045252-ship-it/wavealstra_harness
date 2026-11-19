import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-durable";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { monitorOwnerDispatch, recordedOwnerAudits, type OwnerAuditTick } from "../src/main/agent/pstack/PstackOwnerMonitor";
import { WorkflowState } from "../src/main/agent/pstack/PstackState";
import { auditSchedule, inspectOwnerAudit, verifiedAuditSchedule } from "../src/main/agent/pstack/PstackDelivery";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService } from "../src/main/cron/CronService";

export async function testInFlightOwners() {
  const root = await mkdtemp(join(tmpdir(), "mb-pstack-owner-")), cwd = join(root, "work"), config = join(root, "profile");
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = config;
  let runtime: DurableBotRuntime | undefined;
  let overdue!: () => void, reported!: () => void;
  const late = new Promise<void>(resolve => { overdue = resolve; });
  const observed = new Promise<void>(resolve => { reported = resolve; });
  const samples: OwnerAuditTick[] = [];
  let durableEvidence = false;
  let recoveredOwners: string[] = [];
  const timeout = setTimeout(() => { overdue(); reported(); void runtime?.abort(); }, 12_000);
  try {
    await mkdir(cwd); await mkdir(join(config, "agents"), { recursive: true });
    await writeFile(join(config, "agents", "worker.md"), "---\nname: worker\ndescription: test owner\ntools: write\n---\nWrite owner.txt then finish.");
    await writeFile(join(config, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "owner", enabledModels: ["fixture/owner"] }));
    const models = await ModelRuntime.create({ authPath: join(config, "auth.json"), modelsPath: null, modelsStorePath: join(config, "catalog.json"), refreshOnCreate: false });
    models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
      models: [{ id: "owner", name: "Fixture owner", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, request) {
        const stream = createAssistantMessageEventStream();
        void (async () => {
          const messages = request.messages;
          const child = messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("FIRST_REPORT_FIXTURE"));
          const hasResult = messages.some(m => m.role === "toolResult");
          if (child) await (hasResult ? observed : late);
          const name = child ? "write" : "pstack_delegate";
          const content: AssistantMessage["content"] = hasResult ? [{ type: "text", text: "Finished." }]
            : [{ type: "toolCall", id: "call-" + name, name, arguments: child ? { path: "owner.txt", content: "first artifact" } : {} }];
          const answer: AssistantMessage = { role: "assistant", api: model.api, model: model.id, provider: model.provider,
            timestamp: Date.now(), stopReason: hasResult ? "stop" : "toolUse", content,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          stream.push({ type: "done", reason: answer.stopReason as "stop" | "toolUse", message: answer }); stream.end();
        })();
        return stream;
      },
    });
    const monitor = defineTool({ name: "pstack_delegate", description: "Dispatch and observe one owner", replay: "safe", parameters: Type.Object({}),
      async execute(_args, api, context) {
        await api.commit(async tx => {
          const first = (await tx.scanEntries({ conversationId: api.conversationId }, 1)).items[0]!.id;
          (await tx.doc(WorkflowState, api.conversationId)).run = { task: "owner-fixture", run: api.taskId, first, inputs: [first], revision: 1, playbook: "autopilot-stack",
            config: "{}", phase: "running", stage: 0, block: "", notes: [], operations: [], verification: null, review: null, delegates: [] };
        }, context);
        const recording = Object.create(api) as typeof api;
        Object.defineProperty(recording, "output", { value: (chunk: string | Uint8Array) => {
          api.output(chunk);
          const tick: OwnerAuditTick = JSON.parse(String(chunk).slice("Autopilot owner audit: ".length));
          samples.push(tick);
          if (tick.owners.some(o => o.state === "overdue")) overdue();
          if (tick.owners.some(o => o.state === "reported")) reported();
        } });
        const started = api.now();
        const pending = api.executeTool("subagent", { agent: "worker", task: "FIRST_REPORT_FIXTURE: write the file.", isolation: "shared" }, context, { key: "owner" });
        // Speed up the two intervals while retaining the live clock and production child ownership/entry store.
        const { result } = await monitorOwnerDispatch(pending, recording, context, started, 0.002, 0.002,
          { run: api.taskId, active: () => true, expectedOwners: 1 });
        const saved = (await recordedOwnerAudits(api, context, api.taskId))[String(api.taskId)];
        durableEvidence = !!saved && saved.count >= 2 && saved.latest.owners.some(o => o.firstEvidence?.startsWith("write@"));
        const active = (await api.snapshot(WorkflowState, api.conversationId, context))!.run!;
        const ownerId = saved.latest.owners[0].owner;
        const receipt = { stage: 0, stageId: "owners", role: "swarm-workers", toolTaskId: Number(result.taskId), children: [ownerId], models: ["fixture/owner"], answers: ["done"] };
        const delta = { fingerprint: "fixture", paths: ["owner.txt"], changedLines: 1, largestCrossing: 0, addedBranches: 0, unknown: [], coverageComplete: true };
        await assert.rejects(inspectOwnerAudit(api, context, { ...active, delegates: [{ ...receipt, children: ["another-owner"] }] }, delta, 1, 0.002), /Missing original owner/);
        recoveredOwners = (await inspectOwnerAudit(api, context, { ...active, delegates: [receipt] }, delta, 1, 0.002)).overdueOwners;
        return { output: [{ type: "text", text: result.isError ? JSON.stringify(result.diagnostics) : "owner returned" }], isError: result.isError };
      } });
    runtime = await DurableBotRuntime.open({ taskId: "owner-fixture", cwd, directory: join(root, "store"), toolMode: "native", models,
      model: { provider: "fixture", modelId: "owner" }, instructions: () => "Fixture", onSnapshot: () => {},
      tools: [monitor, ...createDurableSubagentTools({ taskId: "owner-fixture", cwd, models, permissionMode: () => "auto" })] });
    await (await runtime.submit("Monitor the owner", "test")).wait(ctx);
    await runtime.conversation.waitForIdle(ctx);
    assert.equal(await readFile(join(cwd, "owner.txt"), "utf8"), "first artifact");
    const states = samples.flatMap(tick => tick.owners);
    const lateOwner = states.find(owner => owner.state === "overdue");
    assert.ok(lateOwner, JSON.stringify(states));
    assert.ok(states.some(owner => owner.owner === lateOwner.owner && owner.conversation === lateOwner.conversation &&
      owner.state === "reported" && owner.firstEvidence?.startsWith("write@")), JSON.stringify(states));
    assert.ok(durableEvidence, "The owning workflow's durable audit did not retain its live file evidence");
    assert.deepEqual(recoveredOwners, [lateOwner.owner], "Recover the first report and its deadline from the original owner's conversation");
    console.log("PASS live Durable child overdue at its deadline, then captured the same child's file write before it could return");
    const db = new AppDatabase(join(root, "automation.db"));
    const cron = new CronService(db, { prompt: async () => { throw new Error("Future fixture job ran early"); },
      waitForSubmission: async () => { throw new Error("No fixture prompts should be pending"); }, isTaskBusy: () => false,
      loadTaskHistory: async () => ({ messages: [] }), getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
      listSkills: () => [], listConnectors: () => [] });
    try {
      db.upsertTask({ id: "owner-fixture", title: "owner", cwd, updatedAt: Date.now() });
      const expected = auditSchedule({ run: 42, playbook: "autopilot-full" }, 2);
      const job = cron.createForTask("owner-fixture", cwd, { name: "My audit", prompt: expected.prompt, scheduleType: "every", scheduleExpr: "120s", timezone: "UTC", target: "current-task" });
      const snapshot = () => cron.getForTask("owner-fixture", job.id);
      assert.ok(verifiedAuditSchedule(snapshot(), job.id, expected).nextRunAt > Date.now() + 110_000);
      assert.throws(() => verifiedAuditSchedule(snapshot(), job.id, auditSchedule({ run: 42, playbook: "autopilot-full" }, 3)), /interval/);
      assert.throws(() => verifiedAuditSchedule(snapshot(), job.id, auditSchedule({ run: 43, playbook: "autopilot-full" }, 2)), /instructions/);
      cron.changeForTask("owner-fixture", job.id, "pause");
      assert.throws(() => verifiedAuditSchedule(snapshot(), job.id, expected), /active/);
      console.log("PASS persisted task scheduler readback recognizes equivalent cadence, rejects another run, changed interval and paused schedule");
    } finally { cron.stop(); db.close(); }
  } finally {
    clearTimeout(timeout); overdue(); reported(); await runtime?.close();
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
}
