import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { checkWorkspaceStamp, pstackCheckReceipt } from "../pstack/PstackVerificationEvidence";
import { projectVerificationWorkspace } from "../pstack/PstackWorkspace";

export const PROJECT_VERIFY_TOOL = "project_verify";
export const PROJECT_CHECK_NAME_PATTERN = "^(?:typecheck|test(?::[a-zA-Z0-9][a-zA-Z0-9:_-]*)?)$";
export const PROJECT_VERIFY_CHILD_KEY = "project-verification";
export type ProjectVerificationManager = "npm" | "pnpm";

const parameters = Type.Object({
  script: Type.String({ pattern: PROJECT_CHECK_NAME_PATTERN, maxLength: 128 }),
  manager: Type.Optional(Type.Union([Type.Literal("npm"), Type.Literal("pnpm")])),
  args: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\x00-\\x1f\\x7f]+$" }), { maxItems: 12 })),
}, { additionalProperties: false });

type Check = { fingerprint: string; toolTaskId: number; checkedAt: number; executionId: string };

const ProjectChecks = defineDoc({ kind: "mybuddy.project-checks", version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false,
  initial: () => ({ checks: {} as Record<string, Check> }) });

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const checkKey = (script: string, args: readonly string[], manager: ProjectVerificationManager) =>
  sha(JSON.stringify(manager === "pnpm" ? [script, args] : [manager, script, args]));
const shellWord = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function projectVerificationShellCommand(script: string, args: readonly string[], manager: ProjectVerificationManager = "pnpm"): string {
  const command = manager === "npm" && script === "test" ? "npm test" : manager + " run " + shellWord(script);
  return [command, ...(manager === "npm" && args.length ? ["--"] : []), ...args.map(shellWord)].join(" ");
}

async function localEnvironmentFile(path: string, signal?: AbortSignal) {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size > 16 * 1024 * 1024 || await realpath(path) !== path)
      throw new Error("项目校验无法确认本地输入 " + path);
    const digest = sha(await readFile(path, { signal }));
    const after = await lstat(path);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("项目校验的本地输入正在变化 " + path);
    return digest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

async function projectStamp(directory: string, signal?: AbortSignal) {
  const state = await projectVerificationWorkspace(directory, signal);
  const environment = Object.entries(process.env).filter(([key]) =>
    /^(?:path|pathext|ci|display|wayland_display|lang|lc_.*|tz|home|userprofile|node_.*|pnpm_.*|npm_config_.*|electron_.*|mybuddy_.*)$/iu.test(key)).sort();
  const localInputs = [".env", ".env.local", ".env.test", ".env.test.local", ".npmrc", "node_modules/.modules.yaml",
    "node_modules/.package-lock.json", "node_modules/.pnpm/lock.yaml"];
  const paths = [...new Set([state.root, state.cwd].flatMap(root => localInputs.map(path => join(root, path))))];
  const files = await Promise.all(paths.map(path => localEnvironmentFile(path, signal)));
  const fingerprint = sha(JSON.stringify([state.fingerprint, process.platform, process.arch, process.execPath, process.versions, environment, paths, files]));
  return { ...checkWorkspaceStamp({ ...state, fingerprint }, state.head), head: state.head, clean: state.clean };
}

export async function readCurrentProjectVerification(api: ToolExecutionApi, ctx: Context, cwd: string, scripts: readonly string[],
  managers?: Readonly<Record<string, readonly ProjectVerificationManager[]>>) {
  const current = await projectStamp(cwd, ctx.abortSignal);
  const saved = await api.snapshot(ProjectChecks, api.conversationId, ctx);
  return { head: current.head, clean: current.clean && current.coverageComplete,
    verified: current.coverageComplete ? scripts.filter(script => (managers?.[script] ?? ["pnpm"]).every(manager =>
      saved?.checks[checkKey(script, [], manager)]?.fingerprint === current.fingerprint)) : [] };
}

