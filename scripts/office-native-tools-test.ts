import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import JSZip from "jszip";
import { closeOfficeNativeSessions, createOfficeNativeExtension } from "../src/main/office-use/OfficeNativeTools";
import type { OfficeNativeEngine } from "../src/main/platform/office-native";
import { OFFICE_USE_TOOLS as office } from "../src/shared/office-use";

const scratch = join(process.cwd(), "out", "tests");
await mkdir(scratch, { recursive: true });
const temp = await realpath(scratch);
const root = await mkdtemp(join(temp, "mybuddy-office-native-"));
const tools = new Map<string, ToolDefinition>();
createOfficeNativeExtension({
  taskId: "office-native-acceptance", taskRoot: () => root, isEnabled: () => true, getPermissionMode: () => "default",
})({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);

async function run(tool: string, args: object) {
  const result = await tools.get(tool)!.execute("fixture", args, undefined, undefined, {} as never);
  assert.ok(!result.isError, JSON.stringify(result.content).slice(0, 2000));
  return result.content;
}
async function json(tool: string, args: object) {
  const [content] = await run(tool, args);
  assert.equal(content.type, "text");
  return JSON.parse(content.text);
}
const invoke = (engine: OfficeNativeEngine, tool: string, args: object = {}) => json(office.nativeCall, { engine, tool, arguments: args });
const command = (engine: OfficeNativeEngine, command: string, params: object = {}) =>
  invoke(engine, { wordcraft: "execute", gridcraft: "execute_command", deckcraft: "run_command" }[engine], { command, params });

try {
  for (const [engine, count] of [["wordcraft", 18], ["gridcraft", 22], ["deckcraft", 25]] as const) {
    const catalog = await json(office.nativeTools, { engine, limit: 30 });
    assert.equal(catalog.tools.length, count);
    assert.ok(catalog.tools.every((tool: { inputSchema?: unknown }) => tool.inputSchema));
    const commands = await invoke(engine, "list_commands");
    const ids = new Set(commands.map((item: { id: string }) => item.id));
    const reference = await readFile(`vendor/craft-office/skill/office-use/references/upstream/${engine}/references/commands.md`, "utf8");
    const missing = [...reference.matchAll(/^- `([^\x60]+)` /gm)].map(match => match[1]).filter(id => !ids.has(id));
    assert.deepEqual(missing, [], `${engine} commands documented by the upstream skill`);
  }

  const letters = join(root, "letters.docx");
  await invoke("wordcraft", "new_document", { template: "blank" });
  await invoke("wordcraft", "batch", { commands: [
    { command: "mailings.start", params: { kind: "letters" } },
    { command: "mailings.recipients", params: { csv: "Name\nAda\nGrace\n" } },
    { command: "text.insert", params: { text: "Dear " } },
    { command: "mailings.insertField", params: { field: "Name" } },
    { command: "mailings.finish", params: { path: letters } },
  ] });
  const merged = await JSZip.loadAsync(await readFile(letters));
  assert.match(await merged.file("word/document.xml")!.async("text"), /Ada.*Grace/s);

  await invoke("gridcraft", "write_range", { range: "A1", values: [[0], ["=A1*2"]] });
  const solved = await command("gridcraft", "data.solver", { objective: "A2", variables: "A1", constraints: ["A1 <= 7"], method: "simplex" });
  assert.equal(solved.status, "optimal");
  assert.equal(solved.objective, 14);
  assert.equal((await invoke("gridcraft", "read_range", { range: "A1:A2" })).values[0][0], 7);
  await command("gridcraft", "macro.save", { macro: {
    name: "Stamp", steps: [{ type: "command", id: "cell.set", params: { cell: "B1", input: "42" } }],
  } });
  await command("gridcraft", "macro.run", { name: "Stamp" });
  assert.deepEqual((await invoke("gridcraft", "read_range", { range: "B1" })).values, [[42]]);
  const workbook = join(root, "solver.xlsx");
  await invoke("gridcraft", "save_workbook", { path: workbook });

  await invoke("deckcraft", "new_presentation");
  const shape = await invoke("deckcraft", "add_shape", { preset: "rect", x: 80, y: 80, w: 90, h: 70, text: "Motion" });
  const motion = await command("deckcraft", "animation.add", { effect: "customPath", path: [[0, 0], [150, 0]], ids: [shape.id] });
  assert.equal(motion.count, 1);
  const pdf = join(root, "slides.pdf");
  await invoke("deckcraft", "export", { path: pdf, format: "pdf" });
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), "%PDF-");

  if (process.argv.includes("--desktop")) {
    for (const [engine, newTool] of [["wordcraft", "new_document"], ["gridcraft", "open_workbook"], ["deckcraft", "new_presentation"]] as const) {
      await run(office.nativeCall, { engine, surface: "desktop", tool: newTool, arguments: engine === "gridcraft" ? { path: workbook } : {} });
      if (engine === "wordcraft") await run(office.nativeCall, {
        engine, surface: "desktop", tool: "execute",
        arguments: { command: "view.switchWindows", params: { window: 1 } },
      });
      // Native capture is intentionally refused while a document/window switch is on screen.
      await delay(400);
      const path = join(root, "grid.png");
      const capture = () => run(office.nativeCall, { engine, surface: "desktop", tool: "screenshot",
        arguments: engine === "gridcraft" ? { path } : {} });
      const image = await capture().catch(async (error: Error) => {
        if (!/changed while the capture was queued|belongs to another viewport/.test(error.message)) throw error;
        await delay(500);
        return capture();
      });
      if (engine === "gridcraft") assert.equal((await readFile(path)).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      else assert.ok(image.some(item => item.type === "image" && item.mimeType === "image/png"));
      console.log(`${engine} desktop screenshot passed.`);
    }
  }
  console.log("Office native catalogs, mail merge, Solver, workbook macro, motion path, and PDF export passed.");
} finally {
  await closeOfficeNativeSessions();
  assert.equal(dirname(await realpath(root)), temp);
  await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 150 });
}
