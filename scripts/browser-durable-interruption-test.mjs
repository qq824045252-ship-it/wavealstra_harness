import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// No Electron or network provider. Kill only child processes created by this test.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "browser-native-interruption-"));
const override = process.argv.indexOf("--worker");
const worker = override >= 0 ? resolve(process.argv[override + 1]) : join(repository, "out/tests/browser-durable-interruption-fixture.mjs");
if (override < 0) {
  const { build } = await import("esbuild");
  const bundle = await build({ entryPoints: [join(repository, "scripts/browser-durable-interruption-fixture.ts")], bundle: true, platform: "node", format: "esm", packages: "external", outfile: worker, write: false });
  await mkdir(dirname(worker), { recursive: true });
  await writeFile(worker, bundle.outputFiles[0].contents);
}
const children = new Set();
const log = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = path => access(path).then(() => true, () => false);
function launch(phase) {
  const child = spawn(process.execPath, [worker], { cwd: repository, windowsHide: true, env: { ...process.env, PROBE_ROOT: root, PROBE_PHASE: phase }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => { children.delete(child); resolve({ code, signal }); });
  });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => log.push(chunk.toString()));
  return { child, completion };
}
try {
  const first = launch("interrupt");
  const deadline = Date.now() + 30_000;
  while (!(await exists(join(root, "ready")))) {
    assert(children.has(first.child), "worker exited before the in-flight checkpoint");
    assert(Date.now() < deadline, "in-flight checkpoint timeout");
    await delay(100);
  }
  // The third external effect exists but its handler has not returned a receipt.
  first.child.kill("SIGKILL");
  await first.completion;
  const resumed = launch("recover");
  const timeout = setTimeout(() => resumed.child.kill("SIGKILL"), 45_000);
  let exit;
  try { exit = await resumed.completion; } finally { clearTimeout(timeout); }
  assert.equal(exit.code, 0, "recovery child failed or timed out");
  const effects = (await readFile(join(root, "effects.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const recovered = JSON.parse(await readFile(join(root, "result-recover.json"), "utf8"));
  assert.deepEqual(effects.map(item => item.step), ["1", "2", "3"]);
  assert(effects.every(item => item.phase === "interrupt"), "recovery must not replay an unsafe effect");
  assert.deepEqual(recovered.calls, []);
  assert.equal(recovered.result.status, "done");
  // The fixture separately asserts native nested statuses ok, ok, error and unknown effect wording.
  await writeFile(join(root, "result.json"), JSON.stringify({ passed: true, effects, recovered }, null, 2));
  console.log("PASS: native interruption retains two successes, reports uncertain third, never replays or dispatches fourth");
  console.log(`Evidence retained: ${root}`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  await writeFile(join(root, "worker.log"), log.join(""));
}
