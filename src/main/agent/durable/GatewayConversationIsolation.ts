import type { DurableBotServiceOptions } from "./DurableBotService";
import { conversationalRequest, GATEWAY_CONVERSATION_INSTRUCTIONS, isGatewayConversation } from "../../gateway/GatewayConversation";

/** A narrow channel conversation boundary, applied on cold reopen as well as first admission.
 * Ordinary desktop tasks keep their exact existing callbacks. Channel tasks never inherit ambient host context.
 */
export function isolateGatewayConversations(base: DurableBotServiceOptions): DurableBotServiceOptions {
  const check = (id: string) => {
    const task = base.db.getTask(id);
    if (task && (task.projectId || task.spaceId || task.expertId || task.sessionFile)) {
      throw new Error("渠道对话不能绑定本地项目、工作空间、专家或历史会话");
    }
  };
  return { ...base,
    instructions: task => isGatewayConversation(task.id) ? GATEWAY_CONVERSATION_INSTRUCTIONS : base.instructions(task),
    resolveNextCwd: id => isGatewayConversation(id) ? undefined : base.resolveNextCwd?.(id),
    mcpSelection: task => isGatewayConversation(task.id) ? [] : base.mcpSelection?.(task) ?? [],
    tools: async (task, cwd, recovery) => isGatewayConversation(task.id)
      ? { tools: [], contextHooks: [] } : await base.tools?.(task, cwd, recovery) ?? { tools: [], contextHooks: [] },
    toolAllowed: (task, name) => !isGatewayConversation(task.id) && (base.toolAllowed?.(task, name) ?? true),
    toolMode: task => isGatewayConversation(task.id) ? "native" : base.toolMode(task),
    evidence: (task, messages) => isGatewayConversation(task.id) ? "" : base.evidence?.(task, messages) ?? "",
    evidenceProjection: task => isGatewayConversation(task.id) ? undefined : base.evidenceProjection?.(task),
    prepareTask: async (request, mark) => {
      if (!isGatewayConversation(request.taskId)) return await base.prepareTask?.(request, mark) ?? request;
      check(request.taskId);
      return conversationalRequest(request);
    },
    beforeSubmit: request => { if (isGatewayConversation(request.taskId)) check(request.taskId); base.beforeSubmit?.(request); },
    beforeModelRequest: id => { if (isGatewayConversation(id)) check(id); base.beforeModelRequest?.(id); },
    prepareInput: request => isGatewayConversation(request.taskId) ? request.text : base.prepareInput?.(request) ?? request.text,
    prepareImages: async request => isGatewayConversation(request.taskId) ? { images: [] } : await base.prepareImages?.(request) ?? { images: [] },
    auditInput: request => isGatewayConversation(request.taskId) ? undefined : base.auditInput?.(request),
    thinking: (task, request) => isGatewayConversation(task.id) ? undefined : base.thinking?.(task, request),
    onTurns: (id, turns) => { if (!isGatewayConversation(id)) base.onTurns?.(id, turns); },
    onEntries: (id, entries, info) => { if (!isGatewayConversation(id)) base.onEntries?.(id, entries, info); },
    onRequest: (id, info) => { if (!isGatewayConversation(id)) base.onRequest?.(id, info); },
    onSettled: (id, snapshot) => { if (!isGatewayConversation(id)) base.onSettled?.(id, snapshot); },
    projectArtifacts: async (id, ...args) => { if (!isGatewayConversation(id)) await base.projectArtifacts?.(id, ...args); },
    resumeAllowed: id => !isGatewayConversation(id) && (base.resumeAllowed?.(id) ?? true),
  };
}
