import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { z } from "zod";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { currentPlatformId } from "../../platform";
import { workspaceDocumentPath } from "../../../shared/pstack/paths";
import { matchingNativeExecutionReceipt } from "../../../shared/native-execution-receipt";
import { readOnlyCodingTag } from "../../../shared/pstack/coding-tags";
import { checked, owner, runSettings, state, success, failure, type WorkflowOptions } from "./PstackState";
import { guardedWorkspaceTarget } from "./PstackDecisionFile";
import { checkAdvancedArtifact, currentAdvancedMethod, inspectAdvancedFile, statechartReceiptMemo, statechartReceiptSchema, type AdvancedFile, type StatechartReceipt } from "./PstackAdvancedArtifacts";

export function statechartCommand(input: { executable: string; runtime: string; spec: string; config: string; view?: string; out: string; shell: "bash" | "powershell"; electron?: boolean }) {
  const quote = input.shell === "powershell" ? (value: string) => "'" + value.replaceAll("'", "''") + "'" : (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const args = [input.executable, "--disable-warning=ExperimentalWarning", input.runtime, input.spec, "--config", input.config, ...(input.view ? ["--view", input.view] : []), "--out", input.out];
  const command = args.map(quote).join(" ");
  return input.shell === "powershell"
    ? (input.electron ? "$env:ELECTRON_RUN_AS_NODE='1'; " : "") + "& " + command + "; exit $LASTEXITCODE"
    : (input.electron ? "ELECTRON_RUN_AS_NODE=1 " : "") + command;
}

async function installedRuntime() {
  const { app } = await import("electron");
  return join(app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "vendor"), "pstack-statechart", "scripts", "statechart.ts");
}

