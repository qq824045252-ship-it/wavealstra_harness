import { build } from "esbuild";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import os from "node:os";

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
const cases = (options.cases ?? "short,long,table,async,form,popup,non-browser,bot-work").split(",");
const allowedCases = entry === "scripts/browser-production-live.ts" ? ["short", "long", "table", "async", "form", "popup", "non-browser", "bot-work", "partial"] : ["screenshot"];
if (cases.some(test => !allowedCases.includes(test))) throw Error("Unknown benchmark case");
const root = resolve("out/diagnostics/browser-46-50/production", new Date().toISOString().replace(/[:.]/g, "-")); mkdirSync(root, { recursive: true });
const sourceFiles = execFileSync("rg", ["--files", "src/main", "src/shared"], { encoding: "utf8" }).trim().split(/\r?\n/);
const hashes = Object.fromEntries(sourceFiles.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
const manifest = { baseline, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashes: hashes,
  dirtyPaths: execFileSync("git", ["status", "--short"], { encoding: "utf8" }), cpus: os.availableParallelism(), loadavg: os.loadavg(),
  operatingSystem: { type: os.type(), release: os.release(), version: os.version(), arch: os.arch() },
  limitation: "Browser execution, UI execution, tool registration/bridge, BrowserHost and PageInspectionService are switched to the fixed baseline (copies saved in baseline-source). All other current source, including recovery policy and pre-existing uncommitted work, is held constant. New local profiles do not guarantee cold provider caches.", repeats, order: "same model/case: A,B then B,A on alternate rounds", cases, runs: [] };
writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
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
for (const model of models) for (let round = 0; round < repeats; round++) for (const test of cases) {
  for (const variant of round % 2 ? [...variants].reverse() : variants) {
    const out = join(root, `${model.replaceAll(/[^a-zA-Z0-9-]/g, "_")}-${round}-${test}-${variant}`); mkdirSync(out);
    const env = { ...process.env, BROWSER_BENCH_MODEL: model, BROWSER_BENCH_VARIANT: variant, BROWSER_BENCH_OUT: out, BROWSER_BENCH_CASES: test, ...(options.reasoning ? { BROWSER_BENCH_REASONING: options.reasoning } : {}) };
    delete env.ELECTRON_RUN_AS_NODE;
    const startedAt = Date.now();
    const code = await new Promise((resolve, reject) => {
      const child = spawn(electron, [join(root, `${variant}.mjs`)], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) stream.on("data", chunk => appendFileSync(join(out, `${name}.log`), chunk));
      child.once("error", reject); child.once("exit", resolve);
    });
    let result; try { result = JSON.parse(readFileSync(join(out, "results.json"), "utf8")); } catch { result = { status: "missing-report" }; }
    if (entry === "scripts/browser-screenshot-electron-test.ts") {
      result = JSON.parse(readFileSync("artifacts/computer-use-browser-repair/production-capture/results.json", "utf8"));
      result.status = code === 0 ? "passed" : "failed";
      writeFileSync(join(out, "results.json"), JSON.stringify(result, null, 2));
    }
    manifest.runs.push({ model, round, case: test, variant, out, exitCode: code, processWallMs: Date.now() - startedAt, status: result.status });
    console.log(model, test, variant, result.status, result.cases?.[0]?.error ?? result.error ?? "");
    writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  }
}
console.log("BROWSER BENCHMARK", root);
process.exitCode = manifest.runs.every(run => run.exitCode === 0) ? 0 : 1;
