import type { GatewayEventDto, GatewayMessageDto } from "@shared/agent-ipc";

export type GatewayRecord = GatewayEventDto | GatewayMessageDto;

// Live events and persisted rows have different IDs. Match their common immutable fields.
export function gatewayRecordKey(record: GatewayRecord): string {
  return JSON.stringify([record.channelId, record.chatId ?? "", record.direction,
    record.at, record.senderId ?? "", record.senderName ?? "", record.text]);
}

export function mergeGatewayRecords(first: GatewayRecord[], second: GatewayRecord[]): GatewayRecord[] {
  const records = new Map<string, GatewayRecord>();
  for (const record of [...first, ...second]) records.set(gatewayRecordKey(record), record);
  return [...records.values()].sort((a, b) => a.at - b.at);
}

export function gatewayRecordStatus(record: GatewayRecord): string {
  // The gateway DTO has no execution/delivery receipt. Text (including an error reply)
  // is not proof of successful processing, and inbound data cannot set a success badge.
  return record.direction === "in" ? "已收到" : record.direction === "system"
    ? "渠道事件" : "发送记录 · 执行与送达状态未提供";
}
