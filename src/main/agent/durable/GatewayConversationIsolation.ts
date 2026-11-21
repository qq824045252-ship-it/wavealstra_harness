import type { DurableBotServiceOptions } from "./DurableBotService";
import { gatewayChannelSpaceId, isGatewayConversation } from "../../../shared/gateway-task";

/** Recheck channel ownership before submission, model calls and tool execution, including after reopen. */
export function isolateGatewayConversations(base: DurableBotServiceOptions): DurableBotServiceOptions {
  const check = (id: string) => {
    const task = base.db.getTask(id);
    if (!task?.gatewaySidebarChannelId || task.spaceId !== gatewayChannelSpaceId(task.gatewaySidebarChannelId)
      || task.projectId || task.sessionFile) {
      throw new Error("渠道任务必须属于原渠道空间，且不能绑定其他项目或历史会话");
    }
  };
  return { ...base,
    beforeSubmit: request => { if (isGatewayConversation(request.taskId)) check(request.taskId); base.beforeSubmit?.(request); },
    beforeModelRequest: id => { if (isGatewayConversation(id)) check(id); base.beforeModelRequest?.(id); },
    // Gateway's delivery journal rechecks the connected account and sender before replaying an input.
    resumeAllowed: id => !isGatewayConversation(id) && (base.resumeAllowed?.(id) ?? true),
  };
}
