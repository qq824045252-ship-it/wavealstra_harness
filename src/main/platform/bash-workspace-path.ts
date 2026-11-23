import { realpath } from "node:fs/promises";
import { win32 } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { resolveToolPath, type FileMutationPathResolver } from "@earendil-works/pi-durable/tools";
import { currentPlatformId, type PlatformId } from "./index";

type BashWorkspaceTarget = { cwd: string; path: string };
export const FILE_MUTATION_TARGET_MEMO = "mybuddy.file-mutation-target";
export type FileMutationTarget = BashWorkspaceTarget & { bashAlias?: true };

/** Only a verified cwd alias crosses shell/native namespaces; never guess global MSYS mounts. */
export function mapVerifiedBashWorkspacePath(path: string, cwd: string, shellCwd: string, nativeCwd: string): string {
  if (win32.resolve(nativeCwd).toLowerCase() !== win32.resolve(cwd).toLowerCase()
    || !/^[A-Za-z]:[\\/]/.test(nativeCwd) || !shellCwd.startsWith("/") || shellCwd.startsWith("//")) {
    throw new Error("Bash cwd does not match the native workspace; use a native Windows or relative path.");
  }
  const alias = shellCwd.replace(/\/+$/, "");
  if (path !== alias && !path.startsWith(alias + "/")) {
    throw new Error("POSIX path is outside the verified Bash workspace alias; use a native Windows or relative path.");
  }
  const mapped = win32.resolve(cwd, path.slice(alias.length).replace(/^\//, ""));
  const relative = win32.relative(cwd, mapped);
  if (relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) {
    throw new Error("POSIX path escapes the verified workspace; use an explicit native path.");
  }
  return mapped;
}

export function windowsBashWorkspaceAlias(path: unknown, platform: PlatformId = currentPlatformId): string | undefined {
  if (platform !== "windows" || typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined;
  if (/[\r\n\0]/.test(path)) throw new Error("Invalid multiline POSIX path; use a native Windows or relative path.");
  return path;
}

async function assertBashWorkspaceTarget({ cwd, path }: BashWorkspaceTarget): Promise<void> {
  const root = await realpath(cwd);
  let ancestor = path;
  for (;;) {
    try {
      const actual = await realpath(ancestor), relative = win32.relative(root, actual);
      if (relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) throw new Error("POSIX workspace path crosses a symlink outside the workspace");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || win32.dirname(ancestor) === ancestor) throw error;
      ancestor = win32.dirname(ancestor);
    }
  }
}

export async function resolveBashWorkspaceTarget(raw: string, env: ExecutionEnv | undefined, context: Context): Promise<BashWorkspaceTarget> {
  if (!env) throw new Error("Native execution environment is unavailable");
  let output = "";
  const probe = await env.exec("printf '%s\\n' \"$PWD\"; cygpath -am -- \"$PWD\"", {
    timeout: 3, onOutput: text => { if (output.length < 8192) output += text; },
  }, context);
  const lines = output.trim().split(/\r?\n/);
  if (!probe.ok || probe.value.exitCode !== 0 || lines.length !== 2 || output.length >= 8192) {
    throw new Error("Cannot verify this Bash path without guessing; use a native Windows or relative path.");
  }
  const target = { cwd: env.cwd, path: mapVerifiedBashWorkspacePath(raw, env.cwd, lines[0]!, lines[1]!) };
  await assertBashWorkspaceTarget(target);
  return target;
}

export async function resolveFileMutationTarget(raw: string, env: ExecutionEnv, context: Context): Promise<FileMutationTarget> {
  const alias = windowsBashWorkspaceAlias(raw.replace(/^@/, ""));
  if (alias !== undefined) return { ...await resolveBashWorkspaceTarget(alias, env, context), bashAlias: true };
  return { cwd: env.cwd, path: await resolveToolPath(env, raw, context) };
}

export const admittedFileMutationPath: FileMutationPathResolver = async (path, api, context) => {
  const target = await api.memo<FileMutationTarget>(FILE_MUTATION_TARGET_MEMO, context);
  if (!target || target.path !== path || target.cwd !== api.env?.cwd) throw new Error("Admitted file target changed before execution");
  // A Bash alias is limited to the workspace even if a junction changes after admission.
  if (target.bashAlias) await assertBashWorkspaceTarget(target);
  return target.path;
};

/** Retains original tool validation, filesystem semantics and artifact registration. */
export function withWindowsBashWorkspacePath(tool: ToolRegistration, platform: PlatformId = currentPlatformId): ToolRegistration {
  if (platform !== "windows" || !["read", "write", "edit", "register_artifact"].includes(tool.name)) return tool;
  return { ...tool, execute: async (args, api, context) => {
    const input = (args as { path?: unknown }).path;
    const alias = windowsBashWorkspaceAlias(tool.name === "read" && typeof input === "string" ? input.replace(/^@/, "") : input, platform);
    if (alias === undefined) return tool.execute(args, api, context);
    const { path } = await resolveBashWorkspaceTarget(alias, api.env, context);
    return tool.execute({ ...(args as Record<string, unknown>), path }, api, context);
  } };
}
