/** Opt-in real-provider check for the newly available Codex model. No user files are sent. */
import assert from "node:assert/strict";
import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

async function main(): Promise<void> {
  if (!process.argv.includes("--run-live")) throw new Error("--run-live is required; this check sends one provider request.");
  const root = mkdtempSync(join(tmpdir(), "models-update-live-"));
  const latest = JSON.parse(readFileSync(resolve("out/tests/models-portable-latest.json"), "utf8"));
  const report: Record<string, unknown> = { status: "running", startedAt: new Date().toISOString(), provider: "openai-codex", model: "gpt-6.1-sol" };
  try {
    writeFileSync(join(root, "models.json"), '{"providers":{}}');
    const runtime = await ModelRuntime.create({ authPath: join(homedir(), ".mybuddy/auth.json"), modelsPath: join(root, "models.json"), allowModelNetwork: false });
    const model = runtime.getModel("openai-codex", "gpt-6.1-sol");
    assert(model, "Exact new model is absent");
    const a = randomInt(100, 1000), b = randomInt(100, 1000), nonce = randomBytes(10).toString("hex");
    const stream = runtime.streamSimple(model, { messages: [{ role: "user", content: `计算 ${a}+${b}。只返回一个 JSON 对象，字段 nonce 必须等于 ${nonce}，字段 sum 为计算结果，不要 Markdown 或其他文字。`, timestamp: Date.now() }] }, { reasoning: "low", maxTokens: 1024, signal: AbortSignal.timeout(75_000) });
    const message = await stream.result();
    assert.notEqual(message.stopReason, "error", message.errorMessage);
    assert.notEqual(message.stopReason, "aborted", message.errorMessage);
    const text = message.content.filter(p => p.type === "text").map(p => p.text).join("");
    const json = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "").trim());
    assert.deepEqual(json, { nonce, sum: a + b });
    assert.equal(message.provider, model.provider);
    assert.equal(message.model, model.id);
    Object.assign(report, { status: "passed", actualProvider: message.provider, actualModel: message.model, result: json, input: [a, b], usage: message.usage });
  } catch (error) {
    Object.assign(report, { status: "failed", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString();
    mkdirSync(latest.output, { recursive: true });
    writeFileSync(join(latest.output, "new-model-live.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2));
  }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
