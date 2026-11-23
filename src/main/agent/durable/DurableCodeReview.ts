import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { CodeReviewService } from "../CodeReviewService";
import { powerShellLiteralContentTarget } from "./DurableArtifactRegistration";

export interface DurableCodeReview {
  review: Pick<CodeReviewService, "capture">;
  taskId: string;
  workspace: string;
}

export function isNativeReviewWrite(name: string): boolean {
  return name === "write" || name === "edit";
}

function shellMutation(name: string, args: unknown): { path: string; deleting: boolean } | undefined {
  if (!args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return undefined;
  const command = args.command.trim();
  if (name === "powershell") {
    const contentPath = powerShellLiteralContentTarget(command);
    if (contentPath) return { path: contentPath, deleting: false };
    const match = /^Remove-Item[ \t]+-LiteralPath[ \t]+'((?:[^'\r\n’‘]|'')+)'(?:[ \t]+-ErrorAction[ \t]+Stop)?$/i.exec(command);
    if (match?.[1]) return { path: match[1].replaceAll("''", "'"), deleting: true };
  }
  if (name === "bash") {
    // Only a single, literal file path. Directory deletion, expansion, flags and compound commands
    // cannot establish a reviewable file mutation from the shell's result.
    const match = /^rm[ \t]+(?:--[ \t]+)?(?:'([^'\r\n]+)'|"([\p{L}\p{N}_.@/ -]+)"|([\p{L}\p{N}_.@/-]+))$/u.exec(command);
    const path = match?.[1] ?? match?.[2] ?? match?.[3];
    if (path && !path.startsWith("-") && !path.includes("\\")) return { path, deleting: true };
  }
}

/** Observe the exact env.writeFile call made by Pi, inside the coordinated mutation lease. */
export async function withCodeReviewWrite<T extends { isError?: boolean; structuredOutput?: unknown }>(
  owner: DurableCodeReview, name: string, args: unknown, api: ToolExecutionApi, context: Context,
  execute: (api: ToolExecutionApi) => Promise<T>,
): Promise<T> {
  const env = api.env;
  if (!(env instanceof NodeExecutionEnv)) return execute(api);
  if (isNativeReviewWrite(name)) {
    const observedEnv = new Proxy(env, {
      get(target, prop) {
        if (prop === "writeFile") {
          return async (...input: Parameters<NodeExecutionEnv["writeFile"]>) => {
            const [path, content] = input;
            const complete = owner.review.capture(owner.taskId, owner.workspace, path);
            const result = await target.writeFile(...input);
            if (result.ok) await complete?.(Buffer.from(content));
            return result;
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const observedApi = new Proxy(api, {
      get(target, prop) {
        if (prop === "env") return observedEnv;
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return execute(observedApi);
  }

  const mutation = shellMutation(name, args);
  if (!mutation) return execute(api);
  const resolved = await env.absolutePath(mutation.path, context);
  const complete = resolved.ok ? owner.review.capture(owner.taskId, owner.workspace, resolved.value) : undefined;
  const result = await execute(api);
  const output = result.structuredOutput;
  if (!result.isError && output && typeof output === "object" && "exitCode" in output && output.exitCode === 0 &&
    "truncated" in output && output.truncated === false && "output" in output &&
    typeof output.output === "string" && !output.output.trim()) {
    await complete?.(mutation.deleting ? null : undefined);
  }
  return result;
}
