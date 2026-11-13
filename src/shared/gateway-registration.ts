/** Public device-registration view. Secrets and provider polling tickets never cross IPC. */
export type GatewayRegistrationProvider = "feishu" | "dingtalk" | "wecom";
export type GatewayRegistrationField = "corpId" | "robotCode" | "allowUsers";
export interface GatewayRegistrationDetails {
  corpId?: string;
  robotCode?: string;
  allowUsers?: string[];
}
export interface GatewayRegistrationState {
  state: "idle" | "waiting" | "configuration" | "binding" | "connected" | "cancelled" | "expired" | "error";
  sessionId?: string;
  qrUrl?: string;
  message: string;
  missingFields?: GatewayRegistrationField[];
}
