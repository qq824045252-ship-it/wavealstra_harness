/** Trusted local read commands. No PATH lookup, shell startup, or user environment. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, statSync, type Stats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { currentPlatformId, type PlatformId } from "./index";
import { resourcePathContains } from "./resource-identity";

export interface ScopedReadCommand { command: "ls" | "wc" | "stat" | "du" | "od" | "sha256sum" | "sha1sum" | "md5sum"; flags: string[] }

export interface WorkReadCommandResult { output: string; truncated: boolean; exitCode: number; executable: string; argv: string[]; requestedPath: string; evidenceSource: string }

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

/** Linux keeps the pinned system executables plus an inherited descriptor. Other
 * platforms answer the same scoped-read contract from host fs in this process:
 * no spawn, no PATH, no shell. The optional platform argument exists for tests;
 * production callers leave it at currentPlatformId. */
export async function executeWorkReadCommand(root: string, input: string, command: ScopedReadCommand,
  signal?: AbortSignal, timeoutMs = 30_000, platform: PlatformId = currentPlatformId): Promise<WorkReadCommandResult> {
  if (platform !== "linux") return executeHostWorkReadCommand(root, input, command, signal, timeoutMs);
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

/* ------------------------------------------------------------------------- */
/* Host fs backend (windows / macos): same commands, computed in this process. */
/* ------------------------------------------------------------------------- */

const HOST_EVIDENCE_SOURCE = "host-node-fs";
const OUTPUT_LIMIT = 100_000;
const OUTPUT_LIMIT_ERROR = "只读命令输出超出安全上限；请缩小目标，未得到完整校验证据";

interface HostReadGuard { signal?: AbortSignal; deadline: number }

/** A bounded string builder: exceeding the same 100k-character ceiling as the Linux
 * backend fails instead of returning a partial verification result. */
class HostReadOutput {
  private readonly parts: string[] = [];
  private length = 0;
  push(text: string): void {
    this.length += text.length;
    if (this.length > OUTPUT_LIMIT) throw new Error(OUTPUT_LIMIT_ERROR);
    this.parts.push(text);
  }
  toString(): string { return this.parts.join(""); }
}

function isErrno(error: unknown, codes: string[]): boolean {
  return error instanceof Error && "code" in error && codes.includes(String((error as { code: unknown }).code));
}

function hostGuard(guard: HostReadGuard): void {
  if (guard.signal?.aborted) throw new Error("只读校验已取消");
  if (Date.now() > guard.deadline) throw new Error("只读校验超时，未得到完整校验证据");
}

/** Validate through the shared path contract, then report a missing target plainly. */
function canonicalHostReadPath(root: string, input: string): string {
  let canonical: string;
  try { canonical = validateWorkReadPath(root, input); }
  catch (error) {
    if (isErrno(error, ["ENOENT", "ENOTDIR"])) throw new Error(`只读校验路径不存在：${resolve(root, input)}`);
    throw error;
  }
  if (realpathSync(resolve(root, input)) !== canonical) throw new Error("只读校验路径在解析时发生变化；请重试");
  return canonical;
}

function lsMode(info: Stats): string {
  const kind = info.isDirectory() ? "d" : info.isSymbolicLink() ? "l" : info.isFile() ? "-" : "?";
  const rwx = (bits: number): string => `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return kind + rwx((info.mode >> 6) & 7) + rwx((info.mode >> 3) & 7) + rwx(info.mode & 7);
}

function allocatedBlocks(info: Stats): number {
  return info.blocks > 0 ? info.blocks : Math.ceil(info.size / 512);
}

const LS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad2(value: number): string { return String(value).padStart(2, "0"); }

/** Same shape as the Linux backend (`TZ=UTC`, LANG=C): "Nov 11 11:06" or "Nov 11  2023". */
function gnuLsDate(timestampMs: number): string {
  const date = new Date(timestampMs);
  const day = String(date.getUTCDate()).padStart(2, " ");
  const recent = Math.abs(Date.now() - timestampMs) < 182 * 24 * 60 * 60 * 1000;
  return recent
    ? `${LS_MONTHS[date.getUTCMonth()]} ${day} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`
    : `${LS_MONTHS[date.getUTCMonth()]} ${day}  ${date.getUTCFullYear()}`;
}

function statTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs);
  const fraction = String(Math.floor(timestampMs % 1000)).padStart(3, "0");
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}.${fraction}000000 +0000`;
}

function longLsLine(info: Stats, name: string, linkTarget: string | undefined, sizeWidth: number, linkWidth: number): string {
  const suffix = linkTarget === undefined ? "" : ` -> ${linkTarget}`;
  return `${lsMode(info)} ${String(info.nlink).padStart(linkWidth)} ${info.uid} ${info.gid} ` +
    `${String(info.size).padStart(sizeWidth)} ${gnuLsDate(info.mtimeMs)} ${name}${suffix}\n`;
}

/** Field layout matched against GNU coreutils 8.32 `od -c`: width 4, named escapes
 * for C controls, bare 3-digit octal for the remaining controls and non-ASCII. */
function odField(byte: number): string {
  switch (byte) {
    case 0: return "  \\0";
    case 7: return "  \\a";
    case 8: return "  \\b";
    case 9: return "  \\t";
    case 10: return "  \\n";
    case 11: return "  \\v";
    case 12: return "  \\f";
    case 13: return "  \\r";
    default:
      if (byte < 0x20 || byte >= 0x7f) return ` ${byte.toString(8).padStart(3, "0")}`;
      return `   ${String.fromCharCode(byte)}`;
  }
}

function verifyRegularFile(fd: number, canonical: string): Stats {
  const info = fstatSync(fd);
  if (!info.isFile()) throw new Error("此只读校验命令仅接受一个普通文件，不能递归扫描目录");
  if (info.nlink > 1) throw new Error("只读校验不接受多硬链接文件，请使用工作区内独立文件副本");
  const current = statSync(canonical);
  if (current.dev !== info.dev || current.ino !== info.ino) throw new Error("只读目标在打开时已被替换");
  if (realpathSync(canonical) !== canonical) throw new Error("只读目标在打开时已越出工作区或被替换");
  return info;
}

function assertFileUnchanged(canonical: string, before: Stats): void {
  let after: Stats;
  try { after = statSync(canonical); } catch { throw new Error("只读校验期间目标变化，结果不能用作当前版本验收"); }
  let resolved: string;
  try { resolved = realpathSync(canonical); } catch { throw new Error("只读目标在打开时已越出工作区或被替换"); }
  if (resolved !== canonical) throw new Error("只读目标在打开时已越出工作区或被替换");
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
    throw new Error("只读校验期间目标变化，结果不能用作当前版本验收");
}

function assertDirectoryUnchanged(canonical: string): void {
  let after: Stats;
  try { after = statSync(canonical); } catch { throw new Error("只读校验期间目标变化，结果不能用作当前版本验收"); }
  let resolved: string;
  try { resolved = realpathSync(canonical); } catch { throw new Error("只读校验期间目标变化，结果不能用作当前版本验收"); }
  if (!after.isDirectory() || resolved !== canonical) throw new Error("只读校验期间目标变化，结果不能用作当前版本验收");
}

/** Open the checked descriptor, run the read, and re-check the target afterwards. */
function withVerifiedRegularFile<T>(canonical: string, guard: HostReadGuard, consume: (fd: number, info: Stats) => T): T {
  hostGuard(guard);
  const fd = openSync(canonical, constants.O_RDONLY);
  try {
    const info = verifyRegularFile(fd, canonical);
    const result = consume(fd, info);
    assertFileUnchanged(canonical, info);
    return result;
  } finally { closeSync(fd); }
}

function readBytes(fd: number, size: number, guard: HostReadGuard, onChunk: (chunk: Buffer, read: number) => void): void {
  const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < size) {
    hostGuard(guard);
    const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (read <= 0) break;
    offset += read;
    onChunk(buffer.subarray(0, read), read);
  }
}

