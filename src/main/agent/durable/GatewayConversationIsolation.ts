import { existsSync, lstatSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { assertPathInsideTask, MANIFEST_FILENAME } from "../../task/TaskExecutionWorkspace";
import { assertGatewayDotsMemoryCurrent } from "../../gateway/GatewayDotsBindings";
import { durableReadPathVariants, durableToolPath } from "./DurableFilePath";
import type { DurableBotServiceOptions } from "./DurableBotService";
import { gatewayChannelSpaceId, isGatewayConversation } from "../../../shared/gateway-task";

const fileTools = new Set(["read", "write", "edit"]);
const memoryTools = new Set(["memory_search", "memory_get", "memory_history", "memory_create", "memory_update"]);
const allowsGatewayTool = (name: string): boolean => fileTools.has(name) || memoryTools.has(name);

function assertGatewayFilePath(cwd: string, tool: string, args: unknown): void {
  const input = args as { path?: unknown } | undefined;
  if (typeof input?.path !== "string" || !input.path || input.path.trim() !== input.path || /^[~@"']/.test(input.path)) {
    throw new Error("渠道文件工具需要当前会话目录内的路径");
  }
  const root = resolve(cwd);
  const requested = resolve(root, durableToolPath(input.path));
  assertGatewayPath(root, requested);
  if (tool !== "read") return;
  const alternative = durableReadPathVariants(requested).find(existsSync);
  if (alternative && alternative !== requested) assertGatewayPath(root, alternative);
}

function assertGatewayPath(root: string, path: string): void {
  let target = assertPathInsideTask(root, path);
  const local = relative(root, target);
  const parts = local.split(/[\\/]/);
  if (parts.some(part => part.toLowerCase() === MANIFEST_FILENAME.toLowerCase())
    || local.includes(":") || parts.some(part => /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part.trimEnd()))) {
    throw new Error("渠道文件工具不能访问应用清单或设备路径");
  }
  // The native operation opens the named path. Disallow aliases even when the
  // referent is currently missing or happens to share the same physical disk.
  for (;;) {
    let stat: ReturnType<typeof lstatSync> | undefined;
    try { stat = lstatSync(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (stat && (!stat.isDirectory() && !stat.isFile() || stat.isFile() && stat.nlink > 1)) {
      throw new Error("渠道文件工具只能访问当前会话目录内的普通文件");
    }
    if (relative(root, target) === "") {
      if (!stat?.isDirectory()) throw new Error("渠道会话目录不可用");
      return;
    }
    target = dirname(target);
  }
}

/** Recheck channel ownership before submission, model calls and tool execution, including after reopen. */
export function isolateGatewayConversations(base: DurableBotServiceOptions): DurableBotServiceOptions {
  const check = (id: string) => {
    assertGatewayDotsMemoryCurrent(base.db.connection, id);
    const task = base.db.getTask(id);
    if (!task?.gatewaySidebarChannelId || task.spaceId !== gatewayChannelSpaceId(task.gatewaySidebarChannelId)
      || task.projectId || task.sessionFile) {
      throw new Error("渠道任务必须属于原渠道空间，且不能绑定其他项目或历史会话");
    }
  };
  return { ...base,
    beforeSubmit: request => { if (isGatewayConversation(request.taskId)) check(request.taskId); base.beforeSubmit?.(request); },
    beforeModelRequest: id => { if (isGatewayConversation(id)) check(id); base.beforeModelRequest?.(id); },
    mcpSelection: task => isGatewayConversation(task.id) ? []
      : base.mcpSelection ? base.mcpSelection(task) : base.expertBindings?.active(task.id)?.mcpIds,
    toolMode: task => isGatewayConversation(task.id) ? "native" : base.toolMode(task),
    tools: async (task, cwd, recovery) => {
      const domain = await base.tools?.(task, cwd, recovery) ?? { tools: [], contextHooks: [] };
      if (!isGatewayConversation(task.id)) return domain;
      return { ...domain, tools: domain.tools.filter(tool => allowsGatewayTool(tool.name)), toolHooks: {
        ...domain.toolHooks,
        beforeTool: async (call, api, context) => !allowsGatewayTool(call.name)
          ? { block: "渠道任务只可使用当前会话的文件与记忆工具" }
          : domain.toolHooks?.beforeTool?.(call, api, context),
      } };
    },
    toolAllowed: (task, name) => (!isGatewayConversation(task.id) || allowsGatewayTool(name))
      && (base.toolAllowed?.(task, name) ?? true),
    beforeToolExecution: (id, cwd, name, args) => {
      if (isGatewayConversation(id) && fileTools.has(name)) assertGatewayFilePath(cwd, name, args);
      base.beforeToolExecution?.(id, cwd, name, args);
    },
    // Gateway's delivery journal rechecks the connected account and sender before replaying an input.
    resumeAllowed: id => !isGatewayConversation(id) && (base.resumeAllowed?.(id) ?? true),
  };
}
