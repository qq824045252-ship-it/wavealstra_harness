import type { GatewayChannelType } from "../../shared/agent-ipc";

/** Implemented capabilities, not the provider's theoretical API surface. */
export interface GatewayCapabilities {
  transport: "webhook" | "polling" | "socket";
  text: true;
  /** inbound means attachment ingestion only; file replies are not yet wired. */
  media: false | "inbound" | "bidirectional";
  editStreaming: false;
  interactiveApproval: false;
  durableInbound: boolean;
  workNotifications: boolean;
  threads: "none" | "reply-target" | "native-session";
}
const common = { text: true, media: false, editStreaming: false, interactiveApproval: false } as const;
export const GATEWAY_CAPABILITIES = Object.freeze({
  feishu: { ...common, media: "inbound", transport: "webhook", durableInbound: false, workNotifications: true, threads: "reply-target" },
  wecom: { ...common, transport: "webhook", durableInbound: false, workNotifications: true, threads: "none" },
  wechat: { ...common, transport: "webhook", durableInbound: false, workNotifications: true, threads: "none" },
  telegram: { ...common, media: "inbound", transport: "polling", durableInbound: false, workNotifications: true, threads: "reply-target" },
  slack: { ...common, media: "inbound", transport: "socket", durableInbound: true, workNotifications: true, threads: "native-session" },
  dingtalk: { ...common, media: "bidirectional", transport: "socket", durableInbound: false, workNotifications: true, threads: "none" },
  weixin: { ...common, media: "inbound", transport: "polling", durableInbound: false, workNotifications: false, threads: "none" },
  qq: { ...common, media: "inbound", transport: "socket", durableInbound: false, workNotifications: true, threads: "none" },
  discord: { ...common, media: "bidirectional", transport: "socket", durableInbound: false, workNotifications: true, threads: "reply-target" },
} satisfies Record<GatewayChannelType, GatewayCapabilities>);