function selectedFlags(command: ScopedReadCommand["command"], flags: string[], allowed: RegExp): Set<string> {
  const selected = new Set<string>();
  for (const flag of flags) {
    if (!allowed.test(flag)) throw new Error(`不支持的只读命令选项：${command} ${flag}`);
    for (const char of flag.slice(1)) selected.add(char);
  }
  return selected;
}

function hostLs(canonical: string, operand: string, info: Stats, flags: string[], guard: HostReadGuard): string {
  const selected = selectedFlags("ls", flags, /^-[laA1]+$/);
  const output = new HostReadOutput();
  if (info.isFile()) {
    if (selected.has("l")) output.push(longLsLine(info, operand, undefined, String(info.size).length, String(info.nlink).length));
    else output.push(`${operand}\n`);
    assertFileUnchanged(canonical, info);
    return output.toString();
  }
  const entries: { name: string; path: string }[] = [];
  for (const name of readdirSync(canonical)) {
    if (name.startsWith(".") && !selected.has("a") && !selected.has("A")) continue;
    entries.push({ name, path: join(canonical, name) });
  }
  if (selected.has("a")) entries.push({ name: ".", path: canonical }, { name: "..", path: dirname(canonical) });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (selected.has("l")) {
    const rows: { name: string; info: Stats; link: string | undefined }[] = [];
    let totalBlocks = 0;
    for (const entry of entries) {
      hostGuard(guard);
      let entryInfo: Stats;
      try { entryInfo = lstatSync(entry.path); }
      catch (error) { if (isErrno(error, ["ENOENT"])) continue; throw error; }
      let link: string | undefined;
      if (entryInfo.isSymbolicLink()) {
        try { link = readlinkSync(entry.path); } catch (error) { if (!isErrno(error, ["ENOENT"])) throw error; }
      }
      totalBlocks += allocatedBlocks(entryInfo);
      rows.push({ name: entry.name, info: entryInfo, link });
    }
    output.push(`total ${Math.ceil(totalBlocks / 2)}\n`);
    const linkWidth = Math.max(1, ...rows.map(row => String(row.info.nlink).length));
    const sizeWidth = Math.max(1, ...rows.map(row => String(row.info.size).length));
    for (const row of rows) output.push(longLsLine(row.info, row.name, row.link, sizeWidth, linkWidth));
  } else {
    for (const entry of entries) { hostGuard(guard); output.push(`${entry.name}\n`); }
  }
  assertDirectoryUnchanged(canonical);
  return output.toString();
}

