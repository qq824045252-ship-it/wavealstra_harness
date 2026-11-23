import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

test("the gate distinguishes guard timeouts from test failures and preserves unselected baseline entries", () => fixture(async (root) => {
  const sourceDir = dirname(fileURLToPath(import.meta.url));
  const scriptsDir = join(root, "scripts");
  const modulesDir = join(root, "node_modules");
  const binDir = join(modulesDir, ".bin");
  await mkdir(scriptsDir);
  await mkdir(binDir, { recursive: true });
  await symlink(join(sourceDir, "..", "node_modules", "esbuild"), join(modulesDir, "esbuild"), "junction");
  for (const name of ["test-all.mjs", "test-bundle-pool.mjs", "test-guard.mjs"]) {
    await copyFile(join(sourceDir, name), join(scriptsDir, name));
  }
  // Dispatch the fixture's package scripts without relying on an installed pnpm.
  const fixtureRunner = `const { spawnSync } = require("node:child_process");
const script = require("./package.json").scripts[process.argv[2]];
for (const stage of script.split(" && ")) {
  const result = spawnSync(process.execPath, stage.split(" ").slice(1), { stdio: "inherit" });
  if (result.status !== 0) {
    process.exitCode = 1;
    break;
  }
}
`;
  const isWindows = process.platform === "win32";
  await writeFile(join(binDir, isWindows ? "pnpm.cmd" : "pnpm"), isWindows
    ? '@node fixture-runner.cjs "%~2"\r\n'
    : '#!/bin/sh\nexec node fixture-runner.cjs "$2"\n', { mode: 0o755 });
  await writeFile(join(root, "fixture-runner.cjs"), fixtureRunner);
  const cases = {
    "fixture-hang": "setInterval(() => {}, 1000);",
    "fixture-pass": "process.exit(0);",
    "fixture-exit-124": 'console.error("[test-guard] KILL reason=timeout"); process.exit(124);',
  };
  const scripts = {};
  for (const [name, source] of Object.entries(cases)) {
    scripts[`test:${name}`] = `node scripts/test-guard.mjs src/${name}.cjs`;
    await writeFile(join(root, "src", `${name}.cjs`), source);
  }
  scripts["test:fixture-before-guard"] = "node src/fixture-exit-124.cjs && node scripts/test-guard.mjs src/fixture-pass.cjs";
  scripts["test:fixture-after-guard"] = "node scripts/test-guard.mjs src/fixture-pass.cjs && node src/fixture-exit-124.cjs && node scripts/test-guard.mjs src/fixture-pass.cjs";
  scripts["test:fixture-unguarded"] = "node src/fixture-exit-124.cjs";
  scripts["test:fixture-last-guard-failed"] = "node scripts/test-guard.mjs src/fixture-pass.cjs && node scripts/test-guard.mjs src/fixture-exit-124.cjs";
  await writeFile(join(root, "package.json"), JSON.stringify({ scripts }));
  const baselinePath = join(scriptsDir, "test-baseline.json");
  const original = { $basis: "fixture metadata", knownFailing: Object.keys(scripts).sort() };
  await writeFile(baselinePath, JSON.stringify(original));
  const baseline = async () => JSON.parse(await readFile(baselinePath, "utf8"));
  const gate = (...args) => spawnSync(process.execPath, ["scripts/test-all.mjs", "--no-batch-build", ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, GUARD_TIMEOUT_S: "1", GUARD_HOME: "sandbox" },
  });

  const hang = gate("--filter=fixture-hang");
  assert.equal(hang.status, 1, hang.stdout + hang.stderr);
  assert.match(hang.stdout, /TIMEOUT test:fixture-hang/);
  assert.match(hang.stdout, /超时 1/);
  const updateHang = gate("--filter=fixture-hang", "--update-baseline");
  assert.equal(updateHang.status, 1, updateHang.stdout + updateHang.stderr);
  assert.deepEqual(await baseline(), original);

  const assertionFailure = gate("--filter=fixture-exit-124");
  assert.equal(assertionFailure.status, 0, assertionFailure.stdout + assertionFailure.stderr);
  assert.match(assertionFailure.stdout, /FAIL\s+test:fixture-exit-124.+baseline 已知/);
  assert.doesNotMatch(assertionFailure.stdout, /TIMEOUT test:/);

  const pipelineFailures = [
    ["fixture-before-guard", /missing-guard-outcome/],
    ["fixture-after-guard", /guard-exit-mismatch/],
  ].map(([name, expected]) => ({ expected, regression: gate(`--filter=${name}`) }));
  assert.deepEqual(pipelineFailures.map(({ regression }) => regression.status), [1, 1],
    pipelineFailures.map(({ regression }) => regression.stdout + regression.stderr).join("\n"));
  for (const { expected, regression } of pipelineFailures) {
    assert.match(regression.stdout, expected);
  }
  for (const name of ["fixture-unguarded", "fixture-last-guard-failed"]) {
    const ordinaryFailure = gate(`--filter=${name}`);
    assert.equal(ordinaryFailure.status, 0, ordinaryFailure.stdout + ordinaryFailure.stderr);
    assert.match(ordinaryFailure.stdout, /\[baseline 已知\]/);
  }

  const updatePass = gate("--filter=fixture-pass", "--update-baseline");
  assert.equal(updatePass.status, 0, updatePass.stdout + updatePass.stderr);
  assert.match(updatePass.stdout, /PASS test:fixture-pass/);
  const updated = await baseline();
  assert.equal(updated.$basis, original.$basis);
  assert.deepEqual(updated.knownFailing, original.knownFailing.filter((name) => name !== "test:fixture-pass"));
}));
