import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ExternalAgentRuntime } from "../src/main/external-agent/ExternalAgentRuntime";
import { resolveExternalAgentContinuationRunId } from "../src/shared/external-agent";
import type { ExternalAgentRunDto } from "../src/shared/external-agent";

const root = mkdtempSync(join(tmpdir(), "mybuddy-delegated-run-test-"));
const cwd1 = join(root, "task-one");
const cwd2 = join(root, "task-two");
mkdirSync(cwd1); mkdirSync(cwd2);
const db = new AppDatabase(join(root, "app.db"));
db.upsertTask({ id: "task-1", title: "Task One", updatedAt: 1 });
db.upsertTask({ id: "task-2", title: "Task Two", updatedAt: 1 });
const resolveCwd = (taskId: string): string => taskId === "task-1" ? cwd1 : cwd2;
const observer = async (taskId: string): Promise<string[]> => taskId === "task-1" ? ["artifact-one"] : ["artifact-two"];

function insertRun(input: {
  id: string; taskId: string; cwd: string; status?: string; sessionId?: string; resume?: boolean;
  cursor?: number; artifacts?: string[]; verification?: string; recovery?: string;
}): void {
  db.connection.prepare(`
    INSERT INTO external_agent_runs (
      id, task_id, agent_id, agent_name, protocol, status, cwd, session_id,
      user_message_id, assistant_message_id, prompt, display_text, attachments_json,
      final_text, thinking_text, tools_json, started_at, completed_at, error,
      continued_from_run_id, continuation_mode, output_cursor, artifact_refs_json,
      resume_supported, cancel_supported, verification_status, recovery_state, recovery_message
    ) VALUES (?, ?, 'codex', 'Codex', 'acp', ?, ?, ?, ?, ?, 'prompt', 'prompt', '[]',
      '', '', '[]', ?, NULL, NULL, NULL, 'new', ?, ?, ?, 1, ?, ?, NULL)
  `).run(
    input.id, input.taskId, input.status ?? "working", input.cwd, input.sessionId ?? null,
    `u-${input.id}`, `a-${input.id}`, Date.now(), input.cursor ?? 0,
    JSON.stringify(input.artifacts ?? []), input.resume ? 1 : 0,
    input.verification ?? "not_verified", input.recovery ?? "none",
  );
}

