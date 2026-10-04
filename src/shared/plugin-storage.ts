/** Installed capability assets share one root; runtime data and model auth stay in the data directory. */
export const PluginStorageIpc = {
  paths: "plugins:paths",
  openDirectory: "plugins:openDirectory",
} as const;

export interface PluginStoragePathsDto {
  root: string;
  skills: string;
  experts: string;
  connectors: string;
  agents: string;
  prompts: string;
  extensions: string;
  expertMarket: string;
  connectorMarket: string;
  mcp: string;
  mcpConfig: string;
  backupPath?: string;
}
