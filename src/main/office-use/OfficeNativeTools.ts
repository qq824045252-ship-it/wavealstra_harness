import { app } from "electron";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { toLlmContent, type McpClient } from "@earendil-works/pi-mcp";
import type { JsonObject } from "@earendil-works/pi-durable";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import type { PermissionMode } from "../../shared/agent-ipc";
import { OFFICE_USE_TOOLS as office } from "../../shared/office-use";
import { locateOfficeNative, officeNativeEngines, type OfficeNativeEngine } from "../platform/office-native";
import { assertPathInsideTask } from "../task/TaskExecutionWorkspace";
import { OfficeNativeSessions } from "./OfficeNativeSessions";

const engine = Type.Union(officeNativeEngines.map(value => Type.Literal(value)));
const surface = Type.Optional(Type.Union([Type.Literal("workspace"), Type.Literal("desktop")]));
const catalogParameters = Type.Object({
  engine,
  query: Type.Optional(Type.String({ maxLength: 100 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
}, { additionalProperties: false });
const invokeParameters = Type.Object({
  engine,
  surface,
  tool: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  resource: Type.Optional(Type.String({ minLength: 1, maxLength: 150 })),
}, { additionalProperties: false });

const locate = (engine: OfficeNativeEngine) => locateOfficeNative(app.getAppPath(), engine, app.isPackaged ? process.resourcesPath : undefined);
const sessions = new OfficeNativeSessions(locate);
export const closeOfficeNativeTask = (taskId: string) => sessions.closeTask(taskId);
export const closeOfficeNativeSessions = () => sessions.close();

async function acquire(tool: () => Promise<{ content: ReturnType<typeof toLlmContent>; details?: unknown; isError?: boolean }>) {
  try {
    const result = await tool();
    return { ...result, details: result.details ?? {} };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true };
  }
}
const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function officePath(root: string, path: string): string {
  if (!path.trim() || /^(?:[a-z]+:\/\/|[\\/]{2}|[a-z]:(?![\\/]))/i.test(path)) throw new Error("请提供当前任务目录内的 Office 文件路径。");
  return assertPathInsideTask(root, resolve(root, path));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function desktopArguments(root: string, value: unknown, fileOperand = false): unknown {
  if (fileOperand && typeof value === "string") return officePath(root, value);
  if (Array.isArray(value)) return value.map(item => desktopArguments(root, item, fileOperand));
  if (!value || typeof value !== "object") return value;
  const args = record(value);
  const command = String(args.command ?? args.id ?? "");
  return Object.fromEntries(Object.entries(args).map(([key, item]) => [
    key, key === "params" && command.startsWith("animation.") ? item :
      desktopArguments(root, item, /^(?:path|paths|original|file|directory|dir|sourcePath|targetPath)$/i.test(key)),
  ]));
}

const gridFileCommands = new Set([
  "file.open", "file.save", "file.saveAs", "file.exportCsv", "file.exportHtml", "file.exportPdf", "file.print", "file.printPreview",
  "data.getData", "data.fromTextCsv", "insert.picture", "insert.object", "pageLayout.background",
]);

function checkMacroPaths(root: string, steps: unknown) {
  if (!Array.isArray(steps)) return;
  for (const value of steps) {
    const step = record(value);
    const path = record(step.params).path;
    if (path != null && gridFileCommands.has(String(step.id ?? step.command))) {
      const literal = typeof path === "string" && !path.includes("{{") ? path : record(path).$text;
      if (typeof literal !== "string") throw new Error("宏的文件输入和输出需要任务目录内的固定路径。");
      officePath(root, literal);
    }
    for (const key of ["body", "then", "else"]) checkMacroPaths(root, step[key]);
  }
}

async function gridArguments(client: McpClient, root: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
  if (["open_workbook", "save_workbook", "screenshot"].includes(tool) && typeof args.path === "string") {
    return { ...args, path: officePath(root, args.path) };
  }
  if (tool !== "execute_command") return args;
  const command = String(args.command);
  const params = record(args.params);
  if (gridFileCommands.has(command) && typeof params.path === "string") {
    return { ...args, params: { ...params, path: officePath(root, params.path) } };
  }
  if (command === "macro.save") checkMacroPaths(root, (params.macro ? record(params.macro) : params).steps);
  if (command === "macro.run" || (command === "macro.debug" && params.action === "start")) {
    const result = await client.callTool("execute_command", { command: "macro.get", params: { name: params.name } }, { signal });
    const content = result.content[0];
    if (result.isError || content?.type !== "text") throw new Error("无法读取 GridCraft 宏定义。");
    checkMacroPaths(root, record(JSON.parse(content.text)).steps);
  }
  return args;
}

interface OfficeNativePorts {
  taskId: string;
  taskRoot(): string;
  isEnabled(): boolean;
  getPermissionMode(): PermissionMode;
}

export function createOfficeNativeExtension(ports: OfficeNativePorts): ExtensionFactory {
  const enabled = () => {
    if (!ports.isEnabled()) throw new Error("Office Use 已在本机工具设置中关闭。");
  };
  const writable = () => {
    enabled();
    if (ports.getPermissionMode() === "readonly") throw new Error("当前任务为只读模式。");
  };
  return pi => {
    pi.registerTool({
      name: office.nativeTools,
      label: "Office Use · 搜索上游工具",
      description: "从 WordCraft、GridCraft、DeckCraft 的本机 MCP 运行时读取完整工具名、说明和参数。用 query 按工具名筛选。上游 Skill 的 mcp_<engine>_<tool> 对应这里的 engine 与 tool。引擎命令通过上游 list_commands 查询。",
      parameters: catalogParameters,
      execute: async (_id, params: Static<typeof catalogParameters>, signal) => acquire(async () => {
        enabled();
        const root = await realpath(ports.taskRoot());
        return sessions.run(ports.taskId, root, params.engine, "workspace", signal, async (client, catalog) => {
          enabled();
          const tools = await catalog();
          const query = params.query?.replace(new RegExp(`^mcp_${params.engine}_`), "").toLowerCase().trim();
          const matched = tools.filter(tool => !query || tool.name.toLowerCase().includes(query));
          const offset = params.offset ?? 0;
          const end = offset + (params.limit ?? 12);
          const resources = client.serverCapabilities?.resources ? await client.listResources({ signal }) : [];
          return text({ engine: params.engine, tools: matched.slice(offset, end), count: matched.length,
            ...(end < matched.length ? { nextOffset: end } : {}), resources });
        });
      }),
    });
    pi.registerTool({
      name: office.nativeCall,
      label: "Office Use · 执行上游工具",
      description: "执行 WordCraft、GridCraft 或 DeckCraft 的原生上游工具。用 office_native_tools 获取参数，再原样传 tool 和 arguments。默认 surface=workspace 为任务内的后台引擎。明确需要截图、点击、按键或界面控制时，从打开文件开始使用 surface=desktop，MyBuddy 会启动专属的上游应用窗口。同一引擎和 surface 保留各自的状态。文件路径使用当前任务目录内的绝对路径。传 resource 可读取上游资源。",
      parameters: invokeParameters,
      execute: async (_id, params: Static<typeof invokeParameters>, signal) => acquire(async () => {
        writable();
        const root = await realpath(ports.taskRoot());
        if (Boolean(params.tool) === Boolean(params.resource)) throw new Error("请选择一个上游工具或资源。");
        const initialArgs = params.arguments ?? {};
        const name = params.tool?.replace(new RegExp(`^mcp_${params.engine}_`), "");
        const openTool = { wordcraft: "open_document", gridcraft: "open_workbook", deckcraft: "open_presentation" }[params.engine];
        const initialFile = params.surface === "desktop" && name === openTool && !initialArgs.password && typeof initialArgs.path === "string"
          ? officePath(root, initialArgs.path) : undefined;
        writable();
        return sessions.run(ports.taskId, root, params.engine, params.surface ?? "workspace", signal, async (client, catalog) => {
          writable();
          if (params.resource) return text(await client.readResource(params.resource, { signal }));
          const tool = (await catalog()).find(tool => tool.name === name);
          if (!tool) throw new Error(`当前上游版本无工具 ${name}。请先用 ${office.nativeTools} 查询。`);
          // WordCraft and DeckCraft enforce roots inside the upstream engine. Leave their
          // JSON intact, including non-file operands such as DeckCraft motion paths.
          const raw = params.arguments ?? {};
          if (JSON.stringify(raw).length > 32 * 1024 * 1024) throw new Error("Office 工具参数超过 32 MiB。");
          const args = params.engine === "gridcraft" ? await gridArguments(client, root, tool.name, raw, signal)
            : params.surface === "desktop" ? desktopArguments(root, raw) as Record<string, unknown> : raw;
          const checked = validateToolArguments({ name: tool.name, description: tool.description ?? "", parameters: Type.Unsafe(tool.inputSchema) },
            { type: "toolCall", id: _id, name: tool.name, arguments: args as JsonObject });
          writable();
          signal?.throwIfAborted();
          const result = await client.callTool(tool.name, checked, { signal });
          return { content: toLlmContent(result), details: result.structuredContent, isError: result.isError };
        }, initialFile);
      }),
    });
  };
}
