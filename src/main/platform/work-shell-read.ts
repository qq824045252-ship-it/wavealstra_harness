/** Trusted local read commands. No PATH lookup, shell startup, or user environment. */
import { spawn } from "node:child_process";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { currentPlatformId } from "./index";
import { resourcePathContains } from "./resource-identity";

export interface ScopedReadCommand { command: "ls" | "wc" | "stat" | "du" | "od" | "sha256sum" | "sha1sum" | "md5sum"; flags: string[] }

/** Run before resource hashing as well as before execution: never hash a device/FIFO or outside file. */
export function validateWorkReadPath(root: string, input: string): string {
  const requested = resolve(root, input), canonicalRoot = realpathSync(root);
  if (!resourcePathContains(resolve(root), requested)) throw new Error("只读校验路径不在当前工作区内");
  const canonical = realpathSync(requested);
  if (!resourcePathContains(canonicalRoot, canonical)) throw new Error("只读校验路径通过符号链接越出当前工作区");
  const info = statSync(canonical);
  if (!info.isFile() && !info.isDirectory()) throw new Error("只读校验仅支持普通文件或目录，不能读取设备、FIFO 或套接字");
  if (info.isFile() && info.nlink > 1) throw new Error("只读校验不接受多硬链接文件，请使用工作区内独立文件副本");
  return canonical;
}

function trustedExecutable(command: ScopedReadCommand["command"]): string {
  const executable = realpathSync(`/usr/bin/${command}`);
  for (let path = executable;; path = dirname(path)) {
    const info = lstatSync(path);
    if ((info.mode & 0o022) !== 0) throw new Error("系统只读工具的写权限不可信");
    // User namespaces may map immutable root-owned mounts to nobody. They remain
    // acceptable only when the process cannot write any part of the fixed system path.
    if (info.uid !== 0) {
      let immutableToProcess = false;
      try { accessSync(path, constants.W_OK); } catch (error) {
        immutableToProcess = error instanceof Error && "code" in error && ["EROFS", "EACCES", "EPERM"].includes(String(error.code));
      }
      if (!immutableToProcess) throw new Error("系统只读工具路径可由当前用户替换");
    }
    if (path === executable && !info.isFile()) throw new Error("系统只读工具不是普通文件");
    if (dirname(path) === path) break;
  }
  return executable;
}

export async function executeWorkReadCommand(root: string, input: string, command: ScopedReadCommand,
  signal?: AbortSignal, timeoutMs = 30_000): Promise<{ output: string; truncated: boolean; exitCode: number; executable: string; argv: string[]; requestedPath: string; evidenceSource: string }> {
  if (currentPlatformId !== "linux") throw new Error("当前平台尚未提供可信只读命令后端；请使用内置 read，不能把推算当成真实命令输出");
  signal?.throwIfAborted();
  const canonical = validateWorkReadPath(root, input);
  // O_NONBLOCK avoids a raced FIFO open; fstat and the descriptor realpath are checked before spawning.
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if ((!info.isFile() && !info.isDirectory()) || info.isFile() && info.nlink > 1)
      throw new Error("只读目标在打开时已变化或不是独立普通文件/目录");
    const opened = realpathSync(`/proc/self/fd/${fd}`);
    if (!resourcePathContains(realpathSync(root), opened) || opened !== canonical) throw new Error("只读目标在打开时已越出工作区或被替换");
    const current = statSync(canonical);
    if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("只读目标在打开时已被替换");
    if (command.command !== "ls" && command.command !== "stat" && !info.isFile())
      throw new Error("此只读校验命令仅接受一个普通文件，不能递归扫描目录");
    const executable = trustedExecutable(command.command);
    // Inherited descriptor pins the checked inode. The output deliberately retains this actual argv path.
    const target = "/proc/self/fd/3";
    const flags = command.command === "stat" ? ["--dereference"] : command.command === "du" ? ["--dereference", ...command.flags] : command.command === "ls" ? ["-H", ...command.flags] : command.flags;
    const argv = [...flags, "--", target];
    return await new Promise((resolveResult, reject) => {
      const child = spawn(executable, argv, { cwd: realpathSync(root), shell: false,
        env: { LANG: "C", LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe", fd] });
      const chunks: Buffer[] = []; let length = 0, truncated = false, failure: Error | undefined;
      const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
      const collect = (chunk: Buffer) => {
        const remaining = 100_000 - length;
        if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); length += Math.min(remaining, chunk.length); }
        if (chunk.length > remaining) { truncated = true; stop(new Error("只读命令输出超出安全上限；请缩小目标，未得到完整校验证据")); }
      };
      child.stdout!.on("data", collect); child.stderr!.on("data", collect);
      const abort = () => stop(new Error("只读校验已取消"));
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(() => stop(new Error("只读校验超时，未得到完整校验证据")), Math.min(timeoutMs, 30_000));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
      child.on("error", error => { cleanup(); reject(error); });
      child.on("close", code => {
        cleanup(); if (failure) { reject(failure); return; }
        let after;
        try { after = fstatSync(fd); } catch (error) { reject(error); return; }
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
          reject(new Error("只读校验期间目标变化，结果不能用作当前版本验收")); return;
        }
        resolveResult({ output: Buffer.concat(chunks).toString("utf8"), truncated, exitCode: code ?? 1,
          executable, argv, requestedPath: canonical, evidenceSource: "system-command-scoped-file-descriptor" });
      });
    });
  } finally { closeSync(fd); }
}
