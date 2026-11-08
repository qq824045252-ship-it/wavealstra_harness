/** Complete, deliberately tiny native bash grammar. No redirects, expansions,
 * pipelines, flags, multiple commands or user-defined executable names. */
export function workShellRead(name: string, args: unknown): { path: string; directory: boolean } | undefined {
  if (name !== "bash" || !args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return undefined;
  const command = args.command.trim();
  if (/[;&|<>`$\\\r\n*?\[\]{}()!]/.test(command)) return undefined;
  if (command === "pwd") return { path: ".", directory: true };
  if (command === "ls") return { path: ".", directory: true };
  const match = /^(cat|ls)\s+(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'"\\]+))\s*$/.exec(command);
  const path = match?.[2] ?? match?.[3] ?? match?.[4];
  if (!match || !path || path.startsWith("-") || path.startsWith("~")) return undefined;
  return { path, directory: match[1] === "ls" };
}

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";

/** The read allowance is backed by host file APIs, never shell -c/PATH/startup
 * scripts or exported functions. Every other command retains the native shell. */
export function withWorkShellRead(tool: ToolRegistration): ToolRegistration {
  if (tool.name !== "bash") return tool;
  return { ...tool, execute: async (args, api, context) => {
    const read = workShellRead(tool.name, args);
    if (!read) return tool.execute(args, api, context);
    const timeout = (args as { timeout?: number }).timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647 / 1000)) throw new Error("Invalid timeout: must be a finite positive number within the native limit");
    if (!api.env) throw new Error("读取缺少当前原生执行环境");
    context.abortSignal?.throwIfAborted();
    const path = getOrThrow(await api.env.absolutePath(read.path, context));
    let output: string;
    let truncated = false;
    if ((args as { command: string }).command.trim() === "pwd") output = `${path}\n`;
    else if (read.directory) {
      const info = getOrThrow(await api.env.fileInfo(path, context));
      const names = info.kind === "directory" ? getOrThrow(await api.env.listDir(path, context)).map(item => item.name).filter(name => !name.startsWith(".")).sort() : [info.name];
      output = `${names.slice(0, 2000).join("\n")}\n`;
      truncated = names.length > 2000;
    } else {
      const reader = getOrThrow(await api.env.openBinaryReader(path, undefined, context));
      try {
        const info = getOrThrow(await reader.info(context));
        const size = Math.min(info.size, 100_000);
        output = Buffer.from(getOrThrow(await reader.read(0, size, context))).toString("utf8");
        truncated = info.size > size;
      } finally { await reader.close(context); }
    }
    context.abortSignal?.throwIfAborted();
    if (truncated) output += "\n[读取结果已截断，请使用 read 分段读取]";
    api.output(output);
    return { structuredOutput: { output, truncated, exitCode: 0 } };
  } };
}
