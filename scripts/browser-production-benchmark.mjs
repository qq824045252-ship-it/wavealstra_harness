import { build } from "esbuild";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { readBenchmarkAttempt } from "./browser-benchmark-attempt.mjs";

const options = Object.fromEntries(process.argv.slice(2).map((arg, i, args) => arg.startsWith("--") ? [arg.slice(2), args[i + 1]] : []).filter(entry => entry.length));
const baseline = options.baseline ?? "b7040544e0b03b21cd1d560e6219f49bb95c2ff4";
if (!/^[0-9a-f]{40}$/.test(baseline)) throw Error("--baseline must be a full commit SHA");
const variants = options.variant ? [options.variant] : ["baseline", "candidate"];
if (variants.some(variant => !["baseline", "candidate"].includes(variant))) throw Error("Unknown variant");
const repeats = Number(options.repeats ?? 1);
if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20) throw Error("Invalid repeat count");
const models = (options.models ?? "auto/deepseek-v4.1-flash-1017").split(",");
if (models.some(model => !model || /\s/.test(model))) throw Error("--models must be comma-separated catalog IDs without whitespace");
const entry = options.entry ?? "scripts/browser-production-live.ts";
if (!["scripts/browser-production-live.ts", "scripts/browser-screenshot-electron-test.ts"].includes(entry)) throw Error("Unsupported benchmark entry");
const allowedCases = entry === "scripts/browser-production-live.ts" ? ["short", "long", "table", "async", "form", "popup", "non-browser", "partial"] : ["screenshot"];
const cases = options.cases === undefined ? allowedCases : options.cases.split(",");
if (cases.some(test => !allowedCases.includes(test))) throw Error("Unknown benchmark case");
const output = resolve("out/diagnostics/browser-46-50/production");
mkdirSync(output, { recursive: true });
const root = mkdtempSync(join(output, `${new Date().toISOString().replace(/[:.]/g, "-")}-`));
const sourceFiles = execFileSync("rg", ["--files", "src/main", "src/shared"], { encoding: "utf8" }).trim().split(/\r?\n/);
const hashes = Object.fromEntries(sourceFiles.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const manifest = { baseline, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashes: hashes,
  dirtyPaths: execFileSync("git", ["status", "--short"], { encoding: "utf8" }), cpus: os.availableParallelism(), loadavg: os.loadavg(),
  operatingSystem: { type: os.type(), release: os.release(), version: os.version(), arch: os.arch() },
  limitation: "Browser execution, UI execution, tool registration/bridge, BrowserHost and PageInspectionService are switched to the fixed baseline (copies saved in baseline-source). All other current source, including recovery policy and pre-existing uncommitted work, is held constant. New local profiles do not guarantee cold provider caches.", repeats, order: "same model/case: A,B then B,A on alternate rounds", entry, cases, runs: [] };
for (const model of models) for (let round = 0; round < repeats; round++) for (const test of cases) {
  for (const variant of round % 2 ? [...variants].reverse() : variants) {
    const ordinal = manifest.runs.length + 1;
    const out = join(root, `${ordinal}-${model.replaceAll(/[^a-zA-Z0-9-]/g, "_")}-${round}-${test}-${variant}`);
    manifest.runs.push({ model, round, case: test, variant, out, state: "planned" });
  }
}
function saveManifest() {
  const temporary = join(root, "manifest.json.tmp");
  writeFileSync(temporary, JSON.stringify(manifest, null, 2));
  renameSync(temporary, join(root, "manifest.json"));
}
saveManifest();
const baselineFiles = new Set(["src/main/capabilities/BrowserAutomationService.ts", "src/main/capabilities/UiAutomationService.ts", "src/main/capabilities/builtin-capability-extension.ts", "src/main/browser/BrowserHost.ts", "src/main/agent/durable/DurableDomainTools.ts", "src/main/artifact/PageInspectionService.ts", ...(entry !== "scripts/browser-production-live.ts" ? [entry] : [])]);
const snapshot = Object.fromEntries([...baselineFiles].map(path => [path, execFileSync("git", ["show", `${baseline}:${path}`], { encoding: "utf8" })]));
manifest.baselineFiles = [...baselineFiles];
manifest.baselineHashes = Object.fromEntries(Object.entries(snapshot).map(([path, content]) => [path, createHash("sha256").update(content).digest("hex")]));
manifest.harnessHash = createHash("sha256").update(readFileSync(entry)).digest("hex");
mkdirSync(join(root, "baseline-source"));
for (const [path, content] of Object.entries(snapshot)) writeFileSync(join(root, "baseline-source", path.replaceAll("/", "__")), content);
const require = createRequire(import.meta.url), electron = require("electron");
for (const variant of variants) {
  await build({ entryPoints: [entry], bundle: true, platform: "node", format: "esm", packages: "external", outfile: join(root, `${variant}.mjs`),
    banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    plugins: variant === "baseline" ? [{ name: "fixed-browser-baseline", setup(builder) {
      builder.onLoad({ filter: /\.ts$/ }, args => {
        const path = args.path.slice(resolve(".").length + 1).replaceAll("\\", "/");
        return baselineFiles.has(path) ? { contents: snapshot[path], loader: "ts", resolveDir: dirname(args.path) } : undefined;
      });
    } }] : [] });
  manifest.bundles ??= {};
  manifest.bundles[variant] = createHash("sha256").update(readFileSync(join(root, `${variant}.mjs`))).digest("hex");
}
for (const run of manifest.runs) {
  const { model, variant, out, case: test } = run;
  mkdirSync(out);
  run.state = "running";
  saveManifest();
  const env = { ...process.env, BROWSER_BENCH_MODEL: model, BROWSER_BENCH_VARIANT: variant, BROWSER_BENCH_OUT: out, BROWSER_BENCH_CASES: test, ...(options.reasoning ? { BROWSER_BENCH_REASONING: options.reasoning } : {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  const startedAt = Date.now();
  const cwd = test === "screenshot" ? out : process.cwd();
  await new Promise(resolve => {
    const child = spawn(electron, [join(root, `${variant}.mjs`)], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) stream.on("data", chunk => appendFileSync(join(out, `${name}.log`), chunk));
    child.once("error", error => { run.error = String(error); });
    child.once("close", (code, signal) => {
      run.exitCode = code;
      if (signal) run.signal = signal;
      resolve();
    });
  });
  if (test === "screenshot") {
    // The fixed baseline entry writes relative to cwd. Its output remains inside this attempt.
    const legacyReport = join(out, "artifacts/computer-use-browser-repair/production-capture/results.json");
    const report = join(out, "results.json");
    if (!existsSync(report) && existsSync(legacyReport)) copyFileSync(legacyReport, report);
  }
  run.state = "finished";
  run.processWallMs = Date.now() - startedAt;
  const evidence = readBenchmarkAttempt(run);
  run.status = evidence.status;
  console.log(model, test, variant, evidence.status, evidence.error ?? "");
  saveManifest();
}
console.log("BROWSER BENCHMARK", root);
process.exitCode = manifest.runs.every(run => run.status === "passed") ? 0 : 1;