export function createPstackStatechartTool(options: WorkflowOptions, dependencies: { runtimePath?: () => Promise<string> } = {}): ToolRegistration {
  return defineTool({
    name: "pstack_statechart", replay: "safe", executionMode: "sequential",
    description: "Run the bundled, pinned pstack TLC statechart compiler through the existing native shell. Supply task-relative .tla/.cfg and optional pure view module, plus a new output directory. Returns a native execution receipt and hashes of report.md, tlc.out and optional chart.mmd. Exit 1 is a real counterexample; missing Java/TLC or execution errors remain blocked. No new execution kernel is started.",
    parameters: Type.Object({
      spec: Type.String(), config: Type.Optional(Type.String()), view: Type.Optional(Type.String()), out: Type.String(),
      inputs: Type.Optional(Type.Array(Type.String(), { description: "Additional local model modules or view dependencies that belong to this check; include every project file the model imports." })),
      shell: Type.Optional(Type.Union([Type.Literal("bash"), Type.Literal("powershell")])),
    }),
    async execute(args, api, ctx) {
      try {
        checked(options, ctx); await owner(api, ctx);
        const run = await state(api, ctx);
        if (!run || run.task !== options.taskId || run.phase !== "running" || readOnlyCodingTag(run.tagId) || !runSettings(run).skills.statechart?.enabled ||
          !["statechart", "create-formal-verification-skill", "maintain-formal-verification-skill"].includes(currentAdvancedMethod(run) ?? ""))
          throw Error("Statechart requires an active owned workflow with the statechart method enabled.");
        const cached = await api.memo<StatechartReceipt>(statechartReceiptMemo, ctx);
        if (cached) {
          const receipt = statechartReceiptSchema.parse(cached);
          if (receipt.workflowRun !== run.run || receipt.taskId !== api.taskId) throw Error("The statechart receipt belongs to a different workflow.");
          await checkAdvancedArtifact(receipt, { cwd: options.cwd, signal: ctx.abortSignal });
          return success(receipt);
        }
        const spec = workspaceDocumentPath(args.spec, "TLA+ 模型"), config = workspaceDocumentPath(args.config ?? spec.replace(/\.tla$/i, ".cfg"), "TLC 配置"),
          view = args.view ? workspaceDocumentPath(args.view, "状态图视图") : undefined, out = workspaceDocumentPath(args.out, "状态图目录");
        if (!/\.tla$/i.test(spec)) throw Error("Statechart expects a .tla specification.");
        const shell = args.shell ?? (currentPlatformId === "windows" ? "powershell" : "bash");
        const intentKey = "pstack-statechart-input";
        const prior = await api.memo<{ workflowRun: number; command: string; files: AdvancedFile[]; spec: string; config: string; view?: string; out: string; shell: "bash" | "powershell" }>(intentKey, ctx);
        const paths = [...new Set([spec, config, ...(view ? [view] : []), ...(args.inputs ?? []).map(p => workspaceDocumentPath(p, "模型依赖"))])];
        const files: AdvancedFile[] = [];
        for (const path of paths) {
          const file = await inspectAdvancedFile(options.cwd, path, "input", { signal: ctx.abortSignal });
          files.push({ path: file.path, digest: file.digest, role: "input" });
        }
        await guardedWorkspaceTarget(options.cwd, out + "/report.md");
        if (!prior) {
          const existing = await readdir(join(options.cwd, out)).catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
          if (existing.length) throw Error("Statechart output must be a new or empty directory: " + out);
        }
        const command = prior?.command ?? statechartCommand({ executable: process.execPath, runtime: await (dependencies.runtimePath ?? installedRuntime)(),
          spec, config, view, out, shell, electron: !!process.versions.electron });
        const intent = prior ?? await api.memo(intentKey, { workflowRun: run.run, command, files, spec, config, ...(view && { view }), out, shell }, ctx);
        if (intent.workflowRun !== run.run || intent.spec !== spec || intent.config !== config || intent.view !== view || intent.out !== out || intent.shell !== shell ||
          JSON.stringify(intent.files) !== JSON.stringify(files)) throw Error("Statechart inputs changed during recovery. Start a fresh invocation.");
        checked(options, ctx);
        const result = await api.executeTool(shell, { command: intent.command }, ctx, { key: "statechart-execution", progress: true });
        const native = matchingNativeExecutionReceipt(result, { taskId: options.taskId, conversationId: Number(api.conversationId), toolTaskId: Number(result.taskId), toolName: shell });
        const actualExit = z.object({ exitCode: z.number().int() }).safeParse(result.structuredOutput).data?.exitCode;
        if (!native || ![0, 1].includes(native.exitCode ?? -1) || native.exitCode !== actualExit || native.transport !== "returned" || native.settlement !== "consumed" ||
          native.status !== (native.exitCode === 0 ? "passed" : "failed") || native.exitCode === 0 && result.isError)
          throw Error("Statechart did not complete: " + JSON.stringify(result.structuredOutput ?? result.diagnostics).slice(0, 4000));
        const current = await state(api, ctx);
        checked(options, ctx);
        if (current?.run !== run.run || current.task !== options.taskId || current.phase !== "running") throw Error("The owning workflow changed during the statechart run.");
        await checkAdvancedArtifact({ files: intent.files }, { cwd: options.cwd, signal: ctx.abortSignal });
        const names = await readdir(join(options.cwd, out));
        if (!names.includes("report.md") || !names.includes("tlc.out")) throw Error("The compiler did not publish report.md and tlc.out.");
        for (const name of names) {
          if (!/^(?:report\.md|chart\.mmd|tlc(?:-[\w]+)?\.out)$/.test(name)) throw Error("Unexpected statechart artifact: " + name);
          const file = await inspectAdvancedFile(options.cwd, out + "/" + name, "artifact", { signal: ctx.abortSignal });
          if (!file.size) throw Error("Statechart produced an empty artifact: " + file.path);
          files.push({ path: file.path, digest: file.digest, role: "artifact" });
        }
        const receipt: StatechartReceipt = { version: 1, kind: "statechart-execution", workflowRun: run.run, taskId: Number(api.taskId),
          shellTaskId: Number(result.taskId), executionId: native.executionId, command: intent.command, exitCode: native.exitCode as 0 | 1,
          spec, config, ...(view && { view }), out, hasChart: names.includes("chart.mmd"), files };
        await api.memo(statechartReceiptMemo, receipt, ctx);
        return success(receipt);
      } catch (error) { ctx.abortSignal?.throwIfAborted(); return failure(error); }
    },
  });
}
