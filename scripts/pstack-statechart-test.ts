import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { parseValue } from "../vendor/pstack-statechart/scripts/frontends/value.ts";
import { json } from "../vendor/pstack-statechart/scripts/frontends/view.ts";
import { createPstackStatechartTool, statechartCommand } from "../src/main/agent/pstack/PstackStatechartTool";
import { normalizePstackSettings } from "../src/shared/pstack";
import type { Api, WorkflowRun } from "../src/main/agent/pstack/PstackState";

const exec = promisify(execFile), root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), vendor = join(root, "vendor/pstack-statechart");
const source = JSON.parse(await readFile(join(vendor, "UPSTREAM.json"), "utf8")) as { commit: string; pstackVersion: string; files: Record<string, string> };
assert.equal(source.commit, "9e278fe4d4ecd8bfe98b1b79bf4be662efb338cc");
assert.equal(source.pstackVersion, "0.15.48");
assert.equal(Object.keys(source.files).length, 31);
for (const [path, expected] of Object.entries(source.files)) assert.equal(createHash("sha256").update(await readFile(join(vendor, path))).digest("hex"), expected, path);
assert.match(await readFile(join(vendor, "LICENSE"), "utf8"), /MIT License[\s\S]*Lauren Tan/);
assert.deepEqual(json(parseValue('[phase |-> "ready", count |-> 2]')), { phase: "ready", count: 2 });
assert.throws(() => parseValue("<<1, 2"));