function hostWc(canonical: string, operand: string, flags: string[], guard: HostReadGuard): string {
  const selected = selectedFlags("wc", flags, /^-[cl]+$/);
  if (selected.size === 0) throw new Error("不支持的只读命令选项：wc（仅支持 -c / -l）");
  const counts = withVerifiedRegularFile(canonical, guard, (fd, info) => {
    let lines = 0, bytes = 0;
    readBytes(fd, info.size, guard, (chunk, read) => {
      for (let index = 0; index < read; index++) if (chunk[index] === 0x0a) lines++;
      bytes += read;
    });
    return { lines, bytes };
  });
  const numbers: number[] = [];
  if (selected.has("l")) numbers.push(counts.lines);
  if (selected.has("c")) numbers.push(counts.bytes);
  const width = Math.max(...numbers.map(value => String(value).length));
  return `${numbers.map(value => String(value).padStart(width)).join(" ")} ${operand}\n`;
}

function hostStat(canonical: string, operand: string): string {
  const info = statSync(canonical);
  if (info.isFile() && info.nlink > 1) throw new Error("只读校验不接受多硬链接文件，请使用工作区内独立文件副本");
  if (!info.isFile() && !info.isDirectory()) throw new Error("只读校验仅支持普通文件或目录，不能读取设备、FIFO 或套接字");
  const type = info.isDirectory() ? "directory" : "regular file";
  const octal = (info.mode & 0o7777).toString(8).padStart(4, "0");
  const blockSize = info.blksize > 0 ? info.blksize : 4096;
  const rendered = [
    `  File: ${operand}`,
    `  Size: ${String(info.size).padEnd(10)}\tBlocks: ${String(info.blocks).padEnd(10)} IO Block: ${blockSize}  ${type}`,
    `Device: ${info.dev.toString(16)}h/${info.dev}d\tInode: ${info.ino}  Links: ${info.nlink}`,
    `Access: (${octal}/${lsMode(info)})  Uid: (${info.uid})   Gid: (${info.gid})`,
    `Access: ${statTimestamp(info.atimeMs)}`,
    `Modify: ${statTimestamp(info.mtimeMs)}`,
    `Change: ${statTimestamp(info.ctimeMs)}`,
    ` Birth: ${statTimestamp(info.birthtimeMs)}`,
  ].join("\n") + "\n";
  assertFileUnchanged(canonical, info);
  return rendered;
}

