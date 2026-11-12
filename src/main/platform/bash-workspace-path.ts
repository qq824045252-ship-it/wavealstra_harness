import { realpath } from "node:fs/promises";
import { win32 } from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { currentPlatformId, type PlatformId } from "./index";

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

/** Retains original tool validation, filesystem semantics and artifact registration. */
export function withWindowsBashWorkspacePath(tool: ToolRegistration, platform: PlatformId = currentPlatformId): ToolRegistration {
  if (platform !== "windows" || !["read", "write", "edit", "register_artifact"].includes(tool.name)) return tool;
  return { ...tool, execute: async (args, api, context) => {
    const input = (args as { path?: unknown }).path;
    const raw = tool.name === "read" && typeof input === "string" ? input.replace(/^@/, "") : input;
    // Native drives, UNC, relative paths and file URLs must not be remapped.
    if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//")) return tool.execute(args, api, context);
    if (/[\r\n\0]/.test(raw)) throw new Error("Invalid multiline POSIX path; use a native Windows or relative path.");
    if (!api.env) throw new Error("Native execution environment is unavailable");
    let output = "";
    const probe = await api.env.exec("printf '%s\\n' \"$PWD\"; cygpath -am -- \"$PWD\"", {
      timeout: 3, onOutput: text => { if (output.length < 8192) output += text; },
    }, context);
    const lines = output.trim().split(/\r?\n/);
    if (!probe.ok || probe.value.exitCode !== 0 || lines.length !== 2 || output.length >= 8192) {
      throw new Error("Cannot verify this Bash path without guessing; use a native Windows or relative path.");
    }
    const path = mapVerifiedBashWorkspacePath(raw, api.env.cwd, lines[0]!, lines[1]!);
    // A verified lexical alias must not silently cross an existing junction/symlink.
    const root = await realpath(api.env.cwd);
    let ancestor = path;
    for (;;) {
      try {
        const actual = await realpath(ancestor), relative = win32.relative(root, actual);
        if (relative === ".." || relative.startsWith("..\\") || win32.isAbsolute(relative)) throw new Error("POSIX workspace path crosses a symlink outside the workspace");
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || win32.dirname(ancestor) === ancestor) throw error;
        ancestor = win32.dirname(ancestor);
      }
    }
    return tool.execute({ ...(args as Record<string, unknown>), path }, api, context);
  } };
}