const scratch = await mkdtemp(join(tmpdir(), "mybuddy-statechart-"));
const runtime = join(vendor, "scripts/statechart.ts");
async function run(spec: string, out: string) {
  try {
    const result = await exec(process.execPath, ["--disable-warning=ExperimentalWarning", runtime, spec, "--out", out], {
      cwd: scratch, env: process.env, timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const detail = error as { code?: number; stdout?: string; stderr?: string };
    if (typeof detail.code !== "number") throw error;
    return { code: detail.code, output: (detail.stdout ?? "") + (detail.stderr ?? "") };
  }
}
try {
  const unusual = "literal '$(touch SHOULD_NOT_EXIST)' name";
  const command = statechartCommand({ executable: process.execPath, runtime, spec: unusual + ".tla", config: unusual + ".cfg", out: unusual + "-chart", shell: "bash" });
  const invalid = await exec("bash", ["-c", command], { cwd: scratch, windowsHide: true }).then(() => { throw Error("Missing model unexpectedly passed"); }, error => error as { code: number; stderr: string });
  assert.equal(invalid.code, 2);
  assert.match(invalid.stderr, /Cannot find the TLC config/);
  assert.deepEqual(await readdir(scratch), [], "Shell interpolation must not execute a path's dollar expression.");
  const powershell = statechartCommand({ executable: "C:\\My Buddy\\my'buddy.exe", runtime: "C:\\app\\statechart.ts", spec: "model.tla", config: "model.cfg", out: "report", shell: "powershell", electron: true });
  assert.match(powershell, /^\$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\My Buddy\\my''buddy\.exe'/);
  assert.match(powershell, /; exit \$LASTEXITCODE$/);
  if (!process.env.TLA2TOOLS) {
    console.log("SKIP live TLC checks: provide TLA2TOOLS pointing to the pinned 1.7.4 jar; vendored hashes, parser, quoting and missing-config failure passed.");
  } else {
    const model = String.raw`---- MODULE Counter ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Increment == /\ x < 2
             /\ x' = x + 1
Done == /\ x = 2
        /\ UNCHANGED x
Next == Increment \/ Done
Safe == x <= 2
====
`;
    await writeFile(join(scratch, "Counter.tla"), model);
    await writeFile(join(scratch, "Counter.cfg"), "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK TRUE\n");
    const passed = await run("Counter.tla", "pass");
    assert.equal(passed.code, 0, passed.output);
    assert.match(await readFile(join(scratch, "pass/report.md"), "utf8"), /Rules that hold[\s\S]*Safe/);
    assert.match(await readFile(join(scratch, "pass/chart.mmd"), "utf8"), /stateDiagram/);
    assert.ok((await readFile(join(scratch, "pass/tlc.out"))).length);
    const rerun = await run("Counter.tla", "pass");
    assert.equal(rerun.code, 2);
    assert.match(rerun.output, /not empty/);
    await writeFile(join(scratch, "Counter.tla"), model.replace("Safe == x <= 2", "Safe == x < 2"));
    const failed = await run("Counter.tla", "broken");
    assert.equal(failed.code, 1, failed.output);
    assert.match(await readFile(join(scratch, "broken/report.md"), "utf8"), /Safe breaks[\s\S]*shortest path/i);
    assert.match(await readFile(join(scratch, "broken/chart.mmd"), "utf8"), /breaks/);
    await writeFile(join(scratch, "Counter.tla"), model.replace("Next == Increment \\/ Done", "Next == MissingOperator"));
    const invalidModel = await run("Counter.tla", "invalid");
    assert.equal(invalidModel.code, 2, invalidModel.output);
    await assert.rejects(readFile(join(scratch, "invalid/report.md")), /ENOENT/);
    await writeFile(join(scratch, "Counter.tla"), model);
    const settings = normalizePstackSettings(), memos = new Map<string, unknown>();
    const workflow = { task: "statechart-fixture", run: 10, playbook: "skill:sharpen", config: JSON.stringify(settings), phase: "running", stage: 0 } as WorkflowRun;
    let executions = 0, active = true;
    const api = { taskId: 900, conversationId: 7,
      commit: async (action: (tx: unknown) => unknown) => action({ conversation: async () => ({ owner: undefined }) }),
      snapshot: async () => ({ run: workflow }),
      memo: async (...args: unknown[]) => { const key = String(args[0]); if (args.length === 3) memos.set(key, args[1]); return memos.get(key); },
      executeTool: async (shell: string, args: { command: string }) => {
        assert.equal(shell, "bash"); executions++;
        const result = await exec("bash", ["-c", args.command], { cwd: scratch, windowsHide: true }).then(value => ({ exitCode: 0, ...value }),
          error => { if (typeof error.code !== "number") throw error; return { exitCode: error.code as number, stdout: String(error.stdout), stderr: String(error.stderr) }; });
        return { taskId: 901, isError: result.exitCode !== 0, structuredOutput: { exitCode: result.exitCode, output: result.stdout + result.stderr, truncated: false }, diagnostics: [],
          details: { executionReceipt: { version: 1, taskId: "statechart-fixture", conversationId: 7, toolTaskId: 901, callId: "nested-statechart", toolName: "bash",
            executionId: "native-statechart", assistantMessageId: "native-assistant", status: result.exitCode === 0 ? "passed" : "failed", transport: "returned", settlement: "consumed", exitCode: result.exitCode,
            verifierId: "shell", verifierVersion: 1, checkedAt: 1 } } };
      },
    } as unknown as Api;
    const tool = createPstackStatechartTool({ taskId: workflow.task, cwd: scratch, active: () => active, settings: () => settings }, { runtimePath: async () => runtime });
    const call = { spec: "Counter.tla", out: "native-tool", shell: "bash" as const };
    const disallowed = await tool.execute(call, api, ctx);
    assert.equal(disallowed.isError, true); assert.equal(executions, 0, "A read-only prompt method must not invoke the statechart writer.");
    workflow.playbook = "skill:statechart"; active = false;
    assert.equal((await tool.execute(call, api, ctx)).isError, true); assert.equal(executions, 0);
    active = true;
    const native = await tool.execute(call, api, ctx);
    assert.ok(!native.isError, JSON.stringify(native)); assert.equal(executions, 1);
    const replay = await tool.execute(call, api, ctx);
    assert.ok(!replay.isError, JSON.stringify(replay)); assert.equal(executions, 1, "A durable retry reads the receipt without rerunning TLC.");
    await writeFile(join(scratch, "Counter.tla"), model.replace("Safe == x <= 2", "Safe == x < 2"));
    assert.equal((await tool.execute(call, api, ctx)).isError, true, "A cached receipt cannot verify changed input.");
    memos.clear();
    const foundBug = await tool.execute({ ...call, out: "native-counterexample" }, api, ctx);
    assert.ok(!foundBug.isError, JSON.stringify(foundBug));
    const evidence = memos.get("pstack-statechart-receipt") as { exitCode: number };
    assert.equal(evidence.exitCode, 1, "A real counterexample is delivered with its failed native shell exit, not mislabeled as a compiler error or pass.");
    console.log("PASS pinned statechart runtime: real TLC clean pass, shortest counterexample, invalid-model rejection, output preservation and shell quoting");
  }
} finally { await rm(scratch, { recursive: true, force: true }); }
