import { executeWorkReadCommand, validateWorkReadPath, type ScopedReadCommand } from "../../platform/work-shell-read";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** Complete literal-only grammar. Accepted verification commands use a pinned
 * system executable and file descriptor, never shell/PATH or user functions. */
export function workShellRead(name: string, args: unknown): { path: string; directory: boolean; verification?: ScopedReadCommand } | undefined {
  if (name !== "bash" || !args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return undefined;
  const command = args.command.trim();
  if (/[;&|<>`$\\\r\n*?\[\]{}()!\x00-\x1f]/.test(command)) return undefined;
  if (command === "pwd" || command === "ls") return { path: ".", directory: true };
  const tokens = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s'"\\]+/g);
  if (!tokens) return undefined;
  let offset = 0;
  for (const [index, token] of tokens.entries()) {
    if (index > 0 && command[offset] !== " ") return undefined;
    while (command[offset] === " ") offset++;
    if (!command.startsWith(token, offset)) return undefined;
    offset += token.length;
  }
  if (offset !== command.length) return undefined;
  const words = tokens.map(token => /^['"]/.test(token) ? token.slice(1, -1) : token);
  const verb = words.shift();
  const path = words.at(-1);
  if (!path || path.startsWith("-") || path.startsWith("~")) return undefined;
  const flags = words.slice(0, -1);
  if ((verb === "cat" || verb === "ls") && !flags.length) return { path, directory: verb === "ls" };
  const supported = verb === "ls" ? flags.length === 1 && /^-[lA1]+$/.test(flags[0])
    : verb === "wc" ? flags.length === 1 && /^-[cl]+$/.test(flags[0])
    : verb === "stat" || verb === "sha256sum" || verb === "sha1sum" || verb === "md5sum" ? flags.length === 0
    : verb === "du" ? flags.length === 1 && flags[0] === "-b"
    : verb === "od" ? flags.length === 1 && flags[0] === "-c" : false;
  if (!supported) return undefined;
  return { path, directory: verb === "ls", verification: { command: verb as ScopedReadCommand["command"], flags } };
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
    if (read.verification) {
      if (!(api.env instanceof NodeExecutionEnv)) throw new Error("可信系统只读校验要求本机执行环境");
      const result = await executeWorkReadCommand(api.env.cwd, path, read.verification, context.abortSignal,
        timeout === undefined ? undefined : timeout * 1000);
      api.output(result.output + `\n[真实系统只读校验：${result.executable} ${result.argv.join(" ")}；文件描述符绑定目标 ${result.requestedPath}]`);
      return { structuredOutput: result };
    }
    if (api.env instanceof NodeExecutionEnv) validateWorkReadPath(api.env.cwd, path);
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
