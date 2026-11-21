export type GatewayChannelType = "feishu" | "wechat" | "wecom" | "telegram" | "slack" | "dingtalk" | "discord" | "qq" | "weixin";

/** Public enrollment view. Credentials and polling tickets stay in the main process. */
export interface GatewayWeixinQrLoginStateDto {
  state: "idle" | "waiting" | "binding" | "connected" | "cancelled" | "expired" | "error";
  sessionId?: string;
  qrUrl?: string;
  message: string;
}

export interface GatewayQQQrLoginStateDto {
  state: "idle" | "waiting" | "binding" | "connected" | "cancelled" | "expired" | "error";
  sessionId?: string;
  qrUrl?: string;
  message: string;
  appId?: string;
}

export interface GatewayChannelDto {
  id: string;
  type: GatewayChannelType;
  name: string;
  connected: boolean;
  statusText?: string;
  /** Opaque connection generation; pairing drafts echo this value. */
  bindingRevision?: string;
  /** Non-secret account fingerprint used to display stale saved bindings. */
  bindingConnectionKey?: string;
}

export interface GatewayStatusDto {
  running: boolean;
  channels: GatewayChannelDto[];
}

/** 已保存通道配置的脱敏视图（secret 类字段为 REDACTED 占位符，保持原样提交即复用旧值） */
export interface GatewayChannelConfigDto {
  hasConfig: boolean;
  config: Record<string, unknown>;
}

export interface GatewayEventDto {
  /** Verified receiving account identity; absent on legacy/unverified events. */
  bindingConnectionKey?: string;
  channelId: string;
  direction: "in" | "out" | "system";
  text: string;
  at: number;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  messageId?: string;
}

export interface GatewayMessageDto {
  id: number;
  channelId: string;
  chatId: string;
  direction: "in" | "out" | "system";
  senderId?: string;
  senderName?: string;
  text: string;
  at: number;
}

export interface GatewayListMessagesRequest {
  channelId?: string;
  chatId?: string;
  /** 默认 200 */
  limit?: number;
}
