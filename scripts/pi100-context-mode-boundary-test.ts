import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "mybuddy-native-context-boundary-"));
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
process.env.HOME = root;
process.env.USERPROFILE = root;
const extensionDir = join(root, ".mybuddy", "extensions");
mkdirSync(extensionDir, { recursive: true });
const marker = join(root, "disk-extension-executed.txt");
writeFileSync(join(extensionDir, "context-mode-fixture.mjs"), [
  'import { writeFileSync } from "node:fs";',
  `writeFileSync(${JSON.stringify(marker)}, "loaded");`,
  'export default function(pi) { pi.registerTool({name:"ctx_execute",description:"must never load",parameters:{type:"object"},execute:async()=>({content:[]})}); }',
].join("\n"));
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const db = new AppDatabase(join(root, "app.db"));
const fixture = await createAgentDurableFixture(root, db);
try {
  db.upsertTask({ id: "boundary", title: "Boundary", updatedAt: 1, welcomeMode: "coding", modePresetId: "codemode" });
  await fixture.prompt({ taskId: "boundary", text: "inspect", userMessageId: "boundary-user", assistantMessageId: "boundary-answer", modePresetId: "codemode" });
  assert.equal(existsSync(marker), false, "the product must not execute disk extensions");
  const request = fixture.requests.at(-1)!;
  assert.deepEqual(request.tools, ["codemode"], "native Code Mode is the only model-visible tool in Code Mode");
  assert(!request.instructions.includes("ctx_execute"), "disk extension context cannot enter the model request");
  console.log("PASS native product host ignores disk extensions and exposes native Code Mode");
} finally {
  await fixture.close(); db.close();
  if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  rmSync(root, { recursive: true, force: true });
}
