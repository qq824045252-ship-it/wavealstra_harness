import assert from "node:assert/strict";
import { useAppStore } from "../src/renderer/src/store/appStore";
import { minimalTask, prepareTestEnv } from "./test-store-harness";
import type { AgentPromptRequest, TaskDto } from "../src/shared/agent-ipc";

async function main(): Promise<void> {
  prepareTestEnv();
  const api = window.api;
  assert(api);
  const saved: TaskDto[] = [];
  const requests: AgentPromptRequest[] = [];
  let releaseSave: (() => void) | undefined;
  api.db.upsertTask = async (task) => {
    saved.push(task);
    await new Promise<void>(resolve => { releaseSave = resolve; });
  };
  api.agent.prompt = async (request) => { requests.push(request); return { queued: false }; };
  const seed = (mode: "general" | "coding" | "working", globalMode: "general" | "coding" | "working") => {
    saved.length = 0; requests.length = 0; releaseSave = undefined;
    useAppStore.setState({
      tasks: [{ ...minimalTask("bound-task"), welcomeMode: mode, modePresetId: mode === "general" ? "native" : undefined,
        ...(mode === "general" ? {} : { sessionFile: "existing-pi.jsonl", messages: [{ id: "prior", role: "user", text: "first message", blocks: [] }] }) }],
      activeTaskId: "bound-task", welcomeMode: globalMode, modePresetId: "native", activeModelId: "fixture/model",
      models: [], modelExplicit: false, permissionMode: "auto", permissionExplicit: false, draft: null,
      chatSelections: [], activeConnectorIds: [], pendingRefTask: null,
    });
  };
  for (const [taskMode, globalMode] of [["general", "coding"], ["coding", "general"], ["working", "general"]] as const) {
    seed(taskMode,globalMode);
    const completion = useAppStore.getState().sendMessage("continue bound task");
    assert.equal(saved[0]?.welcomeMode,taskMode,"Persistence must use the task mode, not the global new-task selection");
    assert.equal(requests.length,0,"Agent execution must wait until its task metadata is persisted");
    assert(releaseSave);
    releaseSave();
    await completion;
    assert.equal(requests[0]?.welcomeMode,taskMode);
    assert.equal(useAppStore.getState().tasks[0].welcomeMode,taskMode);
  }
  seed("general","general");
  const completion = useAppStore.getState().sendMessage("first Bot submission");
  useAppStore.getState().setWelcomeMode("coding");
  assert.equal(useAppStore.getState().tasks[0].welcomeMode,"general","A pending Bot submission already locks its execution backend");
  assert(releaseSave); releaseSave(); await completion;
  assert.equal(requests[0].welcomeMode,"general");

  seed("general","general");
  api.db.upsertTask = async () => { throw new Error("SAVE_REJECTED"); };
  await useAppStore.getState().sendMessage("must not execute after failed save");
  assert.equal(requests.length,0);
  assert.match(useAppStore.getState().tasks[0].botInputError ?? "",/SAVE_REJECTED/);
  assert.equal(useAppStore.getState().tasks[0].botPendingSubmission,undefined);
  console.log("PASS: task mode authority, persist-before-prompt, pending Bot lock and failed-save admission");
}
main().catch(error => { console.error(error); process.exitCode=1; });
