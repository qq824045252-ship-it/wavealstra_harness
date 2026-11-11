/** Isolated normal stop/reopen lifecycle; no process crash injection. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { createGadgetAgentExtension } from "../src/main/gadget/gadget-agent-extension";

async function main() {
  const output = join(process.cwd(), "out/diagnostics/builtin-browser"); mkdirSync(output, { recursive: true });
  const root = mkdtempSync(join(output, "preview-lifecycle-"));
  const db = new AppDatabase(":memory:");
  const space = db.createSpace({ name: "Isolated preview", path: root });
  db.upsertTask({ id: "preview-task", title: "Fixture", spaceId: space.id, updatedAt: Date.now() });
  const storage = new GadgetStorage(join(root, "gadgets"));
  const registry = new GadgetRegistry();
  const runtime = new GadgetRuntime(storage, registry);
  const service = new GadgetService({ repository: new GadgetRepository(db.connection), storage, registry, runtime,
    workspaceExists: id => !!db.getSpace(id), workspaceEffectiveArchived: () => false,
    taskExists: id => !!db.getTask(id), taskWorkspaceId: id => db.getTask(id)?.spaceId ?? null, workspaceAncestors: () => [] });
  const tools: any[] = [];
  createGadgetAgentExtension({ taskId: "preview-task", service, resolveWorkspaceId: () => space.id,
    getPermissionMode: () => "auto", requestApproval: async () => true })({ registerTool: (tool: any) => tools.push(tool) } as any);
  const call = (name: string, params: any) => tools.find(tool => tool.name === name).execute("fixture", params);
  const gadget = service.create({ name: "Preview", scope: { type: "task", taskId: "preview-task" },
    files: [{ path: "index.html", content: "<body>before update</body>" }, { path: "asset.css", content: "body{color:navy}" }] });
  const report: unknown[] = [];
  try {
    const first = await service.start(gadget.id); assert.equal(first.status, "running");
    const updated = await call("gadget_update", { gadgetId: gadget.id, expectedRevision: service.readSource(gadget.id).revision,
      files: [{ path: "index.html", content: "<body>after update</body>" }] });
    assert.equal(updated.isError, undefined); assert.equal(updated.details.runtime.pid, first.pid); assert.equal(updated.details.runtime.url, first.url);
    assert.match(await (await fetch(first.url!)).text(), /after update/);
    report.push({ name: "live-update-preserves-server", passed: true });

    // Normal lifecycle simulates the stale in-memory URL after app restart.
    // Stop only this fixture's owned preview through its public service.
    await service.stop(gadget.id);
    const stopped = await call("gadget_update", { gadgetId: gadget.id, expectedRevision: service.readSource(gadget.id).revision,
      files: [{ path: "index.html", content: "<body>saved after process exit</body>" }] });
    assert.equal(stopped.isError, undefined, "successful source save must not become a failed edit");
    assert.notEqual(stopped.details.runtime.status, "running");
    assert.match(stopped.content[0].text, /gadget_open/);
    const reopened = await call("gadget_open", { gadgetId: gadget.id }); assert.equal(reopened.isError, undefined);
    assert.notEqual(reopened.details.pid, first.pid);
    assert.match(await (await fetch(reopened.details.url)).text(), /saved after process exit/);
    report.push({ name: "stopped-preview-save-and-reopen", passed: true });
    writeFileSync(join(output, "preview-lifecycle-results.json"), JSON.stringify(report, null, 2));
    console.log("gadget preview recovery: PASS (stable updates, normal stop, saved-source and reopen)");
  } finally { await runtime.disposeAll(); db.close(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
