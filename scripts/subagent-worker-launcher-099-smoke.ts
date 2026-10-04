import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const piCli = resolve(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const launcher = resolve(process.cwd(), "src/main/capabilities/subagent/worker-launcher.mjs");
const sessionDir = mkdtempSync(join(tmpdir(), "pi099-worker-smoke-"));
const sessionId = "pi099-worker-smoke";

const child = spawn(process.execPath, [
  launcher,
  piCli,
  "--mode", "rpc",
  "--no-extensions",
  "--no-tools",
  "--no-approve",
  "--session-dir", sessionDir,
  "--session-id", sessionId,
  "--name", sessionId,
], {
  cwd: process.cwd(),
  env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  child.stdin.write(JSON.stringify({ id: "state-1", type: "get_state" }) + "\n");
  const deadline = Date.now() + 15_000;
  let response: any;
  while (Date.now() < deadline) {
    for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
      try {
        const event = JSON.parse(line);
        if (event.id === "state-1" && event.type === "response") response = event;
      } catch { /* partial/non-json line */ }
    }
    if (response) break;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  assert(response, `worker RPC did not answer get_state; exit=${child.exitCode}; stderr=${stderr.slice(0, 1200)}`);
  assert.equal(response.success, true, `get_state failed: ${JSON.stringify(response)}`);
  assert(!/0\.87\.0/.test(stderr), "worker must not require Pi 0.87.0");
  console.log("subagent-worker-launcher-099-smoke: PASS");
} finally {
  try { child.stdin.end(); } catch {}
  if (child.exitCode === null) child.kill();
  await new Promise<void>((resolveDone) => {
    if (child.exitCode !== null) return resolveDone();
    child.once("exit", () => resolveDone());
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolveDone(); }, 3_000).unref?.();
  });
  rmSync(sessionDir, { recursive: true, force: true });
}