export function createDurableProjectVerification({ taskId, cwd }: { taskId: string; cwd: string }): ToolRegistration {
  return defineTool({ name: PROJECT_VERIFY_TOOL, parameters, replay: "safe", executionMode: "sequential",
    description: "Run a named local package.json typecheck, test or test:* script in the task's Git workspace. Use manager: npm when the user specifies npm, otherwise the default is pnpm. Successful unchanged observations are reused. Use only checks scoped to this workspace, not commands that deploy or change another system.",
    async execute({ script, manager = "pnpm", args = [] }, api, ctx) {
      const respond = (value: object, isError = false) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }], isError });
      try {
        const agent = await api.agent(ctx);
        if (!agent.cwd || await realpath(agent.cwd) !== await realpath(cwd)) throw new Error("项目校验缺少当前任务目录");
        const key = checkKey(script, args, manager);
        const memoKey = "project-verification-input";
        const prior = await api.memo<{ key: string; stamp: Awaited<ReturnType<typeof projectStamp>> }>(memoKey, ctx);
        const manifest = join(await realpath(cwd), "package.json");
        if (await realpath(manifest) !== manifest) throw new Error("项目校验要求当前任务目录中的 package.json");
        const available = JSON.parse(await readFile(manifest, { encoding: "utf8", signal: ctx.abortSignal })).scripts;
        if (!Object.hasOwn(available ?? {}, script) || typeof available[script] !== "string" || !available[script].trim())
          throw new Error("package.json 未声明校验脚本 " + script);
        const observed = await projectStamp(cwd, ctx.abortSignal);
        if (prior && prior.key !== key) throw new Error("项目校验参数与持久调用不一致");
        if (prior && prior.stamp.fingerprint !== observed.fingerprint)
          throw new Error("恢复项目校验时输入已变化。请对当前版本发起新的校验。");
        const saved = (await api.snapshot(ProjectChecks, api.conversationId, ctx))?.checks[key];
        if (observed.coverageComplete && saved?.fingerprint === observed.fingerprint)
          return respond({ script, args, outcome: "passed", reused: true, ...saved });
        const before = prior?.stamp ?? (await api.memo(memoKey, { key, stamp: observed }, ctx)).stamp;
        const command = projectVerificationShellCommand(script, args, manager);
        const result = await api.executeTool("bash", { command, timeout: 600 }, ctx, { key: PROJECT_VERIFY_CHILD_KEY, progress: true });
        const after = await projectStamp(cwd, ctx.abortSignal);
        const receipt = pstackCheckReceipt({ taskId, conversationId: Number(api.conversationId), workflowRun: Number(api.taskId),
          operationTaskId: Number(api.taskId), shell: "bash", command, measurement: false, before, after, result });
        const executionId = receipt.checkIdentity.executionId;
        if (!receipt.passed || !executionId) return respond({ script, args, outcome: receipt.passed ? "tool_error" : receipt.outcome,
          exitCode: receipt.exitCode, output: receipt.output, error: "error" in receipt ? receipt.error : "缺少本机校验执行回执" }, true);
        const output = (result.structuredOutput as { output?: string } | undefined)?.output ?? "";
        if (/^\s*(?:#|ℹ)\s*fail\s+[1-9]\d*\s*$/imu.test(output))
          return respond({ script, args, outcome: "assertion_failed", exitCode: receipt.exitCode, output: receipt.output,
            error: "测试报告有失败项，脚本退出状态却为 0。请修正项目测试脚本的退出状态。" }, true);
        const recorded = { fingerprint: after.fingerprint, toolTaskId: receipt.toolTaskId, checkedAt: api.now(), executionId };
        await api.commit(async tx => {
          const { checks } = await tx.doc(ProjectChecks, api.conversationId);
          checks[key] = recorded;
          const oldest = Object.entries(checks).sort((a, b) => b[1].checkedAt - a[1].checkedAt).slice(64);
          for (const [expired] of oldest) delete checks[expired];
        }, ctx);
        return respond({ script, args, outcome: "passed", reused: false, ...recorded, output: receipt.output });
      } catch (error) {
        ctx.abortSignal?.throwIfAborted();
        return respond({ script, outcome: "tool_error", error: error instanceof Error ? error.message : String(error) }, true);
      }
    },
  });
}
