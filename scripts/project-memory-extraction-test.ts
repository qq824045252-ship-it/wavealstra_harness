/**
 * project-memory-extraction-test — Unified Memory Kernel automatic extraction.
 *
 * Contract:
 * 1) Project-bound task routes project facts to project scope and global preferences to global scope.
 * 2) Non-project workspace task routes durable workspace facts to workspace scope.
 * 3) Retired memory stores (soul.memory_digest / memories / project_memory) do not exist.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";

const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-project-memory-extraction-"));
const dbPath = join(tempRoot, "extract.db");

function fakeResponse(json: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(json) }],
    stopReason: "stop",
  };
}

async function main(): Promise<void> {
  const db = new AppDatabase(dbPath);
  const memory = new MemoryService(db, { semantic: false });
  const pipeline = new MemoryPipelineManager(db);
  try {
    const ws = db.createSpace({ id: "space-x", name: "X", path: "C:/X" });
    const projects = new ProjectService(new ProjectRepository(db.connection), memory);
    const project = projects.create({ name: "仪表项目" });
    const now = Date.now();
    db.upsertTask({ id: "task-proj", title: "项目任务", updatedAt: now, spaceId: ws.id, projectId: project.id, welcomeMode: "coding" });
    db.upsertTask({ id: "task-plain", title: "普通任务", updatedAt: now + 1, spaceId: ws.id, welcomeMode: "coding" });

    let mode: "project" | "plain" = "project";
    let calls = 0;
    const runtime = {
      completeSimple: async () => {
        calls += 1;
        return fakeResponse(mode === "project" ? {
          candidates: [
            {
              kind: "preference", title: "回复语言", content: "优先使用中文回复",
              scopeType: "global", confidence: 0.99, importance: 1, explicit: true, operationHint: "create",
              userEvidence: "以后中文回复",
            },
            {
              kind: "constraint", title: "项目介质", content: "介质为乙腈，材料需要耐腐蚀",
              scopeType: "project", confidence: 0.99, importance: 2, explicit: true, operationHint: "create",
              userEvidence: "项目介质确定为乙腈，材料必须耐腐蚀",
            },
            {
              kind: "decision", title: "进度发布渠道", content: "项目进度统一发布到 Slack",
              scopeType: "workspace", confidence: 0.99, importance: 1, explicit: true, operationHint: "create",
              userEvidence: "进度统一发到 Slack",
            },
          ],
        } : {
          candidates: [
            {
              kind: "procedure", title: "空间调试约定", content: "示波器采样前先确认探头倍率",
              scopeType: "workspace", confidence: 0.95, importance: 1, explicit: true, operationHint: "create",
              userEvidence: "以后采样前必须确认示波器探头倍率",
            },
          ],
        });
      },
    };

    const base = {
      modelRuntime: runtime as never,
      model: {} as never,
      assistantText: "已确认。",
      isEnabled: () => true,
    };

    const l0Project = pipeline.capture({
      taskId: "task-proj",
      userMessageId: "u-project-1",
      assistantMessageId: "a-project-1",
      userText: "以后中文回复；项目介质确定为乙腈，材料必须耐腐蚀；进度统一发到 Slack。",
      assistantText: "已确认。",
      capturedAt: now + 10,
    });
    assert.equal(l0Project.shouldExtractL1, true);
    pipeline.beginL1(l0Project.pendingTurns);
    const r1 = await memory.extractAndStore({
      ...base,
      taskId: "task-proj",
      spaceId: ws.id,
      projectBound: true,
      userText: l0Project.turn.userText,
      sourceTurns: l0Project.pendingTurns,
    });
    pipeline.completeL1("task-proj", l0Project.pendingTurns);
    assert.equal(calls, 1);
    assert.equal(r1.globalChanged, true, "project task still writes global durable preference");
    assert.equal(r1.projectChanged, true, "project task must automatically write project scope");
    assert.equal(r1.spaceChanged, false, "project-specific facts must not double-write workspace scope");
    assert.equal(r1.committedCount, 3);

    const globals = memory.search({ scopeTypes: ["global"], includeInherited: false, statuses: ["active"], limit: 50 });
    assert.equal(globals.some((x) => x.memory.title === "回复语言"), true);
    const projectMem = memory.search({ projectId: project.id, scopeTypes: ["project"], includeInherited: false, statuses: ["active"], limit: 50 });
    assert.equal(projectMem.some((x) => x.memory.title === "项目介质"), true);
    assert.equal(projectMem.some((x) => x.memory.title === "进度发布渠道"), true, "workspace-labelled candidate in a project task must land in project scope");
    const projectFact = projectMem.find((x) => x.memory.title === "项目介质")!.memory;
    assert.equal(projectFact.evidence.some((e) => e.evidenceKind === "conversation" && e.refId === l0Project.turn.id), true, "L1 memory must point back to its L0 conversation evidence");
    const wsAfterProject = memory.search({ workspaceId: ws.id, scopeTypes: ["workspace"], includeInherited: false, statuses: ["active"], limit: 50 });
    assert.equal(wsAfterProject.length, 0, "project extraction must not duplicate into workspace");

    mode = "plain";
    const l0Plain = pipeline.capture({
      taskId: "task-plain",
      userMessageId: "u-plain-1",
      assistantMessageId: "a-plain-1",
      userText: "这个工作空间以后采样前必须确认示波器探头倍率。",
      assistantText: "已确认。",
      capturedAt: now + 20,
    });
    pipeline.beginL1(l0Plain.pendingTurns);
    const r2 = await memory.extractAndStore({
      ...base,
      taskId: "task-plain",
      spaceId: ws.id,
      projectBound: false,
      userText: l0Plain.turn.userText,
      sourceTurns: l0Plain.pendingTurns,
    });
    pipeline.completeL1("task-plain", l0Plain.pendingTurns);
    assert.equal(r2.spaceChanged, true);
    assert.equal(r2.projectChanged, false);
    const workspaceMem = memory.search({ workspaceId: ws.id, scopeTypes: ["workspace"], includeInherited: false, statuses: ["active"], limit: 50 });
    assert.equal(workspaceMem.some((x) => x.memory.title === "空间调试约定"), true);
    const workspaceProcedure = workspaceMem.find((x) => x.memory.title === "空间调试约定")!.memory;
    assert.equal(workspaceProcedure.evidence.some((e) => e.evidenceKind === "conversation" && e.refId === l0Plain.turn.id), true);

    // Unified truth: legacy stores are removed, not kept dormant.
    const legacySpace = db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memories'").get();
    assert.equal(legacySpace, undefined, "legacy memories table must not exist");
    const legacyProject = db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_memory'").get();
    assert.equal(legacyProject, undefined, "legacy project_memory table must not exist");
    const soulColumns = db.connection.pragma("table_info(soul)") as Array<{ name: string }>;
    assert.equal(soulColumns.some((column) => column.name === "memory_digest"), false, "legacy soul.memory_digest column must not exist");
  } finally {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

void main().then(() => {
  console.log("project-memory-extraction-test: PASS");
}).catch((cause) => {
  console.error("project-memory-extraction-test: FAILED", cause);
  process.exit(1);
});
