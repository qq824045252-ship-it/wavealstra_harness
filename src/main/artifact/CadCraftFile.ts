import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { cadCraftExtension, type CadCraftSource } from "../../shared/cadcraft";
import { atomicBytes, digest, inside, plainFile } from "../office-use/OfficeFile";
import { convertCadCraftDrawing } from "../platform/cadcraft";
import type { ArtifactService } from "./ArtifactService";
import type { SavedArtifactActions } from "./SavedArtifactActions";

interface Drawing { path: string; name: string; identity: string; readOnly: false }
interface Ports {
  artifacts: Pick<ArtifactService, "get" | "entryPathOf">;
  saved: Pick<SavedArtifactActions, "verifiedSnapshot">;
  storageRoot: string;
  locateCli: () => Promise<string>;
  choose(defaultPath: string, extension: string): Promise<string | undefined>;
}

const versions: Record<string, string> = {
  AC1015: "2000", AC1018: "2004", AC1021: "2007", AC1024: "2010", AC1027: "2013", AC1032: "2018",
};
const fileLimit = 128 * 1024 * 1024;

export async function resolveCadCraftFile(source: CadCraftSource, ports: Ports): Promise<CadCraftFile> {
  if (source?.type === "work") {
    const drawing = await ports.saved.verifiedSnapshot(source.file);
    return new CadCraftFile({ ...drawing, identity: JSON.stringify(["work", drawing.path]), readOnly: false }, ports);
  }
  if (source?.type !== "artifact" || typeof source.taskId !== "string" || typeof source.id !== "string") {
    throw new Error("CAD 图纸来源无效");
  }
  const descriptor = ports.artifacts.get(source.id);
  const entry = ports.artifacts.entryPathOf(source.id);
  if (descriptor?.taskId !== source.taskId || descriptor.source.type !== "workspace-file" || !entry) {
    throw new Error("CAD 图纸已移除或已离开当前任务的登记目录");
  }
  const path = await realpath(entry);
  if (!inside(await realpath(descriptor.source.rootDir), path)) throw new Error("CAD 图纸已离开登记目录");
  return new CadCraftFile({ path, name: basename(entry), identity: JSON.stringify(["artifact", source.taskId, path]), readOnly: false }, ports);
}

export class CadCraftFile {
  private readonly extension: "dwg" | "dxf";
  private version = "2018";
  private warning = "";
  private draftPath = "";
  private recovered = false;

  constructor(readonly target: Drawing, private readonly ports: Ports) {
    const extension = cadCraftExtension(target.name);
    if (!extension) throw new Error("CADCraft 支持 DWG 和 DXF 图纸");
    this.extension = extension;
  }

  config() {
    const name = basename(this.target.name, extname(this.target.name)) + ".dxf";
    return { name, recovered: this.recovered };
  }

  async open(): Promise<Buffer> {
    await plainFile(this.target.path);
    const info = await lstat(this.target.path);
    if (info.size < 6 || info.size > fileLimit) throw new Error("图纸为空或超过 128 MiB");
    const bytes = await readFile(this.target.path);
    const directory = join(this.ports.storageRoot, "cadcraft-drafts");
    this.draftPath = join(directory, digest(`${this.target.identity}:${digest(bytes)}`) + ".dxf");
    let cli: string | undefined;
    if (this.extension === "dwg") {
      const header = bytes.subarray(0, 6).toString("ascii");
      if (!/^AC10\d{2}$/.test(header)) throw new Error("图纸缺少有效的 DWG 文件头");
      this.version = versions[header] ?? "2000";
      cli = await this.ports.locateCli();
    }
    const draft = await readFile(this.draftPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (draft) {
      this.recovered = true;
      return draft;
    }
    if (!cli) return bytes;
    const converted = await convertCadCraftDrawing(cli, bytes, "dwg", "dxf", this.version);
    this.warning = converted.warning;
    return converted.bytes;
  }

  async writeDraft(bytes: Buffer): Promise<void> {
    await mkdir(dirname(this.draftPath), { recursive: true });
    await atomicBytes(this.draftPath, bytes);
  }

  async saveCopy(bytes: Buffer): Promise<{ path?: string; warning?: string }> {
    const storage = await realpath(this.ports.storageRoot);
    const name = `${basename(this.target.name, extname(this.target.name))} - 编辑副本.${this.extension}`;
    const suggested = inside(storage, this.target.path) ? name : join(dirname(this.target.path), name);
    const converted = this.extension === "dwg"
      ? await convertCadCraftDrawing(await this.ports.locateCli(), bytes, "dxf", "dwg", this.version)
      : { bytes, warning: "" };
    const selected = await this.ports.choose(suggested, this.extension);
    if (!selected) return {};
    const requested = resolve(selected);
    const parent = await realpath(dirname(requested));
    const target = join(parent, basename(requested));
    if (inside(storage, target) || relative(this.target.path, target) === "" || cadCraftExtension(target) !== this.extension) {
      throw new Error("请选择应用存储目录之外的同格式新文件名");
    }
    const staging = join(parent, ".mybuddy-cad-" + randomUUID());
    try {
      await writeFile(staging, converted.bytes, { flag: "wx", mode: 0o600, flush: true });
      await copyFile(staging, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("该文件名已存在，请为编辑副本选择新名称");
      throw error;
    } finally {
      await unlink(staging).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
    return { path: target, warning: [this.warning, converted.warning].filter(Boolean).join(" ") };
  }
}
