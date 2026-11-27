import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";

export interface GatewayExecutionDenied {
  status: "denied";
  code: string;
  memory?: "revoked";
}

export type GatewayExecutionAuthority = GatewayExecutionDenied | {
  status: "allowed";
  channelId: string;
  connectionKey: string;
  chatId: string;
  senderId: string;
  audience: GatewayBotOrigin["audience"];
  memory: "active" | "none";
  bindingId: string | null;
};

export interface GatewayTaskMaterialization {
  origin: Omit<GatewayBotOrigin, "workTarget">;
  taskId: string;
  modelId?: string;
}

export type GatewayTaskMaterializationResult = GatewayExecutionDenied | { status: "ready"; created: boolean };

export function rejectGatewayExecution(result?: GatewayExecutionDenied | null): never {
  if (result?.code === "TASK_ARCHIVED_OR_TRASHED") throw new Error("请先恢复已归档或回收的渠道任务");
  if (result?.memory === "revoked") throw new Error("该私人记忆绑定已撤销，请从当前入口开启新的对话");
  if (result?.code === "GENERATION_CHANGED") throw new Error("该渠道已开启新会话，请在当前会话发送消息");
  throw new Error("Core 未确认当前渠道会话的执行权限。");
}
