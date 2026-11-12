import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { build } from "esbuild";
import { parseBundledTestCommand, prepareTestBundles } from "./test-bundle-pool.mjs";

// Keep compiler subprocesses read-only; the fixture owns writing and cleaning its outputs.
async function buildFixture(options) {
  const result = await build({ ...options, write: false });
  for (const output of result.outputFiles ?? []) {
    await mkdir(dirname(output.path), { recursive: true });
    await writeFile(output.path, output.contents);
  }
  return result;
}

function command(file, extra = "", args = "") {
  return `esbuild src/${file}.ts --bundle --platform=node --format=cjs --alias:fixture=./src/value.ts --outfile=out/tests/${file}.cjs ${extra} && node scripts/test-guard.mjs out/tests/${file}.cjs ${args}`;
}
async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "mybuddy-test-pool-"));
  try { await mkdir(join(root, "src")); await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
function runEntry(root, name) {
  return spawnSync(process.execPath, [join(root, "out/tests", `${name}.cjs`)], { cwd: root, encoding: "utf8", timeout: 10_000 });
}

test("batch compilation retains output paths and aliases, and recompiles changed dependencies", () => fixture(async (root) => {
  await writeFile(join(root, "src/value.ts"), 'export const value = "first";');
  for (const name of ["one", "two"]) await writeFile(join(root, `src/${name}.ts`), 'import { value } from "fixture"; process.stdout.write(value);');
  const scripts = { "test:one": command("one"), "test:two": command("two", "", "--fixture-mode") };
  let invocations = 0;
  const result = await prepareTestBundles(Object.keys(scripts), scripts, { root, buildImpl: async (options) => { invocations++; return buildFixture(options); } });
  assert.equal(invocations, 1, "compatible entries compile in one build");
  assert.equal(result.prepared.size, 2);
  assert.deepEqual(result.prepared.get("test:two").guardArgs, ["out/tests/two.cjs", "--fixture-mode"]);
  for (const name of ["one", "two"]) {
    const execution = runEntry(root, name);
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(execution.stdout, "first");
  }
  await writeFile(join(root, "src/value.ts"), 'export const value = "changed";');
  await prepareTestBundles(Object.keys(scripts), scripts, { root, buildImpl: buildFixture });
  assert.equal(runEntry(root, "one").stdout, "changed", "never reuse stale source output");
}));

test("a broken entry is attributed without losing successful tests or running stale output", () => fixture(async (root) => {
  await writeFile(join(root, "src/value.ts"), 'export const value = 1;');
  await writeFile(join(root, "src/good.ts"), 'process.stdout.write("healthy");');
  await writeFile(join(root, "src/bad.ts"), 'import "./missing-dependency";');
  await mkdir(join(root, "out/tests"), { recursive: true });
  await writeFile(join(root, "out/tests/bad.cjs"), 'process.stdout.write("stale");');
  const scripts = { good: command("good"), bad: command("bad") };
  const { prepared } = await prepareTestBundles(Object.keys(scripts), scripts, { root, buildImpl: buildFixture });
  assert.equal(prepared.get("good").error, undefined);
  assert.match(prepared.get("bad").error, /missing-dependency/);
  assert.equal(prepared.get("bad").guardArgs, undefined, "failed compilation cannot be launched");
  assert.equal(runEntry(root, "good").stdout, "healthy");
}));

test("commands with shell behavior, unrecognized flags or shared outputs stay on their original runner", () => fixture(async (root) => {
  for (const script of [
    command("one", "--define:MODE=1"), command("one", "--loader:.png=file"),
    command("one").replace("node scripts/test-guard.mjs", "electron"),
    command("one").replace("esbuild", "SOURCE=1 esbuild"), command("one") + " && echo done",
    command("one", "", "$(anything)"), command("one").replaceAll("out/tests/one.cjs", "out/main/one.cjs"),
  ]) assert.equal(parseBundledTestCommand(script, root), undefined, script);
  const { prepared, batches } = await prepareTestBundles(["first", "second"], { first: command("one"), second: command("one") }, { root, buildImpl: buildFixture });
  assert.equal(prepared.size, 0);
  assert.equal(batches, 0);
}));


test("invalid concurrency cannot silently report an empty successful gate", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  for (const option of ["--jobs=NaN", "--jobs=0", "--jobs=1.5", "--timeout=NaN"]) {
    const result = spawnSync(process.execPath, ["scripts/test-all.mjs", option, "--list"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stderr, /必须是/);
  }
  const artifacts = spawnSync(process.execPath, ["scripts/test-all.mjs", "--artifacts-only", "--list"], { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(artifacts.status, 0, artifacts.stderr);
  for (const name of ["test:image-resize-assets", "test:oauth-build-assets", "test:pi-codemode-assets"]) assert(artifacts.stdout.includes(name));
  assert(!artifacts.stdout.includes("  test:pi104-features"));
});