try {
  // First instance only materializes schema.
  const bootstrap = new ExternalAgentRuntime(db, resolveCwd, async (taskId) => observer(taskId));
  bootstrap.dispose();

  insertRun({ id: "restart-resume", taskId: "task-1", cwd: cwd1, sessionId: "session-resume", resume: true, cursor: 42, artifacts: ["artifact-a"], verification: "workspace_observed" });
  insertRun({ id: "restart-new", taskId: "task-1", cwd: cwd1, cursor: 7, artifacts: ["artifact-b"] });
  insertRun({ id: "task-two-run", taskId: "task-2", cwd: cwd2, sessionId: "session-two", resume: true, cursor: 11, artifacts: ["artifact-two"], verification: "workspace_observed" });

  // Simulate app restart: constructor closes orphan active statuses without replaying them.
  const runtime = new ExternalAgentRuntime(db, resolveCwd, async (taskId) => observer(taskId));
  const task1 = runtime.history("task-1");
  const resumed = task1.runs.find((run) => run.runId === "restart-resume")!;
  const newRequired = task1.runs.find((run) => run.runId === "restart-new")!;
  assert.equal(resumed.status, "failed");
  assert.equal(resumed.parentTaskId, "task-1");
  assert.deepEqual(resumed.agent, { id: "codex", name: "Codex" });
  assert.equal(resumed.recovery.state, "resume-available");
  assert.equal(resumed.capabilities.resumeSupported, true);
  assert.equal(resumed.capabilities.cancelSupported, false, "restarted orphan process is no longer cancellable");
  assert.equal(resumed.outputCursor, 42);
  assert.deepEqual(resumed.artifactRefs, ["artifact-a"]);
  assert.equal(resumed.verification.status, "workspace_observed");
  assert.equal(newRequired.recovery.state, "new-run-required");
  assert.equal(newRequired.capabilities.resumeSupported, false);
  assert.deepEqual(newRequired.artifactRefs, ["artifact-b"]);

  db.connection.prepare(`UPDATE external_agent_runs SET tools_json=? WHERE id=?`).run(JSON.stringify([
    { id: "done", tool: "read", summary: "done", status: "success" },
    { id: "failed", tool: "write", summary: "failed", status: "error" },
    { id: "denied", tool: "shell", summary: "denied", status: "denied" },
    { id: "pending", tool: "approval", summary: "pending", status: "pending_approval" },
    { id: "running", tool: "build", summary: "running", status: "running" },
  ]), "restart-new");
  const rebuiltTools = runtime.history("task-1").messages.find((message) => message.id === "a-restart-new")!.tools ?? [];
  assert.deepEqual(rebuiltTools.map((tool) => [tool.id, tool.status]), [
    ["done", "success"],
    ["failed", "error"],
    ["denied", "error"],
  ], "history never converts interrupted pending/running ACP tools into fake successes");

  const restoredMessage = task1.messages.find((message) => message.id === "a-restart-resume")!;
  assert.equal(restoredMessage.externalAgent?.runId, "restart-resume");
  assert.equal(restoredMessage.externalAgent?.resumeSupported, true);
  assert.equal(restoredMessage.externalAgent?.recoveryState, "resume-available");
  assert.deepEqual(restoredMessage.artifactIds, ["artifact-a"], "history exposes only trusted Artifact Domain ids");

  // Task isolation: task-1 history must not leak task-2 session/cwd/artifacts.
  assert.equal(task1.runs.some((run) => run.taskId === "task-2" || run.sessionId === "session-two"), false);
  const task2 = runtime.history("task-2");
  assert.equal(task2.runs.length, 1);
  assert.equal(task2.runs[0]!.cwd, cwd2);
  assert.deepEqual(task2.runs[0]!.artifactRefs, ["artifact-two"]);

  // Live delegated run: private state is injected only to test terminal-state semantics without a real CLI.
  insertRun({ id: "live-run", taskId: "task-1", cwd: cwd1, sessionId: "live-session", resume: true });
  const liveDto = runtime.history("task-1").runs.find((run) => run.runId === "live-run")!;
  liveDto.status = "working";
  liveDto.capabilities = { cancelSupported: true, resumeSupported: true };
  liveDto.recovery = { state: "none" };
  const active = { dto: liveDto, sessionId: liveDto.sessionId, cancelled: false };
  (runtime as any).activeRuns.set(liveDto.runId, active);

  (runtime as any).appendText(active, "final_text", "abc");
  (runtime as any).updateTool(active, "tool-1", { tool: "write", summary: "write file", status: "running" });
  (runtime as any).setWorkspaceObservation(active, ["artifact-live", "artifact-live"]);
  let liveHistory = runtime.history("task-1").runs.find((run) => run.runId === "live-run")!;
  assert.ok(liveHistory.outputCursor >= 4, "text/tool updates monotonically advance outputCursor");
  assert.deepEqual(liveHistory.artifactRefs, ["artifact-live"], "artifact refs are deduplicated");
  assert.equal(liveHistory.verification.status, "workspace_observed");

  const cancel = await runtime.cancel("live-run");
  assert.equal(cancel.ok, true);
  assert.equal(runtime.active("task-1").some((run) => run.runId === "live-run"), false, "cancelled run disappears from active view immediately");
  liveHistory = runtime.history("task-1").runs.find((run) => run.runId === "live-run")!;
  assert.equal(liveHistory.status, "cancelled");
  assert.equal(liveHistory.capabilities.cancelSupported, false);
  assert.equal(liveHistory.recovery.state, "none");

  // A late adapter completion cannot overwrite the user-selected terminal cancellation.
  (runtime as any).updateRun(active, "completed", { completedAt: Date.now() + 100 });
  assert.equal(runtime.history("task-1").runs.find((run) => run.runId === "live-run")!.status, "cancelled");

  // --- ACP 任务级 pin：DB roundtrip + preserve/null 语义 + 续链解析 ---
  db.upsertTask({ id: "task-1", title: "Task One", updatedAt: 2, externalAgentPin: { id: "devin", name: "Devin", pinnedAt: 123 } });
  assert.deepEqual(db.getTask("task-1")?.externalAgentPin, { id: "devin", name: "Devin", pinnedAt: 123 });
  db.upsertTask({ id: "task-1", title: "Task One", updatedAt: 3 });
  assert.equal(db.getTask("task-1")?.externalAgentPin?.id, "devin", "upsertTask without pin field preserves existing pin");
  db.upsertTask({ id: "task-1", title: "Task One", updatedAt: 4, externalAgentPin: null });
  assert.equal(db.getTask("task-1")?.externalAgentPin, undefined, "explicit null clears the pin");

  // 续链解析：最新优先，跳过异 agent / 无 session / 无 resume 能力 / 无 runId 的消息。
  const pinMessages = [
    { externalAgent: { id: "devin", runId: "r1", sessionReady: true, resumeSupported: true } },
    { externalAgent: { id: "codex", runId: "r2", sessionReady: true, resumeSupported: true } },
    { externalAgent: { id: "devin", runId: "r3", sessionReady: true, resumeSupported: false } },
    {},
    { externalAgent: { id: "devin", runId: "r4", sessionReady: false, resumeSupported: true } },
    { externalAgent: { id: "devin", sessionReady: true, resumeSupported: true } },
  ];
  assert.equal(resolveExternalAgentContinuationRunId(pinMessages, "devin"), "r1");
  assert.equal(resolveExternalAgentContinuationRunId(pinMessages, "codex"), "r2");
  assert.equal(resolveExternalAgentContinuationRunId(pinMessages, "cline"), undefined);
  assert.equal(resolveExternalAgentContinuationRunId([], "devin"), undefined);

  // Product/UI static gates: capability truth drives continuation and stop controls.
  const messageItem = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/MessageItem.tsx"), "utf8");
  const observatory = readFileSync(join(process.cwd(), "src/renderer/src/components/artifact/overview/RuntimeObservatory.tsx"), "utf8");
  const agentService = readFileSync(join(process.cwd(), "src/main/agent/AgentService.ts"), "utf8");
  const herdr = readFileSync(join(process.cwd(), "src/main/terminal/HerdrLauncher.ts"), "utf8");
  const externalAgentRuntime = readFileSync(join(process.cwd(), "src/main/external-agent/ExternalAgentRuntime.ts"), "utf8");
  const externalAgentTypes = readFileSync(join(process.cwd(), "src/shared/external-agent.ts"), "utf8");
  assert.ok(messageItem.includes("resumeSupported === true"), "continue action must depend on actual resume capability");
  assert.ok(messageItem.includes("工作目录已观察"), "UI must describe observation rather than business verification");
  assert.ok(observatory.includes("外部子任务"));
  assert.ok(observatory.includes("externalAgent?.cancel?.(run.runId)"), "Runtime Observatory exposes per-run cancel");
  assert.ok(agentService.includes("listMessageRefs(taskId, { messageId })"), "delegated artifacts come from Artifact Domain message refs");
  assert.ok(herdr.includes("myBuddyHerdrSessionName"));
  assert.ok(herdr.includes('return `mybuddy-${hash}`'), "Herdr keeps deterministic MyBuddy-owned named sessions");
  assert.ok(herdr.includes("never takes over the user's Herdr `default` session"), "Herdr integration must not compete with the user's default session");
  assert.ok(herdr.includes('const sessionArgs = ["--session", sessionName]'), "Herdr commands stay inside the MyBuddy-owned named session");
  assert.ok(externalAgentTypes.includes('"devin"'), "ExternalAgentId includes Devin");
  assert.ok(externalAgentRuntime.includes('id: "devin"') && externalAgentRuntime.includes('nativeArgs: ["acp"]'), "Devin uses native devin acp runtime");
  assert.ok(externalAgentRuntime.includes("devinDesktopBundledCli"), "Devin falls back to the CLI bundled with Devin Desktop when PATH has no devin executable");
  assert.ok(externalAgentRuntime.includes('"cognition.ai/requestDiagnostics": true'), "Devin advertises its diagnostics compatibility capability");
  assert.ok(externalAgentRuntime.includes('name: "windsurf"'), "Devin ACP initializes with the narrow Windsurf identity compatibility shim");

  const appStore = readFileSync(join(process.cwd(), "src/renderer/src/store/appStore.ts"), "utf8");
  const chatInput = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/ChatInput.tsx"), "utf8");
  const addMenu = readFileSync(join(process.cwd(), "src/renderer/src/components/chat/InputAddMenu.tsx"), "utf8");
  assert.ok(externalAgentTypes.includes("ExternalAgentPinDto"), "shared types expose the pin DTO");
  assert.ok(appStore.includes("resolveExternalAgentContinuationRunId"), "sendMessage resolves pin continuation from message history");
  assert.ok(appStore.includes("setExternalAgentPin"), "store exposes the pin action");
  assert.ok(chatInput.includes("onPinExternalAgent"), "composer wires the pin entry");
  assert.ok(addMenu.includes("onPinExternalAgent"), "add-menu flyout exposes per-agent pin");

  runtime.dispose();
  console.log("delegated run: PASS (restart recovery, cursor, artifacts, cancel terminal guard, task isolation, ACP pin, UI/capability gates)");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}