function hostDu(canonical: string, operand: string, flags: string[], guard: HostReadGuard): string {
  if (flags.length !== 1 || flags[0] !== "-b") throw new Error(`不支持的只读命令选项：du ${flags.join(" ")}`.trimEnd());
  const size = withVerifiedRegularFile(canonical, guard, (_fd, info) => info.size);
  return `${size}\t${operand}\n`;
}

function hostOd(canonical: string, flags: string[], guard: HostReadGuard): string {
  if (flags.length !== 1 || flags[0] !== "-c") throw new Error(`不支持的只读命令选项：od ${flags.join(" ")}`.trimEnd());
  const bytes = withVerifiedRegularFile(canonical, guard, (fd, info) => {
    // Four printable columns per byte: any file above the output ceiling overflows.
    if (info.size > OUTPUT_LIMIT) throw new Error(OUTPUT_LIMIT_ERROR);
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      hostGuard(guard);
      const read = readSync(fd, data, offset, info.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return data.subarray(0, offset);
  });
  const output = new HostReadOutput();
  for (let offset = 0; offset < bytes.length; offset += 16) {
    hostGuard(guard);
    let line = offset.toString(8).padStart(7, "0");
    for (let index = offset; index < Math.min(offset + 16, bytes.length); index++) line += odField(bytes[index] ?? 0);
    output.push(`${line}\n`);
  }
  output.push(`${bytes.length.toString(8).padStart(7, "0")}\n`);
  return output.toString();
}

function hostHash(canonical: string, operand: string, algorithm: "sha256" | "sha1" | "md5", guard: HostReadGuard): string {
  const digest = withVerifiedRegularFile(canonical, guard, (fd, info) => {
    const hash = createHash(algorithm);
    readBytes(fd, info.size, guard, chunk => hash.update(chunk));
    return hash.digest("hex");
  });
  return `${digest}  ${operand}\n`;
}

async function executeHostWorkReadCommand(root: string, input: string, command: ScopedReadCommand,
  signal?: AbortSignal, timeoutMs = 30_000): Promise<WorkReadCommandResult> {
  const guard: HostReadGuard = { signal, deadline: Date.now() + Math.min(timeoutMs, 30_000) };
  hostGuard(guard);
  const canonical = canonicalHostReadPath(root, input);
  const info = statSync(canonical);
  if (!info.isFile() && !info.isDirectory())
    throw new Error("只读校验仅支持普通文件或目录，不能读取设备、FIFO 或套接字");
  if (info.isFile() && info.nlink > 1)
    throw new Error("只读校验不接受多硬链接文件，请使用工作区内独立文件副本");
  if (command.command !== "ls" && command.command !== "stat" && !info.isFile())
    throw new Error("此只读校验命令仅接受一个普通文件，不能递归扫描目录");
  if (command.flags.length > 0 && ["stat", "sha256sum", "sha1sum", "md5sum"].includes(command.command))
    throw new Error(`不支持的只读命令选项：${command.command} ${command.flags.join(" ")}`);
  let output: string;
  switch (command.command) {
    case "ls": output = hostLs(canonical, input, info, command.flags, guard); break;
    case "wc": output = hostWc(canonical, input, command.flags, guard); break;
    case "stat": output = hostStat(canonical, input); break;
    case "du": output = hostDu(canonical, input, command.flags, guard); break;
    case "od": output = hostOd(canonical, command.flags, guard); break;
    case "sha256sum": output = hostHash(canonical, input, "sha256", guard); break;
    case "sha1sum": output = hostHash(canonical, input, "sha1", guard); break;
    case "md5sum": output = hostHash(canonical, input, "md5", guard); break;
    default: throw new Error("不支持的只读命令");
  }
  return { output, truncated: false, exitCode: 0, executable: HOST_EVIDENCE_SOURCE,
    argv: [command.command, ...command.flags, canonical], requestedPath: canonical, evidenceSource: HOST_EVIDENCE_SOURCE };
}
