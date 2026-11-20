import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import release from "../../../vendor/cadcraft/releases.json";
import { currentPlatformId } from "./index";

export async function locateCadCraftCli(appPath: string, packagedResources?: string): Promise<string> {
  if (process.arch !== "x64" || currentPlatformId === "macos") {
    throw new Error("CADCraft 离线编辑器支持 Windows 和 Linux x64");
  }
  const target = currentPlatformId === "windows" ? "win-x64" : "linux-x64";
  const root = packagedResources ? join(packagedResources, "cadcraft") : join(appPath, "vendor/cadcraft/assets", target);
  const cli = join(root, release.targets[target].cli);
  try {
    await access(cli, constants.X_OK);
  } catch {
    throw new Error(packagedResources ? "CADCraft 运行资源缺失或不可执行" : "请先运行 pnpm prepare:cadcraft 安装编辑器资源");
  }
  return cli;
}

const run = promisify(execFile);

export function runCadCraftCli(cli: string, args: string[], cwd: string, signal?: AbortSignal) {
  return run(cli, args, {
    cwd, signal, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, CADCRAFT_CONFIG_DIR: "" },
  });
}

export type CadOutputFormat = "dwg" | "dxf" | "pdf" | "svg" | "png";

export async function buildCadCraftOutput(cli: string, request: {
  source?: string | { bytes: Buffer; format: "dwg" | "dxf" };
  metric?: boolean;
  commands?: readonly string[];
  format: CadOutputFormat;
  version?: string;
  signal?: AbortSignal;
}): Promise<{ bytes: Buffer; warning: string; commandResults: unknown[] }> {
  const directory = await mkdtemp(join(tmpdir(), "mybuddy-cad-output-"));
  try {
    const output = join(directory, `drawing.${request.format}`);
    const args = ["run"];
    if (typeof request.source === "string") {
      args.push(request.source);
    } else if (request.source) {
      const source = join(directory, `input.${request.source.format}`);
      await writeFile(source, request.source.bytes, { flag: "wx", mode: 0o600 });
      args.push(source);
    } else if (request.metric) {
      args.push("--metric");
    }
    for (const command of request.commands ?? []) args.push("--cmd", command);
    if (request.format === "dwg" || request.format === "dxf") {
      args.push("--cmd", `saveas ${JSON.stringify({ path: output, version: request.version })}`);
    } else {
      args.push("--export", output, "--view", "extents");
    }
    const result = await runCadCraftCli(cli, args, directory, request.signal);
    const bytes = await readFile(output);
    if (request.format === "dwg" && !/^AC10\d{2}$/.test(bytes.subarray(0, 6).toString("ascii"))) {
      throw new Error("CADCraft 返回的文件缺少 DWG 文件头");
    }
    if (!bytes.length) throw new Error(`CADCraft 没有生成 ${extname(output)} 数据`);
    const commandResults = request.commands?.length
      ? result.stdout.trim().split(/\r?\n/).slice(0, request.commands.length).map(line => JSON.parse(line) as unknown)
      : [];
    const warning = result.stderr.split(/\r?\n/)
      .filter(line => line !== `wrote ${output} (${bytes.length} bytes)`)
      .join("\n").trim().replaceAll(directory, "临时图纸").slice(0, 1500);
    return { bytes, warning, commandResults };
  } catch (error) {
    request.signal?.throwIfAborted();
    const reason = error as { stderr?: string; killed?: boolean };
    const detail = reason.killed ? "运行超时" : reason.stderr?.trim().replaceAll(directory, "临时图纸").slice(0, 500);
    throw new Error(`CADCraft 生成失败：${detail || (error instanceof Error ? error.message : String(error))}`, { cause: error });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function convertCadCraftDrawing(
  cli: string,
  bytes: Buffer,
  from: "dwg" | "dxf",
  to: "dwg" | "dxf",
  version: string,
): Promise<{ bytes: Buffer; warning: string }> {
  return buildCadCraftOutput(cli, { source: { bytes, format: from }, format: to, version });
}
