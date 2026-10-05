/** New Gateway conversations have their own namespace; legacy gw-* tasks stay untouched. */
export function gatewayBotTaskId(sourceTaskId: string): string {
  return isGatewayBotTaskId(sourceTaskId) ? sourceTaskId : `gw-bot-${sourceTaskId.replace(/^gw-/, "")}`;
}

export function isGatewayBotTaskId(taskId?: string | null): boolean {
  return Boolean(taskId?.startsWith("gw-bot-"));
}
