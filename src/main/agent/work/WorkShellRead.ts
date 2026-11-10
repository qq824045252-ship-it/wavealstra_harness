import { executeWorkReadCommand, validateWorkReadPath, type ScopedReadCommand } from "../../platform/work-shell-read";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

type ReadStep = { command: string } | { echo: string };
export interface WorkShellReadPlan { path: string; directory: boolean; verification?: ScopedReadCommand; echoExitCode?: boolean; steps?: ReadStep[] }

/** A literal semicolon sequence is interpreted by the host, never shell -c.
 * Parse the complete sequence before any step runs; reject expansions and control flow. */
function readSequence(command: string): ReadStep[] | undefined {
  if (/[&|<>`$\\\r\n*?\[\]{}()!\x00-\x1f]/.test(command)) return undefined;
  let quote = "", start = 0; const parts: string[] = [];
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) { if (c === quote) quote = ""; }
    else if (c === "'" || c === '\"') quote = c;
    else if (c === ";") { parts.push(command.slice(start, i).trim()); start = i + 1; }
  }
  if (quote || !parts.length) return undefined;
  parts.push(command.slice(start).trim());
  if (parts.length > 32 || parts.some(part => !part)) return undefined;
  const steps: ReadStep[] = [];
  for (const part of parts) {
    const echo = /^echo(?: +(?:"([^";]*)"|'([^';]*)'|([^\s'";]+)))?$/.exec(part);
    if (echo) {
      const text = echo[1] ?? echo[2] ?? echo[3] ?? "";
      if (text.startsWith("-") && echo[3]) return undefined;
      steps.push({ echo: text });
    } else {
      if (part.includes(";") || !workShellRead("bash", { command: part })) return undefined;
      steps.push({ command: part });
    }
  }
  return steps;
}

/** Complete literal-only grammar. Accepted verification commands use a pinned
 * system executable and file descriptor, never shell/PATH or user functions. */
export function workShellRead(name: string, args: unknown): WorkShellReadPlan | undefined {
  if (name !== "bash" || !args || typeof args !== "object" || !("command" in args) || typeof args.command !== "string") return undefined;
  const original = args.command.trim();
  const steps = readSequence(original);
  if (steps) return { path: ".", directory: true, steps };
  // This exact suffix is a host-rendered status query, not a second shell
  // command. Parse the entire preceding literal read before admitting anything.
  const statusSuffix = /; *echo +\$\?$/.exec(original);
  const command = statusSuffix ? original.slice(0, statusSuffix.index).trimEnd() : original;
  if (/[;&|<>`$\\\r\n*?\[\]{}()!\x00-\x1f]/.test(command)) return undefined;
  if (!statusSuffix && (command === "pwd" || command === "ls")) return { path: ".", directory: true };
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
  if (verb === "ls" && words.length === 1 && /^-[laA1]+$/.test(words[0]!)) words.push(".");
  const path = words.at(-1);
  if (!path || path.startsWith("-") || path.startsWith("~")) return undefined;
  const flags = words.slice(0, -1);
  if (!statusSuffix && (verb === "cat" || verb === "ls") && !flags.length) return { path, directory: verb === "ls" };
  const supported = verb === "ls" ? flags.length === 1 && /^-[laA1]+$/.test(flags[0])
    : verb === "wc" ? flags.length === 1 && /^-[cl]+$/.test(flags[0])
    : verb === "stat" || verb === "sha256sum" || verb === "sha1sum" || verb === "md5sum" ? flags.length === 0
    : verb === "du" ? flags.length === 1 && flags[0] === "-b"
    : verb === "od" ? flags.length === 1 && flags[0] === "-c" : false;
  if (!supported) return undefined;
  return { path, directory: verb === "ls", verification: { command: verb as ScopedReadCommand["command"], flags }, ...(statusSuffix ? { echoExitCode: true } : {}) };
}

import type { ToolRegistration } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";

/** A status query reports the actual command result, never echo's own success. */
export function presentWorkReadResult(result: Awaited<ReturnType<typeof executeWorkReadCommand>>, echoExitCode = false) {
  const exitCodeOutput = echoExitCode ? `${result.exitCode}\n` : "";
  return {
    output: result.output + exitCodeOutput + `\n[真实系统只读校验：${result.executable} ${result.argv.join(" ")}；文件描述符绑定目标 ${result.requestedPath}${echoExitCode ? "；退出码由宿主回显，未启动 Shell" : ""}]`,
    structuredOutput: { ...result, ...(echoExitCode ? { exitCodeOutput } : {}) },
  };
}

/** The read allowance is backed by host file APIs, never shell -c/PATH/startup
 * scripts or exported functions. Every other command retains the native shell. */
export function withWorkShellRead(tool: ToolRegistration, readonly: () => boolean = () => false): ToolRegistration {
  if (tool.name !== "bash") return tool;
  return { ...tool, description: `${tool.description}\n只读任务可使用本工具执行 pwd、ls、cat、wc、stat 等受支持的字面只读命令，由宿主直接读取，不启动交互终端。只读模式仍禁止写入和任意脚本。`, execute: async (args, api, context): Promise<Awaited<ReturnType<ToolRegistration["execute"]>>> => {
    const read = workShellRead(tool.name, args);
    if (!read) {
      if (readonly()) throw new Error("只读任务仅支持宿主字面读取，不能执行 Shell 或写入命令");
      return tool.execute(args, api, context);
    }
    const timeout = (args as { timeout?: number }).timeout;
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2_147_483_647 / 1000)) throw new Error("Invalid timeout: must be a finite positive number within the native limit");
    if (!api.env) throw new Error("读取缺少当前原生执行环境");
    context.abortSignal?.throwIfAborted();
    if (read.steps) {
      if (!(api.env instanceof NodeExecutionEnv)) throw new Error("可信只读序列要求本机执行环境");
      // Preflight all paths, then each leaf revalidates immediately before execution.
      for (const step of read.steps) if ("command" in step) {
        const leaf = workShellRead("bash", { command: step.command })!;
        validateWorkReadPath(api.env.cwd, leaf.path);
      }
      let completedSteps = 0;
      for (const step of read.steps) {
        context.abortSignal?.throwIfAborted();
        if ("echo" in step) { api.output(`${step.echo}\n`);  }
        else await withWorkShellRead(tool, readonly).execute({ ...(args as Record<string, unknown>), command: step.command }, api, context);
        completedSteps++;
      }
      return { structuredOutput: { completedSteps, evidenceSource: "host-interpreted-scoped-read-sequence" } };
    }
    const path = getOrThrow(await api.env.absolutePath(read.path, context));
    if (read.verification) {
      if (!(api.env instanceof NodeExecutionEnv)) throw new Error("可信系统只读校验要求本机执行环境");
      const result = await executeWorkReadCommand(api.env.cwd, path, read.verification, context.abortSignal,
        timeout === undefined ? undefined : timeout * 1000);
      const presented = presentWorkReadResult(result, read.echoExitCode);
      api.output(presented.output);
      return { structuredOutput: presented.structuredOutput };
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
