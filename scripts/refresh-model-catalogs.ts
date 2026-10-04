/** Explicit maintenance action: refresh only authenticated, non-paused providers through Pi.
 * Does not change enabledModels, defaults, per-model reasoning, or consultation choices.
 * Usage: bundle with esbuild (packages=external), run with --apply for the real profile.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerMyBuddyProviders } from "../src/main/agent/providers";

async function main(): Promise<void> {
  if (!process.argv.includes("--apply")) throw new Error("Explicit --apply is required to refresh the current profile.");
  const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".mybuddy");
  const outputIndex = process.argv.indexOf("--output");
  if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--output requires a directory");
  const outputDir = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1]! : "out/tests/model-catalog-refresh");
  mkdirSync(outputDir, { recursive: true });
  const guarded = ["settings.json", "models.json", "capabilities.json"];
  const hashes = () => Object.fromEntries(guarded.map(name => {
    const file = join(agentDir, name);
    return [name, existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null];
  }));
  const beforeHashes = hashes();
  const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  const paused = new Set(Object.keys(settings.pausedProviderModels || {}));
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: true, refreshOnCreate: false,
  });
  registerMyBuddyProviders(runtime);
  // hydrate Pi's credential/catalog snapshot before selecting providers; the
  // constructor intentionally skipped this work via refreshOnCreate: false.
  await runtime.refresh({ allowNetwork: false });
  const providers = runtime.getProviders().filter(p => !!p.refreshModels && runtime.hasConfiguredAuth(p.id) && !paused.has(p.id)).map(p => p.id);
  const list = (id: string) => runtime.getModels(id).map(m => m.id).sort();
  const before = Object.fromEntries(providers.map(id => [id, list(id)]));
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), providers, before, status: "running" };
  const save = () => writeFileSync(join(outputDir, "catalog-refresh.json"), JSON.stringify(report, null, 2) + "\n");
  save();
  const result = await runtime.refresh({ allowNetwork: true, force: true, providers, signal: AbortSignal.timeout(30_000) });
  const available = await runtime.getAvailable();
  const errors = [...result.errors.entries()].map(([providerId, error]) => ({ providerId, message: error instanceof Error ? error.message : String(error) }));
  const after = Object.fromEntries(providers.map(id => [id, list(id)]));
  const newCodex = runtime.getModel("openai-codex", "gpt-6.1-sol");
  assert(newCodex, "Pi's updated Codex model is missing");
  assert(runtime.getModel("commandcode", "gpt-6.1-sol"), "The updated Command Code model is missing");
  const preferencesUnchanged = JSON.stringify(beforeHashes) === JSON.stringify(hashes());
  Object.assign(report, {
    finishedAt: new Date().toISOString(), after, errors, aborted: result.aborted,
    preferencesUnchanged, changes: providers.map(id => ({ providerId: id, before: before[id].length,
      after: after[id].length, added: after[id].filter(x => !before[id].includes(x)),
      removed: before[id].filter(x => !after[id].includes(x)) })),
    verifiedModels: ["openai-codex", "commandcode"].map(provider => {
      const model = runtime.getModel(provider, "gpt-6.1-sol")!;
      return { provider, id: model.id, name: model.name, available: available.some(m => m.provider === provider && m.id === model.id), api: model.api, contextWindow: model.contextWindow };
    }),
    status: !result.aborted && !errors.length && preferencesUnchanged ? "passed" : "partial",
  });
  save();
  console.log(JSON.stringify({ status: report.status, providers, changes: report.changes, verifiedModels: report.verifiedModels, errors, preferencesUnchanged, report: join(outputDir, "catalog-refresh.json") }, null, 2));
  if (!preferencesUnchanged) throw new Error("Preferences changed during refresh; inspect concurrent writers before proceeding.");
  if (result.aborted || errors.length) process.exitCode = 1;
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
