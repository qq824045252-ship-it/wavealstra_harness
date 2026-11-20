import { app } from "electron";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { CAD_USE_TOOLS, cadCraftExtension } from "../../shared/cadcraft";
import type { ArtifactService } from "../artifact/ArtifactService";
import { atomicBytes } from "../office-use/OfficeFile";
import { buildCadCraftOutput, locateCadCraftCli, runCadCraftCli, type CadOutputFormat } from "../platform/cadcraft";
import { resolvedPathKey } from "../platform/paths";
import { assertPathInsideTask } from "../task/TaskExecutionWorkspace";
import type { LocalCapabilityCheckResult } from "./BuiltinCapabilityRuntime";

const pathField = Type.String({ minLength: 1, maxLength: 512 });
const coordinate = Type.Number({ minimum: -1e9, maximum: 1e9 });
const point = Type.Tuple([coordinate, coordinate]);
const radius = Type.Number({ exclusiveMinimum: 0, maximum: 1e9 });
const angle = Type.Number({ minimum: -360, maximum: 360 });
const strict = { additionalProperties: false };
const shape = Type.Union([
  Type.Object({ type: Type.Literal("line"), from: point, to: point }, strict),
  Type.Object({ type: Type.Literal("rectangle"), from: point, to: point }, strict),
  Type.Object({ type: Type.Literal("circle"), center: point, radius }, strict),
  Type.Object({ type: Type.Literal("arc"), center: point, radius, start: angle, end: angle }, strict),
  Type.Object({ type: Type.Literal("polyline"), points: Type.Array(point, { minItems: 2, maxItems: 128 }),
    closed: Type.Optional(Type.Boolean()) }, strict),
]);
const createParameters = Type.Object({
  path: pathField,
  source: Type.Optional(pathField),
  units: Type.Optional(Type.Union([Type.Literal("mm"), Type.Literal("in")])),
  entities: Type.Optional(Type.Array(shape, { maxItems: 80 })),
}, strict);
const inspectParameters = Type.Object({
  path: pathField,
  entityType: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  layer: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, strict);
const exportParameters = Type.Object({ source: pathField, path: pathField }, strict);
const handles = Type.Array(Type.String({ pattern: "^[0-9A-Fa-f]{1,16}$" }), { minItems: 1, maxItems: 50, uniqueItems: true });
const modification = Type.Union([
  Type.Object({ type: Type.Literal("move"), handles, delta: point }, strict),
  Type.Object({ type: Type.Literal("rotate"), handles, base: point, angle }, strict),
  Type.Object({ type: Type.Literal("scale"), handles, base: point, factor: Type.Number({ exclusiveMinimum: 0, maximum: 1e6 }) }, strict),
  Type.Object({ type: Type.Literal("circleRadius"), handles, radius }, strict),
  Type.Object({ type: Type.Literal("erase"), handles }, strict),
]);
const editParameters = Type.Object({
  source: pathField, path: pathField, edits: Type.Array(modification, { minItems: 1, maxItems: 30 }),
}, strict);
type CadEdit = Static<typeof modification>;

const outputKinds = { dwg: "cad", dxf: "cad", pdf: "pdf", svg: "svg", png: "image" } as const;

function toolCommand(entity: Static<typeof shape>): string {
  switch (entity.type) {
    case "line": return `line ${JSON.stringify({ points: [entity.from, entity.to] })}`;
    case "rectangle": return `rectang ${JSON.stringify({ p1: entity.from, p2: entity.to })}`;
    case "circle": return `circle ${JSON.stringify({ center: entity.center, radius: entity.radius })}`;
    case "arc": return `arc ${JSON.stringify({ center: entity.center, radius: entity.radius, start: entity.start, end: entity.end })}`;
    case "polyline": return `pline ${JSON.stringify({ vertices: entity.points, closed: entity.closed })}`;
  }
}

function editCommand(edit: CadEdit): string {
  const { type, ...params } = edit;
  const command = type === "circleRadius" ? "properties.set" : type;
  return `${command} ${JSON.stringify(params)}`;
}

function verifyEdits(edits: readonly CadEdit[], results: readonly unknown[]): void {
  const keys = { move: "moved", rotate: "handles", scale: "handles", circleRadius: "changed", erase: "erased" } as const;
  for (const [index, edit] of edits.entries()) {
    const result = results[index] as Record<string, unknown> | undefined;
    const actual = result?.[keys[edit.type]];
    const count = Array.isArray(actual) ? actual.length : actual;
    if (count !== new Set(edit.handles.map(handle => handle.toUpperCase())).size) {
      throw new Error(`第 ${index + 1} 项修改没有作用于全部图元，请重新读取图元标识和图层锁定状态`);
    }
  }
}

const bundledCli = () => locateCadCraftCli(app.getAppPath(), app.isPackaged ? process.resourcesPath : undefined);

export async function checkCadUse(): Promise<LocalCapabilityCheckResult> {
  let cli: string;
  try { cli = await bundledCli(); }
  catch (error) {
    return { state: "missing-dependency", detail: error instanceof Error ? error.message : String(error) };
  }
  await Promise.all((["dwg", "dxf"] as const).map(format => buildCadCraftOutput(cli, {
    metric: true, format, commands: ['circle {"center":[0,0],"radius":5}'],
  })));
  return { state: "ready", detail: "CADCraft 已在本机实际生成 DWG 和 DXF。" };
}

interface Ports {
  taskId: string;
  taskRoot(): string;
  artifacts(): ArtifactService | null;
  producerMessageId(): string | undefined;
  getPermissionMode(): PermissionMode;
  isEnabled(): boolean;
}

function isChatAttachment(context: ExtensionContext, requested: string): boolean {
  const key = resolvedPathKey(requested);
  return context.sessionManager.getBranch().some(entry => {
    if (entry.type !== "custom" || entry.customType !== "user") return false;
    const data = entry.data as { mybuddyInput?: { attachments?: unknown } } | undefined;
    const attachments = data?.mybuddyInput?.attachments;
    return Array.isArray(attachments) && attachments.some(item =>
      item && typeof item.path === "string" && isAbsolute(item.path) && resolvedPathKey(item.path) === key);
  });
}

async function inputDrawing(ports: Ports, context: ExtensionContext, root: string, raw: string): Promise<string> {
  const requested = resolve(root, raw);
  if (!cadCraftExtension(requested)) throw new Error("源文件必须是 DWG 或 DXF 图纸");
  let checked: string;
  try {
    checked = assertPathInsideTask(root, requested);
  } catch (error) {
    const artifacts = ports.artifacts();
    const descriptor = artifacts?.findByEntryFile(ports.taskId, requested);
    const entry = descriptor && artifacts?.entryPathOf(descriptor.id);
    if (descriptor?.source.type === "workspace-file" && entry && resolvedPathKey(entry) === resolvedPathKey(requested)) {
      checked = assertPathInsideTask(descriptor.source.rootDir, entry);
    } else if (isAbsolute(raw) && isChatAttachment(context, requested)) {
      checked = requested;
    } else {
      throw error;
    }
  }
  const actual = await realpath(checked);
  const info = await lstat(actual);
  if (!info.isFile() || info.size > 128 * 1024 * 1024) throw new Error("源图纸必须是 128 MiB 以内的普通文件");
  return actual;
}

export function createCadUseExtension(ports: Ports): ExtensionFactory {
  function assertEnabled(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!ports.isEnabled()) throw new Error("CAD Use 已在本机工具设置中关闭");
  }
  function assertWritable(signal?: AbortSignal) {
    assertEnabled(signal);
    if (ports.getPermissionMode() === "readonly") throw new Error("当前任务为只读模式");
  }
  async function result(action: () => Promise<object>) {
    try {
      const details = await action();
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
    }
  }
  async function deliver(id: string, context: ExtensionContext, raw: string, format: CadOutputFormat, input: {
    source?: string; commands?: readonly string[]; edits?: readonly CadEdit[]; metric?: boolean;
  }, signal?: AbortSignal) {
    assertWritable(signal);
    if ((input.commands ?? []).reduce((length, command) => length + command.length, 0) > 24_000) {
      throw new Error("本次图元命令过多，请缩小操作范围");
    }
    const artifacts = ports.artifacts();
    if (!artifacts) throw new Error("当前任务的产物服务不可用");
    const configuredRoot = ports.taskRoot();
    const requested = assertPathInsideTask(configuredRoot, resolve(configuredRoot, raw));
    const root = await realpath(configuredRoot);
    const source = input.source ? await inputDrawing(ports, context, configuredRoot, input.source) : undefined;
    const { bytes, warning, commandResults } = await buildCadCraftOutput(await bundledCli(), {
      source, metric: input.metric, commands: input.commands, format, signal,
    });
    if (input.edits) verifyEdits(input.edits, commandResults);
    if (await realpath(configuredRoot) !== root) throw new Error("任务目录已变化，请重新创建");
    assertWritable(signal);
    await mkdir(dirname(requested), { recursive: true });
    const path = assertPathInsideTask(root, resolve(await realpath(dirname(requested)), basename(requested)));
    try {
      await atomicBytes(path, bytes, async () => {
        if (await realpath(configuredRoot) !== root) throw new Error("任务目录已变化，请重新创建");
        assertPathInsideTask(root, path);
        assertWritable(signal);
      }, { create: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`文件已存在：${basename(path)}。请选择新文件名。`);
      throw error;
    }
    const kind = outputKinds[format];
    try {
      const artifact = await artifacts.register({
        taskId: ports.taskId, kind, title: basename(path), workspaceFile: { entryFile: path, rootDir: root },
        producerMessageId: ports.producerMessageId(), producerToolCallId: id,
      });
      return { path, format, artifactId: artifact.id, ...(warning ? { warning } : {}) };
    } catch (error) {
      throw new Error(`文件已保存至 ${path}，登记为任务产物时失败`, { cause: error });
    }
  }
  return pi => {
    pi.registerTool({
      name: CAD_USE_TOOLS.create,
      label: "CAD Use · 创建图纸",
      description: "创建当前任务内的新 DWG 或 DXF 并登记产物，可创建空图纸或添加直线、矩形、圆、圆弧、多段线。坐标和半径使用图纸单位，新图默认毫米。圆的 20 mm 直径请填 radius:10。传 source 可在已有图纸的副本中添加图元，沿用源图单位。path 必须是新文件。",
      parameters: createParameters,
      execute: async (id, args: Static<typeof createParameters>, signal, _onUpdate, context) => result(async () => {
        assertWritable(signal);
        const format = cadCraftExtension(args.path);
        if (!format) throw new Error("路径后缀必须为 .dwg 或 .dxf");
        const commands = (args.entities ?? []).map(toolCommand);
        return deliver(id, context, args.path, format, { source: args.source, commands, metric: args.units !== "in" }, signal);
      }),
    });
    pi.registerTool({
      name: CAD_USE_TOOLS.inspect,
      label: "CAD Use · 读取图纸",
      description: "读取当前任务的 DWG 或 DXF。默认返回单位、范围、图层、布局及图元数量。传 limit、offset、entityType 或 layer 时返回一页图元几何和 handle，最多 50 条。修改前先读取目标，修改后读取产物复验。",
      parameters: inspectParameters,
      execute: async (_id, args: Static<typeof inspectParameters>, signal, _onUpdate, context) => result(async () => {
        assertEnabled(signal);
        const root = ports.taskRoot();
        const file = await inputDrawing(ports, context, root, args.path);
        const paged = args.limit !== undefined || args.offset !== undefined || args.entityType !== undefined || args.layer !== undefined;
        const query = paged ? `entities ${JSON.stringify({
          type: args.entityType, layer: args.layer, limit: args.limit ?? 20, offset: args.offset ?? 0,
        })}` : 'drawing.inspect {"entities":false}';
        const call = ["run", file, "--cmd", query, "--cmd", 'getvar {"name":"INSUNITS"}'];
        const { stdout } = await runCadCraftCli(await bundledCli(), call, root, signal);
        assertEnabled(signal);
        if (stdout.length > 48_000) throw new Error("图纸结果过大，请通过图层、图元类型或更小的页数缩小范围");
        const [summary, units] = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
        return { ...summary, insunits: units.value };
      }),
    });
    pi.registerTool({
      name: CAD_USE_TOOLS.edit,
      label: "CAD Use · 修改图纸",
      description: "按 cad_inspect 返回的十六进制 handle 修改已有 DWG/DXF，支持移动、旋转、等比缩放、改圆半径和删除指定图元。source 是原图，path 是同格式新副本。例如把指定圆的直径改为 20 mm，在毫米图中使用 {type:\"circleRadius\",handles:[圆的handle],radius:10}。完成后用 cad_inspect 读取副本核对。",
      parameters: editParameters,
      execute: async (id, args: Static<typeof editParameters>, signal, _onUpdate, context) => result(async () => {
        const format = cadCraftExtension(args.path);
        if (!format || format !== cadCraftExtension(args.source)) throw new Error("编辑副本必须沿用源图纸的 DWG 或 DXF 格式");
        const commands = args.edits.map(editCommand);
        return deliver(id, context, args.path, format, { source: args.source, commands, edits: args.edits }, signal);
      }),
    });
    pi.registerTool({
      name: CAD_USE_TOOLS.export,
      label: "CAD Use · 导出图纸",
      description: "将任务中的 DWG 或 DXF 导出为新的 DWG、DXF、PDF、SVG 或 PNG 文件，按 path 后缀选格式。文件会登记为任务产物。",
      parameters: exportParameters,
      execute: async (id, args: Static<typeof exportParameters>, signal, _onUpdate, context) => result(async () => {
        const format = extname(args.path).slice(1).toLowerCase();
        if (!Object.hasOwn(outputKinds, format)) throw new Error("导出支持 DWG、DXF、PDF、SVG 和 PNG");
        return deliver(id, context, args.path, format as CadOutputFormat, { source: args.source }, signal);
      }),
    });
  };
}
