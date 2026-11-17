/** Frozen configuration retained for historical Work bindings. */
export interface BotSettingsDto  {
  botId: string; workspacePath: string; modelId: string; expertId: string;
  skillIds: string[]; mcpIds: string[]; connectorIds: string[];
  consultRequested?: boolean;
  externalAgentId?: string;
  reasoningPreference?: import("./model-metadata").ModelReasoningPreferenceDto;
  revision: number; spaceId: string; effectiveWorkspacePath: string;
}
